package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"go.yaml.in/yaml/v4"
)

const (
	testServerURL = "https://github.com"
	testLock      = "wallstop-organization-builds"
)

func digestOf(fields ...string) string {
	payload := fmt.Sprintf(
		`{"repository":%q,"workflow":%q,"job":%q,"runId":%q,"runAttempt":%q,"runnerId":%q,"reason":%q}`,
		fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[6],
	)
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}

func incidentFixture() incident {
	digest := digestOf(
		"Ambiguous-Interactive/qora-redux",
		"Unity Tests",
		"editmode",
		"30416530625",
		"1",
		"ELI-MACHINE",
		incidentReason,
	)
	return incident{
		IncidentID:     "incident-" + digest[:24],
		Repository:     "Ambiguous-Interactive/qora-redux",
		Workflow:       "Unity Tests",
		Job:            "editmode",
		RunID:          "30416530625",
		RunAttempt:     "1",
		RunURL:         testServerURL + "/Ambiguous-Interactive/qora-redux/actions/runs/30416530625",
		RunnerID:       "ELI-MACHINE",
		ReportedAt:     "2026-07-29T02:19:43.885Z",
		Reason:         incidentReason,
		EvidenceDigest: digest,
	}
}

func stateFixture(t *testing.T, active *incident) []byte {
	t.Helper()
	state := map[string]any{
		"lock":           "wallstop-organization-builds",
		"schemaVersion":  5,
		"holders":        []any{},
		"queue":          []any{},
		"reservations":   []any{},
		"activeIncident": nil,
		"updatedAt":      "2026-07-29T03:06:27Z",
	}
	if active != nil {
		state["activeIncident"] = *active
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestClassifyStateSeparatesHealthyIncidentAndAmbiguousEvidence(t *testing.T) {
	t.Parallel()
	active := incidentFixture()
	cases := []struct {
		name   string
		state  func() []byte
		reason string
	}{
		{"no active incident", func() []byte { return stateFixture(t, nil) }, reasonHealthy},
		{"active incident", func() []byte { return stateFixture(t, &active) }, reasonIncidentActive},
		{"malformed JSON", func() []byte { return []byte(`{"schemaVersion":5,`) }, reasonStateInvalid},
		{"trailing JSON", func() []byte { return append(stateFixture(t, nil), '{', '}') }, reasonStateInvalid},
		{"missing schema", func() []byte { return []byte(`{"activeIncident":null}`) }, reasonStateInvalid},
		{
			"unsupported newer schema",
			func() []byte { return []byte(`{"schemaVersion":6,"activeIncident":null}`) },
			reasonStateInvalid,
		},
		{
			"schema 5 without activeIncident key",
			func() []byte { return []byte(`{"schemaVersion":5}`) },
			reasonStateInvalid,
		},
		{
			"older schema carrying an incident",
			func() []byte { return []byte(`{"schemaVersion":4,"activeIncident":{}}`) },
			reasonStateInvalid,
		},
		{"older schema without incident", func() []byte { return []byte(`{"schemaVersion":4}`) }, reasonHealthy},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got := classifyState(test.state(), testServerURL, testLock)
			if got.Reason != test.reason {
				t.Fatalf("classifyState() reason = %q, want %q", got.Reason, test.reason)
			}
			if (got.Incident != nil) != (test.reason == reasonIncidentActive) {
				t.Fatalf("classifyState() incident presence = %v for reason %q", got.Incident != nil, got.Reason)
			}
		})
	}
}

// reseal recomputes the digest and identifier so a case proves the specific
// validation rule it names rather than only the digest binding.
func reseal(active *incident) {
	active.EvidenceDigest = digestOf(
		active.Repository,
		active.Workflow,
		active.Job,
		active.RunID,
		active.RunAttempt,
		active.RunnerID,
		active.Reason,
	)
	active.IncidentID = "incident-" + active.EvidenceDigest[:24]
}

