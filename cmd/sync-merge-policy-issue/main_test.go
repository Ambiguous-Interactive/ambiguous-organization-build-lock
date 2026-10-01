package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/jsonstrict"
	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/mergepolicy"
)

const testArtifactURL = "https://github.com/Ambiguous-Interactive/lock/actions/runs/123/artifacts/456"

func sampleAudit() mergepolicy.Audit {
	return mergepolicy.Audit{
		Complete: true,
		Repositories: []mergepolicy.AuditedRepository{{
			Repository:    "Ambiguous-Interactive/DoxReloaded",
			DefaultBranch: "main",
		}},
		Inventory: []mergepolicy.InventoryEntry{{
			Repository:  "Ambiguous-Interactive/DoxReloaded",
			Kind:        "ruleset",
			Carrier:     "ruleset Main Protection (id 1483933)",
			Context:     "CI Success",
			Enforcement: "active",
		}},
	}
}

func sampleFinding() mergepolicy.Finding {
	return mergepolicy.Finding{
		Repository: "Ambiguous-Interactive/DoxReloaded",
		Code:       "missing-required-context",
		Context:    "CI Success",
		Detail:     "",
	}
}

func TestRenderIssueBodyContainsOnlySanitizedFields(t *testing.T) {
	audit := sampleAudit()
	finding := sampleFinding()
	finding.Detail = `required context is spelled "ci success" in ruleset Main Protection (id 1483933)`
	audit.Findings = []mergepolicy.Finding{finding}
	body := renderIssueBody(audit, testArtifactURL)
	for _, expected := range []string{
		alertMarker,
		"Ambiguous-Interactive/DoxReloaded",
		"missing-required-context",
		"Source App ID",
		"any source",
		"ruleset Main Protection (id 1483933)",
		"finding-code contract",
		"(docs/consumer-enrollment.md)",
		testArtifactURL,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("body missing %q:\n%s", expected, body)
		}
	}
}

func TestSyncCreatesUpdatesAndClosesOneDeduplicatedIssue(t *testing.T) {
	current := []issue{}
	requests := make([]string, 0)
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("missing token")
		}
		requests = append(requests, request.Method+" "+request.URL.Path)
		switch request.Method {
		case http.MethodGet:
			_ = json.NewEncoder(writer).Encode(current)
		case http.MethodPost:
			var payload map[string]any
			_ = json.NewDecoder(request.Body).Decode(&payload)
			created := issue{Number: 42, State: "open", Title: alertTitle, Body: payload["body"].(string)}
			created.User.Login = alertAuthor
			current = []issue{created}
			writer.WriteHeader(http.StatusCreated)
			_, _ = writer.Write([]byte(`{}`))
		case http.MethodPatch:
			var payload map[string]any
			_ = json.NewDecoder(request.Body).Decode(&payload)
			current[0].State = payload["state"].(string)
			current[0].Body = payload["body"].(string)
			_, _ = writer.Write([]byte(`{}`))
		default:
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
	}))
	defer server.Close()
	client, err := newGitHubClient(server.URL, "Ambiguous-Interactive/lock", "test-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}

	drift := sampleAudit()
	drift.Findings = []mergepolicy.Finding{sampleFinding()}
	if err := client.sync(t.Context(), drift, testArtifactURL); err != nil {
		t.Fatal(err)
	}
	if len(current) != 1 || current[0].State != "open" {
		t.Fatalf("alert was not created: %#v", current)
	}
	if err := client.sync(t.Context(), drift, testArtifactURL); err != nil {
		t.Fatal(err)
	}
	if len(current) != 1 {
		t.Fatalf("alert was duplicated: %#v", current)
	}
	if err := client.sync(t.Context(), sampleAudit(), testArtifactURL); err != nil {
		t.Fatal(err)
	}
	if current[0].State != "closed" {
		t.Fatalf("clean audit did not close alert: %#v", current)
	}
	if len(requests) != 5 {
		t.Fatalf("unexpected request count %d: %#v", len(requests), requests)
	}
}

