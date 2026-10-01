package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/jsonstrict"
	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/mergepolicy"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
)

const managedRulesetID = 17663217

// defaultExpectationBodies mirrors the reviewed production expectations: one
// Unity aggregate per paid-serial consumer, an exempt fork, and reviewed
// branches from the enrollment registry.
func defaultExpectationBodies() []string {
	return []string{
		expectationBody("DoxReloaded", "main", "CI Success"),
		expectationBody("DxMessaging", "master", "Unity CI Success"),
		expectationBody("IshoBoy", "main", "Unity CI Success"),
		expectationBody("qora-redux", "main", "Unity CI"),
		expectationBody("unity-builder", "main", ""),
		expectationBody("unity-helpers", "main", "Unity CI Success"),
	}
}

func expectationBody(repository, branch, context string) string {
	contexts := ""
	appID := ""
	if context != "" {
		contexts = `"` + context + `"`
		appID = `"requiredContextAppId": 15368,`
	}
	return fmt.Sprintf(`{
    "repository": "Ambiguous-Interactive/%s",
    "defaultBranch": "%s",
    "requiredContexts": [%s],
	    %s
    "requireAdminEnforcement": %t,
    "allowedBypassActors": []
	}`, repository, branch, contexts, appID, context != "")
}

func writeRepositoryPolicy(t *testing.T, directory string) string {
	t.Helper()
	content := `{
  "schemaVersion": 1,
  "organization": "Ambiguous-Interactive",
  "approvedLockShas": ["` + strings.Repeat("a", 40) + `"],
  "approvedReturnShas": [],
  "approvedDarwinReturnShas": [],
  "repositories": [
    {"repository": "Ambiguous-Interactive/DoxReloaded", "defaultBranch": "main", "fork": false, "allowWorkflowDispatch": false},
    {"repository": "Ambiguous-Interactive/DxMessaging", "defaultBranch": "master", "fork": false, "allowWorkflowDispatch": false},
    {"repository": "Ambiguous-Interactive/IshoBoy", "defaultBranch": "main", "fork": false, "allowWorkflowDispatch": false},
    {"repository": "Ambiguous-Interactive/qora-redux", "defaultBranch": "main", "fork": false, "allowWorkflowDispatch": false},
    {"repository": "Ambiguous-Interactive/unity-builder", "defaultBranch": "main", "fork": true, "allowWorkflowDispatch": false},
    {"repository": "Ambiguous-Interactive/unity-helpers", "defaultBranch": "main", "fork": false, "allowWorkflowDispatch": false}
  ],
  "exceptions": [],
  "repinExceptions": []
}`
	path := filepath.Join(directory, "unity-enrollment-policy.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write policy: %v", err)
	}
	return path
}

