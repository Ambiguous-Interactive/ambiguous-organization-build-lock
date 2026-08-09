package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/githubissue"
)

const (
	incidentTitle    = "ops: scheduled reaper delivery outside SLO"
	incidentMarker   = "<!-- build-lock-reaper-delivery-monitor -->"
	incidentActor    = "github-actions[bot]"
	maxResponseBytes = githubissue.DefaultResponseLimit
	issuePageSize    = githubissue.DefaultPageSize
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

type incidentIssue = githubissue.Issue

type githubClient struct {
	issues *githubissue.Client
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
	if !repositoryPattern.MatchString(repository) ||
		repository != client.issues.Repository() ||
		!workflowPattern.MatchString(workflow) {
		return nil, errors.New("invalid workflow run target")
	}
	endpoint := client.issues.RepositoryPath(
		"/actions/workflows/" + url.PathEscape(workflow) + "/runs?event=schedule&per_page=2",
	)
	var payload struct {
		WorkflowRuns []workflowRun `json:"workflow_runs"`
	}
	if _, err := client.issues.RequestJSON(ctx, http.MethodGet, endpoint, nil, &payload); err != nil {
		return nil, err
	}
	return payload.WorkflowRuns, nil
}

func (client *githubClient) syncIncident(ctx context.Context, repository string, result observation) error {
	if !repositoryPattern.MatchString(repository) || repository != client.issues.Repository() {
		return errors.New("invalid incident repository")
	}
	state := "open"
	if result.Healthy {
		state = "closed"
	}
	_, err := client.issues.Sync(
		ctx,
		incidentIdentity(),
		githubissue.Desired{
			State:            state,
			Title:            incidentTitle,
			Body:             incidentBody(result),
			ClosedIsTerminal: true,
		},
	)
	return err
}

func incidentIdentity() githubissue.Identity {
	return githubissue.Identity{
		Marker:       incidentMarker,
		Author:       incidentActor,
		Title:        incidentTitle,
		RequireTitle: true,
	}
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
		httpClient = &http.Client{}
	}
	issues, err := githubissue.New(githubissue.Options{
		APIURL:     baseURL.String(),
		Repository: config.Repository,
		Token:      config.Token,
		UserAgent:  "ambiguous-build-lock-reaper-delivery-audit",
		HTTPClient: httpClient,
	})
	if err != nil {
		return nil, err
	}
	return &githubClient{issues: issues}, nil
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
		_, _ = fmt.Fprintln(stderr, "Reaper delivery audit failed: invalid configuration.")
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
		_, _ = fmt.Fprintln(stderr, "Reaper delivery audit failed: incident-sync-failed.")
		return 1
	}
	if auditFailed {
		_, _ = fmt.Fprintf(stderr, "Reaper delivery audit failed: %s.\n", result.Reason)
		return 1
	}
	if !result.Healthy {
		_, _ = fmt.Fprintf(stdout, "Reaper delivery alert synchronized: %s.\n", result.Reason)
		return 0
	}
	_, _ = fmt.Fprintln(stdout, "Reaper delivery audit passed: healthy.")
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