func TestReadAuditRejectsUnknownFieldsAndHostileValues(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "audit.json")
	write := func(audit mergepolicy.Audit, mutate func([]byte) []byte) {
		t.Helper()
		content, _ := json.Marshal(audit)
		if mutate != nil {
			content = mutate(content)
		}
		if err := os.WriteFile(path, content, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	write(sampleAudit(), func(content []byte) []byte {
		return []byte(strings.Replace(string(content), `"complete":true`, `"complete":true,"unknown":true`, 1))
	})
	if _, err := readAudit(path); err == nil {
		t.Fatal("unknown audit field passed")
	}

	audit := sampleAudit()
	audit.Inventory[0].Carrier = "ruleset evil (id 1)\ncredential=value"
	write(audit, nil)
	if _, err := readAudit(path); err == nil {
		t.Fatal("hostile inventory value passed")
	}

	audit = sampleAudit()
	audit.Findings = []mergepolicy.Finding{{
		Repository: "Ambiguous-Interactive/DoxReloaded",
		Code:       "missing-required-context",
		Context:    "CI\tSuccess",
	}}
	write(audit, nil)
	if _, err := readAudit(path); err == nil {
		t.Fatal("hostile finding context passed")
	}

	audit = sampleAudit()
	audit.Repositories[0].DefaultBranch = "bad branch"
	write(audit, nil)
	if _, err := readAudit(path); err == nil {
		t.Fatal("invalid branch passed")
	}

	audit = sampleAudit()
	audit.Inventory[0].IntegrationID = -1
	write(audit, nil)
	if _, err := readAudit(path); err == nil {
		t.Fatal("negative source App ID passed")
	}
}

// The audit is written by an artifact this repository does not review as text,
// so an escaped lone surrogate would reach validateAudit as U+FFFD, a spelling
// the analyzer never wrote. The clean row carries the weight: a guard that
// refused every non-ASCII artifact would pass a table with only refusal rows. The
// truncated row carries the ordering, because a guard above the decode would
// report a byte rule and hide the syntax error an operator has to fix.
func TestReadAuditRefusesWhatTheDecoderCannotRepresent(t *testing.T) {
	clean, err := json.Marshal(sampleAudit())
	if err != nil {
		t.Fatal(err)
	}
	damaged := bytes.Replace(clean, []byte(`"context":"CI Success"`), []byte(`"context":"\ud800"`), 1)
	if bytes.Equal(clean, damaged) {
		t.Fatal("the fixture does not hold the literal this test damages")
	}
	unreadable := bytes.Replace(clean, []byte(`"context":"CI Success"`), []byte("\"context\":\"\xff\""), 1)

	cases := []struct {
		name       string
		content    []byte
		want       string
		wantAbsent string
	}{
		{name: "clean artifact", content: clean},
		{
			name:    "escaped lone surrogate",
			content: damaged,
			want:    "audit artifact " + jsonstrict.ReasonLoneSurrogateEscape,
		},
		{name: "unreadable byte", content: unreadable, want: "audit artifact " + jsonstrict.ReasonNotUTF8},
		{
			name:       "truncated artifact keeps the decoder message",
			content:    damaged[:len(damaged)-1],
			want:       "unexpected EOF",
			wantAbsent: "lone surrogate",
		},
	}
	path := filepath.Join(t.TempDir(), "audit.json")
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if err := os.WriteFile(path, test.content, 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := readAudit(path)
			if test.want == "" {
				if err != nil {
					t.Fatalf("a clean audit was refused: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatal("an audit the decoder cannot represent was accepted")
			}
			if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want %q", err, test.want)
			}
			if test.wantAbsent != "" && strings.Contains(err.Error(), test.wantAbsent) {
				t.Fatalf("error = %v, must not claim %q", err, test.wantAbsent)
			}
		})
	}
}

