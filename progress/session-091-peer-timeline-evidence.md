# Session 091: release peer-timeline evidence (issue 269)

## Task

Address issue 269's lock-side deliverable. A consumer's licensed run died
inside the editor on a Baselib TLS assertion with zero failed test cases, and
the required gate read it as an indistinguishable red suite. The issue's RCA
wall: the lock is the only component that can answer "was there a peer, and
when did it acquire or return", and it published nothing a consumer job could
read.

Falsifiable hypothesis: the lock-state branch history contains the peer
acquire and return events for any session window, and a bounded history
replay at release can publish them without changing any release outcome.
The hypothesis was confirmed by the new tests: the 269 shape (peer enters
and possibly leaves entirely inside the window) is invisible to edge
snapshots at acquire and release, but visible in state-file history.

Safety invariants: admission, cleanup classification, and the release write
are untouched. The timeline is diagnostic-only, bounded, never throws, and
never blocks or delays the release beyond its own budget. Published fields
(holder IDs, runner IDs, reason codes, timestamps) are already public in the
lock-state branch. No logs, no credential material.

## Evidence before the change

- `main` at 1ebb4344f, clean and level with `origin/main`. Main CI green;
  no open or draft pull requests. Session 090's baseline stands.
- Open issues re-swept: 269 is the only one with an in-repository fix.
  255 and 113 wait on the unity-helpers PR 749 merge; 229, 231, 249, 153
  wait on the Darwin canary and authorization; 83, 53, 51, 44, 29 wait on
  authority or live evidence.
- No runtime file read commit history before this change, and no release
  output carried peer data. `releaseCooldownSeconds` is 1 live, so a peer
  that returns mid-window leaves no reservation trace at release time.

## Change

- `.github/dist/build-lock.js`:
  - `cleanupIdentity` captures the caller's own `acquiredAt` from the first
    state read that still shows the entry, as `sessionAcquiredAt` on every
    result path.
  - `collectPeerTimeline` lists the lock-state commits since the session
    start (minus a 5-minute clock-skew buffer), replays at most 25
    snapshots under a 30-second abortable deadline with at most 2 attempts
    per read, and reduces them into redacted events: `peer-present`,
    `peer-acquired`, `peer-returned`, `reservation-present`,
    `reservation-created`, `reservation-removed`, `incident-present`,
    `incident-created`. Deadline abort keeps collected events and reports
    `partial`; an unreachable history reports `unavailable`; a noop or
    queue-only cleanup reports `not-applicable`.
  - `release` writes the `peer-timeline` output on every result path
    (defaulting to `unavailable` on the unrecorded-release error path) and
    appends a job-summary table when a session window exists.
- `.github/actions/release-build-lock/action.yml`: `peer-timeline` output
  documented.
- `test/build-lock.test.js`: reducer table test (8 cases plus truncation)
  and four end-to-end release tests (ok, unavailable, not-applicable,
  partial). `releaseOutputNames` carries `peer-timeline`.
- `test/action-manifests.test.js`: manifest output list carries
  `peer-timeline`.
- `README.md`, `docs/operations-runbook.md`: what the evidence is, its
  bounds, and the interpretation table for operators.
- `docs/consumer-enrollment.md` canary item 12: the consumer-side contract
  for the issue's recommendations 1 and 2 - classify the
  engine-assertion-plus-zero-failed-leaves signature as its own reason,
  retry the affected test phase once inside the held lock, keep a second
  failure red, and surface the peer timeline next to the failure.
- Decision recorded: no acquire-side peer output. The release-side window
  covers the full session; an acquire-side snapshot would duplicate it and
  add an output to every acquire path for one narrow crash shape.

## Verification

- `node --test test/*.test.js`: 904 tests, 898 pass, 0 fail, 6 skipped
  (platform-gated).
- `node tools/llm-harness.mjs check`: pass. `go test ./...`, `go test -race
  ./...`, `go vet ./...`, `golangci-lint` (0 issues), `go mod verify` and
  `go mod tidy -diff` for both modules: pass. `ci.sh javascript`,
  `ci.sh shellcheck`, `workflow-credential-audit`: pass.

## Adversarial review

Round 1 findings and dispositions (all fixed):

- The release commit removing this holder is inside the replay window, so
  the first reducer reported the session's own release as a `peer-returned`
  event and its own cooldown as a `reservation-created` event. Fixed by
  filtering self's holder and reservation rows once, before event
  derivation; two reducer cases and the release-commit end-to-end commit
  pin it.
- The snapshot cap kept the newest 25 of a longer window and still reported
  `ok`, silently dropping the window's opening history. Fixed by keeping
  the oldest 25 (they decide the "already present" classification) and by a
  `truncatedBySnapshots` flag that forces `partial`.
- The end-to-end test mocked a commit listing without the release write,
  masking the self-event defect. Fixed: the test registers the written
  release state as the newest listed commit.
- Peer-controlled holder IDs could inject markdown into the job summary.
  Fixed: cells render as inline code spans; backticks become apostrophes,
  newlines collapse, and pipes are escaped because GFM splits cells on them
  even inside code spans.
- The runbook overclaimed `status=ok` completeness. Reworded: `ok` is
  best-effort within the replay bounds; `partial` and `unavailable` mean
  the window is unproven, not absent of peers.
- The action.yml output description misstated the payload (`windowFrom`
  conditional; `reason` only on `unavailable`). Reworded.
- A schema-1 (`holder`-mirror) history snapshot would have made its
  holder invisible. The snapshot parser now accepts both shapes.
- PLAN.md's "never delays the release" tightened to the bounded-budget
  wording; a dead `|| ""` on the captured admission time removed.

Round 2 verified every fix against the runtime and confirmed no new
safety or fail-closed regressions. `node --test test/build-lock.test.js`
(443 pass) and `ci.sh javascript` (exit 0) green after the fixes.

PR review round (Cursor Bugbot on commit ea87ae1a9, fixed in the follow-up
commit):

- Medium: the commit listing reaches back by the 5-minute skew buffer, but
  the reducer treated its first snapshot as the window opening. A peer that
  acquired and returned entirely inside the buffer was published as
  `peer-present`/`peer-returned` with `status=ok`. With the live 1-second
  cooldown that is a normal busy-lock pattern, not a rare skew case.
  Fixed: the reducer now takes the parsed session start. Only snapshots at
  or after the start are reported; pre-session snapshots are tracked but
  never published; a peer observed at a reported snapshot is classified by
  its own state timestamp (`present` when admitted at or before the start,
  `acquired` afterwards); removals are only derived between reported
  snapshots. A replay that never reaches a snapshot inside the window
  reports `partial` instead of a lying `ok`. Three new reducer cases and a
  pre-session buffer commit in the end-to-end release test pin the fix.
- Reservations and incidents follow the same window rules, classified by
  their own `createdAt`; the reservation-present fixture moved before the
  window start so the case keeps testing the `present` classification.

Bounds re-checked: one absolute 30-second deadline with an abort signal,
at most 2 attempts per read, at most 25 snapshots, at most 100 events.
The `since` filter uses the acquirer's clock against GitHub commit
timestamps; the 5-minute buffer absorbs skew and is pinned by a test, and
the reducer carries each peer's exact admission time.

## Dispositions and follow-ups

- Issue 269 stays open for its consumer-side items (classification and the
  bounded retry), now published as canary item 12. The next qora-redux
  casualty can be correlated from its own run's release evidence.
- The same evidence feeds 83's two-order proof and 223's correlation ask;
  no separate lock change is needed for them.
- One branch, one pull request for the whole session.
