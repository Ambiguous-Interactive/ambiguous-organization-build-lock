package enrollment

import (
	"strings"
	"testing"
)

const testSHA = "0123456789abcdef0123456789abcdef01234567"
const acquire = "Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@" + testSHA

func fixture(files map[string]string) Snapshot {
	contents := make(map[string][]byte, len(files))
	for file, content := range files {
		contents[file] = []byte(content)
	}
	return Snapshot{Repository: "Ambiguous-Interactive/fixture", SHA: testSHA, Files: contents}
}

func workflow(workflowConcurrency, jobConcurrency, steps string) string {
	return "name: Fixture\n" + workflowConcurrency + "jobs:\n  unity:\n" + jobConcurrency + "    runs-on: ubuntu-latest\n    steps:\n" + steps
}

func directAcquireStep() string {
	return acquireStep("      ")
}

func acquireStep(indent string) string {
	return indent + "- uses: " + acquire + "\n" +
		indent + "  with:\n" +
		indent + "    github-token: ${{ github.token }}\n" +
		indent + "    pull-request-number: ${{ github.event.pull_request.number }}\n" +
		indent + "    expected-head-sha: ${{ github.event.pull_request.head.sha }}\n" +
		indent + "  env:\n" +
		indent + "    BUILD_LOCK_APP_ID: ${{ secrets.BUILD_LOCK_APP_ID }}\n" +
		indent + "    BUILD_LOCK_APP_PRIVATE_KEY: ${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}\n"
}

func conditionalAcquireStep(indent, condition string) string {
	return indent + "- if: " + condition + "\n" +
		indent + "  uses: " + acquire + "\n" +
		indent + "  with:\n" +
		indent + "    github-token: ${{ github.token }}\n" +
		indent + "    pull-request-number: ${{ github.event.pull_request.number }}\n" +
		indent + "    expected-head-sha: ${{ github.event.pull_request.head.sha }}\n" +
		indent + "  env:\n" +
		indent + "    BUILD_LOCK_APP_ID: ${{ secrets.BUILD_LOCK_APP_ID }}\n" +
		indent + "    BUILD_LOCK_APP_PRIVATE_KEY: ${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}\n"
}

func currentHeadGuard(indent, sha string) string {
	return indent + "- uses: " + guardActionPrefix + sha + "\n" +
		indent + "  with:\n" +
		indent + "    github-token: ${{ github.token }}\n" +
		indent + "    pull-request-number: ${{ github.event.pull_request.number }}\n" +
		indent + "    expected-head-sha: ${{ github.event.pull_request.head.sha }}\n"
}

func findingCodes(findings []Finding) string {
	codes := make([]string, len(findings))
	for index, finding := range findings {
		codes[index] = finding.Code + ":" + finding.Path + ":" + finding.Job
	}
	return strings.Join(codes, ",")
}

func TestCancellationPolicyDirectBoundaries(t *testing.T) {
	tests := []struct {
		name                string
		workflowConcurrency string
		jobConcurrency      string
		wantCode            string
	}{
		{name: "absent concurrency"},
		{name: "literal false scopes", workflowConcurrency: "concurrency: { group: fixture, cancel-in-progress: false }\n", jobConcurrency: "    concurrency: { group: unity, cancel-in-progress: false }\n"},
		{name: "workflow true", workflowConcurrency: "concurrency: { group: fixture, cancel-in-progress: true }\n", wantCode: "unsafe-workflow-cancellation"},
		{name: "workflow expression", workflowConcurrency: "concurrency:\n  group: fixture\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n", wantCode: "unsafe-workflow-cancellation"},
		{name: "quoted false fails closed", workflowConcurrency: "concurrency: { group: fixture, cancel-in-progress: 'false' }\n", wantCode: "unsafe-workflow-cancellation"},
		{name: "job true", jobConcurrency: "    concurrency: { group: unity, cancel-in-progress: true }\n", wantCode: "unsafe-job-cancellation"},
		{name: "repository identity is case insensitive", workflowConcurrency: "concurrency: { group: fixture, cancel-in-progress: true }\n", wantCode: "unsafe-workflow-cancellation"},
		{name: "Windows action path is case insensitive", workflowConcurrency: "concurrency: { group: fixture, cancel-in-progress: true }\n", wantCode: "unsafe-workflow-cancellation"},
		{name: "filesystem-normalized action path is licensed", workflowConcurrency: "concurrency: { group: fixture, cancel-in-progress: true }\n", wantCode: "unsafe-workflow-cancellation"},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			step := directAcquireStep()
			if testCase.name == "repository identity is case insensitive" {
				step = "      - uses: ambiguous-interactive/AMBIGUOUS-ORGANIZATION-BUILD-LOCK/.github/actions/acquire-build-lock@" + testSHA + "\n"
			}
			if testCase.name == "Windows action path is case insensitive" {
				step = "      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.GitHub/Actions/Acquire-Build-Lock@" + testSHA + "\n"
			}
			if testCase.name == "filesystem-normalized action path is licensed" {
				step = "      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/placeholder/../acquire-build-lock/@" + testSHA + "\n"
			}
			findings, err := AnalyzeCancellationSafety(fixture(map[string]string{
				".github/workflows/unity.yml": workflow(testCase.workflowConcurrency, testCase.jobConcurrency, step),
			}))
			if err != nil {
				t.Fatal(err)
			}
			codes := findingCodes(findings)
			if testCase.wantCode == "" && codes != "" {
				t.Fatalf("expected clean policy, got %s", codes)
			}
			if testCase.wantCode != "" && !strings.Contains(codes, testCase.wantCode) {
				t.Fatalf("expected %s, got %s", testCase.wantCode, codes)
			}
		})
	}
}

