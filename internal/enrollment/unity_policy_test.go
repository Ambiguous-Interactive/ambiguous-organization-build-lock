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
	returnActionRef    = lockActionPrefix + "return-unity-license@" + testSHA
	testEditorCommand  = `& "$env:GITHUB_WORKSPACE/.ci/unity-helpers/scripts/unity/ensure-editor.ps1"`
	testEditorVersion  = "6000.5.2f1"
	validationAction   = lockActionPrefix + "require-unity-validation@" + testSHA
)

var (
	testEditorGateCommand = trustedEditorGateCommand(testEditorVersion)
	testEditorRun         = "run: |\n          " + testEditorGateCommand
)

func unityAuditPolicy() UnityEnrollmentPolicy {
	return UnityEnrollmentPolicy{
		ApprovedLockSHAs:      []string{testSHA},
		ApprovedReturnSHAs:    []string{testSHA},
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
    runs-on: [self-hosted, Windows]
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

func testEditorBootstrapBlock() string {
	indented := "          " + strings.ReplaceAll(
		trustedEditorBootstrapRun,
		"\n",
		"\n          ",
	)
	return `      - name: Remove stale Unity editor validator
        timeout-minutes: 2
        shell: pwsh -NoProfile -Command ". '{0}'"
        run: |
` + indented + `
`
}

func centralReturnSteps() string {
	return testEditorBootstrapBlock() + `      - name: Checkout trusted Unity editor validator
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        env:
          GIT_CONFIG_COUNT: 1
          GIT_CONFIG_KEY_0: core.hooksPath
          GIT_CONFIG_VALUE_0: /dev/null
          GIT_CONFIG_NOSYSTEM: 1
          GIT_CONFIG_GLOBAL: /dev/null
        with:
          repository: Ambiguous-Interactive/unity-helpers
          ref: 76712db791093a9c6b2eccdd9c7bd1b4f1cdb24d
          path: .ci/unity-helpers
          persist-credentials: false
          clean: true
          set-safe-directory: false
      - name: Require manually installed Unity editor
        timeout-minutes: 10
        shell: ` + trustedEditorShell + `
        ` + testEditorRun + `
      - id: acquire
        uses: ` + lockActionPrefix + `acquire-build-lock@` + testSHA + `
        with:
          lock-name: wallstop-organization-builds
          holder-id-suffix: qora
          runner-id: ${{ runner.name }}
      - name: Run Unity
        if: steps.acquire.outputs.acquired == 'true'
        run: unity-editor -batchmode -serial "${UNITY_SERIAL}"
        env:
          UNITY_SERIAL: ${{ secrets.UNITY_SERIAL }}
      - id: return_command
        if: ${{ always() && steps.acquire.outputs.acquired == 'true' }}
        uses: ` + returnActionRef + `
        with:
          unity-version: 6000.5.2f1
          tool-cache: ${{ runner.tool_cache }}
          unity-email: ${{ secrets.UNITY_EMAIL }}
          unity-password: ${{ secrets.UNITY_PASSWORD }}
          evidence-suffix: qora
      - id: cleanup_classification
        if: ${{ always() && steps.acquire.outputs.acquired == 'true' }}
        uses: ` + classifierAction + `
        with:
          return-log-path: ${{ steps.return_command.outputs.return-log-path }}
          return-command-completed: ${{ steps.return_command.outputs.return-command-completed }}
          return-exit-code: ${{ steps.return_command.outputs.return-exit-code }}
          evidence-capture-complete: ${{ steps.return_command.outputs.evidence-capture-complete }}
          return-log-digest: ${{ steps.return_command.outputs.return-log-digest }}
      - id: release
        if: always()
        uses: ` + releaseActionRef + `
        with:
          lock-name: wallstop-organization-builds
          holder-id-suffix: qora
          runner-id: ${{ runner.name }}
          resource-cleanup-status: ${{ steps.cleanup_classification.outputs.resource-cleanup-status }}
          resource-health: ${{ steps.cleanup_classification.outputs.resource-health }}
          resource-reason: ${{ steps.cleanup_classification.outputs.resource-reason }}
      - name: Require confirmed cleanup
        if: always()
        uses: ` + gateAction + `
        with:
          acquired: ${{ steps.acquire.outputs.acquired }}
          classification-complete: ${{ steps.cleanup_classification.outputs.classification-complete }}
          cleanup-status: ${{ steps.cleanup_classification.outputs.resource-cleanup-status }}
          cleanup-health: ${{ steps.cleanup_classification.outputs.resource-health }}
          cleanup-reason: ${{ steps.cleanup_classification.outputs.resource-reason }}
          release-outcome: ${{ steps.release.outcome }}
          cleanup-result: ${{ steps.release.outputs.cleanup-result }}
          released: ${{ steps.release.outputs.released }}
          release-health: ${{ steps.release.outputs.resource-health }}
          release-reason: ${{ steps.release.outputs.resource-reason }}
`
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

func trustedSkipAggregate() string {
	return `  aggregate:
    if: always()
    needs: [preflight, unity]
    runs-on: ubuntu-latest
    steps:
      - shell: bash
        env:
          RUNNER_PREFLIGHT_RESULT: ${{ needs.preflight.result }}
          UNITY_TESTS_RESULT: ${{ needs.unity.result }}
          FORK_PR: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository }}
          DEPENDABOT_PR: ${{ github.event_name == 'pull_request' && github.event.pull_request.user.login == 'dependabot[bot]' }}
        run: |
          set -euo pipefail
          if [ "${FORK_PR}" = "true" ] || [ "${DEPENDABOT_PR}" = "true" ]; then
            test "${RUNNER_PREFLIGHT_RESULT}" = skipped
            test "${UNITY_TESTS_RESULT}" = skipped
          else
            test "${RUNNER_PREFLIGHT_RESULT}" = success
            test "${UNITY_TESTS_RESULT}" = success
          fi
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
		".github/workflows/unity.yml": unityWorkflow(centralReturnSteps(), safeAggregate()),
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

func TestUnityEnrollmentAcceptsCurrentHeadGuardBeforeEditorGate(t *testing.T) {
	headGuard := `      - name: Require current PR head before setup
        timeout-minutes: 2
        uses: ` + lockActionPrefix + `require-current-pr-head@` + testSHA + `
        with:
          github-token: ${{ github.token }}
          pull-request-number: ${{ github.event.pull_request.number }}
          expected-head-sha: ${{ github.event.pull_request.head.sha }}
`
	workflow := unityWorkflow(
		headGuard+centralReturnSteps(),
		safeAggregate(),
	)
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": workflow,
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Findings) != 0 {
		t.Fatalf("closed current-head prefix produced findings: %#v", result.Findings)
	}
	mutations := []struct {
		name string
		from string
		to   string
	}{
		{
			name: "condition",
			from: "        timeout-minutes: 2\n",
			to:   "        if: always()\n        timeout-minutes: 2\n",
		},
		{
			name: "unbounded",
			from: "        timeout-minutes: 2\n",
			to:   "        timeout-minutes: 3\n",
		},
		{
			name: "environment",
			from: "        with:\n",
			to:   "        env:\n          NODE_OPTIONS: --require=attacker.js\n        with:\n",
		},
		{
			name: "extra input",
			from: "          expected-head-sha: ${{ github.event.pull_request.head.sha }}\n",
			to: "          expected-head-sha: ${{ github.event.pull_request.head.sha }}\n" +
				"          extra: value\n",
		},
		{
			name: "wrong expected head",
			from: "${{ github.event.pull_request.head.sha }}",
			to:   "${{ github.sha }}",
		},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			mutated := strings.Replace(workflow, mutation.from, mutation.to, 1)
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml": mutated,
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(
				findingCodes(result.Findings),
				"missing-unity-editor-check",
			) {
				t.Fatalf("unsafe current-head prefix passed: %#v", result.Findings)
			}
		})
	}
}

func TestUnityEnrollmentRejectsCIEditorProvisioningMutations(t *testing.T) {
	base := unityWorkflow(centralReturnSteps(), safeAggregate())
	bootstrapBlock := testEditorBootstrapBlock()
	checkoutBlock := `      - name: Checkout trusted Unity editor validator
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        env:
          GIT_CONFIG_COUNT: 1
          GIT_CONFIG_KEY_0: core.hooksPath
          GIT_CONFIG_VALUE_0: /dev/null
          GIT_CONFIG_NOSYSTEM: 1
          GIT_CONFIG_GLOBAL: /dev/null
        with:
          repository: Ambiguous-Interactive/unity-helpers
          ref: 76712db791093a9c6b2eccdd9c7bd1b4f1cdb24d
          path: .ci/unity-helpers
          persist-credentials: false
          clean: true
          set-safe-directory: false
`
	gateBlock := `      - name: Require manually installed Unity editor
        timeout-minutes: 10
        shell: ` + trustedEditorShell + `
        ` + testEditorRun + `
`
	checkoutGateBlock := bootstrapBlock + checkoutBlock + gateBlock
	acquireBlock := `      - id: acquire
        uses: ` + lockActionPrefix + `acquire-build-lock@` + testSHA + `
        with:
          lock-name: wallstop-organization-builds
          holder-id-suffix: qora
          runner-id: ${{ runner.name }}
`
	mutations := []struct {
		name string
		from string
		to   string
		code string
	}{
		{
			name: "missing healthy-existing switch",
			from: " -RequireHealthyExisting",
			to:   "",
			code: "unsafe-unity-editor-provisioning",
		},
		{
			name: "missing mandatory editor version",
			from: " -UnityVersion '" + testEditorVersion + "'",
			to:   "",
			code: "missing-unity-editor-check",
		},
		{
			name: "dynamic editor version",
			from: "'" + testEditorVersion + "'",
			to:   "'${{ matrix.unity-version }}'",
			code: "missing-unity-editor-check",
		},
		{
			name: "non-editor release version",
			from: "'" + testEditorVersion + "'",
			to:   "'6000.5.2b1'",
			code: "missing-unity-editor-check",
		},
		{
			name: "empty editor minor version",
			from: "'" + testEditorVersion + "'",
			to:   "'6000..2f1'",
			code: "missing-unity-editor-check",
		},
		{
			name: "healthy editor release differs from return release",
			from: "'" + testEditorVersion + "'",
			to:   "'2022.3.45f1'",
			code: "missing-unity-editor-check",
		},
		{
			name: "redirected editor install root",
			from: `"$env:RUNNER_TOOL_CACHE\u6-v3"`,
			to:   `C:\attacker-editors`,
			code: "missing-unity-editor-check",
		},
		{
			name: "provisioning profile widened",
			from: " -ProvisioningProfile EditorOnly",
			to:   " -ProvisioningProfile Full",
			code: "missing-unity-editor-check",
		},
		{
			name: "unbound matrix provisioning profile",
			from: " -ProvisioningProfile EditorOnly",
			to:   " -ProvisioningProfile " + trustedEditorMatrixProfile,
			code: "missing-unity-editor-check",
		},
		{
			name: "dynamic whole matrix",
			from: "      matrix:\n        mode: [EditMode]\n",
			to:   "      matrix: ${{ fromJSON(needs.config.outputs.matrix) }}\n",
			code: "missing-unity-editor-check",
		},
		{
			name: "include generated standalone matrix cell",
			from: "      matrix:\n        mode: [EditMode]\n",
			to: "      matrix:\n" +
				"        include:\n" +
				"          - test-mode: standalone\n",
			code: "missing-unity-editor-check",
		},
		{
			name: "excluded matrix shape",
			from: "      matrix:\n        mode: [EditMode]\n",
			to: "      matrix:\n" +
				"        mode: [EditMode]\n" +
				"        exclude:\n" +
				"          - mode: EditMode\n",
			code: "missing-unity-editor-check",
		},
		{
			name: "untrusted editor helper revision",
			from: trustedEditorRevision,
			to:   testSHA,
			code: "missing-unity-editor-check",
		},
		{
			name: "untrusted editor helper repository",
			from: trustedEditorRepository,
			to:   "Ambiguous-Interactive/fake-helper",
			code: "missing-unity-editor-check",
		},
		{
			name: "untrusted editor helper checkout path",
			from: "          path: " + trustedEditorRoot,
			to:   "          path: .ci/fake-helper",
			code: "missing-unity-editor-check",
		},
		{
			name: "trusted checkout skipped",
			from: "        uses: " + trustedEditorCheckout,
			to: "        if: ${{ false }}\n" +
				"        uses: " + trustedEditorCheckout,
			code: "missing-unity-editor-check",
		},
		{
			name: "trusted checkout failure ignored",
			from: "        uses: " + trustedEditorCheckout,
			to: "        continue-on-error: true\n" +
				"        uses: " + trustedEditorCheckout,
			code: "missing-unity-editor-check",
		},
		{
			name: "trusted checkout does not clean destination",
			from: "          clean: true",
			to:   "          clean: false",
			code: "missing-unity-editor-check",
		},
		{
			name: "untrusted checkout overwrites helper",
			from: "          clean: true\n" +
				"          set-safe-directory: false\n" +
				"      - name: Require manually installed Unity editor",
			to: "          clean: true\n" +
				"          set-safe-directory: false\n" +
				"      - name: Overwrite Unity editor validator\n" +
				"        uses: " + trustedEditorCheckout + "\n" +
				"        with:\n" +
				"          repository: attacker/fake-helper\n" +
				"          ref: " + testSHA + "\n" +
				"          path: " + trustedEditorRoot + "\n" +
				"          persist-credentials: false\n" +
				"          clean: true\n" +
				"      - name: Require manually installed Unity editor",
			code: "missing-unity-editor-check",
		},
		{
			name: "trusted checkout redirects server",
			from: "          clean: true",
			to: "          clean: true\n" +
				"          github-server-url: https://attacker.invalid",
			code: "missing-unity-editor-check",
		},
		{
			name: "trusted checkout injects post-checkout hook",
			from: "          GIT_CONFIG_VALUE_0: /dev/null",
			to:   "          GIT_CONFIG_VALUE_0: .ci/attacker-hooks",
			code: "missing-unity-editor-check",
		},
		{
			name: "step before trusted checkout poisons global Git config",
			from: "      - name: Remove stale Unity editor validator",
			to: "      - name: Poison global Git config\n" +
				"        shell: pwsh\n" +
				"        run: git config --global core.hooksPath .ci/attacker-hooks\n" +
				"      - name: Remove stale Unity editor validator",
			code: "missing-unity-editor-check",
		},
		{
			name: "bootstrap removal omitted",
			from: bootstrapBlock,
			to:   "",
			code: "missing-unity-editor-check",
		},
		{
			name: "bootstrap ignores prior failure",
			from: "      - name: Remove stale Unity editor validator\n",
			to: "      - name: Remove stale Unity editor validator\n" +
				"        if: always()\n",
			code: "missing-unity-editor-check",
		},
		{
			name: "bootstrap tolerates stale checkout",
			from: "  Remove-Item -LiteralPath $target -Recurse -Force",
			to:   "  Write-Host 'leaving stale checkout'",
			code: "missing-unity-editor-check",
		},
		{
			name: "job redirects Git home",
			from: "    strategy:\n",
			to: "    env:\n" +
				"      HOME: .ci/attacker-home\n" +
				"    strategy:\n",
			code: "missing-unity-editor-check",
		},
		{
			name: "job injects Node runtime options",
			from: "    strategy:\n",
			to: "    env:\n" +
				"      NODE_OPTIONS: --require=.ci/attacker.js\n" +
				"    strategy:\n",
			code: "missing-unity-editor-check",
		},
		{
			name: "job injects dotnet startup hook before bootstrap",
			from: "    strategy:\n",
			to: "    env:\n" +
				"      DOTNET_STARTUP_HOOKS: C:\\persistent\\attacker.dll\n" +
				"    strategy:\n",
			code: "missing-unity-editor-check",
		},
		{
			name: "job inherited environment is not allowlisted",
			from: "    strategy:\n",
			to: "    env:\n" +
				"      UNITY_VERSION: 6000.5.2f1\n" +
				"    strategy:\n",
			code: "missing-unity-editor-check",
		},
		{
			name: "trusted checkout ignores bootstrap failure",
			from: "      - name: Checkout trusted Unity editor validator\n",
			to: "      - name: Checkout trusted Unity editor validator\n" +
				"        if: always()\n",
			code: "missing-unity-editor-check",
		},
		{
			name: "gate shell ignores generated script",
			from: "        shell: " + trustedEditorShell,
			to:   `        shell: pwsh -NoProfile -Command "exit 0; # {0}"`,
			code: "missing-unity-editor-check",
		},
		{
			name: "gate injects dotnet startup hook",
			from: "        shell: " + trustedEditorShell + "\n        " + testEditorRun,
			to: "        shell: " + trustedEditorShell + "\n" +
				"        env:\n" +
				"          DOTNET_STARTUP_HOOKS: C:\\persistent\\attacker.dll\n" +
				"        " + testEditorRun,
			code: "missing-unity-editor-check",
		},
		{
			name: "gate mutates trusted validator before invocation",
			from: testEditorGateCommand,
			to: "Get-ChildItem $env:GITHUB_WORKSPACE/.ci -Filter *.ps1 -Recurse | " +
				"Set-Content -Value 'exit 0'\n          " + testEditorGateCommand,
			code: "missing-unity-editor-check",
		},
		{
			name: "trusted validator is modified and reinvoked after gate",
			from: "      - id: acquire\n",
			to: "      - name: Replace checked-out PowerShell files\n" +
				"        shell: pwsh\n" +
				"        run: Get-ChildItem .ci/unity-helpers -Recurse -Filter ('*.' + 'ps1') | Set-Content -Value 'exit 0'\n" +
				"      - name: Reinvoke modified validator\n" +
				"        shell: " + trustedEditorShell + "\n" +
				"        run: |\n" +
				"          " + testEditorGateCommand + "\n" +
				"      - id: acquire\n",
			code: "unsafe-unity-editor-provisioning",
		},
		{
			name: "missing CI-managed layout switch",
			from: " -CiManagedOnly",
			to:   "",
			code: "unsafe-unity-editor-provisioning",
		},
		{
			name: "switches explicitly disabled",
			from: " -CiManagedOnly -RequireHealthyExisting",
			to:   " -CiManagedOnly:$false -RequireHealthyExisting:$false",
			code: "unsafe-unity-editor-provisioning",
		},
		{
			name: "inline comment switch decoy",
			from: " -DiagnosticsPath unity-editor-check.json -CiManagedOnly -RequireHealthyExisting",
			to:   " # -CiManagedOnly -RequireHealthyExisting",
			code: "unsafe-unity-editor-provisioning",
		},
		{
			name: "block comment switch decoy",
			from: testEditorRun,
			to: "run: |\n" +
				"          ./scripts/unity/ensure-editor.ps1\n" +
				"          <# -CiManagedOnly -RequireHealthyExisting #>",
			code: "unsafe-unity-editor-provisioning",
		},
		{
			name: "mixed safe and unsafe invocations",
			from: testEditorRun,
			to: "run: |\n" +
				"          ./scripts/unity/ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting\n" +
				"          ./scripts/unity/ensure-editor.ps1",
			code: "unsafe-unity-editor-provisioning",
		},
		{
			name: "dynamically composed invocation before safe gate",
			from: testEditorRun,
			to: "run: |\n" +
				"          $tool = Join-Path $env:GITHUB_WORKSPACE ('scripts/unity/ensure-' + 'editor.ps1')\n" +
				"          & $tool\n" +
				"          ./scripts/unity/ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting",
			code: "unsafe-unity-editor-provisioning",
		},
		{
			name: "dynamic expression invocation before safe gate",
			from: testEditorRun,
			to: "run: |\n" +
				"          & (Join-Path $env:GITHUB_WORKSPACE ('scripts/unity/ensure-' + 'editor.ps1'))\n" +
				"          ./scripts/unity/ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting",
			code: "unsafe-unity-editor-provisioning",
		},
		{
			name: "indirect dynamic invocation before safe gate",
			from: testEditorRun,
			to: "run: |\n" +
				"          $leaf = 'editor.ps1'\n" +
				"          $tool = Join-Path $env:GITHUB_WORKSPACE ('scripts/unity/ensure-' + $leaf)\n" +
				"          & $tool\n" +
				"          ./scripts/unity/ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting",
			code: "unsafe-unity-editor-provisioning",
		},
		{
			name: "invoke-expression before safe gate",
			from: testEditorRun,
			to: "run: |\n" +
				"          $command = './scripts/unity/ensure-' + 'editor.ps1'\n" +
				"          Invoke-Expression $command\n" +
				"          ./scripts/unity/ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting",
			code: "unsafe-unity-editor-provisioning",
		},
		{
			name: "child PowerShell command before safe gate",
			from: testEditorRun,
			to: "run: |\n" +
				"          $command = './scripts/unity/ensure-' + 'editor.ps1'\n" +
				"          pwsh -NoProfile -Command $command\n" +
				"          ./scripts/unity/ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting",
			code: "unsafe-unity-editor-provisioning",
		},
		{
			name: "quoted invoke-expression before safe gate",
			from: testEditorRun,
			to: "run: |\n" +
				"          $command = './scripts/unity/ensure-' + 'editor.ps1'\n" +
				"          & 'Invoke-Expression' $command\n" +
				"          ./scripts/unity/ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting",
			code: "unsafe-unity-editor-provisioning",
		},
		{
			name: "interpolated invoke-expression before safe gate",
			from: testEditorRun,
			to: "run: |\n" +
				"          $verb = 'Expression'\n" +
				"          $command = './scripts/unity/ensure-' + 'editor.ps1'\n" +
				"          & \"Invoke-$verb\" $command\n" +
				"          ./scripts/unity/ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting",
			code: "unsafe-unity-editor-provisioning",
		},
		{
			name: "safe invocation hidden in false PowerShell branch",
			from: testEditorRun,
			to: "run: |\n" +
				"          if ($false) {\n" +
				"            ./scripts/unity/ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting\n" +
				"          }",
			code: "missing-unity-editor-check",
		},
		{
			name: "safe invocation after successful exit",
			from: testEditorRun,
			to: "run: |\n" +
				"          exit 0\n" +
				"          ./scripts/unity/ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting",
			code: "missing-unity-editor-check",
		},
		{
			name: "safe invocation hidden in short circuit",
			from: testEditorRun,
			to: "run: |\n" +
				"          if ($false -and (& ./scripts/unity/ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting)) { }\n",
			code: "missing-unity-editor-check",
		},
		{
			name: "external unsafe invocation after safe gate",
			from: testEditorRun,
			to: "run: |\n" +
				"          ./scripts/unity/ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting\n" +
				"          C:\\external\\ensure-editor.ps1",
			code: "unsafe-unity-editor-provisioning",
		},
		{
			name: "external script cannot satisfy gate",
			from: testEditorGateCommand,
			to:   "C:\\external\\ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting",
			code: "unsafe-unity-editor-provisioning",
		},
		{
			name: "pipeline cannot lend switches to editor invocation",
			from: testEditorGateCommand,
			to:   "./scripts/unity/ensure-editor.ps1 | Receive-Probe -CiManagedOnly -RequireHealthyExisting",
			code: "unsafe-unity-editor-provisioning",
		},
		{
			name: "non-running string decoy",
			from: testEditorRun,
			to:   "run: Write-Host './scripts/unity/ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting'",
			code: "missing-unity-editor-check",
		},
		{
			name: "provisioning budget restored",
			from: "        shell: " + trustedEditorShell + "\n",
			to: "        env:\n" +
				"          UH_ENSURE_EDITOR_PROVISIONING_BUDGET_SECONDS: \"9600\"\n" +
				"        shell: " + trustedEditorShell + "\n",
			code: "unity-editor-provisioning-control",
		},
		{
			name: "install timeout restored",
			from: "        shell: " + trustedEditorShell + "\n",
			to: "        env:\n" +
				"          UH_ENSURE_EDITOR_INSTALL_TIMEOUT_SECONDS: \"7200\"\n" +
				"        shell: " + trustedEditorShell + "\n",
			code: "unity-editor-provisioning-control",
		},
		{
			name: "gate timeout removed",
			from: "        timeout-minutes: 10\n",
			to:   "",
			code: "unbounded-unity-editor-check",
		},
		{
			name: "gate failure ignored",
			from: "        timeout-minutes: 10\n",
			to: "        timeout-minutes: 10\n" +
				"        continue-on-error: true\n",
			code: "unsafe-unity-editor-check",
		},
		{
			name: "gate condition is false",
			from: "        timeout-minutes: 10\n",
			to: "        timeout-minutes: 10\n" +
				"        if: ${{ false }}\n",
			code: "missing-unity-editor-check",
		},
		{
			name: "gate ignores bootstrap or checkout failure",
			from: "        timeout-minutes: 10\n",
			to: "        timeout-minutes: 10\n" +
				"        if: always()\n",
			code: "missing-unity-editor-check",
		},
		{
			name: "safe gate shares step with Unity execution",
			from: testEditorRun,
			to: "run: |\n" +
				"          ./scripts/unity/ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting\n" +
				"          Unity.exe -quit",
			code: "acquire-after-activation",
		},
		{
			name: "workflow credentials precede gate",
			from: "concurrency:\n",
			to: "env:\n" +
				"  UNITY_SERIAL: ${{ secrets.UNITY_SERIAL }}\n" +
				"concurrency:\n",
			code: "missing-unity-editor-check",
		},
		{
			name: "gate moved after acquire",
			from: checkoutGateBlock + acquireBlock,
			to:   acquireBlock + checkoutGateBlock,
			code: "missing-unity-editor-check",
		},
		{
			name: "acquire ignores gate failure",
			from: "      - id: acquire\n",
			to: "      - id: acquire\n" +
				"        if: always()\n",
			code: "missing-lock-acquire",
		},
		{
			name: "gate moved after credentials",
			from: checkoutGateBlock,
			to:   "",
			code: "missing-unity-editor-check",
		},
	}

	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			workflow := strings.Replace(base, mutation.from, mutation.to, 1)
			if mutation.name == "gate moved after credentials" {
				workflow = strings.Replace(
					workflow,
					"      - id: return_command\n",
					checkoutGateBlock+"      - id: return_command\n",
					1,
				)
			}
			if workflow == base {
				t.Fatal("mutation did not change workflow")
			}
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml": workflow,
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(findingCodes(result.Findings), mutation.code) {
				t.Fatalf("missing %s finding: %#v", mutation.code, result.Findings)
			}
		})
	}
}

func TestUnityEnrollmentCheckoutSafeDirectoryTransition(t *testing.T) {
	base := unityWorkflow(centralReturnSteps(), safeAggregate())
	legacy := strings.Replace(
		base,
		"          set-safe-directory: false\n",
		"",
		1,
	)
	legacyResult, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": legacy,
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(findingCodes(legacyResult.Findings), "missing-unity-editor-check") {
		t.Fatalf("checkout without safe-directory false passed: %#v", legacyResult.Findings)
	}
	literal, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": base,
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(findingCodes(literal.Findings), "missing-unity-editor-check") {
		t.Fatalf("literal false safe-directory input was rejected: %#v", literal.Findings)
	}

	for name, value := range map[string]string{
		"true":       "true",
		"expression": "${{ false }}",
	} {
		t.Run(name, func(t *testing.T) {
			workflow := strings.Replace(
				base,
				"set-safe-directory: false",
				"set-safe-directory: "+value,
				1,
			)
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml": workflow,
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(findingCodes(result.Findings), "missing-unity-editor-check") {
				t.Fatalf("unsafe safe-directory input passed: %#v", result.Findings)
			}
		})
	}

	extra := strings.Replace(
		base,
		"          set-safe-directory: false\n",
		"          set-safe-directory: false\n          lfs: false\n",
		1,
	)
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": extra,
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(findingCodes(result.Findings), "missing-unity-editor-check") {
		t.Fatalf("extra checkout input passed: %#v", result.Findings)
	}
}

func TestUnityEnrollmentWorkingDirectoryDoesNotRejectExactGate(t *testing.T) {
	workflow := unityWorkflow(centralReturnSteps(), safeAggregate())
	workflow = strings.Replace(
		workflow,
		"runs-on: [self-hosted, Windows]\n",
		"runs-on: [self-hosted, Windows]\n    defaults:\n      run:\n        working-directory: Assets\n",
		1,
	)
	workflow = strings.Replace(
		workflow,
		"      - id: acquire\n",
		"      - name: Build from project subdirectory\n"+
			"        working-directory: Assets\n"+
			"        run: Write-Host build\n"+
			"      - id: acquire\n",
		1,
	)
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": workflow,
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	findings := findingCodes(result.Findings)
	if strings.Contains(findings, "unsafe-unity-editor-provisioning") ||
		strings.Contains(findings, "missing-unity-editor-check") {
		t.Fatalf("working-directory on unrelated steps rejected exact gate: %#v", result.Findings)
	}
}

func TestUnityEnrollmentRejectsSameNamedFakeEditorGate(t *testing.T) {
	workflow := strings.Replace(
		unityWorkflow(centralReturnSteps(), safeAggregate()),
		testEditorRun,
		"run: ./scripts/fake/ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting",
		1,
	)
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml":    workflow,
		"scripts/fake/ensure-editor.ps1": "param([switch]$CiManagedOnly, [switch]$RequireHealthyExisting)\nexit 0\n",
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(findingCodes(result.Findings), "missing-unity-editor-check") {
		t.Fatalf("same-named fake helper satisfied gate: %#v", result.Findings)
	}
}

func TestUnityEnrollmentDoesNotTreatEditorEvidencePathsAsActivation(t *testing.T) {
	binder := `      - name: Bind and preserve validated Unity editor
        timeout-minutes: 2
        shell: pwsh
        run: |
          $source = Join-Path $env:GITHUB_WORKSPACE 'unity-editor-check.json'
          $evidenceRoot = Join-Path $env:RUNNER_TEMP 'dx-unity-editor-validation'
          Copy-Item -LiteralPath $source -Destination $evidenceRoot -Force
`
	steps := strings.Replace(
		centralReturnSteps(),
		"      - id: acquire\n",
		binder+"      - id: acquire\n",
		1,
	)
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": unityWorkflow(steps, safeAggregate()),
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(findingCodes(result.Findings), "acquire-after-activation") {
		t.Fatalf("editor evidence paths were classified as activation: %#v", result.Findings)
	}
}

func TestUnityEnrollmentDetectsUnityActivationCommandPositions(t *testing.T) {
	for name, command := range map[string]string{
		"assignment pipeline":    "$output = Unity.exe -batchmode -quit",
		"return pipeline":        "return Unity.exe -batchmode -quit",
		"subexpression pipeline": "$(Unity.exe -batchmode -quit)",
		"subexpression call": "$(& " +
			"'C:\\Unity\\Editor\\Unity.exe' -batchmode -quit)",
		"subexpression Start-Process": "$(Start-Process -FilePath Unity.exe " +
			"-ArgumentList '-batchmode','-quit' -Wait)",
		"subexpression call Start-Process": "$(& Start-Process -FilePath " +
			"Unity.exe -ArgumentList '-batchmode','-quit' -Wait)",
		"quoted path with spaces": "& " +
			"'C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.16f1\\Editor\\Unity.exe' " +
			"-batchmode -quit",
		"Start-Process FilePath": "Start-Process -FilePath " +
			"'C:\\Unity\\Editor\\Unity.exe' " +
			"-ArgumentList '-batchmode','-quit' -Wait",
		"Start-Process spaced FilePath": "Start-Process -FilePath " +
			"'C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.16f1\\Editor\\Unity.exe' " +
			"-ArgumentList '-batchmode','-quit' -Wait",
		"assigned Start-Process FilePath": "$output = Start-Process -FilePath " +
			"'C:\\Unity\\Editor\\Unity.exe' " +
			"-ArgumentList '-batchmode','-quit' -Wait",
		"Start-Process switch before positional": "Start-Process -Wait Unity.exe " +
			"-ArgumentList '-batchmode','-quit'",
		"Start-Process attached FilePath": "Start-Process " +
			"-FilePath:'C:\\Unity\\Editor\\Unity.exe' " +
			"-ArgumentList '-batchmode','-quit'",
		"Start-Process value then positional": "Start-Process " +
			"-WorkingDirectory 'C:\\Temp' Unity.exe -Wait",
		"Start-Process abbreviated value": "Start-Process " +
			"-Work 'C:\\Temp' Unity.exe -Wait",
		"Start-Process abbreviated FilePath": "Start-Process " +
			"-FileP:'C:\\Unity\\Editor\\Unity.exe' -Wait",
		"module-qualified Start-Process": "Microsoft.PowerShell.Management\\" +
			"Start-Process -FilePath Unity.exe -Wait",
		"Start-Process saps alias":  "saps -FilePath Unity.exe -Wait",
		"Start-Process start alias": "start -FilePath Unity.exe -Wait",
		"returnlicense filename data": "& 'C:\\Unity\\Editor\\Unity.exe' " +
			"-batchmode -quit -logFile '.artifacts/-returnlicense.log'",
	} {
		t.Run(name, func(t *testing.T) {
			activation := `      - name: Execute Unity before acquiring
        shell: pwsh
        run: |
          ` + command + `
`
			steps := strings.Replace(
				centralReturnSteps(),
				"      - id: acquire\n",
				activation+"      - id: acquire\n",
				1,
			)
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml": unityWorkflow(
					steps,
					safeAggregate(),
				),
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(
				findingCodes(result.Findings),
				"acquire-after-activation",
			) {
				t.Fatalf("Unity activation was not recognized: %#v", result.Findings)
			}
		})
	}

	if commandInvokesUnityExecutable(
		"Write-Output Start-Process Unity.exe",
	) {
		t.Fatal("Start-Process argument data was classified as execution")
	}
	if commandInvokesUnityExecutable(
		"Start-Process -RedirectStandardOutput Unity.exe notepad.exe -Wait",
	) {
		t.Fatal("Start-Process redirect path was classified as execution")
	}
	if commandInvokesUnityExecutable(
		"Start-Process -RedirectStandardO Unity.exe notepad.exe -Wait",
	) {
		t.Fatal("abbreviated Start-Process redirect was classified as execution")
	}
	if commandInvokesUnityExecutable(
		"Write-Output saps -FilePath Unity.exe",
	) {
		t.Fatal("Start-Process alias data was classified as execution")
	}
	if commandInvokesUnityExecutable(
		"& 'C:\\tools\\start.exe' -FilePath Unity.exe",
	) {
		t.Fatal("an executable named start was treated as the built-in alias")
	}
	if commandInvokesUnityExecutable(
		"& '.\\Start-Process' -FilePath Unity.exe",
	) {
		t.Fatal("a relative command path was treated as module qualification")
	}
	if commandInvokesUnityExecutable(
		"return 'C:\\Unity\\Editor\\Unity.exe'",
	) {
		t.Fatal("returned Unity path data was classified as execution")
	}
}

func TestUnityEnrollmentAuditsDelegatedEditorChecks(t *testing.T) {
	workflow := unityWorkflow(strings.Replace(
		centralReturnSteps(),
		testEditorRun,
		"run: ./scripts/ci/wrapper.ps1 -Operation RequireEditor",
		1,
	), safeAggregate())
	wrapperScript := `param([string]$Operation)
& "$PSScriptRoot/unity.ps1" -Operation $Operation
`
	safeScript := `param([string]$Operation)
if ($Operation -eq 'RequireEditor') {
    ./scripts/unity/ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting
}
`
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": workflow,
		"scripts/ci/wrapper.ps1":      wrapperScript,
		"scripts/ci/unity.ps1":        safeScript,
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(findingCodes(result.Findings), "missing-unity-editor-check") {
		t.Fatalf("delegated control flow counted as a required gate: %#v", result.Findings)
	}

	t.Run("unrelated complex PowerShell driver is not an editor wrapper", func(t *testing.T) {
		steps := strings.Replace(
			centralReturnSteps(),
			"      - id: acquire",
			`      - name: Run checked-in test driver
        shell: pwsh
        run: ./scripts/ci/run-tests.ps1 -Mode EditMode
      - id: acquire`,
			1,
		)
		workflow := unityWorkflow(steps, safeAggregate())
		driver := `[CmdletBinding()]
param([ValidateSet('EditMode', 'PlayMode')][string]$Mode)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($Mode -eq 'EditMode') { Write-Host $Mode }
`
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": workflow,
			"scripts/ci/run-tests.ps1":    driver,
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(findingCodes(result.Findings), "unsafe-unity-editor-provisioning") {
			t.Fatalf("unrelated test driver was treated as an editor wrapper: %#v", result.Findings)
		}
	})

	t.Run("unproved delegated control flow is not a gate", func(t *testing.T) {
		skippedWorkflow := strings.Replace(
			workflow,
			"-Operation RequireEditor",
			"-Operation SkipEditor",
			1,
		)
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": skippedWorkflow,
			"scripts/ci/wrapper.ps1":      wrapperScript,
			"scripts/ci/unity.ps1":        safeScript,
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(findingCodes(result.Findings), "missing-unity-editor-check") {
			t.Fatalf("unproved delegated control flow counted as a gate: %#v", result.Findings)
		}
	})

	unsafeScripts := map[string]string{
		"missing switch": strings.Replace(safeScript, " -RequireHealthyExisting", "", 1),
		"comment decoy": `param([string]$Operation)
# -CiManagedOnly -RequireHealthyExisting
if ($Operation -eq 'RequireEditor') {
    ./scripts/unity/ensure-editor.ps1
}
`,
	}
	for name, unsafe := range unsafeScripts {
		t.Run(name, func(t *testing.T) {
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml": workflow,
				"scripts/ci/wrapper.ps1":      wrapperScript,
				"scripts/ci/unity.ps1":        unsafe,
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(findingCodes(result.Findings), "unsafe-unity-editor-provisioning") {
				t.Fatalf("unsafe delegated editor check was not rejected: %#v", result.Findings)
			}
		})
	}

	t.Run("unsafe delegated call does not require a gate marker", func(t *testing.T) {
		unsafePreparation := `      - name: Prepare host
        timeout-minutes: 10
        shell: pwsh
        run: ./scripts/ci/prepare.ps1
`
		workflow := unityWorkflow(
			unsafePreparation+centralReturnSteps(),
			safeAggregate(),
		)
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": workflow,
			"scripts/ci/prepare.ps1":      "./scripts/unity/ensure-editor.ps1\n",
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(findingCodes(result.Findings), "unsafe-unity-editor-provisioning") {
			t.Fatalf("non-marker delegated provisioning passed: %#v", result.Findings)
		}
	})

	t.Run("unresolved delegated script variable fails closed", func(t *testing.T) {
		variableWrapper := `$child = Join-Path $PSScriptRoot ('unity.' + 'ps1')
& $child -Operation RequireEditor
`
		workflow := unityWorkflow(
			`      - name: Prepare host
        timeout-minutes: 10
        shell: pwsh
        run: ./scripts/ci/wrapper.ps1
`+centralReturnSteps(),
			safeAggregate(),
		)
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": workflow,
			"scripts/ci/wrapper.ps1":      variableWrapper,
			"scripts/ci/unity.ps1":        safeScript,
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(findingCodes(result.Findings), "unsafe-unity-editor-provisioning") {
			t.Fatalf("unresolved delegated invocation passed: %#v", result.Findings)
		}
	})

	for name, variableWrapper := range map[string]string{
		"ordinary variable":          "& $installer -Operation RequireEditor\n",
		"environment variable":       "& $env:PAYLOAD -Operation RequireEditor\n",
		"quoted file variable":       "pwsh -NoProfile -File \"$installer\"\n",
		"quoted env file":            "pwsh -NoProfile -File \"${env:PAYLOAD}\"\n",
		"quoted static host":         "& 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' -File $env:PAYLOAD\n",
		"attached File value":        "pwsh -File:$env:PAYLOAD\n",
		"File alias":                 "pwsh -f $env:PAYLOAD\n",
		"composed quoted target":     "pwsh -File \"C:\\payloads\\$installer\"\n",
		"composed bare target":       "pwsh -File .\\$installer\n",
		"expression target":          "pwsh -File (Join-Path $env:TEMP 'payload.ps1')\n",
		"splatted target":            "pwsh -File @launch\n",
		"escaped File option":        "pwsh `-File $env:PAYLOAD\n",
		"stop-parsing env target":    "pwsh --% -File %PAYLOAD%\n",
		"escaped host spelling":      "pw`sh -File $env:PAYLOAD\n",
		"File then stop parsing":     "pwsh -File --% %PAYLOAD%\n",
		"automatic variable":         "pwsh -File \"$$\"\n",
		"nested dot source":          "if ($true) { . $env:PAYLOAD }\n",
		"segmented host":             "pw'sh' -File $env:PAYLOAD\n",
		"segmented File option":      "pwsh -F'ile' $env:PAYLOAD\n",
		"segmented call target":      "& 'C:\\payloads\\'$env:PAYLOAD\n",
		"attached segmented option":  "pwsh -F'ile':$env:PAYLOAD\n",
		"mixed segmented target":     "pwsh -File 'C:\\payloads\\'$env:PAYLOAD'.ps1'\n",
		"mixed subexpression target": "& 'C:\\payloads\\'$(Get-Content target.txt)\n",
		"mixed automatic target":     "& 'C:\\payloads\\'$?\n",
		"nested direct host":         "if ($true) { pwsh -File $env:PAYLOAD }\n",
		"subexpression direct host":  "$(pwsh -File $env:PAYLOAD)\n",
		"assignment direct host":     "$output = pwsh -File $env:PAYLOAD\n",
		"typed assignment host":      "[string]$output = pwsh -File $env:PAYLOAD\n",
		"spaced typed assignment":    "[string] $output = pwsh -File $env:PAYLOAD\n",
		"array typed assignment":     "[string[]]$output = pwsh -File $env:PAYLOAD\n",
		"attributed assignment":      "[ValidatePattern(']')][string]$output = pwsh -File $env:PAYLOAD\n",
		"returned call target":       "function Invoke-Payload { return & $env:PAYLOAD }\n",
		"returned direct host":       "function Invoke-Payload { return pwsh -File $env:PAYLOAD }\n",
		"expandable subexpression":   "\"$(& $env:PAYLOAD)\"\n",
		"expandable after line comment": "# \"\n          " +
			"\"$(& $env:PAYLOAD)\"\n",
		"expandable after block comment": "<# \" #>\n          " +
			"\"$(& $env:PAYLOAD)\"\n",
		"parenthesized dot source":    "$(. $env:PAYLOAD)\n",
		"NBSP call whitespace":        "&\u00a0$env:PAYLOAD\n",
		"em-space call whitespace":    "&\u2003$env:PAYLOAD\n",
		"continued call whitespace":   "& `\n          $env:PAYLOAD\n",
		"Unicode variable call":       "& $脚本\n",
		"Unicode variable dot source": ". $脚本\n",
	} {
		t.Run("unresolved workflow "+name+" fails closed", func(t *testing.T) {
			if !hasUnresolvedPowerShellWorkflowInvocation(variableWrapper) {
				t.Fatalf("unresolved workflow invocation was not recognized: %q", variableWrapper)
			}
			workflow := unityWorkflow(
				`      - name: Prepare host
        timeout-minutes: 10
        shell: pwsh
        run: |
          `+strings.TrimSpace(variableWrapper)+`
`+centralReturnSteps(),
				safeAggregate(),
			)
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml": workflow,
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(
				findingCodes(result.Findings),
				"unsafe-unity-editor-provisioning",
			) {
				t.Fatalf("unresolved variable invocation passed: %#v", result.Findings)
			}
		})
	}

	t.Run("multiline expandable File target fails closed", func(t *testing.T) {
		if !hasUnresolvedPowerShellWorkflowInvocation(
			"pwsh -File \"C:\\payloads\\\n$installer.ps1\"",
		) {
			t.Fatal("multiline expandable target was not recognized")
		}
	})

	t.Run("comment quote cannot create a malformed expandable expression", func(t *testing.T) {
		if hasUnresolvedPowerShellWorkflowInvocation("# \"$(\nWrite-Output ok\n") {
			t.Fatal("comment-only expandable syntax caused a rejection")
		}
	})

	t.Run("ordinary File parameter is not a PowerShell host invocation", func(t *testing.T) {
		if hasUnresolvedPowerShellWorkflowInvocation(
			"./scripts/check-artifact.ps1 -File $report",
		) {
			t.Fatal("ordinary File parameter was classified as an unresolved invocation")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"pwsh -File '$installer'",
		) {
			t.Fatal("single-quoted literal was classified as a dynamic file")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"pwsh -File '$installer path.ps1'",
		) {
			t.Fatal("single-quoted literal with spaces was classified as dynamic")
		}
		if hasUnresolvedPowerShellWorkflowInvocation("git add . $report") {
			t.Fatal("ordinary dot argument was classified as dot-sourcing")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"pwsh -File './wrapper.ps1' -File $report",
		) {
			t.Fatal("script File argument was classified as a second host target")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"pwsh --% -File $env:PAYLOAD",
		) {
			t.Fatal("stop-parsing dollar was classified as expansion")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"pwsh -File .\\`$installer.ps1",
		) {
			t.Fatal("escaped dollar was classified as interpolation")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"pwsh -File C:\\cost$.ps1",
		) {
			t.Fatal("standalone dollar was classified as interpolation")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"pwsh -Version -File $env:PAYLOAD",
		) {
			t.Fatal("terminal Version option did not stop host parsing")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"& 'pw`sh' -File $env:PAYLOAD",
		) {
			t.Fatal("single-quoted host backtick was treated as an escape")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"pwsh '`-File' $env:PAYLOAD",
		) {
			t.Fatal("single-quoted option backtick was treated as an escape")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"pwsh -File '$installer\npath.ps1'",
		) {
			t.Fatal("multiline single-quoted literal was classified as dynamic")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"pwsh -Ve -File $env:PAYLOAD",
		) {
			t.Fatal("terminal Version prefix did not stop host parsing")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"& '''pwsh''' -File $env:PAYLOAD",
		) {
			t.Fatal("literal apostrophes were trimmed from a quoted host")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"pwsh -File 'cost$'path.ps1",
		) {
			t.Fatal("mixed single-quoted dollar was classified as interpolation")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"& \"$env:GITHUB_WORKSPACE/scripts/\"'fixed.ps1'",
		) {
			t.Fatal("static segmented workspace path was classified as unresolved")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"& \"$env:GITHUB_WORKSPACE/scripts/\"'cost$script.ps1'",
		) {
			t.Fatal("single-quoted dollar made a workspace path dynamic")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"pwsh --'%' -File %PAYLOAD%",
		) {
			t.Fatal("literal segmented percent was treated as stop parsing")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"& '(pwsh)' -File $env:PAYLOAD",
		) {
			t.Fatal("literal parenthesized host was normalized into pwsh")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"pwsh '(-File)' $env:PAYLOAD",
		) {
			t.Fatal("literal parenthesized option was normalized into File")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"Write-Output pwsh -File $env:PAYLOAD",
		) {
			t.Fatal("PowerShell-looking output data was treated as invocation")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"Write-Output name=pwsh -File $env:PAYLOAD",
		) {
			t.Fatal("equals-bearing output data was treated as assignment")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"Write-Output $label=pwsh -File $env:PAYLOAD",
		) {
			t.Fatal("variable-bearing output data was treated as assignment")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"Write-Output name = pwsh -File $env:PAYLOAD",
		) {
			t.Fatal("spaced equals output data was treated as assignment")
		}
		if hasUnresolvedPowerShellWorkflowInvocation(
			"Write-Output ok & $report",
		) {
			t.Fatal("background operator was treated as a call operator")
		}
	})

	t.Run("delegated File target preserves single-quote semantics", func(t *testing.T) {
		if hasUnresolvedPowerShellScriptInvocation(
			"pwsh -File 'cost$script.ps1'",
		) {
			t.Fatal("literal single-quoted dollar was classified as dynamic")
		}
	})

	t.Run("unresolved delegated script expression fails closed", func(t *testing.T) {
		expressionWrapper := `& (Join-Path $PSScriptRoot ('unity.' + 'ps1')) -Operation RequireEditor
& "$PSScriptRoot/relevant.ps1" -Operation RequireEditor
`
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": workflow,
			"scripts/ci/wrapper.ps1":      expressionWrapper,
			"scripts/ci/relevant.ps1":     safeScript,
			"scripts/ci/unity.ps1":        safeScript,
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(findingCodes(result.Findings), "unsafe-unity-editor-provisioning") {
			t.Fatalf("unresolved delegated expression passed: %#v", result.Findings)
		}
	})

	t.Run("literal Join-Path delegated call is recursively audited", func(t *testing.T) {
		unsafeChild := strings.Replace(safeScript, " -RequireHealthyExisting", "", 1)
		for name, joinPathWrapper := range map[string]string{
			"module-qualified call": "& (Microsoft.PowerShell.Management\\Join-Path " +
				"$PSScriptRoot 'unity.ps1') -Operation RequireEditor\n",
			"spaced call":  "& (Join-Path $PSScriptRoot 'unity.ps1') -Operation RequireEditor\n",
			"compact call": "&(Join-Path $PSScriptRoot 'unity.ps1') -Operation RequireEditor\n",
			"tabs": "&\t(\tJoin-Path $PSScriptRoot " +
				"'unity.ps1') -Operation RequireEditor\n",
			"Unicode whitespace": "&\u00a0(\u2003Join-Path $PSScriptRoot " +
				"'unity.ps1') -Operation RequireEditor\n",
			"dot sourced": ".(Join-Path $PSScriptRoot 'unity.ps1') " +
				"-Operation RequireEditor\n",
			"multiline parentheses": "& (\n  Join-Path $PSScriptRoot " +
				"'unity.ps1'\n) -Operation RequireEditor\n",
			"explicit continuation": "& `\n  (Join-Path $PSScriptRoot " +
				"'unity.ps1') -Operation RequireEditor\n",
			"continuation before root": "& (Join-Path `\n  $PSScriptRoot " +
				"'unity.ps1') -Operation RequireEditor\n",
			"continuation before child": "& (Join-Path $PSScriptRoot `\n  " +
				"'unity.ps1') -Operation RequireEditor\n",
			"escaped command name": "& (Join`-Path $PSScriptRoot " +
				"'unity.ps1') -Operation RequireEditor\n",
			"escaped command with braced root": "& (Join`-Path ${PSScriptRoot} " +
				"'unity.ps1') -Operation RequireEditor\n",
			"double quoted script root": "& (Join-Path \"$PSScriptRoot\" " +
				"'unity.ps1') -Operation RequireEditor\n",
			"escaped child path": "& (Join-Path $PSScriptRoot " +
				"\"uni`ty.ps1\") -Operation RequireEditor\n",
			"expandable subexpression": "\"$(& (Join-Path $PSScriptRoot " +
				"'unity.ps1'))\"\n",
			"nested dot source": "$(. (Join-Path $PSScriptRoot " +
				"'unity.ps1'))\n",
			"segmented quoted direct path": "& \"$PSScriptRoot/\"'unity.ps1' " +
				"-Operation RequireEditor\n",
			"segmented braced direct path": "& ${PSScriptRoot}/'unity.ps1' " +
				"-Operation RequireEditor\n",
			"segmented path with NBSP boundary": "& \"$PSScriptRoot/\"'unity.ps1'\u00a0" +
				"-Operation RequireEditor\n",
			"segmented path with em-space boundary": "& \"$PSScriptRoot/\"'unity.ps1'\u2003" +
				"-Operation RequireEditor\n",
			"segmented path with redirection boundary": "& \"$PSScriptRoot/\"" +
				"'unity.ps1'>$null\n",
			"segmented subexpression path": "$result = $(& ${PSScriptRoot}/" +
				"'unity.ps1')\n",
			"segmented array expression path": "$result = @(& \"$PSScriptRoot/\"" +
				"'unity.ps1')\n",
		} {
			t.Run(name, func(t *testing.T) {
				references := invokedPowerShellReferences(joinPathWrapper)
				if len(references) != 1 || references[0].path != "unity.ps1" ||
					!references[0].scriptRelative {
					t.Fatalf("wrapper-relative child extraction mismatch: %#v", references)
				}
				if strings.Contains(strings.ToLower(joinPathWrapper), "join") &&
					!references[0].hazardous {
					t.Fatalf("Join-Path edge was not marked hazardous: %#v", references)
				}
				for childName, child := range map[string]string{
					"safe child":   safeScript,
					"unsafe child": unsafeChild,
				} {
					t.Run(childName, func(t *testing.T) {
						result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
							".github/workflows/unity.yml":     workflow,
							"scripts/ci/wrapper.ps1":          joinPathWrapper,
							"scripts/ci/unity.ps1":            child,
							"scripts/unity/ensure-editor.ps1": "",
						}), unityAuditPolicy())
						if err != nil {
							t.Fatal(err)
						}
						unsafe := strings.Contains(
							findingCodes(result.Findings),
							"unsafe-unity-editor-provisioning",
						)
						unsupportedJoinPath := strings.Contains(
							strings.ToLower(normalizePowerShellPathExpression(joinPathWrapper)),
							"join-path",
						)
						unsupportedProgram := unsupportedDelegatedPowerShellProgram(
							joinPathWrapper,
						)
						if unsafe != (childName == "unsafe child" ||
							unsupportedJoinPath || unsupportedProgram) {
							t.Fatalf(
								"Join-Path recursion mismatch: findings=%#v audit=%#v unresolved=%v references=%#v commands=%#v",
								result.Findings,
								auditEnsureEditorSource(joinPathWrapper),
								hasUnresolvedPowerShellScriptInvocation(joinPathWrapper),
								invokedPowerShellReferences(joinPathWrapper),
								powerShellCommands(joinPathWrapper),
							)
						}
					})
				}
			})
		}
	})

	t.Run("unrelated Join-Path script graph remains outside editor policy", func(t *testing.T) {
		steps := strings.Replace(
			centralReturnSteps(),
			"      - id: acquire",
			`      - name: Run unrelated wrapper
        shell: pwsh
        run: ./scripts/ci/unrelated.ps1
      - id: acquire`,
			1,
		)
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": unityWorkflow(steps, safeAggregate()),
			"scripts/ci/unrelated.ps1":    "& (Join-Path $PSScriptRoot 'child.ps1')\n",
			"scripts/ci/child.ps1":        "Write-Host 'ordinary test driver'\n",
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(findingCodes(result.Findings), "unsafe-unity-editor-provisioning") {
			t.Fatalf("unrelated script graph entered editor policy: %#v", result.Findings)
		}
	})

	t.Run("shared and cyclic script graph terminates deterministically", func(t *testing.T) {
		steps := strings.Replace(
			centralReturnSteps(),
			"      - id: acquire",
			`      - name: First shared root
        shell: pwsh
        run: ./scripts/ci/a.ps1
      - name: Second shared root
        shell: pwsh
        run: ./scripts/ci/b.ps1
      - id: acquire`,
			1,
		)
		files := map[string]string{
			".github/workflows/unity.yml":     unityWorkflow(steps, safeAggregate()),
			"scripts/ci/a.ps1":                "& \"$PSScriptRoot/shared.ps1\"\n",
			"scripts/ci/b.ps1":                "& \"$PSScriptRoot/shared.ps1\"\n",
			"scripts/ci/shared.ps1":           safeScript,
			"scripts/unity/ensure-editor.ps1": "",
		}
		result, err := AnalyzeUnityEnrollment(unityFixture(files), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(findingCodes(result.Findings), "unsafe-unity-editor-provisioning") {
			t.Fatalf("shared safe descendant changed result: %#v", result.Findings)
		}

		files["scripts/ci/shared.ps1"] = "& \"$PSScriptRoot/cycle.ps1\"\n"
		files["scripts/ci/cycle.ps1"] = "& \"$PSScriptRoot/shared.ps1\"\n"
		result, err = AnalyzeUnityEnrollment(unityFixture(files), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(findingCodes(result.Findings), "unsafe-unity-editor-provisioning") {
			t.Fatalf("unrelated cycle changed result: %#v", result.Findings)
		}
	})

	for name, wrapper := range map[string]string{
		"single quoted Join-Path root": "& (Join-Path '$PSScriptRoot' " +
			"'unity.ps1')\n",
		"escaped double quoted Join-Path root": "& (Join-Path \"`$PSScriptRoot\" " +
			"'unity.ps1')\n",
		"single quoted direct root":         "& '$PSScriptRoot/unity.ps1'\n",
		"escaped double quoted direct root": "& \"`$PSScriptRoot/unity.ps1\"\n",
	} {
		t.Run(name+" fails closed", func(t *testing.T) {
			wrapper += "& \"$PSScriptRoot/relevant.ps1\" -Operation RequireEditor\n"
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml":     workflow,
				"scripts/ci/wrapper.ps1":          wrapper,
				"scripts/ci/relevant.ps1":         safeScript,
				"scripts/ci/unity.ps1":            safeScript,
				"scripts/unity/ensure-editor.ps1": "",
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(
				findingCodes(result.Findings),
				"unsafe-unity-editor-provisioning",
			) {
				t.Fatalf("literal root was treated as executable scope: %#v", result.Findings)
			}
		})
	}

	t.Run("comment delimiters do not affect delegated grammar balance", func(t *testing.T) {
		wrapper := "# unmatched comment delimiters ({\"\n" +
			"param([string]$Operation)\n& \"$PSScriptRoot/child.ps1\"\n"
		if unsupportedDelegatedPowerShellProgram(wrapper) {
			t.Fatal("comment-only delimiters rejected a valid delegated wrapper")
		}
		malformed := "param([string]$Operation # comment supplies )\n" +
			"& \"$PSScriptRoot/child.ps1\"\n"
		if !unsupportedDelegatedPowerShellProgram(malformed) {
			t.Fatal("comment text balanced malformed delegated code")
		}
	})

	t.Run("escaped direct child cannot redirect recursion to a decoy", func(t *testing.T) {
		unsafeChild := strings.Replace(safeScript, " -RequireHealthyExisting", "", 1)
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": workflow,
			"scripts/ci/wrapper.ps1": "& \"$PSScriptRoot/uni`ty.ps1\" " +
				"-Operation RequireEditor\n",
			"scripts/ci/unity.ps1":            unsafeChild,
			"scripts/ci/uni`ty.ps1":           safeScript,
			"scripts/unity/ensure-editor.ps1": "",
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(
			findingCodes(result.Findings),
			"unsafe-unity-editor-provisioning",
		) {
			t.Fatalf("escaped child audited a raw-name decoy: %#v", result.Findings)
		}
	})

	t.Run("segmented direct child cannot redirect recursion to a root decoy", func(t *testing.T) {
		unsafeChild := strings.Replace(safeScript, " -RequireHealthyExisting", "", 1)
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": workflow,
			"scripts/ci/wrapper.ps1": "& \"$PSScriptRoot/\"'unity.ps1' " +
				"-Operation RequireEditor\n",
			"scripts/ci/unity.ps1":            unsafeChild,
			"unity.ps1":                       safeScript,
			"scripts/unity/ensure-editor.ps1": "",
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(
			findingCodes(result.Findings),
			"unsafe-unity-editor-provisioning",
		) {
			t.Fatalf("segmented child audited a root decoy: %#v", result.Findings)
		}
	})

	for name, wrapper := range map[string]string{
		"direct then Join-Path": "$results = $(& \"$PSScriptRoot/safe.ps1\") + " +
			"$(& (Join-Path $PSScriptRoot 'unsafe.ps1'))\n",
		"Join-Path then direct": "$results = $(& (Join-Path $PSScriptRoot " +
			"'unsafe.ps1')) + $(& \"$PSScriptRoot/safe.ps1\")\n",
	} {
		t.Run(name+" audits both targets", func(t *testing.T) {
			unsafeChild := strings.Replace(safeScript, " -RequireHealthyExisting", "", 1)
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml":     workflow,
				"scripts/ci/wrapper.ps1":          wrapper,
				"scripts/ci/safe.ps1":             safeScript,
				"scripts/ci/unsafe.ps1":           unsafeChild,
				"scripts/unity/ensure-editor.ps1": "",
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(
				findingCodes(result.Findings),
				"unsafe-unity-editor-provisioning",
			) {
				t.Fatalf("mixed command skipped unsafe target: %#v", result.Findings)
			}
		})
	}

	for name, test := range map[string]struct {
		target string
		actual string
		decoy  string
	}{
		"space": {
			target: "\"$PSScriptRoot/my unity.ps1\"",
			actual: "scripts/ci/my unity.ps1",
			decoy:  "scripts/ci/unity.ps1",
		},
		"ampersand": {
			target: "\"$PSScriptRoot/foo&bar.ps1\"",
			actual: "scripts/ci/foo&bar.ps1",
			decoy:  "scripts/ci/bar.ps1",
		},
	} {
		t.Run("quoted "+name+" child cannot redirect recursion", func(t *testing.T) {
			unsafeChild := strings.Replace(safeScript, " -RequireHealthyExisting", "", 1)
			safeResult, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml":     workflow,
				"scripts/ci/wrapper.ps1":          "& " + test.target + "\n",
				"scripts/unity/ensure-editor.ps1": "",
				test.actual:                       safeScript,
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(
				findingCodes(safeResult.Findings),
				"unsafe-unity-editor-provisioning",
			) {
				t.Fatalf("quoted safe child produced a phantom reference: %#v", safeResult.Findings)
			}
			files := map[string]string{
				".github/workflows/unity.yml":     workflow,
				"scripts/ci/wrapper.ps1":          "& " + test.target + "\n",
				"scripts/unity/ensure-editor.ps1": "",
				test.actual:                       unsafeChild,
				test.decoy:                        safeScript,
			}
			result, err := AnalyzeUnityEnrollment(unityFixture(files), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(
				findingCodes(result.Findings),
				"unsafe-unity-editor-provisioning",
			) {
				t.Fatalf("quoted child audited a delimiter decoy: %#v", result.Findings)
			}
		})
	}

	t.Run("here-string syntax fails closed before later execution", func(t *testing.T) {
		for name, wrapper := range map[string]string{
			"expandable": "$text = @\"\n\"\n\"@\n& $env:PAYLOAD\n",
			"literal":    "$text = @'\n'\n'@\n& $env:PAYLOAD\n",
		} {
			t.Run(name, func(t *testing.T) {
				if !hasUnresolvedPowerShellWorkflowInvocation(wrapper) {
					t.Fatal("unsupported here-string syntax did not fail closed")
				}
			})
		}
	})

	t.Run("runtime-loaded delegated target fails closed", func(t *testing.T) {
		wrapper := "$x = Get-Content \"$PSScriptRoot/target.txt\"\n& $x\n" +
			"& \"$PSScriptRoot/relevant.ps1\" -Operation RequireEditor\n"
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": workflow,
			"scripts/ci/wrapper.ps1":      wrapper,
			"scripts/ci/relevant.ps1":     safeScript,
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(
			findingCodes(result.Findings),
			"unsafe-unity-editor-provisioning",
		) {
			t.Fatalf("runtime-loaded target passed delegated audit: %#v", result.Findings)
		}
	})

	t.Run("delegated child replacement fails closed", func(t *testing.T) {
		wrapper := "Copy-Item -LiteralPath \"$PSScriptRoot/payload.template\" " +
			"-Destination \"$PSScriptRoot/child.ps1\" -Force\n" +
			"& \"$PSScriptRoot/child.ps1\"\n"
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": workflow,
			"scripts/ci/wrapper.ps1":      wrapper,
			"scripts/ci/child.ps1":        safeScript,
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(
			findingCodes(result.Findings),
			"unsafe-unity-editor-provisioning",
		) {
			t.Fatalf("runtime child replacement passed: %#v", result.Findings)
		}
	})

	t.Run("same-basename intermediate is not a trusted terminal", func(t *testing.T) {
		wrapper := "Copy-Item -LiteralPath \"$PSScriptRoot/payload.template\" " +
			"-Destination \"$PSScriptRoot/child.ps1\" -Force\n" +
			"& \"$PSScriptRoot/../unity/ensure-editor.ps1\" " +
			"-CiManagedOnly -RequireHealthyExisting\n"
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml":     workflow,
			"scripts/ci/wrapper.ps1":          "& \"$PSScriptRoot/ensure-editor.ps1\"\n",
			"scripts/ci/ensure-editor.ps1":    wrapper,
			"scripts/ci/payload.template":     "Write-Host replacement\n",
			"scripts/unity/ensure-editor.ps1": "",
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(
			findingCodes(result.Findings),
			"unsafe-unity-editor-provisioning",
		) {
			t.Fatalf("same-basename intermediate inherited terminal trust: %#v", result.Findings)
		}
	})

	for name, wrapper := range map[string]string{
		"parameter attribute script": "param([ValidateScript({ Copy-Item a b })]" +
			"[string]$Operation)\n& \"$PSScriptRoot/child.ps1\"\n",
		"expandable argument script": "param([string]$Operation)\n" +
			"& \"$PSScriptRoot/child.ps1\" -Value \"$(Copy-Item a b)\"\n",
		"parenthesized argument expression": "param([string]$Operation)\n" +
			"& \"$PSScriptRoot/child.ps1\" -Value (Get-Date)\n",
		"empty program": "",
		"repeated declaration": "param([string]$Operation)\n" +
			"param([string]$Operation)\n& \"$PSScriptRoot/child.ps1\"\n",
		"repeated invocation": "& \"$PSScriptRoot/child.ps1\"\n" +
			"& \"$PSScriptRoot/child.ps1\"\n",
		"unterminated declaration": "param([string]$Operation\n" +
			"& \"$PSScriptRoot/child.ps1\"\n",
	} {
		t.Run(name+" is outside delegated grammar", func(t *testing.T) {
			if !unsupportedDelegatedPowerShellProgram(wrapper) {
				t.Fatal("executable wrapper syntax passed the allowlist")
			}
		})
	}

	for name, wrapper := range map[string]string{
		"Start-Job":      "Start-Job -FilePath \"$PSScriptRoot/unsafe.ps1\"\n",
		"Invoke-Command": "Invoke-Command -FilePath \"$PSScriptRoot/unsafe.ps1\"\n",
	} {
		t.Run(name+" file execution fails closed", func(t *testing.T) {
			if !hasUnresolvedPowerShellScriptInvocation(wrapper) {
				t.Fatal("file-executing cmdlet passed unresolved audit")
			}
		})
	}

	for name, wrapper := range map[string]string{
		"workspace assignment": "$env:GITHUB_WORKSPACE = $env:RUNNER_TEMP\n" +
			"& \"$env:GITHUB_WORKSPACE/unsafe.ps1\"\n",
		"script root assignment": "$PSScriptRoot = $env:RUNNER_TEMP\n" +
			"& \"$PSScriptRoot/unsafe.ps1\"\n",
		"scoped script root assignment": "$script:PSScriptRoot = $env:RUNNER_TEMP\n" +
			"& \"$PSScriptRoot/unsafe.ps1\"\n",
		"compound script root assignment": "$PSScriptRoot += 'redirect'\n" +
			"& \"$PSScriptRoot/unsafe.ps1\"\n",
		"Set-Variable alias": "sv PSScriptRoot $env:RUNNER_TEMP\n" +
			"& \"$PSScriptRoot/unsafe.ps1\"\n",
		"variable provider mutation": "Set-Item Variable:PSScriptRoot $env:RUNNER_TEMP\n" +
			"& \"$PSScriptRoot/unsafe.ps1\"\n",
		"scoped variable provider mutation": "Set-Item 'Variable:\\script:PSScriptRoot' " +
			"$env:RUNNER_TEMP\n& \"$PSScriptRoot/unsafe.ps1\"\n",
		"environment provider mutation": "Set-Item 'Env:\\GITHUB_WORKSPACE' " +
			"$env:RUNNER_TEMP\n& \"$env:GITHUB_WORKSPACE/unsafe.ps1\"\n",
		"SessionState path mutation": "$ExecutionContext.SessionState.Path." +
			"SetLocation($env:RUNNER_TEMP)\n& ./unsafe.ps1\n",
		"SessionState variable mutation": "$ExecutionContext.SessionState.PSVariable." +
			"Set('PSScriptRoot',$env:RUNNER_TEMP)\n& \"$PSScriptRoot/unsafe.ps1\"\n",
		"Set-Location": "Set-Location $env:RUNNER_TEMP\n& ./unsafe.ps1\n",
		"module qualified Set-Location": "Microsoft.PowerShell.Management\\Set-Location " +
			"$env:RUNNER_TEMP\n& ./unsafe.ps1\n",
		"Push-Location": "Push-Location $env:RUNNER_TEMP\n& ./unsafe.ps1\n",
		"cd alias":      "cd $env:RUNNER_TEMP\n& ./unsafe.ps1\n",
		"sl alias":      "sl $env:RUNNER_TEMP\n& ./unsafe.ps1\n",
		"chdir alias":   "chdir $env:RUNNER_TEMP\n& ./unsafe.ps1\n",
		"function shadows Join-Path": "function Join-Path { param($Path, $ChildPath) " +
			"\"$env:RUNNER_TEMP/$ChildPath\" }\n" +
			"& (Join-Path $PSScriptRoot 'unsafe.ps1')\n",
		"alias shadows Join-Path": "Set-Alias Join-Path Invoke-External\n" +
			"& (Join-Path $PSScriptRoot 'unsafe.ps1')\n",
		"alias indirection": "Set-Alias go Set-Location\ngo $env:RUNNER_TEMP\n" +
			"& ./unsafe.ps1\n",
		"filter definition": "filter Join-Path { $_ }\n" +
			"& (Join-Path $PSScriptRoot 'unsafe.ps1')\n",
	} {
		t.Run(name+" cannot redirect a trusted path", func(t *testing.T) {
			wrapper += "& \"$PSScriptRoot/relevant.ps1\" -Operation RequireEditor\n"
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml": workflow,
				"scripts/ci/wrapper.ps1":      wrapper,
				"scripts/ci/relevant.ps1":     safeScript,
				"unsafe.ps1":                  safeScript,
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(
				findingCodes(result.Findings),
				"unsafe-unity-editor-provisioning",
			) {
				t.Fatalf("path-context mutation passed: %#v", result.Findings)
			}
		})
	}

	for name, mutatedWorkflow := range map[string]string{
		"step working directory": strings.Replace(
			workflow,
			"run: ./scripts/ci/wrapper.ps1 -Operation RequireEditor",
			"working-directory: scripts/alt\n        run: ./wrapper.ps1",
			1,
		),
		"job default working directory": strings.Replace(
			strings.Replace(
				workflow,
				"runs-on: [self-hosted, Windows]",
				"runs-on: [self-hosted, Windows]\n    defaults:\n      run:\n        working-directory: scripts/alt",
				1,
			),
			"run: ./scripts/ci/wrapper.ps1 -Operation RequireEditor",
			"run: ./wrapper.ps1",
			1,
		),
	} {
		t.Run(name+" fails closed", func(t *testing.T) {
			unsafeChild := strings.Replace(safeScript, " -RequireHealthyExisting", "", 1)
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml":     mutatedWorkflow,
				"wrapper.ps1":                     safeScript,
				"scripts/alt/wrapper.ps1":         unsafeChild,
				"scripts/unity/ensure-editor.ps1": "",
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(
				findingCodes(result.Findings),
				"unsafe-unity-editor-provisioning",
			) {
				t.Fatalf("working-directory path redirection passed: %#v", result.Findings)
			}
		})
	}

	t.Run("escaped braced script root cannot redirect recursion to a decoy", func(t *testing.T) {
		unsafeChild := strings.Replace(safeScript, " -RequireHealthyExisting", "", 1)
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": workflow,
			"scripts/ci/wrapper.ps1": "& (Join`-Path ${PSScriptRoot} " +
				"'unity.ps1') -Operation RequireEditor\n",
			"scripts/ci/unity.ps1":            unsafeChild,
			"unity.ps1":                       safeScript,
			"scripts/unity/ensure-editor.ps1": "",
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(
			findingCodes(result.Findings),
			"unsafe-unity-editor-provisioning",
		) {
			t.Fatalf("wrapper-relative unsafe child escaped via root decoy: %#v", result.Findings)
		}
	})

	t.Run("literal backtick root cannot redirect recursion to a decoy", func(t *testing.T) {
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": workflow,
			"scripts/ci/wrapper.ps1": "& (Join-Path $PSScriptRoot`` " +
				"'unity.ps1')\n& \"$PSScriptRoot/relevant.ps1\" -Operation RequireEditor\n",
			"scripts/ci/relevant.ps1":         safeScript,
			"scripts/ci/unity.ps1":            safeScript,
			"scripts/unity/ensure-editor.ps1": "",
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(
			findingCodes(result.Findings),
			"unsafe-unity-editor-provisioning",
		) {
			t.Fatalf("literal-backtick root audited normal-root decoy: %#v", result.Findings)
		}
	})

	t.Run("invalid Join-Path forms fail closed", func(t *testing.T) {
		for name, wrapper := range map[string]string{
			"metachar argument": "&(Join-Path($PSScriptRoot) 'unity.ps1')\n",
			"continued name":    "& (Join-`\nPath $PSScriptRoot 'unity.ps1')\n",
		} {
			t.Run(name, func(t *testing.T) {
				if !hasUnresolvedPowerShellScriptInvocation(wrapper) {
					t.Fatal("invalid form was accepted as a safe literal expression")
				}
			})
		}
	})

	t.Run("inert Join-Path-looking output is not invoked", func(t *testing.T) {
		const inert = "Write-Output '& (Join-Path $PSScriptRoot ''decoy.ps1'''\n"
		references := invokedPowerShellReferences(inert)
		if len(references) != 0 {
			t.Fatalf("inert output produced invoked references: %#v", references)
		}
	})

	t.Run("bare path strings are inert", func(t *testing.T) {
		for name, source := range map[string]string{
			"bare":          "\"$PSScriptRoot/unsafe.ps1\"\n",
			"parenthesized": "(\"$PSScriptRoot/unsafe.ps1\")\n",
		} {
			t.Run(name, func(t *testing.T) {
				if references := invokedPowerShellReferences(source); len(references) != 0 {
					t.Fatalf("inert string produced invoked references: %#v", references)
				}
			})
		}
	})

	t.Run("external Join-Path expression fails closed", func(t *testing.T) {
		externalPreparation := `      - name: Run external preparation
        shell: pwsh
        run: '& (Join-Path $env:TEMP ''install.ps1'')'
`
		externalWorkflow := unityWorkflow(
			strings.Replace(
				centralReturnSteps(),
				"      - id: acquire\n",
				externalPreparation+"      - id: acquire\n",
				1,
			),
			safeAggregate(),
		)
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": externalWorkflow,
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(
			findingCodes(result.Findings),
			"unsafe-unity-editor-provisioning",
		) {
			t.Fatalf("external Join-Path invocation passed: %#v", result.Findings)
		}
	})

	t.Run("missing repository Join-Path target fails closed", func(t *testing.T) {
		missingPreparation := `      - name: Run missing preparation
        shell: pwsh
        run: '& (Join-Path $env:GITHUB_WORKSPACE ''scripts/ci/missing.ps1'')'
`
		missingWorkflow := unityWorkflow(
			strings.Replace(
				centralReturnSteps(),
				"      - id: acquire\n",
				missingPreparation+"      - id: acquire\n",
				1,
			),
			safeAggregate(),
		)
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": missingWorkflow,
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(
			findingCodes(result.Findings),
			"unsafe-unity-editor-provisioning",
		) {
			t.Fatalf("missing Join-Path target passed: %#v", result.Findings)
		}
	})

	t.Run("delegated invoke-expression fails closed", func(t *testing.T) {
		evalWrapper := `$command = './scripts/unity/ensure-' + 'editor.ps1'
iex $command
& "$PSScriptRoot/relevant.ps1" -Operation RequireEditor
`
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": workflow,
			"scripts/ci/wrapper.ps1":      evalWrapper,
			"scripts/ci/relevant.ps1":     safeScript,
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(findingCodes(result.Findings), "unsafe-unity-editor-provisioning") {
			t.Fatalf("delegated Invoke-Expression passed: %#v", result.Findings)
		}
	})

	t.Run("delegated child PowerShell command fails closed", func(t *testing.T) {
		childShellWrapper := `$command = './scripts/unity/ensure-' + 'editor.ps1'
powershell.exe -NoProfile -c $command
& "$PSScriptRoot/relevant.ps1" -Operation RequireEditor
`
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": workflow,
			"scripts/ci/wrapper.ps1":      childShellWrapper,
			"scripts/ci/relevant.ps1":     safeScript,
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(findingCodes(result.Findings), "unsafe-unity-editor-provisioning") {
			t.Fatalf("delegated child PowerShell command passed: %#v", result.Findings)
		}
	})

	t.Run("delegated quoted child PowerShell command fails closed", func(t *testing.T) {
		quotedChildShellWrapper := `$shell = 'pwsh'
$command = './scripts/unity/ensure-' + 'editor.ps1'
& "$shell" -NoProfile -c $command
& "$PSScriptRoot/relevant.ps1" -Operation RequireEditor
`
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": workflow,
			"scripts/ci/wrapper.ps1":      quotedChildShellWrapper,
			"scripts/ci/relevant.ps1":     safeScript,
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(findingCodes(result.Findings), "unsafe-unity-editor-provisioning") {
			t.Fatalf("delegated quoted child PowerShell command passed: %#v", result.Findings)
		}
	})

	t.Run("non-running delegated path string is not a gate", func(t *testing.T) {
		workflow := unityWorkflow(strings.Replace(
			centralReturnSteps(),
			testEditorRun,
			"run: Write-Host './scripts/ci/wrapper.ps1'",
			1,
		), safeAggregate())
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": workflow,
			"scripts/ci/wrapper.ps1":      safeScript,
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(findingCodes(result.Findings), "missing-unity-editor-check") {
			t.Fatalf("non-running script string counted as a gate: %#v", result.Findings)
		}
	})

	t.Run("composite control flow is not a direct workflow gate", func(t *testing.T) {
		gate := `      - name: Require manually installed Unity editor
        timeout-minutes: 10
        shell: ` + trustedEditorShell + `
        ` + testEditorRun + `
`
		compositeGate := `      - name: Require manually installed Unity editor
        timeout-minutes: 10
        uses: ./.github/actions/editor-check
`
		workflow := unityWorkflow(
			strings.Replace(centralReturnSteps(), gate, compositeGate, 1),
			safeAggregate(),
		)
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": workflow,
			".github/actions/editor-check/action.yml": `name: Editor check
runs:
  using: composite
  steps:
    - shell: pwsh
      run: ./scripts/unity/ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting
`,
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(findingCodes(result.Findings), "missing-unity-editor-check") {
			t.Fatalf("composite editor check counted as a direct gate: %#v", result.Findings)
		}
	})

	t.Run("delegated provisioning control is rejected", func(t *testing.T) {
		controlWrapper := `$env:UH_ENSURE_EDITOR_INSTALL_TIMEOUT_SECONDS = '7200'
& "$PSScriptRoot/unity.ps1" -Operation RequireEditor
`
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
			".github/workflows/unity.yml": workflow,
			"scripts/ci/wrapper.ps1":      controlWrapper,
			"scripts/ci/unity.ps1":        safeScript,
		}), unityAuditPolicy())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(findingCodes(result.Findings), "unity-editor-provisioning-control") {
			t.Fatalf("delegated provisioning control passed: %#v", result.Findings)
		}
	})
}