func TestClassifyStateRejectsUnprovableIncidentEvidence(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		edit    func(*incident)
		rebuild bool
	}{
		{name: "identifier not derived from digest", edit: func(active *incident) {
			active.IncidentID = "incident-" + strings.Repeat("b", 24)
		}},
		{name: "identifier shape", edit: func(active *incident) { active.IncidentID = "incident-XYZ" }},
		{name: "tampered provenance", edit: func(active *incident) { active.Job = "playmode" }},
		{name: "digest shape", edit: func(active *incident) { active.EvidenceDigest = "not-a-digest" }},
		{name: "repository shape", edit: func(active *incident) { active.Repository = "qora-redux" }, rebuild: true},
		{
			name:    "repository traversal",
			edit:    func(active *incident) { active.Repository = "Ambiguous-Interactive/.." },
			rebuild: true,
		},
		{name: "empty workflow", edit: func(active *incident) { active.Workflow = "" }, rebuild: true},
		{name: "empty job", edit: func(active *incident) { active.Job = "" }, rebuild: true},
		{name: "run identifier", edit: func(active *incident) { active.RunID = "0" }, rebuild: true},
		{name: "run attempt", edit: func(active *incident) { active.RunAttempt = "one" }, rebuild: true},
		{name: "foreign run URL", edit: func(active *incident) {
			active.RunURL = "https://example.test/x/actions/runs/1"
		}},
		{name: "mismatched run URL", edit: func(active *incident) {
			active.RunURL = testServerURL + "/other/repo/actions/runs/1"
		}},
		{name: "empty runner", edit: func(active *incident) { active.RunnerID = "" }, rebuild: true},
		{name: "timestamp", edit: func(active *incident) { active.ReportedAt = "yesterday" }},
		{name: "reason", edit: func(active *incident) { active.Reason = "unity-return-400006" }, rebuild: true},
		{name: "control character in runner", edit: func(active *incident) { active.RunnerID = "ELI\nMACHINE" }, rebuild: true},
		{name: "tab in workflow", edit: func(active *incident) { active.Workflow = "Unity\tTests" }, rebuild: true},
		{name: "line separator in workflow", edit: func(active *incident) { active.Workflow = "Unity\u2028Tests" }, rebuild: true},
		{name: "paragraph separator in job", edit: func(active *incident) { active.Job = "edit\u2029mode" }, rebuild: true},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			active := incidentFixture()
			test.edit(&active)
			if test.rebuild {
				reseal(&active)
			}
			got := classifyState(stateFixture(t, &active), testServerURL, testLock)
			if got.Reason != reasonStateInvalid || got.Incident != nil {
				t.Fatalf("classifyState() = %q with incident %v, want %q", got.Reason, got.Incident != nil, reasonStateInvalid)
			}
		})
	}
}

