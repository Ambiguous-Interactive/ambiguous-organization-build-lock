// Command lock-recovery-audit publishes the exact recovery evidence for an
// active organization Unity build-lock account incident.
//
// A schema-5 global incident never expires and blocks every new admission until
// an operator dispatches proof-bearing recovery with the exact incident
// identifier. This monitor reads sanitized lock state, proves the incident is
// internally consistent, and synchronizes one deduplicated alert issue that
// carries the identifier and the declared recovery inputs. It never writes lock
// state, never holds writer or Unity credentials, and never weakens the
// exact-identifier proof that recovery requires.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	alertMarker = "<!-- build-lock-incident-recovery -->"
	alertTitle  = "ops: Unity build lock global incident requires recovery"
	alertAuthor = "github-actions[bot]"

	recoveryWorkflowPath = ".github/workflows/recover-build-lock.yml"
	recoveryWorkflowName = "Recover build lock"
	recoveryOperation    = "recover-incident"

	incidentReason         = "unity-account-limit-20111"
	supportedSchemaVersion = 5

	reasonHealthy          = "healthy"
	reasonIncidentActive   = "incident-active"
	reasonStateInvalid     = "lock-state-invalid"
	reasonStateUnavailable = "lock-state-unavailable"
	reasonSyncFailed       = "alert-sync-failed"

	maxStateBytes    = 1 << 20
	maxResponseBytes = 4 << 20
	// GitHub caps an issue body at 64 KiB, so a 30-item page cannot exceed
	// roughly 2 MiB of body plus envelope and stays provably inside the bound
	// however large the repository's issue history grows.
	issuePageSize     = 30
	maxIssuePages     = 40
	maxRenderedRunes  = 200
	maxIdentifierText = 20

	requestTimeout = 20 * time.Second
	auditDeadline  = 5 * time.Minute
)