func TestAuditEnsureEditorSourceAcceptsPinnedCheckoutPipeline(t *testing.T) {
	source := `$editor = & "$env:GITHUB_WORKSPACE/.ci/unity-helpers/scripts/unity/ensure-editor.ps1" ` + "`" + `
  -UnityVersion '6000.5.2f1' ` + "`" + `
  -CiManagedOnly ` + "`" + `
  -RequireHealthyExisting |
  Select-Object -Last 1
$expectedEditor = Join-Path $env:RUNNER_TOOL_CACHE '6000.5.2f1\Editor\Unity.exe'
`
	result := auditEnsureEditorSource(source)
	if !result.found || result.unsafe || result.provisioningControl {
		t.Fatalf(
			"pinned-checkout editor gate audit = %#v; commands=%#v; references=%#v",
			result,
			powerShellCommands(source),
			powerShellPathReferences(powerShellCommands(source)[0]),
		)
	}
	if commandInvokesUnityExecutable(
		`$expectedEditor = 'D:\tool\6000.5.2f1\Editor\Unity.exe'`,
	) {
		t.Fatal("an editor path assignment was classified as execution")
	}
	if !commandInvokesUnityExecutable(
		`& 'D:\tool\6000.5.2f1\Editor\Unity.exe' -quit`,
	) {
		t.Fatal("a literal editor invocation was not classified as execution")
	}
}