// Refusing to publish a provable incident is the failure this audit exists to
// prevent, so provenance that is merely awkward to render must still be
// published, with the rendering made safe instead.
func TestProvableIncidentIsAlwaysPublishable(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		edit     func(*incident)
		expected []string
	}{
		{
			name: "table and code separators in job",
			edit: func(active *incident) { active.Job = "editmode` | evil" },
			expected: []string{
				"| Job | ``editmode` \\| evil`` |",
			},
		},
		{
			name: "leading and trailing backticks in runner",
			edit: func(active *incident) { active.RunnerID = "`ELI`" },
			expected: []string{
				"| Runner | `` `ELI` `` |",
			},
		},
		{
			// GitHub Flavored Markdown's cell scanner is maximal-munch, so an
			// already-escaped pipe is absorbed rather than splitting the cell. These
			// exact renderings were confirmed against GitHub's own renderer.
			name: "pre-escaped pipe in job",
			edit: func(active *incident) { active.Job = `a\|b` },
			expected: []string{
				"| Job | `a\\\\|b` |",
			},
		},
		{
			name: "trailing backslash in runner",
			edit: func(active *incident) { active.RunnerID = `ELI\` },
			expected: []string{
				"| Runner | `ELI\\` |",
			},
		},
		{
			name: "long backtick run in workflow",
			edit: func(active *incident) { active.Workflow = "```a|b```" },
			expected: []string{
				"| Workflow | ```` ```a\\|b``` ```` |",
			},
		},
		{
			name: "workflow longer than the rendered bound",
			edit: func(active *incident) { active.Workflow = strings.Repeat("w", maxRenderedRunes+50) },
			expected: []string{
				"| Workflow | `" + strings.Repeat("w", maxRenderedRunes) + "` (truncated) |",
			},
		},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			active := incidentFixture()
			test.edit(&active)
			reseal(&active)

			got := classifyState(stateFixture(t, &active), testServerURL, testLock)
			if got.Reason != reasonIncidentActive {
				t.Fatalf("classifyState() reason = %q, want %q", got.Reason, reasonIncidentActive)
			}
			body := alertBody(active, testLock, testServerURL, "owner/repo")
			for _, expected := range test.expected {
				if !strings.Contains(body, expected) {
					t.Fatalf("alert body missing safely rendered %q:\n%s", expected, body)
				}
			}
			for _, line := range strings.Split(body, "\n") {
				if !strings.HasPrefix(line, "| ") {
					continue
				}
				if cells := strings.Count(line, "|") - strings.Count(line, "\\|"); cells != 3 {
					t.Fatalf("rendered table row has %d separators, breaking the table: %q", cells, line)
				}
			}
		})
	}
}

func TestClassifyStateRejectsStateForAnotherLock(t *testing.T) {
	t.Parallel()
	state := `{"lock":"some-other-lock","schemaVersion":5,"activeIncident":null}`
	if got := classifyState([]byte(state), testServerURL, testLock); got.Reason != reasonStateInvalid {
		t.Fatalf("classifyState() reason = %q, want %q", got.Reason, reasonStateInvalid)
	}
}

func TestClassifyStateRejectsUnknownIncidentFields(t *testing.T) {
	t.Parallel()
	state := `{"schemaVersion":5,"activeIncident":{"incidentId":"incident-` +
		strings.Repeat("a", 24) + `","surprise":true}}`
	if got := classifyState([]byte(state), testServerURL, testLock); got.Reason != reasonStateInvalid {
		t.Fatalf("classifyState() reason = %q, want %q", got.Reason, reasonStateInvalid)
	}
}

// The expected digests below were produced by the committed JavaScript runtime's
// incidentEvidenceDigest in .github/dist/build-lock.js. They pin cross-runtime
// canonicalization, including the HTML characters that Go escapes by default and
// the JavaScript runtime does not.
func TestIncidentDigestMatchesCommittedRuntimeCanonicalization(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		edit   func(*incident)
		digest string
	}{
		{
			name:   "live provenance shape",
			edit:   func(*incident) {},
			digest: "a511a618ef01e71c44820ded9ce4f1ba36667e41cd2e7fd99d5c13bda398d76d",
		},
		{
			name: "HTML and escape characters",
			edit: func(active *incident) {
				active.Repository = "a/b"
				active.Workflow = `Build & "Test" <all>`
				active.Job = `edit\mode`
				active.RunID = "1"
				active.RunAttempt = "2"
				active.RunnerID = "DAD-MACHINE"
			},
			digest: "442582c004693ba77cf7c6b8596b4d7c400a7ddf7b4a0d5e76546a83a0662633",
		},
		{
			name: "non-ASCII provenance",
			edit: func(active *incident) {
				active.Repository = "a/b"
				active.Workflow = "héllo — ünïcode ✓"
				active.Job = "j/k (x)"
				active.RunID = "9"
				active.RunAttempt = "1"
				active.RunnerID = "r&r"
			},
			digest: "a811b5deb5c83feaca10dba35df866d1c5c0de56d2a1b720b22274430b74b2c1",
		},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			active := incidentFixture()
			test.edit(&active)
			digest, err := incidentDigest(active)
			if err != nil {
				t.Fatal(err)
			}
			if digest != test.digest {
				t.Fatalf("incidentDigest() = %q, want the committed runtime digest %q", digest, test.digest)
			}

			active.EvidenceDigest = digest
			active.IncidentID = "incident-" + digest[:24]
			active.RunURL = testServerURL + "/" + active.Repository + "/actions/runs/" + active.RunID
			if got := classifyState(stateFixture(t, &active), testServerURL, testLock); got.Reason != reasonIncidentActive {
				t.Fatalf("classifyState() reason = %q, want %q", got.Reason, reasonIncidentActive)
			}
		})
	}
}

func TestAlertBodyPublishesRecoveryInstructionsWithoutSecretEvidence(t *testing.T) {
	t.Parallel()
	active := incidentFixture()
	body := alertBody(active, testLock, testServerURL, "owner/repo")

	for _, expected := range []string{
		alertMarker,
		"`" + testLock + "`",
		"`" + active.IncidentID + "`",
		"| `operation` | `" + recoveryOperation + "` |",
		"| `portal-cleanup-confirmed` | `true` |",
		testServerURL + "/owner/repo/actions/workflows/recover-build-lock.yml",
		recoveryWorkflowPath,
		recoveryWorkflowName,
		"gh workflow run recover-build-lock.yml --repo='github.com/owner/repo' --raw-field 'operation=recover-incident' --raw-field 'incident-id=" + active.IncidentID + "' --raw-field 'portal-cleanup-confirmed=true'",
		"`Ambiguous-Interactive/qora-redux`",
		"`Unity Tests`",
		"`ELI-MACHINE`",
		"`2026-07-29T02:19:43.885Z`",
		active.RunURL,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("alert body missing %q:\n%s", expected, body)
		}
	}
	if strings.Contains(body, active.EvidenceDigest) {
		t.Fatal("alert body must never publish the incident evidence digest")
	}
	for _, forbidden := range []string{"Authorization", "Bearer ", "secrets.", "PRIVATE_KEY"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("alert body contains forbidden detail %q", forbidden)
		}
	}
}

