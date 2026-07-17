package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const integrationSHA = "0123456789abcdef0123456789abcdef01234567"

func TestRunExitCodesAndOutput(t *testing.T) {
	tests := []struct {
		name       string
		workflow   string
		wantExit   int
		wantOutput string
		wantError  string
	}{
		{name: "clean", workflow: "jobs: {}\n", wantExit: 0, wantOutput: `"findings":[]`},
		{
			name:       "policy findings",
			workflow:   "concurrency: { group: unity, cancel-in-progress: true }\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@" + integrationSHA + "\n",
			wantExit:   1,
			wantOutput: `"Code":"unsafe-workflow-cancellation"`,
		},
		{name: "analyzer error", workflow: "jobs: {}\njobs: {}\n", wantExit: 2, wantError: "duplicate key"},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			repositoryRoot, sha := integrationRepository(t, testCase.workflow)
			var stdout, stderr bytes.Buffer
			exitCode := run([]string{
				"--git-dir", repositoryRoot,
				"--repository", "Ambiguous-Interactive/fixture",
				"--sha", sha,
			}, &stdout, &stderr)
			if exitCode != testCase.wantExit {
				t.Fatalf("exit code %d, want %d; stdout=%s stderr=%s", exitCode, testCase.wantExit, stdout.String(), stderr.String())
			}
			if testCase.wantOutput != "" && !strings.Contains(stdout.String(), testCase.wantOutput) {
				t.Fatalf("stdout %q does not contain %q", stdout.String(), testCase.wantOutput)
			}
			if testCase.wantError != "" && !strings.Contains(stderr.String(), testCase.wantError) {
				t.Fatalf("stderr %q does not contain %q", stderr.String(), testCase.wantError)
			}
		})
	}
}

func TestRunRequiredGuardPolicy(t *testing.T) {
	repositoryRoot, sha := integrationRepository(t,
		"on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@"+integrationSHA+"\n")
	var stdout, stderr bytes.Buffer
	exitCode := run([]string{
		"--git-dir", repositoryRoot,
		"--repository", "Ambiguous-Interactive/fixture",
		"--sha", sha,
		"--required-guard-sha", integrationSHA,
	}, &stdout, &stderr)
	if exitCode != 1 || !strings.Contains(stdout.String(), `"Code":"missing-initial-current-head-guard"`) {
		t.Fatalf("expected missing guard finding; exit=%d stdout=%s stderr=%s", exitCode, stdout.String(), stderr.String())
	}

	stdout.Reset()
	stderr.Reset()
	exitCode = run([]string{
		"--git-dir", repositoryRoot,
		"--repository", "Ambiguous-Interactive/fixture",
		"--sha", sha,
		"--required-guard-sha", "main",
	}, &stdout, &stderr)
	if exitCode != 2 || !strings.Contains(stderr.String(), "required guard SHA") {
		t.Fatalf("expected invalid guard SHA error; exit=%d stdout=%s stderr=%s", exitCode, stdout.String(), stderr.String())
	}
}

func integrationRepository(t *testing.T, workflow string) (string, string) {
	t.Helper()
	repositoryRoot := t.TempDir()
	integrationGit(t, repositoryRoot, "init", "-q")
	integrationGit(t, repositoryRoot, "config", "user.name", "Policy Test")
	integrationGit(t, repositoryRoot, "config", "user.email", "policy@example.invalid")
	workflowPath := filepath.Join(repositoryRoot, ".github", "workflows", "fixture.yml")
	if err := os.MkdirAll(filepath.Dir(workflowPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(workflowPath, []byte(workflow), 0o600); err != nil {
		t.Fatal(err)
	}
	integrationGit(t, repositoryRoot, "add", ".github/workflows/fixture.yml")
	integrationGit(t, repositoryRoot, "commit", "-q", "-m", "fixture")
	return repositoryRoot, integrationGit(t, repositoryRoot, "rev-parse", "HEAD")
}

func integrationGit(t *testing.T, repositoryRoot string, arguments ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", repositoryRoot}, arguments...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", arguments, err, output)
	}
	return strings.TrimSpace(string(output))
}
