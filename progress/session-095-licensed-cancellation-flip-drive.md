# Session 095: drive the licensed-cancellation flip to green

Date: 2026-09-12. Main CI was green at `00dc0471c` (#275). No open or draft
pull requests existed in this repository. The session worked the open
dependency side of #113: the four consumer flip pull requests that carry the
#274 cancellation contract.

## Baseline

The live enrollment audit (scheduled run at 19:42 UTC) reported 14 findings
over 121 active jobs:

- DoxReloaded 2 (`unsafe-workflow-queue`, `build-deploy.yml`)
- DxMessaging 6 (5 `unsafe-workflow-queue`, 1 `missing-unity-editor-check`)
- IshoBoy 6 (`unsafe-workflow-queue`, three workflows)
- unity-helpers 5 (`unsafe-workflow-queue` on `release.yml`, plus the four
  dynamic-matrix codes on `unity-tests.yml`)

All four fixes were open as consumer pull requests, and three of the four
were red.

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
  cancelled mid-flight at 18:34:19Z (see the evidence-gap note below).

## Fixes pushed

- IshoBoy #902 (`f64b795f`): the licensed-workflow assertion now requires a
  literal `cancel-in-progress: true` and states the resilience evidence
  (acquire signal trap, `always()` cleanup chain, reaper). The gate pin and
  the invented-workflow fixture moved with it. Local proof:
  `pytest scripts/ci/test_unity_lock_workflow_contract.py` passes 105 tests.
- DoxReloaded #832 (`ad7f2831`): the validator pin now requires literal
  `true` with the same rationale. Local proof: the validator script passes.
- unity-helpers #772: reopened. The PR had been closed after its content was
  pushed to `main` directly, but the release merge (#773, 3.6.0) landed on
  the pre-restore history, so the five findings were live again. The branch
  (static `unity-version` axis restating `.github/unity-versions.json`,
  `release.yml` literal `cancel-in-progress: true`) merged cleanly onto
  `08de7912` and was force-pushed to the PR head (`421222db`).
- DxMessaging #582: needed no commit. The branch already carried the flip
  (master merge `4aa11a9`); its runs re-queued.

## Analyzer proof

The unmodified `cmd/audit-unity-enrollment` over all six enrolled
repositories at the four PR heads:

`Audited 6/6 enrolled repositories; active-jobs=121 findings=0 complete=true`

Audited heads: DoxReloaded `ad7f2831`, DxMessaging `4aa11a99`,
IshoBoy `f64b795f`, qora-redux `5e18981c`, unity-builder `70c59fd0`,
unity-helpers `421222db`. Merges stay consumer decisions. The first
complete clean scheduled audit closes #113 automatically.

## Evidence gap: the 18:34:19Z cancellation

DxMessaging #582's `Unity Tests` and `Performance Numbers` runs (head
`84a1276c`) were cancelled simultaneously at 18:34:19Z while their matrix
legs waited for the fleet. Observed facts:

- The stuck-job watchdog ran at 18:31:42Z and explicitly took no action
  (`every matching runner is online but busy; healthy backpressure`); its
  next cycle was 18:41:03Z, after the cancellation. Its state branch holds
  no cancel record for these runs.
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