func TestUnityEnrollmentAcceptsIsolatedTrustedSkipAggregate(t *testing.T) {
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": unityWorkflow(centralReturnSteps(), trustedSkipAggregate()),
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Findings) != 0 {
		t.Fatalf("trusted skip aggregate produced findings: %#v", result.Findings)
	}
}

func TestUnityEnrollmentRejectsTrustedSkipAggregateMutations(t *testing.T) {
	base := unityWorkflow(safeLicensedSteps(), trustedSkipAggregate())
	tests := []struct {
		name   string
		mutate func(string) string
	}{
		{
			name: "preflight result spoofed",
			mutate: func(value string) string {
				return strings.Replace(value, "${{ needs.preflight.result }}", "success", 1)
			},
		},
		{
			name: "fork decision spoofed",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository }}",
					"true",
					1,
				)
			},
		},
		{
			name: "Dependabot decision is not PR scoped",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"${{ github.event_name == 'pull_request' && github.event.pull_request.user.login == 'dependabot[bot]' }}",
					"${{ github.event.pull_request.user.login == 'dependabot[bot]' }}",
					1,
				)
			},
		},
		{
			name: "Dependabot decision uses rerun actor",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"github.event.pull_request.user.login == 'dependabot[bot]'",
					"github.actor == 'dependabot[bot]'",
					1,
				)
			},
		},
		{
			name: "licensed failure accepted",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					`test "${UNITY_TESTS_RESULT}" = success`,
					`test "${UNITY_TESTS_RESULT}" != cancelled`,
					1,
				)
			},
		},
		{
			name: "extra executable step",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"      - shell: bash\n",
					"      - run: echo prepare\n      - shell: bash\n",
					1,
				)
			},
		},
		{
			name: "job execution environment",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"  aggregate:\n    if:",
					"  aggregate:\n    env:\n      BASH_ENV: ./consumer.sh\n    if:",
					1,
				)
			},
		},
		{
			name: "approval environment",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"  aggregate:\n    if: always()\n",
					"  aggregate:\n    environment: production\n    if: always()\n",
					1,
				)
			},
		},
		{
			name: "cancelable job concurrency",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"  aggregate:\n    if: always()\n",
					"  aggregate:\n    concurrency:\n      group: aggregate\n      cancel-in-progress: true\n    if: always()\n",
					1,
				)
			},
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml": testCase.mutate(base),
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(findingCodes(result.Findings), "missing-unity-aggregate") {
				t.Fatalf("mutated trusted skip aggregate was accepted: %#v", result.Findings)
			}
		})
	}
}

