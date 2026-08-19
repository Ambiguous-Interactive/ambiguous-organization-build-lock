# Session 055: shared server-directed retry contract (issues #200, #201)

Date: 2026-08-19

## Objective and invariants

Fully address consumer issue
[unity-helpers#483](https://github.com/Ambiguous-Interactive/unity-helpers/issues/483)
— "a GitHub 503 on the build-lock release reds the whole Unity matrix after every
leg has passed". Preserve licensed-resource safety, FIFO fairness, fail-closed
admission and cleanup, recoverability, and sanitized operator evidence.

## Live triage

`#483`'s own closing comment states the remaining work precisely:

1. The wall-clock release budget that answers the incident merged upstream as
   `954d123f` (issue #198, PR #199) but **is not in any release**: `v1.12.0` was
   published 2026-08-10 and `main` is two commits ahead of it.
2. Two upstream bugs survive that fix and can reproduce the same red:
   - **#200** — a `Retry-After` longer than 10 s is truncated to the backoff cap,
     so the lock retries *into* the throttle rather than after it.
   - **#201** — App token minting runs on its own three-attempt budget that no
     caller's budget can extend, and its exhaustion short-circuits the caller.

A wall-clock budget does not help if the sleep between attempts is wrong (#200)
or if the failure is in a nested budget the caller cannot reach (#201). Both are
repository-contained, carry zero Unity CI churn, and are prerequisites for
closing #483 rather than follow-ups to it, so both are in this change.

## Hypothesis

Falsifiable claims, each with a red test before the fix:

1. A `Retry-After: 45` on an attempt-bounded path waits 10 s, not 45 s, so the
   action retries inside the window GitHub asked it to wait.
2. A minting outage that outlasts the inner three-attempt budget ends the
   caller's call on its first attempt, whatever budget the caller configured.

Both reproduced against the committed runtime; see *Verification*.

## Change

1. **`Retry-After` has its own ceiling.** `retryAfterMaxMs` (60 s) bounds a
   server-directed wait; `maxDelayMs` now bounds only backoff the action
   generates itself. The instruction may lengthen a wait, never shorten it below
   the configured base, and that floor stays capped by `maxDelayMs` and is never
   cut short by the instruction's ceiling. A deadline still lifts the ceiling
   entirely, because it already bounds the total wait. This applies on every
   action and every path, which also retires the runner preflight's
   `maxDelayMs: 60000` as a `Retry-After` workaround: the value stays, now
   bounding only that preflight's own exponential growth.

   The primary rate-limit reset (`x-ratelimit-reset`) stays read only by a
   deadline-bearing caller. It is inferred rather than instructed, and an hourly
   window cannot reopen inside any attempt-bounded budget, so waiting on it in
   acquire or reap would hold a runner through minutes of retries that still
   cannot succeed.

2. **A nested credential exhaustion is a failed attempt, not a failed call.**
   `api()` tags an exhausted budget raised by the credential provider and treats
   it as a retryable failure of the current attempt: the caller's own budget —
   attempt-bounded or time-bounded — decides whether to try again, and the next
   attempt re-mints. Three properties are pinned by tests:
   - the request never left the client, so `unknownOutcomeMutationFailure` is not
     set and a later 409/422 is never reported as a write GitHub may have accepted;
   - the exhausted-budget error names the credential cause
     (`credential unavailable: ...`) rather than the last resource status, and
     keeps the minting status, so acquire's 401 auth-grace window still applies;
   - the caller's *own* exhaustion still short-circuits exactly as before.

   When the operation is already cancelled or past its deadline the nested error
   is rethrown unchanged, because there is nothing left to retry and it carries
   the richest diagnosis of why minting failed.

   `jwtApi`'s three-attempt inner budget is kept: it is a fast inner loop for a
   healthy run, and it is no longer the effective ceiling for the operation.

3. **Documentation.** A new `Server-Directed Retry Waits` section states the
   contract once for all actions instead of only for the runner preflight, and
   the release section points at it rather than restating a deadline-only rule.

## Verification

- Red first: `an attempt-bounded budget honors the instruction, not the backoff
  cap`, `an instruction beyond the Retry-After ceiling is capped there`, `an
  attempt-bounded caller retries past the inner minting budget`, `a time-bounded
  caller keeps minting until its deadline`, and `a minting failure never makes a
  later conflict look like an accepted write` all fail against the committed
  runtime and pass after the change.
- Measured against the built runtime with a virtual clock, one `PUT` answered
  `503` forever (requests made / total time spent waiting):

  | Budget | No `Retry-After` | `Retry-After: 45` | `Retry-After: 600` |
  | --- | --- | --- | --- |
  | Attempt-bounded (default 5) | 5 / 17.5 s | 5 / 180 s | 5 / 240 s |
  | Release deadline 120 s | 16 / 120 s | 4 / 120 s | 2 / 120 s |

  The first cell is the ~15-second window `unity-helpers#483` reports. The
  `Retry-After: 45` column is the change: the same five requests now land after
  the window GitHub asked for instead of inside it. The `600` column is the
  60-second instruction ceiling, and its 240 seconds is the worst-case
  attempt-bounded overrun stated in the README. Under a deadline the total is
  the deadline exactly, and an instruction makes the budget *cheaper* for the
  limiter -- four requests instead of sixteen for the same 120 seconds.
- `node --test test/*.test.js`: 774 tests, 772 passed, 2 hosted-Windows skips.
- `bash .devcontainer/scripts/verify.sh`: exit 0.

## Independent review findings and dispositions

1. **Confirmed defect, found by the existing suite — a lost diagnosis.** Placing
   the credential branch after the abort check made a minting failure that
   coincided with an elapsed deadline report "no response was received before the
   deadline", discarding the 502 and its request ID that the nested error carried.
   `terminal runner preflight preserves classified API diagnostics safely` caught
   it. An aborted operation now rethrows the nested error unchanged, and a local
   regression test pins that at the `api()` layer rather than only through the
   preflight.

2. **Accepted, bounded and documented — an attempt-bounded path has no clamp on
   its own waits.** Honoring an instruction up to 60 s can carry a single call
   past the operation's window by up to one attempt budget of waiting, about four
   minutes at the shared five-attempt default, where the old cap allowed forty
   seconds. The windows this could overrun are orders of magnitude larger (the
   acquire wait is measured in hours), the loop re-checks its deadline as soon as
   the call returns, and retrying inside the window GitHub asked us to wait cannot
   succeed anyway. Release is unaffected: its phases carry abort signals. Stated
   in the README rather than left implicit.

3. **Confirmed defect, same class, pre-existing — a credential failure was
   reported as a possibly-accepted write.** `#201` warns that a nested minting
   failure must not set `unknownOutcomeMutationFailure`, because the request never
   left the client. The exhausted-budget case was handled, but a credential error
   that is *not* an exhausted budget — `mintToken` raising "installation token
   response was missing a valid token or expiry", for instance — fell through to
   the transport-error branch, which set the flag unconditionally. A later 409 or
   422 on the same `PUT` was then reported as a write GitHub may have applied,
   which is the exact misreading that guard exists to prevent. The credential
   provider's error is now tracked by identity for the current attempt, and the
   transport branch marks a mutation ambiguous only for a request that actually
   left the client. Identity rather than a flag on the error, because concurrent
   callers can share one rejected token refresh.

4. **Confirmed hazard — a caller that wants no waiting would have inherited a
   60-second ceiling.** Acquire's cancellation cleanup has 1.5-5 seconds in total
   and sets `baseDelayMs: 0, maxDelayMs: 0` to express that. It is protected today
   only by `maxAttempts: 1`, which is not where that intent belongs. It now sets
   `retryAfterMaxMs: 0` explicitly, and a test proves a caller asking for no
   waiting is not given the shared ceiling.

## Safety review

No fail-closed path was weakened. Both changes only lengthen how long a transient
failure is retried; neither changes what any action claims about licensed
cleanup, admission, or reservation state. The one new claim — that a minting
failure leaves the mutation outcome known — is the conservative direction and is
proven by a test: the request never reached GitHub, so treating a later conflict
as possibly-accepted would have been the unsafe reading.

## Out of scope

`retryAfterMaxMs` is an internal option, not a new public input or environment
knob. The three existing retry knobs exist because a consumer needed to widen a
budget; nothing yet needs to tune the instruction ceiling, and adding a fourth
public knob would widen the enrollment-policy allowlist and the release manifest
for no demonstrated need.

## Continuous-improvement disposition

Both contracts are now executable in the runtime and pinned by tests, and stated
once for every action in the README's `Server-Directed Retry Waits` section and
the `Transient Auth Failures` section, with regression assertions that the README
cannot drop either claim. No new `.llm` resource is warranted: the durable
lesson -- "a bound the caller cannot reach is not the caller's bound, and a
failure that never left the client is not an ambiguous write" -- is narrower and
more authoritative where it now lives, next to the code it governs, than it
would be as a general skill.

## Follow-up filed

`#203` -- the PR-head guard truncates a `Retry-After` it cannot honor within its
30-second budget and spends two more requests against the limiter before failing
closed, rather than failing closed on the first response with a rate-limit
diagnosis. Related class, different guard, and it changes a fail-closed runtime's
request pattern, so it is deliberately not in this change.
