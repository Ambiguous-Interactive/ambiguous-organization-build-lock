package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var testNow = time.Date(2026, 7, 26, 20, 0, 0, 0, time.UTC)

func runFixture(id int64, createdAgo time.Duration, status, conclusion string) workflowRun {
	created := testNow.Add(-createdAgo)
	return workflowRun{
		ID:           id,
		Event:        "schedule",
		Status:       status,
		Conclusion:   conclusion,
		HeadSHA:      strings.Repeat("a", 40),
		CreatedAt:    created,
		RunStartedAt: created.Add(time.Minute),
		UpdatedAt:    created.Add(2 * time.Minute),
	}
}

func TestClassifyRuns(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		runs   []workflowRun
		reason string
		health bool
	}{
		{"recent success", []workflowRun{runFixture(12, 10*time.Minute, "completed", "success")}, "healthy", true},
		{"recent in progress", []workflowRun{runFixture(12, 10*time.Minute, "in_progress", "")}, "healthy", true},
		{"recent queued with API start timestamp", []workflowRun{runFixture(12, 10*time.Minute, "queued", "")}, "healthy", true},
		{"recent pending", []workflowRun{runFixture(12, 10*time.Minute, "pending", "")}, "healthy", true},
		{"recent requested", []workflowRun{runFixture(12, 10*time.Minute, "requested", "")}, "healthy", true},
		{"recent waiting", []workflowRun{runFixture(12, 10*time.Minute, "waiting", "")}, "healthy", true},
		{"delivery overdue", []workflowRun{runFixture(12, 31*time.Minute, "completed", "success")}, "scheduled-run-overdue", false},
		{"run stalled", []workflowRun{runFixture(12, 16*time.Minute, "in_progress", "")}, "scheduled-run-stalled", false},
		{"run failed", []workflowRun{runFixture(12, 10*time.Minute, "completed", "failure")}, "scheduled-run-unsuccessful", false},
		{"run cancelled", []workflowRun{runFixture(12, 10*time.Minute, "completed", "cancelled")}, "scheduled-run-unsuccessful", false},
		{"missing history", nil, "scheduled-run-missing", false},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got := classifyRuns(testNow, test.runs, 30*time.Minute, 15*time.Minute)
			if got.Healthy != test.health || got.Reason != test.reason {
				t.Fatalf("classifyRuns() = healthy %v reason %q, want %v %q", got.Healthy, got.Reason, test.health, test.reason)
			}
		})
	}
}

func TestClassifyRunsRejectsAmbiguousEvidence(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		edit func(*workflowRun)
	}{
		{"wrong event", func(run *workflowRun) { run.Event = "workflow_dispatch" }},
		{"invalid status", func(run *workflowRun) { run.Status = "waiting" }},
		{"completed without conclusion", func(run *workflowRun) { run.Conclusion = "" }},
		{"active with conclusion", func(run *workflowRun) { run.Status, run.Conclusion = "in_progress", "success" }},
		{"invalid SHA", func(run *workflowRun) { run.HeadSHA = "main" }},
		{"future creation", func(run *workflowRun) { run.CreatedAt = testNow.Add(time.Minute) }},
		{"start before creation", func(run *workflowRun) { run.RunStartedAt = run.CreatedAt.Add(-time.Second) }},
		{"update before start", func(run *workflowRun) { run.UpdatedAt = run.RunStartedAt.Add(-time.Second) }},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			run := runFixture(12, 10*time.Minute, "completed", "success")
			test.edit(&run)
			got := classifyRuns(testNow, []workflowRun{run}, 30*time.Minute, 15*time.Minute)
			if got.Healthy || got.Reason != "workflow-evidence-invalid" {
				t.Fatalf("classifyRuns() = healthy %v reason %q", got.Healthy, got.Reason)
			}
		})
	}
}

