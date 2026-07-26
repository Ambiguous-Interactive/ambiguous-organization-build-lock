# Session 013: central Unity cleanup policy

Date: 2026-07-26

Status: local implementation, full validation, and independent review complete

## Objective and boundary

Implement the largest safe zero-Unity slice of issue #85: make the central lock
repository authoritative for bounded cleanup-evidence classification and for the
final post-release safety gate.

This slice does not change lock schema, live capacity, credential selection,
Unity invocation, or consumer pins. In particular it does not treat `400006` as
clean and does not claim that two configured holders represent two independently
returnable Unity identities. Those issue #83 changes remain blocked on two
distinct identities, both return orders, exact positive return evidence, and
portal reconciliation.

## Architecture decision

The new classifier is a dependency-free Node 24 action so Linux, macOS, and
Windows consumers share one implementation. It reads only regular non-symlink
`.log`/`.txt` files, limits evidence to 256 files and 25 MiB, checks file identity
before and after reads, rejects invalid UTF-8/binary capture, and emits only typed
status plus a SHA-256 digest. It never prints evidence.

Cleanup proof is scoped to the dedicated current return log. Supplemental
activation evidence can establish `20111`, `400006`, or `20113`, but cannot
establish cleanup. Classification precedence is:

1. exact `20111`;
2. incomplete or ambiguous capture;
3. exact `400006`;
4. termination;
5. timeout;
6. exact `20113`;
7. exact skipped ULF;
8. exact entitlement plus ULF return proof;
9. missing positive evidence.

The separate final gate accepts only an acquired job with a completed
`confirmed/healthy/cleanup-confirmed` classification and a successful central
release that reports either a coherent cooldown reservation or a direct release.
Quarantine, incident, missing output, contradictory reservation, and
`released=true` without a safe cleanup result all fail.

## Red and focused evidence

- Initial focused command failed because both new committed runtimes were absent.
- After the minimal implementation, 58 classifier/gate cases passed.
- The manifest inventory initially rejected the new runtimes because they were
  not yet in the Git index; after intentionally staging only the new owned files,
  all 36 manifest tests passed.
- The schema-5 reason test passed for all seven runner-local uncertainty reasons,
  including the new `return-ulf-skipped`.
- Main-thread inspection caught that GitHub preserves hyphens in JavaScript
  action input environment keys. The initial runtime incorrectly looked for
  underscore-normalized keys; both runtimes now follow the repository's existing
  `INPUT_<HYPHENATED-NAME>` convention, with injected-environment regressions.
- The final complete verifier passed 533 Node tests, all Go packages, both Go
  modules, actionlint, harness checks, and the credential-literal audit.

## Independent review and remediation

The independent failure-oriented reviewer found four actionable gaps:

1. A path-based whole-file read occurred after the size stat, so a growing file
   could allocate beyond the advertised limit before rejection. The collector
   now opens a descriptor, matches its stat before allocating, reads only the
   exact prevalidated size, and compares descriptor and path stats afterward.
2. Directory limits were local to recursive frames rather than aggregate. The
   collector now uses an iterative stack with one global discovery cap, one
   global directory-read cap, and measured buffer/depth bounds.
3. In-process gate tests did not prove the committed action exits nonzero.
   Subprocess fixtures now prove unsafe cleanup exits 1 with final
   `cleanup-safe=false`, safe cleanup exits 0 with final `cleanup-safe=true`, and
   injected workflow-command text is not echoed.
4. `localeCompare` made evidence-digest ordering host-locale-dependent. Explicit
   code-unit ordering and a fixed `z.log`/`ä.log` digest fixture now make the
   public digest deterministic.

The latest fresh review reports no actionable findings. Focused validation is
102 tests, all seven schema-5 runner-local reason cases, harness check, and diff
check green.

## Continuous-improvement decision

This substantial public-policy change triggered the improvement gate. The
observed findings reinforce existing repository guidance about boundary,
determinism, and committed-entrypoint tests; no new general guidance is needed.
The precise reusable invariants are retained in the task record and executable
regressions. Consumer adoption and issue #83 external entitlement proof remain
explicit open questions rather than promoted inference.

No Unity, Docker, credential, network, or paid CI operation is required for this
implementation or its fixture suites.

## Pending

- Open the central PR, request exact-head Cursor Bugbot and Copilot reviews, and
  merge only after all required CI and review evidence is green.
- Publish an immutable release before any consumer adoption; migrate
  unity-helpers, qora-redux, and DoxReloaded separately.
