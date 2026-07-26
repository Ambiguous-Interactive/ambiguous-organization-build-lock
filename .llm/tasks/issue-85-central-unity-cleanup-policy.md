<!-- summary: Task record for central bounded Unity cleanup classification and post-release safety gating. -->
# Task: Centralize Unity cleanup classification and final safety gating

## Acceptance criteria
- A dependency-free Node 24 action classifies bounded, run-scoped Unity return
  evidence into the typed schema-5 cleanup report without printing evidence.
- Exact skipped-ULF evidence vetoes otherwise positive cleanup proof and maps to
  runner-local quarantine reason `return-ulf-skipped`.
- Supplemental evidence may establish account/error state but never cleanup
  proof for the dedicated return command.
- A separate final action fails every acquired job unless classification and
  central release outputs coherently prove confirmed, healthy cleanup.
- Existing schema, lock capacity, and Unity command invocation behavior remain
  unchanged; the change performs no licensed Unity work.

## Baseline
- Command: `node --test test/unity-cleanup-evidence.test.js test/unity-cleanup-gate.test.js`
- Observed result: failed with `MODULE_NOT_FOUND` for both new committed
  runtimes, as expected before implementation.
- Reproduction status: not applicable; this is a new central policy surface
  replacing independently maintained consumer policy.

## Hypothesis
- Claim: Porting the corrected DoxReloaded evidence contract to a bounded
  dependency-free Node action, then enforcing a coherent post-release gate,
  centralizes policy without changing schema-5 lock semantics.
- Disconfirming evidence: any fixture accepts cleanup proof from supplemental
  logs, treats skipped ULF or `400006` as safe, leaks evidence, or permits a
  quarantined/contradictory release to pass the final gate.
- Falsified hypotheses: `400006` is not clean evidence; serializing only the
  return command cannot establish two independently returnable Unity identities.

## Red
- Test: table-driven classifier and gate suites.
- Expected failure: the central runtimes and public action contracts do not yet
  exist.
- Observed failure: both test files failed at module load because
  `.github/dist/classify-unity-cleanup-evidence.js` and
  `.github/dist/require-confirmed-unity-cleanup.js` did not exist.

## Risk and path matrix
- Positive: exact dedicated-log entitlement plus ULF proof; safe cooldown and
  safe direct release.
- Negative: missing marker, supplemental-only proof, exact skipped ULF,
  `400006`, `20113`, malformed typed inputs, unknown/quarantined release.
- Error: missing/unreadable/symlinked/oversized/over-count/changing evidence;
  failed or incomplete release.
- Boundary/extreme: empty log, exit zero alone, nonzero exact proof, signed
  termination codes, 25 MiB/256-file bounds, UTF-8 BOM and CRLF.
- Concurrency/ordering: stable before/after file identity; mixed proof and skip
  in either order.
- Cancellation/recovery: timeout and termination remain unknown and quarantine;
  the final gate rejects missing classification or release completion.
- Determinism/isolation: temporary fixtures, injected output path, no network,
  Docker, Unity, credentials, or real sleep.
- Contract synchronization: action manifests, committed runtimes, build-lock
  reason allowlist, tests, README, enrollment guide, runbook, and progress log.

## Green
- Minimal change: two dependency-free Node 24 public actions, the schema-5
  `return-ulf-skipped` allowlist addition, fixture suites, and synchronized
  consumer/operator documentation. No schema, config, credential, or workflow
  capacity change.
- Focused result: 58 classifier/gate cases passed before added I/O-race fixtures;
  all 36 manifest-contract tests and all seven schema-5 runner-local uncertainty
  subcases passed.

## Full validation
- `node tools/llm-harness.mjs generate` and `check`: generated index and passed.
- `node --test test/unity-cleanup-evidence.test.js
  test/unity-cleanup-gate.test.js test/action-manifests.test.js`: 102 tests
  passed after all review regressions were added.
- Focused schema-5 reason test: all seven runner-local uncertainty reasons
  passed, including `return-ulf-skipped`.
- `.devcontainer/scripts/verify.sh`: 533 Node tests passed; all Go packages,
  both Go modules, actionlint, harness checks, and credential-literal audit
  passed.
- `git diff --check HEAD`: passed.

## Adversarial review
- Unsafe success paths considered: supplemental proof, mixed group success and
  skip, numeric substrings, partial capture, spoofed exit markers, holder removal
  without safe capacity state, contradictory reservations, workflow-command
  injection, and GitHub's hyphen-preserving action-input environment convention.
- Intent-to-diff status: done for the zero-Unity central slice; consumer rollout
  and schema-6 capacity work are explicitly out of this diff.
- Unverifiable items and open questions: live cross-consumer rollout and two
  independent entitlement identities remain separate follow-up work.
- Remaining uncertainty: consumer wrappers do not yet emit the new capture
  contract or pin these actions; this dormant central slice changes no active
  licensed workflow.
- Implementer: primary agent.
- Reviewer and evidence: independent read-only agent inspected the base-to-working
  diff, affected runtime/contracts, and focused verifier before reading this
  record; it reproduced bounded-I/O probes and mutation tests.
- Actionable findings: uncapped path reads after a pre-read stat; per-directory
  rather than aggregate traversal budgeting; no subprocess proof that the gate
  exits nonzero; and host-locale-dependent digest ordering.
- Remediator and dispositions: primary agent accepted all four. Reads now use a
  prevalidated descriptor and exact buffer, traversal is iterative with aggregate
  discovery/read/buffer/depth bounds, subprocess tests prove unsafe exit 1 and
  safe exit 0, and explicit code-unit ordering has a fixed non-ASCII digest.
- Latest review round outcome: no actionable findings; 102 focused tests, all
  seven schema-5 reason cases, harness check, and diff check independently green.
- Main-thread fallback reason (if applicable): not applicable.

## Knowledge retention
- Trigger or exemption: substantial public safety-policy change.
- Evidence: completed diff, red/green fixtures, 533-test full verifier, and four
  independent review findings with fresh remediation verification.
- Observed facts, inferences, and open questions: observed facts are that a
  post-stat path read is not an allocation bound, nested local counters are not
  an aggregate bound, in-process function tests do not prove action exit status,
  and default locale ordering changes public digests. Consumer rollout and
  two-identity Unity proof remain open questions. No inference is promoted.
- Root cause or reusable insight: evidence collection needs bounds at the actual
  allocation/enumeration boundary, while executable safety promises need
  committed-entrypoint tests.
- Promotion decision: no durable learning beyond the task record and regression
  tests.
- Destination or rationale: the repository's testing skill already requires
  boundary, extreme, determinism, and entrypoint evidence; the concrete rules are
  enforced more precisely in the new classifier/gate tests without duplicating
  general guidance.
- Independent review outcome: clean after four remediation rounds.
