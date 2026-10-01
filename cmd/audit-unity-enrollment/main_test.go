package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/enrollment"
	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/jsonstrict"
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

// The audit is a fail-closed gate, and encoding/json replaces a byte it cannot
// decode with U+FFFD rather than failing. A policy that is not valid UTF-8 must
// never be reported as valid, and the run must name the encoding.
func TestRunRefusesAPolicyThatIsNotValidUTF8(t *testing.T) {
	policy, err := os.ReadFile("../../unity-enrollment-policy.json")
	if err != nil {
		t.Fatal(err)
	}
	// One raw byte inside the free-text owner a reviewed exception carries, so
	// the file is still JSON and only a strict decode can refuse it.
	corrupted := bytes.Replace(
		policy,
		[]byte(`"owner": "unity-builder-maintainers"`),
		append([]byte(`"owner": "unity-builder-`), 0xff, '"'),
		1,
	)
	if bytes.Equal(corrupted, policy) {
		t.Fatal("exception owner fixture is missing from the reviewed policy")
	}
	policyPath := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(policyPath, corrupted, 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	exit := run([]string{"--policy", policyPath, "--validate-policy-only"}, &stdout, &stderr)
	if exit != 2 || !strings.Contains(stderr.String(), "not valid UTF-8") {
		t.Fatalf("got exit %d\nstdout=%s\nstderr=%s", exit, stdout.String(), stderr.String())
	}
	if strings.Contains(stdout.String(), "policy is valid") {
		t.Fatalf("a refused policy was reported as valid: %s", stdout.String())
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

// The audit is a fail-closed gate. An escaped lone surrogate substitutes the
// same way an unreadable byte does and the encoding check cannot see it, so a
// policy carrying one must never be certified as valid.
func TestRunRefusesAPolicyWithAnEscapedLoneSurrogate(t *testing.T) {
	policy, err := os.ReadFile("../../unity-enrollment-policy.json")
	if err != nil {
		t.Fatal(err)
	}
	escaped := bytes.Replace(
		policy,
		[]byte(`"owner": "unity-builder-maintainers"`),
		[]byte(`"owner": "\ud800"`),
		1,
	)
	if bytes.Equal(escaped, policy) {
		t.Fatal("exception owner fixture is missing from the reviewed policy")
	}
	policyPath := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(policyPath, escaped, 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	exit := run([]string{"--policy", policyPath, "--validate-policy-only"}, &stdout, &stderr)
	if exit != 2 || !strings.Contains(stderr.String(), "lone surrogate") {
		t.Fatalf("got exit %d\nstdout=%s\nstderr=%s", exit, stdout.String(), stderr.String())
	}
	if strings.Contains(stdout.String(), "policy is valid") {
		t.Fatalf("a refused policy was reported as valid: %s", stdout.String())
	}
}

// The snapshot reader names the file it refused to read. A consumer otherwise
// has to search its own checkout for that file, so the cause must reach the
// artifact and the run summary.
//
// The two damage shapes matter separately. A raw byte in a script body is
// reported with %s, so the byte reaches the cause raw and the sanitizer has to
// map it. A raw byte in a tree path is reported with %s too, and git accepts
// such a name, so a second repository carries that shape. A test with only the
// first shape passes for a sanitizer that does nothing, because the script body
// is never named in the message.
func TestRunCarriesTheRetrievalCauseIntoTheArtifact(t *testing.T) {
	hostilePath := "scripts/unity/editor-\xff-check.ps1"
	cases := []struct {
		name     string
		damage   func(t *testing.T, repositoryRoot string)
		expected []string
	}{
		{
			name: "raw byte in a policy script body",
			damage: func(t *testing.T, repositoryRoot string) {
				script := filepath.Join(repositoryRoot, "scripts", "unity", "editor-check.ps1")
				if err := os.MkdirAll(filepath.Dir(script), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(
					script, []byte("ensure-editor.ps1 -CiManagedOnly\xff\n"), 0o600,
				); err != nil {
					t.Fatal(err)
				}
				runGit(t, repositoryRoot, "add", ".")
				runGit(t, repositoryRoot, "commit", "-m", "unreadable policy script")
			},
			expected: []string{
				"scripts/unity/editor-check.ps1",
				"is not valid UTF-8",
			},
		},
		{
			// A gitlink mode is not a regular blob, and the snapshot reader says
			// so with the raw name. The cause must carry '?' in place of the
			// byte, not the byte itself.
			name: "raw byte in a policy tree path",
			damage: func(t *testing.T, repositoryRoot string) {
				runGit(
					t, repositoryRoot, "update-index", "--add", "--cacheinfo",
					"160000,0000000000000000000000000000000000000001,"+hostilePath,
				)
				runGit(t, repositoryRoot, "commit", "-m", "unreadable policy path")
			},
			expected: []string{
				"scripts/unity/editor-?-check.ps1",
				"is not a regular blob",
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			root := t.TempDir()
			registry := testRegistry
			registry.RepinExceptions = nil
			policyPath := writeRegistryFixture(t, root, registry)
			outputPath := filepath.Join(root, "audit.json")
			for _, repository := range registry.Repositories {
				buildRepositoryFixture(t, root, repository, registry, nil)
			}
			damagedRepository := registry.Repositories[0].Repository
			testCase.damage(t, filepath.Join(root, repositoryName(damagedRepository)))

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
			if audit.Complete {
				t.Fatalf("an unreadable policy file must fail the audit closed: %s", content)
			}
			if len(audit.Findings) != 1 {
				t.Fatalf("want one finding, got %#v", audit.Findings)
			}
			finding := audit.Findings[0]
			if finding.Repository != damagedRepository ||
				finding.Code != "repository-retrieval-incomplete" {
				t.Fatalf("unexpected retrieval finding: %#v", finding)
			}
			if finding.Cause == "" {
				t.Fatalf("a retrieval finding without a cause sends the operator hunting: %#v", finding)
			}
			for _, expected := range testCase.expected {
				if !strings.Contains(finding.Cause, expected) {
					t.Fatalf("cause %q does not name %q", finding.Cause, expected)
				}
			}
			publishable := regexp.MustCompile("^[" + jsonstrict.CauseAlphabet + "]{0," +
				strconv.Itoa(jsonstrict.MaxCauseBytes) + "}$")
			if !publishable.MatchString(finding.Cause) {
				t.Fatalf("cause %q is outside the issue alphabet", finding.Cause)
			}
			// The cause replaces the provenance fields for a repository that could
			// not be read at all, so no field may claim a commit or a file this run
			// never established.
			if finding.Path != "" || finding.Job != "" || finding.SHA != "" {
				t.Fatalf("retrieval finding claims provenance it does not have: %#v", finding)
			}
			if !strings.Contains(stderr.String(), finding.Cause) {
				t.Fatalf("run summary does not carry the cause:\n%s", stderr.String())
			}
			// The artifact is the evidence the issue sync reads. A cause the sync
			// validator would refuse costs the whole artifact, and with it the
			// alert, so the published form is checked through the shipped alphabet.
			if jsonstrict.SanitizeCause(finding.Cause) != finding.Cause {
				t.Fatalf("cause %q is not already sanitized", finding.Cause)
			}
		})
	}
}
