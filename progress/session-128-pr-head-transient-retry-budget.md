# Session 128: paced current-head guard retry budget (issue #349)

Date: 2026-10-24

## Objective and safety invariants

Complete issue #349 without weakening any fail-closed path:

- a transient GitHub 5xx or transport failure is retried across a bounded
  budget instead of three rapid attempts;
- the live head is revalidated on every attempt over the whole budget;
- admission never happens on unknown state or a changed head;
- rate-limit instructions stay honored when they fit and fail closed fast when
  they do not;
- stale-head responses and permanent authorization failures stay non-retryable;
- the original HTTP failure stays prominent when downstream assertions report
  missing acquisition state.

## Live issue and incident triage

`#349` documented the shared `require-current-pr-head` action, pinned at the
then-HEAD `e04369db0`, aborting two Unity jobs of unity-helpers run
40136283525 on `HTTP 503`. The committed runtime and tests already had a
three-attempt loop, so the first reading was that the acceptance criteria were
already met. Two facts disproved that.

Job log evidence, fetched with the GitHub API (job IDs 120998654278 and
120998654259):

- `22:40:15` guard 1 of job 278 succeeded; the same job's guard 2 started at
  `22:40:54.2` and reported `HTTP 503` at `22:40:59.2`.
- Job 259's pre-PlayMode guard started at `22:41:30.7` and reported `HTTP 503`
  at `22:41:34.3`.
- The next guard step in job 259 started at `22:41:34.4` and succeeded at
  `22:41:37.5`, so the 503 window ended inside those three seconds.

Observed facts: both failures spent their whole three-attempt budget in
3.6-4.9 seconds, and the outage window was at least 40 seconds and closer to
80 seconds. Three attempts spaced by 250 and 500 ms exhausted the real retry
budget in the first five seconds of a minute-scale upstream incident, so the
acceptance criterion "recover within a bounded retry budget" was not met in
any operational sense.

## Remaining open issues, prioritized

Ordered by impact per unit of Unity CI churn, as the objective asks.

- **Selected: #349.** Repository-contained runtime defect on the shared
  admission guard; zero Unity churn to fix; directly removes whole-job
  admission aborts on GitHub 503 windows.
- Externally constrained: #83, #51, #44, #255, #113 (authorization, owner
  evidence, consumer rulesets), #29, #334, #347/#345/#346, #278, #277
  (live operational evidence), #223/#53 (Unity portal and runner data),
  #153/#229/#231/#249 (platform canaries and Darwin authority),
  #335 (upstream actionlint support).

## Hypothesis, baseline, and red evidence

Baseline: `MAX_ATTEMPTS = 3`, delays 250/500 ms, one 30-second signal, a
fit-test that threw for an unhonorable `Retry-After`, and a 10-second cap on a
fitting instruction.

Hypothesis: making the loop deadline-paced over a 120-second budget with the
existing retry classification recovers both documented failures; every
weakening-adjacent invariant (fit rule, stale handling, auth refusal, output
order) stays pinned by the existing suite.

