package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/enrollment"
)

func TestRunAddsValidatedRepository(t *testing.T) {
	root := t.TempDir()
	policyPath := filepath.Join(root, "policy.json")
	content, err := os.ReadFile("../../unity-enrollment-policy.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(policyPath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	exit := run([]string{
		"--policy", policyPath,
		"--repository", "Ambiguous-Interactive/NewUnityGame",
		"--default-branch", "develop/unity",
		"--fork=true",
		"--allow-workflow-dispatch=true",
	}, &stdout, &stderr)
	if exit != 0 {
		t.Fatalf("got exit %d\nstdout=%s\nstderr=%s", exit, stdout.String(), stderr.String())
	}
	updated, err := os.ReadFile(policyPath)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := enrollment.ParseUnityEnrollmentRegistry(updated)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, repository := range registry.Repositories {
		if repository.Repository == "Ambiguous-Interactive/NewUnityGame" {
			found = repository.DefaultBranch == "develop/unity" &&
				repository.Fork &&
				repository.AllowWorkflowDispatch
		}
	}
	if !found {
		t.Fatalf("new repository missing or incorrect: %#v", registry.Repositories)
	}
}

func TestRunRejectsInvalidOrDuplicateRepositoryWithoutChangingPolicy(t *testing.T) {
	for _, repository := range []string{
		"Outside-Organization/NewUnityGame",
		"Ambiguous-Interactive/DoxReloaded",
		"Ambiguous-Interactive/name with spaces",
	} {
		t.Run(repository, func(t *testing.T) {
			root := t.TempDir()
			policyPath := filepath.Join(root, "policy.json")
			before, err := os.ReadFile("../../unity-enrollment-policy.json")
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(policyPath, before, 0o600); err != nil {
				t.Fatal(err)
			}
			var stdout, stderr bytes.Buffer
			exit := run([]string{
				"--policy", policyPath,
				"--repository", repository,
				"--default-branch", "main",
			}, &stdout, &stderr)
			if exit != 2 || !strings.Contains(stderr.String(), "cannot onboard") {
				t.Fatalf("got exit %d\nstdout=%s\nstderr=%s", exit, stdout.String(), stderr.String())
			}
			after, err := os.ReadFile(policyPath)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(before, after) {
				t.Fatal("rejected onboarding changed the policy")
			}
		})
	}
}

func TestValidateOnlyRejectsWorkflowCommandInjectionWithoutChangingPolicy(t *testing.T) {
	root := t.TempDir()
	policyPath := filepath.Join(root, "policy.json")
	before, err := os.ReadFile("../../unity-enrollment-policy.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(policyPath, before, 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	exit := run([]string{
		"--policy", policyPath,
		"--repository", "Ambiguous-Interactive/NewUnityGame",
		"--default-branch", "main\nrepository_name=OtherRepo",
		"--validate-only",
	}, &stdout, &stderr)
	if exit != 2 || !strings.Contains(stderr.String(), "default branch is invalid") {
		t.Fatalf("got exit %d\nstdout=%s\nstderr=%s", exit, stdout.String(), stderr.String())
	}
	after, err := os.ReadFile(policyPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("validate-only injection changed the policy")
	}
}

// The registry is decoded from this file and encoded back into it, and
// encoding/json replaces a byte it cannot decode with U+FFFD instead of
// failing. The atomic replace then hides the destroyed byte inside a clean
// commit, so a policy that is not valid UTF-8 has to be refused before
// anything is parsed.
func TestRunRefusesAPolicyThatIsNotValidUTF8(t *testing.T) {
	root := t.TempDir()
	policyPath := filepath.Join(root, "policy.json")
	content, err := os.ReadFile("../../unity-enrollment-policy.json")
	if err != nil {
		t.Fatal(err)
	}
	// One raw byte inside the free-text owner a reviewed exception carries, so
	// the file is still JSON and only a strict decode can refuse it.
	before := bytes.Replace(
		content,
		[]byte(`"owner": "unity-builder-maintainers"`),
		append([]byte(`"owner": "unity-builder-`), 0xff, '"'),
		1,
	)
	if bytes.Equal(before, content) {
		t.Fatal("exception owner fixture is missing from the reviewed policy")
	}
	if utf8.Valid(before) {
		t.Fatal("fixture policy is valid UTF-8, so the test proves nothing")
	}
	if err := os.WriteFile(policyPath, before, 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	exit := run([]string{
		"--policy", policyPath,
		"--repository", "Ambiguous-Interactive/NewUnityGame",
		"--default-branch", "main",
	}, &stdout, &stderr)
	if exit != 2 || !strings.Contains(stderr.String(), "not valid UTF-8") {
		t.Fatalf("got exit %d\nstdout=%s\nstderr=%s", exit, stdout.String(), stderr.String())
	}
	after, err := os.ReadFile(policyPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("a refused onboarding rewrote the reviewed policy")
	}
}