func TestUnityEnrollmentAcceptsCentralAcquiredScopedReturn(t *testing.T) {
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": unityWorkflow(centralReturnSteps(), safeAggregate()),
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Findings) != 0 {
		t.Fatalf("central acquired-scoped return produced findings: %#v", result.Findings)
	}
}

func TestUnityEnrollmentAcceptsReviewedAlternateEditorLayout(t *testing.T) {
	workflow := strings.Replace(
		unityWorkflow(centralReturnSteps(), safeAggregate()),
		"          evidence-suffix: qora\n",
		"          evidence-suffix: qora\n          editor-layout: ci-managed-alternate\n",
		1,
	)
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": workflow,
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Findings) != 0 {
		t.Fatalf("reviewed alternate editor layout produced findings: %#v", result.Findings)
	}
}

func TestUnityEnrollmentAcceptsCentralReturnFromStaticVersionMatrix(t *testing.T) {
	workflow := strings.Replace(
		unityWorkflow(centralReturnSteps(), safeAggregate()),
		"        mode: [EditMode]\n",
		"        test-mode: [editmode, standalone]\n        unity-version: [2022.3.45f1, 6000.5.2f1]\n",
		1,
	)
	workflow = strings.ReplaceAll(
		workflow,
		"${{ matrix.mode }}",
		"${{ matrix.test-mode }}",
	)
	workflow = strings.Replace(
		workflow,
		"          unity-version: 6000.5.2f1\n",
		"          unity-version: ${{ matrix.unity-version }}\n",
		1,
	)
	workflow = strings.Replace(
		workflow,
		testEditorGateCommand,
		trustedEditorGateCommandWithProfile(
			"${{ matrix.unity-version }}",
			trustedEditorMatrixProfile,
		),
		1,
	)
	workflow = strings.ReplaceAll(
		workflow,
		"          holder-id-suffix: qora\n",
		"          holder-id-suffix: ${{ matrix.unity-version }}-${{ matrix.test-mode }}\n",
	)
	workflow = strings.Replace(
		workflow,
		"unity-editor -batchmode -serial",
		"unity-editor -batchmode -UnityVersion '${{ matrix.unity-version }}' -serial",
		1,
	)
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": workflow,
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Findings) != 0 {
		t.Fatalf("static matrix central return produced findings: %#v", result.Findings)
	}
	for _, mutation := range []struct {
		name    string
		profile string
	}{
		{
			name:    "literal editor-only downgrade",
			profile: "EditorOnly",
		},
		{
			name:    "tampered standalone mapping",
			profile: `${{ fromJSON('{"editmode":"EditorOnly","playmode":"EditorOnly","standalone":"EditorOnly"}')[matrix.test-mode] }}`,
		},
	} {
		t.Run("profile "+mutation.name, func(t *testing.T) {
			mutated := strings.Replace(
				workflow,
				`${{ fromJSON('{"editmode":"EditorOnly","playmode":"EditorOnly","standalone":"StandaloneWindowsIl2Cpp"}')[matrix.test-mode] }}`,
				mutation.profile,
				1,
			)
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml": mutated,
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(
				findingCodes(result.Findings),
				"missing-unity-editor-check",
			) {
				t.Fatalf("unsafe profile passed: %#v", result.Findings)
			}
		})
	}
	for _, mutation := range []struct {
		name  string
		modes string
	}{
		{name: "unsupported", modes: "[editmode, android]"},
		{name: "duplicate", modes: "[editmode, editmode]"},
		{name: "dynamic", modes: "${{ fromJSON(needs.config.outputs.modes) }}"},
	} {
		t.Run("profile matrix "+mutation.name, func(t *testing.T) {
			mutated := strings.Replace(
				workflow,
				"[editmode, standalone]",
				mutation.modes,
				1,
			)
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml": mutated,
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(
				findingCodes(result.Findings),
				"missing-unity-editor-check",
			) {
				t.Fatalf("unsafe profile matrix passed: %#v", result.Findings)
			}
		})
	}
}

