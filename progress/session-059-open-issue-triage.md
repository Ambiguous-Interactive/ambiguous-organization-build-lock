# Session 059: open-issue prioritization and carried-forward devcontainer delivery

Date: 2026-08-25

## Objective and invariants

Review the live open issues, prioritize them by impact while favoring the
least Unity CI churn, complete the highest-priority completable objective,
and preserve fail-closed licensed-resource safety, queue fairness,
recoverability, and operator-visible evidence.

## Baseline

- The live repository had 13 open issues and no open pull requests.
- `origin/main` was green at commit `300501e91c9bec81bb9b5a977c22aa5bb2d9b649`
  (PR #209); scheduled lock, recovery, reaper, and audit workflows were green.
- The working tree carried an unfinished-but-complete task from a previous
  session: `.llm/tasks/devcontainer-agent-clis.md` with its full validation
  record but no commit. It was committed and pushed as PR #210, which ran the
  complete hosted verifier green (amd64/arm64 build-and-verify, action-file
  validation, Windows evidence deletion, Bugbot).
- Every local unmerged branch corresponds to a previously squash-merged PR;
  no hidden substantive work remained.

## Prioritized inventory

| Priority | Issue | Reason and current disposition |
| --- | --- | --- |
| P1 owner-blocked | #188 | Least-churn hygiene item (removes the live `app-id` deprecation annotation observed on the 2026-08-25 enrollment-audit run). Requires owner-side provisioning of a `BUILD_LOCK_READER_APP_CLIENT_ID` secret holding the reader App client ID; switching workflows to a nonexistent secret would break fail-closed CI. Owner decision this session: treat as blocked until provisioned. |
| P1 constrained | #113 | High policy impact; remediation is reviewed workflow edits across five consumer repositories, i.e., exactly the Unity CI churn this goal minimizes. Central analyzers are green; findings remain external. |
| P2 churn-heavy | #60 | Literal cooldown 0 needs a release publication plus immutable re-pins in five consumer repositories before `config=0` becomes effective. Highest cross-repository Unity CI churn; deferred per the churn preference. |
| P2 maintainer-decision-blocked | #83 | Measured second-holder entitlement collision. The 2026-07-27 maintainer decision keeps `unknown/healthy/unity-return-400006` fail-closed and runner-quarantined until independently returnable Unity identities, both return orders, and portal reconciliation supply cleanup evidence; a benign-release classification change was explicitly declined. |
| P2 architecture | #53 | Pre-FIFO runner starvation needs a new admission protocol plus multi-repository two-runner load evidence. |
| P2 downstream | #49, #99 | Remaining scope lives in consumer repositories (compatibility-matrix policy; activation/return retry loops after #129 bounded acquire polling centrally). |
| P2 platform | #153 | Windows-container and Darwin trusted return authorities need new implementations, immutable SHA authorization, and paid canaries. |
| P3 gated | #44, #51 | Truthful aggregate rulesets and credential-scope containment need consumer ruleset enforcement, live negative probes, and organization-secret visibility changes beyond this repository's authority. |
| P3 live-ops | #29, #27, #30 | Seven-day monitoring windows, deliberate canaries, and umbrella closure depend on the items above and portal evidence. |
| Upstream-blocked | #94 | Re-checked 2026-08-25: actionlint v1.7.12 is still the latest release and does not compile against yaml/v4 rc.6; nothing to upgrade yet. |

## Dependency currency

- `go list -m -u` reports no available updates for the root module or the
  isolated `tools/actionlint` module as of 2026-08-25.
- The repository has no npm manifests; committed action runtimes are
  dependency-free by contract, so there are no JavaScript dependencies to
  update.

## Selected objective and evidence

No open issue could be completed this session without either an owner-side
secret value (#188), an upstream release (#94), explicit Unity seat time and
consumer churn (#60, #113, #83), organization-owner authority (#51, #44),
or multi-week live evidence (#29/#27/#30). Per the prioritization rule the
session therefore delivered the highest-value available work: the
carried-forward, fully validated devcontainer agent-CLI installation (PR
#210) plus this sanitized triage record. No issue state, lock semantic, or
fail-closed path was altered to manufacture progress.

## Disposition

- PR #210 merged with the complete hosted verification suite green.
- #188 remains open and ready: once the client-ID secret exists, the change
  is two minting steps, one policy-test pin, and documentation sync.
- #94 stays under upstream monitoring; recheck on the next actionlint
  release.
- All other issues retain their constraints above; none is represented as
  resolved by this record.
