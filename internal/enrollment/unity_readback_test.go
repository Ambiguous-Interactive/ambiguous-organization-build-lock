package enrollment

import (
	"os"
	"os/exec"
	"strings"
	"testing"

	"go.yaml.in/yaml/v4"
)

const readbackSelector = "github.event_name == 'workflow_dispatch' && inputs.native-readback-run-id != ''"

func historicalReadbackWorkflow() string {
	aggregate := strings.Replace(trustedSkipAggregate(), "needs: [preflight, unity]", "needs: [preflight, unity, native-historical-readback]", 1)
	aggregate = strings.Replace(aggregate, "        run: |", "          HISTORICAL_READBACK: ${{ "+readbackSelector+" }}\n          HISTORICAL_READBACK_RESULT: ${{ needs.native-historical-readback.result }}\n        run: |", 1)
	aggregate = strings.Replace(aggregate, `if [ "${FORK_PR}"`, `if [ "${HISTORICAL_READBACK}" = "true" ]; then
            test "${RUNNER_PREFLIGHT_RESULT}" = success
            test "${HISTORICAL_READBACK_RESULT}" = success
            test "${UNITY_TESTS_RESULT}" = skipped
          elif [ "${FORK_PR}"`, 1)
	workflow := unityWorkflow(centralReturnSteps(), aggregate)
	workflow = strings.Replace(workflow, "  workflow_dispatch:\n", `  workflow_dispatch:
    inputs:
      native-readback-run-id:
        type: string
        required: false
        default: ""
`, 1)
	return workflow + `  native-historical-readback:
    needs: preflight
    if: ${{ !cancelled() && ` + readbackSelector + ` && needs.preflight.result == 'success' }}
    runs-on: [self-hosted, Windows]
    steps:
      - run: echo read-original-artifacts
`
}

func TestUnityEnrollmentHistoricalReadbackAggregate(t *testing.T) {
	base := historicalReadbackWorkflow()
	tests := []struct{ name, from, to string }{
		{name: "accepted"},
		{"quoted selector whitespace", "HISTORICAL_READBACK: ${{ " + readbackSelector + " }}", "HISTORICAL_READBACK: ${{ github.event_name == 'workflow_dispatch' && inputs.native-readback-run-id != ' ' }}"},
		{"quoted capture whitespace", "!cancelled() && " + readbackSelector + " && needs.preflight.result == 'success'", "!cancelled() && github.event_name == 'workflow_dispatch' && inputs.native-readback-run-id != ' ' && needs.preflight.result == 'success'"},
		{"capture matrix", "  native-historical-readback:\n", "  native-historical-readback:\n    strategy:\n      matrix:\n        lane: [one]\n"},
		{"aggregate matrix", "  aggregate:\n", "  aggregate:\n    strategy:\n      matrix:\n        lane: [one]\n"},
		{"capture depends on wrong preflight", "    needs: preflight\n    if: ${{ !cancelled()", "    needs: unity\n    if: ${{ !cancelled()"},
		{"job env", "  aggregate:\n", "  aggregate:\n    env:\n      BASH_ENV: ./bad.sh\n"},
		{"spoofed licensed result", "UNITY_TESTS_RESULT: ${{ needs.unity.result }}", "UNITY_TESTS_RESULT: success"},
		{"spoofed fork", "FORK_PR: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository }}", "FORK_PR: true"},
		{"spoofed Dependabot", "DEPENDABOT_PR: ${{ github.event_name == 'pull_request' && github.event.pull_request.user.login == 'dependabot[bot]' }}", "DEPENDABOT_PR: true"},
		{"unscoped selection", "HISTORICAL_READBACK: ${{ " + readbackSelector + " }}", "HISTORICAL_READBACK: ${{ inputs.native-readback-run-id != '' }}"},
		{"constant selection", "HISTORICAL_READBACK: ${{ " + readbackSelector + " }}", "HISTORICAL_READBACK: true"},
		{"wrong result", "HISTORICAL_READBACK_RESULT: ${{ needs.native-historical-readback.result }}", "HISTORICAL_READBACK_RESULT: ${{ needs.preflight.result }}"},
		{"missing dependency", "needs: [preflight, unity, native-historical-readback]", "needs: [preflight, unity]"},
		{"missing capture", "  native-historical-readback:", "  other-capture:"},
		{"wrong capture guard", "!cancelled() && " + readbackSelector + " && needs.preflight.result == 'success'", "always()"},
		{"capture suppressed failure", "  native-historical-readback:\n", "  native-historical-readback:\n    continue-on-error: true\n"},
		{"capture step suppressed failure", "      - run: echo read-original-artifacts", "      - continue-on-error: true\n        run: echo read-original-artifacts"},
		{"capture activates editor", "echo read-original-artifacts", "unity-editor -batchmode"},
		{"capture credential", "echo read-original-artifacts", `echo "${{ secrets.UNITY_SERIAL }}"`},
		{"capture acquire", "      - run: echo read-original-artifacts", "      - uses: " + lockActionPrefix + "acquire-build-lock@" + testSHA},
		{"input absent", "      native-readback-run-id:", "      different-input:"},
		{"input boolean", "type: string", "type: boolean"},
		{"input nonempty default", `default: ""`, `default: "123"`},
		{"input expression default", `default: ""`, `default: "${{ github.run_id }}"`},
		{"input required", "required: false", "required: true"},
		{"extra env", "          HISTORICAL_READBACK:", "          BASH_ENV: ./unsafe.sh\n          HISTORICAL_READBACK:"},
		{"extra step", "      - shell: bash", "      - run: echo extra\n      - shell: bash"},
		{"step failure suppressed", "      - shell: bash", "      - continue-on-error: true\n        shell: bash"},
		{"aggregate failure suppressed", "  aggregate:\n", "  aggregate:\n    continue-on-error: true\n"},
		{"conditional aggregate", "  aggregate:\n    if: always()", "  aggregate:\n    if: success()"},
		{"capture result weakened", `test "${HISTORICAL_READBACK_RESULT}" = success`, `test "${HISTORICAL_READBACK_RESULT}" != failure`},
		{"preflight result weakened", `test "${RUNNER_PREFLIGHT_RESULT}" = success`, `test "${RUNNER_PREFLIGHT_RESULT}" = skipped`},
		{"licensed result weakened", `test "${UNITY_TESTS_RESULT}" = success`, `test "${UNITY_TESTS_RESULT}" != failure`},
	}
	for _, tc := range tests {
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
			if tc.from == "" {
				if len(result.Findings) != 0 {
					t.Fatalf("safe readback rejected: %#v", result.Findings)
				}
			} else if !rejected {
				t.Fatalf("unsafe readback admitted: %#v", result.Findings)
			}
		})
	}
}

