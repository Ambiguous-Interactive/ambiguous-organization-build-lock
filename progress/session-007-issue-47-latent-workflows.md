# Session 007: Issue 47 latent-workflow removal

Status: dependent delivery verified; central merge queued

## Objective

Inventory every open issue by the minimum additional dependent-project Unity CI
needed, select the highest-priority fully feasible issue or related group, and
deliver it through green review, merge, and default-branch verification without
changing organization policy.

## Constraints

- Prefer the GitHub connector, then Git, then `gh`.
- Request Cursor Bugbot and GitHub Copilot after every push and address every
  non-trivial result.
- Use red-green evidence and adversarial review.
- Minimize paid/licensed Unity activations.

## Preflight

- Central repository start: `3049a52b97ed59f5641aa4e6762f5611b72fa7f9`.
- Open issues at start: #27, #29, #30, #42, #44, #47, #48, #49, #51, #52,
  #53, #54, and #60.
- The original checkout was clean on unrelated branch
  `dev/wallstop/bug-fixes-3`; its one commit remains untouched. Delivery uses
  `agent/session-007-minimal-unity-ci` from `origin/main`.
- No zero-run issue is both incomplete, fully autonomous, and compatible with
  the no-organization-policy-change constraint. Issue #54's GitHub-side canary
  evidence completed naturally, but GitHub cannot provide its required fresh
  Unity portal inventory. Issue #47 is therefore the first fully autonomous,
  policy-compatible scope.

## Prioritized issue inventory

The ordering favors zero or minimal additional paid Unity work, autonomous
completion, safety impact, and bounded scope. Counts are lower bounds.

| Priority | Issue | Minimum additional dependent Unity work | Disposition |
| ---: | --- | ---: | --- |
| 1 | #47 latent Dx workflows | 20 paid legs | Selected as the first fully autonomous scope. Dx exercises a 9-leg PR matrix, then a 9-leg default-branch matrix plus two default-branch performance jobs. |
| 2 | #54 Isho cleanup canary | 0 new GitHub runs | Existing run `29677651545` supplies the technical proof, but fresh value-free Unity portal inventory is an external acceptance blocker. |
| 3 | #48 bounded macOS canary | At least 2 paid legs | Requires the mandatory Windows PR smoke plus one macOS canary, with unproven macOS return/recovery and a fresh portal check. |
| 4 | #49 helper matrix throughput | At least one reduced PR wave plus a 15-leg sweep | Full compatibility proof is an explicit acceptance criterion. |
| 5 | #60 literal zero cooldown | Five consumer suites plus a cross-runner canary | Requires a release, five immutable repins, and live handoff monitoring. |
| 6 | #52 cancellation safety | Multiple consumer suites and three live canaries | Draft PR #56 is stale and consumer rollout remains broad. |
| 7 | #53 pre-FIFO starvation | At least three cross-repository/two-runner probes | Requires an admission redesign and real load/fairness evidence. |
| 8 | #29 lifecycle monitoring | Multiple canaries plus seven days | Operational program, not one bounded PR. |
| 9 | #27 lock-held regression | Coupled to #29 | No independent closure path. |
| 10 | #30 rollout tracker | Superset of all remaining children | Umbrella tracker closes last. |
| 11 | #42 enrollment audit | Nominally 0 activations | Pre-merge gates require App installation and organization-secret visibility changes prohibited by this session. |
| 12 | #44 truthful aggregates | Multiple consumer suites | Completion requires repository ruleset changes prohibited by this session. |
| 13 | #51 credential scope | Variable, potentially 0 activations | Its core objectives are organization App/secret policy changes and therefore explicitly out of scope. |

## Rejected zero-new-run candidate #54

- IshoBoy trusted-main Unity run `29677651545` executed at exact commit
  `44cf7060d8abd2027cc6d2601a2035f059c64155` and completed green.
- Reader-App self-hosted-runner preflight passed.
- The EditMode job ran on `ELI-MACHINE`, acquired the organization lock, ran
  94 tests with 94 passed and zero failed/skipped, used the private
  `${{ runner.temp }}/unity-return-EditMode.log` path, returned positive cleanup
  evidence, and released with reason `cleanup-confirmed`.
- Repository assembly discovery is data-driven. It found two Editor-only test
  assemblies, emitted `editmode_has_tests=true` and
  `playmode_has_tests=false`, and the PlayMode job completed its explicit
  `Skip PlayMode tests (no assemblies)` policy step. Its credential validation,
  acquire, Unity execution, return, release, result verification, and upload
  steps were all skipped, so it performed no paid activation and did not imply
  a PlayMode canary ran.
- `Unity CI Success`, both cleanup jobs, compile, and runner preflight passed.
  The workflow contains no `environment:` gate.
- The run published only `unity-EditMode-results` and compile diagnostic
  artifacts. Downloaded contents contain no `unity-return-*` file, no email-like
  value, no private-key marker, and no named Unity credential marker; GitHub
  masking placeholders remain where expected.
