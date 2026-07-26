# Session 012: development harness and active incident priority

Date: 2026-07-26

Status: local implementation complete; hosted container evidence pending

## Objective and invariants

Carry the interrupted development-environment and agent-harness work to a
reviewable, zero-Unity-churn PR, then address the highest-impact open production
issue without weakening licensed-resource safety, queue fairness, recoverability,
or operator-visible evidence.

Unconfirmed Unity cleanup must remain quarantined. Two configured lock holders
must never be described as two safe Unity entitlements without independent
return evidence. No organization policy changes are authorized.

## Current open-issue priority

Production impact is primary. Expected paid/licensed Unity CI churn breaks ties.
Umbrella and duplicate issues follow the issue that owns their implementation or
evidence.

| Priority | Issue | Impact and minimum churn disposition |
| ---: | --- | --- |
| 1 | #83 concurrent-return `400006` | Active cross-repository production defect with a measured 21.4% second-return failure rate. A safe complete fix requires independently returnable entitlement identities, slot-aware state, central lifecycle actions, consumer repins, and live two-order proof. |
| 2 | #84 unexplained quarantine | Likely related symptom, but missing run, reservation, reason, runner, recovery, and timestamp evidence. Do not infer cleanup from an empty portal observation. |
| 3 | #85 centralize license/lock technology | Required enabler for #83 and for eliminating divergent consumer classifiers. Group the central lifecycle implementation with #83 to avoid two consumer repin waves. |
| 4 | #51 credential and App scope | Critical control-plane blast radius. Acceptance requires owner-authorized organization settings and probes; ordinary repository code cannot complete it without prohibited policy changes. |
| 5 | #44 truthful Unity aggregates | High merge-integrity impact with proven early merges. Requires several consumer suites and ruleset work. |
| 6 | #77 delayed stale reaping | High measured recovery-latency impact; most central monitoring/docs work is zero-Unity, but an independent monitor and concurrency design are required. |
| 7 | #42 continuous enrollment | High defense-in-depth value and mostly hosted CI. The broad draft was closed unmerged; the current main contains only narrower audits. |
| 8 | #53 pre-FIFO runner starvation | High fairness/throughput value, but requires a two-phase admission design and multi-repository/two-runner load proof. |
| 9 | #49 unity-helpers matrix bounds | Material organization throughput cost; requires a truthful aggregate, faster representative PR policy, and an automatic 15-leg full sweep. |
| 10 | #54 Isho cleanup canary | Bounded assurance work: one EditMode lifecycle plus PlayMode or an explicit unsupported classification. |
| 11 | #60 literal zero cooldown | Release and consumer repins are largely historical; literal zero and its cross-runner zero-`20111` canary remain. Lower impact at the live one-second setting. |
| 12 | #29 lifecycle canaries/monitoring | Critical closure evidence, but a multi-day operational program rather than one code PR; recent #83 evidence resets any zero-incident interpretation. |
| 13 | #27 lock-held regression | Shares #29's monitoring gate and closes with it. |
| 14 | #79 `Date.now()` UTC | No demonstrated defect: JavaScript epoch milliseconds are timezone-independent. Close with an evidence-backed explanation after higher-impact work. |
| 15 | #30 rollout tracker | Umbrella issue; closes after its children and owner-only evidence are resolved or explicitly transferred. |
| 16 | #86 development harness | Carried-forward developer infrastructure with zero licensed Unity churn. Finish first to preserve existing work and obtain real multi-architecture container evidence; it is not a substitute for #83. |

No draft or in-progress PR was open at the session preflight. PR #56 was closed
unmerged; its cancellation-safety portions were superseded by later merged work.

## #83/#84/#85 architecture evidence

The current shared Unity identity is not proven to expose two independently
returnable entitlements. Serializing `-returnlicense` cannot help: it guarantees
one return is second, and the measured failure discriminator is returning after a
peer. Treating `400006` as clean would convert correlation into cleanup proof and
violate the fail-closed invariant.

The safe target is a drained one-way schema upgrade whose holders, cooldowns, and
quarantines carry one opaque resource-slot ID. Acquire assigns distinct slots by
CAS; central activation selects the corresponding scoped credential bundle;
central return requires exact entitlement and ULF evidence; every `400006`,
skipped ULF, timeout, truncation, termination, or missing proof quarantines only
that slot; confirmed `20111` remains a global incident.

Enabling two slots is blocked on sanitized external proof of two independent Unity
identities, both return orders, portal reconciliation, and secret scope. Dormant
code can be built and tested before that proof, but live schema activation cannot
be claimed safe.

An immediate prerequisite was also found: current unity-helpers classifiers treat
`Serial number unavailable for ULF return` and its `skipping operation` form as
positive ULF proof. DoxReloaded PR #229 established that this is the failure
branch. The shared helper and pinned consumers must be corrected before any code
is centralized from it.

## Issue #86 carried-forward work

The interrupted work adds:

- a canonical `.llm/context.md`, deterministic generated knowledge index,
  Agent Skills metadata validator, and thin editor/vendor pointers;
