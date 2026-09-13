# Session 097: repin verification, the clean-audit close of #113, and the collision RCA

Date: 2026-09-13. Main CI was green at `03c754e25` (PR #279). No open pull
requests existed in this repository. Main is up to date with `origin/main`.

## Baseline

Session 096 left two live-verification debts: the bounded repin offer scan
(#279) had never run in production, and unity-helpers #785 was open against
the four static-matrix findings. Open issues at session start: #280, #278,
#277, #113, plus the authority-blocked set recorded in `PLAN.md`.

## #280: the #279 fix verified live, issue closed

The day's scheduled run (34743810332, created 06:52 UTC) started before
#279 merged (14:55 UTC) and still failed with `invalid value for --limit: 0`.
That run is the old failure, not a regression. A `workflow_dispatch` of
`Repin consumer lock references` on merged `main` (run 34768908054,
16:32 UTC) completed green: all six consumers processed, the bounded scan
ran, no `--limit 0` error, and no superseded offers existed to close.
Issue #280 closed with the run as evidence.

## #113: the clean audit landed and closed the alert

unity-helpers #785 merged 2026-09-13 16:27 UTC. The request workflow
(dispatch 34770233285) triggered the trusted audit (run 34770239068,
16:59 UTC): `0 findings`, `118 active inventory rows`, `Retrieval: complete`.
Alert #113 auto-closed 17:01 UTC, state reason completed. This completes
milestone M3. `PLAN.md` now records M3 under completed milestones.

## #278: the collision premise is refuted by lock-state history

The issue claims a seat collision failed qora-redux run 34736599983 red
without waiting, quotes two lock log lines as proof, and asks for
wait-and-queue behavior. The lock-state branch history for 03:45 to 05:00 UTC
shows a different story:

- 04:01:47Z: the job's acquire leg started. The lock had been full
  (unity-helpers plus DxMessaging) from 03:54:22Z to 04:00:54Z, but the
  acquire attempt began after that window, not during it. It queued and
  admitted itself within three seconds (`queuedAt` 04:01:47.467Z,
  `acquiredAt` 04:01:50.212Z). No reservation blocked admission. This window
  shows FIFO admission working; it does not demonstrate a wait under
  contention.
- 04:06:48Z: the holder released clean, cleanup confirmed. The release leg
  printed both quoted lines: "Lock is held by ...; this run is ..." is the
  standard remaining-holder notice in the release path of
  `.github/dist/build-lock.js`, and "Removed lock ownership ...; resource
  capacity entered cooldown" is `explicitReleaseMessage` for a confirmed
  cleanup. Neither line fails a job.
- 04:29:02Z to 04:34:00Z: the retry acquired (again a short queue-to-admit
  gap), held about five minutes, and released clean, cleanup confirmed.
  This matches the reported Baselib TLS teardown crash: the failure lived
  inside the editor, and the lock recorded a correct return both times.
- 04:44:17Z: the consumer pushed `3d436775`. That push started replacement
  run 34738596998. The workflow's own concurrency group with literal
  `cancel-in-progress: true` (the reviewed #274 flip) cancelled attempt 3
  before it reached acquire. The replacement run completed green.

The collision refutation stands on the clean acquire, hold, and release
records for attempts 1 and 2: no acquire failure, no cooldown-before-wait,
and no unattributed cancel exist anywhere in this window. The quoted lines
are release-path output, not failure evidence.

Comment posted with the evidence. Remaining actionable ask narrowed to the
editor teardown-contamination class, which is consumer validation-flow work,
not lock work. Attempt 1's exact suite failure is unknowable because the
rerun dropped the leg logs; the issue author was asked to attach the log.

## #277: attribution data point

The same-day qora cancel shows one cancel class is attributable without new
tooling: push-driven cancels are self-inflicted through the reviewed
concurrency flip. The session 095 evidence gap (the unexplained 18:34:19Z
cancel) stays real only for cancels that no push, PR event, or watchdog
state explains. Comment posted; no code change. Direction 2 (a consumer-side
cancellation diagnostic) remains available if the gap recurs.

## PLAN.md

- Current state rewritten for session 097; the session 096 verification
  debts are resolved.
- M3 removed from the milestone list and recorded under completed
  milestones.
- M1 (portal evidence) and M2 (capacity decision) keep their single open
  items. The blocked list is unchanged: every remaining open issue needs
  organization-owner authority, portal evidence, or multi-week live
  windows.

## Evidence

- Repin dispatch: run 34768908054, started 16:32 UTC, completed green
  16:33 UTC; issue #280 closed with it.
- Pre-merge scheduled failure: run 34743810332, created 06:52 UTC (the
  06:37 cron start drifts), `--limit 0` class, superseded by the merge.
- Clean audit: run 34770239068, 0 findings, 118 active inventory rows as
  the audit reported; the 04:20 audit counted 119 active jobs, so the live
  fleet changed between the runs. Request run 34770233285; #113 closed
  17:01:24 UTC as completed.
- Lock-state commits read: the 41 commits on `lock-state` from 03:45:24Z to
  04:56:07Z; qora holder entries at 04:01:51Z, 04:06:48Z, 04:29:02Z, and
  04:34:00Z; the acquire timing pair `queuedAt` 04:01:47.467Z and
  `acquiredAt` 04:01:50.212Z.
- qora-redux runs: 34736599983 (attempts 1 to 3, final cancelled) and
  34738596998 (push replacement, success); PR #403 push `3d436775` at
  04:44:17Z.
- Comments: #278 (comment 5654721027), #277 (comment 5654728450),
  #280 closing comment.
- Verification before handoff: `node tools/llm-harness.mjs check` green;
  `node --test test/*.test.js`, `go test ./...`, `go test -race ./...`,
  `go vet ./...`, `golangci-lint run`, both `tools/workflows/ci.sh`
  targets, module verifies, `go mod tidy -diff` on both modules, and the
  workflow credential audit all green. No production code changed.
