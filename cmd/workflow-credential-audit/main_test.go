package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCredentialLiteralClassification(t *testing.T) {
	t.Parallel()
	longMixed := "AbCdEf0123456789AbCdEf0123456789"
	cases := []struct {
		name  string
		value string
		want  bool
	}{
		{"CODECOV_TOKEN", "12345678-1234-4234-9234-123456789abc", true},
		{"GH_TOKEN", "ghp_" + strings.Repeat("a", 36), true},
		{"SERVICE_API_KEY", longMixed, true},
		{"DEPLOY_PRIVATE_KEY", "-----BEGIN OPENSSH PRIVATE KEY-----", true},
		{"CODECOV_TOKEN", "${{ secrets.CODECOV_TOKEN }}", false},
		{"GH_TOKEN", "${{ github.token }}", false},
		{"GH_TOKEN", "prefix-${{ github.token }}", true},
		{"GH_TOKEN", "${{ steps.auth.outputs.token }}", true},
		{"GH_TOKEN", "${{ github.token || secrets.FALLBACK_TOKEN }}", true},
		{"UNITY_PASSWORD", "integration-test-only", false},
		{"AWS_SECRET_ACCESS_KEY", "test", false},
		{"RUN_ID", "12345678-1234-4234-9234-123456789abc", false},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name+"/"+test.value[:min(8, len(test.value))], func(t *testing.T) {
			t.Parallel()
			if got := isCredentialShapedLiteral(test.name, test.value); got != test.want {
				t.Fatalf("isCredentialShapedLiteral(%q, redacted) = %v, want %v", test.name, got, test.want)
			}
		})
	}
}

func TestAuditReaderHandlesYAMLForms(t *testing.T) {
	t.Parallel()
	longMixed := "AbCdEf0123456789AbCdEf0123456789"
	cases := []struct {
		name        string
		source      string
		wantNames   []string
		unsupported int
	}{
		{"block mapping", "env:\n  CODECOV_TOKEN: 12345678-1234-4234-9234-123456789abc\n", []string{"CODECOV_TOKEN"}, 0},
		{"flow mapping", "jobs: {test: {env: {SERVICE_API_KEY: " + longMixed + "}}}\n", []string{"SERVICE_API_KEY"}, 0},
		{"sequence step", "jobs:\n  test:\n    steps:\n      - env:\n          DEPLOY_TOKEN: " + longMixed + "\n", []string{"DEPLOY_TOKEN"}, 0},
		{"explicit key", "? env\n: {GH_TOKEN: " + longMixed + "}\n", []string{"GH_TOKEN"}, 0},
		{"escaped key", "\"e\\x6ev\": {GH_TOKEN: " + longMixed + "}\n", []string{"GH_TOKEN"}, 0},
		{"tagged env and value", "!policy env: {GH_TOKEN: !credential " + longMixed + "}\n", []string{"GH_TOKEN"}, 0},
		{"anchored mapping", "env: &credentials {GH_TOKEN: " + longMixed + "}\n", []string{"GH_TOKEN"}, 0},
		{"aliased mapping", "template: &credentials {GH_TOKEN: " + longMixed + "}\nenv: *credentials\n", []string{"GH_TOKEN"}, 0},
		{"aliased scalar", "token: &value " + longMixed + "\nenv: {GH_TOKEN: *value}\n", []string{"GH_TOKEN"}, 0},
		{"literal block", "env:\n  GH_TOKEN: |\n    " + longMixed + "\n", []string{"GH_TOKEN"}, 0},
		{"folded block", "env:\n  GH_TOKEN: >\n    " + longMixed + "\n", []string{"GH_TOKEN"}, 0},
		{"quoted surrounding whitespace", "env: {GH_TOKEN: '  " + longMixed + "  '}\n", []string{"GH_TOKEN"}, 0},
		{"exact references", "env: {A_TOKEN: '${{ secrets.A_TOKEN }}', B_TOKEN: '${{ github.token }}'}\n", nil, 0},
		{"trimmed exact reference", "env: {A_TOKEN: '  ${{ secrets.A_TOKEN }}  '}\n", nil, 0},
		{"non-approved expression", "env: {GH_TOKEN: '${{ vars.GH_TOKEN }}'}\n", []string{"GH_TOKEN"}, 0},
		{"merged env", "base: &base {GH_TOKEN: test}\nenv: {<<: *base}\n", nil, 1},
		{"sequence env", "env: [A_TOKEN, B_TOKEN]\n", nil, 1},
		{"nested env value", "env: {GH_TOKEN: {value: test}}\n", nil, 1},
		{"safe fixture", "env: {UNITY_PASSWORD: integration-test-only, AWS_SECRET_ACCESS_KEY: test}\n", nil, 0},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			findings, err := auditReader("fixture.yml", strings.NewReader(test.source))
			if err != nil {
				t.Fatal(err)
			}
			var names []string
			unsupported := 0
			for _, finding := range findings {
				if finding.Kind == "unsupported" {
					unsupported++
				} else {
					names = append(names, finding.Name)
				}
				if strings.Contains(finding.String(), longMixed) {
					t.Fatal("diagnostic exposed credential value")
				}
			}
			if strings.Join(names, ",") != strings.Join(test.wantNames, ",") || unsupported != test.unsupported {
				t.Fatalf("findings names=%v unsupported=%d, want names=%v unsupported=%d", names, unsupported, test.wantNames, test.unsupported)
			}
		})
	}
}

