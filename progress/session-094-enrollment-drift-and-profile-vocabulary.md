# Session 094: cancellation enforcement pivot and the reviewed standalone profile shape (issues 113, 274)

## Task

Merge latest origin/main, re-verify the green baseline, and address open
issues by impact. The 2026-09-12 08:33 UTC audit (run 34683538355)
reported 8 findings over 121 active jobs. Mid-session the operator opened
#274 and reversed the cancellation direction: make the lock resilient to
in-progress cancellation, then suggest or enforce cancellation on
consumers, because "queueing useless items on self hosted runner seats
is a waste of resources."

Falsifiable hypotheses:

1. The lock technology already makes cancellation safe: the acquire
   action traps cancellation signals and releases before activation, the
   licensed cleanup chain runs under `if: always()`, and the scheduled
   reaper recovers a holder whose runner died.
2. The literal `StandaloneWindowsIl2Cpp` profile is strictly stronger
   than the reviewed per-mode expression, so admitting it centrally
   cannot let a standalone leg skip IL2CPP verification.

## Baseline

- `main` at 2c285ddd3, level with `origin/main`, worktree clean. All
  scheduled workflows green. No open or draft pull requests in this
  repository.
- Open issues: 269, 249, 231, 229, 153, 113, 83, 53, 51, 44, 29, and the
  new operator steer 274.

## Reproduction of the 08:33 drift

All six consumers checked out at the exact audited commits. The
unmodified `cmd/audit-unity-enrollment` reproduced the live result
exactly: 6/6 repositories, 121 active jobs, 8 findings.

## Root causes of the 08:33 drift

- qora-redux `bfd13df` (#395) and unity-helpers `b63df469` (#765) set
  `cancel-in-progress: true` on licensed scopes, which the contract then
  forbade.
- unity-helpers #765 also replaced the reviewed static `test-mode` axis
  with sequential per-mode steps and a literal
  `provisioning-profile: StandaloneWindowsIl2Cpp` that the reviewed
  vocabulary did not admit, so the gate check emitted
  `missing-unity-editor-check`. A mutation check isolated the profile
  literal as the only gate blocker.

## The pivot (#274)

The operator's steer reverses the licensed-queue invariant. Evidence
that cancellation is already resilient:

- `.github/dist/build-lock.js` installs SIGINT/SIGTERM handlers during
  acquire. A signal aborts the queue wait, runs cancellation cleanup,
  and exits 130/143. Tests cover the handler, the abort path, and the
  cleanup-before-activation path (test/build-lock.test.js).
- Every enrolled licensed job runs the central return, classification,
  release, and cleanup gate under `if: always()`; the analyzer enforces
  that chain today with other finding codes.
- The scheduled reaper reaps stale holders by exact Actions job ID, so a
  holder whose runner died mid-session is recovered.

Contract change (this session's pull request):

- `unsafeConcurrency` now requires a workflow block with a literal
  `cancel-in-progress: true` on every scope that can reach acquire. An
  absent block, `false`, quoted values, and expressions fail closed.
  New codes: `unsafe-workflow-queue` (workflow scope) and
  `unsafe-job-queue` (an existing job-level group that does not cancel;
  an absent job group defers to the workflow scope).
- Aggregate-reporter jobs keep the opposite rule
  (`unsafeAggregateConcurrency`): an existing block there must stay
  literal false so a sibling cannot cancel the report, and a group that
  omits `cancel-in-progress` now fails closed. Run-level cancellation of
  a superseded run is fine: the successor run reports the context.
- `fail-fast: false` on licensed matrices is unchanged: a sibling must
  never cancel another leg's cleanup.
- Item 11 of `docs/consumer-enrollment.md`, the two finding rows, the
  runbook paragraph, the workflow-policy skill, the context invariant,
  and the consumer safety shape are updated together.

## Profile vocabulary change (pre-pivot work, kept)

`trustedEditorGateProfile` admits the literal `StandaloneWindowsIl2Cpp`
on a static matrix. It verifies the IL2CPP player module on every leg,
so it can only over-provision. The admission sits after the
matrix-shape checks, so include-based and dynamic matrices keep the
general rejection. The unsafe direction, an `EditorOnly` profile beside
a static `standalone` matrix value, stays rejected. The legacy
`run:`-based gate keeps its own narrow profile check, with its own red
mutation. Item 3 documents the shape.

An adversarial review round found the admission initially sat before the
matrix-shape checks, admitting include-based and dynamic whole matrices
without doc or test coverage. The reorder, the new mutations, and the
runbook sentence fix that round.

## Audit after the pivot

With the inverted analyzer over upstream default branches (qora-redux
`d51f23f2`, unity-helpers `3b238ba4`, others at the audited commits):
19 findings over 6/6 repositories.

- 15 `unsafe-workflow-queue` findings across DoxReloaded (2), DxMessaging
  (5), IshoBoy (6), and unity-helpers (1). qora-redux is already clean:
  its main cancels.
- unity-helpers `unity-tests` also fails the central-return contract
  (4 findings) because #771 made the version matrix dynamic; the static
  matrix restore clears those.
- DxMessaging `missing-unity-editor-check` stays covered by open
  consumer fix #582.

Reviewed consumer changes opened or updated this session:

- qora-redux #396: closed. Its main already carries the now-reviewed
  cancellation shape, so the fix PR that restored queueing is obsolete.
- unity-helpers #772: retargeted. It keeps the static version matrix
  restore and adds the `release.yml` flip; its queue-shape changes are
  dropped.
- DoxReloaded, DxMessaging, and IshoBoy receive one-block flip pull
  requests for the queue findings.

## Verification

- `go test ./...`, `node --test test/*.test.js` (905 tests), gofmt, go
  vet, golangci-lint, both ci.sh lanes, both module verifies and tidy
  diffs, and the credential audit ran green before handoff.
- The six-snapshot audits above are byte-consistent with the run
  summaries they reproduce.

## Blocked items unchanged

229, 231, 249, and 153 wait on the Darwin canary and authorization. 83,
53, 51, 44, and 29 wait on authority, portal decisions, or multi-week
live evidence. 269 waits on the next authorized release and consumer
adoption of contract item 12. 113 closes automatically on the first
complete clean audit after the consumer flip pull requests merge.
