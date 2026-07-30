package enrollment

import (
	"encoding/json"
	"strings"
	"testing"
)

func validUnityRegistry() UnityEnrollmentRegistry {
	repositories := make([]UnityEnrollmentRepository, 0, len(minimumUnityEnrollmentRepositories))
	for repository, fork := range minimumUnityEnrollmentRepositories {
		branch := "main"
		if repository == "Ambiguous-Interactive/DxMessaging" {
			branch = "master"
		}
		repositories = append(repositories, UnityEnrollmentRepository{
			Repository:            repository,
			DefaultBranch:         branch,
			Fork:                  fork,
			AllowWorkflowDispatch: true,
		})
	}
	return UnityEnrollmentRegistry{
		SchemaVersion:      1,
		Organization:       UnityEnrollmentOrganization,
		ApprovedLockSHAs:   []string{testSHA},
		ApprovedReturnSHAs: []string{},
		Repositories:       repositories,
		Exceptions:         []UnityPolicyException{},
	}
}

func encodeRegistry(t *testing.T, registry UnityEnrollmentRegistry) []byte {
	t.Helper()
	content, err := json.Marshal(registry)
	if err != nil {
		t.Fatal(err)
	}
	return content
}

func TestUnityEnrollmentRegistryRequiresBaselineRepositorySet(t *testing.T) {
	registry := validUnityRegistry()
	parsed, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, registry))
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Repositories) != 6 {
		t.Fatalf("got %d repositories", len(parsed.Repositories))
	}
	foundFork := false
	for _, repository := range parsed.Repositories {
		if repository.Repository == "Ambiguous-Interactive/unity-builder" {
			foundFork = repository.Fork
		}
	}
	if !foundFork {
		t.Fatal("unity-builder fork classification was not retained")
	}

	tests := []struct {
		name   string
		mutate func(*UnityEnrollmentRegistry)
	}{
		{"missing", func(value *UnityEnrollmentRegistry) { value.Repositories = value.Repositories[1:] }},
		{"duplicate", func(value *UnityEnrollmentRegistry) { value.Repositories[1] = value.Repositories[0] }},
		{"case-insensitive duplicate", func(value *UnityEnrollmentRegistry) {
			value.Repositories[1] = value.Repositories[0]
			parts := strings.SplitN(value.Repositories[0].Repository, "/", 2)
			value.Repositories[1].Repository = parts[0] + "/" + strings.ToUpper(parts[1])
		}},
		{"replacement case with false fork", func(value *UnityEnrollmentRegistry) {
			for index := range value.Repositories {
				if value.Repositories[index].Repository == "Ambiguous-Interactive/unity-builder" {
					value.Repositories[index].Repository = "Ambiguous-Interactive/UNITY-BUILDER"
					value.Repositories[index].Fork = false
				}
			}
		}},
		{"fork mismatch", func(value *UnityEnrollmentRegistry) {
			for index := range value.Repositories {
				if value.Repositories[index].Repository == "Ambiguous-Interactive/unity-builder" {
					value.Repositories[index].Fork = false
				}
			}
		}},
		{"mutable lock", func(value *UnityEnrollmentRegistry) { value.ApprovedLockSHAs = []string{"main"} }},
		{"mutable return", func(value *UnityEnrollmentRegistry) {
			value.ApprovedReturnSHAs = []string{"main"}
		}},
		{"return not approved globally", func(value *UnityEnrollmentRegistry) {
			value.ApprovedReturnSHAs = []string{strings.Repeat("b", 40)}
		}},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			candidate := validUnityRegistry()
			testCase.mutate(&candidate)
			if _, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, candidate)); err == nil {
				t.Fatal("invalid registry passed")
			}
		})
	}
}