func writeExpectations(t *testing.T, directory string, bodies ...string) string {
	t.Helper()
	if len(bodies) == 0 {
		bodies = defaultExpectationBodies()
	}
	path := filepath.Join(directory, "merge-policy-expectations.json")
	content := `{
  "schemaVersion": 2,
  "organization": "Ambiguous-Interactive",
  "repositories": [` + strings.Join(bodies, ",\n") + `]
}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write expectations: %v", err)
	}
	return path
}

// rulesetServer serves the ruleset, per-branch rules, branch protection,
// and contents endpoints the audit reads. A repository without a configured
// ruleset list serves an empty list; a branch without configured active
// rules serves an empty list; a branch without a configured protection
// payload answers "not protected"; a repository without a configured
// attestation file answers 404, which the audit reads as "not published".
type rulesetServer struct {
	*httptest.Server
	activeRulesPayloads   map[string]string
	rulesetListPayloads   map[string]string
	rulesetDetailPayloads map[int64]string
	protectionPayloads    map[string]string
	contentsPayloads      map[string]string
	listStatus            int
	detailStatus          int
	protectionStatus      int
	contentsStatus        int
	protection404Body     string
	withNextLink          bool
	withActiveNextLink    bool
}

func newRulesetServer(t *testing.T) (*rulesetServer, *http.Client) {
	t.Helper()
	server := &rulesetServer{
		activeRulesPayloads:   map[string]string{},
		rulesetListPayloads:   map[string]string{},
		rulesetDetailPayloads: map[int64]string{},
		protectionPayloads:    map[string]string{},
		contentsPayloads:      map[string]string{},
		listStatus:            http.StatusOK,
		detailStatus:          http.StatusOK,
		protectionStatus:      http.StatusOK,
		contentsStatus:        http.StatusOK,
		protection404Body:     `{"message": "Branch not protected"}`,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(writer http.ResponseWriter, request *http.Request) {
		path := request.URL.Path
		if request.Method != http.MethodGet {
			writer.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		switch {
		case strings.Contains(path, "/contents/"):
			// The audit must read exactly the reviewed attestation path on
			// the default branch ref; any other read serves 404.
			rest := strings.TrimPrefix(path, "/repos/")
			separator := strings.Index(rest, "/contents/")
			if separator < 0 ||
				rest[separator:] != "/contents/.github/merge-policy-attestation.json" ||
				request.URL.Query().Get("ref") == "" {
				writer.WriteHeader(http.StatusNotFound)
				return
			}
			repository := rest[:separator]
			if server.contentsStatus != http.StatusOK {
				writer.WriteHeader(server.contentsStatus)
				return
			}
			payload, ok := server.contentsPayloads[repository]
			if !ok {
				writer.WriteHeader(http.StatusNotFound)
				_, _ = writer.Write([]byte(`{"message": "Not Found", "status": "404"}`))
				return
			}
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(payload))
		case strings.Contains(path, "/rules/branches/"):
			rest := strings.TrimPrefix(path, "/repos/")
			separator := strings.Index(rest, "/rules/branches/")
			key := rest[:separator] + "@" + rest[separator+len("/rules/branches/"):]
			if server.withActiveNextLink {
				writer.Header().Set("Link", `<`+request.URL.String()+`&page=2>; rel="next"`)
			}
			writer.Header().Set("Content-Type", "application/json")
			payload, ok := server.activeRulesPayloads[key]
			if !ok {
				payload = "[]"
			}
			_, _ = writer.Write([]byte(payload))
		case strings.HasSuffix(path, "/rulesets"):
			repository := strings.TrimSuffix(strings.TrimPrefix(path, "/repos/"), "/rulesets")
			if server.listStatus != http.StatusOK {
				writer.WriteHeader(server.listStatus)
				return
			}
			if server.withNextLink {
				writer.Header().Set("Link", `<`+request.URL.String()+`?page=2>; rel="next"`)
			}
			writer.Header().Set("Content-Type", "application/json")
			payload, ok := server.rulesetListPayloads[repository]
			if !ok {
				payload = "[]"
			}
			_, _ = writer.Write([]byte(payload))
		case strings.Contains(path, "/rulesets/"):
			segments := strings.Split(strings.Trim(path, "/"), "/")
			id, parseErr := strconv.ParseInt(segments[len(segments)-1], 10, 64)
			if parseErr != nil {
				writer.WriteHeader(http.StatusNotFound)
				return
			}
			payload, ok := server.rulesetDetailPayloads[id]
			if !ok || server.detailStatus != http.StatusOK {
				writer.WriteHeader(server.detailStatus)
				return
			}
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(payload))
		case strings.HasSuffix(path, "/protection"):
			if server.protectionStatus != http.StatusOK {
				if server.protectionStatus == http.StatusNotFound && server.protection404Body != "" {
					writer.WriteHeader(http.StatusNotFound)
					_, _ = writer.Write([]byte(server.protection404Body))
					return
				}
				writer.WriteHeader(server.protectionStatus)
				return
			}
			key := strings.TrimSuffix(strings.TrimPrefix(path, "/repos/"), "/protection")
			payload, ok := server.protectionPayloads[key]
			if !ok {
				writer.WriteHeader(http.StatusNotFound)
				_, _ = writer.Write([]byte(`{"message": "Branch not protected"}`))
				return
			}
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(payload))
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	})
	server.Server = httptest.NewTLSServer(mux)
	t.Cleanup(server.Close)
	return server, server.Client()
}

func detailPayload(name, context, bypassActors string) string {
	// An empty string means the field is present and empty (evidence read,
	// no actors); "OMIT" omits the key entirely, which is how GitHub answers
	// a caller that cannot see bypass evidence.
	bypassSection := `"bypass_actors": [],`
	if bypassActors == "OMIT" {
		bypassSection = ""
	}
	return fmt.Sprintf(`{
    "id": %d,
    "name": "%s",
    "enforcement": "active",
    "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
    %s
    "rules": [
      {
        "type": "required_status_checks",
        "parameters": {"required_status_checks": [{"context": "%s", "integration_id": 15368}]}
      }
    ],
    "source": {"type": "organization"}
  }`, managedRulesetID, name, bypassSection, context)
}

func activeRulesJSON(contexts ...string) string {
	checks := make([]string, 0, len(contexts))
	for _, context := range contexts {
		checks = append(checks, fmt.Sprintf(`{"context": "%s"}`, context))
	}
	return fmt.Sprintf(`[{"ruleset_id": %d, "type": "required_status_checks", "parameters": {"required_status_checks": [%s], "strict_required_status_checks_policy": false}}]`,
		managedRulesetID, strings.Join(checks, ", "))
}

// contentsEnvelope wraps one raw file body in the base64 contents API
// envelope, wrapped at 60 characters like GitHub serves it.
func contentsEnvelope(raw string) string {
	encoded := base64.StdEncoding.EncodeToString([]byte(raw))
	var wrapped strings.Builder
	for len(encoded) > 0 {
		cut := len(encoded)
		if cut > 60 {
			cut = 60
		}
		wrapped.WriteString(encoded[:cut])
		wrapped.WriteString("\n")
		encoded = encoded[cut:]
	}
	return fmt.Sprintf(`{"content": %q, "encoding": "base64", "size": %d}`, wrapped.String(), len(raw))
}

func attestationBody(rulesets ...string) string {
	return fmt.Sprintf(`{
  "schemaVersion": 1,
  "repository": "Ambiguous-Interactive/DoxReloaded",
  "rulesets": [%s]
}`, strings.Join(rulesets, ",\n"))
}

func attestedRuleset(name, contexts, actors string) string {
	if actors == "" {
		actors = "[]"
	}
	return fmt.Sprintf(`{
    "rulesetId": %d,
    "rulesetName": "%s",
    "enforcement": "active",
    "requiredContexts": %s,
    "bypassActors": %s
  }`, managedRulesetID, name, contexts, actors)
}

func protectionJSON(context string, adminEnforced bool) string {
	return fmt.Sprintf(`{
    "required_status_checks": {"checks": [{"context": "%s", "app_id": 15368}], "strict": false},
    "enforce_admins": {"enabled": %t},
    "required_pull_request_reviews": null,
    "restrictions": null,
    "allow_force_pushes": {"enabled": false}
  }`, context, adminEnforced)
}

func runAudit(
	t *testing.T,
	directory string,
	serverURL string,
	httpClient *http.Client,
	policyPath, expectationsPath string,
	token string,
) (int, string) {
	t.Helper()
	outputPath := filepath.Join(directory, "audit.json")
	environment := map[string]string{
		"GITHUB_API_URL":       serverURL,
		"READER_AUTHORIZATION": token,
	}
	exit := run(
		[]string{
			"--policy", policyPath,
			"--expectations", expectationsPath,
			"--output", outputPath,
		},
		io.Discard,
		io.Discard,
		func(name string) string { return environment[name] },
		httpClient,
	)
	content, err := os.ReadFile(outputPath)
	if err != nil {
		return exit, ""
	}
	return exit, string(content)
}

// artifactFinding is one finding as the artifact carries it. The cause is read
// here because a refusal cause reaches the artifact next to the detail, and a
// decoder that cannot see it would let a missing cause pass unnoticed.
type artifactFinding struct {
	Repository string `json:"repository"`
	Code       string `json:"code"`
	Context    string `json:"context"`
	Detail     string `json:"detail"`
	Cause      string `json:"cause"`
}

func decodeArtifact(t *testing.T, content string) struct {
	Complete     bool `json:"complete"`
	Repositories []struct {
		Repository string `json:"repository"`
	} `json:"repositories"`
	Inventory []struct {
		Repository    string `json:"repository"`
		Kind          string `json:"kind"`
		Carrier       string `json:"carrier"`
		Context       string `json:"context"`
		Enforcement   string `json:"enforcement"`
		IntegrationID int64  `json:"integrationId"`
	} `json:"inventory"`
	Findings []artifactFinding `json:"findings"`
} {
	t.Helper()
	var audit struct {
		Complete     bool `json:"complete"`
		Repositories []struct {
			Repository string `json:"repository"`
		} `json:"repositories"`
		Inventory []struct {
			Repository    string `json:"repository"`
			Kind          string `json:"kind"`
			Carrier       string `json:"carrier"`
			Context       string `json:"context"`
			Enforcement   string `json:"enforcement"`
			IntegrationID int64  `json:"integrationId"`
		} `json:"inventory"`
		Findings []artifactFinding `json:"findings"`
	}
	if err := json.Unmarshal([]byte(content), &audit); err != nil {
		t.Fatalf("decode artifact: %v", err)
	}
	return audit
}

// repositoryFindings returns every finding one repository carries, so a test
// can pin the count instead of only the presence of a code.
func repositoryFindings(findings []artifactFinding, repository string) []artifactFinding {
	matching := make([]artifactFinding, 0, len(findings))
	for _, finding := range findings {
		if finding.Repository == repository {
			matching = append(matching, finding)
		}
	}
	return matching
}

func findingCodes(t *testing.T, content string) []string {
	t.Helper()
	audit := decodeArtifact(t, content)
	codes := make([]string, 0, len(audit.Findings))
	for _, finding := range audit.Findings {
		codes = append(codes, finding.Code)
	}
	return codes
}

func TestRunValidatesExpectationsWithoutLiveReads(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory)
	exit := run(
		[]string{"--policy", policyPath, "--expectations", expectationsPath, "--validate-only"},
		io.Discard,
		io.Discard,
		func(string) string { return "" },
		nil,
	)
	if exit != 0 {
		t.Fatalf("validate-only exit = %d, want 0", exit)
	}
}

func TestRunRejectsExpectationsDriftingFromRegistry(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	// The registry audits DxMessaging on master; the expectation names main.
	expectationsPath := writeExpectations(t, directory, expectationBody("DxMessaging", "main", ""))
	exit := run(
		[]string{"--policy", policyPath, "--expectations", expectationsPath, "--validate-only"},
		io.Discard,
		io.Discard,
		func(string) string { return "" },
		nil,
	)
	if exit != 2 {
		t.Fatalf("drifted expectations exit = %d, want 2", exit)
	}
}

// encoding/json replaces a byte it cannot decode with U+FFFD rather than
// failing, so a reviewed file that is not valid UTF-8 would be evaluated as a
// value the organization never wrote. Both reviewed files are refused by name,
// so an operator is not sent to fix a spelling the file does not contain.
func TestRunRefusesEvidenceThatIsNotValidUTF8(t *testing.T) {
	reviewed := map[string]func(*testing.T, string) string{
		"policy":       writeRepositoryPolicy,
		"expectations": func(t *testing.T, directory string) string { return writeExpectations(t, directory) },
	}
	for name, write := range reviewed {
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			policyPath := writeRepositoryPolicy(t, directory)
			expectationsPath := writeExpectations(t, directory)
			corruptOneByte(t, write(t, directory), `"organization": "Ambiguous-Interactive"`)
			var stderr bytes.Buffer
			exit := run(
				[]string{"--policy", policyPath, "--expectations", expectationsPath, "--validate-only"},
				io.Discard,
				&stderr,
				func(string) string { return "" },
				nil,
			)
			if exit != 2 || !strings.Contains(stderr.String(), "not valid UTF-8") {
				t.Fatalf("exit = %d, want 2\nstderr=%s", exit, stderr.String())
			}
		})
	}
}

// corruptOneByte splices one 0xFF byte into the last string of a JSON fragment,
// so the file stays valid JSON and only a strict decode can refuse it.
func corruptOneByte(t *testing.T, path string, fragment string) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(content, []byte(fragment)) {
		t.Fatalf("fixture %q is missing from %s", fragment, path)
	}
	corrupted := bytes.Replace(
		content,
		[]byte(fragment),
		[]byte(fragment[:len(fragment)-1]+"\xff"+`"`),
		1,
	)
	if utf8.Valid(corrupted) {
		t.Fatal("the corrupted fixture is still valid UTF-8, so the test proves nothing")
	}
	if !json.Valid(corrupted) {
		t.Fatal("the corrupted fixture is not valid JSON, so it proves nothing about the encoding")
	}
	if err := os.WriteFile(path, corrupted, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRunRequiresReaderCredentials(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory)
	server, client := newRulesetServer(t)
	exit, _ := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "")
	if exit != 2 {
		t.Fatalf("missing credentials exit = %d, want 2", exit)
	}
}

