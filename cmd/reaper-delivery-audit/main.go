package main

import (
	"bytes"
	"context"
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
	incidentTitle    = "ops: scheduled reaper delivery outside SLO"
	incidentMarker   = "<!-- build-lock-reaper-delivery-monitor -->"
	incidentActor    = "github-actions[bot]"
	maxResponseBytes = 4 << 20
	maxIssuePages    = 40
	issuePageSize    = 30
)

var (
	repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	workflowPattern   = regexp.MustCompile(`^[A-Za-z0-9_.-]+\.ya?ml$`)
	shaPattern        = regexp.MustCompile(`^[a-f0-9]{40}$`)
	conclusions       = map[string]bool{
		"action_required": true,
		"cancelled":       true,
		"failure":         true,
		"neutral":         true,
		"skipped":         true,
		"stale":           true,
		"startup_failure": true,
		"success":         true,
		"timed_out":       true,
	}
)

type cliConfig struct {
	Repository       string
	Token            string
	APIURL           string
	Workflow         string
	MaxDeliveryDelay time.Duration
	MaxRunDuration   time.Duration
}

type workflowRun struct {
	ID           int64     `json:"id"`
	Event        string    `json:"event"`
	Status       string    `json:"status"`
	Conclusion   string    `json:"conclusion"`
	HeadSHA      string    `json:"head_sha"`
	CreatedAt    time.Time `json:"created_at"`
	RunStartedAt time.Time `json:"run_started_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type observation struct {
	Healthy   bool
	Reason    string
	CheckedAt time.Time
	Latest    *workflowRun
}

type incidentIssue struct {
	Number      int64           `json:"number"`
	State       string          `json:"state"`
	Title       string          `json:"title"`
	Body        string          `json:"body"`
	PullRequest json.RawMessage `json:"pull_request"`
	User        struct {
		Login string `json:"login"`
	} `json:"user"`
}

type githubClient struct {
	baseURL    *url.URL
	token      string
	httpClient *http.Client
}

func classifyRuns(now time.Time, runs []workflowRun, maxDeliveryDelay, maxRunDuration time.Duration) observation {
	result := observation{Reason: "workflow-evidence-invalid", CheckedAt: now.UTC()}
	if maxDeliveryDelay <= 0 || maxRunDuration <= 0 || now.IsZero() {
		return result
	}
	if len(runs) == 0 {
		result.Reason = "scheduled-run-missing"
		return result
	}
	if len(runs) > 2 {
		return result
	}

	latestIndex := -1
	for index := range runs {
		if !validWorkflowRun(now, runs[index]) {
			return result
		}
		if latestIndex < 0 || runs[index].CreatedAt.After(runs[latestIndex].CreatedAt) {
			latestIndex = index
		} else if runs[index].CreatedAt.Equal(runs[latestIndex].CreatedAt) && runs[index].ID != runs[latestIndex].ID {
			return result
		}
	}

	latest := runs[latestIndex]
	result.Latest = &latest
	age := now.Sub(latest.CreatedAt)
	if age > maxDeliveryDelay {
		result.Reason = "scheduled-run-overdue"
		return result
	}
	if latest.Status != "completed" && age > maxRunDuration {
		result.Reason = "scheduled-run-stalled"
		return result
	}
	if latest.Status == "completed" && latest.Conclusion != "success" {
		result.Reason = "scheduled-run-unsuccessful"
		return result
	}
	result.Healthy = true
	result.Reason = "healthy"
	return result
}

func validWorkflowRun(now time.Time, run workflowRun) bool {
	if run.ID <= 0 || run.Event != "schedule" || !shaPattern.MatchString(run.HeadSHA) || run.CreatedAt.IsZero() {
		return false
	}
	if run.CreatedAt.After(now) || !run.UpdatedAt.IsZero() && run.UpdatedAt.Before(run.CreatedAt) {
		return false
	}
	switch run.Status {
	case "queued", "pending", "requested", "waiting":
		if run.Conclusion != "" {
			return false
		}
	case "in_progress":
		if run.Conclusion != "" || run.RunStartedAt.IsZero() {
			return false
		}
	case "completed":
		if !conclusions[run.Conclusion] || run.RunStartedAt.IsZero() || run.UpdatedAt.IsZero() {
			return false
		}
	default:
		return false
	}
	if !run.RunStartedAt.IsZero() && run.RunStartedAt.Before(run.CreatedAt) {
		return false
	}
	if !run.RunStartedAt.IsZero() && !run.UpdatedAt.IsZero() && run.UpdatedAt.Before(run.RunStartedAt) {
		return false
	}
	return true
}

func incidentBody(result observation) string {
	var builder strings.Builder
	builder.WriteString(incidentMarker)
	builder.WriteString("\n\n# Scheduled reaper delivery status\n\n")
	if result.Healthy {
		builder.WriteString("State: `healthy`\n\n")
	} else {
		builder.WriteString("State: `alerting`\n\n")
	}
	fmt.Fprintf(&builder, "Reason: `%s`\n\n", result.Reason)
	fmt.Fprintf(&builder, "Checked at: `%s`\n\n", result.CheckedAt.UTC().Format(time.RFC3339))
	if result.Latest == nil {
		builder.WriteString("Latest scheduled run ID: `none`\n")
		return builder.String()
	}
	fmt.Fprintf(&builder, "Latest scheduled run ID: `%d`\n\n", result.Latest.ID)
	fmt.Fprintf(&builder, "Head SHA: `%s`\n\n", result.Latest.HeadSHA)
	fmt.Fprintf(&builder, "Delivered at: `%s`\n\n", result.Latest.CreatedAt.UTC().Format(time.RFC3339))
	if result.Latest.RunStartedAt.IsZero() {
		builder.WriteString("Started at: `none`\n\n")
	} else {
		fmt.Fprintf(&builder, "Started at: `%s`\n\n", result.Latest.RunStartedAt.UTC().Format(time.RFC3339))
	}
	if result.Latest.UpdatedAt.IsZero() {
		builder.WriteString("Completed/updated at: `none`\n")
	} else {
		fmt.Fprintf(&builder, "Completed/updated at: `%s`\n", result.Latest.UpdatedAt.UTC().Format(time.RFC3339))
	}
	return builder.String()
}

func (client *githubClient) workflowRuns(ctx context.Context, repository, workflow string) ([]workflowRun, error) {
	if !repositoryPattern.MatchString(repository) || !workflowPattern.MatchString(workflow) {
		return nil, errors.New("invalid workflow run target")
	}
	endpoint := fmt.Sprintf(
		"/repos/%s/actions/workflows/%s/runs?event=schedule&per_page=2",
		escapeRepository(repository),
		url.PathEscape(workflow),
	)
	var payload struct {
		WorkflowRuns []workflowRun `json:"workflow_runs"`
	}
	if _, err := client.request(ctx, http.MethodGet, endpoint, nil, &payload); err != nil {
		return nil, err
	}
	return payload.WorkflowRuns, nil
}

func (client *githubClient) syncIncident(ctx context.Context, repository string, result observation) error {
	issue, err := client.findIncident(ctx, repository)
	if err != nil {
		return err
	}
	if result.Healthy && issue == nil {
		return nil
	}
	if result.Healthy && issue.State == "closed" {
		return nil
	}

	payload := map[string]any{
		"title": incidentTitle,
		"body":  incidentBody(result),
	}
	method := http.MethodPost
	endpoint := fmt.Sprintf("/repos/%s/issues", escapeRepository(repository))
	if issue != nil {
		method = http.MethodPatch
		endpoint += "/" + strconv.FormatInt(issue.Number, 10)
		if result.Healthy && issue.State == "open" {
			payload["state"] = "closed"
		} else if !result.Healthy && issue.State == "closed" {
			payload["state"] = "open"
		}
	}
	_, err = client.request(ctx, method, endpoint, payload, nil)
	return err
}

func (client *githubClient) findIncident(ctx context.Context, repository string) (*incidentIssue, error) {
	if !repositoryPattern.MatchString(repository) {
		return nil, errors.New("invalid incident repository")
	}
	next := fmt.Sprintf("/repos/%s/issues?state=all&per_page=%d", escapeRepository(repository), issuePageSize)
	var incident *incidentIssue
	for page := 0; page < maxIssuePages && next != ""; page++ {
		var issues []incidentIssue
		header, err := client.request(ctx, http.MethodGet, next, nil, &issues)
		if err != nil {
			return nil, err
		}
		for index := range issues {
			isPullRequest := len(issues[index].PullRequest) > 0 &&
				string(issues[index].PullRequest) != "null"
			if !isPullRequest && issues[index].Title == incidentTitle &&
				strings.Contains(issues[index].Body, incidentMarker) &&
				issues[index].User.Login == incidentActor {
				if issues[index].Number <= 0 || issues[index].State != "open" && issues[index].State != "closed" {
					return nil, errors.New("invalid incident issue evidence")
				}
				if incident != nil && incident.Number != issues[index].Number {
					return nil, errors.New("duplicate incident issue evidence")
				}
				current := issues[index]
				incident = &current
			}
		}
		next, err = client.nextLink(header.Get("Link"))
		if err != nil {
			return nil, err
		}
		if page == maxIssuePages-1 && next != "" {
			return nil, errors.New("incident issue pagination exceeded")
		}
	}
	return incident, nil
}

func (client *githubClient) nextLink(header string) (string, error) {
	if header == "" {
		return "", nil
	}
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		if len(fields) < 2 || !strings.Contains(strings.Join(fields[1:], ";"), `rel="next"`) {
			continue
		}
		target := strings.TrimSpace(fields[0])
		if len(target) < 3 || target[0] != '<' || target[len(target)-1] != '>' {
			return "", errors.New("invalid pagination link")
		}
		parsed, err := url.Parse(target[1 : len(target)-1])
		if err != nil || !sameOrigin(client.baseURL, parsed) {
			return "", errors.New("cross-origin pagination rejected")
		}
		return parsed.String(), nil
	}
	return "", nil
}

func (client *githubClient) request(
	ctx context.Context,
	method, endpoint string,
	payload any,
	result any,
) (http.Header, error) {
	target, err := client.resolve(endpoint)
	if err != nil {
		return nil, err
	}
	var body io.Reader
	if payload != nil {
		encoded, encodeErr := json.Marshal(payload)
		if encodeErr != nil {
			return nil, errors.New("encode request failed")
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return nil, errors.New("create request failed")
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+client.token)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "ambiguous-build-lock-reaper-delivery-audit")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, errors.New("GitHub API request failed")
	}
	defer response.Body.Close()
	contents, err := readBounded(response.Body)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("GitHub API status %d", response.StatusCode)
	}
	if result != nil {
		if len(contents) == 0 {
			return nil, errors.New("GitHub API response missing")
		}
		decoder := json.NewDecoder(bytes.NewReader(contents))
		if err := decoder.Decode(result); err != nil {
			return nil, errors.New("decode GitHub API response failed")
		}
		var extra any
		if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
			return nil, errors.New("GitHub API response contained trailing data")
		}
	}
	return response.Header.Clone(), nil
}

func (client *githubClient) resolve(endpoint string) (*url.URL, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, errors.New("invalid GitHub API endpoint")
	}
	if !parsed.IsAbs() {
		parsed = client.baseURL.ResolveReference(parsed)
	}
	if !sameOrigin(client.baseURL, parsed) {
		return nil, errors.New("cross-origin GitHub API endpoint rejected")
	}
	return parsed, nil
}

func readBounded(reader io.Reader) ([]byte, error) {
	contents, err := io.ReadAll(io.LimitReader(reader, maxResponseBytes+1))
	if err != nil {
		return nil, errors.New("read GitHub API response failed")
	}
	if len(contents) > maxResponseBytes {
		return nil, errors.New("GitHub API response exceeded limit")
	}
	return contents, nil
}

func escapeRepository(repository string) string {
	parts := strings.Split(repository, "/")
	return url.PathEscape(parts[0]) + "/" + url.PathEscape(parts[1])
}

func sameOrigin(left, right *url.URL) bool {
	return left != nil && right != nil &&
		strings.EqualFold(left.Scheme, right.Scheme) &&
		strings.EqualFold(left.Host, right.Host)
}

func newGitHubClient(config cliConfig, httpClient *http.Client) (*githubClient, error) {
	baseURL, err := url.Parse(config.APIURL)
	if err != nil || !baseURL.IsAbs() || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("invalid GitHub API URL")
	}
	if config.Token == "" {
		return nil, errors.New("GitHub token is required")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 20 * time.Second}
	}
	safeClient := *httpClient
	previousRedirectPolicy := safeClient.CheckRedirect
	safeClient.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if !sameOrigin(baseURL, request.URL) {
			return errors.New("cross-origin redirect rejected")
		}
		if previousRedirectPolicy != nil {
			return previousRedirectPolicy(request, via)
		}
		if len(via) >= 10 {
			return errors.New("too many redirects")
		}
		return nil
	}
	return &githubClient{baseURL: baseURL, token: config.Token, httpClient: &safeClient}, nil
}

func run(
	ctx context.Context,
	config cliConfig,
	now time.Time,
	httpClient *http.Client,
	stdout, stderr io.Writer,
) int {
	client, err := newGitHubClient(config, httpClient)
	if err != nil {
		fmt.Fprintln(stderr, "Reaper delivery audit failed: invalid configuration.")
		return 1
	}
	runs, err := client.workflowRuns(ctx, config.Repository, config.Workflow)
	result := observation{Reason: "workflow-api-unavailable", CheckedAt: now.UTC()}
	auditFailed := err != nil
	if err == nil {
		result = classifyRuns(now, runs, config.MaxDeliveryDelay, config.MaxRunDuration)
		auditFailed = result.Reason == "workflow-evidence-invalid"
	}
	if err := client.syncIncident(ctx, config.Repository, result); err != nil {
		fmt.Fprintln(stderr, "Reaper delivery audit failed: incident-sync-failed.")
		return 1
	}
	if auditFailed {
		fmt.Fprintf(stderr, "Reaper delivery audit failed: %s.\n", result.Reason)
		return 1
	}
	if !result.Healthy {
		fmt.Fprintf(stdout, "Reaper delivery alert synchronized: %s.\n", result.Reason)
		return 0
	}
	fmt.Fprintln(stdout, "Reaper delivery audit passed: healthy.")
	return 0
}

func parseConfig(arguments []string, getenv func(string) string) (cliConfig, error) {
	flags := flag.NewFlagSet("reaper-delivery-audit", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var config cliConfig
	flags.StringVar(&config.Workflow, "workflow", "", "workflow file to audit")
	flags.DurationVar(&config.MaxDeliveryDelay, "max-delivery-delay", 0, "maximum time since scheduled delivery")
	flags.DurationVar(&config.MaxRunDuration, "max-run-duration", 0, "maximum active run duration")
	if err := flags.Parse(arguments); err != nil || flags.NArg() != 0 {
		return cliConfig{}, errors.New("invalid arguments")
	}
	config.Repository = getenv("GITHUB_REPOSITORY")
	config.Token = getenv("GITHUB_TOKEN")
	config.APIURL = getenv("GITHUB_API_URL")
	apiURL, err := url.Parse(config.APIURL)
	if err != nil || apiURL.Scheme != "https" || apiURL.Host == "" {
		return cliConfig{}, errors.New("invalid GitHub API URL")
	}
	if !repositoryPattern.MatchString(config.Repository) || !workflowPattern.MatchString(config.Workflow) ||
		config.Token == "" || config.MaxDeliveryDelay <= 0 || config.MaxRunDuration <= 0 {
		return cliConfig{}, errors.New("missing or invalid configuration")
	}
	return config, nil
}

func main() {
	config, err := parseConfig(os.Args[1:], os.Getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Reaper delivery audit failed: invalid configuration.")
		os.Exit(1)
	}
	os.Exit(run(context.Background(), config, time.Now().UTC(), nil, os.Stdout, os.Stderr))
}
