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

func TestRunReadsOnlyRegularManifestGitObject(t *testing.T) {
	manifest := make(map[string]string, len(enrollment.ConsumerPolicyRepositories))
	for _, entry := range enrollment.ConsumerPolicyRepositories {
		manifest[entry.Repository] = "0123456789abcdef0123456789abcdef01234567"
	}
	content, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}

	for _, testCase := range []struct {
		name string
		mode string
		want int
	}{
		{name: "regular blob", mode: "100644", want: 0},
		{name: "executable blob", mode: "100755", want: 2},
		{name: "symbolic link", mode: "120000", want: 2},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			repository, sha := manifestCommit(t, testCase.mode, content)
			output := filepath.Join(t.TempDir(), "github-output")
			if err := os.WriteFile(output, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			var stdout bytes.Buffer
			var stderr bytes.Buffer
			got := run([]string{"--git-dir", filepath.Join(repository, ".git"), "--sha", sha, "--github-output", output}, &stdout, &stderr)
			if got != testCase.want {
				t.Fatalf("exit = %d, want %d; stderr=%s", got, testCase.want, stderr.String())
			}
			if testCase.want == 0 {
				written, err := os.ReadFile(output)
				if err != nil {
					t.Fatal(err)
				}
				for _, entry := range enrollment.ConsumerPolicyRepositories {
					if !strings.Contains(string(written), entry.Output+"=") {
						t.Fatalf("missing output %s", entry.Output)
					}
				}
			}
		})
	}
}

func TestRunRejectsInvalidRevisionAndOversizeBlob(t *testing.T) {
	output := filepath.Join(t.TempDir(), "github-output")
	if err := os.WriteFile(output, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if got := run([]string{"--git-dir", t.TempDir(), "--sha", strings.Repeat("-", 40), "--github-output", output}, &stdout, &stderr); got != 2 {
		t.Fatalf("invalid revision exit = %d, want 2", got)
	}

	repository, sha := manifestCommit(t, "100644", bytes.Repeat([]byte{'x'}, enrollment.MaxConsumerPolicyManifestBytes+1))
	stdout.Reset()
	stderr.Reset()
	if got := run([]string{"--git-dir", filepath.Join(repository, ".git"), "--sha", sha, "--github-output", output}, &stdout, &stderr); got != 2 {
		t.Fatalf("oversize blob exit = %d, want 2", got)
	}
	if strings.Contains(stderr.String(), strings.Repeat("x", 32)) {
		t.Fatal("oversize blob content leaked through diagnostics")
	}

	tree := strings.TrimSpace(gitCommand(t, repository, nil, "rev-parse", sha+"^{tree}"))
	stdout.Reset()
	stderr.Reset()
	if got := run([]string{"--git-dir", filepath.Join(repository, ".git"), "--sha", tree, "--github-output", output}, &stdout, &stderr); got != 2 {
		t.Fatalf("tree object exit = %d, want 2", got)
	}
	if !strings.Contains(stderr.String(), "exact Git commit") {
		t.Fatalf("tree object diagnostic = %q", stderr.String())
	}
}

func manifestCommit(t *testing.T, mode string, content []byte) (string, string) {
	t.Helper()
	repository := t.TempDir()
	gitCommand(t, repository, nil, "init", "-q")
	gitCommand(t, repository, nil, "config", "user.name", "Policy Test")
	gitCommand(t, repository, nil, "config", "user.email", "policy@example.invalid")
	object := strings.TrimSpace(gitCommand(t, repository, content, "hash-object", "-w", "--stdin"))
	gitCommand(t, repository, nil, "update-index", "--add", "--cacheinfo", mode+","+object+",consumer-policy.json")
	tree := strings.TrimSpace(gitCommand(t, repository, nil, "write-tree"))
	sha := strings.TrimSpace(gitCommand(t, repository, []byte("fixture\n"), "commit-tree", tree))
	return repository, sha
}

func gitCommand(t *testing.T, repository string, stdin []byte, arguments ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", repository}, arguments...)...)
	command.Stdin = bytes.NewReader(stdin)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", arguments, err, output)
	}
	return string(output)
}
