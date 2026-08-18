# Session 054: time-bounded release retry budget (issue #198)

Date: 2026-08-17

## Objective and invariants

Review every open issue, prioritize by impact while minimizing Unity CI churn,
deliver the highest-priority repository-contained objective, and verify that
merged `main` stays green. Preserve licensed-resource safety, FIFO fairness,
fail-closed admission and cleanup, recoverability, and sanitized operator
evidence.

## Live triage

The repository had 15 open issues and no open or draft pull requests. Priority
order, favoring impact per unit of Unity CI churn:

- **P0 repository-contained (selected):** #198 — the release path's GitHub API
  retry budget is attempt-bounded and exhausts in roughly 15 seconds of a step
  allowed 5 minutes, so a single transient 503 on the final bookkeeping write
  reds a consumer's whole Unity matrix after the licensed resource was already
  returned. Fixable entirely in this repository's action runtime, tests, and
  documentation, with zero Unity CI churn and a confirmed live consumer impact.
- **P0 externally constrained:** #83 (shared entitlement/portal evidence), #113
  (consumer enrollment remediation), #51 (owner-authorized App and org-secret
  scope; organization policy is explicitly out of bounds), #188 (needs a
  distinct GitHub App client-ID secret that only the owner can provision).
- **P1 externally constrained:** #44 (consumer rulesets), #53 (pre-FIFO runner
  admission), #49 (measured compatibility-matrix policy), #60 (re-pinning
  consumers plus live zero-cooldown canaries), #99 (consumer retry/timing
  evidence).
- **P2 operational/platform:** #27, #29, #30, #153 — all require live canaries,
  monitoring, consumer coordination, or new platform cleanup authorities.
- **External dependency:** #94 — blocked on a compatible upstream actionlint
  release.

## Hypothesis

Falsifiable claim: the release path fails not because the lock is in an unknown
state but because a fixed five-attempt budget is spent long before a transient
GitHub outage clears. Making the release budget wall-clock bounded absorbs the
incident without weakening any fail-closed path, because a release only records
an outcome that has already happened.

## Change

1. **Time-bounded retry budget.** `apiRetryOptions` accepts an absolute
   `deadlineAt`. With a deadline, retries continue until the deadline instead of
   stopping after `BUILD_LOCK_API_MAX_ATTEMPTS`; an explicitly configured
   attempt ceiling still wins. The final wait is clamped to the deadline so the
   last attempt starts inside the budget rather than being skipped by a long
   backoff. Callers without a deadline are unchanged. The clamp reuses the
   existing acquire helper, generalized to `boundedRetryDelayMs`.
2. **Release bounds itself by wall clock.** `release` derives a deadline from
   the new `release-retry-deadline-seconds` input (default 120, maximum 3600,
   `0` restores the attempt-bounded budget) and splits it three ways: the
   state-branch check takes the first eighth, the lock-config read the rest of
   the first quarter, and the lock-state read and write the remainder, so no
   phase can starve another.
   Both preparatory calls degrade rather than fail, so neither can red a release
   before the write is attempted. The deadline and `api-max-attempts` are both
   ceilings, whichever binds first, with no per-call attempt floor underneath:
   a bound that each call could re-spend is not a wall-clock bound. This is the
   change that would have absorbed the reported incident.
3. **Discoverable knobs.** `release-retry-deadline-seconds`, `api-max-attempts`
   (1-100), `api-retry-base-ms` (100-60000), and `api-retry-max-ms`
   (1000-300000) are declared release-action inputs. An explicit input wins over
   an inherited environment value. Both channels report and ignore an
   out-of-range value: these knobs only change how long a retry waits, and
   failing a release over a tuning typo would abandon the holder cleanup it
   exists to perform. Minting the App token inherits the budget of the call it
   serves, so a credential outage cannot bypass the deadline or starve the phase
   it runs inside.