func TestShellWordQuotesHostileValues(t *testing.T) {
	t.Parallel()
	if got, want := shellWord("ghe.example'; echo unsafe"), `'ghe.example'"'"'; echo unsafe'`; got != want {
		t.Fatalf("shellWord() = %q, want %q", got, want)
	}
}

func TestAlertBodyIsDeterministicAndStateless(t *testing.T) {
	t.Parallel()
	active := incidentFixture()
	first := alertBody(active, testLock, testServerURL, "owner/repo")
	second := alertBody(active, testLock, testServerURL, "owner/repo")

	if first != second {
		t.Fatal("alert body must be deterministic so an unchanged incident does not churn the issue")
	}
	// A closed alert keeps its last published body, so the body must never assert
	// a live status that closing would contradict.
	for _, forbidden := range []string{"State: `alerting`", "State: `resolved`"} {
		if strings.Contains(first, forbidden) {
			t.Fatalf("retained alert record must not claim the live status %q", forbidden)
		}
	}
}

func TestAlertInstructionsMatchTheDeclaredRecoveryWorkflow(t *testing.T) {
	t.Parallel()
	contents, err := os.ReadFile("../../" + recoveryWorkflowPath)
	if err != nil {
		t.Fatal(err)
	}
	var workflow struct {
		Name string `yaml:"name"`
		On   struct {
			WorkflowDispatch struct {
				Inputs map[string]struct {
					Type    string   `yaml:"type"`
					Options []string `yaml:"options"`
				} `yaml:"inputs"`
			} `yaml:"workflow_dispatch"`
		} `yaml:"on"`
	}
	if err := yaml.Unmarshal(contents, &workflow); err != nil {
		t.Fatal(err)
	}

	if workflow.Name != recoveryWorkflowName {
		t.Fatalf("recovery workflow name = %q, want %q", workflow.Name, recoveryWorkflowName)
	}
	active := incidentFixture()
	body := alertBody(active, testLock, testServerURL, "owner/repo")
	for _, input := range []string{"operation", "incident-id", "portal-cleanup-confirmed"} {
		declared, ok := workflow.On.WorkflowDispatch.Inputs[input]
		if !ok {
			t.Fatalf("recovery workflow does not declare instructed input %q", input)
		}
		if !strings.Contains(body, "| `"+input+"` |") {
			t.Fatalf("alert body does not instruct declared input %q", input)
		}
		if input == "operation" && !slicesContains(declared.Options, recoveryOperation) {
			t.Fatalf("recovery workflow operation options %v do not offer %q", declared.Options, recoveryOperation)
		}
	}
}

func slicesContains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

type stubGitHub struct {
	t          *testing.T
	issues     string
	created    atomic.Int64
	patched    atomic.Int64
	lastBody   atomic.Value
	lastState  atomic.Value
	stateBody  []byte
	stateFail  int
	issuesFail int
	mutex      sync.Mutex
	published  []map[string]any
}

func (stub *stubGitHub) handler() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case strings.HasPrefix(request.URL.Path, "/repos/owner/repo/contents/"):
			if stub.stateFail != 0 {
				writer.WriteHeader(stub.stateFail)
				return
			}
			writer.Header().Set("Content-Type", "application/vnd.github.raw")
			_, _ = writer.Write(stub.stateBody)
		case request.Method == http.MethodGet && request.URL.Path == "/repos/owner/repo/issues":
			if stub.issuesFail != 0 {
				writer.WriteHeader(stub.issuesFail)
				return
			}
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(stub.currentIssues()))
		case request.Method == http.MethodPost && request.URL.Path == "/repos/owner/repo/issues":
			stub.created.Add(1)
			stub.record(request)
			// Real GitHub returns the created issue from later listings, and the
			// audit relies on that to prove its own publication is discoverable.
			stub.publish()
			writer.WriteHeader(http.StatusCreated)
			_, _ = writer.Write([]byte(`{"number":4242}`))
		case request.Method == http.MethodPatch && strings.HasPrefix(request.URL.Path, "/repos/owner/repo/issues/"):
			stub.patched.Add(1)
			stub.record(request)
			_, _ = writer.Write([]byte(`{"number":1}`))
		default:
			stub.t.Errorf("unexpected request %s %s", request.Method, request.URL.Path)
			writer.WriteHeader(http.StatusNotFound)
		}
	})
}

