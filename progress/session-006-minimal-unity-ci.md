# Session 006: Minimal dependent Unity CI delivery

Status: complete

## Objective

Inventory every open issue by the minimum dependent-project Unity CI needed,
select the highest-priority fully feasible issue or related group, deliver it
through exact-head review and green CI, merge it, then verify the target default
branch and the central build-lock default branch remain green.

## Constraints

- Do not change organization policy.
- Prefer the GitHub connector, then Git, then `gh`.
- Request Cursor Bugbot and GitHub Copilot after every push and address every
  non-trivial result.
- Use red-green evidence and adversarial review.
- Minimize paid/licensed Unity activations.

## Preflight

- Central repository start: `9a2923e4462bf187a364ad41af22943099b3e3fe`.
- Open issues at start: #27, #29, #30, #42, #43, #44, #47, #48, #49,
  #51, #52, #53, #54, and #60.
- Existing draft PR #56 covers parts of #42/#52 but conflicts with current
  `main` and still depends on cross-repository/control-plane rollout.
- GitHub CLI is authenticated with `repo` and `workflow` scopes.
- Three independent reviews confirmed that no zero-run issue is both fully
  completable and compatible with the policy constraint. Issue #42 is nominally
  central-only, but its latest comment makes reader-App installation and
  organization-secret visibility restrictions pre-merge gates.

## Prioritized issue inventory

The ordering favors autonomous completion, minimum paid Unity work, safety, and
scope. Counts are lower bounds.

| Priority | Issue | Minimum dependent Unity work | Disposition |
| ---: | --- | ---: | --- |
| 1 | #43 bounded Windows PR canary | 1 paid smoke leg | Selected; the Windows cleanup proof and FIFO lifecycle already exist. |
| 2 | #54 Isho cleanup canary | 1-2 paid legs | Requires portal evidence and has no natural implementation PR. |
| 3 | #48 bounded macOS canary | 1 paid leg | New, unproven macOS return classifier and ephemeral-runner recovery risk. |
| 4 | #47 latent Dx workflows | 18 paid legs | Simple deletion, but Dx runs its 3-by-3 matrix on PR and default-branch push. |
| 5 | #49 helper matrix throughput | At least 15 paid legs | Full compatibility sweep is an explicit acceptance criterion. |
| 6 | #60 literal zero cooldown | Five consumer suites plus canary | Requires release and five immutable repins. |
| 7 | #52 cancellation safety | Multiple consumer suites/canaries | Draft #56 is stale and shares forbidden control-plane gates. |
| 8 | #53 pre-FIFO starvation | Three repos/two runners | High-risk admission protocol and live load evidence. |
| 9 | #29 lifecycle monitoring | Multiple canaries plus seven days | Operational program, not one PR. |
| 10 | #27 lock-held regression | Coupled to #29 | No independent closure path. |
| 11 | #30 rollout tracker | Superset of open children | Umbrella tracker. |
| 12 | #42 enrollment audit | Nominally 0 | Infeasible without prohibited App/secret scope changes. |
| 13 | #44 required aggregates | Multiple suites | Requires ruleset policy changes. |
| 14 | #51 credential scope | Variable | Its core objectives are prohibited organization-policy changes. |

## Selected implementation

- Repository: `Ambiguous-Interactive/unity-builder`.
- Starting commit: `29bbfddb6275e4e83fec3fcf44806b3294cb3675`.
- Branch: `agent/bounded-windows-pr-canary`.
- Plan: add one same-repository PR smoke leg, explicit fork/Dependabot exclusion,
  preflight-only and full-dispatch modes, and a stable fail-closed aggregate.
- Existing main failures found during preflight: Community Plugins cannot import
  `js-yaml`, and Upstream Sync copies the verifier without its imported policy
  module. These will be repaired as separate RCA commits so merged `main` can be
  verified green.

## Red-green implementation evidence

- The expanded RC014 verifier rejected the original Windows workflow before the
  implementation, then passed after the bounded PR matrix, trusted-event gates,
  hosted runner preflight, exact-head checks, aggregate, and typed lifecycle
  release were added.