func TestIncidentBodyContainsOnlySanitizedEvidence(t *testing.T) {
	t.Parallel()
	run := runFixture(42, 31*time.Minute, "completed", "success")
	observation := classifyRuns(testNow, []workflowRun{run}, 30*time.Minute, 15*time.Minute)
	body := incidentBody(observation)
	for _, expected := range []string{
		incidentMarker,
		"Reason: `scheduled-run-overdue`",
		"Checked at: `2026-07-26T20:00:00Z`",
		"Latest scheduled run ID: `42`",
		"Head SHA: `" + strings.Repeat("a", 40) + "`",
		"Delivered at: `2026-07-26T19:29:00Z`",
		"Started at: `2026-07-26T19:30:00Z`",
		"Completed/updated at: `2026-07-26T19:31:00Z`",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("incident body missing %q:\n%s", expected, body)
		}
	}
	for _, forbidden := range []string{"Authorization", "token", "logs", "evidence text"} {
		if strings.Contains(strings.ToLower(body), strings.ToLower(forbidden)) {
			t.Fatalf("incident body contains forbidden detail %q", forbidden)
		}
	}
}

func TestWorkflowRunsUsesBoundedSameRepositoryRequest(t *testing.T) {
	t.Parallel()
	var requested *http.Request
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requested = request.Clone(request.Context())
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(writer, `{"workflow_runs":[{"id":9,"event":"schedule","status":"completed","conclusion":"success","head_sha":"%s","created_at":"2026-07-26T19:50:00Z","run_started_at":"2026-07-26T19:51:00Z","updated_at":"2026-07-26T19:52:00Z"}]}`, strings.Repeat("a", 40))
	}))
	defer server.Close()

	client := testGitHubClient(server.URL, server.Client())
	runs, err := client.workflowRuns(context.Background(), "owner/repo", "reap-stale-locks.yml")
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || runs[0].ID != 9 {
		t.Fatalf("unexpected runs: %#v", runs)
	}
	if requested.URL.Path != "/repos/owner/repo/actions/workflows/reap-stale-locks.yml/runs" {
		t.Fatalf("unexpected request path %q", requested.URL.Path)
	}
	if requested.URL.Query().Get("event") != "schedule" || requested.URL.Query().Get("per_page") != "2" {
		t.Fatalf("unexpected query %q", requested.URL.RawQuery)
	}
	if requested.Header.Get("Authorization") != "Bearer test-token" {
		t.Fatal("request did not use bearer authentication")
	}
}

func TestWorkflowRunsRejectsOversizedOrMalformedResponses(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		body string
	}{
		{"oversized", strings.Repeat("x", maxResponseBytes+1)},
		{"malformed", `{"workflow_runs":[`},
		{"extra JSON", `{"workflow_runs":[]} {}`},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				_, _ = fmt.Fprint(writer, test.body)
			}))
			defer server.Close()
			client := testGitHubClient(server.URL, server.Client())
			if _, err := client.workflowRuns(context.Background(), "owner/repo", "reap-stale-locks.yml"); err == nil {
				t.Fatal("workflowRuns accepted invalid response")
			}
		})
	}
}

func TestGitHubClientRejectsCrossOriginRedirectBeforeCredentialForwarding(t *testing.T) {
	t.Parallel()
	var redirected atomic.Bool
	destination := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		redirected.Store(true)
	}))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, destination.URL+"/stolen", http.StatusFound)
	}))
	defer source.Close()

	client, err := newGitHubClient(
		cliConfig{APIURL: source.URL, Repository: "owner/repo", Token: "test-token"},
		source.Client(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.workflowRuns(context.Background(), "owner/repo", "reap-stale-locks.yml"); err == nil {
		t.Fatal("workflowRuns followed a cross-origin redirect")
	}
	if redirected.Load() {
		t.Fatal("cross-origin redirect reached the destination")
	}
}

func TestWorkflowRunsRejectsRepositoryMismatchBeforeRequest(t *testing.T) {
	t.Parallel()
	var requested atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requested.Store(true)
	}))
	defer server.Close()

	client := testGitHubClient(server.URL, server.Client())
	if _, err := client.workflowRuns(
		t.Context(),
		"other/repository",
		"reap-stale-locks.yml",
	); err == nil {
		t.Fatal("workflowRuns accepted a repository other than the configured one")
	}
	if requested.Load() {
		t.Fatal("repository mismatch reached the server")
	}
}

