package enrollment

import (
	"strings"
	"testing"
)

func TestUnityEnrollmentScheduledTrigger(t *testing.T) {
	for _, tc := range []struct {
		name, config  string
		allowed, want bool
	}{
		{"weekly", "\n    - cron: '17 9 * * 1'", true, true},
		{"no opt-in", "\n    - cron: '17 9 * * 1'", false, false},
		{"daily", "\n    - cron: '0 0 * * *'", true, true},
		{"minute step", "\n    - cron: '*/5 * * * *'", true, false},
		{"hour wildcard", "\n    - cron: '0 * * * *'", true, false},
		{"hour range", "\n    - cron: '0 0-23 * * *'", true, false},
		{"minute range", "\n    - cron: '0-1 0 * * *'", true, false},
		{"out of range", "\n    - cron: '60 24 * * 1'", true, false},
		{"invalid day", "\n    - cron: '0 0 * * 8'", true, false},
		{"missing field", "\n    - cron: '0 0 * *'", true, false},
		{"expression", "\n    - cron: '${{ inputs.cron }}'", true, false},
		{"scalar", " weekly", true, false},
		{"empty", " []", true, false},
		{"no cron", "\n    - other: weekly", true, false},
		{"extra key", "\n    - cron: '0 0 * * 1'\n      other: weekly", true, false},
		{"duplicate key", "\n    - cron: '0 0 * * 1'\n      cron: '0 0 * * 2'", true, false},
		{"non scalar", "\n    - cron: [weekly]", true, false},
		{"two daily entries", "\n    - cron: '0 0 * * *'\n    - cron: '0 12 * * *'", true, false},
		{"overlapping weekly", "\n    - cron: '0 0 * * 1'\n    - cron: '0 12 * * 1,2'", true, false},
		{"disjoint weekly", "\n    - cron: '0 0 * * 1'\n    - cron: '0 0 * * 2'", true, false},
		{"POSIX day union", "\n    - cron: '0 0 1 * 1'\n    - cron: '0 12 2 * 2'", true, false},
		{"numeric ranges and steps", "\n    - cron: '0 0 */2 1-12 1-5'", true, true},
		{"named weekday", "\n    - cron: '0 0 * * MON'", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			workflow := unityWorkflow(centralReturnSteps(), safeAggregate())
			start := strings.Index(workflow, "on:")
			end := strings.Index(workflow, "concurrency:")
			workflow = workflow[:start] + "on:\n  workflow_dispatch:\n  schedule:" + tc.config + "\n" + workflow[end:]
			policy := unityAuditPolicy()
			policy.AllowSchedule = tc.allowed
			policy.RequiredContexts = nil
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{".github/workflows/unity.yml": workflow}), policy)
			if err != nil {
				if !tc.want && tc.name == "duplicate key" {
					return
				}
				t.Fatal(err)
			}
			eligible := !strings.Contains(findingCodes(result.Findings), "ineligible-unity-trigger")
			if eligible != tc.want {
				t.Fatalf("eligible=%v, want %v: %#v", eligible, tc.want, result.Findings)
			}
			if tc.want && len(result.Findings) != 0 {
				t.Fatalf("safe schedule has findings: %#v", result.Findings)
			}
			for _, entry := range result.Inventory {
				if entry.Job == "unity" && entry.Classification != UnityInventoryPaidSerial {
					t.Fatalf("scheduled job classified as %q", entry.Classification)
				}
			}
		})
	}
}

func TestUnityEnrollmentScheduledFallbackMirrorsPaidJob(t *testing.T) {
	workflow := unityWorkflow(centralReturnSteps(), `  cleanup:
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
`)
	workflow = strings.Replace(workflow, "  workflow_dispatch:\n", "  workflow_dispatch:\n  schedule:\n    - cron: '17 9 * * 1'\n", 1)
	for _, allowed := range []bool{false, true} {
		policy := unityAuditPolicy()
		policy.AllowSchedule = allowed
		result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{".github/workflows/unity.yml": workflow}), policy)
		if err != nil {
			t.Fatal(err)
		}
		if allowed && len(result.Findings) != 0 {
			t.Fatalf("allowed fallback has findings: %#v", result.Findings)
		}
		for _, job := range []string{"unity", "cleanup"} {
			found := false
			for _, finding := range result.Findings {
				if finding.Code == "ineligible-unity-trigger" && finding.Job == job {
					found = true
				}
			}
			if found == allowed {
				t.Fatalf("job %s allowed=%v findings=%#v", job, allowed, result.Findings)
			}
		}
	}
}

func TestUnityEnrollmentScheduleRequiresProtectedBranchEvidence(t *testing.T) {
	workflow := unityWorkflow(centralReturnSteps(), safeAggregate())
	start := strings.Index(workflow, "on:")
	end := strings.Index(workflow, "concurrency:")
	workflow = workflow[:start] + "on:\n  schedule:\n    - cron: '17 9 * * 1'\n" + workflow[end:]
	policy := unityAuditPolicy()
	policy.AllowSchedule = true
	policy.RequiredContexts = nil
	policy.ProtectedBranches = nil
	_, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{".github/workflows/unity.yml": workflow}), policy)
	if err == nil || !strings.Contains(err.Error(), "protected branch") {
		t.Fatalf("schedule without branch evidence: %v", err)
	}
}

func TestUnityEnrollmentScheduleOnlyDoesNotRequireDispatchOptIn(t *testing.T) {
	workflow := unityWorkflow(centralReturnSteps(), safeAggregate())
	start := strings.Index(workflow, "on:")
	end := strings.Index(workflow, "concurrency:")
	workflow = workflow[:start] + "on:\n  schedule:\n    - cron: '17 9 * * 1'\n" + workflow[end:]
	policy := unityAuditPolicy()
	policy.AllowSchedule = true
	policy.AllowWorkflowDispatch = false
	policy.RequiredContexts = nil
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{".github/workflows/unity.yml": workflow}), policy)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Findings) != 0 {
		t.Fatalf("schedule-only workflow has findings: %#v", result.Findings)
	}
	workflow = strings.Replace(workflow, "  schedule:", "  workflow_dispatch:\n  schedule:", 1)
	result, err = AnalyzeUnityEnrollment(unityFixture(map[string]string{".github/workflows/unity.yml": workflow}), policy)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(findingCodes(result.Findings), "ineligible-unity-trigger") {
		t.Fatal("schedule bypassed dispatch opt-in")
	}
}
