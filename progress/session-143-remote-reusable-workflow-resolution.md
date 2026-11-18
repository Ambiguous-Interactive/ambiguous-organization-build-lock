# Session 143: remote reusable workflow calls stay unresolved

Date: 2026-11-18

Issues: #406 (fixed here), #397 (measured, decision still open), #113 (alert
class cleared).

Pull request: this repository's #407.

## Objective and safety invariants

Carry the GOAL.md directive: rank open issues by impact with the least Unity CI
churn, complete the highest-priority safe work, and drive it green.

Safety invariants:

- An unresolved reusable workflow call stays license-capable.
- A resolved callee with a licensed job makes the caller a paid job, so no
  licensing work escapes the paid shape rules.
- A caller that forwards Unity or lock credentials stays unresolved.
- No licensed workflow changes, so the Unity matrix is untouched.

## Baseline

- `main` at `3a0172adeb`. No open pull request. `main` CI and both scheduled
  monitors pass.
- Local audit of the seven default branches with the unmodified analyzer:
  `Audited 7/7 enrolled repositories; active-jobs=149 findings=53 complete=true`.
- Finding classes:
  - 31 remote reusable workflow calls in six repositories.
  - 14 DxMessaging workflow shape findings.
  - 8 expired policy exceptions.

## Open-issue priority

| Order | Item | Impact | Unity CI churn |
| --- | --- | --- | --- |
| 1 | #406 remote reusable workflow calls | 31 of 53 findings. The alert cannot close while they stay unresolved. | None. Central analyzer only. |
| 2 | #397 aggregate coverage | 6 of the 14 DxMessaging findings wait on the decision. | None central; consumer edits later. |
| 3 | #113 DxMessaging shape, expired exceptions | 14 consumer findings and 8 expired exceptions. | Low for the dispatch-only workflows; the exceptions need an owner re-review. |
| 4 | #390 consumer status adoption | Needs a consumer job shape decision, already recorded. | Low. Consumer side only. |
| 5 | #379 merge queue adoption | Needs an owner decision to enable the queue. | Low. |
| 6 | #335 actionlint YAML | Blocked upstream. Rechecked today: latest actionlint is still v1.7.12. | None. |
| 7 | #29, #51, #53, #83, #153, #229, #231, #249, #277, #278, #334 | Each needs owner authority, portal evidence, or hardware that this session cannot obtain. | Unknown until the evidence exists. |

## Root cause

`analyzer.jobLicensed` treats a remote reusable workflow call as
license-capable and reports `unresolved-reusable-workflow`, because the snapshot
holds one repository tree. `auditPaidJob` then reports `missing-licensed-steps`
and `unsafe-hosted-unity-runner` for the same job, which cannot define steps.

Six enrolled repositories call `Ambiguous-Interactive/review-tools` for
`agent-metrics.yml` and `openai-review.yml`. Both callees hold only checkout,
Python setup, and artifact steps. The callers cannot remove the findings: the
callee is in another repository.

## Change

- `analyzer` holds an optional `ReusableWorkflowSource`. Before the call is
  classified, the call target splits into a callee repository and workflow
  path. A full commit SHA and a normalized `.github/workflows/<file>.yml` path
  are required.
- The callee workflow is parsed as its own snapshot and each of its jobs is
  classified with a sub-analyzer. Its findings are dropped; only the licensed
  verdict matters. A callee that uses a repository-local action or calls
  another remote workflow therefore stays unproven.
- `reusableMemo` and `reusableVisiting` share one cache per audit, so a cycle
  and a repeated call cost one read and one verdict.
- Any unproven case keeps the old verdict: `unresolved-reusable-workflow` and
  license-capable.
- `okReusableCaller` refuses a resolved call whose job text names a Unity
  serial, email, password, license, or lock credential.
- `cmd/audit-unity-enrollment` supplies the resolver: one anonymous raw read of
  `raw.githubusercontent.com/<repository>/<sha>/<path>`, a 15-second timeout, a
  256 KiB bound, a status check, and a per-run cache. `--reusable-workflow-base-url`
  exists for tests.
- `docs/consumer-enrollment.md` states the rule in preconditions item 7, in
  workflow contract item 1, and in the `unresolved-reusable-workflow` row.

## Evidence

Local audit of the same seven snapshots after the change:

```text
Audited 7/7 enrolled repositories; active-jobs=139 findings=22 complete=true
```

The 31 remote-call findings are gone. The remaining 22 are the 14 DxMessaging
shape findings and the 8 expired policy exceptions.

Focused tests:

```text
go test ./internal/enrollment -run 'TestUnityEnrollment(Resolves|Keeps|Treats|Refuses)'
ok  github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/enrollment
go test ./cmd/audit-unity-enrollment
ok  github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/cmd/audit-unity-enrollment
```

## Review findings and dispositions

Pending.

## Out of scope

- #397 keeps its open decision. This session added the measured two-lane
  evidence to it.
- The 8 expired policy exceptions need an owner re-review.
- The 14 DxMessaging findings need a consumer change.
