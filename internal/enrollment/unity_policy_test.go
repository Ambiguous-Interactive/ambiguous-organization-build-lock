package enrollment

import (
	"strings"
	"testing"
	"time"
)

const (
	releaseActionRef   = lockActionPrefix + "release-build-lock@" + testSHA
	changeAction       = lockActionPrefix + "classify-unity-changes@" + testSHA
	classifierAction   = lockActionPrefix + "classify-unity-cleanup-evidence@" + testSHA
	gateAction         = lockActionPrefix + "require-confirmed-unity-cleanup@" + testSHA
	preflightActionRef = lockActionPrefix + "check-unity-runner-availability@" + testSHA
	validationAction   = lockActionPrefix + "require-unity-validation@" + testSHA
)

func unityAuditPolicy() UnityEnrollmentPolicy {
	return UnityEnrollmentPolicy{
		ApprovedLockSHAs:      []string{testSHA},
		ProtectedBranches:     []string{"main"},
		AllowWorkflowDispatch: true,
		Now:                   time.Date(2026, time.July, 27, 0, 0, 0, 0, time.UTC),
	}
}

func unityWorkflow(licensedSteps, aggregate string) string {
	return `name: Unity
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
concurrency:
  group: unity-${{ github.ref }}
  cancel-in-progress: false
jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: ` + preflightActionRef + `
  unity:
    needs: preflight
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: [self-hosted, linux]
    strategy:
      fail-fast: false
      matrix:
        mode: [EditMode]
    steps:
` + licensedSteps + aggregate
}

func safeLicensedSteps() string {
	return wrappedCleanupSteps("always()")
}

func unityFixture(files map[string]string) Snapshot {
	copyFiles := make(map[string]string, len(files)+1)
	for path, content := range files {
		copyFiles[path] = content
	}
	if _, exists := copyFiles[".github/actions/return-unity-license/action.yml"]; !exists {
		copyFiles[".github/actions/return-unity-license/action.yml"] = cleanupComposite("classify_return")
	}
	return fixture(copyFiles)
}

func safeAggregate() string {
	return `  aggregate:
    if: always()
    needs: [preflight, unity]
    runs-on: ubuntu-latest
    steps:
      - run: |
          test "${{ needs.preflight.result }}" = success
          test "${{ needs.unity.result }}" = success
`
}

func TestUnityEnrollmentRejectsUnprotectedPaidSerialJob(t *testing.T) {
	snapshot := unityFixture(map[string]string{
		".github/workflows/unity.yml": `on: [pull_request]
jobs:
  unity:
    runs-on: ubuntu-latest
    steps:
      - run: unity-editor -batchmode -serial "${UNITY_SERIAL}"
        env:
          UNITY_SERIAL: ${{ secrets.UNITY_SERIAL }}
`,
	})

	result, err := AnalyzeUnityEnrollment(snapshot, unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Inventory) != 1 || result.Inventory[0].Classification != "paid-serial" {
		t.Fatalf("unexpected inventory: %#v", result.Inventory)
	}
	if !strings.Contains(findingCodes(result.Findings), "missing-lock-acquire") {
		t.Fatalf("unprotected paid job was not rejected: %#v", result.Findings)
	}
}

func TestUnityEnrollmentAcceptsCompleteLifecycle(t *testing.T) {
	snapshot := unityFixture(map[string]string{
		".github/workflows/unity.yml": unityWorkflow(safeLicensedSteps(), safeAggregate()),
	})
	result, err := AnalyzeUnityEnrollment(snapshot, unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Findings) != 0 {
		t.Fatalf("complete lifecycle produced findings: %#v", result.Findings)
	}
	paid := 0
	for _, entry := range result.Inventory {
		if entry.Classification == "paid-serial" {
			paid++
		}
	}
	if paid != 1 {
		t.Fatalf("expected one paid job in inventory: %#v", result.Inventory)
	}
}

func TestUnityEnrollmentAcceptsCanonicalFallbackCleanup(t *testing.T) {
	licensedSteps := strings.Replace(
		safeLicensedSteps(),
		"      - id: acquire\n        uses: "+lockActionPrefix+"acquire-build-lock@"+testSHA,
		"      - id: acquire\n        uses: "+lockActionPrefix+"acquire-build-lock@"+testSHA+
			"\n        with:\n          lock-name: wallstop-organization-builds\n          holder-id-suffix: default",
		1,
	)
	snapshot := unityFixture(map[string]string{
		".github/workflows/unity.yml": unityWorkflow(licensedSteps, `  cleanup:
    if: ${{ always() && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) }}
    needs: unity
    runs-on: ubuntu-latest
    steps:
      - id: fallback_release
        if: always()
        uses: `+releaseActionRef+`
        with:
          lock-name: wallstop-organization-builds
          holder-id: ${{ github.repository }}:${{ github.run_id }}:unity:default
          holder-id-suffix: default
          runner-id: ${{ runner.name }}
          resource-cleanup-status: unknown
          resource-health: healthy
          resource-reason: return-terminated
        env:
          BUILD_LOCK_APP_ID: ${{ secrets.BUILD_LOCK_APP_ID }}
          BUILD_LOCK_APP_PRIVATE_KEY: ${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}
  aggregate:
    if: always()
    needs: [preflight, unity, cleanup]
    runs-on: ubuntu-latest
    steps:
      - shell: bash
        run: |
          test "${{ needs.preflight.result }}" = success
          test "${{ needs.unity.result }}" = success
      - shell: bash
        run: |
          test "${{ needs.unity.result }}" = success
          test "${{ needs.cleanup.result }}" = success
`),
	})
	result, err := AnalyzeUnityEnrollment(snapshot, unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Findings) != 0 {
		t.Fatalf("canonical paid lifecycle and fallback produced findings: %#v", result.Findings)
	}
	fallbacks := make([]UnityInventoryEntry, 0, 1)
	for _, entry := range result.Inventory {
		if entry.Classification == "fallback-cleanup" {
			fallbacks = append(fallbacks, entry)
		}
	}
	if len(fallbacks) != 1 || fallbacks[0].Job != "cleanup" {
		t.Fatalf("unexpected fallback inventory: %#v", result.Inventory)
	}
}

