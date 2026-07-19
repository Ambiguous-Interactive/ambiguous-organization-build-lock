# Session 008: Account-incident fail-closed regression

Status: local implementation and adversarial review green; PR delivery pending

## Objective

Inventory every open issue by impact and minimum additional Unity CI churn,
resolve the recovered account-incident report in issue #73, and eliminate the
related current-main compatibility regression before any consumer repins to the
next release.

## Constraints

- Prefer the GitHub connector, then Git, then `gh`.
- Do not change organization policy or mutate live lock state outside the
  supported operator workflow.
- Request Cursor Bugbot and GitHub Copilot after every push and address every
  non-trivial result.
- Use red-green evidence and iterative adversarial review.
- Minimize paid/licensed Unity activation churn.

## Preflight

- Central repository start: `f17f2607d1a1cccd18e4772d817a26c1f94adda9`.
- Delivery branch: `agent/session-008-incident-diagnostics`, created directly
  from `origin/main` so the unrelated local branch
  `dev/wallstop/bug-fixes-3` remains untouched.
- The checkout contains pre-existing untracked files under `progress/`; they are
  excluded from this delivery by explicit-path staging.
- Open issues at start: #27, #29, #30, #42, #44, #48, #49, #51, #52, #53,
  #54, #60, and #73.
- The latest central default-branch `Build lock CI` run `29704873080` passed.
- No new Unity job is required for the selected central action/test scope.

## Selected issue and related regression

- Issue #73 reported a Qora acquire denial caused by schema-5 global incident
  `incident-08d2ae36d87d05ac56c5b448`.
- The incident originated from confirmed `unity-account-limit-20111` evidence
  in Qora run `29694913080` on `DAD-MACHINE`. The denial was correct fail-closed
  containment.
- Portal-confirmed exact-ID recovery committed state at `c6b5911c`, and the
  referenced Qora run `29696198660` completed successfully on attempt 4. The
  current lock state has no active incident, holders, or queued requests.
- A full-class sweep found a related regression on current `main`: blocked
  acquire writes `acquired=false` and `admission-result=account-blocked`, then
  returns success. The currently pinned `6b2147a1` action throws after writing
  those outputs. Qora has an unguarded licensed step, so a future #60 repin to
  the current behavior could activate Unity without owning the lock.
- Selected fix: restore nonzero fail-closed behavior after preserving typed
  outputs, add sanitized incident provenance and exact recovery guidance, and
  lock the contract with data-backed tests. This uses hosted/static CI only.

## Prioritized issue inventory

The ordering weights safety/security impact, autonomous completion without
organization-policy changes, and the minimum incremental licensed Unity work.
Counts are lower bounds; evidence-only closure work is listed as zero churn.

| Priority | Issue | Minimum additional Unity churn | Disposition |
| ---: | --- | ---: | --- |
| 1 | #73 account incident / current-main fail-open regression | 0 | Selected. The reported incident is recovered; the related release-blocking regression is high-impact and fully central. |
| 2 | #52 automatic cancellation safety | About 20 post-merge consumer legs if existing exact-green PR heads remain untouched | Next autonomous safety rollout. Avoid rebasing already-green consumer heads merely for review churn. |
| 3 | #54 Isho cleanup canary | 0 | Existing successful runs provide technical evidence; fresh external portal evidence remains the closure boundary. |
| 4 | #42 continuous enrollment audit | 0 for central static audit work | High-impact defense in depth, but full acceptance includes App/secret scope controls outside this session. |
| 5 | #44 truthful required aggregates | Multiple consumer suites | High correctness impact; enforcement also requires repository policy changes prohibited here. |
| 6 | #51 credential/App scope | Near 0 plus bounded probes | Critical security control, but its core organization policy mutations are explicitly out of scope. |
| 7 | #48 macOS unity-builder canary | At least one paid macOS leg plus the required Windows smoke | Bounded if an enrolled macOS runner and portal evidence are available. |
| 8 | #49 unity-helpers matrix throughput | At least one reduced PR wave plus the 15-leg compatibility sweep | Valuable throughput work with high licensed churn. |
| 9 | #53 pre-FIFO runner starvation | At least three cross-repository/two-runner probes | Architectural redesign and real-load evidence required. |
| 10 | #29 lifecycle monitoring | Multiple deliberate canaries plus seven days | Operational program; the 2026-07-19 `20111` resets the zero-incident window. |
| 11 | #27 lock-held regression | Coupled to #29 | No independent closure path; retain as the incident regression gate. |
| 12 | #60 literal zero cooldown | More than 25 consumer legs plus a cross-runner canary | Unsafe to advance immediately after a confirmed `20111` at the transitional one-second setting; this PR is a prerequisite to any repin. |
| 13 | #30 rollout tracker | Superset of all remaining children | Umbrella tracker closes last. |

## Red-green implementation

- Baseline focused test passed because it asserted only typed outputs and no
  state write; it did not require acquire to fail.
- Red: the expanded contract produced five failures, including missing
  rejection on initial denial, queue cleanup, incident-during-wait,
  post-admission retraction, and cleanup failure.
- Green production behavior now:
  - writes `acquired=false`, typed incident health/reason, and the exact incident
    ID before returning nonzero;
  - cleans only the caller's exact queued identity when an incident appears;
  - retracts a holder admitted immediately before an incident and restores an
    exact same-runner quarantine if admission had reclaimed it;
  - reports `account-blocked-cleanup-failed` when cleanup cannot be confirmed;
  - preserves unrelated holders, queue entries, reservations, and the incident;
  - emits one sanitized error path with immutable source-run provenance and the
    exact portal-confirmed recovery inputs.
- Both acquire manifests document the expanded `admission-result` contract.
- README and the steady-state runbook document nonzero blocked admission,
  pre-activation cleanup, and the prohibition on manual state edits.

## Out-of-scope finding

- Opened `Ambiguous-Interactive/DoxReloaded#167` for default-branch run
  `29703754825`, which stayed green after `unity-return-400006` correctly caused
  a runner quarantine. The issue requires truthful aggregate failure without
  weakening the classifier or quarantine.

## Validation and delivery

- Focused incident/race/cleanup-failure contract: 7/7 passed.
- Full Node suite: 383/383 passed.
- Go tests, module verification, and tidy checks passed for the production and
  isolated actionlint modules.
- Actionlint, JavaScript syntax checks, workflow credential-literal audit, and
  diff hygiene passed.
- Two independent implementation/adversarial review loops reached zero local
  findings; the final adversarial pass also reran the seven focused cases.
- Pending PR review, CI, merge, and default-branch verification.