- The same-repository PR matrix is exactly one complete `2022.3.62f3` /
  `StandaloneWindows64` leg. The explicit full dispatch remains 15 complete,
  non-mergeable legs; preflight-only is the safe manual default.
- Exact PR state is checked on a hosted prerequisite, immediately before FIFO
  acquire, and again after admission before activation. A post-admission
  rejection reports `cleanup-confirmed` only when admission explicitly did not
  inherit a same-runner quarantine; inherited or missing recovery evidence
  remains unknown/quarantined, and the workflow stays red because no build ran.
- Outer build retries require positive `resourceSafe` proof from every prior
  attempt. The Windows activation script has one bounded 360-second retry inside
  the same activation-owning action attempt; executable mock cases cover first
  success, retry success, and bounded failure.
- The broken weekly Community Plugins workflow was reduced to a least-privilege,
  zero-Unity registry contract. Data-driven tests cover registry defaults,
  platform expansion, filters, version overrides, hostile input, and workflow
  credential isolation.
- Both Upstream Sync isolated verifier paths now copy the credential-policy
  module imported by the verifier.
- Local evidence: actionlint semantic parsing passed for all changed workflows;
  RC001-RC019 passed; Windows proof/retry tests passed; workflow-policy tests
  passed; 365 Vitest tests passed with two intentional skips; typecheck passed;
  lint exited zero with 17 pre-existing warnings; changed-file formatting and
  `git diff --check` passed.

## Review boundary

- The central acquire action still does not poll PR state while queued. This is
  owned by issue #52. Issue #43 is protected at every consumer-controlled
  boundary, including a post-admission/pre-activation recheck, without changing
  organization policy or widening the selected issue.

## Live PR evidence and RCA

- Target PR: `Ambiguous-Interactive/unity-builder#10`; final reviewed head
  `02d6f3485560dff1808784d4c99f7d2391c51409`.
- The first live smoke proved hosted gating, exactly one licensed-eligible
  matrix leg, and fail-closed retry behavior, but exposed a pre-activation
  Windows portability bug: production versioning attempted to execute missing
  `sh`. The action's runtime versioning
  pipelines and the affected `hasAny`/`logDiff` tests were replaced by direct
  Git/JavaScript behavior; the intentionally shell-oriented
  `system-integration.test.ts` fixture remains. 157 focused versioning tests
  passed.
- Linux Integrity then exposed a stale Windows-generated distribution. An
  isolated Linux/x64 Node 18 rebuild produced Git-clean blobs
  `50207baccca9169c0ee9fac521d92752edff3ac0` and
  `37d752cd6f67956db56b4f28e2c6cd9105853b1e`, exactly matching CI.
- The activation-owning cancellation battle test cancelled run `29675374467`
  46 seconds after Build began. Logs proved successful paid activation and Unity
  execution before cancellation. The workflow emitted `resourceSafe=false`,
  classified `unknown/healthy/return-missing-positive-evidence`, quarantined the
  runner, failed cleanup-proof verification, and failed the aggregate.
- That battle test exposed two contract defects before merge: a run-specific
  `runner-id` prevented physical-runner recovery, and two diagnostic cleanup
  reasons were outside pinned v1.8.3's allowlist. Acquire/release now use stable
  `${{ runner.name }}` with run/job/matrix holder fencing, and classifier tests
  enforce the v1.8.3 allowlist plus confirmed/unknown cross-field rules.
- DAD-MACHINE's cancellation-race reservation
  `26ae1fad-a983-465b-b2e4-8d2053c15124` was proven pre-activation from the full
  log and recovered by exact ID in central run `29675750842`. ELI-MACHINE then
  completed a positive activation/build/entitlement-return/ULF-return cycle
  before its legacy reservation `050e7ab2-e4b9-43de-8989-5e61c30ee88f` was
  recovered by exact ID in `29676145270`. Reaper run `29676172709` left no
  queue, reservation, or incident from this work.
- A live `preflight-only` dispatch (`29674951750`) was green with the licensed
  matrix skipped. The full 15-leg matrix was not dispatched. Offline-runner
  behavior was exercised through the executable aggregate truth table instead
  of changing runner/organization policy.
