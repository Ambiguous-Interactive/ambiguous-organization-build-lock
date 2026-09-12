# Session 095: drive the licensed-cancellation flip cohort toward merge

Date: 2026-09-12. Main CI was green at `00dc0471c` (#275). No open or draft
pull requests existed in this repository. The session worked the open
dependency side of #113: the four consumer flip pull requests that carry the
#274 cancellation contract.

## Baseline

The enrollment audit pushed by the #275 merge (run 34714868795,
19:40 UTC) reported 19 findings over 121 active jobs:

- DoxReloaded 2 (`unsafe-workflow-queue`, `build-deploy.yml`)
- DxMessaging 6 (5 `unsafe-workflow-queue`, 1 `missing-unity-editor-check`)
- IshoBoy 6 (`unsafe-workflow-queue`, three workflows)
- unity-helpers 5 (`unsafe-workflow-queue` on `release.yml`, plus the four
  dynamic-matrix codes on `unity-tests.yml`)

DxMessaging #584 (the cancellation flip) merged at 19:57 UTC and cleared its
five `unsafe-workflow-queue` findings, leaving 14 when the session started
working. The remaining fixes were three open consumer pull requests and one
closed one (unity-helpers #772). Three of the four vehicles were red.

## Root-cause analysis of the red consumer PRs

The same failure class explains two of the three reds: a reviewed consumer
artifact still pinned the pre-#274 contract shape.

- IshoBoy #902: `scripts/ci/test_unity_lock_workflow_contract.py` failed
  `test_gate_workflow_always_reports_and_uses_immutable_pr_author` and
  `test_every_workflow_that_takes_a_unity_seat_is_recoverable`. The licensed
  workflow assertion required `cancel-in-progress` `false`. Test bug; the
  contract moved in #274.
- DoxReloaded #832: `.github/scripts/validate-organization-build-lock-policy.sh`
  failed with `build-deploy.yml must set literal
  concurrency.cancel-in-progress: false`. Same class. Test bug.
- DxMessaging #582: no code failure. Its Unity and performance runs were
  cancelled mid-flight at 18:34:19Z (see the evidence-gap note below). Its
  branch already carried the flip through the master merge `4aa11a9`; the
  flip itself merged as DxMessaging #584.

## Fixes pushed

- IshoBoy #902 (`f64b795f`): the licensed-workflow assertion now requires a
  literal `cancel-in-progress: true` and states the resilience evidence
  (acquire signal trap, `always()` cleanup chain, reaper). The gate pin and
  the invented-workflow fixture moved with it. Local proof:
  `pytest scripts/ci/test_unity_lock_workflow_contract.py` passes 105 tests.
- DoxReloaded #832 (`ad7f2831`): the validator pin now requires literal
  `true` with the same rationale. Local proof: the validator script passes.
- unity-helpers #772: reopened. The PR had been closed after its content was
  pushed to `main` directly. The release merge (#773, 3.6.0) then landed on
  the pre-restore history, so the five findings were live again. The branch
  (static `unity-version` axis restating `.github/unity-versions.json`,
  `release.yml` literal `cancel-in-progress: true`) merged cleanly onto
  `08de7912` and was force-pushed to the PR head (`421222db`).
- CI then caught a real gap in the restored content: the
  `unity-workflow-matrix-contract` suite failed its centralization term,
  which still pinned the dynamic axis literal
  `unity-version: ${{ fromJSON(...) }}`. The suite's own version-grouped
  matrix contract already proves the static axis against
  `.github/unity-versions.json`. Fix pushed as `f1bc22b0`: the
  centralization term requires that same canonical match. Local proof with
  pwsh 7.4.6: the suite exits 0 with no error annotations on `f1bc22b0`.

Succession after the fixes landed: DoxReloaded closed #832 and folded it
into #835, which merged and carries the flip plus the validator pin on
`main`. unity-helpers closed #772 again as superseded by #776, which
restates the static version axis, drops the stale dynamic-axis suite pin
(the same gap `f1bc22b0` fixed), and moves the release export off the
licensed path. The analyzer proof below was taken at the documented PR
heads and is unaffected by the successions.
- DxMessaging #582: needed no commit. The branch already carried the flip
  (master merge `4aa11a9`); its runs re-queued. The flip itself merged as
  DxMessaging #584.

## Analyzer proof

The unmodified `cmd/audit-unity-enrollment` over all six enrolled
repositories at the four PR heads (before the #772 suite fix, which touches
no workflow):

`Audited 6/6 enrolled repositories; active-jobs=121 findings=0 complete=true`

Audited heads: DoxReloaded `ad7f2831`, DxMessaging `4aa11a99`,
IshoBoy `f64b795f`, qora-redux `5e18981c`, unity-builder `70c59fd0`,
unity-helpers `421222db`. The #772 head is now `f1bc22b0`; it changes only
the PowerShell contract suite. Merges stay consumer decisions. The first
complete clean scheduled audit closes #113 automatically.

## Evidence gap: the 18:34:19Z cancellation

DxMessaging #582's `Unity Tests` and `Performance Numbers` runs (head
`84a1276c`) were cancelled simultaneously at 18:34:19Z while their matrix
legs waited for the fleet. Observed facts:

- The stuck-job watchdog audited at 18:31:42Z. Its verdict line for both
  runs printed at 18:31:48Z: every matching runner online but busy, healthy
  backpressure, no action. Its cancel cap state branch holds no record for
  these run ids. Its next cycle (18:41:03Z) started after the cancellation.
  The gap is tracked as issue #277.
- The lock-state history shows normal acquire and release churn in the
  window and no incident.
- No superseding push, no PR close or reopen, and no watchdog cap entry
  explains the event.

GitHub records no canceller identity for run cancellations, so the
attribution is not answerable from retained evidence. Cost: about one hour
of red required checks on a clean revision. Recorded here as an audit
evidence gap; no code change made.

## Repository verification

All commands from `.llm/context.md` pass on this session's commit:
harness check, `node --test`, `go test`, both `mod verify`, both
`tidy -diff`, `golangci-lint` (0 issues), `ci.sh javascript`,
`ci.sh shellcheck`, `go vet`, `go test -race`, credential audit.
