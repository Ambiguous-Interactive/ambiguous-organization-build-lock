# Session 013: the preflight asked whether a runner was connected, not whether one exists

Date: 2026-07-26

## The defect

`check-unity-runner-availability` fails a required label set when no runner
matching it has `status == "online"` at the instant the action runs. That is not
the question the preflight exists to answer.

The preflight exists because a licensed job whose labels nothing can satisfy
queues until GitHub cancels it, and the consumer's always-reporting aggregate
never resolves. The condition that produces that outcome is "no runner with
these labels is REGISTERED in a group this repository can see" — a typo in a
label, a runner removed from the organization, a group that stopped being
visible. A registered runner that is momentarily disconnected produces the
opposite outcome: GitHub holds the job in the queue and dispatches it when the
runner reconnects.

The action already accepts that reasoning for one half of the state space. A
busy runner reports `status == "online"`, `busy == true`, and the README says
so explicitly: "A busy online runner is considered available infrastructure and
may queue the licensed job." `busy` is never read. The offline case is the same
argument with the same conclusion, and it was rejected instead.

## Measured consumer impact

`Ambiguous-Interactive/DoxReloaded` run `30180911045`, a push to `main` at
2026-07-26T00:17:33Z. Both preflights failed at 00:18:18Z with
`No accessible online organization runner matches required label set(s)`, one
for `[self-hosted, linux]` and one for `[self-hosted, windows, ram-64gb]` — four
machines across two operating systems, simultaneously. The inventory read itself
succeeded: the classified `RUNNER_INVENTORY_API_UNAVAILABLE` warning is absent
from the log, and so is the "no runner groups visible" error, so the runners were
read and simply were not connected.

That repository's own job history bounds the outage. The last self-hosted job
before the failure ended at 2026-07-25T23:19:19Z and the next began at
2026-07-26T02:01:26Z, on the same four runner names, with no failure in between.
The fleet came back on its own 1h43m after the push. Without the preflight the
run would have queued and gone green.

Surveying every failed `Build and Deploy` run in that repository back to
2025-08-22 (266 runs) finds ten preflight failures in five runs, and not one of
them was an unserviceable label set:

| Date | Cause | Class |
| --- | --- | --- |
| 2026-07-19, 2026-07-20 (×3) | `Missing required input: reader-app-id` | Dependabot has no access to the reader-App secrets |
| 2026-07-20T00:13 | `HTTP 503`/`504` on the runner-group read | GitHub API incident; hardened by #78 after this occurrence |
| 2026-07-26T00:18 | Fleet offline for 1h43m | This defect |

The check has produced a false failure five times and a true failure zero times.

## The change

`matchingRegisteredRunners` matches on labels alone. `execute` fails when a
label set has no REGISTERED match and does not inspect connection or busy state.
The public output is `registered-runner-count`; `matched-runners` carries only
the registered names for each label set. Connection state is GitHub's queueing
concern, not an enrollment preflight result.

Every fail-closed path is intact. An unreadable inventory, a repository with no
visible runner group, a malformed inventory page, and an unparsable label set all
fail exactly as before, and the API-unavailability classification is untouched.
The change is monotone: every state that passed before still passes, so no
enrolled consumer can acquire a new failure from this release.

## Red-green evidence

`node --test test/runner-availability.test.js` — 12/12 pass on the change.
Against the shipped `.github/dist/check-unity-runners.js` restored under the new
tests, exactly the three intended tests fail (9 pass / 3 fail):

- `runner matching requires every label and ignores connection status` —
  assertions cover both connected and disconnected registered infrastructure.
- `runtime requests only organization runner read permission and rejects an
  empty match` — the terminal message now names registration.
- `a registered label set passes without inspecting connection status` — the
  end-to-end case supplies one offline `box-linux`, `execute()` resolves,
  `registered-runner-count=1` is written, and no availability warning is
  emitted.

`node --test test/*.test.js` is 448 tests / 433 pass / 9 fail; `main` at
`ea8b1147e` is 447 / 432 / **the same 9**. All nine are `go`-dependent
(`spawnSync go ENOENT`) and `go` is not installed in this container; the delta is
the one added test.

## Recorded, not fixed

- `docs/operations-facts.json` still records `publishedRelease` as `v1.8.3`
  while `v1.9.1` is tagged. It was already stale before this change and the
  documentation-policy test only requires the file and the runbook to agree, so
  reconciling it is a separate change.
- Dependabot pull requests still fail the preflight on the missing reader-App
  secret. That is a credential-scope question, tracked by the consumer as
  `Ambiguous-Interactive/DoxReloaded#161`, and this change does not touch it.