- The live schema-5 lock read showed no active incident, no queue, and no
  reservation/quarantine. Unrelated active holders from qora-redux were left
  untouched. Combined with the exact positive same-runner return evidence, the
  canary created no unexplained activation.
- Focused local policy validation passed: 12/12 workflow lifecycle contract
  tests, 38/38 assembly-discovery tests with one intentional platform skip, and
  34/34 assembly-flag composition tests.
- No new IshoBoy workflow or paid Unity run was triggered during the audit.
- Strict adversarial review rejected closure because lock state and positive
  return evidence cannot directly establish the external Unity portal inventory.
  The issue remains open.

## Selected issue #47 implementation

- Repository: `Ambiguous-Interactive/DxMessaging`.
- Starting default-branch commit: `0f39c21b69d62ba3696fefe48c36c0dbbbc16e20`.
- Branch: `agent/issue-47-remove-latent-workflows` in an isolated worktree; the
  existing DxMessaging checkout and its user state remain untouched.
- Red first: the expanded repository policy validator detected exactly the two
  credential-bearing files under `.github/workflows-disabled/` and failed.
- Green: deleted the two obsolete duplicates. The active enrolled
  `.github/workflows/unity-tests.yml` and `unity-benchmarks.yml` remain unchanged.
- The existing Unity PR-policy validator now recursively reads every YAML file
  under `.github`, classifies credential/GameCI activation markers against an
  exact reviewed registry, and rejects an unregistered file even if it is moved
  into the active workflow directory.
- Data-driven embedded cases cover all current and retired Unity credential
  markers, all activation-capable GameCI actions, registered active workflows
  and cleanup actions, disabled/copied files, mixed-case YAML extensions, and
  unrelated YAML.
- Deleting a tracked workflow exposed a repository test that passed index entries
  from `git ls-files --cached` directly to `statSync`. It now ignores paths absent
  from the worktree, matching the repository's existing deleted-file handling and
  preventing deletion PRs from failing before staging.
- Full local policy validation passed: `validate:all`, analyzer reproducibility,
  247 script tests except two unrelated Windows-host baseline constraints,
  focused design-system tests, Prettier, pre-commit, and diff hygiene. The two
  baseline constraints are a symlink-privilege test and a WSL `bash -n` path
  conversion test; both are exercised in their supported Linux CI environment.

## Review and delivery

- DxMessaging PR #282 used exact head
  `a49a558ecbcc7ea6600657164f240cf529d34977`. Cursor Bugbot reported zero
  issues for that SHA. GitHub Copilot was requested through both reviewer and
  tagged-comment mechanisms and reported that its reviewer quota was exhausted;
  it supplied no actionable feedback. The thread-aware review inventory was
  empty.
- All exact-head PR checks passed, including Linux, Windows, and macOS script
  tests, devcontainer validation, actionlint, the Unity aggregate, and the full
  3-version by 3-mode Unity matrix in run `29695726376`.
- PR #282 was squash-merged through the GitHub connector as
  `b859aaaf348ab0938312a0716642b5ab51c2c9b8` only after that exact-head proof.
  Default-branch static CI, devcontainer validation, and release drafting passed.

## Default-branch RCA and fail-closed follow-up

- Default-branch Unity run `29696231385` exposed a pre-existing active schema-5
  account incident, `incident-08d2ae36d87d05ac56c5b448`, reported by
  qora-redux run `29694913080` on `DAD-MACHINE` for
  `unity-account-limit-20111`.
- The central acquire action correctly returned `acquired=false` and
  `admission-result=account-blocked`, but its output-oriented interface keeps
  the step successful so callers can inspect the result. All six Dx licensed
  windows failed to inspect it and could therefore start Unity without owning
  the lock. Unity 2021 PlayMode retried 20111 until its bounded budget expired;
  this was a production workflow bug, not a test failure.
- The remaining already-red Unity and performance jobs were canceled to avoid
  further unsafe paid activations. Post-cancellation state has no holders or
  queue entries and no new reservation. The existing DoxReloaded
  `unity-return-400006` quarantine remains untouched.
- DxMessaging PR #283 fixes the full class across six lock windows in five
  workflows. Each acquire has a stable ID, blocked or missing admission causes
  an immediate nonzero guard, licensed work independently requires exact
  `acquired=true`, and return/release cleanup remains unconditional.
- Red-first policy evidence failed because no window had the guard. The
  data-driven green contract inventories all six windows, distinguishes five
  expected-empty paths from the release export, and requires the exact empty
  predicate on both the guard and licensed-work step. Local `validate:all`,
  13/13 focused lifecycle tests, Prettier, pre-commit, and adversarial review
  pass.
- Cursor's first review found that the policy did not protect the expected-empty
  conjunct. Exact head `84e80c2bac2f9b229691fefa6242b8325036dcc6`
  addresses that feedback; the thread was resolved and the exact-head Cursor
  rereview reported zero issues. Copilot was requested after both pushes and
  reported quota exhaustion without actionable feedback.