var (
	lockPattern       = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	refPattern        = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$`)
	repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	incidentIDPattern = regexp.MustCompile(`^incident-[a-f0-9]{24}$`)
	digestPattern     = regexp.MustCompile(`^[a-f0-9]{64}$`)
	countPattern      = regexp.MustCompile(`^[1-9][0-9]*$`)
)

type incident struct {
	IncidentID     string `json:"incidentId"`
	Repository     string `json:"repository"`
	Workflow       string `json:"workflow"`
	Job            string `json:"job"`
	RunID          string `json:"runId"`
	RunAttempt     string `json:"runAttempt"`
	RunURL         string `json:"runUrl"`
	RunnerID       string `json:"runnerId"`
	ReportedAt     string `json:"reportedAt"`
	Reason         string `json:"reason"`
	EvidenceDigest string `json:"evidenceDigest"`
}

// digestPayload mirrors the committed runtime's evidence-digest input exactly,
// including field order, so a tampered or hand-edited incident cannot be
// published as recoverable.
type digestPayload struct {
	Repository string `json:"repository"`
	Workflow   string `json:"workflow"`
	Job        string `json:"job"`
	RunID      string `json:"runId"`
	RunAttempt string `json:"runAttempt"`
	RunnerID   string `json:"runnerId"`
	Reason     string `json:"reason"`
}

type observation struct {
	Reason   string
	Lock     string
	Incident *incident
}

type alertIssue struct {
	Number      int             `json:"number"`
	State       string          `json:"state"`
	Title       string          `json:"title"`
	Body        string          `json:"body"`
	PullRequest json.RawMessage `json:"pull_request"`
	User        struct {
		Login string `json:"login"`
	} `json:"user"`
}

type config struct {
	Lock       string
	StateRef   string
	Repository string
	APIURL     string
	ServerURL  string
	Token      string
}

type githubClient struct {
	base       *url.URL
	repository string
	token      string
	http       *http.Client
}

func main() {
	settings, err := parseConfig(os.Args[1:], os.Getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Build lock incident audit failed: invalid configuration.")
		os.Exit(1)
	}
	// A stalled request must not consume the whole job budget: the next scheduled
	// run cannot replace a pending one, so a hang would leave an incident
	// unpublished for far longer than one interval.
	ctx, cancel := context.WithTimeout(context.Background(), auditDeadline)
	defer cancel()
	os.Exit(run(ctx, settings, &http.Client{Timeout: requestTimeout}, os.Stdout, os.Stderr))
}

func run(
	ctx context.Context,
	settings config,
	httpClient *http.Client,
	stdout, stderr io.Writer,
) int {
	client, err := newGitHubClient(settings.APIURL, settings.Repository, settings.Token, httpClient)
	if err != nil {
		fmt.Fprintln(stderr, "Build lock incident audit failed: invalid configuration.")
		return 1
	}
	state, err := client.lockState(ctx, settings.Lock, settings.StateRef)
	if err != nil {
		fmt.Fprintf(stderr, "Build lock incident audit failed: %s (%s).\n", reasonStateUnavailable, err)
		return 1
	}
	result := classifyState(state, settings.ServerURL, settings.Lock)
	result.Lock = settings.Lock
	if result.Reason == reasonStateInvalid {
		// Ambiguous state can neither prove an incident nor prove recovery, so it
		// must never open, edit, or close the alert.
		fmt.Fprintf(stderr, "Build lock incident audit failed: %s.\n", reasonStateInvalid)
		return 1
	}
	if err := client.syncAlert(ctx, result, settings.ServerURL); err != nil {
		fmt.Fprintf(stderr, "Build lock incident audit failed: %s (%s).\n", reasonSyncFailed, err)
		return 1
	}
	if result.Reason == reasonIncidentActive {
		fmt.Fprintf(stdout, "Build lock incident alert synchronized: %s.\n", result.Incident.IncidentID)
		return 0
	}
	fmt.Fprintln(stdout, "Build lock incident audit passed: no active global incident.")
	return 0
}

func parseConfig(arguments []string, getenv func(string) string) (config, error) {
	flags := flag.NewFlagSet("lock-recovery-audit", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var settings config
	flags.StringVar(&settings.Lock, "lock", "", "lock name whose state is audited")
	flags.StringVar(&settings.StateRef, "state-ref", "", "branch holding committed lock state")
	if err := flags.Parse(arguments); err != nil || flags.NArg() != 0 {
		return config{}, errors.New("invalid arguments")
	}
	if !lockPattern.MatchString(settings.Lock) || !refPattern.MatchString(settings.StateRef) {
		return config{}, errors.New("invalid lock target")
	}
	settings.Repository = getenv("GITHUB_REPOSITORY")
	settings.APIURL = getenv("GITHUB_API_URL")
	settings.Token = getenv("GITHUB_TOKEN")
	serverURL, err := origin(getenv("GITHUB_SERVER_URL"))
	if err != nil {
		return config{}, err
	}
	settings.ServerURL = serverURL
	if !repositoryPattern.MatchString(settings.Repository) || strings.TrimSpace(settings.Token) == "" {
		return config{}, errors.New("invalid GitHub identity")
	}
	if _, err := origin(settings.APIURL); err != nil {
		return config{}, err
	}
	return settings, nil
}

// origin accepts only an absolute, credential-free HTTPS origin with no path,
// query, or fragment, matching the committed runtime's server contract.
func origin(value string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Path != "" && parsed.Path != "/") {
		return "", errors.New("invalid GitHub origin")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func classifyState(raw []byte, serverURL, lock string) observation {
	invalid := observation{Reason: reasonStateInvalid}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		return invalid
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return invalid
	}
	if declared, ok := fields["lock"]; ok {
		var name string
		if err := json.Unmarshal(declared, &name); err != nil || name != lock {
			return invalid
		}
	}
	rawSchema, ok := fields["schemaVersion"]
	if !ok {
		return invalid
	}
	var schemaVersion int
	if err := json.Unmarshal(rawSchema, &schemaVersion); err != nil ||
		schemaVersion < 1 || schemaVersion > supportedSchemaVersion {
		return invalid
	}

	rawIncident, present := fields["activeIncident"]
	if schemaVersion < supportedSchemaVersion {
		// Incidents exist only at schema 5. Anything else claiming one is ambiguous.
		if present && !isJSONNull(rawIncident) {
			return invalid
		}
		return observation{Reason: reasonHealthy}
	}
	if !present {
		return invalid
	}
	if isJSONNull(rawIncident) {
		return observation{Reason: reasonHealthy}
	}

	incidentDecoder := json.NewDecoder(bytes.NewReader(rawIncident))
	incidentDecoder.DisallowUnknownFields()
	var active incident
	if err := incidentDecoder.Decode(&active); err != nil {
		return invalid
	}
	// normalizeIncident trims these three before it digests and compares, so the
	// monitor must trim identically or it could publish an identifier that
	// recovery would reject.
	active.IncidentID = strings.TrimSpace(active.IncidentID)
	active.RunnerID = strings.TrimSpace(active.RunnerID)
	active.EvidenceDigest = strings.TrimSpace(active.EvidenceDigest)
	if !validIncident(active, serverURL) {
		return invalid
	}
	return observation{Reason: reasonIncidentActive, Incident: &active}
}

func isJSONNull(raw json.RawMessage) bool {
	return string(bytes.TrimSpace(raw)) == "null"
}

func validIncident(active incident, serverURL string) bool {
	if !incidentIDPattern.MatchString(active.IncidentID) ||
		!digestPattern.MatchString(active.EvidenceDigest) ||
		active.Reason != incidentReason {
		return false
	}
	if !repositoryPattern.MatchString(active.Repository) {
		return false
	}
	for _, segment := range strings.Split(active.Repository, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	if !provableText(active.Workflow) || !provableText(active.Job) || !provableText(active.RunnerID) {
		return false
	}
	if !countPattern.MatchString(active.RunID) || len(active.RunID) > maxIdentifierText ||
		!countPattern.MatchString(active.RunAttempt) || len(active.RunAttempt) > maxIdentifierText {
		return false
	}
	if active.RunURL != serverURL+"/"+active.Repository+"/actions/runs/"+active.RunID {
		return false
	}
	reportedAt, err := time.Parse(time.RFC3339, active.ReportedAt)
	if err != nil || reportedAt.UnixMilli() == 0 {
		// The committed runtime treats an epoch-zero parse as no timestamp, so an
		// identifier it would reject must never be published as recoverable.
		return false
	}
	digest, digestErr := incidentDigest(active)
	if digestErr != nil || digest != active.EvidenceDigest ||
		active.IncidentID != "incident-"+digest[:24] {
		return false
	}
	return true
}

// provableText rejects only what makes the evidence itself unprovable: an empty
// value, or a separator whose JSON encoding differs between Go and the committed
// JavaScript runtime and would therefore break digest parity. Anything else is a
// rendering concern, handled by codeCell. A provable incident must always be
// publishable, because refusing to publish one is the failure this audit exists
// to prevent.
func provableText(value string) bool {
	if value == "" {
		return false
	}
	for _, symbol := range value {
		if symbol < 0x20 || symbol == 0x7f || symbol == '\u2028' || symbol == '\u2029' {
			return false
		}
	}
	return true
}

// codeCell renders arbitrary provenance inside a Markdown table cell. It fences
// the value with a backtick run longer than any it contains, escapes the cell
// separator, and truncates so three oversized fields cannot push the body past
// the issue-body limit.
func codeCell(value string) string {
	runes := []rune(value)
	truncated := false
	if len(runes) > maxRenderedRunes {
		runes = runes[:maxRenderedRunes]
		truncated = true
	}
	rendered := string(runes)

	longest, current := 0, 0
	for _, symbol := range rendered {
		if symbol == '`' {
			current++
			if current > longest {
				longest = current
			}
			continue
		}
		current = 0
	}
	fence := strings.Repeat("`", longest+1)
	if strings.HasPrefix(rendered, "`") || strings.HasSuffix(rendered, "`") {
		rendered = " " + rendered + " "
	}
	cell := fence + rendered + fence
	if truncated {
		cell += " (truncated)"
	}
	return strings.ReplaceAll(cell, "|", "\\|")
}

