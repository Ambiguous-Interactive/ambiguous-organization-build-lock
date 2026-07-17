package enrollment

import (
	"context"
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
	if err := os.MkdirAll(filepath.Dir(workflowPath), 0o755); err != nil {
		t.Fatal(err)
	}
	unsafe := workflow("concurrency: { group: fixture, cancel-in-progress: true }\n", "", directAcquireStep())
	if err := os.WriteFile(workflowPath, []byte(unsafe), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repositoryRoot, "add", ".github/workflows/unity.yml")
	runGit(t, repositoryRoot, "commit", "-q", "-m", "unsafe")
	unsafeSHA := runGit(t, repositoryRoot, "rev-parse", "HEAD")

	safe := workflow("concurrency: { group: fixture, cancel-in-progress: false }\n", "", directAcquireStep())
	if err := os.WriteFile(workflowPath, []byte(safe), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repositoryRoot, "commit", "-q", "-am", "safe")
	safeSHA := runGit(t, repositoryRoot, "rev-parse", "HEAD")

	for _, testCase := range []struct {
		name         string
		sha          string
		wantFindings int
	}{
		{name: "older unsafe commit", sha: unsafeSHA, wantFindings: 1},
		{name: "newer safe commit", sha: safeSHA, wantFindings: 0},
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
		})
	}
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