func TestUnityEnrollmentAcceptsTypedConditionalValidationGate(t *testing.T) {
	licensedSteps := strings.Replace(
		safeLicensedSteps(),
		"      - id: acquire\n        uses: "+lockActionPrefix+"acquire-build-lock@"+testSHA,
		"      - id: acquire\n        uses: "+lockActionPrefix+"acquire-build-lock@"+testSHA+
			"\n        with:\n          lock-name: wallstop-organization-builds\n          holder-id-suffix: qora",
		1,
	)
	workflow := `name: Unity
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
concurrency:
  group: unity-${{ github.ref }}
  cancel-in-progress: false
jobs:
  classify:
    runs-on: ubuntu-latest
    outputs:
      unity-required: ${{ steps.classify.outputs.unity-required }}
    steps:
      - uses: ` + classifierCheckoutRef + `
        with:
          fetch-depth: 0
          persist-credentials: false
      - id: classify
        uses: ` + changeAction + `
        with:
          event-name: ${{ github.event_name }}
          base-sha: ${{ github.event.pull_request.base.sha }}
          head-sha: ${{ github.event.pull_request.head.sha }}
  preflight:
    if: >-
      ${{
        github.actor != 'dependabot[bot]' &&
        (github.event_name != 'pull_request' ||
          github.event.pull_request.head.repo.full_name == github.repository)
      }}
    runs-on: ubuntu-latest
    steps:
      - uses: ` + preflightActionRef + `
  unity:
    needs: [classify, preflight]
    if: >-
      ${{
        needs.classify.result == 'success' &&
        needs.classify.outputs.unity-required == 'true' &&
        github.actor != 'dependabot[bot]' &&
        (github.event_name != 'pull_request' ||
          github.event.pull_request.head.repo.full_name == github.repository)
      }}
    runs-on: [self-hosted, Windows]
    steps:
` + licensedSteps + `  cleanup:
    if: ${{ always() && needs.unity.result != 'skipped' && github.actor != 'dependabot[bot]' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) }}
    needs: unity
    runs-on: ubuntu-latest
    outputs:
      cleanup-result: ${{ steps.fallback_release.outputs.cleanup-result }}
    steps:
      - id: fallback_release
        if: always()
        uses: ` + releaseActionRef + `
        with:
          lock-name: wallstop-organization-builds
          holder-id: ${{ github.repository }}:${{ github.run_id }}:unity:qora
          holder-id-suffix: qora
          runner-id: ${{ runner.name }}
          resource-cleanup-status: unknown
          resource-health: healthy
          resource-reason: return-terminated
        env:
          BUILD_LOCK_APP_ID: ${{ secrets.BUILD_LOCK_APP_ID }}
          BUILD_LOCK_APP_PRIVATE_KEY: ${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}
  aggregate:
    if: always()
    needs: [classify, preflight, unity, cleanup]
    runs-on: ubuntu-latest
    steps:
      - uses: ` + validationAction + `
        with:
          classifier-result: ${{ needs.classify.result }}
          unity-required: ${{ needs.classify.outputs.unity-required }}
          trusted-revision: ${{ github.actor != 'dependabot[bot]' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) }}
          preflight-result: ${{ needs.preflight.result }}
          unity-result: ${{ needs.unity.result }}
          fallback-result: ${{ needs.cleanup.result }}
          fallback-cleanup-result: ${{ needs.cleanup.outputs.cleanup-result }}
`
	snapshot := unityFixture(map[string]string{
		".github/workflows/unity.yml": workflow,
	})
	result, err := AnalyzeUnityEnrollment(snapshot, unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Findings) != 0 {
		t.Fatalf("typed conditional validation gate produced findings: %#v", result.Findings)
	}

	tests := []struct {
		name   string
		mutate func(string) string
	}{
		{
			name: "unapproved validation action",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					validationAction,
					lockActionPrefix+"require-unity-validation@abcdefabcdefabcdefabcdefabcdefabcdefabcd",
					1,
				)
			},
		},
		{
			name: "validation action suppresses failure",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"      - uses: "+validationAction,
					"      - uses: "+validationAction+"\n        continue-on-error: true",
					1,
				)
			},
		},
		{
			name: "aggregate runs consumer code before validation",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"    steps:\n      - uses: "+validationAction,
					"    steps:\n      - run: node spoof-validation.js\n      - uses: "+validationAction,
					1,
				)
			},
		},
		{
			name: "aggregate runs consumer code after validation",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"          fallback-cleanup-result: ${{ needs.cleanup.outputs.cleanup-result }}",
					"          fallback-cleanup-result: ${{ needs.cleanup.outputs.cleanup-result }}\n      - run: node spoof-validation.js",
					1,
				)
			},
		},
		{
			name: "aggregate omits classifier dependency",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"    needs: [classify, preflight, unity, cleanup]",
					"    needs: [preflight, unity, cleanup]",
					1,
				)
			},
		},
		{
			name: "classifier output comes from another job",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"unity-required: ${{ needs.classify.outputs.unity-required }}",
					"unity-required: ${{ needs.preflight.outputs.unity-required }}",
					1,
				)
			},
		},
		{
			name: "classifier job suppresses failure",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"  classify:\n    runs-on: ubuntu-latest",
					"  classify:\n    continue-on-error: true\n    runs-on: ubuntu-latest",
					1,
				)
			},
		},
		{
			name: "workflow preloads pull request code",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"concurrency:\n  group:",
					"env:\n  NODE_OPTIONS: --require=${{ github.workspace }}/spoof.js\nconcurrency:\n  group:",
					1,
				)
			},
		},
		{
			name: "classifier uses a container",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"  classify:\n    runs-on: ubuntu-latest",
					"  classify:\n    runs-on: ubuntu-latest\n    container: node:24",
					1,
				)
			},
		},
		{
			name: "classifier uses a non-fail-fast matrix",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"  classify:\n    runs-on: ubuntu-latest",
					"  classify:\n    strategy:\n      fail-fast: false\n      matrix:\n        shard: [one]\n    runs-on: ubuntu-latest",
					1,
				)
			},
		},
		{
			name: "licensed job inherits node preload",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"  unity:\n    needs:",
					"  unity:\n    env:\n      NODE_OPTIONS: --require=spoof.js\n    needs:",
					1,
				)
			},
		},
		{
			name: "classifier step suppresses failure",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"      - id: classify\n        uses: "+changeAction,
					"      - id: classify\n        continue-on-error: true\n        uses: "+changeAction,
					1,
				)
			},
		},
		{
			name: "classifier output is literal false",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"unity-required: ${{ steps.classify.outputs.unity-required }}",
					"unity-required: false",
					1,
				)
			},
		},
		{
			name: "classifier uses consumer shell",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"        uses: "+changeAction,
					"        run: echo \"unity-required=false\" >> \"$GITHUB_OUTPUT\"",
					1,
				)
			},
		},
		{
			name: "classifier aliases preflight role",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"preflight-result: ${{ needs.preflight.result }}",
					"preflight-result: ${{ needs.classify.result }}",
					1,
				)
			},
		},
		{
			name: "preflight has an extra executable step",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"      - uses: "+preflightActionRef,
					"      - uses: "+preflightActionRef+"\n      - run: echo unsafe",
					1,
				)
			},
		},
		{
			name: "fallback output comes from licensed job",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"fallback-cleanup-result: ${{ needs.cleanup.outputs.cleanup-result }}",
					"fallback-cleanup-result: ${{ needs.unity.outputs.cleanup-result }}",
					1,
				)
			},
		},
		{
			name: "fallback job spoofs noop output",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"cleanup-result: ${{ steps.fallback_release.outputs.cleanup-result }}",
					"cleanup-result: noop",
					1,
				)
			},
		},
		{
			name: "fallback targets another source job",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"${{ github.repository }}:${{ github.run_id }}:unity:qora",
					"${{ github.repository }}:${{ github.run_id }}:other:qora",
					1,
				)
			},
		},
		{
			name: "trust expression drops Dependabot guard",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"trusted-revision: ${{ github.actor != 'dependabot[bot]' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) }}",
					"trusted-revision: ${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}",
					1,
				)
			},
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			mutated := unityFixture(map[string]string{
				".github/workflows/unity.yml": testCase.mutate(workflow),
			})
			result, err := AnalyzeUnityEnrollment(mutated, unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			codes := findingCodes(result.Findings)
			if !strings.Contains(codes, "missing-unity-aggregate") ||
				!strings.Contains(codes, "missing-fallback-aggregate") {
				t.Fatalf("unsafe typed validation gate was accepted: %#v", result.Findings)
			}
		})
	}

	t.Run("direct composite caller preloads central lock action", func(t *testing.T) {
		mutatedWorkflow := strings.Replace(
			workflow,
			"    runs-on: [self-hosted, Windows]\n    steps:\n",
			"    runs-on: [self-hosted, Windows]\n    steps:\n"+
				"      - uses: ./.github/actions/preload-direct\n"+
				"        env:\n"+
				"          NODE_OPTIONS: --require=${{ github.workspace }}/spoof.js\n",
			1,
		)
		mutated := unityFixture(map[string]string{
			".github/workflows/unity.yml": mutatedWorkflow,
			".github/actions/preload-direct/action.yml": `name: Preload direct
runs:
  using: composite
  steps:
    - uses: ` + lockActionPrefix + `require-current-pr-head@` + testSHA + `
`,
		})
		result, err := AnalyzeUnityEnrollment(mutated, unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		codes := findingCodes(result.Findings)
		if !strings.Contains(codes, "missing-unity-aggregate") ||
			!strings.Contains(codes, "missing-fallback-aggregate") {
			t.Fatalf("direct composite caller environment was accepted: %#v", result.Findings)
		}
	})

	t.Run("nested composite caller preloads central lock action", func(t *testing.T) {
		mutatedWorkflow := strings.Replace(
			workflow,
			"    runs-on: [self-hosted, Windows]\n    steps:\n",
			"    runs-on: [self-hosted, Windows]\n    steps:\n"+
				"      - uses: ./.github/actions/preload-wrapper\n"+
				"        env:\n"+
				"          NODE_OPTIONS: --require=${{ github.workspace }}/spoof.js\n",
			1,
		)
		mutated := unityFixture(map[string]string{
			".github/workflows/unity.yml": mutatedWorkflow,
			".github/actions/preload-wrapper/action.yml": `name: Preload wrapper
runs:
  using: composite
  steps:
    - uses: ./.github/actions/preload-inner
`,
			".github/actions/preload-inner/action.yml": `name: Preload inner
runs:
  using: composite
  steps:
    - uses: ` + lockActionPrefix + `require-current-pr-head@` + testSHA + `
`,
		})
		result, err := AnalyzeUnityEnrollment(mutated, unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		codes := findingCodes(result.Findings)
		if !strings.Contains(codes, "missing-unity-aggregate") ||
			!strings.Contains(codes, "missing-fallback-aggregate") {
			t.Fatalf("composite caller environment was accepted: %#v", result.Findings)
		}
	})

	t.Run("preflight guard admits another actor", func(t *testing.T) {
		mutated := unityFixture(map[string]string{
			".github/workflows/unity.yml": strings.Replace(
				workflow,
				"github.actor != 'dependabot[bot]' &&",
				"github.actor != 'untrusted-bot' &&",
				1,
			),
		})
		result, err := AnalyzeUnityEnrollment(mutated, unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		codes := findingCodes(result.Findings)
		if !strings.Contains(codes, "missing-runner-preflight") ||
			!strings.Contains(codes, "missing-unity-aggregate") {
			t.Fatalf("unsafe preflight guard was accepted: %#v", result.Findings)
		}
	})
}

func TestUnityEnrollmentRejectsMalformedFallbackCleanup(t *testing.T) {
	base := `on:
  push:
    branches: [main]
jobs:
  unity:
    runs-on: ubuntu-latest
    steps:
      - id: acquire
        uses: ` + lockActionPrefix + `acquire-build-lock@` + testSHA + `
        with:
          lock-name: wallstop-organization-builds
          holder-id-suffix: qora
      - run: echo source
  cleanup:
    if: always()
    needs: unity
    runs-on: ubuntu-latest
    steps:
      - id: fallback_release
        if: always()
        uses: ` + releaseActionRef + `
        with:
          lock-name: wallstop-organization-builds
          holder-id: ${{ github.repository }}:${{ github.run_id }}:unity:qora
          holder-id-suffix: qora
          runner-id: ${{ runner.name }}
          resource-cleanup-status: unknown
          resource-health: healthy
          resource-reason: return-terminated
        env:
          BUILD_LOCK_APP_ID: ${{ secrets.BUILD_LOCK_APP_ID }}
          BUILD_LOCK_APP_PRIVATE_KEY: ${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}
  aggregate:
    if: always()
    needs: [unity, cleanup]
    runs-on: ubuntu-latest
    steps:
      - shell: bash
        run: |
          test "${{ needs.unity.result }}" = success
          test "${{ needs.cleanup.result }}" = success
`
	tests := []struct {
		name   string
		mutate func(string) string
		code   string
	}{
		{
			name: "source job is not paid",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"      - id: acquire\n        uses: "+lockActionPrefix+"acquire-build-lock@"+testSHA+"\n        with:\n          lock-name: wallstop-organization-builds\n          holder-id-suffix: qora\n",
					"",
					1,
				)
			},
			code: "invalid-fallback-release",
		},
		{
			name: "source acquire is disabled",
			mutate: func(value string) string {
				return strings.Replace(value, "      - id: acquire\n        uses:", "      - id: acquire\n        if: false\n        uses:", 1)
			},
			code: "invalid-fallback-release",
		},
		{
			name: "holder source is not a dependency",
			mutate: func(value string) string {
				return strings.Replace(value, ":unity:qora", ":other:qora", 1)
			},
			code: "invalid-fallback-release",
		},
		{
			name: "holder suffix does not match",
			mutate: func(value string) string {
				return strings.Replace(value, "holder-id-suffix: qora", "holder-id-suffix: other", 1)
			},
			code: "invalid-fallback-release",
		},
		{
			name: "holder suffix depends on source job context",
			mutate: func(value string) string {
				return strings.ReplaceAll(value, "qora", "${{ github.job }}")
			},
			code: "invalid-fallback-release",
		},
		{
			name: "holder suffix depends on source matrix context",
			mutate: func(value string) string {
				return strings.ReplaceAll(value, "qora", "${{ matrix.mode }}")
			},
			code: "invalid-fallback-release",
		},
		{
			name: "cleanup evidence claims confirmation",
			mutate: func(value string) string {
				return strings.Replace(value, "resource-cleanup-status: unknown", "resource-cleanup-status: confirmed", 1)
			},
			code: "invalid-fallback-release",
		},
		{
			name: "fallback targets another lock",
			mutate: func(value string) string {
				return strings.Replace(value, "lock-name: wallstop-organization-builds", "lock-name: another-lock", 1)
			},
			code: "invalid-fallback-release",
		},
		{
			name: "fallback targets another state branch",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"          holder-id: ${{ github.repository }}",
					"          state-branch: other-state\n          holder-id: ${{ github.repository }}",
					1,
				)
			},
			code: "invalid-fallback-release",
		},
		{
			name: "fallback depends on the lost self-hosted runner",
			mutate: func(value string) string {
				return strings.Replace(value, "  cleanup:\n    if: always()\n    needs: unity\n    runs-on: ubuntu-latest", "  cleanup:\n    if: always()\n    needs: unity\n    runs-on: [self-hosted, Windows]", 1)
			},
			code: "fallback-cleanup-not-hosted",
		},
		{
			name: "fallback runner is dynamic",
			mutate: func(value string) string {
				return strings.Replace(value, "  cleanup:\n    if: always()\n    needs: unity\n    runs-on: ubuntu-latest", "  cleanup:\n    if: always()\n    needs: unity\n    runs-on: ${{ vars.RUNNER }}", 1)
			},
			code: "fallback-cleanup-not-hosted",
		},
		{
			name: "fallback has an opaque executable step",
			mutate: func(value string) string {
				return strings.Replace(value, "  aggregate:\n", "      - run: ./activate-license.sh\n  aggregate:\n", 1)
			},
			code: "unexpected-fallback-step",
		},
		{
			name: "release action is mutable",
			mutate: func(value string) string {
				return strings.Replace(value, releaseActionRef, lockActionPrefix+"release-build-lock@main", 1)
			},
			code: "mutable-action-ref",
		},
		{
			name: "release action uses noncanonical repository casing",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					releaseActionRef,
					strings.Replace(releaseActionRef, "Ambiguous-Interactive", "ambiguous-interactive", 1),
					1,
				)
			},
			code: "invalid-fallback-release",
		},
		{
			name: "release action is not approved",
			mutate: func(value string) string {
				return strings.Replace(value, testSHA, "abcdefabcdefabcdefabcdefabcdefabcdefabcd", 1)
			},
			code: "unapproved-lock-ref",
		},
		{
			name: "writer credentials are job scoped",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"    runs-on: ubuntu-latest\n    steps:\n      - id: fallback_release",
					"    runs-on: ubuntu-latest\n    env:\n      APP_ID: ${{ secrets.BUILD_LOCK_APP_ID }}\n    steps:\n      - id: fallback_release",
					1,
				)
			},
			code: "job-scoped-unity-credential",
		},
		{
			name: "release receives an extra opaque credential",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"          BUILD_LOCK_APP_PRIVATE_KEY: ${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}",
					"          BUILD_LOCK_APP_PRIVATE_KEY: ${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}\n          LICENSE_TOKEN: ${{ secrets.OPAQUE_TOKEN }}",
					1,
				)
			},
			code: "invalid-fallback-release",
		},
		{
			name: "release writer credentials are missing",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"        env:\n          BUILD_LOCK_APP_ID: ${{ secrets.BUILD_LOCK_APP_ID }}\n          BUILD_LOCK_APP_PRIVATE_KEY: ${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}\n",
					"",
					1,
				)
			},
			code: "invalid-fallback-release",
		},
		{
			name: "fallback release suppresses failure",
			mutate: func(value string) string {
				return strings.Replace(value, "      - id: fallback_release\n        if: always()", "      - id: fallback_release\n        if: always()\n        continue-on-error: true", 1)
			},
			code: "invalid-fallback-release",
		},
		{
			name: "fallback job timeout is too short",
			mutate: func(value string) string {
				return strings.Replace(value, "    runs-on: ubuntu-latest\n    steps:\n      - id: fallback_release", "    runs-on: ubuntu-latest\n    timeout-minutes: 1\n    steps:\n      - id: fallback_release", 1)
			},
			code: "invalid-fallback-timeout",
		},
		{
			name: "fallback release timeout is too short",
			mutate: func(value string) string {
				return strings.Replace(value, "      - id: fallback_release\n        if: always()", "      - id: fallback_release\n        if: always()\n        timeout-minutes: 1", 1)
			},
			code: "invalid-fallback-release",
		},
		{
			name: "fallback can skip after upstream failure",
			mutate: func(value string) string {
				return strings.Replace(value, "  cleanup:\n    if: always()", "  cleanup:", 1)
			},
			code: "fallback-cleanup-not-always",
		},
		{
			name: "fallback condition excludes upstream failure",
			mutate: func(value string) string {
				return strings.Replace(value, "  cleanup:\n    if: always()", "  cleanup:\n    if: ${{ always() && needs.unity.result == 'success' }}", 1)
			},
			code: "fallback-cleanup-not-always",
		},
		{
			name: "fallback result is not aggregated",
			mutate: func(value string) string {
				return strings.Replace(value, "    needs: [unity, cleanup]", "    needs: unity", 1)
			},
			code: "missing-fallback-aggregate",
		},
		{
			name: "source result is not aggregated",
			mutate: func(value string) string {
				return strings.Replace(value, "    needs: [unity, cleanup]", "    needs: cleanup", 1)
			},
			code: "missing-fallback-aggregate",
		},
		{
			name: "aggregate shell ignores the checks",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"      - shell: bash\n        run: |\n          test \"${{ needs.unity.result }}\"",
					"      - shell: sh -c 'exit 0' {0}\n        run: |\n          test \"${{ needs.unity.result }}\"",
					1,
				)
			},
			code: "missing-fallback-aggregate",
		},
		{
			name: "aggregate depends on a lost self-hosted runner",
			mutate: func(value string) string {
				return strings.Replace(value, "  aggregate:\n    if: always()\n    needs: [unity, cleanup]\n    runs-on: ubuntu-latest", "  aggregate:\n    if: always()\n    needs: [unity, cleanup]\n    runs-on: [self-hosted, Windows]", 1)
			},
			code: "missing-fallback-aggregate",
		},
		{
			name: "aggregate waits for environment approval",
			mutate: func(value string) string {
				return strings.Replace(value, "  aggregate:\n    if: always()\n    needs: [unity, cleanup]\n    runs-on: ubuntu-latest", "  aggregate:\n    if: always()\n    needs: [unity, cleanup]\n    runs-on: ubuntu-latest\n    environment: unity", 1)
			},
			code: "missing-fallback-aggregate",
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			result, err := AnalyzeUnityEnrollment(
				unityFixture(map[string]string{".github/workflows/unity.yml": testCase.mutate(base)}),
				unityAuditPolicy(),
			)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(findingCodes(result.Findings), testCase.code) {
				t.Fatalf("missing %s: %#v", testCase.code, result.Findings)
			}
		})
	}
}

