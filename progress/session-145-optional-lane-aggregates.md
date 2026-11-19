# Session 145: optional lane aggregates

Date: 2026-11-18

Issues: #412 (closed), #113 (remaining), #397 (closed earlier).

## Objective and safety invariants

Carry the GOAL.md directive: rank the open issues by impact with the least Unity
CI churn, complete the highest-priority safe work, and drive it green.

Safety invariants:

- A lane that can block a protected pull request or merge group must stay
  fail closed. The new shape is refused for such a lane.
- A skipped lane must never green-report a lane that ran and failed.
- A required context must not report green while its lane did not run.

## Baseline

- `main` at `2dfa570513`. No open pull request. The last runs were green.
- Local audit of all seven default branches:

  ```text
  Audited 7/7 enrolled repositories; active-jobs=136 findings=23 complete=true
  ```

- The 23 rows: 14 DxMessaging shape findings, 8 expired policy exceptions,
  1 unity-helpers aggregate finding.
- Four rows were `missing-unity-aggregate`: three optional DxMessaging runner
  bootstrap lanes and the unity-helpers split single-threaded lane.

## Root cause

The exact trusted-skip aggregate proves one lane that runs, or skips for a fork
or Dependabot pull request. It cannot prove a lane that the caller selects for
some dispatches only:

- The DxMessaging lanes run one audit mode per dispatch.
- The unity-helpers single-threaded lane runs only for a split dispatch. A
  combined run covers both variants inside `unity-tests`, so the lane stays
  skipped on pull requests and push.

A literal aggregate for either lane would report red on every unselected run.
A guarded aggregate was rejected, because the guard was not literal `always()`.

## Change

Central #414 and #415:

- Accept one caller-selected lane aggregate. The lane must be unable to run for
  a protected pull request, merge group, or reusable-workflow call.
- The aggregate is a hosted literal `always()` job with one bash step.
- `LANE_SELECTED` repeats one or more `&&` terms of the lane guard. Every term
  must render boolean `true` or `false`.
- The selection reads caller inputs, `github.event_name`,
  `github.event.inputs`, and `needs.<job>.outputs` in dot form. A job result,
  a job-scoped context, a function, a dynamic index, a bracket `needs`
  reference, and a secret are refused.
- The step passes for an exact untrusted skip, for a successful preflight and a
  skipped lane when the selection is false, or for a successful preflight and
  lane when it is true. Any other selection value is red.
- The shape is refused when the branch requires the aggregate context.

Consumers:

- DxMessaging #787: one aggregate for `native-sdk-floor`,
  `pilot-contract-smoke`, and `shipping-editor-verification`.
- DxMessaging #788: the secondary shipping preflight binding is redundant. A
  failed second preflight skips the lane, which the selected branch refuses.
- unity-helpers #1254: the split lane guard is dispatch only. Its aggregate
  repeats the split selection. Combined runs stay green only when the same
  selection skipped the lane.

No required context and no ruleset change was made. No licensed job gained a
run on pull requests or push.

## Evidence

Local audit with the final analyzer and the merged default branches:

```text
Audited 7/7 enrolled repositories; active-jobs=139 findings=19 complete=true
```

`missing-unity-aggregate` is gone. The 19 rows are the 11 DxMessaging shape
findings and 8 expired policy exceptions tracked by #113.

The official organization audit run `44433544257` at `dacfe2a319` reports the
same 19 findings, complete retrieval, and no aggregate finding.

Tests:

- `TestUnityEnrollmentAcceptsCallerSelectedLaneAggregate`
- `TestUnityEnrollmentAcceptsCallerSelectedLaneOffAnotherWorkflowEvent`
- `TestUnityEnrollmentRejectsCallerSelectedLaneAggregateMutations`, fourteen
  mutations: a job result, a term outside the guard, a partial comparison,
  quoted whitespace, a status function, a merge-gated lane, a
  `pull_request_target` lane, a reusable workflow, a non-boolean selection, a
  job-scoped context, a bracket `needs` reference, a dynamic index, a mixed
  result and output, and an upper-case event.
- `TestUnityEnrollmentRefusesARequiredCallerSelectedLaneContext`
- Consumer tests: DxMessaging aggregate contract, unity-helpers acceptance,
  grouped modes, artifact redaction, workflow matrix contract, YAML lint,
  `test_ci_modes.py`, and `test_slow_tests.py`.

Local checks:

- `go test ./...`, `go vet ./...`, `go test -race ./...`: pass.
- `go mod verify`, both `go mod tidy -diff` commands: pass.
- `node tools/llm-harness.mjs check`: pass.
- `bash tools/workflows/ci.sh javascript` and `shellcheck`: pass.
- `node --test test/*.test.js` reports 20 failures on this macOS host. The same
  20 tests fail on the untouched tree, with the same pass and fail counts
  (1030/20). CI runs them on Linux.
- `golangci-lint` is not installed on this host. CI runs it.

## Review findings and dispositions

An independent adversarial review found four holes. All are fixed.

- High: a bare string input rendered a non-boolean value, so the step treated a
  failed lane as unselected. Every selection term must now be boolean-valued.
  The step is red for any value other than `true` or `false`.
- High: `compactExpression` removed whitespace inside quoted values. It now
  preserves quoted text.
- Medium: a bracket `needs` reference hid a job result. Bracket form is refused,
  and every dot reference must be a direct `.outputs.` path.
- Medium: the checker accepted a job-scoped context such as `github.job`. Only
  caller inputs, the event name, event inputs, and declared job outputs are
  accepted.
- Low: a `pull_request_target` lane and a `workflow_call` workflow could take
  the weaker shape. Both are treated as merge-reachable now.
- Low: a selection function such as `hashFiles` could differ between the lane
  and the aggregate. Every function call is refused.
- Low: a dynamic bracket index such as `inputs[matrix.mode]` could differ.
  Only a quoted literal index is accepted.
- Low: the shape could report a required context green. It is refused when the
  branch requires the aggregate context.

Second and third rounds, from the OpenAI review and CodeRabbit:

- Major: `termFalseForEvent` compared event literals with case. It now compares
  without regard to case, as GitHub does.
- Minor: `PLAN.md` held completion evidence. It now lists open work only.
- Minor: a local gh device identifier was committed. It is removed, and
  `.local/` is ignored.
- Every review thread is answered and resolved. The CodeRabbit
  changes-requested reviews were dismissed after every actionable comment was
  fixed.

## Merge and verification

- Central #414 merged at `eceadd7f98`; #415 merged at `dacfe2a319`.
- DxMessaging #787 merged at `f211a7e1`; #788 merged at `d73d2ea3`.
- unity-helpers #1254 merged at `4b054c3d`.
- Organization Unity enrollment audit run `44433544257` on `dacfe2a319`:
  success, 19 findings, no aggregate finding.
- Build lock CI on `dacfe2a319`: success.
- DxMessaging `master` CI on `d73d2ea3`: success.
- unity-helpers `main` Unity Tests, Local Gates, and Repo Lint on `4b054c3d`:
  success.

## Out of scope

- The 11 DxMessaging shape findings and 8 expired policy exceptions remain in
  #113. The exceptions need an owner re-review.
- #335 stays blocked on the upstream YAML API.