func TestCancellationPolicyMatrixFailFastBoundaries(t *testing.T) {
	tests := []struct {
		name     string
		strategy string
		wantCode string
	}{
		{name: "no strategy"},
		{name: "non matrix strategy", strategy: "    strategy:\n      max-parallel: 1\n"},
		{name: "literal false", strategy: "    strategy:\n      fail-fast: false\n      matrix: { mode: [EditMode, PlayMode] }\n"},
		{name: "default true", strategy: "    strategy:\n      matrix: { mode: [EditMode, PlayMode] }\n", wantCode: "unsafe-matrix-fail-fast"},
		{name: "literal true", strategy: "    strategy:\n      fail-fast: true\n      matrix: { mode: [EditMode, PlayMode] }\n", wantCode: "unsafe-matrix-fail-fast"},
		{name: "expression", strategy: "    strategy:\n      fail-fast: ${{ inputs.abort_on_first_failure }}\n      matrix: { mode: [EditMode, PlayMode] }\n", wantCode: "unsafe-matrix-fail-fast"},
		{name: "quoted false", strategy: "    strategy:\n      fail-fast: 'false'\n      matrix: { mode: [EditMode, PlayMode] }\n", wantCode: "unsafe-matrix-fail-fast"},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			findings, err := AnalyzeCancellationSafety(fixture(map[string]string{
				".github/workflows/unity.yml": workflow("", testCase.strategy, directAcquireStep()),
			}))
			if err != nil {
				t.Fatal(err)
			}
			codes := findingCodes(findings)
			if testCase.wantCode == "" && codes != "" {
				t.Fatalf("expected clean policy, got %s", codes)
			}
			if testCase.wantCode != "" && !strings.Contains(codes, testCase.wantCode) {
				t.Fatalf("expected %s, got %s", testCase.wantCode, codes)
			}
		})
	}
}

