package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/enrollment"
	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/jsonstrict"
)

const testArtifactURL = "https://github.com/Ambiguous-Interactive/lock/actions/runs/123/artifacts/456"

func sampleAudit() enrollment.UnityOrganizationAudit {
	return enrollment.UnityOrganizationAudit{
		Complete: true,
		Repositories: []enrollment.UnityAuditedRepository{{
			Repository: "Ambiguous-Interactive/DoxReloaded",
			SHA:        strings.Repeat("a", 40),
		}},
		Inventory: []enrollment.UnityInventoryEntry{{
			Repository:     "Ambiguous-Interactive/DoxReloaded",
			SHA:            strings.Repeat("a", 40),
			Path:           ".github/workflows/unity.yml",
			Job:            "unity",
			Classification: "paid-serial",
		}},
	}
}

func TestRenderIssueBodyContainsOnlySanitizedFields(t *testing.T) {
	audit := sampleAudit()
	audit.Findings = []enrollment.UnityAuditFinding{{
		Repository: "Ambiguous-Interactive/DoxReloaded",
		SHA:        strings.Repeat("a", 40),
		Code:       "missing-lock-acquire",
		Path:       ".github/workflows/unity.yml",
		Job:        "unity",
	}}
	body := renderIssueBody(audit, testArtifactURL)
	for _, expected := range []string{
		alertMarker, "Ambiguous-Interactive/DoxReloaded", ".github/workflows/unity.yml",
		"missing-lock-acquire", "paid-serial",
		"finding-code contract",
		"(docs/consumer-enrollment.md)",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("body missing %q:\n%s", expected, body)
		}
	}
	if strings.Contains(body, "UNITY_SERIAL") {
		t.Fatal("body exposed matched source")
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
	drift.Findings = []enrollment.UnityAuditFinding{{
		Repository: "Ambiguous-Interactive/DoxReloaded",
		SHA:        strings.Repeat("a", 40),
		Code:       "missing-lock-acquire",
		Path:       ".github/workflows/unity.yml",
		Job:        "unity",
	}}
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
	// The second identical drift observation is read-only; only the final clean
	// observation needs to patch and close the alert.
	if len(requests) != 5 {
		t.Fatalf("unexpected request count %d: %#v", len(requests), requests)
	}
}

// A repository accumulates issues indefinitely, so alert discovery must stay
// inside its response bound as the history grows. Every page must be walked and
// every response must fit even when each issue carries a maximum-size body.
func TestAlertDiscoveryStaysBoundedAcrossPages(t *testing.T) {
	maximumBody := strings.Repeat("x", 64*1024)
	pages := make(map[string][]issue)
	for page := 1; page <= 3; page++ {
		bulk := make([]issue, issuePageSize)
		for index := range bulk {
			bulk[index] = issue{Number: page*1000 + index, State: "closed", Title: "unrelated", Body: maximumBody}
			bulk[index].User.Login = alertAuthor
		}
		pages[strconv.Itoa(page)] = bulk
	}
	pages["3"][0] = issue{Number: 7, State: "open", Title: alertTitle, Body: alertMarker + "\nprevious"}
	pages["3"][0].User.Login = alertAuthor
	pages["4"] = nil

	var largest int
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		query := request.URL.Query()
		if query.Get("per_page") != strconv.Itoa(issuePageSize) {
			t.Errorf("unexpected page size %q", query.Get("per_page"))
		}
		if query.Get("creator") != alertAuthor {
			t.Errorf("discovery must be restricted to this automation's own issues, got creator %q", query.Get("creator"))
		}
		var buffer bytes.Buffer
		_ = json.NewEncoder(&buffer).Encode(pages[request.URL.Query().Get("page")])
		if buffer.Len() > largest {
			largest = buffer.Len()
		}
		_, _ = writer.Write(buffer.Bytes())
	}))
	defer server.Close()

	client, err := newGitHubClient(server.URL, "Ambiguous-Interactive/lock", "test-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	found, err := client.issues.Find(t.Context(), alertIdentity())
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

func TestSyncRejectsDuplicateMarkerIssues(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		first := issue{Number: 1, Body: alertMarker}
		first.User.Login = alertAuthor
		second := issue{Number: 2, Body: alertMarker}
		second.User.Login = alertAuthor
		_ = json.NewEncoder(writer).Encode([]issue{first, second})
	}))
	defer server.Close()
	client, err := newGitHubClient(server.URL, "Ambiguous-Interactive/lock", "token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if err := client.sync(t.Context(), sampleAudit(), testArtifactURL); err == nil {
		t.Fatal("duplicate marker issues passed")
	}
}