Red confirmed before the change by reproducing the incident shape with the
committed runtime: three 503 attempts ended in failures within the five-second
window (the old suite covered the shape, #349's live log covered the outcome).

## Change

1. **Paced budget.** The standalone guard's default budget is now 120 seconds
   (`DEFAULT_RETRY_BUDGET_MS`), used for both the shared timeout signal and
   pacing. Generated backoff is `250 * 2^(attempt-1)` capped at 10 seconds and
   clamped to the remaining budget, so no wait outlives the budget.
   `MAX_ATTEMPTS = 20` is a backstop for injection callers whose sleep never
   advances real time, and it can also end a run early while a fitting
   `Retry-After` shorter than about six seconds keeps repeating; every end of
   the budget names the attempt count and the last failure.
2. **Instruction handling.** The raw `Retry-After` is read once and stays raw
   for the fit decision. A fitting instruction is now honored in full instead
   of the old capped 10 seconds (the shared-client lesson from #200 applies to
   the guard the moment its budget grew past the cap). An unfit instruction
   still fails on the current response with the same two diagnoses.
3. **Diagnostics.** Every retried attempt logs a `::warning::` with its delay
   and attempt number, mirroring the shared client's pre-exhaustion pattern.
   Deadline exhaustion, a budget-killed in-flight request, a budget-killed
   pace wait, and the attempt ceiling produce a named exhausted error with
   the attempt count and last failure (`HTTP 503 (request-id=...)` or the
   transport message), so the original status survives when downstream
   assertions report missing acquisition state. A caller's cancellation keeps
   its own typed reason instead of the generic abort that `timers/promises`
   rejects a paced wait with.
4. **Embedded acquire caller unchanged.** `build-lock.js` now passes
   `timeoutMs: 30_000` explicitly. Acquire revalidates inside its own wait
   loop with caller-visible `wait-ms` accounting, so it keeps the shorter
   budget instead of silently inheriting the action default. Checkpoints
   before other shared admissions already use the shared client's
   deadline-aware budgets.
5. **Docs.** The README's guard paragraph and the `test/action-manifests.test.js`
   contract assertions moved together, so the runtime cannot drift from either.

Rejected alternatives: raising only the attempt count (three calculations
show the budget still ends at 30 seconds of wall time, before the incident
ended), runtime-only pacing without the budget raise (same window miss),
reading `x-ratelimit-reset` in the guard (no observed need; the residual
bounded generic retry on a quota-less 403 stays as documented), and dropping
the attempt ceiling for a pure deadline bound (a frozen injectable clock would
hang the loop).

## Verification

- `node --test test/current-pr-head.test.js`: 38 passed, including ten new
  paced-budget contracts (multi-503 recovery, deadline exhaustion, budget-
  killed in-flight request, budget-killed pace wait, 401 refusal without
  retry, head changed during recovery, attempt-ceiling exhaustion, typed
  cancellation from a paced wait, transport-failure warning, and the
  parser-level instruction pins) and updated pacing/full-honor pins.
- `node --test test/build-lock-0.test.js`: acquire's own 17 contracts stayed
  green with the explicit 30-second embedded budget.
- `bash .devcontainer/scripts/verify.sh`: exit 0 (1022 node tests, 6 expected
  hosted-Windows skips, plus Go, lint, actionlint, shellcheck, workflow
  policy, and credential-literal audits).

Unrelated pre-existing working-tree edits in `.devcontainer/` and
`test/devcontainer.test.js` are left untouched and out of the commit.

## Independent review findings and dispositions

Distinct reviewer agents were used: the implementation ran on the main agent,
the initial adversarial review on an independent sub-agent that found eight
findings, and a follow-up review round re-checks the remediation before
publication. Each round's evidence is recorded here.

Round 1 findings and dispositions:

1. HIGH — a budget kill of the paced wait escaped as a bare `AbortError`
   because `timers/promises` rejects aborts without the signal's reason and
   the conversion only covered fetch kills; roughly three of every four runs
   reaching budget end lost the named diagnosis. **Accepted.** The guard now
   converts wait rejections at both sleep sites: the budget kill becomes the
   named exhausted error, a caller cancellation re-emits the caller's typed
   reason. Two new tests cover the conversions: the budget-kill conversion
   runs on the guard's default wait discipline, and the typed-cancellation
   contract uses an injected wait that mimics the generic timers rejection.
2. HIGH — `MAX_ATTEMPTS = 20` could end the lookup before the budget when a
   fitting instruction under eight seconds repeats, and that ending lost the
   attempt count and last failure. **Accepted.** The ceiling exits now throw
   the named exhausted error with the reason "the attempt ceiling was
   reached", both for a failed response and for a transport failure. The
   header comment and README wording were corrected; a new test pins the
   20-attempt ceiling ending with budget left.
3. MEDIUM — a cancellation landing inside a paced wait loses the caller's
   typed reason behind the generic abort rejection (exposure widened by
   pacing). **Accepted fold-in with finding 1** (same conversion). A new
   guard-level test pins the typed pass-through; acquire's state-based
   `isCancellationError` was already safe.
4. LOW — README and progress said "every wait still leaves room for one more
   attempt"; the boundary case makes no further attempt. **Accepted** as a
   wording fix in both places; the stricter check is deliberate and now
   stated as "no wait outlives the budget".
5. LOW — a caller-supplied `AbortSignal.timeout` would be misreported as the
   guard's own budget. **Accepted:** the discriminator now reads the guard's
   own timeout signal instead of the composite's reason.
6. LOW — the transport-failure warning had no test. **Accepted:** a new test
   pins the warning line, delay, and attempt number.
7. LOW — terminal and ceiling response bodies were undisposed. **Accepted:**
   the non-retryable and ceiling exits now discard the response before
   failing; the 401 test pin moved from zero to one disposal.
8. INFO — the exhaustion test pins exact injectable-clock call sequences;
   deliberate contract-pinning style. **No action.**

Areas confirmed clean by round 1: embedded acquire caller (timing, queue
fairness, wait accounting unchanged), fetch-client census (only the shared
client and the guard use `fetch`), secret handling, output-writing paths, and
the doc/runtime/manifest synchronization.

Round 2 findings and dispositions (independent reviewer, fresh read):

1. HIGH — the first budget-killed-pace-wait test ran on real timers where the
   100 ms wait and the abort expired in the same millisecond, so a second
   attempt could win the race and both pinned assertions lost (measured mixed
   results across runs, including a failing full-verifier run). **Accepted.**
   The flaky real-clock test was removed and the conversion is now pinned
   deterministically: an injected wait that mimics `timers/promises` (generic
   `AbortError` name shape) runs 10 ms inside a 2 ms budget, so the guard's
   own `AbortSignal.timeout` is reliably fired first and the conversion branch
   is tested directly.
2. MEDIUM — the transport-mode attempt-ceiling ending had no test. **Accepted:**
   a new test pins 20 transport attempts, the capped generated-backoff
   sequence, and the named ceiling diagnosis ending.
3. MEDIUM — the caller-supplied-timeout discrimination had no test. **Accepted:**
   a new test proves an `AbortSignal.timeout(20)` caller receives its own
   timeout reason by identity and the outcome is not the guard's exhausted
   error.
4. LOW — the comment said "shorter than eight seconds" for the ceiling
   threshold; the right steady-instruction bound is about six seconds (nineteen
   honored waits must still fit in 120 seconds). **Accepted**, comment fixed.
5. LOW — the deadline diagnosis's "last failure" is the last completed
   attempt's failure, not the budget-killed in-flight request. **Accepted as a
   documented semantic**: a comment states it; the elapsed reason describes the
   killed attempt.
6. LOW — caller-cancel and guard-budget endings in the same instant are
   resolved in the budget's favor. **Accepted as documented**: one comment line
   records the deliberate ordering.
7. INFO — a budget kill during the post-break `response.json()` body read
   still surfaces the raw abort reason. **Rejected for this change**: the case
   needs a success followed by a body read longer than the remaining budget,
   stays fail closed, and writes no outputs; the conversion value does not
   justify touching the success path.
8. INFO — round-1 record wording: the "three of every four runs" fraction was
   reviewer-measured (9 of 12 instrumented runs), and the full-verifier count
   is the current suite size (verified in the fresh run below).

Areas confirmed clean in round 2: attempt counting, no fall-through of a
non-ok response to parsing, output-writing discipline, secrets, acquire embed
and its contracts, README/manifest runtime story, and the round-1 dispositions
for the sleep conversion, wording clamp, timeout discriminator, and body
disposal.

Round-2 verification: `node --test test/*.test.js`: 1028 tests, 1022 passed,
6 expected hosted-Windows skips, 0 failed; the focused trio
`test/current-pr-head.test.js test/build-lock-0.test.js
test/action-manifests.test.js`: 115 tests, 0 failed.

## Round 3 independent review

A third independent agent re-reviewed the round-2-remediated change without
finding any actionable runtime, test, or documentation defect beyond one
documentation-only LOW: this record's own prose (Change section, item 1)
still said "shorter than eight seconds" for the repeating-fitting-instruction
ceiling threshold after round 2 fixed the runtime comment to the right
steady-instruction bound of about six seconds. **Accepted.** The prose now
matches the runtime comment, and the working-tree note above now names the
`test/devcontainer.test.js` opencode-rename edit explicitly
(INFO, accepted). Everything else was confirmed clean: runtime invariants,
test determinism, and the README/manifest anchors.

## Publication and post-merge evidence

Pending the follow-up review round, PR CI, merge, release, and post-merge
`main` verification. Sections will be updated only with observed evidence.
