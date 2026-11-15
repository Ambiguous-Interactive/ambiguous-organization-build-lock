package enrollment

import (
	"os"
	"os/exec"
	"strings"
	"testing"

	"go.yaml.in/yaml/v4"
)

const readbackSelector = "github.event_name == 'workflow_dispatch' && inputs.native-readback-run-id != ''"
const readbackAggregateGuard = "${{ !(" + readbackSelector + ") && (always()) }}"

func historicalReadbackWorkflow() string {
	aggregate := strings.Replace(trustedSkipAggregate(), "if: always()", "if: "+readbackAggregateGuard, 1)
	workflow := unityWorkflow(centralReturnSteps(), aggregate)
	licensedGuard := "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository"
	workflow = strings.Replace(workflow, "    if: "+licensedGuard+"\n", "    if: ${{ !("+readbackSelector+") && ("+licensedGuard+") }}\n", 1)
	return strings.Replace(workflow, "  workflow_dispatch:\n", `  workflow_dispatch:
    inputs:
      native-readback-run-id:
        type: string
        required: false
        default: ""
`, 1)
}

func TestUnityEnrollmentHistoricalReadbackAggregate(t *testing.T) {
	base := historicalReadbackWorkflow()
	for _, tc := range []struct {
		name, from, to string
		accepted       bool
	}{
		{name: "exact diagnostic exclusion", accepted: true},
		{"implicit optional empty input", "        required: false\n        default: \"\"\n", "", true},
		{"ordinary always aggregate", "if: " + readbackAggregateGuard, "if: always()", true},
		{"outer expression whitespace", "if: " + readbackAggregateGuard, "if: ${{  !( github.event_name == 'workflow_dispatch' && inputs.native-readback-run-id != '' ) && ( always() )  }}", true},
		{"missing always", "if: " + readbackAggregateGuard, "if: ${{ !(" + readbackSelector + ") }}", false},
		{"success instead of always", "if: " + readbackAggregateGuard, "if: ${{ !(" + readbackSelector + ") && (success()) }}", false},
		{"all manual dispatch excluded", "if: " + readbackAggregateGuard, "if: ${{ github.event_name != 'workflow_dispatch' && always() }}", false},
		{"unscoped input exclusion", "if: " + readbackAggregateGuard, "if: ${{ inputs.native-readback-run-id == '' && always() }}", false},
		{"wrong event literal", "if: " + readbackAggregateGuard, "if: ${{ !(github.event_name == 'pull_request' && inputs.native-readback-run-id != '') && (always()) }}", false},
		{"quoted event whitespace", "if: " + readbackAggregateGuard, "if: ${{ !(github.event_name == 'workflow_ dispatch' && inputs.native-readback-run-id != '') && (always()) }}", false},
		{"quoted empty literal whitespace", "if: " + readbackAggregateGuard, "if: ${{ !(github.event_name == 'workflow_dispatch' && inputs.native-readback-run-id != ' ') && (always()) }}", false},
		{"input absent", "      native-readback-run-id:", "      different-input:", false},
		{"input boolean", "type: string", "type: boolean", false},
		{"input required", "required: false", "required: true", false},
		{"input quoted required", "required: false", "required: 'false'", false},
		{"input nonempty default", `default: ""`, `default: "123"`, false},
		{"input null default", `default: ""`, "default: null", false},
		{"input expression default", `default: ""`, `default: "${{ github.run_id }}"`, false},
		{"missing licensed dependency", "needs: [preflight, unity]", "needs: [preflight]", false},
		{"missing preflight dependency", "needs: [preflight, unity]", "needs: [unity]", false},
		{"aggregate matrix", "  aggregate:\n", "  aggregate:\n    strategy:\n      matrix:\n        lane: [one]\n", false},
		{"job env", "  aggregate:\n", "  aggregate:\n    env:\n      BASH_ENV: ./bad.sh\n", false},
		{"extra step", "      - shell: bash", "      - run: echo extra\n      - shell: bash", false},
		{"extra historical success env", "          FORK_PR:", "          HISTORICAL_READBACK: true\n          FORK_PR:", false},
		{"spoofed licensed result", "UNITY_TESTS_RESULT: ${{ needs.unity.result }}", "UNITY_TESTS_RESULT: success", false},
		{"spoofed fork", "FORK_PR: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository }}", "FORK_PR: true", false},
		{"spoofed Dependabot", "DEPENDABOT_PR: ${{ github.event_name == 'pull_request' && github.event.pull_request.user.login == 'dependabot[bot]' }}", "DEPENDABOT_PR: true", false},
		{"step failure suppressed", "      - shell: bash", "      - continue-on-error: true\n        shell: bash", false},
		{"aggregate failure suppressed", "  aggregate:\n", "  aggregate:\n    continue-on-error: true\n", false},
		{"preflight result weakened", `test "${RUNNER_PREFLIGHT_RESULT}" = success`, `test "${RUNNER_PREFLIGHT_RESULT}" = skipped`, false},
		{"licensed result weakened", `test "${UNITY_TESTS_RESULT}" = success`, `test "${UNITY_TESTS_RESULT}" != failure`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			workflow := base
			if tc.from != "" {
				if !strings.Contains(base, tc.from) {
					t.Fatal("mutation absent")
				}
				workflow = strings.Replace(base, tc.from, tc.to, 1)
			}
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{".github/workflows/unity.yml": workflow}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			rejected := strings.Contains(findingCodes(result.Findings), "missing-unity-aggregate")
			if rejected == tc.accepted || (tc.accepted && len(result.Findings) != 0) {
				t.Fatalf("accepted=%t, findings=%#v", tc.accepted, result.Findings)
			}
		})
	}
}

