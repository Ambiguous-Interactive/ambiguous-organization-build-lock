# Session 096: repin offer-scan RCA and the unity-helpers static-matrix regression

Date: 2026-09-13. Main CI was green at `029e95516`. No open pull requests
existed in this repository. Main is up to date with `origin/main`.

## Baseline: the flip cohort completed

All four #274 flip vehicles reached `main` after session 095 closed:

- DoxReloaded #832 folded into #835 (merged).
- IshoBoy #902 folded into #906, which merged 2026-09-12 23:20 UTC.
- unity-helpers #776 merged 2026-09-12 22:19 UTC.
- DxMessaging #584 merged 2026-09-12 (session 095).

Alert #113 auto-closed on 2026-09-12 21:36 UTC on the first complete clean
audit, then reopened (see below). The on-demand audit dispatched this session
(run 34737670056, 04:20 UTC) reported `findings=4` over 119 active jobs,
`complete=true`, all on unity-helpers `unity-tests` at `e969f494`.

## Central fix: repin offer-scan failure

`Repin consumer lock references` failed on 2026-09-10, 09-11, and 09-12
(runs 34447241152, 34571801026, 34679138266). Every consumer that reached the
close-superseded-offers path logged `invalid value for --limit: 0`, then
`could not list open repin offers`. The run failed closed as designed.

Root cause: `close_superseded_offers` in
`tools/workflows/repin-consumer-locks.sh` passed `--limit 0` to
`gh pr list`, believing `0` meant "unlimited" (session 087 chose it after
finding the default page cap of 30). The current `gh` CLI rejects any
non-positive limit, so the first live exercise of the path failed. The run of
2026-09-09 stayed green because no consumer was in the superseded state that
day; the scan itself had never run clean in production.

Fix: the scan requests a bounded page of 100 items and fails closed when the
page is full, because a full page cannot prove the offer list is complete.
The first `jq` output line reports the page size; the remaining lines are the
automation-branch offers. The mock `gh` in
`test/workflow-scripts.test.js` now mirrors real `gh`: it rejects
non-positive limits and always applies the page cap, so a regression to
`--limit 0` turns three existing close-path tests red. A new data-driven test
proves the full-page case fails closed and closes nothing.

A second bug surfaced while implementing the parse: command substitution
strips the trailing newline, so the marker line and the offer lines must be
split through a normalized stream. Parameter expansion on the raw output
turned the marker itself into an offer and the isolated function tried to
close pull request #0. The existing "records an already pinned repository
without offers" test caught it.

Sweep for the class: `gh pr list --limit 0` appears nowhere else; the other
call sites are head-filtered existence checks that accept the default cap.

Verification is local-only until merge: the workflow checks out the trusted
default branch, so the scheduled run (06:37 UTC) or a dispatch after the merge
is the live proof.

## Consumer fix: unity-helpers #785

The four findings share one root cause. #776 reshaped the `unity-tests`
matrix into the static `unity-version` axis plus a dynamic
`selected-version` axis (`${{ fromJSON(needs.matrix-config.outputs.unity-versions) }}`)
with mismatch exclusions. `staticUnityVersionMatrix` requires every axis to be
static text so the audit can enumerate the cells and prove the per-leg editor
gate and central return pins. The expression axis defeats the enumeration;
the return-input typing and the editor-gate proof fail, and
`unsafe-central-return-suffix` plus `classifier-inputs-not-typed` cascade
from the unclassified return step.

Diagnostics: a scratch instrumentation of the return-step classification
showed the only false condition was `typedReturnInputs`, and the axis-level
trace pinpointed `axis reject: key="selected-version"`. The diagnostics are
removed; the auditable trail lives in this record and on issue #113.

One measurement trap is worth recording: `cmd/audit-unity-enrollment` loads
snapshots with `LoadGitSnapshot`, which reads the pinned commit's tree
through git objects. Working-tree edits in the consumer clone are invisible;
the local fix had to be committed before the analyzer could see it. Two
bisection rounds were wasted on this.

Resolution: unity-helpers #785 restores the #772 static axis, corrects the
workflow comment, and reverts the selector assertions in the consumer's
`test-unity-workflow-matrix-contract.ps1` to the #772 wording (keeping
#776's unitypackage de-licensing changes). Behavior: pull-request and push
legs are identical, because the exclusions had reduced the cell set to the
identity pairs; a `workflow_dispatch` run now executes the full matrix.
Verified with the unmodified analyzer over all six consumers at `e969f494`
with the fix committed: `findings=0, complete=true, 119 active jobs`;
findings=4 without it. RCA posted on issue #113.

## Evidence

- Repin failures: runs 34447241152, 34571801026, 34679138266; the first red
  is 2026-09-10 06:53 UTC, the last green 2026-09-09 06:52 UTC.
- On-demand enrollment audit: run 34737670056 (2026-09-13 04:20 UTC),
  `Audited 6/6 ... active-jobs=119 findings=4 complete=true`; run green with
  the drift issue updated, per the merge-policy split.
- Local audit with the unity-helpers fix applied: `findings=0 complete=true`.
- unity-helpers pull request: #785, head `0c0f9ffb`.
- Drift RCA comment: issue #113, comment 5651230077.