func TestRunReportsCleanMergePolicy(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	// Only DoxReloaded (ruleset) and qora-redux (classic protection) declare
	// required contexts in this fixture; the other repositories are exempt.
	expectationsPath := writeExpectations(t, directory,
		expectationBody("DoxReloaded", "main", "CI Success"),
		expectationBody("DxMessaging", "master", ""),
		expectationBody("IshoBoy", "main", ""),
		expectationBody("qora-redux", "main", "Unity CI"),
		expectationBody("unity-builder", "main", ""),
		expectationBody("unity-helpers", "main", ""),
	)
	server, client := newRulesetServer(t)
	server.rulesetListPayloads["Ambiguous-Interactive/DoxReloaded"] =
		fmt.Sprintf(`[{"id": %d, "name": "Main Protection", "enforcement": "active"}]`, managedRulesetID)
	server.rulesetDetailPayloads[managedRulesetID] =
		detailPayload("Main Protection", "CI Success", "")
	server.activeRulesPayloads["Ambiguous-Interactive/DoxReloaded@main"] =
		activeRulesJSON("CI Success")
	server.protectionPayloads["Ambiguous-Interactive/qora-redux/branches/main"] = protectionJSON("Unity CI", true)
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 0 {
		t.Fatalf("clean audit exit = %d, artifact: %s", exit, content)
	}
	audit := decodeArtifact(t, content)
	if !audit.Complete || len(audit.Findings) != 0 || len(audit.Repositories) != 6 {
		t.Fatalf("unexpected artifact: %s", content)
	}
	if len(audit.Inventory) != 2 {
		t.Fatalf("inventory must record both observed carriers: %s", content)
	}
	for _, entry := range audit.Inventory {
		if entry.Context == "CI Success" && entry.IntegrationID != 15368 {
			t.Fatalf("ruleset source ID = %d, want 15368", entry.IntegrationID)
		}
		if entry.Context == "Unity CI" && entry.IntegrationID != 15368 {
			t.Fatalf("branch protection source ID = %d, want 15368", entry.IntegrationID)
		}
	}
}

func TestRunReportsUnboundRulesetCheckSource(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory,
		expectationBody("DoxReloaded", "main", "CI Success"),
		expectationBody("DxMessaging", "master", ""),
		expectationBody("IshoBoy", "main", ""),
		expectationBody("qora-redux", "main", ""),
		expectationBody("unity-builder", "main", ""),
		expectationBody("unity-helpers", "main", ""),
	)
	server, client := newRulesetServer(t)
	server.rulesetListPayloads["Ambiguous-Interactive/DoxReloaded"] =
		fmt.Sprintf(`[{"id": %d, "name": "Main Protection", "enforcement": "active"}]`, managedRulesetID)
	server.rulesetDetailPayloads[managedRulesetID] = strings.Replace(
		detailPayload("Main Protection", "CI Success", ""),
		`"integration_id": 15368`, `"integration_id": null`, 1,
	)
	server.activeRulesPayloads["Ambiguous-Interactive/DoxReloaded@main"] = activeRulesJSON("CI Success")
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 1 {
		t.Fatalf("unbound source exit = %d, want 1; artifact: %s", exit, content)
	}
	audit := decodeArtifact(t, content)
	if !audit.Complete || len(audit.Findings) != 1 || audit.Findings[0].Code != mergepolicy.CodeUnexpectedCheckSource {
		t.Fatalf("unexpected unbound-source evidence: %s", content)
	}
	if audit.Inventory[0].IntegrationID != 0 || !strings.Contains(audit.Findings[0].Detail, "App ID 0") {
		t.Fatalf("artifact must preserve the unbound source: %s", content)
	}
}