func TestHistoricalReadbackAggregateShellResults(t *testing.T) {
	var workflow yaml.Node
	if err := yaml.Unmarshal([]byte(historicalReadbackWorkflow()), &workflow); err != nil {
		t.Fatal(err)
	}
	job := mappingValue(mappingValue(workflow.Content[0], "jobs"), "aggregate")
	script := scalarValue(mappingValue(sequenceValues(mappingValue(job, "steps"))[0], "run"))
	for _, mode := range []string{"readback", "normal", "fork", "dependabot"} {
		for _, preflight := range []string{"", "success", "failure", "skipped", "cancelled"} {
			for _, licensed := range []string{"", "success", "failure", "skipped", "cancelled"} {
				for _, capture := range []string{"", "success", "failure", "skipped", "cancelled"} {
					t.Run(mode+"/"+preflight+"/"+licensed+"/"+capture, func(t *testing.T) {
						command := exec.Command("bash", "-c", script)
						command.Env = append(os.Environ(), "RUNNER_PREFLIGHT_RESULT="+preflight, "UNITY_TESTS_RESULT="+licensed, "HISTORICAL_READBACK_RESULT="+capture, "HISTORICAL_READBACK="+boolText(mode == "readback"), "FORK_PR="+boolText(mode == "fork"), "DEPENDABOT_PR="+boolText(mode == "dependabot"))
						expected := preflight == "success" && licensed == "success"
						if mode == "readback" {
							expected = preflight == "success" && licensed == "skipped" && capture == "success"
						}
						if mode == "fork" || mode == "dependabot" {
							expected = preflight == "skipped" && licensed == "skipped"
						}
						err := command.Run()
						if (err == nil) != expected {
							t.Fatalf("success=%t, expected=%t: %v", err == nil, expected, err)
						}
					})
				}
			}
		}
	}
}

func boolText(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

func TestUnityEnrollmentHistoricalReadbackOptionalInputFields(t *testing.T) {
	workflow := strings.Replace(historicalReadbackWorkflow(), "        required: false\n        default: \"\"\n", "", 1)
	result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
		".github/workflows/unity.yml": workflow,
	}), unityAuditPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Findings) != 0 {
		t.Fatalf("implicit optional empty string rejected: %#v", result.Findings)
	}
}

func TestUnityEnrollmentHistoricalReadbackCompositeBoundary(t *testing.T) {
	for _, tc := range []struct {
		name, step string
		accepted   bool
	}{
		{"inert local composite", "    - run: echo redact-original-artifacts\n      shell: bash\n", true},
		{"nested acquire", "    - uses: " + lockActionPrefix + "acquire-build-lock@" + testSHA + "\n", false},
		{"nested activation", "    - run: unity-editor -batchmode\n      shell: bash\n", false},
		{"nested credential", "    - run: echo redact\n      shell: bash\n      env:\n        UNITY_SERIAL: ${{ secrets.UNITY_SERIAL }}\n", false},
		{"nested suppression", "    - continue-on-error: true\n      run: echo redact\n      shell: bash\n", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			workflow := strings.Replace(historicalReadbackWorkflow(), "      - run: echo read-original-artifacts", "      - uses: ./.github/actions/readback", 1)
			result, err := AnalyzeUnityEnrollment(unityFixture(map[string]string{
				".github/workflows/unity.yml":         workflow,
				".github/actions/readback/action.yml": "name: Readback\nruns:\n  using: composite\n  steps:\n" + tc.step,
			}), unityAuditPolicy())
			if err != nil {
				t.Fatal(err)
			}
			rejected := strings.Contains(findingCodes(result.Findings), "missing-unity-aggregate")
			if rejected == tc.accepted {
				t.Fatalf("accepted=%t, findings=%#v", tc.accepted, result.Findings)
			}
		})
	}
}