func TestUnityEnrollmentRegistryAcceptsReviewedOrganizationExpansion(t *testing.T) {
	registry := validUnityRegistry()
	registry.Repositories = append(registry.Repositories, UnityEnrollmentRepository{
		Repository:            "Ambiguous-Interactive/future-unity-project",
		DefaultBranch:         "develop/unity",
		AllowWorkflowDispatch: true,
	})
	parsed, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, registry))
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Repositories) != 7 {
		t.Fatalf("got %d repositories", len(parsed.Repositories))
	}
}

func TestAddUnityEnrollmentRepositoryValidatesAndSorts(t *testing.T) {
	registry := validUnityRegistry()
	added, err := AddUnityEnrollmentRepository(registry, UnityEnrollmentRepository{
		Repository:            "Ambiguous-Interactive/AnotherUnityProject",
		DefaultBranch:         "main",
		AllowWorkflowDispatch: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(registry.Repositories) != 6 {
		t.Fatal("input registry was mutated")
	}
	if added.Repositories[0].Repository != "Ambiguous-Interactive/AnotherUnityProject" {
		t.Fatalf("registry was not sorted: %#v", added.Repositories)
	}
	if _, err := AddUnityEnrollmentRepository(added, UnityEnrollmentRepository{
		Repository:    "Ambiguous-Interactive/anotherunityproject",
		DefaultBranch: "main",
	}); err == nil {
		t.Fatal("case-insensitive duplicate repository passed")
	}
	if _, err := AddUnityEnrollmentRepository(registry, UnityEnrollmentRepository{
		Repository:    "Outside-Organization/project",
		DefaultBranch: "main",
	}); err == nil {
		t.Fatal("outside-organization repository passed")
	}
}

func TestUnityEnrollmentRegistryRejectsInvalidGitBranches(t *testing.T) {
	invalid := []string{
		"feature/", "feature//unity", "feature/.hidden", "feature/cache.lock",
		"feature/../unity", "feature@{unity", "-danger", "@", "feature.",
		"feature\x00unity", "feature\x1funity", "feature\x7funity",
		"feature#candidate", "feature%2Fcandidate",
	}
	for _, branch := range invalid {
		t.Run(strings.ReplaceAll(branch, "/", "_"), func(t *testing.T) {
			registry := validUnityRegistry()
			registry.Repositories[0].DefaultBranch = branch
			if _, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, registry)); err == nil {
				t.Fatalf("invalid branch %q passed", branch)
			}
		})
	}
	for _, branch := range []string{"main", "develop/unity", "release-1.2", "feature/@name"} {
		t.Run("valid_"+strings.ReplaceAll(branch, "/", "_"), func(t *testing.T) {
			registry := validUnityRegistry()
			registry.Repositories[0].DefaultBranch = branch
			if _, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, registry)); err != nil {
				t.Fatalf("valid branch %q failed: %v", branch, err)
			}
		})
	}
}

func TestUnityEnrollmentRegistryRequiresCanonicalExceptionRepository(t *testing.T) {
	registry := validUnityRegistry()
	registry.Exceptions = []UnityPolicyException{{
		Repository:     "Ambiguous-Interactive/DOXRELOADED",
		Path:           ".github/workflows/unity.yml",
		Classification: "synthetic",
		Owner:          "unity-platform",
		ExpiresAt:      "2026-08-27T00:00:00Z",
	}}
	if _, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, registry)); err == nil {
		t.Fatal("case-mismatched exception repository passed")
	}
}

func TestUnityEnrollmentRegistryRejectsUnknownAndTrailingJSON(t *testing.T) {
	content := encodeRegistry(t, validUnityRegistry())
	withUnknown := strings.Replace(string(content), `"schemaVersion":1`, `"schemaVersion":1,"unknown":true`, 1)
	if _, err := ParseUnityEnrollmentRegistry([]byte(withUnknown)); err == nil {
		t.Fatal("unknown field passed")
	}
	if _, err := ParseUnityEnrollmentRegistry(append(content, []byte(` {}`)...)); err == nil {
		t.Fatal("trailing JSON passed")
	}
}