func TestCancellationPolicyTransitiveBoundaries(t *testing.T) {
	tests := []struct {
		name     string
		files    map[string]string
		wantCode string
	}{
		{
			name: "unsafe static sibling is unrelated",
			files: map[string]string{
				".github/workflows/main.yml": "jobs:\n  static:\n    concurrency: { group: static, cancel-in-progress: true }\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo static\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + directAcquireStep(),
			},
		},
		{
			name: "similarly named remote action is not acquire",
			files: map[string]string{
				".github/workflows/main.yml": "concurrency: { group: static, cancel-in-progress: true }\njobs:\n  static:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock-extra@" + testSHA + "\n",
			},
		},
		{
			name: "external reusable call fails closed and marks caller licensed",
			files: map[string]string{
				".github/workflows/main.yml": "jobs:\n  call:\n    concurrency: { group: call, cancel-in-progress: true }\n    uses: Ambiguous-Interactive/remote/.github/workflows/unity.yml@" + testSHA + "\n",
			},
			wantCode: "unsafe-job-cancellation:.github/workflows/main.yml:call",
		},
		{
			name: "caller job can cancel called workflow",
			files: map[string]string{
				".github/workflows/main.yml":   "jobs:\n  call:\n    concurrency: { group: call, cancel-in-progress: true }\n    uses: ./.github/workflows/called.yml\n",
				".github/workflows/called.yml": "on: workflow_call\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + directAcquireStep(),
			},
			wantCode: "unsafe-job-cancellation:.github/workflows/main.yml:call",
		},
		{
			name: "called workflow top level can cancel holder",
			files: map[string]string{
				".github/workflows/main.yml":   "jobs:\n  call:\n    uses: ./.github/workflows/called.yml\n",
				".github/workflows/called.yml": "on: workflow_call\nconcurrency: { group: called, cancel-in-progress: true }\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + directAcquireStep(),
			},
			wantCode: "unsafe-workflow-cancellation:.github/workflows/called.yml:unity",
		},
		{
			name: "called workflow leaf job can cancel holder",
			files: map[string]string{
				".github/workflows/main.yml":   "jobs:\n  call:\n    uses: ./.github/workflows/called.yml\n",
				".github/workflows/called.yml": "on: workflow_call\njobs:\n  unity:\n    concurrency: { group: leaf, cancel-in-progress: true }\n    runs-on: ubuntu-latest\n    steps:\n" + directAcquireStep(),
			},
			wantCode: "unsafe-job-cancellation:.github/workflows/called.yml:unity",
		},
		{
			name: "nested composite acquire propagates to caller",
			files: map[string]string{
				".github/workflows/main.yml":       "concurrency: { group: main, cancel-in-progress: true }\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/outer\n",
				".github/actions/outer/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/inner\n",
				".github/actions/inner/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: " + acquire + "\n",
			},
			wantCode: "unsafe-workflow-cancellation:.github/workflows/main.yml:unity",
		},
		{
			name: "caller workflow cancellation propagates through reusable and nested composites",
			files: map[string]string{
				".github/workflows/main.yml":       "concurrency: { group: main, cancel-in-progress: true }\njobs:\n  call:\n    uses: ./.github/workflows/called.yml\n",
				".github/workflows/called.yml":     "on: workflow_call\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/outer\n",
				".github/actions/outer/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/inner\n",
				".github/actions/inner/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: " + acquire + "\n",
			},
			wantCode: "unsafe-workflow-cancellation:.github/workflows/main.yml:call",
		},
		{
			name: "caller job cancellation propagates through reusable and nested composites",
			files: map[string]string{
				".github/workflows/main.yml":       "jobs:\n  call:\n    concurrency: { group: call, cancel-in-progress: true }\n    uses: ./.github/workflows/called.yml\n",
				".github/workflows/called.yml":     "on: workflow_call\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/outer\n",
				".github/actions/outer/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/inner\n",
				".github/actions/inner/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: " + acquire + "\n",
			},
			wantCode: "unsafe-job-cancellation:.github/workflows/main.yml:call",
		},
		{
			name: "two reusable workflow levels propagate acquire",
			files: map[string]string{
				".github/workflows/main.yml":   "jobs:\n  call:\n    concurrency: { group: call, cancel-in-progress: true }\n    uses: ./.github/workflows/middle.yml\n",
				".github/workflows/middle.yml": "on: workflow_call\njobs:\n  call:\n    uses: ./.github/workflows/leaf.yml\n",
				".github/workflows/leaf.yml":   "on: workflow_call\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + directAcquireStep(),
			},
			wantCode: "unsafe-job-cancellation:.github/workflows/main.yml:call",
		},
		{
			name: "literal false is safe across reusable and composite boundaries",
			files: map[string]string{
				".github/workflows/main.yml":       "concurrency: { group: main, cancel-in-progress: false }\njobs:\n  call:\n    concurrency: { group: call, cancel-in-progress: false }\n    uses: ./.github/workflows/called.yml\n",
				".github/workflows/called.yml":     "on: workflow_call\nconcurrency: { group: called, cancel-in-progress: false }\njobs:\n  unity:\n    concurrency: { group: unity, cancel-in-progress: false }\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/outer\n",
				".github/actions/outer/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/inner\n",
				".github/actions/inner/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: " + acquire + "\n",
			},
		},
		{
			name: "action yaml fallback propagates acquire",
			files: map[string]string{
				".github/workflows/main.yml":           "jobs:\n  unity:\n    concurrency: { group: unity, cancel-in-progress: true }\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/licensed\n",
				".github/actions/licensed/action.yaml": "runs:\n  using: composite\n  steps:\n    - uses: " + acquire + "\n",
			},
			wantCode: "unsafe-job-cancellation:.github/workflows/main.yml:unity",
		},
		{
			name: "root composite action propagates acquire",
			files: map[string]string{
				".github/workflows/main.yml": "jobs:\n  unity:\n    concurrency: { group: unity, cancel-in-progress: true }\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./\n",
				"action.yml":                 "runs:\n  using: composite\n  steps:\n    - uses: " + acquire + "\n",
			},
			wantCode: "unsafe-job-cancellation:.github/workflows/main.yml:unity",
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			findings, err := AnalyzeCancellationSafety(fixture(testCase.files))
			if err != nil {
				t.Fatal(err)
			}
			codes := findingCodes(findings)
			if testCase.wantCode == "" && codes != "" {
				t.Fatalf("expected clean policy, got %s", codes)
			}
			if testCase.wantCode != "" && !strings.Contains(codes, testCase.wantCode) {
				t.Fatalf("expected %s, got %s", testCase.wantCode, codes)
			}
			if testCase.name == "external reusable call fails closed and marks caller licensed" &&
				!strings.Contains(codes, "unresolved-reusable-workflow:.github/workflows/main.yml:call") {
				t.Fatalf("expected unresolved remote workflow finding, got %s", codes)
			}
		})
	}
}

