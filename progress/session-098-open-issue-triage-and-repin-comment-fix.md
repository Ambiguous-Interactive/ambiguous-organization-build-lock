# Session 098: open issue triage and repin comment fix

Date: 2026-09-26. The worktree started clean at `f070452d3`, equal to
`origin/main`. The GitHub connector reported 14 open issues and no open pull
requests in this repository.

## Task and safety rules

Review every open issue. Rank by impact and prefer work with low licensed
Unity CI churn. Complete the highest-priority issue that has a safe, evidenced
fix, open a pull request, and drive it through checks and review.

Preserve these rules: do not change organization policies; do not weaken the
fail-closed lock paths; keep licensed concurrency and cleanup behavior
unchanged; record only sanitized facts.

## Issue priority

Priority uses three factors: impact if unresolved, available evidence and
authority, and expected licensed Unity CI churn. P0 means high impact. P1
means material impact or a central dependency. P2 means contained impact or
an unresolved cause. “Blocked” names a missing prerequisite, not low impact.

| Priority | Issue | Impact and evidence | Decision |
| --- | --- | --- | --- |
| P0, blocked | #51 | Broad writer and Unity secret visibility raises the largest security risk. The issue requires owner-authorized inventory and organization secret changes. | Do not change organization policy. Keep the owner-authority requirement explicit. |
| P0, evidence gated | #83 | Two holders can contend for one entitlement return and create false red cleanup. Safe closure needs measured identities, both return orders, portal proof, and consumer rollout. | Preserve quarantine and existing capacity. Do not guess at seat semantics. |
| P0, root cause open | #113 | The current alert reports two missing aggregate findings on DoxReloaded. The cited commit's workflow file contains `ci-success` with the central validation action. | Reproduce why the analyzer rejects that shape before editing consumer policy or the analyzer. |
| P0, authority gated | #44 | Missing required Unity aggregates can allow merges without a completed Unity result. Enforcement requires owner-level ruleset changes across consumers. | Keep the authority and staged-enforcement prerequisites. |
| P1, live evidence gated | #269 | An editor assertion with zero failed test leaves can turn a clean revision red. The peer timeline is available, but the remaining consumer correlation and retry policy need live evidence. | Do not add licensed retries without consumer evidence and a bounded acceptance rule. |
| P1, multi-week evidence | #29 | Lifecycle canaries and monitoring provide the final proof for recovery and capacity behavior. | Continue only with the listed owner, portal, and live-window evidence. |
| P1, platform evidence gated | #153, #229 | Darwin and container returns need native platform and container proofs. They affect licensed integration coverage. | Keep the paths fail closed until exact-head platform canaries pass. |
| P1, authorization gated | #231, #249 | Darwin return admission needs a measured Application team ID, an authorized release SHA, and a native macOS canary. | Do not populate the allowlist from an Installer identity or inference. |
| P1, design and load evidence | #53 | Runner starvation occurs before FIFO admission. A fix needs a fail-closed design, synthetic multi-repository tests, and real load evidence. | Do not add capacity or move license activation before a real runner claim. |
| P1, direct regression | #283 | A new version comment uses one space before `#`; yamllint rejects 22 changed lines on Linux and Windows, blocking a consumer repin PR. The fix is central and does not change licensed jobs. | Selected: fix the writer, pin the spacing contract in tests and docs, then verify the full repository. |
| P2, premise refuted | #278 | Session 097 traced the cited lock records to successful acquisition and normal release. The remaining editor teardown report lacks its original suite log. | Do not implement wait-and-queue from the disproven collision claim. Keep the editor issue with the consumer evidence request. |
| P2, attribution unavailable | #277 | GitHub's retained run data does not identify the canceller for the cited API-ambiguous cancellation. | Retain the RCA. Revisit diagnostics if an event source exposes actor evidence. |

This ranks raw impact first and then identifies the highest-impact work safe to
do now. #51, #83, #113, and #44 have greater potential impact than #283, but
their evidence or authority gaps prevent a safe patch in this session. #283 is
the highest-priority ready fix with low licensed CI churn.