func TestUnityEnrollmentRejectsUnboundedCentralReturnVersionMatrix(t *testing.T) {
	base := strings.Replace(
		unityWorkflow(centralReturnSteps(), safeAggregate()),
		"          unity-version: 6000.5.2f1\n",
		"          unity-version: ${{ matrix.unity-version }}\n",
		1,
	)
	base = strings.Replace(
		base,
		testEditorGateCommand,
		trustedEditorGateCommand("${{ matrix.unity-version }}"),
		1,
	)
	base = strings.ReplaceAll(
		base,
		"          holder-id-suffix: qora\n",
		"          holder-id-suffix: ${{ matrix.unity-version }}-${{ matrix.mode }}\n",
	)
	base = strings.Replace(
		base,
		"unity-editor -batchmode -serial",
		"unity-editor -batchmode -UnityVersion '${{ matrix.unity-version }}' -serial",
		1,
	)
	tests := []struct {
		name   string
		matrix string
	}{
		{name: "missing version axis", matrix: "        mode: [EditMode]\n"},
		{name: "dynamic version axis", matrix: "        mode: [EditMode]\n        unity-version: ${{ fromJSON(needs.config.outputs.versions) }}\n"},
		{name: "empty version axis", matrix: "        mode: [EditMode]\n        unity-version: []\n"},
		{name: "invalid version", matrix: "        mode: [EditMode]\n        unity-version: [latest]\n"},
		{name: "beta-only version axis", matrix: "        mode: [EditMode]\n        unity-version: [6000.5.2b1]\n"},
		{name: "mixed final and beta version axis", matrix: "        mode: [EditMode]\n        unity-version: [6000.5.2f1, 6000.5.2b1]\n"},
		{name: "duplicate version", matrix: "        mode: [EditMode]\n        unity-version: [6000.5.2f1, 6000.5.2f1]\n"},
		{name: "case duplicate version", matrix: "        mode: [EditMode]\n        unity-version: [6000.5.2f1, 6000.5.2F1]\n"},
		{name: "expression-valued axis", matrix: "        mode: ['${{ matrix.unity-version }}']\n        unity-version: [6000.5.2f1]\n"},
		{name: "include override", matrix: "        mode: [EditMode]\n        unity-version: [6000.5.2f1]\n        include:\n          - unity-version: latest\n"},
		{name: "exclude rewrite surface", matrix: "        mode: [EditMode]\n        unity-version: [6000.5.2f1]\n        exclude:\n          - unity-version: 6000.5.2f1\n"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			workflow := strings.Replace(base, "        mode: [EditMode]\n", testCase.matrix, 1)
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml": workflow,
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(findingCodes(result.Findings), "missing-unity-return") {
				t.Fatalf("unbounded matrix return was accepted: %#v", result.Findings)
			}
		})
	}
}

