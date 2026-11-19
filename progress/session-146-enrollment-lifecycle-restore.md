# Session 146: restore the DxMessaging enrollment lifecycle shape

Date: 2026-11-19

Issues: #113, #408.

Pull requests: this repository's #417, Ambiguous-Interactive/DxMessaging#794.

## Objective and safety invariants

Carry the GOAL.md directive: rank the open issues by impact with the least
Unity CI churn, complete the highest-priority safe work, and drive it green.

Safety invariants:

- No licensed step changes the work it performs.
- The editor gate stays before every credential reference and checkout.
- The central return, classifier, release, and cleanup gate stay the job
  suffix, so the reported seat and lock state stays final.
- A cancelled run still reaches the return and release steps.

## Baseline

- `main` at `0c6aaa4ab4`. No open pull request.
- Local audit of all seven default branches:

  ```text
  Audited 7/7 enrolled repositories; active-jobs=139 findings=19 complete=true
  ```

- The 19 rows: 11 DxMessaging workflow-shape findings and 8 expired policy
  exceptions.

## Open-issue priority

| Order | Issue | Impact | Unity CI churn |
| --- | --- | --- | --- |
| 1 | #113 DxMessaging findings | 11 audit rows on three workflows. The other 8 rows need an owner re-review. | One matrix leg, workflow-only edits. |
| 2 | #408 private callee | A policy decision that blocks no consumer today. | None. |
| 3 | #390 status adoption | Operability gain for a denied acquire. | One hosted job per consumer. |
| 4 | #379 merge queue | Needs owner authorization to enable the queue. | Low, in DoxReloaded. |
| 5 | #335 actionlint YAML | Dependency freshness only. Blocked upstream. | None. |
| 6 | #29, #51, #53, #83, #153, #229, #231, #249, #277, #278, #334 | Each needs owner authority, a portal fact, or published evidence. | Unknown until the evidence exists. |

## Root cause

The audit enforced three exact-shape rules that the consumer contract did not
state, and one consumer drifted on each:

- Five findings: the current-head guard allowed three minutes. The audit admits
  two minutes or less.
- Three findings: the optional dispatch lanes ran a request check before the
  editor gate. The audit admits only the current-head guard before it, and
  those lanes have none.
- Three findings, of two codes: artifact redaction and upload followed the
  cleanup gate, so the gate was not the last step.

A fourth rule reddened the dispatch lanes: the workflow concurrency used
`cancel-in-progress: false`, and item 11 requires the literal `true`.

## Change

Central #417, merged at `9a0ccb59d5`:

- `docs/consumer-enrollment.md` states the two-minute guard bound, the
  gate-first rule for a lane without a guard, and the terminal gate rule.
- The finding-code rows name both rules.
- `/.policy-consumers/` is ignored, because it is a generated audit workspace.

DxMessaging #794, merged at `573dea2d8ca2`:

- Three head guards move from three minutes to two.
- The editor gate is the first step in `shipping-editor-verification`,
  `pilot-contract-smoke`, and `native-sdk-floor`.
- Redaction and upload move before the central return in two lanes, and every
  moved step now adds `!cancelled()`.
- The workflow concurrency cancels a superseded dispatch.
- The `unity-tests` job timeout grows from 1050 to 1060 minutes, which keeps the
  validator's 60-minute reserve.
- The contract test fails when a step precedes the editor gate or follows the
  cleanup gate.

No licensed step changed its work. No required context and no ruleset changed.

## Evidence

The unmodified local analyzer over the DxMessaging snapshot:

```text
findings=11 before, findings=0 after
```

Red-green: the new contract assertion fails on the previous workflow shape with
`unity-tests.yml:unity-tests: bounded head guard and terminal cleanup gate`.

Consumer checks:

- `node --test scripts/__tests__/ci-aggregate-workflow.test.js`: 30 pass.
- `python3 scripts/validate-unity-pr-policy.py`: the enrollment rules pass.
  One post-merge push-loop case fails on macOS on the untouched default branch
  too.
- `validate-js-loc-budget`: 24156/24158.
- `yamllint` and `prettier --check`: pass.

Organization audit after the merge:

```text
Audited 7/7 enrolled repositories; active-jobs=139 findings=8 complete=true
```

The eight remaining rows are `expired-policy-exception` in `unity-builder` and
`unity-helpers`. The run also warns that the count is 8 across 2 repositories.

## Review findings and dispositions

- OpenAI review: three majors. Two asked for more job-timeout budget, and one
  asked to scope the cancellation. The measured reserves are 88, 92, 81, and 63
  minutes against the required 60, so no budget change is needed. Cancellation
  is the reviewed item-11 contract, and the licensed path keeps its signal trap
  and `always()` cleanup chain.
- CodeRabbit: one major, that a cancelled run could spend its cancellation
  window on artifact handling. Fixed: every moved step adds `!cancelled()`. The
  changes-requested review was dismissed after the fix, because the review
  limit blocked a re-review.
- The base-branch policy refused the merge after the dismissal left no
  approving review. The review limit blocked a new approval, so the owner
  merged #794 with administrator privilege after every check passed.

## Out of scope

- The eight expired `unity-builder` and `unity-helpers` policy exceptions still
  need an owner re-review.