- a staged-snapshot pre-commit hook and installer;
- a pinned image-based Dev Container with native amd64/arm64 Features, lifecycle
  scripts, caches, editor settings, and the complete repository verifier;
- CI integration, focused contract tests, and developer documentation.

### Adversarial findings and remediation

1. The initial devcontainer declared both `image` and `build`, which violates the
   official schema's mutually exclusive source modes. The Dockerfile was removed,
   convenience packages moved into the lifecycle bootstrap, and the contract test
   now requires exactly one source. The official base schema accepts the revised
   JSON.
2. Removing the Dockerfile also removed its mutable, stale
   `docker/dockerfile:1.7` frontend. The pinned current multi-architecture Go image
   remains the single source for both standards-compatible and DDorch clients.
3. Go was updated from 1.26.4 to 1.26.5 in the Feature selector and checksum-pinned
   amd64/arm64 DDorch fallback.
4. The actionlint tool module updated `go-isatty` 0.0.23 to 0.0.24 and
   `go-runewidth` 0.0.24 to 0.0.27. YAML v4 rc.6 was tested and rejected because
   actionlint v1.7.12 fails to compile against its changed parser-error API;
   compatible rc.3 remains isolated with direct command evidence.
5. `semantic-release` 25.0.8 and the three configured plugins are now exact
   rather than floating. All remote workflow action SHAs and Dev Container Feature
   packages were already current.
6. A pinned `devcontainers/ci` workflow now performs native amd64 and arm64 builds
   and runs the complete verifier inside each container. This is zero licensed
   Unity churn.
7. Cursor's exact-SHA PR review found that `safe.directory` was configured after
   the DDorch post-start fallback invoked repository-dependent setup. Both
   lifecycle paths now configure it before any repository command, with an
   ordering regression test.

## Verification evidence

Observed green before remediation:

- focused harness/devcontainer/workflow tests: 70 passed;
- complete verifier: 457 Node tests, all Go packages, actionlint, both module
  verification/tidy checks, harness checks, and credential audit passed;
- Bash syntax, ShellCheck, and `git diff --check` passed.

Observed red during remediation:

- official schema review rejected simultaneous `image` and `build`;
- actionlint compilation failed against YAML v4 rc.6 with missing
  `ParserError`/error fields.

Observed green after focused remediation:

- official Dev Container base schema validation: passed;
- devcontainer and workflow policy tests: 58 passed;
- actionlint compiled and passed with compatible YAML rc.3;
- both actionlint module verification and tidy checks passed.
- complete verifier: 459 Node tests, all Go packages, actionlint, both module
  verification/tidy checks, harness checks, and credential audit passed;
- fresh independent review reproduced the complete verifier, confirmed that the
  pinned image manifest contains native `linux/amd64` and `linux/arm64`, confirmed
  the pinned `devcontainers/ci` inputs, and resolved every documented Open VSX
  extension.
- after Cursor remediation, the focused lifecycle suite passed 3/3 and the
  complete verifier again passed 459 Node tests plus every Go, module,
  actionlint, harness, and credential gate.

The local host has no Docker executable, so native container builds remain
unverified locally. The new hosted matrix is the authoritative pending evidence.

## Continuous-improvement decision

Trigger: the work changes agent guidance, developer runtime, CI, tests, and
dependency policy, and it produced two reusable compatibility findings.

Observed facts:

- the official Dev Container schema rejects simultaneous container source modes;
- actionlint v1.7.12 does not compile against YAML v4 rc.6's changed parser-error
  API.

Inference: none promoted. The native hosted matrix is expected to reproduce the
local verifier, but only completed hosted runs can establish that result.

Open questions: the actual amd64/arm64 container-build result remains pending CI,
and #83's Unity entitlement behavior remains bounded by the external evidence
requirements above.

Decision: `promote`. The source-mode invariant is enforced in
`test/devcontainer.test.js` and explained in `.devcontainer/README.md`; the YAML
compatibility boundary is retained in this dated task record rather than promoted
to permanent guidance because it must be revalidated when actionlint changes.
No inference about Unity's concurrent-return behavior was promoted: #83 remains
bounded by the external proof described above.

## Review roles

- Implementer/remediator: main session thread.
- Independent dirty-patch reviewer: adversarial sub-agent; four actionable
  findings above were accepted and remediated or carried as explicit GOAL work.
- Dependency auditor: independent sub-agent; compatible updates incorporated,
  incompatible/upstream-only modules disposed with command evidence.
- #83 architecture reviewer: independent sub-agent; rejected unsafe shortcuts and
  identified the shared-helper fail-open prerequisite.
- Fresh post-remediation reviewer: independent sub-agent; reproduced all local
  gates and found one actionable handoff-record omission. The main-thread
  remediator added the missing full-verifier, external-manifest/input, extension,
  and continuous-improvement evidence. Latest-round re-review reported no
  actionable findings.
- Cursor Bugbot exact-SHA review: one medium portability finding accepted;
  `safe.directory` now precedes repository-dependent setup in both lifecycle
  paths. Independent re-review found and the main-thread remediator fixed one
  false-pass in the ordering regression; a deletion mutation now proves absence
  fails. The latest independent review reported no actionable findings.
