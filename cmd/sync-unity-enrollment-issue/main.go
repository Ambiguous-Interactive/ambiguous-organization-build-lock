package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"

	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/enrollment"
	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/githubissue"
)

const (
	alertMarker          = "<!-- unity-enrollment-audit:v1 -->"
	alertAuthor          = "github-actions[bot]"
	alertTitle           = "policy: organization Unity enrollment drift detected"
	maxAuditBytes        = 4 * 1024 * 1024
	maxResponseBytes     = githubissue.DefaultResponseLimit
	issuePageSize        = githubissue.DefaultPageSize
	maxAuditRows         = 4096
	maxIssueBodyBytes    = 60 * 1024
	maxEvidenceURLBytes  = 2048
	maxRepositories      = 64
	maxRenderedFindings  = 40
	maxRenderedInventory = 16
)

type issue = githubissue.Issue

type githubClient struct {
	issues *githubissue.Client
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr, os.Getenv, http.DefaultClient))
}

func run(
	arguments []string,
	stdout, stderr io.Writer,
	getenv func(string) string,
	httpClient *http.Client,
) int {
	flags := flag.NewFlagSet("sync-unity-enrollment-issue", flag.ContinueOnError)
	flags.SetOutput(stderr)
	auditPath := flags.String("audit", "", "bounded organization audit JSON")
	if err := flags.Parse(arguments); err != nil || flags.NArg() != 0 || *auditPath == "" {
		return 2
	}
	audit, err := readAudit(*auditPath)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "Unity enrollment audit artifact is unavailable or invalid")
		return 2
	}
	client, err := newGitHubClient(
		getenv("GITHUB_API_URL"),
		getenv("GITHUB_REPOSITORY"),
		getenv("GITHUB_TOKEN"),
		httpClient,
	)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "Unity enrollment issue synchronization is not configured")
		return 2
	}
	evidenceURL, err := validatedArtifactURL(
		getenv("GITHUB_SERVER_URL"),
		getenv("GITHUB_REPOSITORY"),
		getenv("GITHUB_RUN_ID"),
		getenv("UNITY_AUDIT_ARTIFACT_URL"),
	)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "Unity enrollment evidence link is unavailable or invalid")
		return 2
	}
	if err := client.sync(context.Background(), audit, evidenceURL); err != nil {
		_, _ = fmt.Fprintln(stderr, "Unity enrollment issue synchronization failed")
		return 1
	}
	if audit.Complete && len(audit.Findings) == 0 {
		_, _ = fmt.Fprintln(stdout, "Unity enrollment audit is complete and clean; drift alert is closed.")
	} else {
		_, _ = fmt.Fprintln(stdout, "Unity enrollment drift alert is open with sanitized evidence.")
	}
	return 0
}