4. **An unreachable record is named, not conflated with an unknown lock.** When
   confirmed, non-degraded cleanup evidence cannot be recorded because the
   lock-state file stayed unreachable for the whole budget, release emits
   `cleanup-result=lock-release-unreachable` with `released=false` and the
   confirmed health/reason before failing. The step still fails and both
   consumer gates still refuse the run; they now render the typed code instead
   of `invalid`, so one diagnostic line shows the licensed resource is safe and
   only its record is in doubt. The wording asserts only the invariant that
   always holds and describes the reaper consequence conditionally, because
   GitHub can apply a mutation it never acknowledges. The code is reserved for an
   exhausted API budget; compare-and-swap exhaustion under contention and
   unproven cleanup evidence both keep the raw failure and make no such claim.
5. Retry warnings name the governing bound instead of printing an infinite
   attempt ceiling.

## Verification

- Red first: with the deadline logic disabled, the four new behavior tests fail
  (time-bounded continuation, deadline-named exhaustion, release completing past
  the attempt ceiling, and the `lock-release-unreachable` report); with
  `applyApiRetryInputs` removed, the input-precedence test fails. All pass after
  the change.
- `node --test test/*.test.js`: 756 tests, 754 passed, 2 hosted-Windows skips.
- `bash .devcontainer/scripts/verify.sh`: exit 0 — harness check, Node contract
  and policy tests, all Go tests, module verification, tidy checks, golangci-lint,
  JavaScript analysis, ShellCheck, `go vet`, race validation, and the
  credential-literal audit.

## Independent review findings and dispositions

An independent adversarial review of the first published revision raised four
findings. All four were verified against the code and all four were remediated.

1. **Confirmed defect — a false self-healing claim.** The failure text said the
   abandoned holder entry "is reclaimed by the lock's lease timeout". Under
   schema 4 and later the scheduled reaper converts a stale holder into a
   **quarantine** reservation, which carries no `availableAt` and is never
   removed by `pruneExpiredCooldowns`. The capacity stays consumed until an
   acquire on the same physical runner reclaims it or an operator runs the
   central recovery runbook. The original wording would have told an operator to
   do nothing about a pinned seat. Issue #198's own premise contained the same
   error; correcting it strengthens the case for the fix, because failing to
   record a release is worse than the issue assumed. Corrected in the runtime
   message, the consumer gate failure text, and the README, with a regression
   assertion that the README cannot reintroduce the lease-timeout claim.
2. **Confirmed defect — contention reported as an outage.** Compare-and-swap
   exhaustion was classified as `lock-release-unreachable`. It means the
   opposite: reads and writes succeeded but lost a contention race, possibly
   after an ambiguous accepted write, in which case the synthesized
   `released=false` / empty state SHA outputs would have been wrong.
   `isUnrecordedReleaseError` is now restricted to an exhausted API retry
   budget, and the unused error code introduced for the conflated case was
   removed rather than left as dead contract.
3. **Accepted — an unvalidated public knob.** `api-retry-max-ms: "0"` would have
   produced a zero-delay retry storm for the whole deadline and discarded every
   server-directed `Retry-After` wait, guarded only by a README warning. The
   three retry inputs now carry explicit ranges and fail the action when
   violated, matching every other numeric input in the runtime.
4. **Confirmed defect — a shared budget spent before the call it protects.** The
   deadline originally covered the state-branch check and the lock-config read.
   `readLockConfig` fail-closes to safe defaults on an exhausted budget, so a
   broad outage could silently consume the entire 120 seconds and leave the
   lock-state write with no retries at all — worse than the five-attempt budget
   it replaced. The deadline now covers only the cleanup read and write, proven
   by a test in which the lock-config read exhausts its five attempts and the
   write still gets its full time-bounded budget.

A second independent review of the remediated revision raised two further
findings; both were verified and remediated.