// The marker is published in this public repository's own alert body, so an
// outsider can post a lookalike. It must be ignored rather than adopted and
// overwritten, and must not stall synchronization.
func TestForeignAuthoredMarkerIsIgnored(t *testing.T) {
	impostor := issue{Number: 5, State: "open", Title: alertTitle, Body: alertMarker + "\nnot ours"}
	impostor.User.Login = "impostor"
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(writer).Encode([]issue{impostor})
	}))
	defer server.Close()

	client, err := newGitHubClient(server.URL, "Ambiguous-Interactive/lock", "test-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	found, err := client.issues.Find(t.Context(), alertIdentity())
	if err != nil {
		t.Fatalf("a foreign lookalike must not stall discovery: %v", err)
	}
	if found != nil {
		t.Fatalf("a foreign lookalike must never be adopted: %#v", found)
	}
}

func TestReadAuditRejectsUnknownFieldsAndHostileValues(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "audit.json")
	audit := sampleAudit()
	content, _ := json.Marshal(audit)
	content = []byte(strings.Replace(string(content), `"complete":true`, `"complete":true,"unknown":true`, 1))
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readAudit(path); err == nil {
		t.Fatal("unknown audit field passed")
	}

	audit = sampleAudit()
	audit.Inventory[0].Job = "unity\ncredential=value"
	content, _ = json.Marshal(audit)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readAudit(path); err == nil {
		t.Fatal("hostile inventory value passed")
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
	damaged := bytes.Replace(clean, []byte(`"job":"unity"`), []byte(`"job":"\ud800"`), 1)
	if bytes.Equal(clean, damaged) {
		t.Fatal("the fixture does not hold the literal this test damages")
	}
	unreadable := bytes.Replace(clean, []byte(`"job":"unity"`), []byte("\"job\":\"\xff\""), 1)

	cases := []struct {
		name       string
		content    []byte
		want       string
		wantAbsent string
	}{
		{name: "clean artifact", content: clean},
		{name: "escaped lone surrogate", content: damaged, want: "audit artifact " + jsonstrict.ReasonLoneSurrogateEscape},
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

func TestValidateAuditAcceptsEveryInventoryClassification(t *testing.T) {
	for _, classification := range []string{
		enrollment.UnityInventoryPaidSerial,
		enrollment.UnityInventoryFallbackCleanup,
		enrollment.UnityInventoryControlledCanary,
		enrollment.UnityInventorySynthetic,
		enrollment.UnityInventoryDisabled,
		enrollment.UnityInventoryNonLicensingStatic,
	} {
		t.Run(classification, func(t *testing.T) {
			audit := sampleAudit()
			audit.Inventory[0].Classification = classification
			if err := validateAudit(audit); err != nil {
				t.Fatalf("valid inventory classification %q was rejected: %v", classification, err)
			}
		})
	}

	audit := sampleAudit()
	audit.Inventory[0].Classification = "unknown"
	if err := validateAudit(audit); err == nil {
		t.Fatal("unknown inventory classification passed")
	}
}

func TestAuditAndIssueBodyAreBounded(t *testing.T) {
	audit := sampleAudit()
	audit.Findings = make([]enrollment.UnityAuditFinding, maxAuditRows+1)
	if err := validateAudit(audit); err == nil {
		t.Fatal("oversized finding collection passed")
	}

	audit = sampleAudit()
	audit.Inventory = make([]enrollment.UnityInventoryEntry, 113)
	for index := range audit.Inventory {
		audit.Inventory[index] = sampleAudit().Inventory[0]
		audit.Inventory[index].Job = "unity"
	}
	audit.Findings = make([]enrollment.UnityAuditFinding, 286)
	for index := range audit.Findings {
		audit.Findings[index] = enrollment.UnityAuditFinding{
			Repository: "Ambiguous-Interactive/DoxReloaded",
			SHA:        strings.Repeat("a", 40),
			Code:       "missing-lock-acquire",
			Path:       ".github/workflows/unity.yml",
			Job:        "unity",
		}
	}
	if err := validateAudit(audit); err != nil {
		t.Fatalf("live-scale sanitized audit was rejected: %v", err)
	}
	body := renderIssueBody(audit, testArtifactURL)
	if len(body) > maxIssueBodyBytes {
		t.Fatalf("bounded issue body has %d bytes", len(body))
	}
	for _, expected := range []string{
		"286 findings", "113 active inventory rows", "246 additional findings omitted",
		"97 additional inventory rows omitted", testArtifactURL,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("bounded issue body missing %q", expected)
		}
	}
}

func TestMaximumValidatedPreviewFitsIssueBodyLimit(t *testing.T) {
	repository := "Ambiguous-Interactive/" + strings.Repeat("r", 100)
	workflowPath := ".github/workflows/" + strings.Repeat("p", 232) + ".yml"
	audit := enrollment.UnityOrganizationAudit{
		Complete: true,
	}
	for range maxRepositories {
		audit.Repositories = append(audit.Repositories, enrollment.UnityAuditedRepository{
			Repository: repository,
			SHA:        strings.Repeat("a", 40),
		})
	}
	for range maxAuditRows {
		audit.Findings = append(audit.Findings, enrollment.UnityAuditFinding{
			Repository: repository,
			SHA:        strings.Repeat("b", 40),
			Code:       "c" + strings.Repeat("d", 79),
			Path:       workflowPath,
			Job:        strings.Repeat("j", 128),
		})
		audit.Inventory = append(audit.Inventory, enrollment.UnityInventoryEntry{
			Repository:     repository,
			SHA:            strings.Repeat("c", 40),
			Path:           workflowPath,
			Job:            strings.Repeat("k", 128),
			Classification: "controlled-canary",
		})
	}
	if err := validateAudit(audit); err != nil {
		t.Fatalf("maximum validated audit was rejected: %v", err)
	}
	body := renderIssueBody(audit, testArtifactURL)
	if len(body) > maxIssueBodyBytes {
		t.Fatalf("maximum validated preview has %d bytes", len(body))
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

// The analyzer builds the cause from a consumer-controlled path, so the value
// reaches a retained artifact. readAudit is the only door, and it must refuse a
// cause outside the alphabet the analyzer sanitizes to, or a hostile file name
// becomes retained evidence. The empty cause is the control: it shares every
// other field with the hostile rows.
func TestReadAuditRefusesACauseOutsideTheSanitizedAlphabet(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.json")
	write := func(t *testing.T, cause string) {
		t.Helper()
		audit := sampleAudit()
		audit.Findings = []enrollment.UnityAuditFinding{{
			Repository: "Ambiguous-Interactive/DoxReloaded",
			SHA:        strings.Repeat("a", 40),
			Code:       "repository-retrieval-incomplete",
			Cause:      cause,
		}}
		content, err := json.Marshal(audit)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	accepted := map[string]string{
		"no cause":    "",
		"reason":      "load exact snapshot: policy file scripts/unity/editor-check.ps1 is not valid UTF-8",
		"with quotes": `policy file ".github/workflows/unity.yml" is not valid UTF-8`,
		"longest":     strings.Repeat("a", jsonstrict.MaxCauseBytes),
	}
	refused := map[string]string{
		"newline":     "load exact snapshot failed\ncredential=value",
		"backtick":    "load exact snapshot `failed`",
		"pipe":        "load exact snapshot | failed",
		"non ascii":   "load exact snapshot failed: naïve ✨",
		"oversized":   strings.Repeat("a", jsonstrict.MaxCauseBytes+1),
		"empty table": "load exact snapshot ()\tfailed",
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
				t.Fatalf("cause %q reached the retained artifact", cause)
			}
			if !strings.Contains(err.Error(), "invalid finding") {
				t.Fatalf("error = %v, want the finding validator to refuse it", err)
			}
		})
	}
}

// The enrollment cause is a clause from internal/jsonstrict, or a message the
// snapshot reader builds from a file name nobody wrote. A character the shipped
// validator rejects makes the issue sync refuse the whole artifact, so the drift
// alert never opens and the file name is lost with it. A comma in one reason
// caused exactly that on the merge-policy side.
//
// The strings are checked UNSANITIZED, against the shipped pattern. Sanitizing
// first or rebuilding the pattern here would hide the defect from the test that
// exists to catch it.
func TestEveryPublishedEnrollmentCauseIsPublishable(t *testing.T) {
	// Every message the enrollment audit can publish, before sanitizing.
	published := []string{
		"load exact snapshot: tree path \"scripts/unity/editor-check.ps1\" at 0123456789abcdef is not valid UTF-8",
		"load exact snapshot: resolve exact commit",
		"load exact snapshot: verify repository origin",
		".github/workflows/unity.yml:build cannot define both uses and steps",
	}
	for _, reason := range []string{jsonstrict.ReasonNotUTF8, jsonstrict.ReasonLoneSurrogateEscape} {
		for _, what := range []string{"lock state", "audit artifact", "requests"} {
			published = append(published, what+" "+reason)
		}
	}
	for _, cause := range published {
		if !causePattern.MatchString(cause) {
			t.Errorf("cause %q is outside the shipped issue alphabet", cause)
		}
		if got := jsonstrict.SanitizeCause(cause); got != cause {
			t.Errorf("SanitizeCause changed %q to %q, so the analyzer publishes it twice", cause, got)
		}
	}
	// A refused path is not valid UTF-8 and the snapshot reader reports it with
	// %s, so the raw byte reaches the cause. This row is why the analyzer
	// sanitizes: without it the validator refuses the whole artifact, and with
	// it the drift alert never opens. Without this row a sanitizer that did
	// nothing would pass every row above.
	hostile := "load exact snapshot: policy file scripts/unity/editor-\xff-check.ps1 at 0123456789abcdef is not valid UTF-8"
	if causePattern.MatchString(hostile) {
		t.Fatalf("the validator accepts a raw byte, so SanitizeCause is not load bearing")
	}
	if got := jsonstrict.SanitizeCause(hostile); !causePattern.MatchString(got) {
		t.Fatalf("sanitized cause %q is outside the shipped issue alphabet", got)
	}
}