- The lower bound for the selected issue was one paid smoke. Exploratory RCA,
  the positive recovery proof, the cancellation battle test, and two PR #11
  exact-head reviewer loops produced seven real activation cycles in total:
  `29674426435`, `29674932275`, `29675268466`, `29675374467`, `29675946418`,
  `29677090748`, and `29677308568`. Runs `29673952887`, `29675494659`, and
  `29675527191` reached licensed jobs but failed or stopped before activation and
  therefore added no paid Unity activation. No 15-leg matrix was run.

## Late review RCA and follow-up

- PR #10 was squash-merged as
  `ceb6418a89189136cbfc2f2d80024de2f41c1f11`; central issue #43 was closed with
  acceptance evidence. Its merge-commit Windows push run `29676230381` used
  zero Unity, Integrity `29676230482` passed, and orchestrator run `29676230394`
  passed.
- Acquire-cancellation race run `29675527191` had already logged the exact
  empty-reason rejection about 21 minutes before merge, but that signal was
  missed and misclassified while unwinding the runner race. Cursor delivered a
  valid PR #10 review thread 53 seconds after merge and correctly identified the
  cause: acquire failure/cancellation could invoke release while the cleanup
  classifier was skipped, producing an empty v1.8.3 reason and preventing lock
  cleanup. The session was reopened rather than treating the earlier thread
  audit as final.
- Follow-up PR #11 fixed the whole failure class. Classification and release now
  share every release-eligible acquire outcome; missing, partial, contradictory,
  or malformed classifier evidence is normalized to a schema-valid unknown
  tuple; inherited quarantine survives pre-build head rejection; and a green
  canary requires one successful build plus the exact
  `true/cleanup-confirmed` proof tuple. RC014 pins all wiring and expressions,
  including classifier/release execution after acquire success, failure, or
  cancellation. Data-driven PowerShell cases cover the resulting no-attempt
  state, failed/cancelled head guards, fresh and inherited quarantine, missing
  recovery evidence, retries, and unsafe return.
- Cursor's PR #11 review requested explicit precedence grouping in the release
  expressions. Commit `baaf8d3c66920f8940e3a042847e6e1b1a305ad8`
  parenthesized every branch and updated RC014. Cursor automatically resolved
  the thread and its exact-head rereview reported no new issues. Three local
  adversarial reviewers independently reported zero issues after each fix loop.
- PR #11 exact-head Windows runs `29677090748` and `29677308568` each completed
  one bounded paid smoke with successful activation/build, positive cleanup
  classification, lock release, and final proof; all retries were skipped.
  Integrity runs `29677090831` and `29677308605` passed. The second paid smoke
  was the reviewer-driven synchronize run; no full 15-leg matrix was dispatched.

## Reviews, merge, and default branches

- Cursor Bugbot and GitHub Copilot were tagged after every push and Copilot was
  also requested through the reviewer API. Copilot's available response was an
  explicit requester-quota exhaustion notice. The final PR #11 GraphQL audit
  found zero unresolved threads; Cursor's exact-head rereview found no new
  issues, and the original late PR #10 thread was replied to and resolved after
  the follow-up merged.
- Every local change passed three independent adversarial review loops with zero
  remaining issues. Final checks included actionlint, RC001-RC019, PowerShell
  classifier/activation tests, workflow-policy tests, 365 Vitest tests with two
  intentional skips, typecheck, formatting, and lint with zero errors.
- Follow-up PR #11 was squash-merged as
  `207d7039c3681a1cb24d8106d3ed198e2c1d6a4f`. Target `main` Windows push run
  `29677466940` succeeded with the licensed matrix and self-hosted preflight
  skipped, proving zero Unity on the default branch. Integrity run `29677467006`
  passed the repository suite and all orchestrator integration jobs.
- Central `main` remained green at `9a2923e4462bf187a364ad41af22943099b3e3fe`:
  Build lock CI run `29668602098` passed, and the final relevant reaper run
  `29677585543` passed. A post-reaper state read found no session-owned holder,
  queue, reservation, or incident; unrelated active consumer entries were left
  untouched.
