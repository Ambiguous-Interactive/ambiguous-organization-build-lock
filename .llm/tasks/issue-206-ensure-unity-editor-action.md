<!-- summary: Replace the trusted Unity editor checkout prefix with one pinned organization action. -->
# Task: Centralize the trusted Unity editor validator

## Acceptance criteria
- `.github/actions/ensure-unity-editor/` exposes the upstream validator's eight inputs and an `editor-path` output.
- A consumer needs one immutable build-lock action step, with no `unity-helpers` checkout or bespoke diagnostics binding step.
- The action invokes the vendored PowerShell payload without a command shell and fails closed on malformed inputs, process failure, or missing/contradictory diagnostics.
- The enrollment analyzer accepts only the approved action SHA, exact safe inputs, bounded failure-propagating execution, and the existing trusted-prefix ordering.
- Action manifest, runtime, vendored source provenance, tests, README, enrollment guidance, operations guidance, and generated knowledge stay synchronized.

## Baseline
- Command: focused source, policy, and GitHub inspection on 2026-08-20.
- Observed result: issue #206 is open with no PR; `main` is clean at `57634ff29`; the enrollment analyzer requires a removal bootstrap, `actions/checkout`, and direct `ensure-editor.ps1` invocation.
- Reproduction status: reproduced from source and current policy fixtures; the reported external checkout timeout is historical evidence and was not replayed.

## Hypothesis
- Claim: vendoring the self-contained script at its already-approved `76712db...` bytes and wrapping it in a Node 24 action can remove the network checkout while preserving exact-input and editor-path evidence checks.
- Disconfirming evidence: any shell-interpreted input, mutable/unapproved action reference, accepted contradictory diagnostics, unbounded gate, new pre-acquire step freedom, or consumer policy regression.
- Falsified hypotheses: pending.

## Red
- Test: `node --test test/unity-editor-action.test.js`.
- Expected failure: the new committed runtime does not exist.
- Observed failure: Node failed with `MODULE_NOT_FOUND` for
  `.github/dist/ensure-unity-editor.js`, proving the contract had no runtime.

## Risk and path matrix
- Positive: exact literal and static-matrix versions; EditorOnly and reviewed standalone profile; canonical and CI-managed alternate editor paths.
- Negative: malformed booleans/version/profile/list, missing diagnostics, outside-root editor, mismatched root/version/profile/managed flag, non-success classification.
- Error: PowerShell launch error or nonzero exit leaves `editor-path` unwritten.
- Boundary/extreme: empty optional inputs, CR/LF output injection, empty/duplicate payload paths, diagnostics BOM.
- Concurrency/ordering: no shared state; policy keeps the action first or immediately after the exact current-head guard.
- Cancellation/recovery: no lock is acquired yet; a cancelled/failed validator blocks all later licensed work.
- Determinism/isolation: unit tests inject process execution and use isolated temporary evidence files.
- Contract synchronization: manifest/runtime/payload, enrollment analyzer and fixtures, README/docs, provenance notice, generated index.

## Green
- Minimal change: added one dependency-free Node 24 action that validates typed
  inputs, invokes the approved self-contained PowerShell payload without a
  command shell, binds its output to exact diagnostics, and writes
  `editor-path` only after all checks pass. The analyzer accepts that shorter
  prefix while retaining only the exact prior prefix during consumer rollout.
- Focused result: `env -u FORCE_COLOR node --test
  test/unity-editor-action.test.js test/action-manifests.test.js
  test/documentation-policy.test.js` ran 95 tests: 94 passed, the hosted-Windows
  adapter test was expectedly skipped on Linux, and 0 failed. `go test
  ./internal/enrollment` passed, including the restored legacy mutation suite
  and the new action-prefix mutation matrix.

## Full validation
- Command: `bash .devcontainer/scripts/verify.sh`.
- Exact outcome: exit 0. The LLM harness passed; 819 Node tests ran with
  816 passed, 3 expected platform skips, and 0 failed; all Go tests and race
  tests, module verification and tidy-diff checks, Go vet, golangci-lint,
  actionlint, JavaScript and ShellCheck policy, workflow policy, and the
  credential-literal audit passed.

## Adversarial review
- Unsafe success paths considered: mutable or extra action inputs, inherited
  runtime-preload environment, omitted safety switches, shell interpolation,
  process failure, stale/malformed/contradictory diagnostics, path or workflow
  output injection, action ordering after credentials/acquire, and rollout
  failure for consumers still on the exact old prefix.
- Intent-to-diff status: the action and analyzer satisfy all five issue #206
  criteria; the only additional product change is one compatible tooling-module
  dependency refresh required by `GOAL.md`.
- Unverifiable items and open questions: the typed PowerShell adapter cannot run
  locally because this Linux container has no `pwsh`; the existing Windows CI
  job now executes that test. Consumer repins occur after this action has an
  immutable merged SHA and are intentionally outside this repository PR.
- Remaining uncertainty: hosted Windows behavior and downstream consumer
  adoption remain remote evidence; both fail closed because the analyzer also
  retains the exact old prefix during migration.
- Implementer: main agent.
- Reviewer and evidence: main-thread adversarial pass required by `GOAL.md` because no sub-agent was requested.
- Actionable findings: initial review found two high-impact defects: replacing
  the legacy gate immediately would make the live organization audit reject all
  not-yet-repinned consumers, and the first README example placed Unity work
  before acquisition.
- Remediator and dispositions: the main agent restored the exact legacy gate as
  closed transition-only compatibility, restored its full negative mutation
  suite, documented migration sequencing, and changed the README to bind the
  validated path only in later acquired work.
- Latest review round outcome: a fresh final diff pass found zero unresolved
  product findings after those remediations. The first full verifier then found
  that actionlint 1.7.12 cannot compile against YAML v4 rc.6; that attempted
  dependency update was reverted to the tracked #94-compatible rc.3 pin. The
  next verifier found and corrected one stale exact CI run-step test expectation
  after the Windows job began running both action suites. Final staged review
  and the complete verifier found zero unresolved findings.
- Main-thread fallback reason (if applicable): multi-agent delegation was not requested.

## Knowledge retention
- Trigger or exemption: substantial public action and enrollment-policy change.
- Evidence: the first analyzer implementation made the action the only accepted
  editor gate; inspection against live consumer rollout order exposed that main
  would reject every unchanged old prefix before any consumer could repin.
- Observed facts, inferences, and open questions: the old prefix remains safe
  only in its exact previously approved shape; the new action removes the
  network checkout and binding step; no open implementation question remains.
- Root cause or reusable insight: security-contract migrations must preserve an
  exact safe predecessor until dependents can move to the new immutable pin.
- Promotion decision: no new durable skill or reference.
- Destination or rationale: the existing architecture-and-plan-review guidance
  already requires compatibility, migration, rollback, and downstream-consumer
  analysis. The issue-specific predecessor shape and removal condition are
  recorded in the analyzer comment, enrollment guide, operations runbook, this
  task record, and the progress record rather than duplicating generic guidance.
- Independent review outcome: main-thread review, required because delegation
  was not requested, confirmed the existing guidance already covers the durable
  lesson and found no further knowledge remediation.
