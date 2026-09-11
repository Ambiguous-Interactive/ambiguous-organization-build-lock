# Session 092: enrollment drift RCA and peer-correlation evidence (issues 113, 255, 269)

## Task

Merge latest origin/main, re-verify the green baseline, and address open
issues by impact. Session 091 had just landed the peer-timeline; the open
issue queue had no in-repository fix. Both changed during the session:
unity-helpers #749 merged and cleared the last 27 structural findings, and
the same enrollment audit run caught one fresh drift.

Falsifiable hypotheses:

1. The new DxMessaging finding is a real contract regression, not an
   analyzer defect: an edit moved the `ensure-unity-editor` gate out of
   its reviewed prefix.
2. Lock-state branch history can settle #269's correlation question for
   the two recorded casualty attempts the way the new `peer-timeline`
   output will.

## Baseline

- `main` at b5e7b0fac, level with `origin/main`, worktree clean. Build lock
  CI and the enrollment audit green on the merge push. No open or draft
  pull requests. No failed runs in the recent history.
- Open issues: 269, 255, 249, 231, 229, 153, 83, 53, 51, 44, 29, and drift
  alert 113.

## Enrollment drift: DxMessaging `missing-unity-editor-check` (#113)

Observed: run 34649869100 (2026-09-11 21:32 UTC) reported 1 finding over
119 active jobs: DxMessaging `.github/workflows/unity-tests.yml` job
`unity-tests`, `missing-unity-editor-check`. unity-helpers no longer
appears; #749 merged at 2026-09-11 21:32 UTC.

Reproduced locally: all six consumers checked out at the exact audited
commits, the unmodified `cmd/audit-unity-enrollment` reported
`complete=true`, 119 active jobs, the same single finding.

Root cause: DxMessaging #580 (merged 2026-09-11 15:51 UTC) inserted a
one-minute input mutual-exclusion guard between the current-PR-head guard
and the editor gate. Contract item 3 fixes the reviewed prefix; the gate
moved to step three, so the literal-shape check failed. The audit is
correct. The docs already state the position rule, but the finding
table's fix text did not name it.

Fix: DxMessaging #582 moves the guard to directly after the gate. It still
fails before any checkout, credential reference, or lock acquisition.
Verified with the unmodified analyzer over all six snapshots with the fix
applied: 0 findings, `complete=true`, 119 active jobs. The diff moves six
lines and adds one comment.

Sweep: the same audit run reports every other consumer clean, so no other
repository carries the class.

## Peer correlation for #269

The issue's rerun note expected a green rerun. The API says otherwise:
run 34537837229 has `run_attempt=2` and conclusion `failure`. Attempt 2
reproduced the identical signature (EditMode 158/0 green, PlayMode
suite-setup Baselib TLS assertion, zero failed leaves, clean confirmed
return). The PR's later green run used a commit that edits a PlayMode
test file, so it is not a same-sources control.

Lock-state replay for both casualty windows (2026-09-10):

- Attempt 1 (22:40:19Z-22:43:47Z): single holder (qora-redux, runner
  `ELI-MACHINE`), empty queue, no reservations, no incident. A
  unity-helpers session (editor 6000.3.16f1) returned on the same runner
  at 22:39:17Z. Its cooldown cleared at 22:39:34Z. qora acquired 62s
  after the return and 45s after the cooldown cleared.
- Attempt 2 (23:10:31Z-23:14:00Z): same single-holder shape. An IshoBoy
  session returned on the same runner at 23:09:51Z; cooldown cleared
  23:10:08Z. qora acquired 40s after the return and 23s after the
  cooldown cleared.
- Base rate: 85% of acquires over the last three days follow a release
  within 60s (median 30s, 705 acquires), so return proximity alone is not
  diagnostic.

Inference posted on #269: no concurrent peer existed in either window, so
the concurrent-race hypothesis weakens. Both casualties started 40-62s
after a peer's license return on the same physical runner. This points at
cross-session machine state. The comment separates these facts from the
inference.

## Change

- `docs/consumer-enrollment.md`: the `missing-unity-editor-check` fix row
  now names the reviewed prefix rule for new or edited workflows. The next
  consumer sees the position contract without reading item 3 in full.
- `PLAN.md`: current state moved to session 092; the 27-finding and
  #113-close claims replaced with the merged state; the M3 drive item
  records the new drift and its consumer PR; the #113 item notes that the
  alert stays open while a finding stands.
- No production code changed. The analyzer behaved correctly; widening it
  for the consumer's guard step would weaken the reviewed prefix for no
  safety gain.

## Verification

- `go run ./cmd/audit-unity-enrollment` over six exact snapshots: before
  the consumer fix, 1 finding; after, 0 findings, complete, 119 jobs.
- Full local suite ran green before handoff: the harness check, all
  `test/*.test.js` suites, `go test ./...`, `go test -race ./...`,
  `go vet ./...`, both `go mod verify` and `go mod tidy -diff` checks,
  `golangci-lint run`, both `tools/workflows/ci.sh` lanes, and the
  workflow credential audit.
- DxMessaging #582: diff moves six lines; no workflow behavior change.

## Blocked items unchanged

229, 231, 249, and 153 wait on the Darwin canary and authorization. 83,
53, 51, 44, and 29 wait on authority, portal decisions, or multi-week live
evidence. 255 closes automatically on the first clean merge-policy audit
after the unity-helpers merge (next scheduled run 2026-09-12 08:41 UTC).
