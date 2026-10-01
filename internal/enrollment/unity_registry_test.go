package enrollment

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
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
		SchemaVersion:            1,
		Organization:             UnityEnrollmentOrganization,
		ApprovedLockSHAs:         []string{testSHA},
		ApprovedReturnSHAs:       []string{},
		ApprovedDarwinReturnSHAs: []string{},
		Repositories:             repositories,
		Exceptions:               []UnityPolicyException{},
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
		{"mutable darwin return", func(value *UnityEnrollmentRegistry) {
			value.ApprovedReturnSHAs = []string{testSHA}
			value.ApprovedDarwinReturnSHAs = []string{"main"}
		}},
		{"duplicate darwin return", func(value *UnityEnrollmentRegistry) {
			value.ApprovedReturnSHAs = []string{testSHA}
			value.ApprovedDarwinReturnSHAs = []string{testSHA, testSHA}
		}},
		{"darwin return not return-approved", func(value *UnityEnrollmentRegistry) {
			value.ApprovedLockSHAs = []string{testSHA, strings.Repeat("b", 40)}
			value.ApprovedReturnSHAs = []string{testSHA}
			value.ApprovedDarwinReturnSHAs = []string{strings.Repeat("b", 40)}
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

func TestUnityEnrollmentRegistryRetainsDarwinReturnAuthorization(t *testing.T) {
	registry := validUnityRegistry()
	registry.ApprovedReturnSHAs = []string{testSHA}
	registry.ApprovedDarwinReturnSHAs = []string{testSHA}
	parsed, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, registry))
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.ApprovedDarwinReturnSHAs) != 1 || parsed.ApprovedDarwinReturnSHAs[0] != testSHA {
		t.Fatalf("darwin return authorization was not retained: %#v", parsed.ApprovedDarwinReturnSHAs)
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

func TestUnityEnrollmentRegistryRetainsValidRepinException(t *testing.T) {
	registry := validUnityRegistry()
	registry.RepinExceptions = []UnityRepinException{{
		Repository: "Ambiguous-Interactive/unity-helpers",
		Path:       ".github/workflows/legacy-return.yml",
		Reason:     "The wrapper cannot supply the return-log-digest input.",
		Owner:      "unity-helpers-maintainers",
		ExpiresAt:  "2099-01-01T00:00:00Z",
	}}
	parsed, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, registry))
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.RepinExceptions) != 1 || parsed.RepinExceptions[0].Path != ".github/workflows/legacy-return.yml" {
		t.Fatalf("repin exception was not retained: %#v", parsed.RepinExceptions)
	}
}

func TestUnityEnrollmentRegistryRejectsInvalidRepinException(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*UnityRepinException)
	}{
		{"unregistered repository", func(value *UnityRepinException) {
			value.Repository = "Ambiguous-Interactive/not-enrolled"
		}},
		{"non-canonical repository", func(value *UnityRepinException) {
			value.Repository = "Ambiguous-Interactive/UNITY-HELPERS"
		}},
		{"path outside workflows", func(value *UnityRepinException) {
			value.Path = "scripts/legacy-return.yml"
		}},
		{"non-yaml path", func(value *UnityRepinException) {
			value.Path = ".github/workflows/legacy-return.json"
		}},
		{"nested workflow path", func(value *UnityRepinException) {
			value.Path = ".github/workflows/nested/legacy-return.yml"
		}},
		{"escaping path", func(value *UnityRepinException) {
			value.Path = ".github/workflows/../legacy-return.yml"
		}},
		{"multiline path", func(value *UnityRepinException) {
			value.Path = ".github/workflows/legacy\n-return.yml"
		}},
		{"backtick path", func(value *UnityRepinException) {
			value.Path = ".github/workflows/leg`acy-return.yml"
		}},
		{"missing owner", func(value *UnityRepinException) {
			value.Owner = " "
		}},
		{"multiline owner", func(value *UnityRepinException) {
			value.Owner = "owner\nsecond-line"
		}},
		{"backtick owner", func(value *UnityRepinException) {
			value.Owner = "`owner`"
		}},
		{"missing reason", func(value *UnityRepinException) {
			value.Reason = ""
		}},
		{"multiline reason", func(value *UnityRepinException) {
			value.Reason = "line one\nline two"
		}},
		{"invalid expiry", func(value *UnityRepinException) {
			value.ExpiresAt = "2026-09-07"
		}},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			registry := validUnityRegistry()
			registry.RepinExceptions = []UnityRepinException{{
				Repository: "Ambiguous-Interactive/unity-helpers",
				Path:       ".github/workflows/legacy-return.yml",
				Reason:     "The wrapper cannot supply the return-log-digest input.",
				Owner:      "unity-helpers-maintainers",
				ExpiresAt:  "2099-01-01T00:00:00Z",
			}}
			testCase.mutate(&registry.RepinExceptions[0])
			if _, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, registry)); err == nil {
				t.Fatalf("invalid repin exception %q passed", testCase.name)
			}
		})
	}
}