func TestFindingDiagnosticEscapesHostileComponents(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		file string
		key  string
	}{
		{"filename newline", ".github/workflows/forged\nline.yml", "GH_TOKEN"},
		{"filename annotation", ".github/::error file=target::forged.yml", "GH_TOKEN"},
		{"key carriage return", "fixture.yml", "GH_TOKEN_\rforged-line"},
		{"key control", "fixture.yml", "GH_TOKEN_\x1b[31mforged"},
		{"key annotation", "fixture.yml", "GH_TOKEN_::error file=target::forged"},
		{"key unicode line separator", "fixture.yml", "GH_TOKEN_\u2028forged-line"},
		{"filename unicode paragraph separator", ".github/workflows/forged\u2029line.yml", "GH_TOKEN"},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			diagnostic := (finding{File: test.file, Line: 17, Name: test.key, Kind: "literal"}).String()
			if !strings.Contains(diagnostic, `:17: credential-shaped literal in env[`) {
				t.Fatalf("diagnostic lost useful file/line context: %q", diagnostic)
			}
			if !strings.HasPrefix(diagnostic, `"`) || !strings.Contains(diagnostic, `env["`) {
				t.Fatalf("diagnostic components are not visibly quoted: %q", diagnostic)
			}
			if strings.Contains(diagnostic, "::") {
				t.Fatalf("diagnostic retained a workflow-command marker: %q", diagnostic)
			}
			for _, character := range diagnostic {
				if character < 0x20 || character == 0x7f || character == '\u2028' || character == '\u2029' {
					t.Fatalf("diagnostic retained a line or control character %U: %q", character, diagnostic)
				}
			}
		})
	}
}

func TestRunEscapesParseErrorDiagnostics(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	workflow := filepath.Join(root, ".github", "workflows", "invalid.yml")
	if err := os.MkdirAll(filepath.Dir(workflow), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(workflow, []byte("env: [\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr strings.Builder
	code := run(root, &stdout, &stderr)
	if code != 1 || stdout.Len() != 0 {
		t.Fatalf("run returned code=%d stdout=%q", code, stdout.String())
	}
	diagnostic := stderr.String()
	if !strings.HasPrefix(diagnostic, `workflow credential audit failed: "`) || strings.Contains(diagnostic, "::") {
		t.Fatalf("unsafe or unquoted error diagnostic: %q", diagnostic)
	}
	for _, character := range strings.TrimSuffix(diagnostic, "\n") {
		if character < 0x20 || character == 0x7f || character == '\u2028' || character == '\u2029' {
			t.Fatalf("diagnostic retained a line or control character %U: %q", character, diagnostic)
		}
	}
}

func TestAuditRepositoryRecursesThroughGitHubYAML(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	paths := map[string]string{
		".github/workflows/safe.yml":                    "env: {GH_TOKEN: '${{ github.token }}'}\n",
		".github/workflows-disabled/nested/unsafe.yaml": "env: {GH_TOKEN: AbCdEf0123456789AbCdEf0123456789}\n",
		"outside/ignored.yml":                           "env: {GH_TOKEN: AbCdEf0123456789AbCdEf0123456789}\n",
	}
	for relative, contents := range paths {
		path := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	findings, err := auditRepository(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 || findings[0].File != ".github/workflows-disabled/nested/unsafe.yaml" || findings[0].Name != "GH_TOKEN" {
		t.Fatalf("unexpected sanitized findings: %#v", findings)
	}
}

func TestRepositoryPassesAudit(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	findings, err := auditRepository(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 0 {
		t.Fatalf("repository has workflow credential findings: %v", findings)
	}
}
