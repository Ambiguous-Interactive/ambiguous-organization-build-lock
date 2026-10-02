# Session 122: publish both acquire wait phases

Date: 2026-10-01

## Prioritized open issues

Baseline: clean `main` at `8622bf6b2`. No open pull requests. No open
Dependabot pull requests and no Dependabot alerts. `main-module
GOSUMDB=off go list -m -u all` reports no module updates; the isolated
actionlint module is unchanged. No dependency change was made.

| Priority | Issue | Impact and evidence boundary |
| --- | --- | --- |
| P0, merge-policy source binding | #255, #44 | Four rulesets leave the required Unity aggregate unbound, so any App could satisfy it. The central audit already detects it. The fix is a live ruleset edit through the authorized owner path, which this task must not make. |
| P0, owner security action | #51 | App installation and org-secret visibility. Owner authority required. |
| P0, licensed-seat proof | #83 | Independent two-seat capacity and portal reconciliation. Owner and Unity portal evidence required. |
| P1, queue diagnostics | #53 | Items 1 and 6 are in-repository. The admission-protocol redesign needs live two-runner load. **Selected.** |
| P1, platform cleanup | #153, #229, #231, #249 | Native and container canaries plus an immutable release authorization. Hardware and owner acts by design. |
| P1, lifecycle evidence | #29 | Hard-stop, account-block, third-runner, and seven-day monitoring canaries. Live operations. |
| P1, consumer evidence | #278 | Lock admission and release were clean. The first test log and consumer retry details are still missing. |
| P2, cancellation attribution | #277 | GitHub records no actor for the unexplained cancellation. No actor is recoverable from run records. |

I selected #53 item 6 with the part of item 1 it needs. It has high
operational impact, needs no licensed Unity job, and changes no safety
invariant. It was also the only in-repository item that removed a gap between
what the runbook already told operators to monitor and what the action
actually published.

## Baseline

- `.devcontainer/scripts/verify.sh` exits 0 in 9.2 s. 978 JavaScript tests,
  0 fail, 6 skipped by platform gate. All Go suites, `golangci-lint`,
  `shellcheck`, `actionlint`, `go vet`, and `go test -race` pass.

## Hypothesis

A caller waiting for this lock waits in exactly one of two places: before
GitHub gives it a runner, or inside the organization FIFO. The second is the
only one the action published, and only inside a collapsed log group or on the
timeout path. The first happens before the acquire process starts, so it
cannot be measured from inside without a new API call.

Falsifiable claim: the exact job record the acquire step already reads to prove
the caller identity already carries that job's own timeline, so the runner
wait is measurable with **no extra API call**. If the record does not carry it,
the hypothesis fails and the item cannot be closed here.

The record does carry `created_at` and `started_at`. Confirmed.

## Change

Three commits on `issue-53-acquire-wait-phase-diagnostics`.

- Publish `runner-wait-ms`, measured from the exact job's Actions timeline.
- Publish `queue-position`. It was computed and discarded into a log line.
- Report both phases in every summary the action writes, under the output
  names.
- Report the last observation that withheld the lock on an acquired run.
- Use one clock for `wait-ms` on every outcome path.
- Stop reporting a queue position for a caller that already holds the lock.
- Stop reporting peer-written values unescaped in the acquire summary.
- Correct the `peer-timeline` status and the reaper summary where each
  misdescribed the situation. Same defect class. See the class sweep below.

## Class sweep

The change unified `wait-ms` because two code paths reported one name with
different windows. The same class of defect, a diagnostic that misdescribes
the situation, exists in two other outputs. Both are in the same runtime and
each is one line, so both are fixed here.

| Site | Symptom | Fix |
| --- | --- | --- |
| Release whose state write never landed | Published `peer-timeline` status `unavailable` with no `reason`, which the manifest promises. | Publish the reason. `not-applicable` would claim no session, and this path cannot prove that. |
| Reaper, prune-only run | Summary said "Reaped capacity-critical stale state" when it had pruned only expired cooldowns and reaped no holder. | Say which happened. The `reaped` output is unchanged and still correct. Not covered by a test; no reap fixture reads a summary today. |

## Red-green

| Check | Before | After |
| --- | --- | --- |
| `current job lookup` cases | 2 | 9, as a data-driven table plus one fail-closed case |
| `acquire publishes both wait phases` | absent | 1 |
| `queue-position` on the superseded path | not asserted | asserted `1` |
| Acquire wait-phase documentation | no test | 1 test, whitespace-folded |
| `node --test test/*.test.js` | 978 | 987 |