func TestUnityEnrollmentRegistryRejectsDuplicateRepinException(t *testing.T) {
	registry := validUnityRegistry()
	entry := UnityRepinException{
		Repository: "Ambiguous-Interactive/unity-helpers",
		Path:       ".github/workflows/legacy-return.yml",
		Reason:     "The wrapper cannot supply the return-log-digest input.",
		Owner:      "unity-helpers-maintainers",
		ExpiresAt:  "2099-01-01T00:00:00Z",
	}
	registry.RepinExceptions = []UnityRepinException{entry, entry}
	if _, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, registry)); err == nil {
		t.Fatal("duplicate repin exception passed")
	}
	second := entry
	second.Path = ".github/workflows/other.yml"
	registry.RepinExceptions = []UnityRepinException{entry, second}
	if _, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, registry)); err != nil {
		t.Fatalf("distinct repin exceptions failed: %v", err)
	}
}

func TestUnityEnrollmentRegistryRetainsValidRepinCompanions(t *testing.T) {
	registry := validUnityRegistry()
	registry.RepinCompanions = []UnityRepinCompanion{
		{
			Repository: "Ambiguous-Interactive/DxMessaging",
			Path:       "docs/ops/ci-and-github-settings.md",
			Mode:       "pin-lines",
		},
		{
			Repository: "Ambiguous-Interactive/IshoBoy",
			Path:       "scripts/build_lock_policy.json",
			Mode:       "policy-snapshot",
		},
		{
			Repository: "Ambiguous-Interactive/qora-redux",
			Path:       "tests/ci/unity-workflow-contract.test.mjs",
			Mode:       "pin-literal",
		},
		{
			// The shapes a consumer that keeps its pins under `.github/` uses.
			// The workflow pin rewrite selects YAML by name, so nothing else
			// writes these and this rewrite is their only writer.
			Repository: "Ambiguous-Interactive/DoxReloaded",
			Path:       ".github/lock-action-pins.json",
			Mode:       "pin-literal",
		},
		{
			Repository: "Ambiguous-Interactive/DoxReloaded",
			Path:       ".github/scripts/test-central-unity-cleanup-policy.cjs",
			Mode:       "pin-literal",
		},
	}
	parsed, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, registry))
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.RepinCompanions) != 5 {
		t.Fatalf("repin companions were not retained: %#v", parsed.RepinCompanions)
	}
}

