package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
