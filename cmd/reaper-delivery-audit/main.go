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
	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/runnotice"
)

const (
	incidentTitle    = "ops: scheduled reaper delivery outside SLO"
	incidentMarker   = "<!-- build-lock-reaper-delivery-monitor -->"
	incidentActor    = "github-actions[bot]"
	maxResponseBytes = githubissue.DefaultResponseLimit
	issuePageSize    = githubissue.DefaultPageSize

	reasonHealthy              = "healthy"
	reasonRunMissing           = "scheduled-run-missing"
	reasonRunOverdue           = "scheduled-run-overdue"
	reasonRunStalled           = "scheduled-run-stalled"
	reasonRunUnsuccessful      = "scheduled-run-unsuccessful"
	reasonEvidenceInvalid      = "workflow-evidence-invalid"
	reasonRunHistoryUnreadable = "workflow-api-unavailable"
	reasonSyncFailed           = "incident-sync-failed"
	// reasonRunNoticeUnpublished reports that this run could not state what it
	// proved. It is the run's own outcome, not a property of the reaper.
	reasonRunNoticeUnpublished = "run-notice-unpublished"
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
	SummaryPath      string
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
	result := observation{Reason: reasonEvidenceInvalid, CheckedAt: now.UTC()}
	if maxDeliveryDelay <= 0 || maxRunDuration <= 0 || now.IsZero() {
		return result
	}
	if len(runs) == 0 {
		result.Reason = reasonRunMissing
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
		result.Reason = reasonRunOverdue
		return result
	}
	if latest.Status != "completed" && age > maxRunDuration {
		result.Reason = reasonRunStalled
		return result
	}
	if latest.Status == "completed" && latest.Conclusion != "success" {
		result.Reason = reasonRunUnsuccessful
		return result
	}
	result.Healthy = true
	result.Reason = reasonHealthy
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
	// The summary and the annotations are where an operator looks first. A
	// conclusion this run cannot publish is evidence it did not read, so every
	// classified outcome is published and a refusal fails the run.
	reporter := runnotice.New(config.SummaryPath, stderr)
	client, err := newGitHubClient(config, httpClient)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "Reaper delivery audit failed: invalid configuration.")
		return 1
	}
	runs, err := client.workflowRuns(ctx, config.Repository, config.Workflow)
	result := observation{Reason: reasonRunHistoryUnreadable, CheckedAt: now.UTC()}
	auditFailed := err != nil
	if err == nil {
		result = classifyRuns(now, runs, config.MaxDeliveryDelay, config.MaxRunDuration)
		auditFailed = result.Reason == reasonEvidenceInvalid
	}
	if syncErr := client.syncIncident(ctx, config.Repository, result); syncErr != nil {
		if !report(stderr, reporter, reasonSyncFailed, "") {
			return 1
		}
		_, _ = fmt.Fprintln(stderr, "Reaper delivery audit failed: incident-sync-failed.")
		return 1
	}
	if auditFailed {
		if !report(stderr, reporter, result.Reason, "") {
			return 1
		}
		_, _ = fmt.Fprintf(stderr, "Reaper delivery audit failed: %s.\n", result.Reason)
		return 1
	}
	if !result.Healthy {
		if !report(stderr, reporter, result.Reason, reaperHandle(result.Latest)) {
			return 1
		}
		_, _ = fmt.Fprintf(stdout, "Reaper delivery alert synchronized: %s.\n", result.Reason)
		return 0
	}
	if !report(stderr, reporter, reasonHealthy, "") {
		return 1
	}
	_, _ = fmt.Fprintln(stdout, "Reaper delivery audit passed: healthy.")
	return 0
}

// monitorMeanings states, for each reason this audit returns, what the run
// concluded. A reason code alone leaves an operator to guess the consequence,
// which is the log-only condition #326 records.
var monitorMeanings = map[string]string{
	reasonHealthy:         "The latest scheduled reaper delivery is on time and its run succeeded.",
	reasonRunMissing:      "No scheduled reaper delivery can be proven, so stale build locks are not being reaped.",
	reasonRunOverdue:      "The latest scheduled reaper delivery is later than the delivery threshold, so reaping is late.",
	reasonRunStalled:      "The latest scheduled reaper run is still active past the run-duration threshold, so reaping is stalled.",
	reasonRunUnsuccessful: "The latest scheduled reaper run did not succeed, so stale build locks may not have been reaped.",
	reasonEvidenceInvalid: "The scheduled reaper run history could not be read, so delivery status is unknown.",
	reasonRunHistoryUnreadable: "The scheduled reaper run history could not be requested, so delivery status is " +
		"unknown.",
	reasonSyncFailed: "The alert issue could not be synchronized, so delivery status is unknown.",
}

// reaperHandle names the exact scheduled run the conclusion is about, and the
// alert issue that carries the detail. A missing delivery has no run to name.
func reaperHandle(latest *workflowRun) string {
	if latest == nil {
		return fmt.Sprintf("Alert issue: %q.", incidentTitle)
	}
	return fmt.Sprintf(
		"Latest scheduled run: `%d` delivered at `%s`. Alert issue: %q.",
		latest.ID,
		latest.CreatedAt.UTC().Format(time.RFC3339),
		incidentTitle,
	)
}

// conclude publishes one conclusion. A handle is what makes a conclusion
// alerting, so an alerting conclusion can never be published without naming what
// the operator acts on. The annotation repeats the summary line without its
// Markdown, so the two channels cannot drift apart.
func conclude(reporter *runnotice.Reporter, reason, handle string) error {
	meaning, stated := monitorMeanings[reason]
	if !stated {
		return runnotice.ErrUnstatedReason
	}
	summary := meaning + " Reason: `" + reason + "`."
	warning := ""
	if handle != "" {
		summary += " " + handle
		warning = strings.ReplaceAll(summary, "`", "")
	}
	return reporter.Publish(runnotice.Conclusion{Summary: summary, Warning: warning})
}

// report publishes one conclusion and reports a refusal as the run's own
// fail-closed outcome. No green run may claim a verdict the run did not publish.
func report(stderr io.Writer, reporter *runnotice.Reporter, reason, handle string) bool {
	if err := conclude(reporter, reason, handle); err != nil {
		_, _ = fmt.Fprintf(
			stderr,
			"Reaper delivery audit failed: %s (%s).\n",
			reasonRunNoticeUnpublished,
			err,
		)
		return false
	}
	return true
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
	config.SummaryPath = getenv("GITHUB_STEP_SUMMARY")
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