func TestUnityEnrollmentRejectsCollidingCentralReturnVersionMatrix(t *testing.T) {
	base := strings.Replace(
		unityWorkflow(centralReturnSteps(), safeAggregate()),
		"        mode: [EditMode]\n",
		"        a: [x, xy]\n        b: [yz, z]\n        unity-version: [2022.3.45f1]\n",
		1,
	)
	base = strings.Replace(
		base,
		"          unity-version: 6000.5.2f1\n",
		"          unity-version: ${{ matrix.unity-version }}\n",
		1,
	)
	tests := []struct {
		name   string
		suffix string
	}{
		{
			name:   "literal holder collides",
			suffix: "qora",
		},
		{
			name:   "holder omits an axis",
			suffix: "${{ matrix.unity-version }}-${{ matrix.a }}",
		},
		{
			name:   "cross-axis concatenation collides",
			suffix: "${{ matrix.unity-version }}-${{ matrix.a }}${{ matrix.b }}",
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			workflow := strings.ReplaceAll(
				base,
				"          holder-id-suffix: qora\n",
				"          holder-id-suffix: "+testCase.suffix+"\n",
			)
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml": workflow,
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(findingCodes(result.Findings), "missing-unity-return") {
				t.Fatalf("colliding matrix return was accepted: %#v", result.Findings)
			}
		})
	}
}

