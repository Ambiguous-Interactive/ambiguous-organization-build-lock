# Session 046: open-issue prioritization and issue 160 closeout

Date: 2026-08-02

## Objective and invariants

Review the live open issues, select the highest-impact objective that can be
completed without unnecessary Unity CI churn, and preserve fail-closed
licensed-resource safety, queue fairness, recoverability, and public evidence.

## Baseline

- The live repository had 14 open issues and no open pull requests.
- `origin/main` was green at commit `1f31641ac278f1b6f4fa5a802d5ab7e5abbc8e8c`.
- Issue #160's implementation and immutable approval were already merged by
  PRs #161 and #162; the issue itself remained open.
- The latest enrollment audit run succeeded but retained 114 external consumer
  findings, so a central closeout cannot truthfully claim #113 complete.
- The actionlint dependency issue remains upstream-blocked: v1.7.12 is the
  latest release and still selects yaml/v4 rc.3.

## Prioritized inventory

| Priority | Issue | Reason and current disposition |
| --- | --- | --- |
| P0 constrained | #113 | High policy impact, but 114 findings require reviewed consumer-repository changes and exact external evidence. |
| P0 constrained | #83 | Live entitlement collision risk; safe completion requires independent identities, both return orders, and portal proof. |
| P0 owner-constrained | #51 | Credential/App scope requires owner-authorized organization policy changes, outside this session's authority. |
| P1 | #160 | Consumed return evidence deletion is implemented and approved; only auditable issue closeout remained. Selected. |
| P1 | #44 | Truthful required checks require consumer ruleset enforcement and repository policy changes. |
| P1 architecture | #53 | Pre-FIFO runner fairness needs a new admission protocol and multi-repository load evidence. |
| P2 | #153 | New Windows-container and Darwin cleanup authorities require platform implementations and paid canaries. |
| P2 | #49 | Compatibility-matrix reduction needs measured consumer timing and automatic full-sweep evidence. |
| P2 | #29, #27 | Coupled live canaries and a seven-day monitoring window remain incomplete. |
| P2 | #99 | Acquire polling improved in #129; exhaustive activation/return timing evidence remains unverified. |
| Safety-blocked | #60 | Zero cooldown remains dependent on resolving the #83 shared-entitlement return risk. |
| Upstream-blocked | #94 | No compatible actionlint/yaml upgrade is available at the current upstream release. |
| Operational tracker | #30 | Umbrella closure depends on the child issues and owner evidence above. |

## Selected objective and evidence

Issue #160 is selected because its central implementation satisfies the
specified deletion boundary and its reviewed immutable release is live. The
repository's focused tests cover exact path models, symlink/reparse and path
escape rejection, identity mutation, deletion failure, post-delete presence,
and suppression of completed outputs on failed deletion. The closeout PR adds
this sanitized prioritization and evidence record; it does not alter licensed
consumer workflows or lock semantics.

## Validation and disposition

The focused and complete checks run for the closeout are recorded in the PR.
After the closeout PR is merged, issue #160 can be closed with links to PRs
#161/#162 and this record. The remaining issues stay open with the constraints
above; no issue is represented as complete merely because its central audit or
test suite is green.