Red states observed before each implementation step: the missing output keys,
the absent `resolveCurrentJob` export, the timeout-path clock value, and the
summary that named a peer which had already released.

## Verification

- `.devcontainer/scripts/verify.sh` exits 0. 987 tests, 981 pass, 0 fail,
  6 skipped by platform gate.
- `node tools/llm-harness.mjs check`, `golangci-lint`, `shellcheck`,
  `actionlint`, `go vet`, `go test`, and `go test -race` all pass.
- The two acquire manifests keep byte-identical input and output blocks.
- No credential, personal data, or live lock state appears in this record.

## Review rounds, and what each changed

Two independent adversarial reviews, then a verification pass on the fixes.

| Finding | Severity | Disposition |
| --- | --- | --- |
| Only the two acquired paths named the runner wait, and one of them named it `github-runner-wait-ms`, which is not the output name. A timeout summary named neither phase. | should-fix | One `runnerWaitText` helper now names it as `runner-wait-ms` on every acquire outcome summary. The account-blocked path that wrote outputs and no summary got one. The `account-blocked-cleanup-failed` path still writes no summary, so the run-level failure block is the only summary there. |
| Six denial paths published `queue-position` 0 for a caller that had queued, so one name carried three meanings | should-fix | Every site publishes a derived value. A test now pins the superseded path. |
| `queue-position` meant the final poll in the output and the blocking poll in the summary | should-fix | An acquired run reports where it waited. A refused or timed out run reports its last observed poll, and a timed out summary reports the same number. Neither document now promises that every summary echoes the output, because a success that never waited has nothing to report and a refusal summary carries only the runner wait. |
| The success summary named a peer that never withheld the caller, or claimed a wait it had no evidence for | should-fix | The observation is recorded where the caller provably remained queued, and the summary reports it only when one exists. |
| The success summary rendered peer-written values unescaped | should-fix | Routed through the escaping helper the peer timeline already used. A consumer could otherwise inject markdown into another consumer's summary. A stored `runUrl` is escaped too: the state file is not revalidated on read, so it is not trusted. |
| `Date.parse` accepted non-ISO formats and unbounded spans, so a bad record published an impossible measurement | should-fix | Only the RFC 3339 shape is read, offset form included, and a span past a year is rejected. A one-week bound was tried first and rejected: a self-hosted runner can be offline for days. A one-year bound still rejects a corrupt record. |
| The manifest claimed `wait-ms` starts at the step, but the clock starts inside `acquire` after the inputs are read | should-fix | Wording corrected in both manifests, the README, and the runbook. |
| The manifest and README disagreed on `attempts` | should-fix | Both now say poll iterations. `CAS attempts` was already wrong. |
| `wait-ms` unification had no test | should-fix | The timeout fixture now charges the lock-config read a distinctive cost, so `wait-ms` is pinned to the loop bound plus that cost. The pre-change clock reported the loop bound alone. The first attempt at this assertion compared against a value from an unrelated measurement path and had no headroom; it was replaced. |
| Nothing enforced the new documentation | minor | One test, whitespace-folded so it does not depend on line wrapping. |
| The README claimed the summary always reports `runner-wait-ms` | minor | Now scoped to the summaries the action writes, and a test refuses the stronger claim. |
| A dead first `deadline` store | minor | Removed, and the wait budget is now one named `const`. |
| `queuePosition` parameter shadowed the `queuePosition` function | minor | The parameter is gone; one `queuePositionAt` helper decides the value. |
| Repeated issue citations and long sentences | minor | One citation kept where the rule is non-obvious. Sentences shortened. |

## Known limits

- The runner wait needs `github-token` and `runner-id`. Without them
  `runner-wait-ms` stays empty. The manifests and the runbook now say so.
- GitHub records a job's timeline at one-second resolution, so a proven wait
  below one second reports `0`. The manifests say this, so `0` means measured
  and empty means unproven.
- `summaryCell` escapes pipes for a GFM table. The acquire summary is a
  paragraph, where GFM does not process that escape, so a peer reason
  containing a pipe renders a visible backslash. Only the peer timeline builds
  a table, and its rendering is correct.
- A cancelled acquire publishes no outputs and no summary. That is pre-existing
  for every output and deliberate, so it is not changed here.
- #53 stays open. The admission protocol that stops a waiter from occupying a
  self-hosted runner still needs a design and live two-runner load.
