# Session 102: open issue triage and Gemini pointer PR

Date: 2026-09-27

## Objective and safety rules

Review all open issues, prioritize by impact while favoring low Unity CI churn,
and complete the highest-value work available. Preserve licensed-resource
safety, fail-closed admission and cleanup, immutable action pins, and credential
safety. Do not change organization policy.

## Baseline

- `main` was clean at `2d0e67ca` before work began.
- GitHub search found 13 open issues and one open PR, #290.
- PR #290 removes the root `GEMINI.md` pointer. Its hosted Build lock CI run
  `36290038454` failed in the agent-context harness. The job log reported
  `GEMINI.md: required file is missing`; the harness still listed that file as
  mandatory.
- The local main branch passed `node --test test/unity-editor-action.test.js`
  (27 passed, one expected Windows-only skip) and `go test ./internal/enrollment`
  was running when the PR investigation began.

## Prioritized open issue inventory

| Priority | Issue | Impact and current constraint |
| --- | --- | --- |
| P1 | #51 | Credential scope is a security boundary. Secret visibility, App installation scope, rotation, and live negative probes require organization-owner operations. No organization policy or secret settings will change here. |
| P1 | #83, #269, #278 | Shared-seat collisions and editor crashes can make Unity CI fail on clean changes. Safe fixes need fresh multi-holder evidence, a reviewed lock design, or cross-repository consumer work. Do not release or classify uncertain cleanup as clean. |
| P1 | #44 | Missing truthful Unity merge gates can permit unsafe merges. Enforcement needs rulesets and coordinated consumer workflows, outside this repository's authority. |
| P2 | #53 | Runner starvation needs an admission redesign and measured load across repositories and physical runners. |
| P2 | #153, #229, #231, #249 | Trusted Darwin and container returns still need exact-head platform canaries, a measured signer identity, and separately reviewed immutable SHA authorization. The container path needs real Docker evidence. |
| P2 | #291 | A Linux Steam profile could reduce provisioning scope, but the central PowerShell payload is copied from `unity-helpers` at a pinned commit. A safe profile change needs upstream source provenance, central action release adoption, and downstream deployment work. The Mac depot also needs a separate Mac signing path. |
| P2 | #29 | Lifecycle canaries and seven-day monitoring require owner-run licensed operations and portal evidence. |
| P3 | #277 | GitHub's retained run data lacks canceller identity. A future diagnostic may help only for API-driven cancels; the core evidence gap needs GitHub support or new consumer-side telemetry. |

The issue acceptance evidence does not support completing these items safely in
this repository session. The least-churn actionable work is the in-progress
PR #290: reconcile the harness with its optional vendor-pointer deletion.

## Hypothesis and red evidence

Hypothesis: the harness failure is a stale required-pointer entry, not a reason
to restore the duplicate Gemini pointer. This is falsified if removing the
entry makes remaining pointer validation or generated-index checks incomplete.

On PR branch `wallstop-patch-1`, before the fix:

- `node tools/llm-harness.mjs check` failed only with
  `GEMINI.md: required file is missing`.
- The hosted run showed all later checks skipped because this harness step
  failed. Its Windows evidence-deletion and Darwin return action jobs passed.
- PR review comments were empty at inspection time.

## Change and focused evidence

- Removed `GEMINI.md` from the harness's required pointer list.
- Added a contract assertion that the deleted optional pointer is not required.
- `node tools/llm-harness.mjs check`: passed.
- `node --test test/llm-harness-contract.test.js test/llm-harness-hook.test.js`:
  8 passed, 0 failed.

## Adversarial review

- Remaining pointers are still required and checked against the canonical
  template. The harness still rejects missing, symlinked, oversized, or stale
  generated knowledge files.
- No workflow, action, lock policy, credential path, or licensed cleanup path
  changed.
- Historical research dated 2026-07-26 accurately describes the pointer set at
  that time; it is not current-state guidance and needs no edit.
- Main-thread review is required because this task did not request delegation.

## Disposition

Pending full local verification, push, hosted CI, review feedback, merge, and a
green-main check. Keep issues above open; this change does not claim to resolve
them.