func TestUnityEnrollmentDoesNotDowngradeLicensedWorkToFallbackCleanup(t *testing.T) {
	base := `on:
  push:
    branches: [main]
jobs:
  unity:
    runs-on: ubuntu-latest
    steps:
      - run: echo source
  cleanup:
    if: always()
    needs: unity
    runs-on: ubuntu-latest
    steps:
      - id: fallback_release
        if: always()
        uses: ` + releaseActionRef + `
        with:
          lock-name: wallstop-organization-builds
          holder-id: ${{ github.repository }}:${{ github.run_id }}:unity:qora
          holder-id-suffix: qora
          runner-id: ${{ runner.name }}
          resource-cleanup-status: unknown
          resource-health: healthy
          resource-reason: return-terminated
        env:
          BUILD_LOCK_APP_ID: ${{ secrets.BUILD_LOCK_APP_ID }}
          BUILD_LOCK_APP_PRIVATE_KEY: ${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}
`
	tests := []struct {
		name string
		step string
	}{
		{
			name: "Unity credential",
			step: `      - run: echo credential
        env:
          UNITY_SERIAL: ${{ secrets.UNITY_SERIAL }}
`,
		},
		{
			name: "Unity activation",
			step: `      - run: unity-editor -batchmode
`,
		},
		{
			name: "lock acquire",
			step: `      - id: acquire
        uses: ` + lockActionPrefix + `acquire-build-lock@` + testSHA + `
`,
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			workflow := base + testCase.step
			result, err := AnalyzeUnityEnrollment(
				unityFixture(map[string]string{".github/workflows/unity.yml": workflow}),
				unityAuditPolicy(),
			)
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range result.Inventory {
				if entry.Job == "cleanup" && entry.Classification == "fallback-cleanup" {
					t.Fatalf("licensed work was downgraded to fallback cleanup: %#v", result.Inventory)
				}
			}
			if !strings.Contains(findingCodes(result.Findings), "missing-unity-return") {
				t.Fatalf("full paid lifecycle audit did not run: %#v", result.Findings)
			}
		})
	}
}