func TestCancellationPolicyReportsEveryUnsafeLicensedLeaf(t *testing.T) {
	findings, err := AnalyzeCancellationSafety(fixture(map[string]string{
		".github/workflows/main.yml": "concurrency: { group: main, cancel-in-progress: true }\njobs:\n  first:\n    concurrency: { group: first, cancel-in-progress: true }\n    runs-on: ubuntu-latest\n    steps:\n" + directAcquireStep() + "  second:\n    concurrency: { group: second, cancel-in-progress: true }\n    runs-on: ubuntu-latest\n    steps:\n" + directAcquireStep(),
	}))
	if err != nil {
		t.Fatal(err)
	}
	codes := findingCodes(findings)
	for _, expected := range []string{
		"unsafe-workflow-cancellation:.github/workflows/main.yml:first",
		"unsafe-workflow-cancellation:.github/workflows/main.yml:second",
		"unsafe-job-cancellation:.github/workflows/main.yml:first",
		"unsafe-job-cancellation:.github/workflows/main.yml:second",
	} {
		if !strings.Contains(codes, expected) {
			t.Fatalf("expected %s among all findings, got %s", expected, codes)
		}
	}
}

func TestCurrentHeadGuardPolicyBoundaries(t *testing.T) {
	guard := currentHeadGuard("      ", testSHA)
	acquireDirect := directAcquireStep()
	tests := []struct {
		name     string
		files    map[string]string
		wantCode string
	}{
		{
			name: "direct PR job is guarded at both boundaries",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard + "      - run: echo setup\n" + guard + acquireDirect,
			},
		},
		{
			name: "push-only workflow needs no PR guard",
			files: map[string]string{
				".github/workflows/main.yml": "on: push\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + acquireDirect,
			},
		},
		{
			name: "missing initial guard",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo setup\n" + guard + acquireDirect,
			},
			wantCode: "missing-initial-current-head-guard",
		},
		{
			name: "wrong immutable guard is invalid",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + currentHeadGuard("      ", strings.Repeat("b", 40)) + acquireDirect,
			},
			wantCode: "invalid-current-head-guard",
		},
		{
			name: "conditional guard is invalid",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + strings.Replace(guard, "      - uses:", "      - if: success()\n        uses:", 1) + acquireDirect,
			},
			wantCode: "invalid-current-head-guard",
		},
		{
			name: "missing guard immediately before acquire",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard + "      - run: echo setup\n" + acquireDirect,
			},
			wantCode: "missing-pre-lock-current-head-guard",
		},
		{
			name: "PR acquire must embed exact FIFO head revalidation inputs",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard + guard + "      - uses: " + acquire + "\n",
			},
			wantCode: "invalid-acquire-pr-head-revalidation",
		},
		{
			name: "PR acquire rejects a different token expression",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard + guard + strings.Replace(directAcquireStep(), "${{ github.token }}", "${{ secrets.OTHER_TOKEN }}", 1),
			},
			wantCode: "invalid-acquire-pr-head-revalidation",
		},
		{
			name: "PR acquire requires exact App credential environment",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard + guard + strings.Replace(directAcquireStep(), "        env:\n          BUILD_LOCK_APP_ID: ${{ secrets.BUILD_LOCK_APP_ID }}\n          BUILD_LOCK_APP_PRIVATE_KEY: ${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}\n", "", 1),
			},
			wantCode: "invalid-acquire-pr-head-revalidation",
		},
		{
			name: "PR acquire rejects a different App credential binding",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard + guard + strings.Replace(directAcquireStep(), "${{ secrets.BUILD_LOCK_APP_ID }}", "${{ secrets.OTHER_APP_ID }}", 1),
			},
			wantCode: "invalid-acquire-pr-head-revalidation",
		},
		{
			name: "PR acquire rejects an older immutable implementation",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard + guard + strings.Replace(directAcquireStep(), testSHA, strings.Repeat("b", 40), 1),
			},
			wantCode: "invalid-acquire-pr-head-revalidation",
		},
		{
			name: "PR acquire rejects step environment injection",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard + guard + strings.Replace(directAcquireStep(), "          BUILD_LOCK_APP_ID:", "          NODE_OPTIONS: --require ./payload.js\n          BUILD_LOCK_APP_ID:", 1),
			},
			wantCode: "invalid-acquire-pr-head-revalidation",
		},
		{
			name: "PR licensed job rejects inherited NODE_OPTIONS",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\nenv:\n  node_options: --require ./payload.js\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard + guard + directAcquireStep(),
			},
			wantCode: "unsafe-node-options",
		},
		{
			name: "PR licensed container rejects inherited NODE_OPTIONS",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    container:\n      image: unity:latest\n      env:\n        NODE_OPTIONS: --require ./payload.js\n    steps:\n" + guard + guard + directAcquireStep(),
			},
			wantCode: "unsafe-job-container",
		},
		{
			name: "PR licensed container rejects opaque runtime options",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    container:\n      image: unity:latest\n      options: --env NODE_OPTIONS=--require=./payload.js\n    steps:\n" + guard + guard + directAcquireStep(),
			},
			wantCode: "unsafe-job-container",
		},
		{
			name: "pre acquire guard may run for a superset of entry conditions",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					strings.Replace(guard, "      - uses:", "      - if: steps.ready == 'true'\n        uses:", 1) +
					conditionalAcquireStep("      ", "steps.ready == 'true' && github.event_name == 'pull_request'"),
			},
		},
		{
			name: "pre acquire guard may not be more restrictive than entry",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					strings.Replace(guard, "      - uses:", "      - if: steps.ready == 'true' && steps.extra == 'true'\n        uses:", 1) +
					"      - if: steps.ready == 'true'\n        uses: " + acquire + "\n",
			},
			wantCode: "invalid-current-head-guard",
		},
		{
			name: "guard cannot condition itself on its eventual skipped outcome",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					strings.Replace(guard, "      - uses:", "      - id: head_guard\n        if: steps.head_guard.outcome == 'skipped'\n        uses:", 1) +
					"      - if: success() && steps.head_guard.outcome == 'skipped'\n        uses: " + acquire + "\n",
			},
			wantCode: "invalid-current-head-guard",
		},
		{
			name: "guard and acquire cannot observe different step env",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    env:\n      RUN_GUARD: 'false'\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					strings.Replace(guard, "      - uses:", "      - if: env.RUN_GUARD == 'true'\n        uses:", 1) +
					"      - if: success() && env.RUN_GUARD == 'true'\n        env:\n          RUN_GUARD: 'true'\n        uses: " + acquire + "\n",
			},
			wantCode: "invalid-current-head-guard",
		},
		{
			name: "guard cannot depend on step-specific github context",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					strings.Replace(guard, "      - uses:", "      - if: github.action == 'require-current-pr-head'\n        uses:", 1) +
					"      - if: success() && github.action == 'require-current-pr-head'\n        uses: " + acquire + "\n",
			},
			wantCode: "invalid-current-head-guard",
		},
		{
			name: "guard rejects Node preload environment injection",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					strings.Replace(guard, "      - uses:", "      - env:\n          NODE_OPTIONS: --require ./fake-guard-hook.js\n        uses:", 1) +
					acquireDirect,
			},
			wantCode: "invalid-current-head-guard",
		},
		{
			name: "implicit success guard does not cover always acquire",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					guard +
					"      - if: always()\n        uses: " + acquire + "\n",
			},
			wantCode: "invalid-current-head-guard",
		},
		{
			name: "matching always guard does not gate acquire on guard success",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					strings.Replace(guard, "      - uses:", "      - if: always()\n        uses:", 1) +
					"      - if: always()\n        uses: " + acquire + "\n",
			},
			wantCode: "invalid-current-head-guard",
		},
		{
			name: "always guard covers acquire explicitly gated on success",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					strings.Replace(guard, "      - uses:", "      - if: always()\n        uses:", 1) +
					conditionalAcquireStep("      ", "always() && success()"),
			},
		},
		{
			name: "unconditional guard covers status free disjunction acquire",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					guard +
					conditionalAcquireStep("      ", "steps.a == 'true' || steps.b == 'true'"),
			},
		},
		{
			name: "top level OR cannot bypass explicit success conjunct",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					guard +
					"      - if: success() && false || always()\n        uses: " + acquire + "\n",
			},
			wantCode: "invalid-current-head-guard",
		},
		{
			name: "parenthesized OR remains one safe conjunct",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					strings.Replace(guard, "      - uses:", "      - if: (steps.a == 'true' || steps.b == 'true')\n        uses:", 1) +
					conditionalAcquireStep("      ", "success() && (steps.a == 'true' || steps.b == 'true')"),
			},
		},
		{
			name: "implicit success guard does not cover failure acquire",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					guard +
					"      - if: failure()\n        uses: " + acquire + "\n",
			},
			wantCode: "invalid-current-head-guard",
		},
		{
			name: "matching failure guard does not gate acquire on guard success",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					strings.Replace(guard, "      - uses:", "      - if: failure()\n        uses:", 1) +
					"      - if: failure()\n        uses: " + acquire + "\n",
			},
			wantCode: "invalid-current-head-guard",
		},
		{
			name: "implicit success guard does not cover cancelled acquire",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					guard +
					"      - if: cancelled()\n        uses: " + acquire + "\n",
			},
			wantCode: "invalid-current-head-guard",
		},
		{
			name: "matching cancelled guard does not gate acquire on guard success",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					strings.Replace(guard, "      - uses:", "      - if: cancelled()\n        uses:", 1) +
					"      - if: cancelled()\n        uses: " + acquire + "\n",
			},
			wantCode: "invalid-current-head-guard",
		},
		{
			name: "status function text inside a string retains implicit success",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					strings.Replace(guard, "      - uses:", "      - if: contains('failure(', steps.value)\n        uses:", 1) +
					"      - if: always() && contains('failure(', steps.value)\n        uses: " + acquire + "\n",
			},
			wantCode: "invalid-current-head-guard",
		},
		{
			name: "condition comparison preserves quoted whitespace",
			files: map[string]string{
				".github/workflows/main.yml": "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard +
					strings.Replace(guard, "      - uses:", "      - if: steps.value == 'a b'\n        uses:", 1) +
					"      - if: steps.value == 'ab'\n        uses: " + acquire + "\n",
			},
			wantCode: "invalid-current-head-guard",
		},
		{
			name: "AND event exclusion is proven non PR",
			files: map[string]string{
				".github/workflows/main.yml": "on: [pull_request, push]\njobs:\n  unity:\n    if: github.event_name == 'push' && success()\n    runs-on: ubuntu-latest\n    steps:\n" + acquireDirect,
			},
		},
		{
			name: "OR event expression remains PR capable",
			files: map[string]string{
				".github/workflows/main.yml": "on: [pull_request, push]\njobs:\n  unity:\n    if: github.event_name == 'push' || github.event_name == 'pull_request'\n    runs-on: ubuntu-latest\n    steps:\n" + acquireDirect,
			},
			wantCode: "missing-initial-current-head-guard",
		},
		{
			name: "mixed AND OR event expression remains PR capable",
			files: map[string]string{
				".github/workflows/main.yml": "on: [pull_request, push]\njobs:\n  unity:\n    if: github.event_name == 'push' && false || true\n    runs-on: ubuntu-latest\n    steps:\n" + acquireDirect,
			},
			wantCode: "missing-initial-current-head-guard",
		},
		{
			name: "PR reachability propagates through called workflow",
			files: map[string]string{
				".github/workflows/main.yml":   "on: pull_request\njobs:\n  call:\n    uses: ./.github/workflows/called.yml\n",
				".github/workflows/called.yml": "on: workflow_call\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard + acquireDirect,
			},
		},
		{
			name: "nested composite requires its own pre acquire guard",
			files: map[string]string{
				".github/workflows/main.yml":          "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard + "      - uses: ./.github/actions/licensed\n",
				".github/actions/licensed/action.yml": "runs:\n  using: composite\n  steps:\n" + currentHeadGuard("    ", testSHA) + acquireStep("    "),
			},
		},
		{
			name: "unguarded nested composite acquire fails",
			files: map[string]string{
				".github/workflows/main.yml":          "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard + "      - uses: ./.github/actions/licensed\n",
				".github/actions/licensed/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: " + acquire + "\n",
			},
			wantCode: "missing-pre-lock-current-head-guard",
		},
		{
			name: "guarded nested composite acquire still requires exact revalidation inputs",
			files: map[string]string{
				".github/workflows/main.yml":          "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard + "      - uses: ./.github/actions/licensed\n",
				".github/actions/licensed/action.yml": "runs:\n  using: composite\n  steps:\n" + currentHeadGuard("    ", testSHA) + "    - uses: " + acquire + "\n",
			},
			wantCode: "invalid-acquire-pr-head-revalidation",
		},
		{
			name: "nested composite acquire rejects environment injection",
			files: map[string]string{
				".github/workflows/main.yml":          "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + guard + "      - uses: ./.github/actions/licensed\n",
				".github/actions/licensed/action.yml": "runs:\n  using: composite\n  steps:\n" + currentHeadGuard("    ", testSHA) + strings.Replace(acquireStep("    "), "        BUILD_LOCK_APP_ID:", "        NODE_OPTIONS: --require ./payload.js\n        BUILD_LOCK_APP_ID:", 1),
			},
			wantCode: "invalid-acquire-pr-head-revalidation",
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			findings, err := AnalyzePolicy(fixture(testCase.files), Policy{
				RequiredGuardSHA:   testSHA,
				RequiredAcquireSHA: testSHA,
			})
			if err != nil {
				t.Fatal(err)
			}
			codes := findingCodes(findings)
			if testCase.wantCode == "" && codes != "" {
				t.Fatalf("expected clean guard policy, got %s", codes)
			}
			if testCase.wantCode != "" && !strings.Contains(codes, testCase.wantCode) {
				t.Fatalf("expected %s, got %s", testCase.wantCode, codes)
			}
		})
	}
}