// currentIssues returns the seeded listing plus anything this stub published, so
// discovery behaves like the real API rather than a frozen fixture.
func (stub *stubGitHub) currentIssues() string {
	stub.mutex.Lock()
	defer stub.mutex.Unlock()
	listing := []map[string]any{}
	if stub.issues != "" {
		if err := json.Unmarshal([]byte(stub.issues), &listing); err != nil {
			stub.t.Fatalf("seeded issue fixture is not a list: %v", err)
		}
	}
	listing = append(listing, stub.published...)
	encoded, err := json.Marshal(listing)
	if err != nil {
		stub.t.Fatal(err)
	}
	return string(encoded)
}

func (stub *stubGitHub) publish() {
	stub.mutex.Lock()
	defer stub.mutex.Unlock()
	body, _ := stub.lastBody.Load().(string)
	stub.published = append(stub.published, map[string]any{
		"number": 4242,
		"state":  "open",
		"title":  alertTitle,
		"body":   body,
		"user":   map[string]any{"login": alertAuthor},
	})
}

func (stub *stubGitHub) record(request *http.Request) {
	var payload struct {
		Body  string `json:"body"`
		State string `json:"state"`
	}
	if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
		stub.t.Errorf("decode issue payload: %v", err)
		return
	}
	stub.lastBody.Store(payload.Body)
	stub.lastState.Store(payload.State)
}

func existingAlert(t *testing.T, state, body string) string {
	t.Helper()
	encoded, err := json.Marshal([]map[string]any{{
		"number": 1,
		"state":  state,
		"title":  alertTitle,
		"body":   body,
		"user":   map[string]any{"login": alertAuthor},
	}})
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func runAudit(t *testing.T, stub *stubGitHub) (int, string, string) {
	t.Helper()
	server := httptest.NewServer(stub.handler())
	t.Cleanup(server.Close)

	var stdout, stderr strings.Builder
	code := run(
		context.Background(),
		config{
			Lock:       testLock,
			StateRef:   "lock-state",
			Repository: "owner/repo",
			APIURL:     server.URL,
			ServerURL:  testServerURL,
			Token:      "test-token",
		},
		server.Client(),
		&stdout,
		&stderr,
	)
	return code, stdout.String(), stderr.String()
}

func TestRunOpensUpdatesAndClosesExactlyOneAlert(t *testing.T) {
	t.Parallel()
	active := incidentFixture()
	activeState := stateFixture(t, &active)
	healthyState := stateFixture(t, nil)
	activeBody := alertBody(active, testLock, testServerURL, "owner/repo")

	cases := []struct {
		name          string
		state         []byte
		issues        string
		wantCode      int
		wantCreated   int64
		wantPatched   int64
		wantIssuState string
	}{
		{"incident opens the alert", activeState, `[]`, 0, 1, 0, ""},
		{
			"incident reopens a closed alert",
			activeState,
			existingAlert(t, "closed", alertMarker+"\n\nsuperseded evidence"),
			0, 0, 1, "open",
		},
		{
			"unchanged incident does not churn the alert",
			activeState,
			existingAlert(t, "open", activeBody),
			0, 0, 0, "",
		},
		{
			"recovered lock closes the alert",
			healthyState,
			existingAlert(t, "open", activeBody),
			0, 0, 1, "closed",
		},
		{
			"healthy lock without an alert writes nothing",
			healthyState,
			`[]`,
			0, 0, 0, "",
		},
		{
			"healthy lock leaves a closed alert alone",
			healthyState,
			existingAlert(t, "closed", activeBody),
			0, 0, 0, "",
		},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			stub := &stubGitHub{t: t, stateBody: test.state, issues: test.issues}
			code, stdout, stderr := runAudit(t, stub)
			if code != test.wantCode {
				t.Fatalf("run() = %d, want %d (stderr %q)", code, test.wantCode, stderr)
			}
			if stub.created.Load() != test.wantCreated || stub.patched.Load() != test.wantPatched {
				t.Fatalf(
					"created %d patched %d, want %d and %d",
					stub.created.Load(), stub.patched.Load(), test.wantCreated, test.wantPatched,
				)
			}
			if test.wantIssuState != "" {
				if got, _ := stub.lastState.Load().(string); got != test.wantIssuState {
					t.Fatalf("issue state = %q, want %q", got, test.wantIssuState)
				}
			}
			if stdout == "" {
				t.Fatal("run() must report a single-line outcome")
			}
		})
	}
}