func incidentDigest(active incident) (string, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(digestPayload{
		Repository: active.Repository,
		Workflow:   active.Workflow,
		Job:        active.Job,
		RunID:      active.RunID,
		RunAttempt: active.RunAttempt,
		RunnerID:   active.RunnerID,
		Reason:     active.Reason,
	}); err != nil {
		return "", err
	}
	sum := sha256.Sum256(bytes.TrimSuffix(buffer.Bytes(), []byte("\n")))
	return hex.EncodeToString(sum[:]), nil
}

// alertBody renders the retained operator record for one incident. It carries no
// wall-clock or run-scoped value, so an unchanged incident produces a
// byte-identical body and the audit does not rewrite the issue. It also states
// no live status of its own: the issue's open or closed state is the authority,
// which keeps a closed alert readable as history.
func alertBody(active incident, lock, serverURL, repository string) string {
	var body strings.Builder
	body.WriteString(alertMarker)
	body.WriteString("\n\n# Unity build lock global account incident\n\n")
	fmt.Fprintf(
		&body,
		"While this alert is open, every new `%s` admission is blocked until an operator completes proof-bearing recovery. Existing holders may still finish their own cleanup.\n\n",
		lock,
	)

	body.WriteString("## Recover\n\n")
	body.WriteString(
		"1. Reconcile every Unity portal activation for the runner below and confirm that no unexplained activation remains.\n",
	)
	fmt.Fprintf(
		&body,
		"2. Dispatch [%s](%s/%s/actions/workflows/%s) (`%s`) with these inputs:\n\n",
		recoveryWorkflowName,
		serverURL,
		repository,
		recoveryWorkflowFile(),
		recoveryWorkflowPath,
	)
	body.WriteString("| Input | Value |\n| --- | --- |\n")
	fmt.Fprintf(&body, "| `operation` | `%s` |\n", recoveryOperation)
	fmt.Fprintf(&body, "| `incident-id` | `%s` |\n", active.IncidentID)
	body.WriteString("| `portal-cleanup-confirmed` | `true` |\n\n")
	body.WriteString(
		"Never edit lock state by hand. Recovery with a wrong identifier or without portal proof fails closed.\n\n",
	)

	body.WriteString("## Sanitized incident evidence\n\n")
	body.WriteString("| Field | Value |\n| --- | --- |\n")
	fmt.Fprintf(&body, "| Reported at | %s |\n", codeCell(active.ReportedAt))
	fmt.Fprintf(&body, "| Repository | %s |\n", codeCell(active.Repository))
	fmt.Fprintf(&body, "| Workflow | %s |\n", codeCell(active.Workflow))
	fmt.Fprintf(&body, "| Job | %s |\n", codeCell(active.Job))
	fmt.Fprintf(&body, "| Run attempt | %s |\n", codeCell(active.RunAttempt))
	fmt.Fprintf(&body, "| Runner | %s |\n", codeCell(active.RunnerID))
	fmt.Fprintf(&body, "| Reason | %s |\n", codeCell(active.Reason))
	fmt.Fprintf(&body, "| Source run | %s |\n\n", active.RunURL)

	body.WriteString(
		"This alert contains sanitized repository, workflow, job, run, runner, reason, and timestamp evidence only. It never contains credential values, raw logs, or the incident evidence digest.\n",
	)
	body.WriteString(
		"\nThe audit closes this alert automatically once the lock reports no active global incident, and leaves this record in place.\n",
	)
	return body.String()
}

