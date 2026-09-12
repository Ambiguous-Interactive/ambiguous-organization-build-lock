# Session 094: enrollment drift RCA and the reviewed standalone profile shape (issue 113)

## Task

Merge latest origin/main, re-verify the green baseline, and address open
issues by impact. The 2026-09-12 08:33 UTC scheduled enrollment audit
reported 8 findings over 121 active jobs, up from 1. That drift is the
highest-impact actionable item; every other open issue waits on an
external decision or live evidence.

Falsifiable hypotheses:

1. The new qora-redux and unity-helpers findings are real contract
   regressions: consumer edits set `cancel-in-progress: true` on scopes
   that reach acquire, and unity-helpers also moved the editor gate onto
   an unreviewed provisioning-profile shape.
2. The literal `StandaloneWindowsIl2Cpp` profile is strictly stronger
   than the reviewed per-mode expression, so admitting it centrally
   cannot let a standalone leg skip IL2CPP verification.

## Baseline

- `main` at 2c285ddd3, level with `origin/main`, worktree clean. All
  scheduled workflows green. No open or draft pull requests in this
  repository.
- Open issues: 269, 249, 231, 229, 153, 113, 83, 53, 51, 44, 29.
- DxMessaging #582 (session 092) stays open and green; it is a consumer
  merge decision.

## Reproduction

All six consumers checked out at the exact audited commits from run
34683538355. The unmodified `cmd/audit-unity-enrollment` reproduced the
live result exactly: 6/6 repositories, 121 active jobs, 8 findings.

## Root causes

- qora-redux `bfd13df` ("a newer run cancels the run it supersedes",
  #395) set `cancel-in-progress: true` on the `unity-tests.yml` group.
  Findings: `unity`, `unity-cleanup`.
- unity-helpers `b63df469` (#765) set `cancel-in-progress: true` on the
  `unity-tests.yml` and `unity-benchmarks.yml` groups. Findings:
  `unity-tests`, `unity-tests-single-threaded`, `unitypackage-smoke`,
  `benchmarks`.
- unity-helpers `b63df469` also replaced the reviewed static
  `matrix.test-mode` axis with sequential per-mode steps and a literal
  `provisioning-profile: StandaloneWindowsIl2Cpp`. The reviewed profile
  vocabulary admitted only `EditorOnly` or the per-mode expression, so
  `trustedEditorGateProfile` rejected the gate and the analyzer emitted
  `missing-unity-editor-check` for `unity-tests`.
- A mutation-check confirmed the profile literal is the only gate
  blocker: with `EditorOnly` substituted into the snapshot, the finding
  disappears and nothing else appears.

## Fix

- Central: `trustedEditorGateProfile` now admits the literal
  `StandaloneWindowsIl2Cpp` on a static matrix. It verifies the IL2CPP
  player module on every leg, so it can only over-provision. The unsafe
  direction, an `EditorOnly` profile beside a static `standalone` matrix
  value, stays rejected. The admission sits after the matrix-shape
  checks, so include-based and dynamic matrices keep the general
  rejection: an unenumerable leg set cannot prove the per-leg pins. The
  legacy `run:`-based gate keeps its own narrow profile check, now with
  its own red mutation. Item 3 of `docs/consumer-enrollment.md` and the
  runbook paragraph document the third admitted shape.
- Consumer: unity-helpers #772 restores per-HEAD groups with literal
  `cancel-in-progress: false` on both licensed workflows, removes the
  benchmarks top-level group (dispatch-only workflow, so repeated
  dispatches queue), restores a static version matrix restating
  `.github/unity-versions.json`, and migrates the two PowerShell
  contract tests to the reviewed shapes. A test-time comparison keeps
  the JSON file as the single version source.
- Consumer: qora-redux #396 restores the per-event group with literal
  `cancel-in-progress: false` and splits the shared gate policy test:
  `llm-harness` keeps full cancellation, `unity-tests` pins the queue
  shape. The owner's no-queued-CI steer survives through pending-run
  supersession: GitHub cancels a pending run when a newer one enters an
  occupied group, and a pending run holds no lock and no editor state.

## Verification

- Audit over the six snapshots with the central change and both consumer
  fixes applied: 1 finding (DxMessaging `missing-unity-editor-check`,
  covered by open consumer fix #582), `complete=true`.
- New data-driven Go tests: the literal profile on a static version
  matrix audits clean; the same literal beside a static `test-mode` axis
  audits clean (over-provisioning); unknown and dynamic literal profiles
  stay rejected; include-based and dynamic whole matrices stay rejected
  with the literal profile; the legacy script gate rejects the literal;
  the reviewed expression is asserted to equal its exact reviewed text,
  which locks the constant-drift failure class caught during development
  (a mistyped concatenation made two downgrade mutations apply nothing
  and turned them green; the mutation tests failed loudly and the drift
  was fixed).
- Adversarial review round one found the admission sat before the
  matrix-shape checks, so include-based and dynamic whole matrices were
  admitted without doc or test coverage, plus a stale runbook sentence,
  two untested shapes, and formatting nits. All are fixed in this
  record's scope; the reordered admission and new mutations cover the
  found shapes.
- qora-redux: 65/66 contract tests pass; the one failure fails on
  pristine `main` in this container too. Full `npm test`: 364 pass,
  39 fail, identical to pristine `main`. No new failures.
- actionlint clean on all three changed consumer workflows.
- Full lock-repository suite green before handoff.

## Change

- `internal/enrollment/unity_policy.go`: the reviewed profile admission.
- `internal/enrollment/unity_policy_test.go`: the new shape test with
  red mutations and the constant-consistency guard.
- `docs/consumer-enrollment.md`: item 3 names the literal standalone
  profile and keeps the `EditorOnly`-beside-`standalone` rejection.
- `PLAN.md`: session 094 state, the new consumer PRs, and the #113
  disposition.

## Blocked items unchanged

229, 231, 249, and 153 wait on the Darwin canary and authorization. 83,
53, 51, 44, and 29 wait on authority, portal decisions, or multi-week
live evidence. 269 waits on the next authorized release (which publishes
the peer timeline) and consumer adoption of contract item 12. 113 closes
automatically on the first complete clean audit after DxMessaging #582,
unity-helpers #772, and qora-redux #396 merge.