// The audit sanitizes hostile consumer-controlled names before they reach
// the artifact. Every possible sanitizer output must still pass this
// command's validator, or a hostile name could silence the drift alert.
func TestSanitizedEvidenceAlwaysPassesValidation(t *testing.T) {
	hostileValues := []string{
		"Validate YAML & Workflows",
		"build (Linux, Release)",
		"naïve ✨ name",
		"pipe|injection",
		"backtick`injection",
		"colon: name",
		"quote\"name",
		"semi;colon",
		strings.Repeat("é", 300),
		strings.Repeat("x", 300) + "\nnewlines\tand tabs",
	}
	for index, hostile := range hostileValues {
		audit := sampleAudit()
		audit.Inventory = []mergepolicy.InventoryEntry{{
			Repository:  "Ambiguous-Interactive/DoxReloaded",
			Kind:        "ruleset",
			Carrier:     mergepolicy.SanitizeText(hostile, 128),
			Context:     mergepolicy.SanitizeText(hostile, mergepolicy.MaxContextBytes),
			Enforcement: "active",
		}}
		audit.Findings = []mergepolicy.Finding{{
			Repository: "Ambiguous-Interactive/DoxReloaded",
			Code:       "missing-required-context",
			Context:    mergepolicy.SanitizeText(hostile, mergepolicy.MaxContextBytes),
			Detail:     mergepolicy.BoundDetail("context " + mergepolicy.SanitizeText(hostile, 128) + ` in "ruleset name" (id 1)`),
		}}
		if err := validateAudit(audit); err != nil {
			t.Fatalf("sanitized evidence %d (%q) was rejected: %v", index, hostile, err)
		}
	}
}

func TestValidateAuditBoundsCollections(t *testing.T) {
	audit := sampleAudit()
	audit.Findings = make([]mergepolicy.Finding, maxAuditRows+1)
	if err := validateAudit(audit); err == nil {
		t.Fatal("oversized finding collection passed")
	}

	bulk := make([]mergepolicy.Finding, maxAuditRows)
	for index := range bulk {
		bulk[index] = sampleFinding()
	}
	audit.Findings = bulk
	if err := validateAudit(audit); err != nil {
		t.Fatalf("live-scale sanitized audit was rejected: %v", err)
	}
	body := renderIssueBody(audit, testArtifactURL)
	if len(body) > maxIssueBodyBytes {
		t.Fatalf("bounded issue body has %d bytes", len(body))
	}
	if !strings.Contains(body, "4096 findings") || !strings.Contains(body, "4056 additional findings omitted") {
		t.Fatalf("bounded issue body lacks omission evidence:\n%s", body[:600])
	}
}

func TestValidatedArtifactURLRejectsMaliciousRunIdentity(t *testing.T) {
	valid, err := validatedArtifactURL(
		"https://github.com",
		"Ambiguous-Interactive/lock",
		"123",
		testArtifactURL,
	)
	if err != nil || valid != testArtifactURL {
		t.Fatalf("valid artifact URL failed: %q %v", valid, err)
	}
	tests := []struct {
		name       string
		server     string
		repository string
		runID      string
		artifact   string
	}{
		{"run newline", "https://github.com", "Ambiguous-Interactive/lock", "123\n456", testArtifactURL},
		{"wrong run", "https://github.com", "Ambiguous-Interactive/lock", "124", testArtifactURL},
		{"wrong repository", "https://github.com", "Ambiguous-Interactive/other", "123", testArtifactURL},
		{"query", "https://github.com", "Ambiguous-Interactive/lock", "123", testArtifactURL + "?token=secret"},
		{"fragment", "https://github.com", "Ambiguous-Interactive/lock", "123", testArtifactURL + "#evil"},
		{"foreign host", "https://github.com", "Ambiguous-Interactive/lock", "123", "https://example.com/Ambiguous-Interactive/lock/actions/runs/123/artifacts/456"},
		{"encoded path", "https://github.com", "Ambiguous-Interactive/lock", "123", "https://github.com/Ambiguous-Interactive/lock/actions/runs/123/artifacts/456%2F789"},
		{"oversized URL", "https://github.com", "Ambiguous-Interactive/lock", "123", "https://github.com/" + strings.Repeat("a", maxEvidenceURLBytes)},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := validatedArtifactURL(
				testCase.server,
				testCase.repository,
				testCase.runID,
				testCase.artifact,
			); err == nil {
				t.Fatal("malicious artifact identity passed")
			}
		})
	}
}