func TestHistoricalReadbackAggregateQualificationEvents(t *testing.T) {
	var workflow yaml.Node
	if err := yaml.Unmarshal([]byte(historicalReadbackWorkflow()), &workflow); err != nil {
		t.Fatal(err)
	}
	job := mappingValue(mappingValue(workflow.Content[0], "jobs"), "aggregate")
	condition := scalarValue(mappingValue(job, "if"))
	condition = strings.TrimSuffix(strings.TrimPrefix(condition, "${{"), "}}")
	// Evaluate the fixed guard's boolean operators with shell string comparisons.
	condition = strings.NewReplacer("github.event_name", `"${EVENT_NAME}"`, "inputs.native-readback-run-id", `"${READBACK_RUN_ID}"`, "always()", "true").Replace(condition)
	for _, event := range []string{"pull_request", "push", "workflow_dispatch", "merge_group"} {
		for _, input := range []string{"", "123", " "} {
			for _, result := range []string{"success", "failure", "skipped", "cancelled"} {
				t.Run(event+"/input="+input+"/needs="+result, func(t *testing.T) {
					command := exec.Command("bash", "-c", "[[ "+condition+" ]]")
					command.Env = append(os.Environ(), "EVENT_NAME="+event, "READBACK_RUN_ID="+input, "RUNNER_PREFLIGHT_RESULT="+result, "UNITY_TESTS_RESULT="+result)
					wantRun := event != "workflow_dispatch" || input == ""
					if err := command.Run(); (err == nil) != wantRun {
						t.Fatalf("run=%t, want=%t: %v", err == nil, wantRun, err)
					}
				})
			}
		}
	}
}

func TestHistoricalReadbackAggregateKeepsTrustedSkipScript(t *testing.T) {
	var workflow yaml.Node
	if err := yaml.Unmarshal([]byte(historicalReadbackWorkflow()), &workflow); err != nil {
		t.Fatal(err)
	}
	job := mappingValue(mappingValue(workflow.Content[0], "jobs"), "aggregate")
	step := sequenceValues(mappingValue(job, "steps"))[0]
	if env := mappingValue(step, "env"); env == nil || len(env.Content) != 8 {
		t.Fatal("diagnostic exclusion must keep the four original environment bindings")
	}
	script := scalarValue(mappingValue(step, "run"))
	for _, mode := range []string{"normal", "fork", "dependabot"} {
		for _, preflight := range []string{"", "success", "failure", "skipped", "cancelled"} {
			for _, licensed := range []string{"", "success", "failure", "skipped", "cancelled"} {
				t.Run(mode+"/"+preflight+"/"+licensed, func(t *testing.T) {
					command := exec.Command("bash", "-c", script)
					command.Env = append(os.Environ(), "RUNNER_PREFLIGHT_RESULT="+preflight, "UNITY_TESTS_RESULT="+licensed, "FORK_PR="+boolText(mode == "fork"), "DEPENDABOT_PR="+boolText(mode == "dependabot"))
					expected := preflight == "success" && licensed == "success"
					if mode != "normal" {
						expected = preflight == "skipped" && licensed == "skipped"
					}
					if err := command.Run(); (err == nil) != expected {
						t.Fatalf("success=%t, expected=%t: %v", err == nil, expected, err)
					}
				})
			}
		}
	}
}

