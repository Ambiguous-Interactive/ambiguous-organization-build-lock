package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