// The cause column lands in a Markdown table, so a cause holding a byte the
// table cannot carry would either break the row or escape it into a new one.
// readAudit is the only door, so it has to refuse the whole artifact instead of
// posting a table an attacker shaped. The empty cause is the control: it shares
// every other field with the hostile rows.
func TestReadAuditRefusesACauseOutsideThePublishableAlphabet(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.json")
	accepted := map[string]string{
		"no cause":            "",
		"reviewed reason":     "active rules response is not valid UTF-8",
		"longest reason":      strings.Repeat("a", 256),
		"hyphenated id":       "ruleset 17663217 response is not valid UTF-8",
		"attestation reason":  "merge policy attestation is not valid UTF-8",
		"reason with numbers": "contents response is not valid UTF-8 (id 17663217)",
	}
	refused := map[string]string{
		"newline":   "active rules response is not valid UTF-8\ncredential=value",
		"backtick":  "active rules response `not valid UTF-8",
		"pipe":      "active rules response | not valid valid UTF-8",
		"quote":     `active rules response "is not valid UTF-8`,
		"oversized": strings.Repeat("a", 257),
	}
	write := func(t *testing.T, cause string) {
		t.Helper()
		audit := sampleAudit()
		finding := sampleFinding()
		finding.Cause = cause
		audit.Findings = []mergepolicy.Finding{finding}
		content, err := json.Marshal(audit)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for name, cause := range accepted {
		t.Run(name, func(t *testing.T) {
			write(t, cause)
			if _, err := readAudit(path); err != nil {
				t.Fatalf("cause %q was refused: %v", cause, err)
			}
		})
	}
	for name, cause := range refused {
		t.Run(name, func(t *testing.T) {
			write(t, cause)
			_, err := readAudit(path)
			if err == nil {
				t.Fatalf("cause %q reached the issue table", cause)
			}
			if !strings.Contains(err.Error(), "invalid finding") {
				t.Fatalf("error = %v, want the finding validator to refuse it", err)
			}
		})
	}
}

// A cause the audit publishes is a clause from internal/jsonstrict behind a
// reader's own name. One character outside this validator's alphabet makes the
// issue sync refuse the whole artifact, so the drift alert never opens and the
// cause is lost with it. A comma in the lone-surrogate reason did exactly that,
// so every reason a reader can publish is checked here, not just one of them.
func TestEveryPublishedCauseIsPublishable(t *testing.T) {
	publishable := regexp.MustCompile("^[" + mergepolicy.Alphabet + "-]{0," +
		strconv.Itoa(mergepolicy.MaxDetailBytes) + "}$")
	for _, reason := range []string{
		jsonstrict.ReasonNotUTF8,
		jsonstrict.ReasonLoneSurrogateEscape,
	} {
		for _, what := range []string{
			"active rules response",
			"branch protection response",
			"ruleset list response",
			"contents response",
			"ruleset 17663217 response",
			"merge policy attestation",
		} {
			cause := what + " " + reason
			if !publishable.MatchString(cause) {
				t.Errorf("cause %q is outside the issue alphabet", cause)
			}
		}
	}
}

// An operator reads the cause in the table, so a finding with one must show it
// and a finding without one must show a dash. A missing column and a literal
// empty cell both render as blank, so this test pins the row text.
func TestRenderIssueBodyShowsTheCauseColumn(t *testing.T) {
	audit := sampleAudit()
	withCause := sampleFinding()
	withCause.Cause = "active rules response is not valid UTF-8"
	withoutCause := sampleFinding()
	withoutCause.Context = "Unity CI"
	audit.Findings = []mergepolicy.Finding{withCause, withoutCause}
	body := renderIssueBody(audit, testArtifactURL)
	for _, expected := range []string{
		"| Repository | Context | Detail | Cause | Reason |",
		"| --- | --- | --- | --- | --- |",
		"| `Ambiguous-Interactive/DoxReloaded` | `CI Success` | - | `active rules response is not valid UTF-8` | `missing-required-context` |",
		"| `Ambiguous-Interactive/DoxReloaded` | `Unity CI` | - | - | `missing-required-context` |",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("body missing %q:\n%s", expected, body)
		}
	}
}

// Two findings that differ only in their cause are two different rows for an
// operator. Without the cause in the key they share one, and the order the rows
// appear in is whatever the sort happened to produce.
func TestFindingKeySeparatesFindingsByCause(t *testing.T) {
	first := sampleFinding()
	first.Cause = "active rules response is not valid UTF-8"
	second := first
	second.Cause = "ruleset list response is not valid UTF-8"
	if findingKey(first) == findingKey(second) {
		t.Fatalf("two causes share one key: %q", findingKey(first))
	}
	if findingKey(sampleFinding()) == findingKey(first) {
		t.Fatal("a finding without a cause shares the key of one with a cause")
	}
}