1. **Confirmed defect — an unconditional claim under an ambiguous write.** `api`
   drops its `unknownOutcomeMutationFailure` flag when it raises the exhausted
   error, so a release `PUT` that GitHub applies but never acknowledges reached
   the same code path. The failure text and gate diagnostic asserted a stale
   holder entry that may not exist. Both now state the invariant that always
   holds — the licensed resource was returned and only its record is in doubt —
   and describe the reaper consequence conditionally. A regression assertion
   requires the conditional phrasing. Suppressing the code for ambiguous writes
   was rejected: it would remove the diagnostic from the exact reported incident
   while the operator's next action is identical either way.
2. **Confirmed documentation drift.** Under the 120-second default, retryable
   401s on the release path are bounded by the deadline rather than by
   `BUILD_LOCK_API_MAX_ATTEMPTS`, which the "Transient Auth Failures" section
   still claimed. The behavior is kept — it is consistent with the acquire path's
   existing five-minute auth grace window, and it stays inside the release step's
   own timeout — and the section now states the release exception. The
   `cleanup-result` enumeration earlier in the README was also extended with the
   new value.

A third independent review raised three findings; two were remediated and one
was rejected with reasoning.

1. **Rejected — one deadline shared across the compare-and-swap loop.** The
   review noted the deadline can expire mid-loop and leave later iterations with
   no retries. That is the requested semantics: a wall-clock budget that
   restarted per attempt would not be time-bounded, and ten contention rounds
   cost roughly twenty seconds against a 120-second budget, so the deadline binds
   only when contention coincides with sustained degradation. In that case the
   attempt-bounded budget it replaced would also have failed, just sooner. The
   README now states that the deadline covers the whole cleanup including its
   compare-and-swap retries and does not restart per attempt.
2. **Confirmed defect — the guarded hazard was still reachable.** The zero-backoff
   retry storm the new input ranges prevent was still configurable through the
   `BUILD_LOCK_API_RETRY_BASE_MS` and `BUILD_LOCK_API_RETRY_MAX_MS` environment
   variables, whose minimum was 0. Both channels now carry the same floors, and
   the seven tests that zeroed a production knob for speed were converted to the
   suite's existing `withImmediateTimers` helper, which is the correct tool for
   that job.
