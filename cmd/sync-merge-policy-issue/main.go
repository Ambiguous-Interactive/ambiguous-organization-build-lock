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

	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/githubissue"
	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/mergepolicy"
)

const (
	alertMarker          = "<!-- merge-policy-audit:v1 -->"
	alertAuthor          = "github-actions[bot]"
	alertTitle           = "policy: organization merge-policy drift detected"
	maxAuditBytes        = 4 * 1024 * 1024
	maxAuditRows         = 4096
	maxRepositories      = 64
	maxIssueBodyBytes    = 60 * 1024
	maxEvidenceURLBytes  = 2048
	maxRenderedFindings  = 40
	maxRenderedInventory = 40
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
	flags := flag.NewFlagSet("sync-merge-policy-issue", flag.ContinueOnError)
	flags.SetOutput(stderr)
	auditPath := flags.String("audit", "", "bounded organization merge-policy audit JSON")
	if err := flags.Parse(arguments); err != nil || flags.NArg() != 0 || *auditPath == "" {
		return 2
	}
	audit, err := readAudit(*auditPath)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "Merge policy audit artifact is unavailable or invalid")
		return 2
	}
	client, err := newGitHubClient(
		getenv("GITHUB_API_URL"),
		getenv("GITHUB_REPOSITORY"),
		getenv("GITHUB_TOKEN"),
		httpClient,
	)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "Merge policy issue synchronization is not configured")
		return 2
	}
	evidenceURL, err := validatedArtifactURL(
		getenv("GITHUB_SERVER_URL"),
		getenv("GITHUB_REPOSITORY"),
		getenv("GITHUB_RUN_ID"),
		getenv("MERGE_POLICY_AUDIT_ARTIFACT_URL"),
	)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "Merge policy evidence link is unavailable or invalid")
		return 2
	}
	if err := client.sync(context.Background(), audit, evidenceURL); err != nil {
		_, _ = fmt.Fprintln(stderr, "Merge policy issue synchronization failed")
		return 1
	}
	if audit.Clean() {
		_, _ = fmt.Fprintln(stdout, "Merge policy audit is complete and clean; drift alert is closed.")
	} else {
		_, _ = fmt.Fprintln(stdout, "Merge policy drift alert is open with sanitized evidence.")
	}
	return 0
}