func TestRunReportsUnboundClassicProtectionSource(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory,
		expectationBody("DoxReloaded", "main", ""),
		expectationBody("DxMessaging", "master", ""),
		expectationBody("IshoBoy", "main", ""),
		expectationBody("qora-redux", "main", "Unity CI"),
		expectationBody("unity-builder", "main", ""),
		expectationBody("unity-helpers", "main", ""),
	)
	server, client := newRulesetServer(t)
	server.protectionPayloads["Ambiguous-Interactive/qora-redux/branches/main"] = strings.Replace(
		protectionJSON("Unity CI", true), `"app_id": 15368`, `"app_id": null`, 1,
	)
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 1 {
		t.Fatalf("unbound classic source exit = %d, want 1; artifact: %s", exit, content)
	}
	audit := decodeArtifact(t, content)
	if !audit.Complete || len(audit.Findings) != 1 || audit.Findings[0].Code != mergepolicy.CodeUnexpectedCheckSource {
		t.Fatalf("unexpected unbound-source evidence: %s", content)
	}
	if audit.Inventory[0].IntegrationID != 0 || !strings.Contains(audit.Findings[0].Detail, "App ID 0") {
		t.Fatalf("artifact must preserve the unbound source: %s", content)
	}
}

func TestIntegrationIDTreatsNonpositiveSourceAsUnbound(t *testing.T) {
	for _, value := range []*int64{nil, int64Pointer(0), int64Pointer(-1)} {
		if got := integrationID(value); got != 0 {
			t.Fatalf("integrationID(%v) = %d, want unbound 0", value, got)
		}
	}
	if got := integrationID(int64Pointer(15368)); got != 15368 {
		t.Fatalf("integrationID(15368) = %d", got)
	}
}

func int64Pointer(value int64) *int64 {
	return &value
}

func TestRunReportsMissingContextAndAbsentProtection(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory)
	server, client := newRulesetServer(t)
	// An active ruleset that requires only an unrelated context, and no
	// classic protection, leaves the reviewed aggregate unrequired.
	server.rulesetListPayloads["Ambiguous-Interactive/unity-helpers"] =
		fmt.Sprintf(`[{"id": %d, "name": "Copilot review", "enforcement": "active"}]`, managedRulesetID)
	server.rulesetDetailPayloads[managedRulesetID] =
		detailPayload("Copilot review", "Do The Code Review", "")
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 1 {
		t.Fatalf("drifted audit exit = %d, want 1", exit)
	}
	audit := decodeArtifact(t, content)
	if !audit.Complete {
		t.Fatalf("consumer drift must not mark retrieval incomplete: %s", content)
	}
	var helpers []string
	for _, finding := range audit.Findings {
		if finding.Repository == "Ambiguous-Interactive/unity-helpers" {
			helpers = append(helpers, finding.Code+" "+finding.Context)
		}
	}
	if len(helpers) != 1 || helpers[0] != "missing-required-context Unity CI Success" {
		t.Fatalf("unexpected unity-helpers findings: %v in %s", helpers, content)
	}
}

func TestRunFailsClosedWhenAttestationIsMissing(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory,
		expectationBody("DoxReloaded", "main", "CI Success"),
		expectationBody("DxMessaging", "master", ""),
		expectationBody("IshoBoy", "main", ""),
		expectationBody("qora-redux", "main", ""),
		expectationBody("unity-builder", "main", ""),
		expectationBody("unity-helpers", "main", ""),
	)
	server, client := newRulesetServer(t)
	server.rulesetListPayloads["Ambiguous-Interactive/DoxReloaded"] =
		fmt.Sprintf(`[{"id": %d, "name": "Main Protection", "enforcement": "active"}]`, managedRulesetID)
	// A caller without ruleset write access cannot see bypass actors; GitHub
	// answers with the key absent. Without a consumer attestation the audit
	// must fail closed, not pass.
	server.rulesetDetailPayloads[managedRulesetID] =
		detailPayload("Main Protection", "CI Success", "OMIT")
	server.activeRulesPayloads["Ambiguous-Interactive/DoxReloaded@main"] =
		activeRulesJSON("CI Success")
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 1 {
		t.Fatalf("unavailable bypass evidence exit = %d, want 1", exit)
	}
	audit := decodeArtifact(t, content)
	if audit.Complete {
		t.Fatalf("missing bypass evidence must fail the audit closed: %s", content)
	}
	if len(audit.Findings) != 1 ||
		audit.Findings[0].Code != "merge-policy-attestation-missing" ||
		!strings.Contains(audit.Findings[0].Detail, "Main Protection") {
		t.Fatalf("unexpected artifact: %s", content)
	}
}

func TestRunFillsBypassBlindSpotFromAttestation(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory,
		expectationBody("DoxReloaded", "main", "CI Success"),
		expectationBody("DxMessaging", "master", ""),
		expectationBody("IshoBoy", "main", ""),
		expectationBody("qora-redux", "main", ""),
		expectationBody("unity-builder", "main", ""),
		expectationBody("unity-helpers", "main", ""),
	)
	server, client := newRulesetServer(t)
	server.rulesetListPayloads["Ambiguous-Interactive/DoxReloaded"] =
		fmt.Sprintf(`[{"id": %d, "name": "Main Protection", "enforcement": "active"}]`, managedRulesetID)
	server.rulesetDetailPayloads[managedRulesetID] =
		detailPayload("Main Protection", "CI Success", "OMIT")
	server.activeRulesPayloads["Ambiguous-Interactive/DoxReloaded@main"] =
		activeRulesJSON("CI Success")
	server.contentsPayloads["Ambiguous-Interactive/DoxReloaded"] = contentsEnvelope(attestationBody(
		attestedRuleset("Main Protection", `["CI Success"]`, ""),
	))
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 0 {
		t.Fatalf("attested clean audit exit = %d, artifact: %s", exit, content)
	}
	var artifact struct {
		Complete     bool `json:"complete"`
		Repositories []struct {
			Repository         string  `json:"repository"`
			AttestedRulesetIDs []int64 `json:"attestedRulesetIds"`
		} `json:"repositories"`
	}
	if err := json.Unmarshal([]byte(content), &artifact); err != nil {
		t.Fatalf("decode artifact: %v", err)
	}
	if !artifact.Complete {
		t.Fatalf("a fresh attestation must complete the audit: %s", content)
	}
	attested := 0
	for _, repository := range artifact.Repositories {
		if repository.Repository == "Ambiguous-Interactive/DoxReloaded" {
			attested = len(repository.AttestedRulesetIDs)
			if attested != 1 || repository.AttestedRulesetIDs[0] != managedRulesetID {
				t.Fatalf("attested ruleset evidence missing: %s", content)
			}
		}
	}
	if attested == 0 {
		t.Fatalf("DoxReloaded is absent from the artifact: %s", content)
	}
}

func TestRunFailsClosedWhenAttestationIsStale(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory,
		expectationBody("DoxReloaded", "main", "CI Success"),
		expectationBody("DxMessaging", "master", ""),
		expectationBody("IshoBoy", "main", ""),
		expectationBody("qora-redux", "main", ""),
		expectationBody("unity-builder", "main", ""),
		expectationBody("unity-helpers", "main", ""),
	)
	server, client := newRulesetServer(t)
	server.rulesetListPayloads["Ambiguous-Interactive/DoxReloaded"] =
		fmt.Sprintf(`[{"id": %d, "name": "Main Protection", "enforcement": "active"}]`, managedRulesetID)
	server.rulesetDetailPayloads[managedRulesetID] =
		detailPayload("Main Protection", "CI Success", "OMIT")
	server.activeRulesPayloads["Ambiguous-Interactive/DoxReloaded@main"] =
		activeRulesJSON("CI Success")
	// The live ruleset requires CI Success; the attestation names a context
	// that no longer exists, so the attested bypass list is untrusted.
	server.contentsPayloads["Ambiguous-Interactive/DoxReloaded"] = contentsEnvelope(attestationBody(
		attestedRuleset("Main Protection", `["Legacy Context"]`, ""),
	))
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 1 {
		t.Fatalf("stale attestation exit = %d, want 1", exit)
	}
	audit := decodeArtifact(t, content)
	if audit.Complete {
		t.Fatalf("a stale attestation must fail the audit closed: %s", content)
	}
	if len(audit.Findings) != 1 ||
		audit.Findings[0].Code != "merge-policy-attestation-stale" {
		t.Fatalf("unexpected artifact: %s", content)
	}
}

