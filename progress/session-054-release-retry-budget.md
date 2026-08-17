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
2. **Release bounds the lock-state read and write by wall clock.** `release`
   derives a deadline from the new `release-retry-deadline-seconds` input
   (default 120, maximum 3600, `0` restores the attempt-bounded budget) and
   applies it to the cleanup read/write only. The preparatory state-branch and
   lock-config calls keep the shared attempt budget on purpose, so a long outage
   on those cannot spend the budget that exists to protect the write. This is
   the change that would have absorbed the reported incident.
3. **Discoverable knobs.** `release-retry-deadline-seconds`, `api-max-attempts`
   (1-100), `api-retry-base-ms` (100-60000), and `api-retry-max-ms`
   (1000-300000) are declared release-action inputs. An explicit input wins over
   an inherited environment value, and an out-of-range input fails the action
   rather than silently running a different budget than the caller requested.
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
- `node --test test/*.test.js`: 732 tests, 730 passed, 2 hosted-Windows skips.
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

## Safety review

No fail-closed path was weakened. Both consumer gates continue to refuse a run
whose release did not remove holder ownership; the new code is added to their
diagnostic allowlists only, never to a safe-result set. Acquire keeps its
fail-fast attempt budget, because waiting there holds a runner and delays the
queue before any work has started. Retrying a release longer cannot over-run a
license: the resource is already returned before release runs, and a holder
entry that is never removed is reclaimed by the lock's own lease timeout.

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
60000. It is out of scope here because the fix changes acquire and reap timing.

Continuous-improvement disposition: the retry asymmetry between acquire and
release is now executable in the runtime, its inputs, and the tests, and is
documented in the README. The one durable correction worth recording is that a
stale holder entry is **quarantined**, not lease-expired, so an unrecorded
release is not self-healing; that fact now lives in the README section, the
runtime message, the gate failure text, and a regression assertion, which is
narrower and more authoritative than a new LLM resource would be.