func readAudit(path string) (mergepolicy.Audit, error) {
	file, err := os.Open(path)
	if err != nil {
		return mergepolicy.Audit{}, err
	}
	defer func() { _ = file.Close() }()
	content, err := io.ReadAll(io.LimitReader(file, maxAuditBytes+1))
	if err != nil || len(content) > maxAuditBytes {
		return mergepolicy.Audit{}, fmt.Errorf("audit exceeds size limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	var audit mergepolicy.Audit
	if err := decoder.Decode(&audit); err != nil {
		return mergepolicy.Audit{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return mergepolicy.Audit{}, fmt.Errorf("audit must contain one JSON value")
	}
	if err := validateAudit(audit); err != nil {
		return mergepolicy.Audit{}, err
	}
	return audit, nil
}

var (
	repositoryPattern  = regexp.MustCompile(`^Ambiguous-Interactive/[A-Za-z0-9_.-]{1,100}$`)
	branchPattern      = regexp.MustCompile(`^[A-Za-z0-9._@+/-]{1,100}$`)
	codePattern        = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,79}$`)
	contextPattern     = regexp.MustCompile("^[" + mergepolicy.Alphabet + "-]{0,128}$")
	carrierPattern     = regexp.MustCompile("^[" + mergepolicy.Alphabet + "-]{0,160}$")
	kindPattern        = regexp.MustCompile(`^(ruleset|branch-protection)$`)
	enforcementPattern = regexp.MustCompile(`^[a-z-]{0,32}$`)
	detailPattern      = regexp.MustCompile("^[" + mergepolicy.Alphabet + "\";-]{0,256}$")
	runIDPattern       = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)
)

func validateAudit(audit mergepolicy.Audit) error {
	if len(audit.Repositories) > maxRepositories ||
		len(audit.Inventory) > maxAuditRows ||
		len(audit.Findings) > maxAuditRows {
		return fmt.Errorf("audit collection exceeds bound")
	}
	for _, repository := range audit.Repositories {
		if !repositoryPattern.MatchString(repository.Repository) ||
			!branchPattern.MatchString(repository.DefaultBranch) {
			return fmt.Errorf("invalid audited repository")
		}
	}
	for _, entry := range audit.Inventory {
		if !repositoryPattern.MatchString(entry.Repository) ||
			!kindPattern.MatchString(entry.Kind) ||
			!carrierPattern.MatchString(entry.Carrier) ||
			!contextPattern.MatchString(entry.Context) ||
			!enforcementPattern.MatchString(entry.Enforcement) {
			return fmt.Errorf("invalid inventory entry")
		}
	}
	for _, finding := range audit.Findings {
		if !repositoryPattern.MatchString(finding.Repository) ||
			!codePattern.MatchString(finding.Code) ||
			!contextPattern.MatchString(finding.Context) ||
			!detailPattern.MatchString(finding.Detail) {
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
	if !repositoryPattern.MatchString(repository) || !runIDPattern.MatchString(runID) {
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
	if !runIDPattern.MatchString(artifactID) {
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
		UserAgent:  "ambiguous-build-lock-merge-policy-audit",
		HTTPClient: httpClient,
	})
	if err != nil {
		return nil, err
	}
	return &githubClient{issues: issues}, nil
}

func alertIdentity() githubissue.Identity {
	return githubissue.Identity{Marker: alertMarker, Author: alertAuthor}
}

func (client *githubClient) sync(
	ctx context.Context,
	audit mergepolicy.Audit,
	evidenceURL string,
) error {
	body := renderIssueBody(audit, evidenceURL)
	if len(body) > maxIssueBodyBytes {
		return fmt.Errorf("sanitized issue body exceeds bound")
	}
	state := "open"
	if audit.Clean() {
		state = "closed"
	}
	_, err := client.issues.Sync(
		ctx,
		alertIdentity(),
		githubissue.Desired{Title: alertTitle, Body: body, State: state},
	)
	return err
}

func renderIssueBody(audit mergepolicy.Audit, evidenceURL string) string {
	var body strings.Builder
	body.WriteString(alertMarker)
	body.WriteString("\n\n# Organization merge-policy audit\n\n")
	if audit.Complete {
		body.WriteString("Retrieval: **complete**\n\n")
	} else {
		body.WriteString("Retrieval: **incomplete (fail closed)**\n\n")
	}
	body.WriteString("This issue contains repository names, branches, ruleset metadata, check contexts, and reason codes only. It never contains credential values.\n\n")
	body.WriteString("Every reason code maps to its reviewed fix in the [finding-code contract](docs/consumer-enrollment.md).\n\n")
	fmt.Fprintf(
		&body,
		"Summary: **%d findings**, **%d observed required checks**. [Download the full sanitized audit artifact](%s).\n\n",
		len(audit.Findings),
		len(audit.Inventory),
		evidenceURL,
	)

	repositories := append([]mergepolicy.AuditedRepository(nil), audit.Repositories...)
	sort.Slice(repositories, func(i, j int) bool {
		return repositories[i].Repository < repositories[j].Repository
	})
	body.WriteString("## Audited repositories\n\n")
	if len(repositories) == 0 {
		body.WriteString("- None; retrieval did not establish repository evidence.\n")
	} else {
		for _, repository := range repositories {
			fmt.Fprintf(&body, "- `%s` default branch `%s`\n", repository.Repository, repository.DefaultBranch)
		}
	}

	body.WriteString("\n## Findings\n\n")
	if len(audit.Findings) == 0 {
		body.WriteString("- None.\n")
	} else {
		body.WriteString("| Repository | Context | Detail | Reason |\n")
		body.WriteString("| --- | --- | --- | --- |\n")
		findings := append([]mergepolicy.Finding(nil), audit.Findings...)
		sort.Slice(findings, func(i, j int) bool {
			left, right := findings[i], findings[j]
			return findingKey(left) < findingKey(right)
		})
		rendered := min(len(findings), maxRenderedFindings)
		for _, finding := range findings[:rendered] {
			fmt.Fprintf(
				&body,
				"| `%s` | %s | %s | `%s` |\n",
				finding.Repository,
				valueOrDash(finding.Context),
				valueOrDash(finding.Detail),
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

	body.WriteString("\n## Observed required checks\n\n")
	if len(audit.Inventory) == 0 {
		body.WriteString("- No required status checks were observed on the audited default branches.\n")
	} else {
		body.WriteString("| Repository | Carrier | Context | Enforcement |\n")
		body.WriteString("| --- | --- | --- | --- |\n")
		inventory := append([]mergepolicy.InventoryEntry(nil), audit.Inventory...)
		sort.Slice(inventory, func(i, j int) bool {
			left, right := inventory[i], inventory[j]
			if left.Repository != right.Repository {
				return left.Repository < right.Repository
			}
			if left.Kind != right.Kind {
				return left.Kind < right.Kind
			}
			if left.Carrier != right.Carrier {
				return left.Carrier < right.Carrier
			}
			return left.Context < right.Context
		})
		rendered := min(len(inventory), maxRenderedInventory)
		for _, entry := range inventory[:rendered] {
			fmt.Fprintf(
				&body,
				"| `%s` | %s | %s | `%s` |\n",
				entry.Repository,
				valueOrDash(entry.Carrier),
				valueOrDash(entry.Context),
				entry.Enforcement,
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
	body.WriteString("\nTracked by #44 (item 7) and #252. A complete clean audit closes this alert automatically.\n")
	return body.String()
}

func findingKey(finding mergepolicy.Finding) string {
	return finding.Repository + "\x00" + finding.Code + "\x00" + finding.Context + "\x00" + finding.Detail
}

func valueOrDash(value string) string {
	if value == "" {
		return "-"
	}
	return "`" + value + "`"
}