func TestUnityEnrollmentClassifiesReviewedSyntheticFixture(t *testing.T) {
	policy := unityAuditPolicy()
	policy.Exceptions = []UnityPolicyException{{
		Repository:     "Ambiguous-Interactive/fixture",
		Path:           ".github/workflows/synthetic.yml",
		Classification: "synthetic",
		Owner:          "unity-platform",
		ExpiresAt:      "2026-08-27T00:00:00Z",
	}}
	snapshot := unityFixture(map[string]string{
		".github/workflows/synthetic.yml": `on: workflow_dispatch
jobs:
  fixture:
    runs-on: ubuntu-latest
    steps:
      - run: echo 'UNITY_SERIAL is fixture text; no organization credential is referenced'
`,
	})
	result, err := AnalyzeUnityEnrollment(snapshot, policy)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Findings) != 0 {
		t.Fatalf("reviewed fixture produced findings: %#v", result.Findings)
	}
	if len(result.Inventory) != 1 || result.Inventory[0].Classification != "synthetic" {
		t.Fatalf("unexpected inventory: %#v", result.Inventory)
	}
}

func TestUnityEnrollmentExceptionCannotHideOpaqueCredentialJob(t *testing.T) {
	policy := unityAuditPolicy()
	policy.Exceptions = []UnityPolicyException{{
		Repository:     "Ambiguous-Interactive/fixture",
		Path:           ".github/workflows/opaque.yml",
		Classification: "synthetic",
		Owner:          "unity-platform",
		ExpiresAt:      "2026-08-27T00:00:00Z",
	}}
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/opaque.yml": `on:
  push:
    branches: [main]
jobs:
  opaque:
    runs-on: ubuntu-latest
    env:
      TOKEN: ${{ secrets['UNITY_SERIAL'] }}
    steps:
      - run: ./opaque-tool
`,
	}), policy)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Inventory) != 1 || result.Inventory[0].Classification != "paid-serial" ||
		!strings.Contains(findingCodes(result.Findings), "missing-lock-acquire") {
		t.Fatalf("credential-bearing opaque job escaped paid policy: %#v", result)
	}
}

func TestUnityEnrollmentExceptionCannotHideDynamicCredentialIndex(t *testing.T) {
	policy := unityAuditPolicy()
	policy.Exceptions = []UnityPolicyException{{
		Repository:     "Ambiguous-Interactive/fixture",
		Path:           ".github/workflows/opaque.yml",
		Classification: "synthetic",
		Owner:          "unity-platform",
		ExpiresAt:      "2026-08-27T00:00:00Z",
	}}
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/opaque.yml": `on:
  push:
    branches: [main]
env:
  SECRET_NAME: UNITY_SERIAL
jobs:
  opaque:
    runs-on: ubuntu-latest
    env:
      TOKEN: ${{ secrets[env.SECRET_NAME] }}
    steps:
      - run: ./opaque-tool
`,
	}), policy)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Inventory) != 1 || result.Inventory[0].Classification != "paid-serial" ||
		!strings.Contains(findingCodes(result.Findings), "missing-lock-acquire") {
		t.Fatalf("dynamic credential index escaped paid policy: %#v", result)
	}
}

func TestUnityEnrollmentRejectsExpiredException(t *testing.T) {
	policy := unityAuditPolicy()
	policy.Exceptions = []UnityPolicyException{{
		Repository:     "Ambiguous-Interactive/fixture",
		Path:           ".github/workflows/synthetic.yml",
		Classification: "synthetic",
		Owner:          "unity-platform",
		ExpiresAt:      "2026-07-26T23:59:59Z",
	}}
	snapshot := unityFixture(map[string]string{
		".github/workflows/synthetic.yml": `on: workflow_dispatch
jobs:
  fixture:
    runs-on: ubuntu-latest
    steps:
      - run: echo UNITY_SERIAL
`,
	})
	result, err := AnalyzeUnityEnrollment(snapshot, policy)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(findingCodes(result.Findings), "expired-policy-exception") {
		t.Fatalf("expired exception was not rejected: %#v", result.Findings)
	}
}

func TestUnityEnrollmentRejectsMissingSafetySurfaces(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(string) string
		code   string
	}{
		{"runner preflight", func(value string) string {
			return strings.Replace(value, "    needs: preflight\n", "", 1)
		}, "missing-runner-preflight"},
		{"disabled runner preflight step", func(value string) string {
			return strings.Replace(value, "      - uses: "+preflightActionRef, "      - if: false\n        uses: "+preflightActionRef, 1)
		}, "missing-runner-preflight"},
		{"disabled acquire", func(value string) string {
			return strings.Replace(value, "      - id: acquire\n        uses:", "      - id: acquire\n        if: false\n        uses:", 1)
		}, "missing-lock-acquire"},
		{"aggregate", func(value string) string {
			return strings.Split(value, "  aggregate:")[0]
		}, "missing-unity-aggregate"},
		{"final gate", func(value string) string {
			return strings.Replace(value, "        uses: "+gateAction, "        uses: actions/checkout@main", 1)
		}, "missing-cleanup-gate"},
		{"always release", func(value string) string {
			return strings.Replace(value, "      - id: release\n        if: always()", "      - id: release", 1)
		}, "release-not-always"},
		{"environment gate", func(value string) string {
			return strings.Replace(value, "    runs-on: [self-hosted, linux]", "    runs-on: [self-hosted, linux]\n    environment: unity", 1)
		}, "approval-environment"},
		{"job credential", func(value string) string {
			return strings.Replace(value, "    strategy:", "    env:\n      UNITY_SERIAL: ${{ secrets.UNITY_SERIAL }}\n    strategy:", 1)
		}, "job-scoped-unity-credential"},
		{"aliased job credential", func(value string) string {
			return strings.Replace(value, "    strategy:", "    env:\n      SERIAL_ALIAS: ${{ secrets.UNITY_SERIAL }}\n    strategy:", 1)
		}, "job-scoped-unity-credential"},
		{"bracket job credential", func(value string) string {
			return strings.Replace(value, "    strategy:", "    env:\n      SERIAL_ALIAS: ${{ secrets['UNITY_SERIAL'] }}\n    strategy:", 1)
		}, "job-scoped-unity-credential"},
		{"unconditional pull request", func(value string) string {
			return strings.Replace(value, "    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository\n", "", 1)
		}, "ineligible-unity-trigger"},
		{"unconditional same-repository guard", func(value string) string {
			return strings.Replace(value, "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository", "github.event_name != 'pull_request' || true", 1)
		}, "ineligible-unity-trigger"},
		{"mutable action", func(value string) string {
			return strings.Replace(value, releaseActionRef, lockActionPrefix+"release-build-lock@main", 1)
		}, "mutable-action-ref"},
		{"unbounded push", func(value string) string {
			return strings.Replace(value, "  push:\n    branches: [main]", "  push:", 1)
		}, "ineligible-unity-trigger"},
		{"tag only push", func(value string) string {
			return strings.Replace(value, "  push:\n    branches: [main]", "  push:\n    tags: ['v*']", 1)
		}, "ineligible-unity-trigger"},
		{"wildcard push", func(value string) string {
			return strings.Replace(value, "    branches: [main]", "    branches: ['*']", 1)
		}, "ineligible-unity-trigger"},
		{"unapproved branch", func(value string) string {
			return strings.Replace(value, "    branches: [main]", "    branches: [develop]", 1)
		}, "ineligible-unity-trigger"},
		{"cleanup gate evidence", func(value string) string {
			return strings.Replace(value, "          release-outcome: ${{ steps.release.outcome }}\n", "", 1)
		}, "cleanup-gate-inputs-not-typed"},
	}
	base := unityWorkflow(safeLicensedSteps(), safeAggregate())
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			result, err := AnalyzeUnityEnrollment(
				unityFixture(map[string]string{".github/workflows/unity.yml": testCase.mutate(base)}),
				unityAuditPolicy(),
			)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(findingCodes(result.Findings), testCase.code) {
				t.Fatalf("missing %s: %#v", testCase.code, result.Findings)
			}
		})
	}
}

func TestUnityEnrollmentRejectsAcquireBehindDisabledComposite(t *testing.T) {
	steps := strings.Replace(
		safeLicensedSteps(),
		"      - id: acquire\n        uses: "+lockActionPrefix+"acquire-build-lock@"+testSHA,
		"      - id: acquire\n        if: false\n        uses: ./.github/actions/acquire-wrapper",
		1,
	)
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": unityWorkflow(steps, safeAggregate()),
		".github/actions/acquire-wrapper/action.yml": `name: Acquire wrapper
runs:
  using: composite
  steps:
    - id: inner_acquire
      uses: ` + lockActionPrefix + `acquire-build-lock@` + testSHA + `
`,
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(findingCodes(result.Findings), "missing-lock-acquire") {
		t.Fatalf("disabled acquire composite passed: %#v", result.Findings)
	}
}

func TestUnityEnrollmentDisabledPreflightCannotSatisfyAggregate(t *testing.T) {
	workflow := unityWorkflow(safeLicensedSteps(), safeAggregate())
	workflow = strings.Replace(
		workflow,
		"      - uses: "+preflightActionRef,
		"      - if: false\n        uses: "+preflightActionRef,
		1,
	)
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": workflow,
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	codes := findingCodes(result.Findings)
	if !strings.Contains(codes, "missing-runner-preflight") ||
		!strings.Contains(codes, "missing-unity-aggregate") {
		t.Fatalf("disabled preflight satisfied lifecycle evidence: %#v", result.Findings)
	}
}

func TestUnityEnrollmentRejectsContinueOnErrorLifecycleEvidence(t *testing.T) {
	tests := []struct {
		name              string
		workflowMutation  func(string) string
		compositeMutation func(string) string
		code              string
	}{
		{
			name: "preflight job",
			workflowMutation: func(value string) string {
				return strings.Replace(value, "  preflight:\n    runs-on:", "  preflight:\n    continue-on-error: true\n    runs-on:", 1)
			},
			code: "missing-runner-preflight",
		},
		{
			name: "preflight step",
			workflowMutation: func(value string) string {
				return strings.Replace(value, "      - uses: "+preflightActionRef, "      - continue-on-error: true\n        uses: "+preflightActionRef, 1)
			},
			code: "missing-runner-preflight",
		},
		{
			name: "aggregate job",
			workflowMutation: func(value string) string {
				return strings.Replace(value, "  aggregate:\n    if:", "  aggregate:\n    continue-on-error: true\n    if:", 1)
			},
			code: "missing-unity-aggregate",
		},
		{
			name: "aggregate step",
			workflowMutation: func(value string) string {
				return strings.Replace(value, "      - run: |", "      - continue-on-error: true\n        run: |", 1)
			},
			code: "missing-unity-aggregate",
		},
		{
			name: "acquire",
			workflowMutation: func(value string) string {
				return strings.Replace(value, "      - id: acquire\n        uses:", "      - id: acquire\n        continue-on-error: true\n        uses:", 1)
			},
			code: "missing-lock-acquire",
		},
		{
			name: "licensed job",
			workflowMutation: func(value string) string {
				return strings.Replace(value, "  unity:\n    needs:", "  unity:\n    continue-on-error: true\n    needs:", 1)
			},
			code: "missing-lock-acquire",
		},
		{
			name: "acquire expression",
			workflowMutation: func(value string) string {
				return strings.Replace(value, "      - id: acquire\n        uses:", "      - id: acquire\n        continue-on-error: ${{ false }}\n        uses:", 1)
			},
			code: "missing-lock-acquire",
		},
		{
			name: "cleanup wrapper",
			workflowMutation: func(value string) string {
				return strings.Replace(value, "      - id: return_cleanup\n        if:", "      - id: return_cleanup\n        continue-on-error: true\n        if:", 1)
			},
			code: "release-inputs-not-typed",
		},
		{
			name:             "classifier",
			workflowMutation: func(value string) string { return value },
			compositeMutation: func(value string) string {
				return strings.Replace(value, "    - id: classify_return\n      if:", "    - id: classify_return\n      continue-on-error: true\n      if:", 1)
			},
			code: "release-inputs-not-typed",
		},
		{
			name: "release",
			workflowMutation: func(value string) string {
				return strings.Replace(value, "      - id: release\n        if:", "      - id: release\n        continue-on-error: true\n        if:", 1)
			},
			code: "missing-typed-release",
		},
		{
			name: "final gate",
			workflowMutation: func(value string) string {
				return strings.Replace(value, "      - name: Require confirmed cleanup\n        if:", "      - name: Require confirmed cleanup\n        continue-on-error: true\n        if:", 1)
			},
			code: "missing-cleanup-gate",
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			workflowMutation := testCase.workflowMutation
			if workflowMutation == nil {
				workflowMutation = func(value string) string { return value }
			}
			compositeMutation := testCase.compositeMutation
			if compositeMutation == nil {
				compositeMutation = func(value string) string { return value }
			}
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml": workflowMutation(
					unityWorkflow(safeLicensedSteps(), safeAggregate()),
				),
				".github/actions/return-unity-license/action.yml": compositeMutation(
					cleanupComposite("classify_return"),
				),
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(findingCodes(result.Findings), testCase.code) {
				t.Fatalf("continue-on-error %s passed: %#v", testCase.name, result.Findings)
			}
		})
	}
}

func TestUnityEnrollmentRejectsAcquireBehindContinueOnErrorComposite(t *testing.T) {
	steps := strings.Replace(
		safeLicensedSteps(),
		"      - id: acquire\n        uses: "+lockActionPrefix+"acquire-build-lock@"+testSHA,
		"      - id: acquire\n        continue-on-error: true\n        uses: ./.github/actions/acquire-wrapper",
		1,
	)
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": unityWorkflow(steps, safeAggregate()),
		".github/actions/acquire-wrapper/action.yml": `name: Acquire wrapper
runs:
  using: composite
  steps:
    - id: inner_acquire
      uses: ` + lockActionPrefix + `acquire-build-lock@` + testSHA + `
`,
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(findingCodes(result.Findings), "missing-lock-acquire") {
		t.Fatalf("continue-on-error acquire composite passed: %#v", result.Findings)
	}
}

func TestUnityEnrollmentAcceptsLiteralFalseContinueOnError(t *testing.T) {
	workflow := unityWorkflow(safeLicensedSteps(), safeAggregate())
	workflow = strings.Replace(
		workflow,
		"      - id: release\n        if:",
		"      - id: release\n        continue-on-error: false\n        if:",
		1,
	)
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": workflow,
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Findings) != 0 {
		t.Fatalf("literal false continue-on-error produced findings: %#v", result.Findings)
	}
}

func TestUnityEnrollmentRequiresReviewedWorkflowDispatch(t *testing.T) {
	policy := unityAuditPolicy()
	policy.AllowWorkflowDispatch = false
	result, err := AnalyzeUnityEnrollment(
		unityFixture(map[string]string{".github/workflows/unity.yml": unityWorkflow(safeLicensedSteps(), safeAggregate())}),
		policy,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(findingCodes(result.Findings), "ineligible-unity-trigger") {
		t.Fatalf("unreviewed workflow_dispatch passed: %#v", result.Findings)
	}
}

func TestUnityEnrollmentRejectsAggregateThatCannotFailClosed(t *testing.T) {
	tests := []struct {
		name      string
		aggregate string
	}{
		{
			name: "echo only",
			aggregate: `  aggregate:
    if: always()
    needs: [preflight, unity]
    runs-on: ubuntu-latest
    steps:
      - run: echo '${{ needs.unity.result }} ${{ needs.preflight.result }}'
`,
		},
		{
			name: "licensed result only",
			aggregate: `  aggregate:
    if: always()
    needs: [preflight, unity]
    runs-on: ubuntu-latest
    steps:
      - run: test "${{ needs.unity.result }}" = success
`,
		},
		{
			name: "false guarded always",
			aggregate: `  aggregate:
    if: ${{ false && always() }}
    needs: [preflight, unity]
    runs-on: ubuntu-latest
    steps:
      - run: |
          test "${{ needs.preflight.result }}" = success
          test "${{ needs.unity.result }}" = success
`,
		},
		{
			name: "missing preflight dependency",
			aggregate: `  aggregate:
    if: always()
    needs: unity
    runs-on: ubuntu-latest
    steps:
      - run: |
          test "${{ needs.preflight.result }}" = success
          test "${{ needs.unity.result }}" = success
`,
		},
		{
			name: "ignored test failure",
			aggregate: `  aggregate:
    if: always()
    needs: [preflight, unity]
    runs-on: ubuntu-latest
    steps:
      - run: |
          test "${{ needs.preflight.result }}" = success || echo ignored
          test "${{ needs.unity.result }}" = success
`,
		},
		{
			name: "unsafe shell template",
			aggregate: `  aggregate:
    if: always()
    needs: [preflight, unity]
    runs-on: ubuntu-latest
    steps:
      - shell: bash {0}
        run: |
          test "${{ needs.preflight.result }}" = success
          test "${{ needs.unity.result }}" = success
`,
		},
		{
			name: "fallthrough after tests",
			aggregate: `  aggregate:
    if: always()
    needs: [preflight, unity]
    runs-on: ubuntu-latest
    steps:
      - run: |
          test "${{ needs.preflight.result }}" = success
          test "${{ needs.unity.result }}" = success
          echo done
`,
		},
		{
			name: "unreachable failure",
			aggregate: `  aggregate:
    if: always()
    needs: [preflight, unity]
    runs-on: ubuntu-latest
    steps:
      - run: |
          exit 0
          test "${{ needs.preflight.result }}" = success
          test "${{ needs.unity.result }}" = success
`,
		},
		{
			name: "disabled enforcement step",
			aggregate: `  aggregate:
    if: always()
    needs: [preflight, unity]
    runs-on: ubuntu-latest
    steps:
      - if: false
        run: |
          test "${{ needs.preflight.result }}" = success
          test "${{ needs.unity.result }}" = success
`,
		},
		{
			name: "conditional enforcement step",
			aggregate: `  aggregate:
    if: always()
    needs: [preflight, unity]
    runs-on: ubuntu-latest
    steps:
      - if: ${{ steps.prepare.outcome == 'success' }}
        run: |
          test "${{ needs.preflight.result }}" = success
          test "${{ needs.unity.result }}" = success
`,
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			result, err := AnalyzeUnityEnrollment(
				unityFixture(map[string]string{
					".github/workflows/unity.yml": unityWorkflow(safeLicensedSteps(), testCase.aggregate),
				}),
				unityAuditPolicy(),
			)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(findingCodes(result.Findings), "missing-unity-aggregate") {
				t.Fatalf("non-enforcing aggregate passed: %#v", result.Findings)
			}
		})
	}
}

func TestUnityEnrollmentAggregateUsesPaidJobsPreflight(t *testing.T) {
	value := unityWorkflow(safeLicensedSteps(), safeAggregate())
	value = strings.Replace(value, "  unity:\n    needs: preflight", `  other-preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: `+preflightActionRef+`
  unity:
    needs: other-preflight`, 1)
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": value,
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(findingCodes(result.Findings), "missing-unity-aggregate") {
		t.Fatalf("aggregate accepted a different preflight dependency: %#v", result.Findings)
	}
}

func TestUnityEnrollmentRejectsFabricatedDirectReturnEvidence(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(string) string
	}{
		{"hardcoded completion", func(value string) string {
			return strings.Replace(value, `echo "return-command-completed=$command_completed"`, `echo "return-command-completed=true"`, 1)
		}},
		{"ignored command failure", func(value string) string {
			return strings.Replace(value, `unity-editor -batchmode -returnlicense -logFile "$return_log"`, `unity-editor -batchmode -returnlicense -logFile "$return_log" || true`, 1)
		}},
		{"fabricated exit code", func(value string) string {
			return strings.Replace(value, "return_exit_code=$?", "return_exit_code=0", 1)
		}},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml": unityWorkflow(safeLicensedSteps(), safeAggregate()),
				".github/actions/return-unity-license/action.yml": testCase.mutate(
					cleanupComposite("classify_return"),
				),
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(findingCodes(result.Findings), "missing-unity-return") {
				t.Fatalf("fabricated direct return passed: %#v", result.Findings)
			}
		})
	}
}

func TestUnityEnrollmentDetectsPaidCredentialsThroughAliasesAndComposites(t *testing.T) {
	tests := []struct {
		name  string
		files map[string]string
	}{
		{
			name: "workflow env",
			files: map[string]string{
				".github/workflows/unity.yml": `on:
  push:
    branches: [main]
env:
  SERIAL: ${{ secrets.UNITY_SERIAL }}
jobs:
  unity:
    runs-on: ubuntu-latest
    steps:
      - run: unity-editor -batchmode -serial "${SERIAL}"
`,
			},
		},
		{
			name: "aliased job env",
			files: map[string]string{
				".github/workflows/unity.yml": `on:
  push:
    branches: [main]
jobs:
  unity:
    runs-on: ubuntu-latest
    env:
      SERIAL: ${{ secrets.UNITY_SERIAL }}
    steps:
      - run: unity-editor -batchmode -serial "${SERIAL}"
`,
			},
		},
		{
			name: "local composite",
			files: map[string]string{
				".github/workflows/unity.yml": `on:
  push:
    branches: [main]
jobs:
  unity:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/run-unity
        with:
          serial: ${{ secrets.UNITY_SERIAL }}
`,
				".github/actions/run-unity/action.yml": `name: Run Unity
inputs:
  serial:
    required: true
runs:
  using: composite
  steps:
    - shell: bash
      run: unity-editor -batchmode -serial "${{ inputs.serial }}"
`,
			},
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			result, err := AnalyzeUnityEnrollment(unityFixture(testCase.files), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Inventory) != 1 || result.Inventory[0].Classification != "paid-serial" ||
				!strings.Contains(findingCodes(result.Findings), "missing-lock-acquire") {
				t.Fatalf("paid alias/composite escaped audit: %#v", result)
			}
		})
	}
}

func TestUnityEnrollmentRequiresCoherentCleanupProvenance(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(string) string
		code   string
	}{
		{"unrelated release producer", func(value string) string {
			return strings.ReplaceAll(value, "steps.release.", "steps.other.")
		}, "cleanup-gate-inputs-not-typed"},
		{"release false guarded", func(value string) string {
			return strings.Replace(value, "      - id: release\n        if: always()", "      - id: release\n        if: ${{ false && always() }}", 1)
		}, "release-not-always"},
		{"gate false guarded", func(value string) string {
			return strings.Replace(value, "      - name: Require confirmed cleanup\n        if: always()", "      - name: Require confirmed cleanup\n        if: ${{ false && always() }}", 1)
		}, "cleanup-gate-not-always"},
		{"gate missing always", func(value string) string {
			return strings.Replace(value, "      - name: Require confirmed cleanup\n        if: always()", "      - name: Require confirmed cleanup", 1)
		}, "cleanup-gate-not-always"},
	}
	base := unityWorkflow(safeLicensedSteps(), safeAggregate())
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			result, err := AnalyzeUnityEnrollment(
				unityFixture(map[string]string{".github/workflows/unity.yml": testCase.mutate(base)}),
				unityAuditPolicy(),
			)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(findingCodes(result.Findings), testCase.code) {
				t.Fatalf("missing %s: %#v", testCase.code, result.Findings)
			}
		})
	}
}

func TestUnityEnrollmentRejectsFalseGuardAroundCleanupComposite(t *testing.T) {
	workflow := unityWorkflow(
		`      - id: acquire
        uses: `+lockActionPrefix+`acquire-build-lock@`+testSHA+`
      - uses: ./.github/actions/lifecycle
        if: false
`,
		safeAggregate(),
	)
	composite := `name: Lifecycle
runs:
  using: composite
  steps:
` + safeLicensedSteps()
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml":          workflow,
		".github/actions/lifecycle/action.yml": composite,
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	codes := findingCodes(result.Findings)
	if !strings.Contains(codes, "classifier-not-always") ||
		!strings.Contains(codes, "release-not-always") ||
		!strings.Contains(codes, "cleanup-gate-not-always") {
		t.Fatalf("false-guarded composite cleanup passed: %#v", result.Findings)
	}
}

func wrappedCleanupSteps(parentCondition string) string {
	return `      - id: acquire
        uses: ` + lockActionPrefix + `acquire-build-lock@` + testSHA + `
      - name: Run Unity
        if: steps.acquire.outputs.acquired == 'true'
        run: unity-editor -batchmode -serial "${UNITY_SERIAL}"
        env:
          UNITY_SERIAL: ${{ secrets.UNITY_SERIAL }}
      - id: return_cleanup
        if: ` + parentCondition + `
        uses: ./.github/actions/return-unity-license
      - id: release
        if: always()
        uses: ` + releaseActionRef + `
        with:
          resource-cleanup-status: ${{ steps.return_cleanup.outputs.resource-cleanup-status }}
          resource-health: ${{ steps.return_cleanup.outputs.resource-health }}
          resource-reason: ${{ steps.return_cleanup.outputs.resource-reason }}
      - name: Require confirmed cleanup
        if: always()
        uses: ` + gateAction + `
        with:
          acquired: ${{ steps.acquire.outputs.acquired }}
          classification-complete: ${{ steps.return_cleanup.outputs.classification-complete }}
          cleanup-status: ${{ steps.return_cleanup.outputs.resource-cleanup-status }}
          cleanup-health: ${{ steps.return_cleanup.outputs.resource-health }}
          cleanup-reason: ${{ steps.return_cleanup.outputs.resource-reason }}
          release-outcome: ${{ steps.release.outcome }}
          cleanup-result: ${{ steps.release.outputs.cleanup-result }}
          released: ${{ steps.release.outputs.released }}
          release-health: ${{ steps.release.outputs.resource-health }}
          release-reason: ${{ steps.release.outputs.resource-reason }}
`
}

func cleanupComposite(outputProducer string) string {
	return `name: Return Unity
outputs:
  resource-cleanup-status:
    value: ${{ steps.` + outputProducer + `.outputs.resource-cleanup-status }}
  resource-health:
    value: ${{ steps.` + outputProducer + `.outputs.resource-health }}
  resource-reason:
    value: ${{ steps.` + outputProducer + `.outputs.resource-reason }}
  classification-complete:
    value: ${{ steps.` + outputProducer + `.outputs.classification-complete }}
runs:
  using: composite
  steps:
    - id: capture_return
      if: always()
      shell: bash
      run: |
        return_log="${RUNNER_TEMP}/return.log"
        command_completed=false
        evidence_capture_complete=false
        set +e
        unity-editor -batchmode -returnlicense -logFile "$return_log"
        return_exit_code=$?
        set -e
        command_completed=true
        evidence_capture_complete=true
        echo "return-log-path=$return_log" >> "$GITHUB_OUTPUT"
        echo "return-command-completed=$command_completed" >> "$GITHUB_OUTPUT"
        echo "return-exit-code=$return_exit_code" >> "$GITHUB_OUTPUT"
        echo "evidence-capture-complete=$evidence_capture_complete" >> "$GITHUB_OUTPUT"
    - id: classify_return
      if: always()
      uses: ` + classifierAction + `
      with:
        return-log-path: ${{ steps.capture_return.outputs.return-log-path }}
        return-command-completed: ${{ steps.capture_return.outputs.return-command-completed }}
        return-exit-code: ${{ steps.capture_return.outputs.return-exit-code }}
        evidence-capture-complete: ${{ steps.capture_return.outputs.evidence-capture-complete }}
`
}

func TestUnityEnrollmentAcceptsValidatedCleanupCompositeWrapper(t *testing.T) {
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": unityWorkflow(
			wrappedCleanupSteps("always()"),
			safeAggregate(),
		),
		".github/actions/return-unity-license/action.yml": cleanupComposite("classify_return"),
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Findings) != 0 {
		t.Fatalf("validated cleanup wrapper produced findings: %#v", result.Findings)
	}
}

func TestUnityEnrollmentRejectsTamperedCleanupCompositeOutput(t *testing.T) {
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": unityWorkflow(
			wrappedCleanupSteps("always()"),
			safeAggregate(),
		),
		".github/actions/return-unity-license/action.yml": cleanupComposite("unrelated"),
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	codes := findingCodes(result.Findings)
	if !strings.Contains(codes, "release-inputs-not-typed") ||
		!strings.Contains(codes, "cleanup-gate-inputs-not-typed") {
		t.Fatalf("tampered cleanup forwarding passed: %#v", result.Findings)
	}
}

func TestUnityEnrollmentRejectsFalseParentOnValidatedCleanupComposite(t *testing.T) {
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": unityWorkflow(
			wrappedCleanupSteps("${{ false && always() }}"),
			safeAggregate(),
		),
		".github/actions/return-unity-license/action.yml": cleanupComposite("classify_return"),
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	codes := findingCodes(result.Findings)
	if !strings.Contains(codes, "missing-unity-return") ||
		!strings.Contains(codes, "release-inputs-not-typed") {
		t.Fatalf("false-parent cleanup wrapper passed: %#v", result.Findings)
	}
}

func TestUnityEnrollmentRejectsFailureDependentCleanupConditions(t *testing.T) {
	tests := []struct {
		name              string
		workflowMutation  func(string) string
		compositeMutation func(string) string
		code              string
	}{
		{
			name:             "return",
			workflowMutation: func(value string) string { return value },
			compositeMutation: func(value string) string {
				return strings.Replace(value, "    - id: capture_return\n      if: always()", "    - id: capture_return\n      if: ${{ always() && steps.build.outcome == 'success' }}", 1)
			},
			code: "missing-unity-return",
		},
		{
			name:             "classifier",
			workflowMutation: func(value string) string { return value },
			compositeMutation: func(value string) string {
				return strings.Replace(value, "    - id: classify_return\n      if: always()", "    - id: classify_return\n      if: ${{ always() && steps.build.outcome == 'success' }}", 1)
			},
			code: "release-inputs-not-typed",
		},
		{
			name: "release",
			workflowMutation: func(value string) string {
				return strings.Replace(value, "      - id: release\n        if: always()", "      - id: release\n        if: ${{ always() && steps.build.outcome == 'success' }}", 1)
			},
			compositeMutation: func(value string) string { return value },
			code:              "release-not-always",
		},
		{
			name: "gate",
			workflowMutation: func(value string) string {
				return strings.Replace(value, "      - name: Require confirmed cleanup\n        if: always()", "      - name: Require confirmed cleanup\n        if: ${{ always() && steps.build.outcome == 'success' }}", 1)
			},
			compositeMutation: func(value string) string { return value },
			code:              "cleanup-gate-not-always",
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			workflow := testCase.workflowMutation(
				unityWorkflow(safeLicensedSteps(), safeAggregate()),
			)
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml": workflow,
				".github/actions/return-unity-license/action.yml": testCase.compositeMutation(
					cleanupComposite("classify_return"),
				),
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(findingCodes(result.Findings), testCase.code) {
				t.Fatalf("failure-dependent %s passed: %#v", testCase.name, result.Findings)
			}
		})
	}
}

func TestUnityEnrollmentDropsRepositoryFromActiveInventoryWithoutReferences(t *testing.T) {
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/static.yml": `on: push
jobs:
  static:
    runs-on: ubuntu-latest
    steps:
      - run: echo no-licensed-work
`,
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Inventory) != 0 || len(result.Findings) != 0 {
		t.Fatalf("inactive repository was retained: %#v", result)
	}
}
