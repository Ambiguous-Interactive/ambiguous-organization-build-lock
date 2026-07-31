package enrollment

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitSnapshotStaysBoundToExactCommit(t *testing.T) {
	repositoryRoot := t.TempDir()
	runGit(t, repositoryRoot, "init", "-q")
	runGit(t, repositoryRoot, "config", "user.name", "Policy Test")
	runGit(t, repositoryRoot, "config", "user.email", "policy@example.invalid")

	workflowPath := filepath.Join(repositoryRoot, ".github", "workflows", "unity.yml")
	scriptPath := filepath.Join(repositoryRoot, "scripts", "unity", "editor-check.ps1")
	if err := os.MkdirAll(filepath.Dir(workflowPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(scriptPath), 0o755); err != nil {
		t.Fatal(err)
	}
	unsafe := workflow("concurrency: { group: fixture, cancel-in-progress: true }\n", "", directAcquireStep())
	if err := os.WriteFile(workflowPath, []byte(unsafe), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(scriptPath, []byte("ensure-editor.ps1 -CiManagedOnly\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repositoryRoot, "add", ".github/workflows/unity.yml", "scripts/unity/editor-check.ps1")
	runGit(t, repositoryRoot, "commit", "-q", "-m", "unsafe")
	unsafeSHA := runGit(t, repositoryRoot, "rev-parse", "HEAD")

	safe := workflow("concurrency: { group: fixture, cancel-in-progress: false }\n", "", directAcquireStep())
	if err := os.WriteFile(workflowPath, []byte(safe), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(scriptPath, []byte("ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repositoryRoot, "commit", "-q", "-am", "safe")
	safeSHA := runGit(t, repositoryRoot, "rev-parse", "HEAD")
	runGit(t, repositoryRoot, "replace", unsafeSHA, safeSHA)

	for _, testCase := range []struct {
		name         string
		sha          string
		wantFindings int
		wantScript   string
	}{
		{
			name:         "older unsafe commit",
			sha:          unsafeSHA,
			wantFindings: 1,
			wantScript:   "ensure-editor.ps1 -CiManagedOnly\n",
		},
		{
			name:         "newer safe commit",
			sha:          safeSHA,
			wantFindings: 0,
			wantScript:   "ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting\n",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			snapshot, err := LoadGitSnapshot(context.Background(), repositoryRoot, "Ambiguous-Interactive/fixture", testCase.sha)
			if err != nil {
				t.Fatal(err)
			}
			findings, err := AnalyzeCancellationSafety(snapshot)
			if err != nil {
				t.Fatal(err)
			}
			if len(findings) != testCase.wantFindings {
				t.Fatalf("got %d findings, want %d: %#v", len(findings), testCase.wantFindings, findings)
			}
			if got := string(snapshot.Files["scripts/unity/editor-check.ps1"]); got != testCase.wantScript {
				t.Fatalf("script snapshot = %q, want %q", got, testCase.wantScript)
			}
		})
	}
}

func TestGitSnapshotRejectsOversizedPolicyBlob(t *testing.T) {
	repositoryRoot := initializeSnapshotRepository(t)
	scriptPath := filepath.Join(repositoryRoot, "scripts", "oversized.ps1")
	if err := os.MkdirAll(filepath.Dir(scriptPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		scriptPath,
		bytes.Repeat([]byte{'x'}, maxPolicySnapshotFileBytes+1),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	runGit(t, repositoryRoot, "add", "scripts/oversized.ps1")
	runGit(t, repositoryRoot, "commit", "-q", "-m", "oversized")
	sha := runGit(t, repositoryRoot, "rev-parse", "HEAD")

	_, err := LoadGitSnapshot(
		context.Background(),
		repositoryRoot,
		"Ambiguous-Interactive/fixture",
		sha,
	)
	if err == nil || !strings.Contains(err.Error(), "policy file scripts/oversized.ps1") {
		t.Fatalf("oversized policy blob error = %v", err)
	}
}

func TestGitSnapshotRejectsExcessivePolicyFileCount(t *testing.T) {
	repositoryRoot := initializeSnapshotRepository(t)
	scriptsRoot := filepath.Join(repositoryRoot, "scripts")
	if err := os.MkdirAll(scriptsRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	for index := 0; index <= maxPolicySnapshotFiles; index++ {
		scriptPath := filepath.Join(scriptsRoot, fmt.Sprintf("%03d.ps1", index))
		if err := os.WriteFile(scriptPath, []byte("# bounded fixture\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	runGit(t, repositoryRoot, "add", "scripts")
	runGit(t, repositoryRoot, "commit", "-q", "-m", "too many policy files")
	sha := runGit(t, repositoryRoot, "rev-parse", "HEAD")

	_, err := LoadGitSnapshot(
		context.Background(),
		repositoryRoot,
		"Ambiguous-Interactive/fixture",
		sha,
	)
	if err == nil || !strings.Contains(err.Error(), "policy-file limit") {
		t.Fatalf("excessive policy file count error = %v", err)
	}
}

func TestGitSnapshotRejectsExcessiveAggregatePolicyBytes(t *testing.T) {
	repositoryRoot := initializeSnapshotRepository(t)
	scriptsRoot := filepath.Join(repositoryRoot, "scripts")
	if err := os.MkdirAll(scriptsRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	content := bytes.Repeat([]byte{'x'}, maxPolicySnapshotFileBytes)
	for index := 0; index <= maxPolicySnapshotBytes/maxPolicySnapshotFileBytes; index++ {
		scriptPath := filepath.Join(scriptsRoot, fmt.Sprintf("%03d.ps1", index))
		if err := os.WriteFile(scriptPath, content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	runGit(t, repositoryRoot, "add", "scripts")
	runGit(t, repositoryRoot, "commit", "-q", "-m", "aggregate too large")
	sha := runGit(t, repositoryRoot, "rev-parse", "HEAD")

	_, err := LoadGitSnapshot(
		context.Background(),
		repositoryRoot,
		"Ambiguous-Interactive/fixture",
		sha,
	)
	if err == nil || !strings.Contains(err.Error(), "policy snapshot limit") {
		t.Fatalf("aggregate policy size error = %v", err)
	}
}

func initializeSnapshotRepository(t *testing.T) string {
	t.Helper()
	repositoryRoot := t.TempDir()
	runGit(t, repositoryRoot, "init", "-q")
	runGit(t, repositoryRoot, "config", "user.name", "Policy Test")
	runGit(t, repositoryRoot, "config", "user.email", "policy@example.invalid")
	return repositoryRoot
}

func runGit(t *testing.T, repositoryRoot string, arguments ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", repositoryRoot}, arguments...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", arguments, err, output)
	}
	return strings.TrimSpace(string(output))
}