func TestRunReportsAttestedBypassActorAsDrift(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory,
		expectationBody("DoxReloaded", "main", "CI Success"),
		expectationBody("DxMessaging", "master", ""),
		expectationBody("IshoBoy", "main", ""),
		expectationBody("qora-redux", "main", ""),
		expectationBody("unity-builder", "main", ""),
		expectationBody("unity-helpers", "main", ""),
	)
	server, client := newRulesetServer(t)
	server.rulesetListPayloads["Ambiguous-Interactive/DoxReloaded"] =
		fmt.Sprintf(`[{"id": %d, "name": "Main Protection", "enforcement": "active"}]`, managedRulesetID)
	server.rulesetDetailPayloads[managedRulesetID] =
		detailPayload("Main Protection", "CI Success", "OMIT")
	server.activeRulesPayloads["Ambiguous-Interactive/DoxReloaded@main"] =
		activeRulesJSON("CI Success")
	server.contentsPayloads["Ambiguous-Interactive/DoxReloaded"] = contentsEnvelope(attestationBody(
		attestedRuleset("Main Protection", `["CI Success"]`,
			`[{"actorType": "Integration", "actorId": 3977200, "bypassMode": "always"}]`),
	))
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 1 {
		t.Fatalf("attested bypass drift exit = %d, want 1", exit)
	}
	audit := decodeArtifact(t, content)
	// The attested actor is real drift, but the evidence is complete: the
	// run fails on findings, not on retrieval.
	if !audit.Complete || len(audit.Findings) != 1 ||
		audit.Findings[0].Code != "unexpected-bypass-actor" {
		t.Fatalf("unexpected artifact: %s", content)
	}
	if !strings.Contains(audit.Findings[0].Detail, "(attested)") {
		t.Fatalf("attested evidence must be visible in the detail: %s", content)
	}
}

func TestRunFailsClosedWhenAttestationEnvelopeIsInvalid(t *testing.T) {
	// Every malformed contents envelope must fail the audit closed with a
	// retrieval finding, never read as an absent file. The two oversize
	// cases pin each size bound independently: one exceeds the declared
	// size only, the other exceeds the encoded length only.
	oversizedEncoded := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("A", 49153)))
	var wrapped strings.Builder
	for len(oversizedEncoded) > 0 {
		cut := len(oversizedEncoded)
		if cut > 60 {
			cut = 60
		}
		wrapped.WriteString(oversizedEncoded[:cut])
		wrapped.WriteString("\n")
		oversizedEncoded = oversizedEncoded[cut:]
	}
	cases := map[string]string{
		"non-base64 encoding": `{"content": "eHl6", "encoding": "plain", "size": 3}`,
		"missing content":     `{"encoding": "base64", "size": 3}`,
		"undecodable content": `{"content": "!!!not base64!!!", "encoding": "base64", "size": 3}`,
		"oversized declared size": fmt.Sprintf(
			`{"content": "eHl6", "encoding": "base64", "size": %d}`,
			mergepolicy.MaxAttestationBytes+1,
		),
		"oversized encoded length": fmt.Sprintf(
			`{"content": %q, "encoding": "base64", "size": %d}`,
			wrapped.String(), 49153,
		),
	}
	for name, envelope := range cases {
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			policyPath := writeRepositoryPolicy(t, directory)
			expectationsPath := writeExpectations(t, directory,
				expectationBody("DoxReloaded", "main", "CI Success"),
				expectationBody("DxMessaging", "master", ""),
				expectationBody("IshoBoy", "main", ""),
				expectationBody("qora-redux", "main", ""),
				expectationBody("unity-builder", "main", ""),
				expectationBody("unity-helpers", "main", ""),
			)
			server, client := newRulesetServer(t)
			server.contentsPayloads["Ambiguous-Interactive/DoxReloaded"] = envelope
			exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
			if exit != 1 {
				t.Fatalf("%s: exit = %d, want 1", name, exit)
			}
			audit := decodeArtifact(t, content)
			if audit.Complete {
				t.Fatalf("%s: a broken envelope must fail the audit closed: %s", name, content)
			}
			found := false
			for _, finding := range audit.Findings {
				if finding.Repository == "Ambiguous-Interactive/DoxReloaded" &&
					finding.Code == "merge-policy-retrieval-incomplete" {
					found = true
				}
			}
			if !found {
				t.Fatalf("%s: retrieval finding is missing: %s", name, content)
			}
		})
	}
}

func TestRunFailsClosedWhenAttestationReadFails(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory,
		expectationBody("DoxReloaded", "main", "CI Success"),
		expectationBody("DxMessaging", "master", ""),
		expectationBody("IshoBoy", "main", ""),
		expectationBody("qora-redux", "main", ""),
		expectationBody("unity-builder", "main", ""),
		expectationBody("unity-helpers", "main", ""),
	)
	server, client := newRulesetServer(t)
	// A non-404 contents failure is ambiguous; it must never be read as
	// "not published".
	server.contentsStatus = http.StatusInternalServerError
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 1 {
		t.Fatalf("contents read failure exit = %d, want 1", exit)
	}
	audit := decodeArtifact(t, content)
	if audit.Complete || len(audit.Findings) != 6 {
		t.Fatalf("every repository must fail closed: %s", content)
	}
	for _, finding := range audit.Findings {
		if finding.Code != "merge-policy-retrieval-incomplete" {
			t.Fatalf("unexpected artifact: %s", content)
		}
	}
}

func TestRunFailsClosedWhenAttestationIsInvalid(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory,
		expectationBody("DoxReloaded", "main", "CI Success"),
		expectationBody("DxMessaging", "master", ""),
		expectationBody("IshoBoy", "main", ""),
		expectationBody("qora-redux", "main", ""),
		expectationBody("unity-builder", "main", ""),
		expectationBody("unity-helpers", "main", ""),
	)
	server, client := newRulesetServer(t)
	server.contentsPayloads["Ambiguous-Interactive/DoxReloaded"] =
		contentsEnvelope(`{"schemaVersion": 2, "repository": "Ambiguous-Interactive/DoxReloaded", "rulesets": []}`)
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 1 {
		t.Fatalf("invalid attestation exit = %d, want 1", exit)
	}
	audit := decodeArtifact(t, content)
	if audit.Complete || len(audit.Findings) != 1 ||
		audit.Findings[0].Code != "merge-policy-attestation-stale" {
		t.Fatalf("an invalid attestation must fail the audit closed: %s", content)
	}
}

