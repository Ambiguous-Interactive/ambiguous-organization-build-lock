package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/enrollment"
)

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
	body := renderIssueBody(audit)
	for _, expected := range []string{
		alertMarker, "Ambiguous-Interactive/DoxReloaded", ".github/workflows/unity.yml",
		"missing-lock-acquire", "paid-serial",
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
		switch {
		case request.Method == http.MethodGet:
			_ = json.NewEncoder(writer).Encode(current)
		case request.Method == http.MethodPost:
			var payload map[string]any
			_ = json.NewDecoder(request.Body).Decode(&payload)
			current = []issue{{Number: 42, State: "open", Title: alertTitle, Body: payload["body"].(string)}}
			writer.WriteHeader(http.StatusCreated)
			_, _ = writer.Write([]byte(`{}`))
		case request.Method == http.MethodPatch:
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
	if err := client.sync(t.Context(), drift); err != nil {
		t.Fatal(err)
	}
	if len(current) != 1 || current[0].State != "open" {
		t.Fatalf("alert was not created: %#v", current)
	}
	if err := client.sync(t.Context(), drift); err != nil {
		t.Fatal(err)
	}
	if len(current) != 1 {
		t.Fatalf("alert was duplicated: %#v", current)
	}
	if err := client.sync(t.Context(), sampleAudit()); err != nil {
		t.Fatal(err)
	}
	if current[0].State != "closed" {
		t.Fatalf("clean audit did not close alert: %#v", current)
	}
	if len(requests) != 6 {
		t.Fatalf("unexpected request count %d: %#v", len(requests), requests)
	}
}

func TestSyncRejectsDuplicateMarkerIssues(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(writer).Encode([]issue{
			{Number: 1, Body: alertMarker},
			{Number: 2, Body: alertMarker},
		})
	}))
	defer server.Close()
	client, err := newGitHubClient(server.URL, "Ambiguous-Interactive/lock", "token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if err := client.sync(t.Context(), sampleAudit()); err == nil {
		t.Fatal("duplicate marker issues passed")
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

func TestAuditAndIssueBodyAreBounded(t *testing.T) {
	audit := sampleAudit()
	audit.Findings = make([]enrollment.UnityAuditFinding, maxAuditRows+1)
	if err := validateAudit(audit); err == nil {
		t.Fatal("oversized finding collection passed")
	}

	audit = sampleAudit()
	audit.Inventory[0].Job = strings.Repeat("x", 128)
	audit.Inventory = make([]enrollment.UnityInventoryEntry, maxAuditRows)
	for index := range audit.Inventory {
		audit.Inventory[index] = sampleAudit().Inventory[0]
		audit.Inventory[index].Job = strings.Repeat("x", 128)
	}
	audit.Findings = make([]enrollment.UnityAuditFinding, maxAuditRows)
	for index := range audit.Findings {
		audit.Findings[index] = enrollment.UnityAuditFinding{
			Repository: "Ambiguous-Interactive/DoxReloaded",
			SHA:        strings.Repeat("a", 40),
			Code:       "missing-lock-acquire",
			Path:       ".github/workflows/unity.yml",
			Job:        strings.Repeat("x", 128),
		}
	}
	if len(renderIssueBody(audit)) <= maxIssueBodyBytes {
		t.Fatal("fixture did not exceed the issue-body bound")
	}
}