## Hypothesis and baseline

Hypothesis: `rewritePinLine` writes the one-space form for new or updated
version comments, and its tests require that form. Two spaces should satisfy
yamllint's default comment spacing while preserving recognition of either
existing spacing.

Evidence before the change:

- Issue #283 reports 22 yamllint failures on both Linux and Windows.
- `tools/workflows/repin-consumer-locks.sh` builds the comment as
  `${targetSha} # ${targetVersion}`.
- The data-driven rewrite test expected one space for missing and existing
  version comments.
- The root issue search found no open or draft PR in this repository.

The test was changed first to require two spaces. The focused test failed on
the old output, with actual one-space text and expected two-space text.

## Change

- The writer emits two spaces before a generated or updated `# vX.Y.Z` label.
- The pin matcher already accepts one or more spaces before a comment. The
  regression matrix now proves one-space and two-space input both normalize
  to two spaces when the version label changes.
- Existing target pins keep their exact shape. Non-version comments and
  unknown-version comments keep their existing bytes.
- Consumer enrollment and operations docs state the spacing contract.
- No action runtime, Unity workflow, lock policy, organization policy, or
  consumer repository changed.

## Validation

The focused regression failed before the implementation and passed after it.
The first full verifier run found stale one-space output expectations in the
workflow test suite. Those expectations and the current-format orphan-branch
fixture were updated. No production behavior beyond comment spacing changed.

`bash .devcontainer/scripts/verify.sh` passed after the fixture updates:

- LLM harness checks passed.
- All 906 Node tests passed, with 6 architecture-gated skips.
- Go tests, vet, and race tests passed.
- actionlint, JavaScript CI, ShellCheck CI, both module verifies, both tidy
  checks, and the workflow credential audit passed.
- `git diff --check` passed.

## Review and follow-up

The review loop used separate roles: the main thread implemented the change,
an independent agent reviewed it, and a different agent applied the justified
documentation remediation.

The main-thread adversarial pass compared the change with the issue
acceptance and the full writer, test, docs, and caller behavior:

- The writer accepts one or more spaces before comments and emits two for a
  new or updated version label.
- A pin already at target remains byte-identical. Witness comments and
  version labels without a known target keep their original spacing.
- The offer flow still refuses to update a remote branch with different
  content. The runbook now states that an orphan from the earlier spacing
  format needs one-time deletion.
- No lock lifecycle, licensed workflow, action runtime, secret, or merge
  policy path changed.

The independent reviewer found one P2 documentation gap: an existing open
same-target repin pull request is intentionally left unchanged, so its old
formatting can remain red. A separate remediator updated the runbook with the
manual correction for that existing branch. The full verifier passed on the
remediated state.

In the next review pass, the independent reviewer confirmed the open-offer
remediation and found no runtime or safety issues, but noted stale
future-tense validation wording in this record. The remediator corrected the
wording to report the completed verifier run and distinguish it from checks
run during the documentation-only edit. The final review confirmed that
chronology and found no remaining issue.

The external consumer PR that reported the lint failure must still be checked
after this central fix is merged. A scheduled or dispatched repin run must
show two spaces in its generated output. The PR must pass every GitHub check,
receive review feedback, and merge before this session is complete.

## PR #284 independent review finding and remediation

- Independent reviewer finding (P2): an open same-target repin pull request is
  not duplicated, but the runbook did not say that automation leaves its
  existing branch unchanged. An older offer with one-space version comments
  can therefore keep failing yamllint after the writer fix.
- Remediator: a separate agent updated `docs/operations-runbook.md` to require
  the maintainer to push the two-space correction to that existing pull
  request branch. The text preserves the rule that automation does not
  rewrite an open pull request branch.
- Disposition: accepted. Documentation only; workflow code was not changed.
  No separate checks were run for this documentation-only remediation.
  `bash .devcontainer/scripts/verify.sh` was rerun afterward and passed.
