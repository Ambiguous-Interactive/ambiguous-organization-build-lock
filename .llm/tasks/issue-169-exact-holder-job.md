<!-- summary: Bind stale-state decisions to a recorded numeric Actions job ID instead of runner-clock inference. -->
# Task: Record the exact holder job for stale reaping

## Acceptance criteria

- Acquire records the unique active numeric Actions job ID on the declared
  physical runner when the jobs API proves it.
- Scheduled stale evaluation uses only that ID, run attempt, and runner; it
  never infers a matrix leg from timestamps or names.
- Missing, malformed, ambiguous, inaccessible, or mismatched job evidence
  retains an active workflow-run identity fail closed.
- Exact terminal jobs remain reclaimable while exact active jobs remain held.
- Optional job IDs survive state normalization, stable serialization, legacy
  holder mirroring, CAS reconciliation, and every supported schema.
- Runtime, public manifests, tests, README, and operator guidance agree.

## Baseline and hypothesis

- Incident #169 showed a live playmode holder quarantined after the reaper's
  timestamp window selected the completed editmode predecessor on the same
  runner.
- Hypothesis: recording the unique active job during acquire and requiring its
  exact ID during reaping removes the unsafe cross-clock inference while
  preserving run-level fail-closed compatibility for older state.
- Disconfirming evidence: a completed sibling can still remove the live holder,
  absent job evidence frees active capacity, older state stops parsing, or an
  exact terminal job can no longer be reclaimed.

## Red and green

- Red: loading the committed `HEAD` runtime and evaluating the two-job incident
  fixture reproduced `{ stale: true, reason: "holder job 91204876077 is
  completed" }` for the live playmode holder.
- Green: the selected incident, exact-job, legacy-state, normalization, and
  acquire tests pass with job-ID recording and exact matching.

## Risk and path matrix

- Positive: unique active same-runner job is persisted and evaluated exactly.
- Negative: missing and malformed IDs, wrong runner, wrong ID, and multiple
  active same-runner jobs retain active run state.
- Error: jobs API authorization, absence, malformed responses, pagination, and
  cancellation retain existing fail-closed/error behavior.
- Boundary: numeric IDs reject zero, signs, leading zeroes, and non-digits.
- Concurrency: the ID participates in reaper version comparison; queue order,
  capacity CAS, and cleanup identity remain unchanged.
- Cancellation/recovery: failure to resolve before enqueue stores no guessed ID;
  run-level terminal evidence and lease-governed unavailable-run handling remain.
- Contract: both acquire manifests, committed runtime, state documentation,
  operator guidance, and behavior tests are synchronized.

## Validation and review

- Focused incident, exact-job, legacy-state, normalization, and acquire tests
  pass locally.
- Full validation, adversarial review, and GitHub exact-head evidence are
  recorded in the session progress file before completion.

## Knowledge retention

- Observed fact: separate action and Actions-API clocks selected the wrong
  sequential matrix job; later review also found malformed status and CAS-drop
  boundaries that could make indirect evidence unsafe or non-durable.
- Decision: revise the canonical lifecycle invariant map to require exact
  numeric job identity, recognized status, and CAS persistence, and to prohibit
  clock/name inference. This covers the reusable failure class without storing
  transient incident state.