3. **Confirmed defect — the change amplified a pre-existing one.** `retryDelayMs`
   truncates a server-directed `Retry-After` to `maxDelayMs` (issue #200), and
   removing the attempt ceiling roughly triples the number of truncated waits on
   the release path, escalating a secondary rate limit on the org-wide lock-repo
   token. A `Retry-After` is now honored in full whenever a deadline bounds the
   total wait, and the deadline still clamps an instruction that would overrun
   it. The attempt-bounded paths keep the cap and remain #200's scope.

A fourth independent review raised two findings; both were remediated.

1. **Confirmed defect — the budget never reached the call it protects.** Round
   three's fix left `ensureStateBranch` attempt-bounded, and unlike
   `readLockConfig` it rethrows instead of degrading to safe defaults. An outage
   broad enough to matter hits it first, so the release would fail after roughly
   fifteen seconds with the deadline unspent — the exact failure the change
   targets. Both earlier deadline tests masked it by always answering the
   state-branch ref with 200. The budget is now split rather than shared: the
   preparatory calls get the first quarter and the lock-state read and write keep
   the remainder, so neither phase can starve the other and both end no later
   than the one configured deadline. A test now drives the state-branch check,
   the lock-config read, and the write past the five-attempt ceiling together.
2. **Confirmed defect — floors without ceilings.** The environment channel gained
   the input minimums but not the maximums, while the README claimed both applied.
   `BUILD_LOCK_API_RETRY_MAX_MS=600000` was silently accepted, letting a single
   retryable 503 sleep ten minutes on an attempt-bounded path.
   `integerEnvironment` now takes a maximum, the three retry knobs read their
   range from one shared definition, and the warning names the range it enforced.

A fifth independent review raised two findings; both were remediated with one
general invariant rather than a special case.

1. **Confirmed defect — a deadline could shorten the budget.** Once the deadline
   had passed, the next call was declared exhausted on its first attempt, so a
   request starting after a spent budget got zero retries where the
   attempt-bounded code guaranteed five. The invariant is now explicit: a
   deadline may only extend the shared budget, never shorten it. Past the
   deadline the ordinary five-attempt budget still applies, and an explicitly
   configured ceiling still wins over both.
2. **Confirmed defect — a preparatory failure could still red the release.** The
   budget split made `ensureStateBranch` fail sooner rather than not at all, and
   unlike the lock-config read it was the one terminal preparatory call. It now
   degrades the same way: an unreachable check warns and continues to the write,
   which owns the rest of the budget and reports the real outcome. A genuinely
   missing branch still surfaces at the write, and no fail-closed decision is
   made from that call.

The review's documentation note was also taken: the README no longer implies the
cleanup's compare-and-swap loop is deadline-bounded. Its ten-round ceiling is
attempt-bounded, so cleanup can finish a round just past the deadline.

A sixth independent review raised two findings, both introduced by the fifth
round's fix, and both remediated.

1. **Confirmed defect — an unbounded wait past the deadline.** The floor branch
   returned its proposed delay unclamped while `retryDelayMs` still honored a
   `Retry-After` in full because a deadline existed, so a spent 120-second budget
   with `Retry-After: 300` could sleep about seventeen minutes and be killed by
   the job timeout, losing the new output entirely. Honoring a server-directed
   wait in full is now conditional on the deadline actually bounding it: floor
   attempts run with the deadline cleared, so they behave exactly like an
   attempt-bounded budget, backoff cap included.
2. **Confirmed defect — a documented invariant the code did not hold.** The floor
   compared against the constant default rather than the effective ceiling, so a
   configured `api-max-attempts: 20` was cut short by the deadline while the
   comment, the README, and the input documentation all promised a deadline only
   ever extends. The semantics are now stated the way two ceilings actually
   behave: the deadline and `api-max-attempts` both bind, whichever comes first,
   and the floor guarantees only the shared five-attempt default without ever
   raising a ceiling the caller set above it. A test pins the above-floor case
   the earlier test could not reach.

A seventh independent review raised two findings, both reproduced against the
committed runtime, and both remediated.

1. **Confirmed defect — the last zero-delay channel.** `retryAfterMs` returns 0
   for `Retry-After: 0` and for an already-past HTTP date. Honoring that
   literally under a deadline produced an unthrottled retry loop for the whole
   budget, measured at roughly 80,000 requests per release step at the default
   deadline. A server-directed wait may now lengthen the backoff but never
   shorten it below the configured base, which closes the hazard for both
   budgets and for every channel that can set one.
2. **Confirmed defect — a degraded branch check could become a false success.**
   Tolerating an unreachable state-branch check also tolerated a failed branch
   *creation*, after which every content read 404s, normalizes to empty state,
   and reports `cleanup-result=noop` with exit 0 — a release that never happened.
   The Unity gate would still have refused the run, but the action's own contract
   was fail-open. An empty state SHA with the branch unverified is now refused
   under the same `lock-release-unreachable` code instead of being reported as
   "nothing to release", and the inline comment's false claim that a missing
   branch surfaces at the write was removed.

An eighth independent review raised three findings, none blocking the happy path.
Two were remediated and one was deferred with a filed issue.

1. **Deferred to issue #201 — App token minting has its own uncapped-by-callers
   budget.** `jwtApi` is hard-capped at three attempts, and `api()` short-circuits
   on the exhaustion code that `getToken` raises, so a broad outage fails a
   release in about three seconds with the whole deadline unspent. It is the same
   failure mode as #198, but the fix changes `api()`'s error handling for acquire
   and reap as well, and it touches the ambiguous-mutation bookkeeping that guards
   against double-writes. That is a separate, riskier change than this one, so it
   is filed with the exact distinguishing signal (`error.path`), the
   ambiguous-write hazard, and its acceptance evidence.
2. **Documented, then disproved and fixed in round nine.** This round's overrun
   finding was answered by arguing the control flow bounded it to about one
   attempt budget. That analysis only considered `cleanupIdentity` and was wrong;
   see finding 1 of the ninth review below.
3. **Confirmed defect — an inherited attempt ceiling silently voided the
   deadline.** A job-level or organization `BUILD_LOCK_API_MAX_ATTEMPTS` caps the
   deadline exactly as a value set on the step does, but an inherited value never
   appears in the log. Release now warns once, naming the value and the deadline
   it caps, and the README says so.

A ninth independent review raised two findings, both verified against the
committed runtime with a virtual clock, and both remediated.

1. **Confirmed defect — the per-call floor multiplied the budget.** The floor
   added in round five granted a fresh attempt budget to *every* API call once the
   deadline was spent. The preparation phase alone makes several calls, so at a
   30-second deadline preparation finished at 33.8 seconds — past the entire
   cleanup deadline — and the step ended at 51.9 seconds; at 10 seconds it ended
   at 51.7, five times the configured budget. The eighth round's contrary analysis
   considered only `cleanupIdentity` and missed the preparation phase.
   The floor is removed rather than patched: it was the mechanism behind three
   consecutive findings, and a wall-clock budget whose bound can be multiplied by
   the number of calls is not a wall-clock budget. The guarantee that a caller
   actually depends on holds at the operation level without it — a release with
   the default deadline gets roughly eight times the total retry time of the
   five-attempt budget it replaces — while an individual call that starts with the
   budget already spent now gets a single attempt, which is what a spent budget
   should mean. Removing it also retires the round-six hazard of an unbounded wait
   on the floor branch.
2. **Confirmed defect — a warning for a value that was ignored.** The
   inherited-ceiling notice fired on any non-empty
   `BUILD_LOCK_API_MAX_ATTEMPTS`, including out-of-range values the retry budget
   rejects, so it announced a bound that did not exist. It now reports only a
   ceiling that will take effect, and its wording no longer tells an operator to
   clear an environment variable they may never have set.

A tenth independent review raised three findings; all three were remediated.

1. **Confirmed defect — a tuning typo abandoned the cleanup.** An out-of-range
   value for one of the pure-tuning inputs threw from `config()`, so the release
   never ran: no holder cleanup attempted, no outputs written, and a licensed seat
   pinned until the reaper quarantines it. Invalid *safety evidence* already
   degrades rather than aborts, so a typo in a backoff knob was punished harder
   than bad cleanup evidence. All four tuning inputs, including
   `release-retry-deadline-seconds`, now report and ignore an out-of-range value
   through one shared resolver, matching the environment channel. The first
   review's objection that ignoring is "silent" is answered by the warning, which
   names the rejected value and the range.
2. **Confirmed defect — the backoff floor could escape its cap.** The
   `Retry-After` floor was applied after the cap, and nothing requires
   `api-retry-base-ms <= api-retry-max-ms`. With base 60000 and max 1000 an
   attempt-bounded wait returned sixty times the configured ceiling. The cap is
   now outermost, so it bounds the floor whatever the two are set to.
3. **Confirmed defect — this record contradicted itself.** The safety review still
   asserted the lease-timeout reclaim that finding 1 of the first review
   disproves. A test guards the README against that phrasing; nothing guarded the
   audit record, so it was corrected by hand and swept for elsewhere.

The review also noted that issue #201 leaves the headline guarantee weaker than
the README implies, because a broad outage that reaches App token minting bypasses
the deadline in about three seconds. That is recorded in #201 and remains the
right scope boundary for this change.

An eleventh independent review raised three findings; all three were remediated,
including the one previously deferred.

1. **Fixed here after all — the deadline now covers token minting.** Two reviews
   in a row identified App token minting as the dominant real-world way the new
   budget is bypassed, since every release mints before its first call and the
   minting budget is a fixed three attempts. The deferral in issue #201 assumed
   the only fix was to change `api()`'s nested-exhaustion handling for every mode,
   which would have touched the ambiguous-mutation bookkeeping. A narrower one
   exists: anchor the release deadline once when the action reads its inputs and
   hand the same absolute deadline to the credential provider, which then governs
   minting instead of the fixed inner budget. Acquire and reap pass no deadline
   and are untouched, and `api()`'s error handling is unchanged. Issue #201 stays
   open for the general case.
2. **Confirmed defect — our own floor escaped the backoff cap.** Lifting the cap
   under a deadline was meant to let the *server's* number through, but it also
   let the `Retry-After` floor through, so `api-retry-base-ms: 60000` with
   `api-retry-max-ms: 1000` waited sixty seconds. The floor is now capped like any
   other backoff the action generates; only the server's number may exceed it, and
   only while a deadline bounds it.
3. **Confirmed defect — primary rate limits were retried blind.** A primary limit
   sends `x-ratelimit-reset` and no `Retry-After`, so the exponential path capped
   at ten seconds and the time-bounded budget spent its whole deadline on requests
   that could not succeed until the hourly window reopened — about thirteen
   requests per release where the old budget made five, multiplied across a
   matrix. The reset is now read as a server-directed wait, so a window that
   reopens after the budget ends is waited on once and then abandoned.

A twelfth independent review raised two findings, both caused by the eleventh
round's fix, and both remediated.

1. **Confirmed defect — the previous fix broke every real release.** Handing the
   credential provider a deadline made `jwtApi` resolve its attempt ceiling to
   `undefined`, which the spread then propagated into the retry options, so the
   loop `attempt <= undefined` never entered and every minting call threw after
   zero requests with an uncoded error the unrecorded-release path does not
   recognise. Since App credentials are mandatory in production, that would have
   failed every release with no cleanup at all. The whole test suite passed
   because every existing release test passes a plain string token; that coverage
   gap is now closed by a release test that uses a real App credential provider
   and was confirmed red against the defect.
2. **Confirmed defect — minting was bounded by the wrong phase.** The credential
   held the full budget while running inside preparatory calls that own only a
   quarter of it, so a degraded token endpoint could spend the entire deadline
   before the lock-state read and write began — the starvation the split budget
   exists to prevent.

Both are fixed by the same change of approach: minting is no longer given a
deadline of its own at configuration time. `api()` hands the credential provider
the budget of the call being made, so minting inherits exactly the phase it serves
and nothing more. `apiRetryOptions` now also ignores undefined-valued overrides,
so an option built conditionally can never again clobber a computed bound and
leave the retry loop with none.

A thirteenth independent review raised two findings; both were remediated.

1. **Confirmed defect — a starved lock-config read silently changed release
   behavior.** The preparation slice was one shared deadline consumed
   sequentially, so `ensureStateBranch` could spend all of it and leave
   `readLockConfig` a single attempt. That read fails closed to *default* lock
   configuration, and the live config sets `releaseCooldownSeconds: 1` against a
   default of 360 — so during exactly the outage this feature exists to survive, a
   freed licensed seat would have been parked in a six-minute cooldown. Every
   phase now holds its own absolute deadline: the state-branch check takes the
   first eighth, the lock-config read the rest of the first quarter, and the
   lock-state read and write the remainder. A phase that finishes early still
   hands its remainder forward.
2. **Confirmed defect — the share inverted at small deadlines.** Rounding the
   preparation share up in whole seconds gave preparation the entire budget for
   any `release-retry-deadline-seconds` of four or less, all legal inputs, leaving
   the write the feature protects with nothing. The arithmetic is now in
   milliseconds and clamped strictly inside the total.

The shares are wall-clock arithmetic that no mocked-timer test can observe, which
is why the earlier split-budget test missed both. A data-driven test now asserts
the invariant directly across the legal range. The review's cosmetic note about a
duplicated warning was taken as well: the ceiling check no longer re-reports a
rejection the retry budget already reports.

A fourteenth independent review raised three findings; two were remediated and
one was declined on the facts.

1. **Confirmed defect — a scope violation.** The primary rate-limit reset was read
   on every path, not only the deadline-bearing one, so a 403 with a far reset
   pinned each acquire wait to the backoff cap instead of exponential growth: 40
   seconds per call against 17 on `main`. This change is meant to leave admission
   and reaping timing alone. The reset is now read only when a deadline is
   present, matching how the `Retry-After` uncapping is already gated.
2. **Confirmed defect — a self-contradicting log.** The ceiling notice trimmed its
   value before validating while the retry budget does not, so
   `BUILD_LOCK_API_MAX_ATTEMPTS=" 3"` announced a ceiling of 3 in the same log
   that rejected it four times, while actually running with no ceiling. The notice
   now validates exactly as the budget does, whitespace included.
3. **Declined — the reconciliation handle is not lost.** The review reported that
   an ambiguous accepted write followed by budget exhaustion drops the reservation
   ID an operator needs. The reservation outputs are indeed empty there, correctly,
   because no reservation was confirmed. But every reservation carries the holder
   identity that produced it, and `holder-id` is always written, so the handle is
   present. Carrying the unconfirmed identity out on the error would have meant
   re-indenting the whole compare-and-swap loop for a compound scenario whose
   answer is already in the outputs. The README now states where to look.

## Safety review

No fail-closed path was weakened. Both consumer gates continue to refuse a run
whose release did not remove holder ownership; the new code is added to their
diagnostic allowlists only, never to a safe-result set. Acquire keeps its
fail-fast attempt budget, because waiting there holds a runner and delays the
queue before any work has started. Retrying a release longer cannot over-run a
license: the resource is already returned before release runs, and a holder entry
that is never removed is quarantined by the scheduled reaper, which holds
capacity rather than releasing it. That is the cost this change exists to avoid,
not a safety hole — see finding 1 of the first review below.

## Out of scope

Acquire-failure cleanup and post-action cleanup keep their attempt-bounded
budgets. Both are bounded by their own signals and are covered by the scheduled
reaper when they fail, so neither carries the "work finished, only the record is
missing" asymmetry that motivates the release deadline. No organization policy,
credential, consumer workflow, runner capacity, or live lock state was changed.

A separate pre-existing defect found while reviewing this code was filed as
issue #200: `retryDelayMs` clamps a server-directed `Retry-After` to
`maxDelayMs`, so a 30- or 60-second rate-limit instruction is truncated to 10
seconds and the action retries back into the same secondary rate limit. The
runner-preflight runtime already works around it by widening `maxDelayMs` to
60000. This change fixes it for the deadline-bearing release path, because
leaving it would have amplified the harm there; the attempt-bounded acquire and
reap paths remain #200's scope, since fixing them changes admission timing.

A second follow-up, issue #201, records that App token minting runs on its own
three-attempt budget whose exhaustion short-circuits the caller's budget. The
release path no longer suffers from it — the eleventh review's finding 1 closed
that case by handing the credential provider the same anchored deadline — but
acquire and reap still do, and the general fix to `api()`'s nested-exhaustion
handling remains #201's scope.

Continuous-improvement disposition: the retry asymmetry between acquire and
release is now executable in the runtime, its inputs, and the tests, and is
documented in the README. The one durable correction worth recording is that a
stale holder entry is **quarantined**, not lease-expired, so an unrecorded
release is not self-healing; that fact now lives in the README section, the
runtime message, the gate failure text, and a regression assertion, which is
narrower and more authoritative than a new LLM resource would be.