func TestCancellationPolicyValidatesSnapshotIdentity(t *testing.T) {
	for _, repository := range []string{
		"", "owner", "owner/repository/extra", " owner/repository", "owner/repository ",
		"-owner/repository", "owner-/repository", "own--er/repository", "owner/repository?ref=main",
		strings.Repeat("o", 40) + "/repository", "owner/" + strings.Repeat("r", 101),
	} {
		snapshot := fixture(map[string]string{".github/workflows/main.yml": "jobs: {}\n"})
		snapshot.Repository = repository
		if _, err := AnalyzeCancellationSafety(snapshot); err == nil {
			t.Fatalf("expected repository %q to fail", repository)
		}
	}

	snapshot := fixture(map[string]string{".github/workflows/main.yml": "jobs: {}\n"})
	snapshot.SHA = "main"
	if _, err := AnalyzeCancellationSafety(snapshot); err == nil {
		t.Fatal("expected mutable snapshot ref to fail")
	}

	snapshot = fixture(map[string]string{".github/workflows/main.yml": "jobs: {}\n"})
	if _, err := AnalyzePolicy(snapshot, Policy{RequiredAcquireSHA: "main"}); err == nil {
		t.Fatal("expected mutable required acquire ref to fail")
	}
}

func TestRequiredAcquirePolicyCanRollOutIndependently(t *testing.T) {
	workflowText := "on: pull_request\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + directAcquireStep()
	findings, err := AnalyzePolicy(
		fixture(map[string]string{".github/workflows/main.yml": workflowText}),
		Policy{RequiredAcquireSHA: testSHA},
	)
	if err != nil {
		t.Fatal(err)
	}
	if codes := findingCodes(findings); codes != "" {
		t.Fatalf("exact acquire policy should not require standalone guards, got %s", codes)
	}

	findings, err = AnalyzePolicy(
		fixture(map[string]string{
			".github/workflows/main.yml": strings.Replace(workflowText, testSHA, strings.Repeat("b", 40), 1),
		}),
		Policy{RequiredAcquireSHA: testSHA},
	)
	if err != nil {
		t.Fatal(err)
	}
	if codes := findingCodes(findings); !strings.Contains(codes, "invalid-acquire-pr-head-revalidation") {
		t.Fatalf("expected exact acquire pin finding, got %s", codes)
	}
}