func TestRunFailsClosedWithoutTouchingTheAlert(t *testing.T) {
	t.Parallel()
	active := incidentFixture()
	activeBody := alertBody(active, testLock, testServerURL, "owner/repo")

	cases := []struct {
		name string
		stub func() *stubGitHub
	}{
		{
			"state retrieval failure",
			func() *stubGitHub {
				return &stubGitHub{stateFail: http.StatusInternalServerError, issues: existingAlert(t, "open", activeBody)}
			},
		},
		{
			"missing state file",
			func() *stubGitHub {
				return &stubGitHub{stateFail: http.StatusNotFound, issues: existingAlert(t, "open", activeBody)}
			},
		},
		{
			"oversized state",
			func() *stubGitHub {
				return &stubGitHub{
					stateBody: []byte(strings.Repeat("x", maxStateBytes+1)),
					issues:    existingAlert(t, "open", activeBody),
				}
			},
		},
		{
			"unprovable state",
			func() *stubGitHub {
				return &stubGitHub{
					stateBody: []byte(`{"schemaVersion":5,"activeIncident":{"incidentId":"nope"}}`),
					issues:    existingAlert(t, "open", activeBody),
				}
			},
		},
		{
			"issue discovery failure",
			func() *stubGitHub {
				return &stubGitHub{
					stateBody:  stateFixture(t, &active),
					issuesFail: http.StatusInternalServerError,
				}
			},
		},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			stub := test.stub()
			stub.t = t
			code, _, stderr := runAudit(t, stub)
			if code != 1 {
				t.Fatalf("run() = %d, want 1", code)
			}
			if stub.created.Load() != 0 || stub.patched.Load() != 0 {
				t.Fatal("ambiguous evidence must never create, update, or close the alert")
			}
			if stderr == "" {
				t.Fatal("failure must report a single-line reason")
			}
		})
	}
}

// Missing an existing alert on a later page would republish a duplicate on every
// scheduled run, so discovery must walk pages and still fit its response bound
// when each issue carries a maximum-size body.
func TestAlertDiscoveryStaysBoundedAcrossPages(t *testing.T) {
	t.Parallel()
	maximumBody := strings.Repeat("x", 64*1024)
	pages := map[string][]map[string]any{}
	for page := 1; page <= 3; page++ {
		bulk := make([]map[string]any, issuePageSize)
		for index := range bulk {
			bulk[index] = map[string]any{
				"number": page*1000 + index,
				"state":  "closed",
				"title":  "unrelated",
				"body":   maximumBody,
				"user":   map[string]any{"login": "someone"},
			}
		}
		pages[strconv.Itoa(page)] = bulk
	}
	pages["3"][0] = map[string]any{
		"number": 7,
		"state":  "open",
		"title":  alertTitle,
		"body":   alertMarker + "\nprevious",
		"user":   map[string]any{"login": alertAuthor},
	}
	pages["4"] = nil

	var largest int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		query := request.URL.Query()
		if query.Get("per_page") != strconv.Itoa(issuePageSize) {
			t.Errorf("unexpected page size %q", query.Get("per_page"))
		}
		if query.Get("creator") != alertAuthor {
			t.Errorf("discovery must be restricted to this automation's own issues, got creator %q", query.Get("creator"))
		}
		if query.Get("sort") != "created" || query.Get("direction") != "asc" {
			t.Errorf("discovery must keep offsets stable, got sort=%q direction=%q", query.Get("sort"), query.Get("direction"))
		}
		encoded, err := json.Marshal(pages[request.URL.Query().Get("page")])
		if err != nil {
			t.Fatal(err)
		}
		if len(encoded) > largest {
			largest = len(encoded)
		}
		_, _ = writer.Write(encoded)
	}))
	defer server.Close()

	client, err := newGitHubClient(server.URL, "owner/repo", "test-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	found, err := client.issues.Find(context.Background(), alertIdentity())
	if err != nil {
		t.Fatal(err)
	}
	if found == nil || found.Number != 7 {
		t.Fatalf("alert on a later page was not discovered: %#v", found)
	}
	if largest > maxResponseBytes {
		t.Fatalf("a full page of maximum-size issues was %d bytes, over the %d byte bound", largest, maxResponseBytes)
	}
}