func TestRunFlagsStaleAttestationWhenLiveEvidenceIsVisible(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory,
		expectationBody("DoxReloaded", "main", "CI Success"),
		expectationBody("DxMessaging", "master", ""),
		expectationBody("IshoBoy", "main", ""),
		expectationBody("qora-redux", "main", ""),
		expectationBody("unity-builder", "main", ""),
		expectationBody("unity-helpers", "main", ""),
	)
	server, client := newRulesetServer(t)
	server.rulesetListPayloads["Ambiguous-Interactive/DoxReloaded"] =
		fmt.Sprintf(`[{"id": %d, "name": "Main Protection", "enforcement": "active"}]`, managedRulesetID)
	// Live bypass evidence is visible here, so the audit stays complete; the
	// stale attestation still fails the run until the consumer updates it.
	server.rulesetDetailPayloads[managedRulesetID] =
		detailPayload("Main Protection", "CI Success", "")
	server.activeRulesPayloads["Ambiguous-Interactive/DoxReloaded@main"] =
		activeRulesJSON("CI Success")
	server.contentsPayloads["Ambiguous-Interactive/DoxReloaded"] = contentsEnvelope(attestationBody(
		attestedRuleset("Renamed Protection", `["CI Success"]`, ""),
	))
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 1 {
		t.Fatalf("stale attestation with live evidence exit = %d, want 1", exit)
	}
	audit := decodeArtifact(t, content)
	if !audit.Complete || len(audit.Findings) != 1 ||
		audit.Findings[0].Code != "merge-policy-attestation-stale" {
		t.Fatalf("unexpected artifact: %s", content)
	}
}

func TestRunFailsClosedWhenAResponseIsNotValidUTF8(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory,
		expectationBody("DoxReloaded", "main", "CI Success"),
		expectationBody("DxMessaging", "master", ""),
		expectationBody("IshoBoy", "main", ""),
		expectationBody("qora-redux", "main", ""),
		expectationBody("unity-builder", "main", ""),
		expectationBody("unity-helpers", "main", ""),
	)
	server, client := newRulesetServer(t)
	server.rulesetListPayloads["Ambiguous-Interactive/DoxReloaded"] =
		fmt.Sprintf(`[{"id": %d, "name": "Main Protection", "enforcement": "active"}]`, managedRulesetID)
	// A required check context that carries a byte the decoder cannot read is
	// ambiguous evidence, not a context name. The audit must not read it as the
	// reviewed spelling, and must not read it as a different one either.
	server.rulesetDetailPayloads[managedRulesetID] =
		detailPayload("Main Protection", "CI Succ\xffess", "")
	server.activeRulesPayloads["Ambiguous-Interactive/DoxReloaded@main"] =
		activeRulesJSON("CI Success")
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 1 {
		t.Fatalf("unreadable response exit = %d, want 1", exit)
	}
	audit := decodeArtifact(t, content)
	if audit.Complete || len(audit.Findings) != 1 ||
		audit.Findings[0].Repository != "Ambiguous-Interactive/DoxReloaded" ||
		audit.Findings[0].Code != "merge-policy-retrieval-incomplete" {
		t.Fatalf("an unreadable response must fail that repository closed: %s", content)
	}
}

func TestRunTreatsUnexpectedProtection404AsRetrievalFailure(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory)
	server, client := newRulesetServer(t)
	// A bare 404 without the documented "Branch not protected" body is
	// ambiguous; it must never be read as "no protection".
	server.protectionStatus = http.StatusNotFound
	server.protection404Body = ""
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 1 {
		t.Fatalf("ambiguous protection 404 exit = %d, want 1", exit)
	}
	audit := decodeArtifact(t, content)
	if audit.Complete || len(audit.Findings) != 6 {
		t.Fatalf("every repository must fail closed: %s", content)
	}
}

func TestRunFailsClosedWhenRulesetDetailsAreUnreadable(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory)
	server, client := newRulesetServer(t)
	server.rulesetListPayloads["Ambiguous-Interactive/DoxReloaded"] =
		fmt.Sprintf(`[{"id": %d, "name": "Main Protection", "enforcement": "active"}]`, managedRulesetID)
	// A missing Administration read permission presents as 404 here.
	server.detailStatus = http.StatusNotFound
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 1 {
		t.Fatalf("unreadable details exit = %d, want 1", exit)
	}
	audit := decodeArtifact(t, content)
	if audit.Complete {
		t.Fatalf("an unreadable ruleset must fail the audit closed: %s", content)
	}
	found := false
	for _, finding := range audit.Findings {
		if finding.Repository == "Ambiguous-Interactive/DoxReloaded" &&
			finding.Code == "merge-policy-retrieval-incomplete" {
			found = true
		}
	}
	if !found {
		t.Fatalf("retrieval finding is missing: %s", content)
	}
}

func TestRunFailsClosedOnUnexpectedPagination(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory)
	server, client := newRulesetServer(t)
	server.withNextLink = true
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 1 {
		t.Fatalf("paginated rulesets exit = %d, want 1", exit)
	}
	if codes := findingCodes(t, content); len(codes) != 6 ||
		codes[0] != "merge-policy-retrieval-incomplete" {
		t.Fatalf("every repository must fail closed: %s", content)
	}
}

func TestRunFailsClosedWhenActiveRulesArePaginated(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory)
	server, client := newRulesetServer(t)
	server.withActiveNextLink = true
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 1 {
		t.Fatalf("paginated active rules exit = %d, want 1", exit)
	}
	if codes := findingCodes(t, content); len(codes) != 6 ||
		codes[0] != "merge-policy-retrieval-incomplete" {
		t.Fatalf("every repository must fail closed: %s", content)
	}
}

func TestRunRecordsClassicProtectionWithoutAdminEnforcement(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory,
		expectationBody("DoxReloaded", "main", ""),
		expectationBody("DxMessaging", "master", ""),
		expectationBody("IshoBoy", "main", ""),
		expectationBody("qora-redux", "main", "Unity CI"),
		expectationBody("unity-builder", "main", ""),
		expectationBody("unity-helpers", "main", ""),
	)
	server, client := newRulesetServer(t)
	// Classic protection requires the context, but administrators may bypass.
	server.protectionPayloads["Ambiguous-Interactive/qora-redux/branches/main"] = protectionJSON("Unity CI", false)
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 1 {
		t.Fatalf("admin bypass exit = %d, want 1", exit)
	}
	audit := decodeArtifact(t, content)
	if !audit.Complete || len(audit.Findings) != 1 ||
		audit.Findings[0].Code != "unexpected-bypass-actor" {
		t.Fatalf("unexpected artifact: %s", content)
	}
	if len(audit.Inventory) != 1 ||
		audit.Inventory[0].Kind != "branch-protection" ||
		audit.Inventory[0].Context != "Unity CI" ||
		audit.Inventory[0].Enforcement != "active-admin-bypass" {
		t.Fatalf("inventory must record the observed carrier: %s", content)
	}
}