func TestRequiredAcquirePolicyAppliesToEveryTriggerAndComposite(t *testing.T) {
	staleSHA := strings.Repeat("b", 40)
	tests := []struct {
		name  string
		files map[string]string
	}{
		{
			name: "push workflow",
			files: map[string]string{
				".github/workflows/main.yml": "on: push\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + strings.Replace(directAcquireStep(), testSHA, staleSHA, 1),
			},
		},
		{
			name: "manual workflow",
			files: map[string]string{
				".github/workflows/main.yml": "on: workflow_dispatch\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n" + strings.Replace(directAcquireStep(), testSHA, staleSHA, 1),
			},
		},
		{
			name: "nested composite",
			files: map[string]string{
				".github/workflows/main.yml":          "on: push\njobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/outer\n",
				".github/actions/outer/action.yml":    "runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/licensed\n",
				".github/actions/licensed/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: " + lockActionPrefix + "acquire-build-lock@" + staleSHA + "\n",
			},
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			findings, err := AnalyzePolicy(fixture(testCase.files), Policy{RequiredAcquireSHA: testSHA})
			if err != nil {
				t.Fatal(err)
			}
			if codes := findingCodes(findings); !strings.Contains(codes, "unapproved-acquire-ref") {
				t.Fatalf("expected exact acquire pin finding, got %s", codes)
			}
		})
	}
}