// The repository is public and both the title and the marker are published, so
// an outsider can post a lookalike. It must be ignored, not adopted and not
// treated as fatal: a fatal reading would let any user permanently suppress
// incident publication, which is exactly the visibility gap this audit closes.
func TestForeignLookalikeCannotSuppressOrCaptureTheAlert(t *testing.T) {
	t.Parallel()
	active := incidentFixture()
	issues, err := json.Marshal([]map[string]any{{
		"number": 99,
		"state":  "open",
		"title":  alertTitle,
		"body":   alertMarker + "\nplease ignore the real incident",
		"user":   map[string]any{"login": "impostor"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	stub := &stubGitHub{t: t, stateBody: stateFixture(t, &active), issues: string(issues)}
	code, stdout, stderr := runAudit(t, stub)

	if code != 0 {
		t.Fatalf("run() = %d, want 0 (stderr %q)", code, stderr)
	}
	if stub.created.Load() != 1 || stub.patched.Load() != 0 {
		t.Fatalf("expected one freshly published alert, got created %d patched %d", stub.created.Load(), stub.patched.Load())
	}
	if !strings.Contains(stdout, active.IncidentID) {
		t.Fatalf("run() must report the published incident, got %q", stdout)
	}
}

// The title is presentation, so an operator who renames the alert for context
// must not orphan it and cause a duplicate to be published.
func TestRenamedAlertIsStillTheSameAlert(t *testing.T) {
	t.Parallel()
	active := incidentFixture()
	renamed := existingAlert(t, "open", alertMarker+"\nsuperseded evidence")
	renamed = strings.Replace(renamed, alertTitle, "[P0] "+alertTitle, 1)

	stub := &stubGitHub{t: t, stateBody: stateFixture(t, &active), issues: renamed}
	if code, _, stderr := runAudit(t, stub); code != 0 {
		t.Fatalf("run() = %d, want 0 (stderr %q)", code, stderr)
	}
	if stub.created.Load() != 0 || stub.patched.Load() != 1 {
		t.Fatalf("renamed alert must be updated, not duplicated: created %d patched %d", stub.created.Load(), stub.patched.Load())
	}
}

// If discovery ever stops resolving what this automation created, an unverified
// create would republish the alert on every scheduled run while the audit stayed
// green. That is an unbounded write with no operator signal, so publication must
// prove itself and fail red instead.
func TestUndiscoverablePublicationFailsInsteadOfRepublishing(t *testing.T) {
	t.Parallel()
	active := incidentFixture()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case strings.HasPrefix(request.URL.Path, "/repos/owner/repo/contents/"):
			_, _ = writer.Write(stateFixture(t, &active))
		case request.Method == http.MethodGet:
			// A discovery filter that has silently stopped matching.
			_, _ = writer.Write([]byte(`[]`))
		default:
			writer.WriteHeader(http.StatusCreated)
			_, _ = writer.Write([]byte(`{"number":4242}`))
		}
	}))
	defer server.Close()

	var stdout, stderr strings.Builder
	code := run(
		context.Background(),
		config{
			Lock:       testLock,
			StateRef:   "lock-state",
			Repository: "owner/repo",
			APIURL:     server.URL,
			ServerURL:  testServerURL,
			Token:      "test-token",
		},
		server.Client(),
		&stdout,
		&stderr,
	)
	if code != 1 {
		t.Fatalf("run() = %d, want 1 when the published alert cannot be rediscovered", code)
	}
	if !strings.Contains(stderr.String(), "not discoverable") {
		t.Fatalf("failure must name the undiscoverable publication, got %q", stderr.String())
	}
}

func TestRunRejectsDuplicateAlertIssues(t *testing.T) {
	t.Parallel()
	active := incidentFixture()
	duplicates, err := json.Marshal([]map[string]any{
		{"number": 1, "state": "open", "title": alertTitle, "body": alertMarker, "user": map[string]any{"login": alertAuthor}},
		{"number": 2, "state": "open", "title": alertTitle, "body": alertMarker, "user": map[string]any{"login": alertAuthor}},
	})
	if err != nil {
		t.Fatal(err)
	}
	stub := &stubGitHub{t: t, stateBody: stateFixture(t, &active), issues: string(duplicates)}
	if code, _, _ := runAudit(t, stub); code != 1 {
		t.Fatalf("run() = %d, want 1", code)
	}
	if stub.created.Load() != 0 || stub.patched.Load() != 0 {
		t.Fatal("duplicate alert evidence must not be mutated")
	}
}

func TestRunIgnoresPullRequestsAndForeignMarkers(t *testing.T) {
	t.Parallel()
	active := incidentFixture()
	issues, err := json.Marshal([]map[string]any{
		{
			"number":       7,
			"state":        "open",
			"title":        alertTitle,
			"body":         alertMarker,
			"user":         map[string]any{"login": alertAuthor},
			"pull_request": map[string]any{"url": "https://example.test/pull/7"},
		},
		{"number": 8, "state": "open", "title": "unrelated", "body": "no marker", "user": map[string]any{"login": alertAuthor}},
	})
	if err != nil {
		t.Fatal(err)
	}
	stub := &stubGitHub{t: t, stateBody: stateFixture(t, &active), issues: string(issues)}
	code, _, stderr := runAudit(t, stub)
	if code != 0 {
		t.Fatalf("run() = %d, want 0 (stderr %q)", code, stderr)
	}
	if stub.created.Load() != 1 || stub.patched.Load() != 0 {
		t.Fatalf("expected one created alert, got created %d patched %d", stub.created.Load(), stub.patched.Load())
	}
}