func TestSyncIncidentDeduplicatesAndTransitionsOneIssue(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name       string
		existing   *incidentIssue
		healthy    bool
		wantMethod string
		wantPath   string
		wantState  string
	}{
		{"create alert", nil, false, http.MethodPost, "/repos/owner/repo/issues", ""},
		{"update open alert", &incidentIssue{Number: 77, State: "open", Title: incidentTitle, Body: incidentMarker}, false, http.MethodPatch, "/repos/owner/repo/issues/77", "open"},
		{"reopen closed alert", &incidentIssue{Number: 77, State: "closed", Title: incidentTitle, Body: incidentMarker}, false, http.MethodPatch, "/repos/owner/repo/issues/77", "open"},
		{"close recovered alert", &incidentIssue{Number: 77, State: "open", Title: incidentTitle, Body: incidentMarker}, true, http.MethodPatch, "/repos/owner/repo/issues/77", "closed"},
		{"leave closed healthy incident unchanged", &incidentIssue{Number: 77, State: "closed", Title: incidentTitle, Body: incidentMarker}, true, "", "", ""},
		{"healthy without incident", nil, true, "", "", ""},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var mutationMethod, mutationPath, mutationState string
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				switch request.Method {
				case http.MethodGet:
					issues := []incidentIssue{}
					if test.existing != nil {
						test.existing.User.Login = incidentActor
						issues = append(issues, *test.existing)
					}
					_ = json.NewEncoder(writer).Encode(issues)
				default:
					mutationMethod, mutationPath = request.Method, request.URL.Path
					var body map[string]any
					if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					mutationState, _ = body["state"].(string)
					writer.WriteHeader(http.StatusOK)
					_, _ = fmt.Fprint(writer, `{}`)
				}
			}))
			defer server.Close()

			client := testGitHubClient(server.URL, server.Client())
			observation := classifyRuns(testNow, []workflowRun{runFixture(9, 10*time.Minute, "completed", "success")}, 30*time.Minute, 15*time.Minute)
			if !test.healthy {
				observation = classifyRuns(testNow, nil, 30*time.Minute, 15*time.Minute)
			}
			if err := client.syncIncident(context.Background(), "owner/repo", observation); err != nil {
				t.Fatal(err)
			}
			if mutationMethod != test.wantMethod || mutationPath != test.wantPath || mutationState != test.wantState {
				t.Fatalf("mutation = %s %s state %q, want %s %s state %q", mutationMethod, mutationPath, mutationState, test.wantMethod, test.wantPath, test.wantState)
			}
		})
	}
}