func TestCancellationPolicyRequiresImmutableAcquirePins(t *testing.T) {
	tests := []map[string]string{
		{".github/workflows/unity.yml": workflow("", "", "      - uses: "+lockActionPrefix+"acquire-build-lock@v1\n")},
		{
			".github/workflows/unity.yml":         workflow("", "", "      - uses: ./.github/actions/licensed\n"),
			".github/actions/licensed/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: " + lockActionPrefix + "acquire-build-lock@main\n",
		},
	}
	for _, files := range tests {
		findings, err := AnalyzeCancellationSafety(fixture(files))
		if err != nil {
			t.Fatal(err)
		}
		if codes := findingCodes(findings); !strings.Contains(codes, "mutable-acquire-ref") {
			t.Fatalf("expected mutable acquire ref finding, got %s", codes)
		}
	}
}

func TestCancellationPolicyTraversesPastFirstLicensedReference(t *testing.T) {
	tests := []struct {
		name  string
		files map[string]string
	}{
		{
			name: "job finds later mutable acquire",
			files: map[string]string{
				".github/workflows/unity.yml": workflow("", "", directAcquireStep()+"      - uses: "+lockActionPrefix+"acquire-build-lock@main\n"),
			},
		},
		{
			name: "composite finds later cycle",
			files: map[string]string{
				".github/workflows/unity.yml":      workflow("", "", "      - uses: ./.github/actions/outer\n"),
				".github/actions/outer/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: " + acquire + "\n    - uses: ./.github/actions/cycle\n",
				".github/actions/cycle/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/cycle\n",
			},
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			findings, err := AnalyzeCancellationSafety(fixture(testCase.files))
			if testCase.name == "job finds later mutable acquire" {
				if err != nil {
					t.Fatal(err)
				}
				if codes := findingCodes(findings); !strings.Contains(codes, "mutable-acquire-ref") {
					t.Fatalf("expected later mutable acquire finding, got %s", codes)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), "composite action cycle") {
				t.Fatalf("expected later composite cycle error, got %v", err)
			}
		})
	}
}