func readAudit(path string) (enrollment.UnityOrganizationAudit, error) {
	file, err := os.Open(path)
	if err != nil {
		return enrollment.UnityOrganizationAudit{}, err
	}
	defer func() { _ = file.Close() }()
	content, err := io.ReadAll(io.LimitReader(file, maxAuditBytes+1))
	if err != nil || len(content) > maxAuditBytes {
		return enrollment.UnityOrganizationAudit{}, fmt.Errorf("audit exceeds size limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	var audit enrollment.UnityOrganizationAudit
	if err := decoder.Decode(&audit); err != nil {
		return enrollment.UnityOrganizationAudit{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return enrollment.UnityOrganizationAudit{}, fmt.Errorf("audit must contain one JSON value")
	}
	if err := validateAudit(audit); err != nil {
		return enrollment.UnityOrganizationAudit{}, err
	}
	return audit, nil
}

func validateAudit(audit enrollment.UnityOrganizationAudit) error {
	if len(audit.Repositories) > maxRepositories || len(audit.Inventory) > maxAuditRows ||
		len(audit.Findings) > maxAuditRows {
		return fmt.Errorf("audit collection exceeds bound")
	}
	repositoryPattern := regexp.MustCompile(`^Ambiguous-Interactive/[A-Za-z0-9_.-]{1,100}$`)
	codePattern := regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,79}$`)
	pathPattern := regexp.MustCompile(`^\.github/(?:workflows/)?[A-Za-z0-9_./-]+\.ya?ml$`)
	jobPattern := regexp.MustCompile(`^[A-Za-z0-9_. -]{0,128}$`)
	validateIdentity := func(repository, sha string, shaOptional bool) error {
		if !repositoryPattern.MatchString(repository) {
			return fmt.Errorf("invalid repository")
		}
		if sha == "" && shaOptional {
			return nil
		}
		if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(sha) {
			return fmt.Errorf("invalid commit")
		}
		return nil
	}
	for _, repository := range audit.Repositories {
		if err := validateIdentity(repository.Repository, repository.SHA, false); err != nil {
			return err
		}
	}
	for _, entry := range audit.Inventory {
		if err := validateIdentity(entry.Repository, entry.SHA, false); err != nil {
			return err
		}
		if len(entry.Path) > 256 || !pathPattern.MatchString(entry.Path) || !jobPattern.MatchString(entry.Job) {
			return fmt.Errorf("invalid inventory location")
		}
		if !enrollment.ValidUnityInventoryClassification(entry.Classification) {
			return fmt.Errorf("invalid inventory classification")
		}
	}
	for _, finding := range audit.Findings {
		if err := validateIdentity(finding.Repository, finding.SHA, true); err != nil {
			return err
		}
		if !codePattern.MatchString(finding.Code) ||
			(finding.Path != "" && (len(finding.Path) > 256 || !pathPattern.MatchString(finding.Path))) ||
			!jobPattern.MatchString(finding.Job) {
			return fmt.Errorf("invalid finding")
		}
	}
	return nil
}

func validatedArtifactURL(serverURL, repository, runID, artifactURL string) (string, error) {
	if len(serverURL) > maxEvidenceURLBytes || len(artifactURL) > maxEvidenceURLBytes {
		return "", fmt.Errorf("audit artifact URL exceeds bound")
	}
	server, err := url.Parse(strings.TrimSpace(serverURL))
	if err != nil || server.Scheme != "https" || server.Host == "" || server.User != nil ||
		server.RawQuery != "" || server.Fragment != "" || server.RawPath != "" {
		return "", fmt.Errorf("invalid GitHub server URL")
	}
	if !regexp.MustCompile(`^Ambiguous-Interactive/[A-Za-z0-9_.-]{1,100}$`).MatchString(repository) ||
		!regexp.MustCompile(`^[1-9][0-9]{0,19}$`).MatchString(runID) {
		return "", fmt.Errorf("invalid GitHub run identity")
	}
	artifact, err := url.Parse(strings.TrimSpace(artifactURL))
	if err != nil || artifact.Scheme != server.Scheme || artifact.Host != server.Host ||
		artifact.User != nil || artifact.RawQuery != "" || artifact.Fragment != "" ||
		artifact.RawPath != "" {
		return "", fmt.Errorf("invalid audit artifact URL")
	}
	expectedPrefix := strings.TrimSuffix(server.Path, "/") + "/" + repository +
		"/actions/runs/" + runID + "/artifacts/"
	if !strings.HasPrefix(artifact.Path, expectedPrefix) {
		return "", fmt.Errorf("audit artifact URL does not match this run")
	}
	artifactID := strings.TrimPrefix(artifact.Path, expectedPrefix)
	if !regexp.MustCompile(`^[1-9][0-9]{0,19}$`).MatchString(artifactID) {
		return "", fmt.Errorf("invalid audit artifact identity")
	}
	return artifact.String(), nil
}

func newGitHubClient(apiURL, repository, token string, httpClient *http.Client) (*githubClient, error) {
	base, err := url.Parse(strings.TrimSpace(apiURL))
	if err != nil || base.Scheme != "https" || base.Host == "" ||
		base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, fmt.Errorf("invalid GitHub API URL")
	}
	if !regexp.MustCompile(`^Ambiguous-Interactive/[A-Za-z0-9_.-]+$`).MatchString(repository) ||
		strings.TrimSpace(token) == "" || httpClient == nil {
		return nil, fmt.Errorf("invalid GitHub issue client configuration")
	}
	issues, err := githubissue.New(githubissue.Options{
		APIURL:     base.String(),
		Repository: repository,
		Token:      token,
		UserAgent:  "ambiguous-build-lock-unity-enrollment-audit",
		HTTPClient: httpClient,
	})
	if err != nil {
		return nil, err
	}
	return &githubClient{issues: issues}, nil
}

func (client *githubClient) sync(
	ctx context.Context,
	audit enrollment.UnityOrganizationAudit,
	evidenceURL string,
) error {
	clean := audit.Complete && len(audit.Findings) == 0
	body := renderIssueBody(audit, evidenceURL)
	if len(body) > maxIssueBodyBytes {
		return fmt.Errorf("sanitized issue body exceeds bound")
	}
	state := "open"
	if clean {
		state = "closed"
	}
	_, err := client.issues.Sync(
		ctx,
		alertIdentity(),
		githubissue.Desired{Title: alertTitle, Body: body, State: state},
	)
	return err
}

func alertIdentity() githubissue.Identity {
	return githubissue.Identity{Marker: alertMarker, Author: alertAuthor}
}

func renderIssueBody(audit enrollment.UnityOrganizationAudit, evidenceURL string) string {
	var body strings.Builder
	body.WriteString(alertMarker)
	body.WriteString("\n\n# Organization Unity enrollment audit\n\n")
	if audit.Complete {
		body.WriteString("Retrieval: **complete**\n\n")
	} else {
		body.WriteString("Retrieval: **incomplete (fail closed)**\n\n")
	}
	body.WriteString("This issue contains sanitized repository, commit, workflow, job, classification, and reason-code evidence only. It never contains matched source lines or credential values.\n\n")
	fmt.Fprintf(
		&body,
		"Summary: **%d findings**, **%d active inventory rows**. [Download the full retained source-free audit artifact](%s).\n\n",
		len(audit.Findings),
		len(audit.Inventory),
		evidenceURL,
	)

	repositories := append([]enrollment.UnityAuditedRepository(nil), audit.Repositories...)
	sort.Slice(repositories, func(i, j int) bool {
		left, right := repositories[i], repositories[j]
		return left.Repository+"\x00"+left.SHA < right.Repository+"\x00"+right.SHA
	})
	body.WriteString("## Audited commits\n\n")
	if len(repositories) == 0 {
		body.WriteString("- None; retrieval did not establish an immutable repository snapshot.\n")
	} else {
		for _, repository := range repositories {
			fmt.Fprintf(&body, "- `%s` at `%s`\n", repository.Repository, repository.SHA)
		}
	}

	body.WriteString("\n## Findings\n\n")
	if len(audit.Findings) == 0 {
		body.WriteString("- None.\n")
	} else {
		body.WriteString("| Repository | Commit | Workflow | Job | Reason |\n")
		body.WriteString("| --- | --- | --- | --- | --- |\n")
		findings := append([]enrollment.UnityAuditFinding(nil), audit.Findings...)
		sort.Slice(findings, func(i, j int) bool {
			left, right := findings[i], findings[j]
			return left.Repository+"\x00"+left.SHA+"\x00"+left.Path+"\x00"+left.Job+"\x00"+left.Code <
				right.Repository+"\x00"+right.SHA+"\x00"+right.Path+"\x00"+right.Job+"\x00"+right.Code
		})
		rendered := min(len(findings), maxRenderedFindings)
		for _, finding := range findings[:rendered] {
			fmt.Fprintf(
				&body,
				"| `%s` | `%s` | `%s` | `%s` | `%s` |\n",
				finding.Repository,
				valueOrDash(finding.SHA),
				valueOrDash(finding.Path),
				valueOrDash(finding.Job),
				finding.Code,
			)
		}
		if omitted := len(findings) - rendered; omitted > 0 {
			fmt.Fprintf(
				&body,
				"\n_%d additional findings omitted from this bounded preview; use the retained artifact above for the complete sanitized evidence._\n",
				omitted,
			)
		}
	}

	body.WriteString("\n## Active inventory\n\n")
	if len(audit.Inventory) == 0 {
		body.WriteString("- No Unity-related jobs were established by this audit.\n")
	} else {
		body.WriteString("| Repository | Workflow | Job | Classification |\n")
		body.WriteString("| --- | --- | --- | --- |\n")
		inventory := append([]enrollment.UnityInventoryEntry(nil), audit.Inventory...)
		sort.Slice(inventory, func(i, j int) bool {
			left, right := inventory[i], inventory[j]
			return left.Repository+"\x00"+left.SHA+"\x00"+left.Path+"\x00"+left.Job+"\x00"+left.Classification <
				right.Repository+"\x00"+right.SHA+"\x00"+right.Path+"\x00"+right.Job+"\x00"+right.Classification
		})
		rendered := min(len(inventory), maxRenderedInventory)
		for _, entry := range inventory[:rendered] {
			fmt.Fprintf(
				&body,
				"| `%s` | `%s` | `%s` | `%s` |\n",
				entry.Repository,
				entry.Path,
				entry.Job,
				entry.Classification,
			)
		}
		if omitted := len(inventory) - rendered; omitted > 0 {
			fmt.Fprintf(
				&body,
				"\n_%d additional inventory rows omitted from this bounded preview; use the retained artifact above for the complete sanitized evidence._\n",
				omitted,
			)
		}
	}
	body.WriteString("\nTracked by #42 and rollout tracker #30. A complete clean audit closes this alert automatically.\n")
	return body.String()
}

func valueOrDash(value string) string {
	if value == "" {
		return "-"
	}
	return value
}