func recoveryWorkflowFile() string {
	return recoveryWorkflowPath[strings.LastIndex(recoveryWorkflowPath, "/")+1:]
}

func newGitHubClient(apiURL, repository, token string, httpClient *http.Client) (*githubClient, error) {
	base, err := url.Parse(strings.TrimSpace(apiURL))
	if err != nil || base.Scheme == "" || base.Host == "" || base.User != nil ||
		base.RawQuery != "" || base.Fragment != "" {
		return nil, errors.New("invalid GitHub API URL")
	}
	if !repositoryPattern.MatchString(repository) || strings.TrimSpace(token) == "" || httpClient == nil {
		return nil, errors.New("invalid GitHub client configuration")
	}
	fenced := *httpClient
	fenced.CheckRedirect = func(*http.Request, []*http.Request) error {
		return errors.New("redirects are not allowed")
	}
	return &githubClient{base: base, repository: repository, token: token, http: &fenced}, nil
}

func (client *githubClient) lockState(ctx context.Context, lock, ref string) ([]byte, error) {
	path := client.repositoryPath(
		"/contents/locks/" + url.PathEscape(lock+".json") + "?ref=" + url.QueryEscape(ref),
	)
	return client.request(ctx, http.MethodGet, path, nil, "application/vnd.github.raw", maxStateBytes)
}

