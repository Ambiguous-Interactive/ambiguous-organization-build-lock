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
- The active paid-serial inventory is unity-helpers, DxMessaging, DoxReloaded,
  IshoBoy, qora-redux, and the controlled unity-builder canary.
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
   DoxReloaded, IshoBoy, and qora-redux. Cursor's permission-scope finding was
   fixed by preserving workflow-wide read access.
8. Enrolled those five exact commits and the unchanged unity-builder canary in
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
12. The first immutable-inventory CI run proved the default repository token
    cannot read private sibling repositories. Organization policy deliberately
    disables repository deploy keys, so the audit does not weaken that policy or
    embed private consumer snapshots.
13. The privileged inventory audit is now a trusted `workflow_run` second
    stage. Ordinary PR CI stays local, secretless, and safe for forks and
    Dependabot. The second stage checks out the exact protected workflow commit,
    disables cross-trust dependency caching, reads only a strict six-repository
    manifest from the candidate's exact regular Git blob, and never executes
    candidate or consumer content. A separate policy-reader App, whose key is
    central-repository-only and whose installation is limited to the six
    consumers, mints `contents: read` tokens and revokes them at job completion.
    The exact event repository IDs and live PR head are both checked. One terminal
    fixed-name Check Run is published on the candidate SHA, avoiding both
    base-SHA false positives and orphaned in-progress checks.
14. The source run's optional PR-association array is not trusted or required.
    A tested resolver lists open `main` PRs and requires exactly one match for the
    event's head repository ID and SHA, covering empty associations, forks,
    Dependabot, stale heads, and ambiguous matches. Candidate identity is recorded
    before the fallible lookup so a resolution failure can still publish a red
    terminal check on the exact source SHA.
15. Immutable manifest pins must also equal every consumer's live default-branch
    head. The policy App verifies all six before checkout and again after the
    analyzer, so historical passing commits cannot be used as downgrade pins and
    a consumer advance during the audit cannot produce a stale success. The
    Check Run is explicitly a point-in-time attestation; source CI must be rerun
    after consumer changes and immediately before central merge.
16. Live FIFO observation exposed a time-of-check/time-of-use gap in the
    standalone current-head guard: a PR could pass the guard, wait behind a
    licensed holder, then be superseded before admission. Acquire now performs
    its own fail-closed PR-head validation before any lock read, periodically
    while queued, immediately before the admission CAS, and after verified CAS
    success before licensed work can start. A stale or unverifiable run removes
    its exact queue/holder identity; a just-admitted stale holder is retracted
    without creating a lifecycle reservation because the action has not yet
    returned control to Unity. Cleanup ambiguity is a distinct terminal failure,
    and the enrollment analyzer requires the exact three PR identity inputs on
    every PR-reachable direct or composite acquire frontier. Data-driven tests
    cover capacity-held periodic checks, the admission boundary, CAS conflicts,
    API failure ordering, and truthful blocked-account failure behavior.
17. The adversarial implementation pass found five additional boundary flaws:
    quarantine recovery provenance could be discarded, request timeouts could
    be mistaken for process cancellation, inert inputs on an older immutable
    acquire pin could satisfy policy, `NODE_OPTIONS` could alter pinned action
    execution, and an account incident appearing mid-wait could strand the
    caller in FIFO. The revised implementation restores an original quarantine
    atomically, quarantines unknown pre-existing holders, classifies only the
    acquire controller as signal cancellation, makes PR failures terminal
    outside lock-auth grace, supports an exact required acquire SHA, rejects
    direct and inherited Node preload injection, and performs exact queue-only
    incident cleanup. A separate periodic-401 regression closes the same
    terminal-error class. Follow-up adversarial interleavings also close incident
    publication after the admission CAS, ambiguous queue-write post cleanup,
    clean-conflict provenance carryover, preexisting queued retries, and job
    container runtime injection. The complete local gate and zero-issue final
    adversarial pass are green at 406 Node tests,
    all Go tests and vet, actionlint, and whitespace validation.
18. Repinned every acquire-action site across the five modified active
    consumers to reviewed implementation
    `6b2147a1d158c770f213d216f4eea0c313be370a`.
    Every PR-reachable licensed job now passes the exact GitHub token, pull
    request number, expected head SHA, and two App credential bindings. The
    final consumer heads are unity-helpers `aa5425343db714bafc2b0f2c14db579427b75937`,
    DxMessaging `431c8bcb4453e33d04c289c479f85fc493e8ba4f`, DoxReloaded
    `b7037932ddde050963d748dc816161debae9fb3e`, IshoBoy
    `3d2ea5a149a790d2528e5412f524cee582fe3606`, and qora-redux
    `3cb77f47d83289b18c464e2c50ce6bc1cae27a9b`; unchanged unity-builder commit
    `bb2ff53bc0855f97da41a71c93bf0f4b37e60efa` also passes exact acquire-SHA
    analysis. The consumer adversarial loop caught and removed acquire inputs
    from one Dox release step. Hosted CI then exposed three useful contract
    gaps: Dx's repeated documentation assertions exceeded its JavaScript budget
    and were consolidated data-first without dropping coverage; Cursor found
    that Dox's local policy did not yet enforce the acquire inputs and the
    complete three-job PR inventory is now checked; Isho's strict yamllint
    required two spaces before all eight repin comments. Each correction has a
    zero-issue adversarial re-review, exact Cursor zero-issue review, Copilot's
    exact-head quota response, and green hosted CI. Licensed Unity matrices are
    still waiting on the two self-hosted runners occupied by pre-existing Qora
    PR #39 jobs; those active holders were not cancelled.
19. Verified the existing organization-wide `BUILD_LOCK_READER_*` App is the
    Actions/runner-inventory reader: it intentionally has no Contents access and
    its credentials are available to consumer preflights. It cannot safely back
    the trusted policy audit. Adding Contents permission would let any consumer
    key holder mint a contents token across the App's all-repository
    installation; per-workflow token narrowing does not constrain other key
    holders. The central-only `BUILD_LOCK_POLICY_READER_*` App therefore remains
    a required, separate boundary: Contents read only, installed on exactly the
    six active consumers. Documentation and validator diagnostics now use the
    current six-repository inventory.

## Next tasks

- Await every licensed consumer matrix, merge the five consumer PRs, and then
  publish the prepared exact consumer manifest plus required acquire-SHA audit.
- Provision the scoped policy-reader App, run live pre-/post-acquire and manual
  cancellation canaries, then merge and release the central policy.
