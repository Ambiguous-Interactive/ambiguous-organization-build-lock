# Session 001: issue 52 cancellation safety

## Objective

Prevent automatic GitHub Actions supersession from cancelling a licensed Unity
holder, reject stale pull-request work before it joins the organization FIFO,
and keep required aggregates truthful. Minimize live Unity churn while fixing
the affected consumer repositories and DxMessaging's generated-performance
commit cascade.

## Evidence baseline

- Central issue: `Ambiguous-Interactive/ambiguous-organization-build-lock#52`.
- Related cascade: `Ambiguous-Interactive/DxMessaging#279`.
- Default-branch audit began at build-lock `59a2fa98` (`v1.8.3`).
- The registered paid-serial inventory is unity-helpers, DepartmentOfArrangements,
  DxMessaging, DoxReloaded, IshoBoy, qora-redux, and the controlled unity-builder
  canary.
- GitHub concurrency with `cancel-in-progress: false` protects a running holder;
  the default single pending slot may still replace a not-yet-running stale run.
  That is compatible with the required pre-acquire supersession behavior.
- Issue #42 has no production enrollment auditor yet. Its cancellation rule must
  be implemented as an exact-SHA workflow/called-workflow/composite graph check,
  not added to this repository's test-only workflow parser.

## Work log

1. Added a fail-closed `require-current-pr-head` Node 24 action. Pull-request
   events re-read the PR, require it to remain open, and compare the current head
   with the event's exact 40-character SHA. Push/dispatch events do no API call.
2. Added data-driven tests for current, superseded, non-PR, malformed-input,
   closed-PR, HTTP-failure, and malformed-response behavior.
3. Targeted validation: `node --test test/current-pr-head.test.js
   test/action-manifests.test.js` — 38 tests passed.
4. Cursor Bugbot identified a `pull_request_target` bypass in the first pushed
   guard. The guard now treats both PR event types as live checks and also checks
   reusable-workflow calls when PR number/SHA inputs are supplied.
5. Added an exact-SHA snapshot analyzer for cancellation safety. It propagates
   lock capability through local reusable workflows and nested composites,
   rejects non-literal-false cancellation at every licensed workflow/job scope,
   retains cancellation for unrelated static/preflight jobs, rejects mutable
   acquire pins, and fails closed on malformed or cyclic local graphs.
6. The second adversarial review found early-return traversal, incomplete graph
   shape validation, and a vacuous self-repository CI audit. Traversal and shape
   checks now inspect the complete reachable graph; the self-audit was removed
   until immutable consumer commits can be enrolled as the real gate.
7. Published reviewed consumer commits for unity-helpers, DxMessaging,
   DoxReloaded, IshoBoy, qora-redux, and DepartmentOfArrangements. The archived
   Department repository was temporarily reopened for maintenance; Cursor's
   permission-scope finding was fixed by preserving workflow-wide read access.
8. Enrolled those six exact commits and the unchanged unity-builder canary in
   central CI. Each tree is checked out without persisted credentials and
   audited from its immutable commit object.
9. The final adversarial pass caught a zero-delay retry bug, a shrinkable CI
   inventory, and the fact that consumers still pinned the pre-retry guard.
   Retry parsing now falls back to bounded exponential delay, the inventory is
   an exact data-driven invariant, and all consumers pin reviewed guard commit
   `8e1cf892f5ee710908fc14f09b3c8033edcb74f9`.
10. Extended the exact-SHA analyzer to enforce current-head guards across
    PR-reachable licensed jobs, called workflows, and nested local composite
    lock frontiers. Conservative event-condition analysis only excludes jobs
    when every PR trigger is provably impossible.
11. The closing adversarial pass found that CI-step modifiers could bypass the
    immutable audit and that guard implication omitted GitHub's implicit
    `success()`. CI now constrains both enrollment and audit steps to exact
    executable shapes. Guard conditions model implicit status semantics,
    including `always()`, `failure()`, and `cancelled()`, without mistaking
    status-function text inside quoted strings for a function call. Every
    acquire path must retain a top-level `success()` gate so a failing stale-head
    guard cannot be bypassed by a matching status condition. Mixed top-level
    `&&`/`||` expressions with status functions fail closed, preventing both
    status-gate and PR-event precedence bypasses. Status-free top-level OR is
    compared atomically with GitHub's implicit success gate; parenthesized OR
    remains usable as one conjunct.
    Enrollment and audit checks bind exact executable scripts to their exact
    named step objects; adversarial name swaps cannot satisfy the gate by
    separating a safe step shape from the policy command it is meant to run.
    Direct acquire references are matched case-insensitively across every fixed
    path segment, closing mixed-case lookup bypasses on Windows runners.
    Conditional pre-acquire guards cannot define an `id`, preventing their
    condition from changing truth value after the guard records its own
    `outcome` or `conclusion`; unconditional first guards may still export the
    reviewed action result. Guard steps use a strict top-level key allowlist,
    rejecting `env`/`NODE_OPTIONS` injection, and conditional guards cannot
    reference the step-specific `env` or `github` contexts.
    Licensed matrix jobs require literal `strategy.fail-fast: false`, covering
    GitHub's second automatic-cancellation mechanism in addition to concurrency.
    The unity-helpers manual abort option was removed and all three licensed
    matrices were republished at `af34f6f0234119100dde525d77c4a9f04315e736`.

## Next tasks

- Run local workflow contracts, then live pre-/post-acquire/manual-cancel canaries.
- Await CI and Copilot/Cursor Bugbot review after every pushed task.