func TestUnityEnrollmentRegistryRejectsInvalidRepinCompanion(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*UnityRepinCompanion)
	}{
		{"unregistered repository", func(value *UnityRepinCompanion) {
			value.Repository = "Ambiguous-Interactive/not-enrolled"
		}},
		{"non-canonical repository", func(value *UnityRepinCompanion) {
			value.Repository = "Ambiguous-Interactive/DXMESSAGING"
		}},
		{"a .github YAML companion", func(value *UnityRepinCompanion) {
			value.Path = ".github/pin-reference.yml"
		}},
		{"a .github YAML companion with an uppercase extension", func(value *UnityRepinCompanion) {
			value.Path = ".github/pin-reference.YAML"
		}},
		{"a trailing slash", func(value *UnityRepinCompanion) {
			value.Path = "docs/pin-reference/"
		}},
		{"a .github trailing slash", func(value *UnityRepinCompanion) {
			value.Path = ".github/"
		}},
		{"a .github workflow", func(value *UnityRepinCompanion) {
			value.Path = ".github/workflows/unity.yml"
		}},
		{"the .github directory itself", func(value *UnityRepinCompanion) {
			value.Path = ".github"
		}},
		{"nul in path", func(value *UnityRepinCompanion) {
			value.Path = "docs/pin\x00reference.md"
		}},
		{"tab in path", func(value *UnityRepinCompanion) {
			value.Path = "docs/pin\treference.md"
		}},
		{"escaping path", func(value *UnityRepinCompanion) {
			value.Path = "docs/../secrets.txt"
		}},
		{"non-normalized path", func(value *UnityRepinCompanion) {
			value.Path = "docs/./pin-reference.md"
		}},
		{"absolute path", func(value *UnityRepinCompanion) {
			value.Path = "/docs/pin-reference.md"
		}},
		{"windows path", func(value *UnityRepinCompanion) {
			value.Path = `docs\pin-reference.md`
		}},
		{"option-like path", func(value *UnityRepinCompanion) {
			value.Path = "-docs/pin-reference.md"
		}},
		{"backtick path", func(value *UnityRepinCompanion) {
			value.Path = "docs/pin`-reference.md"
		}},
		{"multiline path", func(value *UnityRepinCompanion) {
			value.Path = "docs/pin\n-reference.md"
		}},
		{"unknown mode", func(value *UnityRepinCompanion) {
			value.Mode = "rewrite-everything"
		}},
		{"empty mode", func(value *UnityRepinCompanion) {
			value.Mode = ""
		}},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			registry := validUnityRegistry()
			registry.RepinCompanions = []UnityRepinCompanion{{
				Repository: "Ambiguous-Interactive/DxMessaging",
				Path:       "docs/ops/ci-and-github-settings.md",
				Mode:       "pin-lines",
			}}
			testCase.mutate(&registry.RepinCompanions[0])
			if _, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, registry)); err == nil {
				t.Fatalf("invalid repin companion %q passed", testCase.name)
			}
		})
	}
}

func TestUnityEnrollmentRegistryRejectsDuplicateRepinCompanion(t *testing.T) {
	registry := validUnityRegistry()
	entry := UnityRepinCompanion{
		Repository: "Ambiguous-Interactive/DxMessaging",
		Path:       "docs/ops/ci-and-github-settings.md",
		Mode:       "pin-lines",
	}
	registry.RepinCompanions = []UnityRepinCompanion{entry, entry}
	if _, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, registry)); err == nil {
		t.Fatal("duplicate repin companion passed")
	}
	second := entry
	second.Path = "docs/ops/ambiguous-release-migration.md"
	registry.RepinCompanions = []UnityRepinCompanion{entry, second}
	if _, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, registry)); err != nil {
		t.Fatalf("distinct repin companion paths failed: %v", err)
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

func TestUnityEnrollmentRegistryValidatesRequiredContexts(t *testing.T) {
	registry := validUnityRegistry()
	for index := range registry.Repositories {
		registry.Repositories[index].RequiredContexts = []string{"Unity CI Success"}
	}
	parsed, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, registry))
	if err != nil {
		t.Fatalf("valid required contexts failed: %v", err)
	}
	for _, repository := range parsed.Repositories {
		if len(repository.RequiredContexts) != 1 ||
			repository.RequiredContexts[0] != "Unity CI Success" {
			t.Fatalf("required contexts were not retained: %#v", repository.RequiredContexts)
		}
	}
	tests := []struct {
		name     string
		contexts []string
	}{
		{name: "blank context", contexts: []string{""}},
		{name: "untrimmed context", contexts: []string{" Unity CI Success"}},
		{name: "multiline context", contexts: []string{"Unity CI\nSuccess"}},
		{name: "tab context", contexts: []string{"Unity\tCI Success"}},
		{name: "duplicate context", contexts: []string{"Unity CI Success", "Unity CI Success"}},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			invalid := validUnityRegistry()
			invalid.Repositories[0].RequiredContexts = testCase.contexts
			if _, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, invalid)); err == nil {
				t.Fatal("invalid required contexts passed")
			}
		})
	}
}

func TestUnityEnrollmentRegistryCapsRequiredContexts(t *testing.T) {
	registry := validUnityRegistry()
	contexts := make([]string, 0, 33)
	for index := 0; index <= 32; index++ {
		contexts = append(contexts, fmt.Sprintf("Context %d", index))
	}
	registry.Repositories[0].RequiredContexts = contexts
	if _, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, registry)); err == nil {
		t.Fatal("too many required contexts passed")
	}
	registry.Repositories[0].RequiredContexts = contexts[:32]
	if _, err := ParseUnityEnrollmentRegistry(encodeRegistry(t, registry)); err != nil {
		t.Fatalf("bounded required contexts failed: %v", err)
	}
}

