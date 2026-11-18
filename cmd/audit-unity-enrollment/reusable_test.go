package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/enrollment"
)

const reusableWorkflowCommit = "0123456789abcdef0123456789abcdef01234567"

const reusableWorkflowFixture = `name: OpenAI Review
on:
  workflow_call:
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - run: python3 scripts/review.py
`

func TestReusableWorkflowFetcherReadsOneImmutableIdentity(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		if request.URL.Path != "/Ambiguous-Interactive/review-tools/"+reusableWorkflowCommit+"/.github/workflows/openai-review.yml" {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = writer.Write([]byte(reusableWorkflowFixture))
	}))
	defer server.Close()
	fetcher := newReusableWorkflowFetcher(server.URL)

	content, err := fetcher.resolve(
		"Ambiguous-Interactive/review-tools",
		".github/workflows/openai-review.yml",
		reusableWorkflowCommit,
	)
	if err != nil || string(content) != reusableWorkflowFixture {
		t.Fatalf("unexpected read: %q %v", content, err)
	}
	if _, err := fetcher.resolve(
		"Ambiguous-Interactive/review-tools",
		".github/workflows/openai-review.yml",
		reusableWorkflowCommit,
	); err != nil {
		t.Fatalf("cached read failed: %v", err)
	}
	if requests != 1 {
		t.Fatalf("the fetcher read %d times for one identity", requests)
	}
	if _, err := fetcher.resolve(
		"Ambiguous-Interactive/review-tools",
		".github/workflows/missing.yml",
		reusableWorkflowCommit,
	); err == nil {
		t.Fatal("a refused read was reported as content")
	}
}

func TestReusableWorkflowFetcherRefusesOversizedContent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write(bytes.Repeat([]byte("a"), maxReusableWorkflowBytes+1))
	}))
	defer server.Close()
	fetcher := newReusableWorkflowFetcher(server.URL)
	if _, err := fetcher.resolve(
		"Ambiguous-Interactive/review-tools",
		".github/workflows/openai-review.yml",
		reusableWorkflowCommit,
	); err == nil {
		t.Fatal("oversized content was accepted")
	}
}

func TestRunResolvesNonLicensingRemoteReusableWorkflow(t *testing.T) {
	root := t.TempDir()
	registry := testRegistry
	policyPath := writeRegistryFixture(t, root, registry)
	outputPath := filepath.Join(root, "audit.json")
	for _, repository := range registry.Repositories {
		buildRepositoryFixture(t, root, repository, registry, nil)
	}
	consumerRoot := filepath.Join(root, "DxMessaging")
	workflowPath := filepath.Join(consumerRoot, ".github", "workflows", "openai-review.yml")
	if err := os.MkdirAll(filepath.Dir(workflowPath), 0o700); err != nil {
		t.Fatal(err)
	}
	workflow := "on: pull_request\njobs:\n  review:\n    uses: Ambiguous-Interactive/review-tools/.github/workflows/openai-review.yml@" + reusableWorkflowCommit + "\n"
	if err := os.WriteFile(workflowPath, []byte(workflow), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, consumerRoot, "add", ".")
	runGit(t, consumerRoot, "commit", "-m", "add review call")

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if !strings.HasSuffix(request.URL.Path, "/"+reusableWorkflowCommit+"/.github/workflows/openai-review.yml") {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = writer.Write([]byte(reusableWorkflowFixture))
	}))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	exit := run([]string{
		"--policy", policyPath,
		"--repositories-root", root,
		"--output", outputPath,
		"--reusable-workflow-base-url", server.URL,
	}, &stdout, &stderr)
	if exit != 0 {
		t.Fatalf("got exit %d\nstdout=%s\nstderr=%s", exit, stdout.String(), stderr.String())
	}
	content, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatal(err)
	}
	var audit enrollment.UnityOrganizationAudit
	if err := json.Unmarshal(content, &audit); err != nil {
		t.Fatal(err)
	}
	if !audit.Complete || len(audit.Findings) != 0 {
		t.Fatalf("resolved non-licensing call produced findings: %#v", audit.Findings)
	}
}

func TestReusableWorkflowFetcherRefusesARedirect(t *testing.T) {
	// The redirect stays on this server and changes only the path, so the
	// fetcher must refuse it on identity, not on host.
	source := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasSuffix(request.URL.Path, "/other.yml") {
			_, _ = writer.Write([]byte(reusableWorkflowFixture))
			return
		}
		http.Redirect(writer, request, "/other.yml", http.StatusFound)
	}))
	defer source.Close()
	fetcher := newReusableWorkflowFetcher(source.URL)
	if _, err := fetcher.resolve(
		"Ambiguous-Interactive/review-tools",
		".github/workflows/openai-review.yml",
		reusableWorkflowCommit,
	); err == nil {
		t.Fatal("a redirect to another path was followed")
	}
}