// An escaped lone surrogate substitutes the same way an unreadable byte does,
// and the encoding check cannot see it. Both reviewed files are refused by
// name, so an operator is not sent to fix a spelling the file does not contain.
func TestRunRefusesEvidenceWithAnEscapedLoneSurrogate(t *testing.T) {
	reviewed := map[string]func(*testing.T, string) string{
		"policy":       writeRepositoryPolicy,
		"expectations": func(t *testing.T, directory string) string { return writeExpectations(t, directory) },
	}
	for name, write := range reviewed {
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			policyPath := writeRepositoryPolicy(t, directory)
			expectationsPath := writeExpectations(t, directory)
			escapeOneLoneSurrogate(t, write(t, directory), `"organization": "Ambiguous-Interactive"`)
			var stderr bytes.Buffer
			exit := run(
				[]string{"--policy", policyPath, "--expectations", expectationsPath, "--validate-only"},
				io.Discard,
				&stderr,
				func(string) string { return "" },
				nil,
			)
			if exit != 2 || !strings.Contains(stderr.String(), "lone surrogate") {
				t.Fatalf("exit = %d, want 2\nstderr=%s", exit, stderr.String())
			}
		})
	}
}

// escapeOneLoneSurrogate rewrites the last string of a JSON fragment as an
// escaped lone surrogate, so the file stays valid UTF-8 and valid JSON and only
// a check for the escape can refuse it.
func escapeOneLoneSurrogate(t *testing.T, path string, fragment string) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(content, []byte(fragment)) {
		t.Fatalf("fixture %q is missing from %s", fragment, path)
	}
	escaped := bytes.Replace(
		content,
		[]byte(fragment),
		[]byte(fragment[:len(fragment)-1]+`\ud800"`),
		1,
	)
	if !utf8.Valid(escaped) {
		t.Fatal("the escaped fixture is not valid UTF-8, so the test proves nothing")
	}
	if !json.Valid(escaped) {
		t.Fatal("the escaped fixture is not valid JSON, so the test proves nothing")
	}
	if err := os.WriteFile(path, escaped, 0o600); err != nil {
		t.Fatal(err)
	}
}

// A live response carrying an escape is the same substitution as an unreadable
// byte, and this decoder owns the refusal every caller turns into a named
// retrieval failure. A repository that published one must not be reported as
// matching the reviewed expectations.
func TestStrictDecodeRejectsAnEscapedLoneSurrogate(t *testing.T) {
	type response struct {
		Rulesets []struct {
			Name string `json:"name"`
		} `json:"rulesets"`
	}
	var decoded response
	if err := strictDecode([]byte(`{"rulesets":[{"name":"\ud800"}]}`), &decoded); err == nil ||
		!strings.Contains(err.Error(), "lone surrogate") {
		t.Fatalf("error = %v, want a named lone-surrogate refusal", err)
	}
	if err := strictDecode([]byte(`{"rulesets":[{"name":"protect main"}]}`), &decoded); err != nil {
		t.Fatalf("a clean response was refused: %v", err)
	}
	// The guard runs after the decode, so a malformed response keeps the
	// decoder's own message rather than the escape message. The input carries a
	// well-formed escape and is truncated after it, so the guard would answer if
	// it ran first. Without the escape this assertion holds at any position and
	// pins nothing.
	if err := strictDecode([]byte(`{"rulesets":[{"name":"\ud800"}`), &decoded); err == nil ||
		strings.Contains(err.Error(), "lone surrogate") {
		t.Fatalf("error = %v, want the decoder's own message", err)
	}
}

// auditedRepository is the one repository this test damages. Every other
// repository keeps its drift findings, so the assertions count the findings of
// this repository alone.
const auditedRepository = "Ambiguous-Interactive/DoxReloaded"

// damagedRead is one live read the audit makes for a repository: the payload it
// returns and the server state the audit must already hold to reach it.
type damagedRead struct {
	name    string
	label   string
	payload func(inserted string) string
	arrange func(server *rulesetServer, payload string)
}

// damagedReads returns every response the audit decodes for one repository. A
// read that is damaged must be the first read that fails, so each row holds
// every other read of that repository clean.
func damagedReads() []damagedRead {
	cleanRulesets := func(server *rulesetServer) {
		server.rulesetListPayloads[auditedRepository] =
			fmt.Sprintf(`[{"id": %d, "name": "Main Protection", "enforcement": "active"}]`, managedRulesetID)
		server.rulesetDetailPayloads[managedRulesetID] = detailPayload("Main Protection", "CI Success", "")
		server.activeRulesPayloads[auditedRepository+"@main"] = activeRulesJSON("CI Success")
	}
	return []damagedRead{
		{
			name:  "active rules",
			label: "active rules response",
			payload: func(inserted string) string {
				return damageInsideJSONString(activeRulesJSON("CI Success"), `"context": "CI Success`, inserted)
			},
			arrange: func(server *rulesetServer, payload string) {
				server.activeRulesPayloads[auditedRepository+"@main"] = payload
			},
		},
		{
			name:  "ruleset list",
			label: "ruleset list response",
			payload: func(inserted string) string {
				return damageInsideJSONString(
					fmt.Sprintf(`[{"id": %d, "name": "Main Protection", "enforcement": "active"}]`, managedRulesetID),
					`"name": "Main Protection`, inserted,
				)
			},
			arrange: func(server *rulesetServer, payload string) {
				// The detail read follows the list read, so it must be clean.
				cleanRulesets(server)
				server.rulesetListPayloads[auditedRepository] = payload
			},
		},
		{
			name:  "ruleset detail",
			label: fmt.Sprintf("ruleset %d response", managedRulesetID),
			payload: func(inserted string) string {
				return damageInsideJSONString(
					detailPayload("Main Protection", "CI Success", ""), `"context": "CI Success`, inserted,
				)
			},
			arrange: func(server *rulesetServer, payload string) {
				cleanRulesets(server)
				server.rulesetDetailPayloads[managedRulesetID] = payload
			},
		},
		{
			name:  "branch protection",
			label: "branch protection response",
			payload: func(inserted string) string {
				return damageInsideJSONString(protectionJSON("CI Success", true), `"context": "CI Success`, inserted)
			},
			arrange: func(server *rulesetServer, payload string) {
				server.protectionPayloads[auditedRepository+"/branches/main"] = payload
			},
		},
		{
			name:  "contents",
			label: "contents response",
			// The contents envelope carries the damage in a key the audit does
			// not read. The base64 text cannot hold it, because a substituted
			// byte there would fail the base64 decode for an unrelated reason.
			payload: func(inserted string) string {
				return strings.Replace(
					contentsEnvelope(attestationBody()), `{"content": "`, `{"sha": "`+inserted+`", "content": "`, 1,
				)
			},
			arrange: func(server *rulesetServer, payload string) {
				cleanRulesets(server)
				server.contentsPayloads[auditedRepository] = payload
			},
		},
	}
}

// damageInsideJSONString inserts one byte sequence at the end of the named
// string, so the payload stays valid JSON and only a strict decode can see the
// damage. Without that, a decoder error would prove the guard nothing.
func damageInsideJSONString(payload, marker, inserted string) string {
	if !strings.Contains(payload, marker) {
		panic("fixture " + marker + " is missing from " + payload)
	}
	damaged := strings.Replace(payload, marker, marker+inserted, 1)
	if !json.Valid([]byte(damaged)) {
		panic("the damaged payload is not valid JSON, so it proves nothing")
	}
	return damaged
}