func TestUnityEnrollmentHistoricalReadbackExclusionRejectsOtherAggregateShapes(t *testing.T) {
	base := historicalReadbackWorkflow()
	direct := strings.Replace(safeAggregate(), "if: always()", "if: "+readbackAggregateGuard, 1)
	start := strings.Index(base, "  aggregate:\n")
	typed := strings.Replace(typedConditionalValidationWorkflow(), "  aggregate:\n    if: always()", "  aggregate:\n    if: "+readbackAggregateGuard, 1)
	typed = strings.Replace(typed, "  workflow_dispatch:\n", "  workflow_dispatch:\n    inputs:\n      native-readback-run-id:\n        type: string\n", 1)
	for _, tc := range []struct{ name, workflow string }{
		{"direct", base[:start] + direct},
		{"typed", typed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{".github/workflows/unity.yml": tc.workflow}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(findingCodes(result.Findings), "missing-unity-aggregate") {
				t.Fatalf("aggregate received trusted-skip exclusion: %#v", result.Findings)
			}
		})
	}
}

func TestUnityEnrollmentHistoricalReadbackRequiresLicensedExclusion(t *testing.T) {
	const trustGuard = "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository"
	const licensedGuard = "${{ !(" + readbackSelector + ") && (" + trustGuard + ") }}"
	for _, tc := range []struct {
		name, guard string
		accepted    bool
	}{
		{"exact exclusion", licensedGuard, true},
		{"exclusion after trust guard", "${{ (" + trustGuard + ") && !(" + readbackSelector + ") }}", true},
		{"additional result guard", "${{ !cancelled() && !(" + readbackSelector + ") && (" + trustGuard + ") && needs.preflight.result == 'success' }}", true},
		{"original licensed guard", trustGuard, false},
		{"wrong input", "${{ !(github.event_name == 'workflow_dispatch' && inputs.other-readback-id != '') && (" + trustGuard + ") }}", false},
		{"quoted empty literal whitespace", "${{ !(github.event_name == 'workflow_dispatch' && inputs.native-readback-run-id != ' ') && (" + trustGuard + ") }}", false},
		{"quoted event whitespace", "${{ !(github.event_name == 'workflow_ dispatch' && inputs.native-readback-run-id != '') && (" + trustGuard + ") }}", false},
		{"top level OR bypass", "${{ !(" + readbackSelector + ") && (" + trustGuard + ") || true }}", false},
		{"nested OR bypass", "${{ (!(" + readbackSelector + ") || true) && (" + trustGuard + ") }}", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			workflow := strings.Replace(historicalReadbackWorkflow(), "if: "+licensedGuard, "if: "+tc.guard, 1)
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{".github/workflows/unity.yml": workflow}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			rejected := strings.Contains(findingCodes(result.Findings), "missing-unity-aggregate")
			if rejected == tc.accepted || (tc.accepted && len(result.Findings) != 0) {
				t.Fatalf("accepted=%t, findings=%#v", tc.accepted, result.Findings)
			}
		})
	}
}

func TestUnityEnrollmentHistoricalReadbackRequiresEachLicensedLaneExclusion(t *testing.T) {
	const trustGuard = "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository"
	const licensedGuard = "${{ !(" + readbackSelector + ") && (" + trustGuard + ") }}"
	base := historicalReadbackWorkflow()
	licensedStart := strings.Index(base, "  unity:\n")
	aggregateStart := strings.Index(base, "  aggregate:\n")
	otherLicensed := strings.Replace(base[licensedStart:aggregateStart], "  unity:\n", "  other-unity:\n", 1)
	otherAggregate := strings.NewReplacer("  aggregate:\n", "  other-aggregate:\n", "needs: [preflight, unity]", "needs: [preflight, other-unity]", "needs.unity.result", "needs.other-unity.result").Replace(base[aggregateStart:])
	for _, missing := range []bool{false, true} {
		t.Run("other-lane-missing="+boolText(missing), func(t *testing.T) {
			other := otherLicensed
			if missing {
				other = strings.Replace(other, "if: "+licensedGuard, "if: "+trustGuard, 1)
			}
			workflow := base + other + otherAggregate
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{".github/workflows/unity.yml": workflow}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			if !missing && len(result.Findings) != 0 {
				t.Fatalf("guarded lanes rejected: %#v", result.Findings)
			}
			found := false
			for _, finding := range result.Findings {
				if finding.Code == "missing-unity-aggregate" {
					if finding.Job != "other-unity" {
						t.Fatalf("wrong licensed lane rejected: %#v", result.Findings)
					}
					found = true
				}
			}
			if found != missing {
				t.Fatalf("unguarded=%t, findings=%#v", missing, result.Findings)
			}
		})
	}
}

func boolText(value bool) string {
	if value {
		return "true"
	}
	return "false"
}
