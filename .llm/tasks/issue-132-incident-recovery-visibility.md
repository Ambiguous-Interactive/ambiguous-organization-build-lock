<!-- summary: Task record for publishing active build-lock incident recovery evidence without weakening exact-ID proof. -->
# Task: Publish active incident recovery evidence automatically

## Acceptance criteria

- An active schema-5 global account incident becomes operator-visible without
  reading the `lock-state` branch by hand.
- One deduplicated alert carries the exact incident identifier and the inputs
  the declared recovery workflow accepts.
- Unprovable lock state never opens, edits, or closes that alert.
- The monitor holds no writer, reader, or Unity credential and never writes
  lock state.
- Recovery still requires the exact incident identifier plus explicit portal
  cleanup proof.
- No consumer re-pin and therefore no licensed Unity CI run is required.

## Baseline

- Command: `node --test test/workflow-policy.test.js
  test/documentation-policy.test.js` and `go test ./...`
- Observed result: all checks passed while the only path to an active incident
  identifier was manually reading committed lock state.
- Reproduction status: demonstrated from the state contract. A schema-5
  incident never expires, blocks all admission, and is cleared only by an
  operator dispatch that requires the exact identifier.

## Hypothesis

- Claim: a scheduled read-only monitor can prove an incident from committed
  state and publish its identifier plus declared recovery inputs in one
  deduplicated issue, removing the manual lookup without weakening any
  fail-closed path.
- Disconfirming evidence: a published alert that lets recovery proceed without
  the exact identifier or portal proof; an alert whose instructions the
  recovery workflow cannot accept; ambiguity that silently closes an alert;
  credential or evidence-digest exposure; or a required consumer re-pin.
- Falsified hypotheses: latching the alert from the acquire path would need
  issue-write scope in every consumer and a full re-pin, so it was rejected in
  favor of the central schedule.

## Red

- Test: `go test ./cmd/lock-recovery-audit`.
- Expected failure: the monitor package does not exist.
- Observed failure: build failure with undefined `incident`,
  `incidentReason`, `reasonHealthy`, `reasonIncidentActive`, and
  `reasonStateInvalid`.

## Risk and path matrix

- Positive: an active, internally consistent incident opens the alert; an
  unchanged incident is republished as a byte-identical body and is not
  rewritten; a recovered lock closes the alert.
- Negative: healthy state with no alert writes nothing; healthy state leaves a
  closed alert untouched.
- Error: unavailable, missing, oversized, malformed, trailing, unsupported
  schema, unknown-field, tampered-digest, foreign-author, and duplicate
  evidence all fail red without touching the alert.
- Boundary/extreme: one-MiB bounded reads, ten-page bounded issue discovery,
  200-byte provenance fields, 20-digit run identifiers, and canonical run URLs
  bound to the configured server origin.
- Concurrency/ordering: a stable concurrency group with cancellation disabled
  keeps a scheduled audit from replacing pending recovery.
- Cancellation/recovery: the audit never writes lock state and never changes
  what recovery demands.
- Determinism/isolation: `httptest` fixtures, injected configuration, no
  sleeps, no credentials, no Unity, and no runner use. The alert body contains
  no wall-clock value, so equality is a stable no-write signal.
- Contract synchronization: workflow, monitor source, workflow policy tests,
  documentation policy tests, operations facts, README, lock docs, runbook,
  task record, and progress log.

## Green

- Minimal change: one standard-library Go monitor, one least-privilege
  scheduled workflow, focused behavioral and contract tests, and synchronized
  operational facts and guidance.
- Focused result: `go test ./cmd/lock-recovery-audit` and the adjacent
  workflow/documentation policy suites pass.

## Full validation

- Commands and exact outcomes: recorded in
  `progress/session-029-incident-recovery-visibility.md`.

## Adversarial review

- Unsafe success paths considered: an alert that appears authoritative while
  the underlying state is unreadable; an untrusted user pre-creating the marker
  issue; hand-edited state producing an identifier recovery would reject;
  Markdown injection through workflow, job, or runner names; digest parity
  drift between the Go monitor and the committed JavaScript runtime; and
  repeated writes churning the operator's record.
- Intent-to-diff status: recorded in the progress log.
- Unverifiable items and open questions: whether a 20111 incident is ever
  raised without a real leaked seat. Seat probing and auto-recovery need
  licensed evidence and remain out of scope.
- Remaining uncertainty: GitHub schedule delivery stays best effort, so the
  alert improves detection without creating a bounded SLO.
- Implementer: root agent.
- Reviewer and evidence: recorded in the progress log.
- Actionable findings: recorded in the progress log.
- Remediator and dispositions: recorded in the progress log.
- Latest review round outcome: recorded in the progress log.

## Knowledge retention

- Trigger or exemption: substantial operations and workflow safety change.
- Evidence: red build failure, focused suites, complete verification, and the
  review rounds recorded in the progress log.
- Observed facts, inferences, and open questions: a never-expiring fail-closed
  state needs an automatic publication path, because the proof it demands can
  only be supplied by an operator who first has to find it.
- Root cause or reusable insight: publishing recovery evidence is separable
  from authorizing recovery. A read-only publisher can remove operator search
  cost while the proof requirement stays exactly where it was.
- Promotion decision: revise.
- Destination or rationale:
  `.llm/skills/build-lock-lifecycle/references/build-lock-invariants.md`
  records that recovery evidence may be published automatically only by a
  read-only path that fails closed on unprovable state.
- Independent review outcome: recorded in the progress log.