func TestUnityEnrollmentRejectsGloballyApprovedButUnapprovedReturnSHA(t *testing.T) {
	const historicalSHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	policy := unityAuditPolicy()
	policy.ApprovedLockSHAs = append(policy.ApprovedLockSHAs, historicalSHA)
	workflow := strings.Replace(
		unityWorkflow(centralReturnSteps(), safeAggregate()),
		returnActionRef,
		lockActionPrefix+"return-unity-license@"+historicalSHA,
		1,
	)
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": workflow,
	}), policy)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(findingCodes(result.Findings), "missing-unity-return") {
		t.Fatalf("historical globally approved SHA authorized return: %#v", result.Findings)
	}
}

func TestUnityEnrollmentRejectsCentralReturnContractMutations(t *testing.T) {
	base := unityWorkflow(centralReturnSteps(), safeAggregate())
	tests := []struct {
		name   string
		mutate func(string) string
		code   string
	}{
		{
			name: "mutable return",
			mutate: func(value string) string {
				return strings.Replace(value, returnActionRef, lockActionPrefix+"return-unity-license@main", 1)
			},
			code: "mutable-action-ref",
		},
		{
			name: "noncanonical return path",
			mutate: func(value string) string {
				return strings.Replace(value, returnActionRef, strings.Replace(returnActionRef, "@", "/@", 1), 1)
			},
			code: "missing-unity-return",
		},
		{
			name: "wrong acquire identity",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"${{ always() && steps.acquire.outputs.acquired == 'true' }}",
					"${{ always() && steps.other.outputs.acquired == 'true' }}",
					1,
				)
			},
			code: "missing-unity-return",
		},
		{
			name: "missing always",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"${{ always() && steps.acquire.outputs.acquired == 'true' }}",
					"${{ steps.acquire.outputs.acquired == 'true' }}",
					1,
				)
			},
			code: "missing-unity-return",
		},
		{
			name: "return continue on error",
			mutate: func(value string) string {
				return strings.Replace(value, "      - id: return_command\n", "      - id: return_command\n        continue-on-error: true\n", 1)
			},
			code: "missing-unity-return",
		},
		{
			name: "short return timeout",
			mutate: func(value string) string {
				return strings.Replace(value, "      - id: return_command\n", "      - id: return_command\n        timeout-minutes: 1\n", 1)
			},
			code: "missing-unity-return",
		},
		{
			name: "return environment",
			mutate: func(value string) string {
				return strings.Replace(value, "        uses: "+returnActionRef+"\n", "        uses: "+returnActionRef+"\n        env:\n          EXTRA: value\n", 1)
			},
			code: "missing-unity-return",
		},
		{
			name: "caller executable input",
			mutate: func(value string) string {
				return strings.Replace(value, "          evidence-suffix: qora\n", "          evidence-suffix: qora\n          editor-path: Unity.exe\n", 1)
			},
			code: "missing-unity-return",
		},
		{
			name: "tool cache from environment",
			mutate: func(value string) string {
				return strings.Replace(value, "${{ runner.tool_cache }}", "${{ env.RUNNER_TOOL_CACHE }}", 1)
			},
			code: "missing-unity-return",
		},
		{
			name: "unknown editor layout",
			mutate: func(value string) string {
				return strings.Replace(value, "          evidence-suffix: qora\n", "          evidence-suffix: qora\n          editor-layout: consumer-path\n", 1)
			},
			code: "missing-unity-return",
		},
		{
			name: "editor layout expression",
			mutate: func(value string) string {
				return strings.Replace(value, "          evidence-suffix: qora\n", "          evidence-suffix: qora\n          editor-layout: ${{ env.EDITOR_LAYOUT }}\n", 1)
			},
			code: "missing-unity-return",
		},
		{
			name: "classifier missing acquired guard",
			mutate: func(value string) string {
				first := strings.Index(value, "${{ always() && steps.acquire.outputs.acquired == 'true' }}")
				second := strings.Index(value[first+1:], "${{ always() && steps.acquire.outputs.acquired == 'true' }}")
				if first < 0 || second < 0 {
					return value
				}
				index := first + 1 + second
				target := "${{ always() && steps.acquire.outputs.acquired == 'true' }}"
				return value[:index] + "always()" + value[index+len(target):]
			},
			code: "classifier-not-always",
		},
		{
			name: "classifier environment",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"        uses: "+classifierAction+"\n",
					"        uses: "+classifierAction+"\n        env:\n          NODE_OPTIONS: --require=./consumer.js\n",
					1,
				)
			},
			code: "classifier-not-always",
		},
		{
			name: "short classifier timeout",
			mutate: func(value string) string {
				return strings.Replace(value, "      - id: cleanup_classification\n", "      - id: cleanup_classification\n        timeout-minutes: 1\n", 1)
			},
			code: "classifier-not-always",
		},
		{
			name: "classifier digest not linked",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"${{ steps.return_command.outputs.return-log-digest }}",
					strings.Repeat("0", 64),
					1,
				)
			},
			code: "classifier-inputs-not-typed",
		},
		{
			name: "later licensed invocation",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"      - id: release\n",
					"      - name: Late Unity\n        run: unity-editor -batchmode -serial \"${UNITY_SERIAL}\"\n      - id: release\n",
					1,
				)
			},
			code: "missing-unity-return",
		},
		{
			name: "opaque executable step after return",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"  aggregate:\n",
					"      - name: Opaque late command\n        if: ${{ always() && steps.acquire.outputs.acquired == 'true' }}\n        shell: pwsh\n        run: '& ($env:EDITOR_STEM + ''.exe'') -serial $env:UNITY_SERIAL'\n        env:\n          EDITOR_STEM: Unity\n          UNITY_SERIAL: ${{ secrets.UNITY_SERIAL }}\n  aggregate:\n",
					1,
				)
			},
			code: "unsafe-central-return-suffix",
		},
		{
			name: "opaque executable step interleaved after return",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"      - id: cleanup_classification\n",
					"      - name: Opaque late command\n        run: echo execute\n      - id: cleanup_classification\n",
					1,
				)
			},
			code: "unsafe-central-return-suffix",
		},
		{
			name: "workflow execution environment",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"concurrency:\n",
					"env:\n  NODE_OPTIONS: --require=./consumer.js\nconcurrency:\n",
					1,
				)
			},
			code: "unsafe-return-execution-environment",
		},
		{
			name: "job execution environment",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"  unity:\n    needs:",
					"  unity:\n    env:\n      NODE_OPTIONS: --require=./consumer.js\n    needs:",
					1,
				)
			},
			code: "unsafe-return-execution-environment",
		},
		{
			name: "job container",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"    runs-on: [self-hosted, Windows]\n",
					"    runs-on: [self-hosted, Windows]\n    container:\n      image: windows\n      env:\n        NODE_OPTIONS: --require=./consumer.js\n",
					1,
				)
			},
			code: "unsafe-return-execution-environment",
		},
		{
			name: "job services",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"    runs-on: [self-hosted, Windows]\n",
					"    runs-on: [self-hosted, Windows]\n    services:\n      spoof:\n        image: consumer\n",
					1,
				)
			},
			code: "unsafe-return-execution-environment",
		},
		{
			name: "non-Windows runner",
			mutate: func(value string) string {
				return strings.Replace(value, "[self-hosted, Windows]", "[self-hosted, linux]", 1)
			},
			code: "unsafe-return-execution-environment",
		},
		{
			name: "duplicate acquire",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"      - name: Run Unity\n",
					"      - id: acquire_again\n        uses: "+lockActionPrefix+"acquire-build-lock@"+testSHA+"\n      - name: Run Unity\n",
					1,
				)
			},
			code: "ambiguous-lock-acquire",
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml": testCase.mutate(base),
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(findingCodes(result.Findings), testCase.code) {
				t.Fatalf("missing %s: %#v", testCase.code, result.Findings)
			}
		})
	}
}