func TestParseConfigAcceptsOnlyProvableTargets(t *testing.T) {
	t.Parallel()
	baseArguments := []string{"--lock=" + testLock, "--state-ref=lock-state"}
	cases := []struct {
		name        string
		arguments   []string
		environment map[string]string
	}{
		{name: "missing lock", arguments: []string{"--state-ref=lock-state"}},
		{name: "missing ref", arguments: []string{"--lock=" + testLock}},
		{name: "unexpected argument", arguments: append(append([]string{}, baseArguments...), "extra")},
		{name: "lock path traversal", arguments: []string{"--lock=../secrets", "--state-ref=lock-state"}},
		{name: "lock separator", arguments: []string{"--lock=locks/other", "--state-ref=lock-state"}},
		{name: "ref shape", arguments: []string{"--lock=" + testLock, "--state-ref=refs heads"}},
		{name: "insecure API URL", environment: map[string]string{"GITHUB_API_URL": "http://api.example.test"}},
		{name: "API URL with query", environment: map[string]string{"GITHUB_API_URL": "https://api.github.com?x=1"}},
		{name: "server URL with path", environment: map[string]string{"GITHUB_SERVER_URL": "https://github.com/enterprise"}},
		{name: "server URL with credentials", environment: map[string]string{"GITHUB_SERVER_URL": "https://user@github.com"}},
		{name: "repository shape", environment: map[string]string{"GITHUB_REPOSITORY": "owner"}},
		{name: "missing token", environment: map[string]string{"GITHUB_TOKEN": ""}},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			environment := map[string]string{
				"GITHUB_API_URL":    "https://api.github.com",
				"GITHUB_SERVER_URL": testServerURL,
				"GITHUB_REPOSITORY": "owner/repo",
				"GITHUB_TOKEN":      "test-token",
			}
			for key, value := range test.environment {
				environment[key] = value
			}
			arguments := test.arguments
			if arguments == nil {
				arguments = baseArguments
			}
			if _, err := parseConfig(arguments, func(key string) string { return environment[key] }); err == nil {
				t.Fatal("invalid configuration must fail closed")
			}
		})
	}

	environment := map[string]string{
		"GITHUB_API_URL":    "https://api.github.com/",
		"GITHUB_SERVER_URL": testServerURL,
		"GITHUB_REPOSITORY": "owner/repo",
		"GITHUB_TOKEN":      "test-token",
	}
	settings, err := parseConfig(baseArguments, func(key string) string { return environment[key] })
	if err != nil {
		t.Fatal(err)
	}
	if settings.Lock != testLock || settings.StateRef != "lock-state" || settings.ServerURL != testServerURL {
		t.Fatalf("unexpected configuration %#v", settings)
	}
}

func TestStateRequestIsBoundedRawAndSameOrigin(t *testing.T) {
	t.Parallel()
	var captured *http.Request
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		captured = request.Clone(request.Context())
		_, _ = writer.Write([]byte(`{"schemaVersion":5,"activeIncident":null}`))
	}))
	defer server.Close()

	client, err := newGitHubClient(server.URL, "owner/repo", "test-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.lockState(context.Background(), "wallstop-organization-builds", "lock-state"); err != nil {
		t.Fatal(err)
	}
	if captured.URL.Path != "/repos/owner/repo/contents/locks/wallstop-organization-builds.json" {
		t.Fatalf("unexpected state path %q", captured.URL.Path)
	}
	if captured.URL.Query().Get("ref") != "lock-state" {
		t.Fatalf("unexpected state query %q", captured.URL.RawQuery)
	}
	if captured.Header.Get("Accept") != "application/vnd.github.raw" {
		t.Fatalf("state read must request the raw contract, got %q", captured.Header.Get("Accept"))
	}
	if captured.Header.Get("Authorization") != "Bearer test-token" {
		t.Fatal("state read did not use bearer authentication")
	}
}

func TestClientRejectsCrossOriginRedirects(t *testing.T) {
	t.Parallel()
	elsewhere := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"schemaVersion":5,"activeIncident":null}`))
	}))
	defer elsewhere.Close()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, elsewhere.URL+"/leak", http.StatusFound)
	}))
	defer server.Close()

	client, err := newGitHubClient(server.URL, "owner/repo", "test-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.lockState(context.Background(), "wallstop-organization-builds", "lock-state"); err == nil {
		t.Fatal("cross-origin redirect must be rejected")
	}
}
