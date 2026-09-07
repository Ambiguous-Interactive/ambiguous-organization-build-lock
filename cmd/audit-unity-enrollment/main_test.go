package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/enrollment"
)

func TestRunFailsClosedAndWritesSanitizedArtifactWhenRepositoriesAreMissing(t *testing.T) {
	root := t.TempDir()
	policyPath := filepath.Join(root, "policy.json")
	outputPath := filepath.Join(root, "audit.json")
	policy, err := os.ReadFile("../../unity-enrollment-policy.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(policyPath, policy, 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	exit := run([]string{
		"--policy", policyPath,
		"--repositories-root", filepath.Join(root, "missing"),
		"--output", outputPath,
	}, &stdout, &stderr)
	if exit != 1 {
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
	if audit.Complete || len(audit.Repositories) != 0 || len(audit.Findings) != 6 {
		t.Fatalf("unexpected audit: %#v", audit)
	}
	for _, finding := range audit.Findings {
		if finding.Code != "repository-retrieval-incomplete" ||
			finding.Path != "" || finding.Job != "" || finding.SHA != "" {
			t.Fatalf("retrieval diagnostic was not sanitized: %#v", finding)
		}
	}
}

func TestRunCanValidatePolicyWithoutRepositoryAccess(t *testing.T) {
	var stdout, stderr bytes.Buffer
	exit := run([]string{
		"--policy", "../../unity-enrollment-policy.json",
		"--validate-policy-only",
	}, &stdout, &stderr)
	if exit != 0 || !strings.Contains(stdout.String(), "policy is valid") {
		t.Fatalf("got exit %d\nstdout=%s\nstderr=%s", exit, stdout.String(), stderr.String())
	}
}

