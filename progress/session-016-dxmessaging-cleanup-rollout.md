# Session 016: DxMessaging central cleanup rollout

Date: 2026-07-27

Status: complete; consumer merged, reviewed, and default branch green

## Objective and boundary

Review every open issue, prioritize impact while minimizing licensed Unity
churn, and complete the highest-impact remaining autonomous scope.

Issue #85 is selected for its final consumer rollout. DxMessaging had five
licensed workflows and six lock windows that still classified Unity cleanup
locally. This change preserves their existing native PowerShell commands and
matrix shapes while making the central actions at
`673eb65e7d863a1a8a8a70882bd980e189d41754` authoritative.

No organization policy, lock schema, capacity, credential scope, Unity version,
or matrix row changed.

## Open-issue priority

All 19 open issues and all open/draft pull requests were reviewed through the
connected GitHub App. There was no open dependency pull request.

| Priority | Issues | Impact and churn assessment |
| --- | --- | --- |
| P0 owner-constrained | #51 | Highest credential-boundary risk, but it requires owner organization-secret policy changes that this task explicitly prohibits. |
| P0 evidence-constrained | #83, #84 | False quarantine remains production-impacting, but `400006` cannot safely prove cleanup without two independent entitlement identities, both return orders, and portal reconciliation. |
| P0 selected | #85 | Central policy and three planned migrations were green; DxMessaging was the remaining active consumer with six local-classification lock windows. |
| P1 constrained | #42 | The privileged cross-repository enrollment audit was intentionally rejected until the #51 credential-scope gate is resolved. |
| P1 | #53 | Pre-FIFO starvation affects fairness but needs a two-phase architecture and cross-repository load evidence. |
| P1 | #44 | Aggregate required-check work spans consumers and rulesets, creating broader rollout churn than the selected migration. |
| P2 operational | #29, #30, #54, #60 | These require paid canaries, a monitoring window, or a cooldown configuration change rather than an autonomous code-only delivery. |
| P2 engineering | #49, #99, #100, #101, #102 | Throughput, timing, extraction, parallel-test, and TypeScript work are lower-impact or broader than the bounded safety rollout. |
| P3 investigate/close | #27, #79, #94 | The old lock report needs refreshed evidence; `Date.now()` is already UTC epoch time; the yaml/actionlint upgrade remains compatibility-gated. |

## Implementation and dependency result

DxMessaging PR #291:

- delegates bounded return and account-health evidence to the central
  `classify-unity-cleanup-evidence` action;
- passes typed classification outputs through central release and the final
  `require-confirmed-unity-cleanup` gate in all six lock windows;
- writes Unity return output only to private runner-temp files and deletes those
  files after classification;
- removes both duplicated PowerShell classifiers and their obsolete package
  validation command;
- adds lifecycle, pin, evidence-retention, and negative local-classifier
  contracts; and
- updates direct development dependencies from `markdownlint-cli2` 0.23.0 to
  0.23.2 and Prettier 3.9.4 to 3.9.6. Cspell 10.0.1 was already current.

`npm outdated --json` returned no outdated direct dependency, and a temporary
generated lockfile passed `npm audit --audit-level=low` with zero
vulnerabilities before being removed. The central production Go module is
current. The isolated actionlint module remains pinned to actionlint v1.7.12;
its advertised yaml/v4 and unused transitive updates are the compatibility case
tracked by #94 rather than safe standalone dependency changes.

## Validation and review

Local validation passed:

- 238 Node tests, with nine PowerShell-dependent cases skipped because
  PowerShell was unavailable and zero failures;
- 13 focused workflow-policy tests;
- actionlint over every workflow;
- formatting, Markdown, spelling, Unity version and PR policy, package/meta,
  banner, generated-index, and 13,695/13,700 JavaScript line-budget checks; and
- `git diff --check`.

Windows CI subsequently ran the previously unavailable PowerShell tests
successfully.

The continuous-improvement loop used a main-thread fallback because this
session did not authorize sub-agent delegation. The first adversarial pass found
dead local classifier copies; remediation removed them. Cursor Bugbot then
found that attested prior evidence could be omitted from fallback health
classification and deletion. Commit
`fb112e8c21874200622af49c1ee46eb58c7eaaca` retains that file in supplemental
evidence unconditionally and adds a regression contract. The finding was
resolved with a written disposition. Fresh local validation passed, and Cursor
Bugbot reviewed that exact head with no new issue or unresolved thread.
Copilot was requested after both pushes and reported exhausted reviewer quota
both times.

No new durable guidance was promoted: private licensing-log handling and
central policy ownership were already documented. The precise fallback
invariant is retained in executable regression coverage and this record.

## Delivery and default-branch verification

PR #291's exact final head ran green in:

- CI run `30242098130`;
- Test Devcontainer run `30242098136`;
- Prettier Auto Fix run `30242098113`; and
- Unity Tests run `30242098126`, including all nine Unity
  2021/2022/6000 editmode, playmode, and standalone cells.

An earlier queued Unity run for the superseded head drained through the
`require-current-pr-head` rejection before checkout, acquisition, or Unity
launch. Its failures were expected stale-run safety behavior, not licensed
execution or a product regression.

PR #291 was squash-merged with an exact-head fence as
`f3182c5f1527a7d2b8335a00294979cab504f255`. Push-triggered Unity run
`30244986780` then passed all nine cells and its aggregate gate on that merge
commit.

Repository automation advanced `master` through the expected `llms.txt` and
performance-document refreshes. The exact current tip
`d6fdd531444baa330619538ed1e909439f3d62ca` passed CI run `30248555258`,
Release Drafter run `30248555221`, Deploy Documentation run `30248555386`, and
Sync Wiki run `30248555677`. The generated performance-only commit correctly
did not start another Unity matrix.

Issue #85 can close: the central classifier and final gate are active in all
identified consumer migrations, including DxMessaging's six remaining lock
windows.