func TestCancellationPolicyFailsClosedOnMalformedGraphs(t *testing.T) {
	tests := []struct {
		name  string
		files map[string]string
	}{
		{name: "duplicate keys", files: map[string]string{".github/workflows/main.yml": "jobs: {}\njobs: {}\n"}},
		{name: "multiple documents", files: map[string]string{".github/workflows/main.yml": "jobs: {}\n---\njobs: {}\n"}},
		{name: "jobs is not a mapping", files: map[string]string{".github/workflows/main.yml": "jobs: []\n"}},
		{name: "steps is not a sequence", files: map[string]string{".github/workflows/main.yml": "jobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps: {}\n"}},
		{name: "step is not a mapping", files: map[string]string{".github/workflows/main.yml": "jobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n      - scalar\n"}},
		{name: "step uses is not a scalar", files: map[string]string{".github/workflows/main.yml": "jobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: {}\n"}},
		{name: "job uses is not a scalar", files: map[string]string{".github/workflows/main.yml": "jobs:\n  unity:\n    uses: []\n"}},
		{name: "job has uses and steps", files: map[string]string{".github/workflows/main.yml": "jobs:\n  unity:\n    uses: ./.github/workflows/called.yml\n    steps: []\n", ".github/workflows/called.yml": "jobs: {}\n"}},
		{name: "missing local action", files: map[string]string{".github/workflows/main.yml": "jobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/missing\n"}},
		{name: "action runs is not a mapping", files: map[string]string{
			".github/workflows/main.yml":   "jobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/a\n",
			".github/actions/a/action.yml": "runs: composite\n",
		}},
		{name: "composite step is not a mapping", files: map[string]string{
			".github/workflows/main.yml":   "jobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/a\n",
			".github/actions/a/action.yml": "runs:\n  using: composite\n  steps:\n    - scalar\n",
		}},
		{name: "composite uses is not a scalar", files: map[string]string{
			".github/workflows/main.yml":   "jobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/a\n",
			".github/actions/a/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: {}\n",
		}},
		{name: "called workflow cycle", files: map[string]string{
			".github/workflows/a.yml": "jobs:\n  call:\n    uses: ./.github/workflows/b.yml\n",
			".github/workflows/b.yml": "jobs:\n  call:\n    uses: ./.github/workflows/a.yml\n",
		}},
		{name: "composite action cycle", files: map[string]string{
			".github/workflows/main.yml":   "jobs:\n  unity:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/a\n",
			".github/actions/a/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/b\n",
			".github/actions/b/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/a\n",
		}},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := AnalyzeCancellationSafety(fixture(testCase.files)); err == nil {
				t.Fatal("expected fail-closed graph error")
			}
		})
	}
}
