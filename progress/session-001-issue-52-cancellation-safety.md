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

## Next tasks

- Commit and publish the immutable guard SHA.
- Apply non-cancellable licensed scopes and two live head checks in every affected
  consumer without changing static-only cancellation behavior.
- Add the exact-SHA transitive cancellation policy analyzer and fixtures.
- Run local workflow contracts, then live pre-/post-acquire/manual-cancel canaries.
- Await CI and Copilot/Cursor Bugbot review after every pushed task.
