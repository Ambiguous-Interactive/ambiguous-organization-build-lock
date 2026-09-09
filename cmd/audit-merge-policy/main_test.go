package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/mergepolicy"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
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
	if context != "" {
		contexts = `"` + context + `"`
	}
	return fmt.Sprintf(`{
    "repository": "Ambiguous-Interactive/%s",
    "defaultBranch": "%s",
    "requiredContexts": [%s],
    "requireAdminEnforcement": %t,
    "allowedBypassActors": []
  }`, repository, branch, contexts, context != "")
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
  "schemaVersion": 1,
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
				rest[separator:] != "/contents/"+filepath.Join(".github", "merge-policy-attestation.json") ||
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

func decodeArtifact(t *testing.T, content string) struct {
	Complete     bool `json:"complete"`
	Repositories []struct {
		Repository string `json:"repository"`
	} `json:"repositories"`
	Inventory []struct {
		Repository  string `json:"repository"`
		Kind        string `json:"kind"`
		Carrier     string `json:"carrier"`
		Context     string `json:"context"`
		Enforcement string `json:"enforcement"`
	} `json:"inventory"`
	Findings []struct {
		Repository string `json:"repository"`
		Code       string `json:"code"`
		Context    string `json:"context"`
		Detail     string `json:"detail"`
	} `json:"findings"`
} {
	t.Helper()
	var audit struct {
		Complete     bool `json:"complete"`
		Repositories []struct {
			Repository string `json:"repository"`
		} `json:"repositories"`
		Inventory []struct {
			Repository  string `json:"repository"`
			Kind        string `json:"kind"`
			Carrier     string `json:"carrier"`
			Context     string `json:"context"`
			Enforcement string `json:"enforcement"`
		} `json:"inventory"`
		Findings []struct {
			Repository string `json:"repository"`
			Code       string `json:"code"`
			Context    string `json:"context"`
			Detail     string `json:"detail"`
		} `json:"findings"`
	}
	if err := json.Unmarshal([]byte(content), &audit); err != nil {
		t.Fatalf("decode artifact: %v", err)
	}
	return audit
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
	// retrieval finding, never read as an absent file.
	cases := map[string]string{
		"non-base64 encoding": `{"content": "eHl6", "encoding": "plain", "size": 3}`,
		"missing content":     `{"encoding": "base64", "size": 3}`,
		"undecodable content": `{"content": "!!!not base64!!!", "encoding": "base64", "size": 3}`,
		"oversized content": fmt.Sprintf(
			`{"content": %q, "encoding": "base64", "size": %d}`,
			strings.Repeat("QQ==\n", mergepolicy.MaxAttestationBytes/4+1), mergepolicy.MaxAttestationBytes+64,
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
