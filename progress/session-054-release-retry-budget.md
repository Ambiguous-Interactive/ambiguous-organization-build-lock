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
2. **Release uses one wall-clock budget.** `release` derives a single deadline
   from the new `release-retry-deadline-seconds` input (default 120, maximum
   3600, `0` restores the attempt-bounded budget) and shares it across the
   state-branch check, the lock-config read, and the cleanup read/write. This
   is the change that would have absorbed the reported incident.
3. **Discoverable knobs.** `release-retry-deadline-seconds`, `api-max-attempts`,
   `api-retry-base-ms`, and `api-retry-max-ms` are declared release-action
   inputs. An explicit input wins over an inherited environment value; an
   invalid value keeps its existing warn-and-ignore behavior.
4. **An unreachable record is named, not conflated with an unknown lock.** When
   confirmed, non-degraded cleanup evidence cannot be recorded because the
   lock-state file stayed unreachable for the whole budget, release emits
   `cleanup-result=lock-release-unreachable` with `released=false` and the
   confirmed health/reason before failing. The step still fails and both
   consumer gates still refuse the run; they now render the typed code instead
   of `invalid`, so one diagnostic line shows the licensed resource is safe and
   only the bookkeeping is missing. Unproven cleanup evidence keeps the raw
   failure and makes no such claim.
5. Retry warnings name the governing bound instead of printing an infinite
   attempt ceiling.

## Verification

- Red first: with the deadline logic disabled, the four new behavior tests fail
  (time-bounded continuation, deadline-named exhaustion, release completing past
  the attempt ceiling, and the `lock-release-unreachable` report); with
  `applyApiRetryInputs` removed, the input-precedence test fails. All pass after
  the change.
- `node --test test/*.test.js`: 723 tests, 721 passed, 2 hosted-Windows skips.
- `bash .devcontainer/scripts/verify.sh`: exit 0 — harness check, Node contract
  and policy tests, all Go tests, module verification, tidy checks, golangci-lint,
  JavaScript analysis, ShellCheck, `go vet`, race validation, and the
  credential-literal audit.

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

Continuous-improvement disposition: the retry asymmetry between acquire and
release is now executable in the runtime, its inputs, and the tests, and is
documented in the README. No new durable LLM guidance is warranted.