func (client *githubClient) syncAlert(ctx context.Context, result observation, serverURL string) error {
	existing, err := client.findAlert(ctx)
	if err != nil {
		return err
	}

	if result.Reason != reasonIncidentActive {
		// Recovery closes the alert but never rewrites it. The last published
		// incident stays readable as the retained operator record.
		if existing == nil || existing.State == "closed" {
			return nil
		}
		return client.patchAlert(ctx, existing.Number, map[string]any{"state": "closed"})
	}

	body := alertBody(*result.Incident, result.Lock, serverURL, client.repository)
	if existing == nil {
		_, err := client.request(
			ctx,
			http.MethodPost,
			client.repositoryPath("/issues"),
			map[string]any{"title": alertTitle, "body": body},
			"application/vnd.github+json",
			maxResponseBytes,
		)
		return err
	}
	if existing.State == "open" && existing.Body == body {
		// The alert already carries this exact evidence; rewriting it would churn
		// the operator's record without adding information.
		return nil
	}
	return client.patchAlert(
		ctx,
		existing.Number,
		map[string]any{"title": alertTitle, "body": body, "state": "open"},
	)
}

func (client *githubClient) patchAlert(ctx context.Context, number int, payload map[string]any) error {
	_, err := client.request(
		ctx,
		http.MethodPatch,
		client.repositoryPath("/issues/"+strconv.Itoa(number)),
		payload,
		"application/vnd.github+json",
		maxResponseBytes,
	)
	return err
}

// findAlert resolves at most one alert that this automation owns. A foreign
// author or a duplicate marker is ambiguous evidence and fails closed rather
// than letting an untrusted issue be adopted or overwritten.
func (client *githubClient) findAlert(ctx context.Context) (*alertIssue, error) {
	var found *alertIssue
	for page := 1; page <= maxIssuePages; page++ {
		path := client.repositoryPath(fmt.Sprintf(
			"/issues?state=all&sort=created&direction=asc&per_page=%d&page=%d",
			issuePageSize,
			page,
		))
		content, err := client.request(ctx, http.MethodGet, path, nil, "application/vnd.github+json", maxResponseBytes)
		if err != nil {
			return nil, err
		}
		var issues []alertIssue
		if err := json.Unmarshal(content, &issues); err != nil {
			return nil, errors.New("decode issue list")
		}
		for index := range issues {
			candidate := issues[index]
			pullRequest := strings.TrimSpace(string(candidate.PullRequest))
			// The marker plus this automation's own authorship is the alert's
			// identity. The repository is public and both the title and the marker
			// are published, so a foreign-authored lookalike must be skipped rather
			// than adopted or treated as fatal: making it fatal would let any user
			// permanently suppress incident publication. The title is presentation
			// only, so an operator rename cannot orphan the alert either.
			if (pullRequest != "" && pullRequest != "null") ||
				candidate.User.Login != alertAuthor ||
				!strings.Contains(candidate.Body, alertMarker) {
				continue
			}
			if candidate.Number <= 0 || candidate.State != "open" && candidate.State != "closed" {
				return nil, errors.New("invalid alert issue evidence")
			}
			if found != nil && found.Number != candidate.Number {
				return nil, errors.New("duplicate alert issue evidence")
			}
			found = &candidate
		}
		if len(issues) < issuePageSize {
			return found, nil
		}
	}
	return nil, errors.New("alert issue pagination exceeded")
}

func (client *githubClient) repositoryPath(suffix string) string {
	parts := strings.Split(client.repository, "/")
	return "/repos/" + url.PathEscape(parts[0]) + "/" + url.PathEscape(parts[1]) + suffix
}

func (client *githubClient) request(
	ctx context.Context,
	method, path string,
	payload map[string]any,
	accept string,
	limit int,
) ([]byte, error) {
	reference, err := url.Parse(path)
	if err != nil {
		return nil, errors.New("invalid GitHub API endpoint")
	}
	endpoint := client.base.ResolveReference(reference)
	if !strings.EqualFold(endpoint.Scheme, client.base.Scheme) || !strings.EqualFold(endpoint.Host, client.base.Host) {
		return nil, errors.New("cross-origin GitHub API endpoint rejected")
	}
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, errors.New("encode request failed")
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return nil, errors.New("create request failed")
	}
	request.Header.Set("Accept", accept)
	request.Header.Set("Authorization", "Bearer "+client.token)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "ambiguous-build-lock-recovery-audit")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.http.Do(request)
	if err != nil {
		return nil, errors.New("GitHub API request failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("GitHub API status %d", response.StatusCode)
	}
	content, err := io.ReadAll(io.LimitReader(response.Body, int64(limit)+1))
	if err != nil || len(content) > limit {
		return nil, errors.New("GitHub API response exceeded limit")
	}
	return content, nil
}