func TestUnityEnrollmentAcceptsCanonicalFallbackCleanup(t *testing.T) {
	licensedSteps := centralReturnSteps()
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
	credentialValidation := `      - name: Validate Unity credentials
        uses: ` + lockActionPrefix + `validate-unity-license@` + testSHA + `
        env:
          UNITY_SERIAL: ${{ secrets.UNITY_SERIAL }}
          UNITY_EMAIL: ${{ secrets.UNITY_EMAIL }}
          UNITY_PASSWORD: ${{ secrets.UNITY_PASSWORD }}
          UNITY_LICENSING_SERVER: ${{ secrets.UNITY_LICENSING_SERVER }}
`
	licensedSteps := strings.Replace(
		centralReturnSteps(),
		"      - id: acquire",
		credentialValidation+"      - id: acquire",
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
  static-validation:
    runs-on: ubuntu-latest
    steps:
      - run: true
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
        github.event_name != 'pull_request' ||
        (github.event.pull_request.user.login != 'dependabot[bot]' &&
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
        (github.event_name != 'pull_request' ||
          (github.event.pull_request.user.login != 'dependabot[bot]' &&
            github.event.pull_request.head.repo.full_name == github.repository))
      }}
    runs-on: [self-hosted, Windows]
    steps:
` + licensedSteps + `  cleanup:
    if: ${{ always() && needs.unity.result != 'skipped' && (github.event_name != 'pull_request' || (github.event.pull_request.user.login != 'dependabot[bot]' && github.event.pull_request.head.repo.full_name == github.repository)) }}
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
    needs: [static-validation, classify, preflight, unity, cleanup]
    runs-on: ubuntu-latest
    steps:
      - uses: ` + validationAction + `
        with:
          static-validation-result: ${{ needs.static-validation.result }}
          classifier-result: ${{ needs.classify.result }}
          unity-required: ${{ needs.classify.outputs.unity-required }}
          trusted-revision: ${{ github.event_name != 'pull_request' || (github.event.pull_request.user.login != 'dependabot[bot]' && github.event.pull_request.head.repo.full_name == github.repository) }}
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

	declaredPathsWorkflow := strings.Replace(
		workflow,
		"          head-sha: ${{ github.event.pull_request.head.sha }}\n",
		"          head-sha: ${{ github.event.pull_request.head.sha }}\n"+
			"          independent-paths: \"Benchmarks/**\"\n",
		1,
	)
	declaredPathsResult, err := AnalyzeUnityEnrollment(
		unityFixture(map[string]string{".github/workflows/unity.yml": declaredPathsWorkflow}),
		unityAuditPolicy(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(declaredPathsResult.Findings) != 0 {
		t.Fatalf("caller-declared independent paths produced findings: %#v", declaredPathsResult.Findings)
	}
	for _, declaration := range []string{
		"${{ github.event.pull_request.head.ref }}",
		"Benchmarks/*",
		".github/**",
		"../outside/**",
	} {
		invalidDeclarationWorkflow := strings.Replace(
			workflow,
			"          head-sha: ${{ github.event.pull_request.head.sha }}\n",
			"          head-sha: ${{ github.event.pull_request.head.sha }}\n"+
				"          independent-paths: \""+declaration+"\"\n",
			1,
		)
		invalidResult, err := AnalyzeUnityEnrollment(
			unityFixture(map[string]string{".github/workflows/unity.yml": invalidDeclarationWorkflow}),
			unityAuditPolicy(),
		)
		if err != nil {
			t.Fatal(err)
		}
		if len(invalidResult.Findings) == 0 {
			t.Fatalf("invalid caller-declared path %q was accepted", declaration)
		}
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
					"    needs: [static-validation, classify, preflight, unity, cleanup]",
					"    needs: [static-validation, preflight, unity, cleanup]",
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
			name: "credential validator omits email binding",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"          UNITY_EMAIL: ${{ secrets.UNITY_EMAIL }}\n",
					"",
					1,
				)
			},
		},
		{
			name: "credential validator aliases email binding",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"          UNITY_EMAIL: ${{ secrets.UNITY_EMAIL }}",
					"          EMAIL_ALIAS: ${{ secrets.UNITY_EMAIL }}",
					1,
				)
			},
		},
		{
			name: "credential validator reads another secret",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"          UNITY_EMAIL: ${{ secrets.UNITY_EMAIL }}",
					"          UNITY_EMAIL: ${{ secrets.OTHER_EMAIL }}",
					1,
				)
			},
		},
		{
			name: "credential validator adds process preload",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"          UNITY_LICENSING_SERVER: ${{ secrets.UNITY_LICENSING_SERVER }}",
					"          UNITY_LICENSING_SERVER: ${{ secrets.UNITY_LICENSING_SERVER }}\n"+
						"          NODE_OPTIONS: --require=spoof.js",
					1,
				)
			},
		},
		{
			name: "Unity credential environment belongs to another central action",
			mutate: func(value string) string {
				return strings.Replace(
					value,
					"validate-unity-license@",
					"require-current-pr-head@",
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
					"trusted-revision: ${{ github.event_name != 'pull_request' || (github.event.pull_request.user.login != 'dependabot[bot]' && github.event.pull_request.head.repo.full_name == github.repository) }}",
					"trusted-revision: ${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}",
					1,
				)
			},
		},
		{
			name: "trust expressions use rerun actor",
			mutate: func(value string) string {
				return strings.ReplaceAll(
					value,
					"github.event.pull_request.user.login",
					"github.actor",
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
				"github.event.pull_request.user.login != 'dependabot[bot]' &&",
				"github.event.pull_request.user.login != 'untrusted-bot' &&",
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
			return strings.Replace(value, "    runs-on: [self-hosted, Windows]", "    runs-on: [self-hosted, Windows]\n    environment: unity", 1)
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
	workflow := unityWorkflow(centralReturnSteps(), safeAggregate())
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

func TestUnityEnrollmentRejectsLegacyCleanupCompositeWrapper(t *testing.T) {
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
	codes := findingCodes(result.Findings)
	for _, code := range []string{
		"classifier-inputs-not-typed",
		"missing-unity-return",
		"release-inputs-not-typed",
		"cleanup-gate-inputs-not-typed",
	} {
		if !strings.Contains(codes, code) {
			t.Fatalf("legacy cleanup wrapper omitted %q: %#v", code, result.Findings)
		}
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
