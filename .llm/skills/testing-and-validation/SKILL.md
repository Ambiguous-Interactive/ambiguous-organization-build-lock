---
name: testing-and-validation
description: Select and run repository validation with honest evidence. Use when adding tests, changing validation commands, updating committed action runtimes, running CI, or preparing a handoff.
---
# Testing and Validation

The repository uses dependency-free Node 24 tests and Go 1.26 tests. Public
JavaScript actions execute committed files under `.github/dist/`; do not assume
a package build step exists.

## Risk and path matrix

Before selecting commands, trace every changed entry point through inputs,
state changes, outputs, cleanup, and consumers. Map the applicable cases:

- positive: authorized success, idempotence, and required operator evidence;
- negative: unauthorized, malformed, missing, stale, or ambiguous evidence;
- error: dependency errors, 401/403/409/429/5xx, timeout, network or body-read
  failure, retry exhaustion, and partial or ambiguous writes;
- boundary and extreme: empty, zero, one, maximum, overflow, and large inputs;
- concurrency: duplicate/replayed requests, competing acquire/release/reap,
  stale reads, compare-and-swap loss, and deterministic queue ordering;
- cancellation and recovery: abort at each asynchronous boundary, cleanup,
  quarantine/cooldown, restart, and operator escalation;
- contract: action manifest, committed runtime, analyzer, outputs, docs,
  workflow policy, and generated knowledge remain synchronized.

Not every change needs every case. Record why a dimension is inapplicable; do
not silently omit a reachable failure path. Connect each case to the cheapest
authoritative unit, contract, integration, or end-to-end test.

## Determinism and isolation

Inject the clock, random source, sleep, and I/O at nondeterministic boundaries.
Do not use real sleep in tests. Use fixed fixtures and isolated temporary
directories, environment, globals, and processes; restore narrow mutations in
cleanup even after assertion failure. Assert retry counts, delays, ordering,
terminal diagnostics, and deadlines directly.

A mandatory test must pass on the first attempt. Repetition is a diagnostic
for flakes, never a retry-based green gate; any divergent run is evidence of
nondeterminism.

When a defect exposes a recurring category, add one behavioral regression and,
where mechanically expressible, the narrowest central invariant or validator
that rejects the entire unsafe shape or class. Avoid example-only coverage when
one tripwire can prevent all equivalent forms.

## Retry instruction decision order

Keep a raw external retry instruction available until the caller has completed
its semantic and remaining-budget decisions. A backoff or sleep cap is not
evidence that the original instruction fits a deadline: compare the uncapped
instruction with the caller's contract first, then cap only the eventual sleep
that caller permits. Shared-client retry policy is not automatically the policy
of a standalone action with a narrower guard budget.

Test the two values separately when they can differ: the raw instruction must
drive honorability and terminal-diagnostic decisions, while the eventual delay
must obey that caller's sleep cap, cancellation, and deadline contract.

## Escalation

1. Syntax-check or run the smallest changed unit.
2. Run its focused Node or Go test.
3. Run adjacent policy or contract suites.
4. Run `.devcontainer/scripts/verify.sh` for the CI-equivalent suite.

Confirm manifests still reference the intended runtime files. For workflow
changes, run actionlint. For Go changes, run tests, module verification, and
tidy-diff checks. For workflow command changes, run the credential audit.

Record actual command outcomes. If environment or credentials prevent a check,
state that limitation instead of substituting confidence. Any applicable
mandatory gate that failed or did not run blocks a clean completion status.