- Portal reconciliation confirmed the exact incident was externally clean.
  Guarded recovery run `29696967498` used `operation=recover-incident`, the
  exact incident ID, and `portal-cleanup-confirmed=true`; central history commit
  `c6b5911c` records the recovery. The pre-existing Dox quarantine was separately
  recovered only after equivalent portal proof.
- PR #283's exact-head full 3-version by 3-mode run `29697187657` passed, along
  with static CI, both automated reviewers' available results, thread-aware
  review inventory, and adversarial review. It was squash-merged as
  `35fc35f721dc682a1f5ab105d61f8db1b3754a4b`.

## Cancellation-cleanup RCA and full-class fix

- A superseded default-branch matrix was canceled only after its remaining work
  became redundant. Unity itself returned the entitlement successfully, but the
  cleanup classifier rejected Unity's canonical prefixed ULF diagnostic,
  `[Licensing::Module] Error: Serial number unavailable for ULF return; skipping operation`,
  and created reservation `926c489d-2984-46de-8b72-456422911bd7` with
  `return-missing-positive-evidence`. Exact job logs supplied the required
  same-runner positive proof, and guarded recovery run `29699406532` removed
  only that reservation.
- DxMessaging PR #284 fixes the entire cleanup-evidence path. It accepts the
  observed canonical ULF line without weakening the required two-signal proof
  or known-termination exclusions, ports account-health classification from
  Python to PowerShell for every enrolled Windows runner, preserves bounded and
  sanitized evidence discovery, and makes composite outputs fail closed unless
  account health and return safety are both exact successes.
- Data-driven tests cover canonical, legacy, explicit ULF, near-miss, and all
  known termination results; recursive evidence discovery also covers trimmed
  input, case-distinct Linux paths, exact `20111` boundaries, deterministic
  digests, and sanitized diagnostics. Local policy validation, formatting,
  actionlint, and the supported Linux CI suite passed.
- The first adversarial pass found the production classifier gap and a latent
  fail-open composite output. The second found case-insensitive path collapse
  and input-whitespace parity. After correction, final adversarial review found
  zero issues. Exact PR head
  `7794e54f238d3ad14578144b64e0cd1ab6d178b4` passed static CI and the full 3x3
  Unity run `29700041599`; Cursor reported zero issues, Copilot reported quota
  exhaustion, and no review threads remained. PR #284 was squash-merged as
  `0fdc3de6e8d2eec92a5fafaf15af3c374aa9b0d5`.

## Final Dx default-branch verification

- Performance run `29701726990` passed both Unity 6 benchmark modes and safely
  auto-committed only generated throughput documentation, advancing `master` to
  `c257e4ff37e5c53359e50245c8b01349de6d5dc5`.
- The prior code-head run completed six green paid legs. After the generated-doc
  commit created the authoritative latest-head matrix, the superseded run was
  canceled during an observed zero-active handoff, saving its remaining three
  paid Unity legs without interrupting cleanup.
- At exact current `master` commit `c257e4ff37e5c53359e50245c8b01349de6d5dc5`,
  static CI run `29703432444`, documentation deployment run `29703432437`, and
  Unity run `29703432451` all passed. The Unity run completed all nine version
  by mode legs and all 12 jobs green. No duplicate manual run was dispatched.
- A later unrelated DoxReloaded `unity-return-400006` quarantine remains
  untouched because this session has no matching Dox portal proof.

## Central enrollment audit extension

- Added a daily and manually dispatchable, zero-Unity audit of DxMessaging's
  current default branch. The job records the exact audited commit in its step
  summary, retains only `contents: read`, disables persisted checkout
  credentials, uses a stable non-canceling concurrency group, and pins every
  remote action to a reviewed commit SHA.
- Extended the existing Go workflow audit with an explicit
  `unity-automation` subcommand and exact reviewed-path registry. It scans every
  YAML file recursively under `.github`, including mixed-case extensions, for
  current/retired Unity credential names and activation-capable GameCI actions.
- The audit fails closed for an absent or non-directory target, a missing
  `.github`, invalid command arity, an empty registry with a discovered marker,
  and any unregistered match. Diagnostics contain only sanitized paths, never
  source text or credential values.
- Red-first evidence included the two latent Dx paths and initially undefined
  central policy functions. Green validation includes `go test ./...`, all 375
  Node policy tests, actionlint, module verification/tidy checks, direct audit
  against the exact Dx branch, and diff/gofmt hygiene.
- The adversarial loop first found incomplete marker/extension coverage and the
  missing central audit. A second pass found ambiguous CLI dispatch and a stale
  hard-coded default-branch ref. After fixes and regression tests, the final
  adversarial pass reported zero issues across both repositories.
- Central PR #72 exact head `0754dee6a1a723820832b4ce7f9c6b02ceb72290`
  had zero-Unity CI green, Cursor zero-issue review, no review threads, and a
  Copilot quota-exhausted response before this final evidence refresh. Dx
  recovery, both fail-closed follow-ups, and current-default-branch verification
  are now complete.
- Remaining central-only steps are the final evidence push and reviewer/check
  cycle, merge, `main` verification, live zero-Unity audit of Dx's exact current
  default commit, and issue closure confirmation.