// causeExpectationBodies reviews the same contexts the damaged fixtures carry,
// so a finding count cannot grow because the expectation set changed.
func causeExpectationBodies() []string {
	return []string{
		expectationBody("DoxReloaded", "main", "CI Success"),
		expectationBody("DxMessaging", "master", "Unity CI Success"),
		expectationBody("IshoBoy", "main", "Unity CI Success"),
		expectationBody("qora-redux", "main", "Unity CI"),
		expectationBody("unity-builder", "main", ""),
		expectationBody("unity-helpers", "main", "Unity CI Success"),
	}
}

// A refused response is only actionable when the artifact says which read
// refused and why. Both doors of the decoder guard have to reach the artifact
// with the name of the read attached, so an operator does not search five
// endpoints for the one that failed.
func TestRunPublishesTheRefusalCauseForEveryDamagedRead(t *testing.T) {
	doors := []struct {
		name     string
		inserted string
		reason   string
	}{
		{name: "invalid UTF-8 byte", inserted: "\xff", reason: jsonstrict.ReasonNotUTF8},
		{name: "escaped lone surrogate", inserted: `\ud800`, reason: jsonstrict.ReasonLoneSurrogateEscape},
	}
	for _, read := range damagedReads() {
		t.Run(read.name, func(t *testing.T) {
			for _, door := range doors {
				t.Run(door.name, func(t *testing.T) {
					directory := t.TempDir()
					policyPath := writeRepositoryPolicy(t, directory)
					expectationsPath := writeExpectations(t, directory, causeExpectationBodies()...)
					server, client := newRulesetServer(t)
					read.arrange(server, read.payload(door.inserted))
					exit, content := runAudit(
						t, directory, server.URL, client, policyPath, expectationsPath, "reader-token",
					)
					if exit != 1 {
						t.Fatalf("damaged %s exit = %d, want 1; artifact: %s", read.name, exit, content)
					}
					audit := decodeArtifact(t, content)
					if audit.Complete {
						t.Fatalf("a damaged %s must fail the audit closed: %s", read.name, content)
					}
					findings := repositoryFindings(audit.Findings, auditedRepository)
					if len(findings) != 1 ||
						findings[0].Code != mergepolicy.CodeRetrievalIncomplete {
						t.Fatalf("want one %s finding for %s, got %#v in %s",
							mergepolicy.CodeRetrievalIncomplete, auditedRepository, findings, content)
					}
					finding := findings[0]
					if finding.Cause != read.label+" "+door.reason {
						t.Fatalf("cause = %q, want %q", finding.Cause, read.label+" "+door.reason)
					}
					if finding.Detail != "" {
						// A retrieval finding has no drift evidence. A cause copied
						// into the detail would make the alert read as drift.
						t.Fatalf("retrieval finding carries a detail: %#v", finding)
					}
					assertCauseIsPublishable(t, finding.Cause)
				})
			}
		})
	}
}

// assertCauseIsPublishable pins the alphabet the issue validator accepts. A
// cause outside it is not a bad alert row: the validator refuses the whole
// artifact, so the drift alert never opens at all.
func assertCauseIsPublishable(t *testing.T, cause string) {
	t.Helper()
	publishable := regexp.MustCompile("^[" + mergepolicy.Alphabet + "-]{0," +
		strconv.Itoa(mergepolicy.MaxDetailBytes) + "}$")
	if !publishable.MatchString(cause) {
		t.Fatalf("cause %q is outside the issue alphabet", cause)
	}
}

// The substituted form of the same damage is a value the decoder can read, so
// only the guard can refuse it. If a substituted payload is also refused, the
// test would pass for the wrong reason.
func TestRunAcceptsTheSubstitutedFormOfEveryDamagedRead(t *testing.T) {
	for _, read := range damagedReads() {
		t.Run(read.name, func(t *testing.T) {
			directory := t.TempDir()
			policyPath := writeRepositoryPolicy(t, directory)
			expectationsPath := writeExpectations(t, directory, causeExpectationBodies()...)
			server, client := newRulesetServer(t)
			read.arrange(server, read.payload("\uFFFD"))
			_, content := runAudit(
				t, directory, server.URL, client, policyPath, expectationsPath, "reader-token",
			)
			audit := decodeArtifact(t, content)
			for _, finding := range repositoryFindings(audit.Findings, auditedRepository) {
				if finding.Code == mergepolicy.CodeRetrievalIncomplete {
					t.Fatalf("a substituted %s was refused: %s", read.name, content)
				}
			}
			if !audit.Complete {
				t.Fatalf("a substituted %s must stay complete evidence: %s", read.name, content)
			}
		})
	}
}

// A consumer that published a file the decoder cannot represent cannot tell
// which of the many reasons it was refused, so it republishes the same file and
// the alert returns. The cause therefore has to be in both channels: the cause
// is the machine-readable reason, the detail is what the consumer reads.
func TestRunCarriesTheAttestationCauseInBothChannels(t *testing.T) {
	directory := t.TempDir()
	policyPath := writeRepositoryPolicy(t, directory)
	expectationsPath := writeExpectations(t, directory, causeExpectationBodies()...)
	server, client := newRulesetServer(t)
	server.rulesetListPayloads[auditedRepository] =
		fmt.Sprintf(`[{"id": %d, "name": "Main Protection", "enforcement": "active"}]`, managedRulesetID)
	server.rulesetDetailPayloads[managedRulesetID] = detailPayload("Main Protection", "CI Success", "")
	server.activeRulesPayloads[auditedRepository+"@main"] = activeRulesJSON("CI Success")
	server.contentsPayloads[auditedRepository] = contentsEnvelope(damageInsideJSONString(
		attestationBody(), `"repository": "Ambiguous-Interactive/DoxReloaded`, "\xff",
	))
	exit, content := runAudit(t, directory, server.URL, client, policyPath, expectationsPath, "reader-token")
	if exit != 1 {
		t.Fatalf("damaged attestation exit = %d, want 1; artifact: %s", exit, content)
	}
	audit := decodeArtifact(t, content)
	if audit.Complete {
		t.Fatalf("an unreadable published file must fail the audit closed: %s", content)
	}
	findings := repositoryFindings(audit.Findings, auditedRepository)
	if len(findings) != 1 || findings[0].Code != mergepolicy.CodeAttestationStale {
		t.Fatalf("want one %s finding for %s, got %#v in %s",
			mergepolicy.CodeAttestationStale, auditedRepository, findings, content)
	}
	finding := findings[0]
	want := "merge policy attestation " + jsonstrict.ReasonNotUTF8
	if finding.Cause != want {
		t.Fatalf("cause = %q, want %q", finding.Cause, want)
	}
	if finding.Detail != finding.Cause {
		t.Fatalf("detail = %q, want the same cause %q", finding.Detail, finding.Cause)
	}
	assertCauseIsPublishable(t, finding.Cause)
}