func TestRunAuditsCompleteExactRepositorySet(t *testing.T) {
	root := t.TempDir()
	policyContent, err := os.ReadFile("../../unity-enrollment-policy.json")
	if err != nil {
		t.Fatal(err)
	}
	registry, err := enrollment.ParseUnityEnrollmentRegistry(policyContent)
	if err != nil {
		t.Fatal(err)
	}
	for index := range registry.Exceptions {
		registry.Exceptions[index].ExpiresAt = "2099-01-01T00:00:00Z"
	}
	policyContent, err = json.Marshal(registry)
	if err != nil {
		t.Fatal(err)
	}
	policyPath := filepath.Join(root, "policy.json")
	outputPath := filepath.Join(root, "audit.json")
	if err := os.WriteFile(policyPath, policyContent, 0o600); err != nil {
		t.Fatal(err)
	}

	for _, repository := range registry.Repositories {
		buildRepositoryFixture(t, root, repository, registry, nil)
	}

	var stdout, stderr bytes.Buffer
	exit := run([]string{
		"--policy", policyPath,
		"--repositories-root", root,
		"--output", outputPath,
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
	if !audit.Complete || len(audit.Repositories) != len(registry.Repositories) ||
		len(audit.Inventory) != len(registry.Exceptions) || len(audit.Findings) != 0 {
		t.Fatalf("unexpected complete audit: %#v", audit)
	}
}

func buildRepositoryFixture(
	t *testing.T,
	root string,
	repository enrollment.UnityEnrollmentRepository,
	registry enrollment.UnityEnrollmentRegistry,
	omitFiles map[string]bool,
) {
	t.Helper()
	repositoryRoot := filepath.Join(root, repositoryName(repository.Repository))
	if err := os.MkdirAll(repositoryRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repositoryRoot, "README.md"), []byte("fixture\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, exception := range registry.Exceptions {
		if exception.Repository != repository.Repository {
			continue
		}
		path := filepath.Join(repositoryRoot, filepath.FromSlash(exception.Path))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		workflow := "on: workflow_dispatch\njobs:\n  fixture:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo UNITY_SERIAL\n"
		if err := os.WriteFile(path, []byte(workflow), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, exception := range registry.RepinExceptions {
		if exception.Repository != repository.Repository || omitFiles[exception.Path] {
			continue
		}
		path := filepath.Join(repositoryRoot, filepath.FromSlash(exception.Path))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		workflow := "on: workflow_dispatch\njobs:\n  fixture:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo 'no unity reference'\n"
		if err := os.WriteFile(path, []byte(workflow), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	runGit(t, repositoryRoot, "init")
	runGit(t, repositoryRoot, "config", "user.name", "Enrollment Test")
	runGit(t, repositoryRoot, "config", "user.email", "enrollment@example.invalid")
	runGit(t, repositoryRoot, "remote", "add", "origin", "https://github.com/"+repository.Repository+".git")
	runGit(t, repositoryRoot, "add", ".")
	runGit(t, repositoryRoot, "commit", "-m", "fixture")
}

// testRegistry is the parsed live policy used to build repository fixtures.
var testRegistry = func() enrollment.UnityEnrollmentRegistry {
	content, err := os.ReadFile("../../unity-enrollment-policy.json")
	if err != nil {
		panic(err)
	}
	registry, err := enrollment.ParseUnityEnrollmentRegistry(content)
	if err != nil {
		panic(err)
	}
	return registry
}()

// writeRegistryFixture serializes a mutated registry for one audit run.
func writeRegistryFixture(t *testing.T, root string, registry enrollment.UnityEnrollmentRegistry) string {
	t.Helper()
	registry.Exceptions = append([]enrollment.UnityPolicyException(nil), registry.Exceptions...)
	for index := range registry.Exceptions {
		registry.Exceptions[index].ExpiresAt = "2099-01-01T00:00:00Z"
	}
	policyContent, err := json.Marshal(registry)
	if err != nil {
		t.Fatal(err)
	}
	policyPath := filepath.Join(root, "policy.json")
	if err := os.WriteFile(policyPath, policyContent, 0o600); err != nil {
		t.Fatal(err)
	}
	return policyPath
}

func TestRunReportsRepinExceptionStalenessInArtifact(t *testing.T) {
	root := t.TempDir()
	registry := testRegistry
	registry.RepinExceptions = []enrollment.UnityRepinException{{
		Repository: "Ambiguous-Interactive/unity-helpers",
		Path:       ".github/workflows/repin-protected.yml",
		Reason:     "wrapper cannot supply the newest input contract",
		Owner:      "unity-helpers-maintainers",
		ExpiresAt:  "2099-01-01T00:00:00Z",
	}}
	policyPath := writeRegistryFixture(t, root, registry)
	outputPath := filepath.Join(root, "audit.json")
	for _, repository := range registry.Repositories {
		buildRepositoryFixture(t, root, repository, registry, map[string]bool{
			".github/workflows/repin-protected.yml": true,
		})
	}

	var stdout, stderr bytes.Buffer
	exit := run([]string{
		"--policy", policyPath,
		"--repositories-root", root,
		"--output", outputPath,
	}, &stdout, &stderr)
	if exit != 1 {
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
	if !audit.Complete || len(audit.Findings) != 1 {
		t.Fatalf("unexpected audit: %#v", audit)
	}
	finding := audit.Findings[0]
	if finding.Repository != "Ambiguous-Interactive/unity-helpers" ||
		finding.Code != "stale-repin-exception" ||
		finding.Path != ".github/workflows/repin-protected.yml" ||
		finding.Job != "" || !fullSHA(finding.SHA) {
		t.Fatalf("repin staleness finding lost provenance: %#v", finding)
	}
}

func TestRunKeepsProtectedRepinFileCleanInArtifact(t *testing.T) {
	root := t.TempDir()
	registry := testRegistry
	protectedFile := ".github/workflows/repin-protected.yml"
	registry.RepinExceptions = []enrollment.UnityRepinException{{
		Repository: "Ambiguous-Interactive/unity-helpers",
		Path:       protectedFile,
		Reason:     "wrapper cannot supply the newest input contract",
		Owner:      "unity-helpers-maintainers",
		ExpiresAt:  "2099-01-01T00:00:00Z",
	}}
	policyPath := writeRegistryFixture(t, root, registry)
	outputPath := filepath.Join(root, "audit.json")
	for _, repository := range registry.Repositories {
		buildRepositoryFixture(t, root, repository, registry, nil)
	}

	var stdout, stderr bytes.Buffer
	exit := run([]string{
		"--policy", policyPath,
		"--repositories-root", root,
		"--output", outputPath,
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
		t.Fatalf("protected file produced findings: %#v", audit.Findings)
	}
}

func runGit(t *testing.T, root string, arguments ...string) {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", root}, arguments...)...)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(arguments, " "), err, output)
	}
}

func TestCanonicalRemoteRequiresExactRepository(t *testing.T) {
	for _, remote := range []string{
		"https://github.com/Ambiguous-Interactive/DoxReloaded.git",
		"https://github.com/Ambiguous-Interactive/DoxReloaded",
		"git@github.com:Ambiguous-Interactive/DoxReloaded.git",
	} {
		if !canonicalRemote(remote, "Ambiguous-Interactive/DoxReloaded") {
			t.Fatalf("rejected canonical remote %q", remote)
		}
	}
	for _, remote := range []string{
		"https://example.com/Ambiguous-Interactive/DoxReloaded.git",
		"https://github.com/Ambiguous-Interactive/other.git",
		"https://token@github.com/Ambiguous-Interactive/DoxReloaded.git",
	} {
		if canonicalRemote(remote, "Ambiguous-Interactive/DoxReloaded") {
			t.Fatalf("accepted noncanonical remote %q", remote)
		}
	}
}