func TestSyncIncidentRejectsUntrustedOrDuplicateMarkerIssues(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		issues func() []incidentIssue
		error  bool
	}{
		{
			name: "untrusted marker is ignored",
			issues: func() []incidentIssue {
				issue := incidentIssue{Number: 77, State: "open", Title: incidentTitle, Body: incidentMarker}
				issue.User.Login = "untrusted-user"
				return []incidentIssue{issue}
			},
		},
		{
			name: "duplicate bot markers fail closed",
			issues: func() []incidentIssue {
				first := incidentIssue{Number: 77, State: "open", Title: incidentTitle, Body: incidentMarker}
				first.User.Login = incidentActor
				second := incidentIssue{Number: 78, State: "closed", Title: incidentTitle, Body: incidentMarker}
				second.User.Login = incidentActor
				return []incidentIssue{first, second}
			},
			error: true,
		},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var creates int
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if request.Method == http.MethodGet {
					_ = json.NewEncoder(writer).Encode(test.issues())
					return
				}
				creates++
				writer.WriteHeader(http.StatusCreated)
				_, _ = fmt.Fprint(writer, `{}`)
			}))
			defer server.Close()

			client := testGitHubClient(server.URL, server.Client())
			err := client.syncIncident(context.Background(), "owner/repo", classifyRuns(testNow, nil, 30*time.Minute, 15*time.Minute))
			if (err != nil) != test.error {
				t.Fatalf("syncIncident error = %v, want error %v", err, test.error)
			}
			if test.error && creates != 0 {
				t.Fatalf("ambiguous incident created %d issues", creates)
			}
			if !test.error && creates != 1 {
				t.Fatalf("untrusted marker resulted in %d creates, want 1", creates)
			}
		})
	}
}

func TestRunSucceedsAfterSynchronizingKnownAlert(t *testing.T) {
	t.Parallel()
	var issueCreated bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case strings.Contains(request.URL.Path, "/actions/workflows/"):
			_, _ = fmt.Fprint(writer, `{"workflow_runs":[]}`)
		case request.Method == http.MethodGet:
			_, _ = fmt.Fprint(writer, `[]`)
		default:
			issueCreated = true
			writer.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprint(writer, `{}`)
		}
	}))
	defer server.Close()

	config := cliConfig{
		Repository:       "owner/repo",
		Token:            "test-token",
		APIURL:           server.URL,
		Workflow:         "reap-stale-locks.yml",
		MaxDeliveryDelay: 30 * time.Minute,
		MaxRunDuration:   15 * time.Minute,
	}
	var stdout, stderr strings.Builder
	if code := run(context.Background(), config, testNow, server.Client(), &stdout, &stderr); code != 0 {
		t.Fatalf("run returned %d, want 0", code)
	}
	if !issueCreated || !strings.Contains(stdout.String(), "scheduled-run-missing") || stderr.Len() != 0 ||
		strings.Contains(stdout.String(), "test-token") {
		t.Fatalf("run did not safely report synchronized alert: created=%v stdout=%q stderr=%q", issueCreated, stdout.String(), stderr.String())
	}
}

func TestRunFailsClosedAfterSynchronizingAmbiguousEvidence(t *testing.T) {
	t.Parallel()
	var issueCreated bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case strings.Contains(request.URL.Path, "/actions/workflows/"):
			_, _ = fmt.Fprint(writer, `{"workflow_runs":[`)
		case request.Method == http.MethodGet:
			_, _ = fmt.Fprint(writer, `[]`)
		default:
			issueCreated = true
			writer.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprint(writer, `{}`)
		}
	}))
	defer server.Close()

	config := cliConfig{
		Repository:       "owner/repo",
		Token:            "test-token",
		APIURL:           server.URL,
		Workflow:         "reap-stale-locks.yml",
		MaxDeliveryDelay: 30 * time.Minute,
		MaxRunDuration:   15 * time.Minute,
	}
	var stdout, stderr strings.Builder
	if code := run(context.Background(), config, testNow, server.Client(), &stdout, &stderr); code != 1 {
		t.Fatalf("run returned %d, want 1", code)
	}
	if !issueCreated || stdout.Len() != 0 || !strings.Contains(stderr.String(), "workflow-api-unavailable") ||
		strings.Contains(stderr.String(), "test-token") {
		t.Fatalf("run did not fail closed safely: created=%v stdout=%q stderr=%q", issueCreated, stdout.String(), stderr.String())
	}
}

func testGitHubClient(baseURL string, httpClient *http.Client) *githubClient {
	client, err := newGitHubClient(
		cliConfig{APIURL: baseURL, Repository: "owner/repo", Token: "test-token"},
		httpClient,
	)
	if err != nil {
		panic(err)
	}
	return client
}