// encoding/json replaces a byte it cannot decode with U+FFFD rather than
// failing, so a policy that is not valid UTF-8 would otherwise be evaluated as
// a value the repository never wrote. Every reviewed field class is refused by
// name, so an operator is never sent to fix a spelling the file does not
// contain.
func TestUnityEnrollmentRegistryRejectsContentThatIsNotValidUTF8(t *testing.T) {
	registry := validUnityRegistry()
	registry.Exceptions = []UnityPolicyException{{
		Repository:     "Ambiguous-Interactive/unity-builder",
		Path:           ".github/workflows/unity.yml",
		Classification: UnityInventorySynthetic,
		Owner:          "unity-builder-maintainers",
		ExpiresAt:      "2099-01-01T00:00:00Z",
	}}
	registry.RepinExceptions = []UnityRepinException{{
		Repository: "Ambiguous-Interactive/unity-builder",
		Path:       ".github/workflows/repin-protected.yml",
		Reason:     "wrapper cannot supply the newest input contract",
		Owner:      "unity-builder-maintainers",
		ExpiresAt:  "2099-01-01T00:00:00Z",
	}}
	registry.RepinCompanions = []UnityRepinCompanion{{
		Repository: "Ambiguous-Interactive/unity-builder",
		Path:       ".github/unity-lock.json",
		Mode:       "pin-lines",
	}}
	for index := range registry.Repositories {
		registry.Repositories[index].RequiredContexts = []string{"CI Success"}
	}
	content := encodeRegistry(t, registry)
	// parsesAfterSubstitution records what the same file does when the byte is
	// the three bytes a decoder substitutes for it. No validator inspects the
	// free-text bytes, so those rows still parse and the audit decides from
	// text nobody wrote. Every other row has a validator, so the guard there
	// only names the real cause. Both directions are asserted, so a validator
	// that later stops rejecting a field cannot make a row quietly wrong.
	fields := map[string]struct {
		fragment                string
		parsesAfterSubstitution bool
	}{
		"organization":           {`"organization":"Ambiguous-Interactive"`, false},
		"repository":             {`"repository":"Ambiguous-Interactive/DoxReloaded"`, false},
		"default branch":         {`"defaultBranch":"master"`, false},
		"required context":       {`"requiredContexts":["CI Success"`, false},
		"approved lock SHA":      {`"approvedLockShas":["` + testSHA + `"`, false},
		"exception owner":        {`"owner":"unity-builder-maintainers"`, true},
		"repin exception reason": {`"reason":"wrapper cannot supply the newest input contract"`, true},
		"companion path":         {`"path":".github/unity-lock.json"`, true},
	}
	for name, field := range fields {
		t.Run(name, func(t *testing.T) {
			corrupted := oneRawByteIn(t, content, field.fragment)
			_, err := ParseUnityEnrollmentRegistry(corrupted)
			if err == nil || !strings.Contains(err.Error(), "not valid UTF-8") {
				t.Fatalf("error = %v, want a named UTF-8 refusal", err)
			}
			_, substitutedErr := ParseUnityEnrollmentRegistry(withSubstitutedByte(corrupted))
			if field.parsesAfterSubstitution != (substitutedErr == nil) {
				t.Fatalf("substituted form error = %v, want parse = %t", substitutedErr, field.parsesAfterSubstitution)
			}
		})
	}
}

// oneRawByteIn splices one 0xFF byte into the last string of a JSON fragment,
// so the file stays valid JSON and only a strict decode can refuse it.
func oneRawByteIn(t *testing.T, content []byte, fragment string) []byte {
	t.Helper()
	if !bytes.Contains(content, []byte(fragment)) {
		t.Fatalf("fixture %q is missing from the encoded registry", fragment)
	}
	corrupted := bytes.Replace(
		content,
		[]byte(fragment),
		[]byte(fragment[:len(fragment)-1]+"\xff"+`"`),
		1,
	)
	if utf8.Valid(corrupted) {
		t.Fatal("the corrupted fixture is still valid UTF-8, so the test proves nothing")
	}
	if !json.Valid(corrupted) {
		t.Fatal("the corrupted fixture is not valid JSON, so it proves nothing about the encoding")
	}
	return corrupted
}

// withSubstitutedByte replaces the one raw byte with the three bytes a decoder
// substitutes for it.
func withSubstitutedByte(corrupted []byte) []byte {
	return bytes.Replace(corrupted, []byte{0xff}, []byte("�"), 1)
}
