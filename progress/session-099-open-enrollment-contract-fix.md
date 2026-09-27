# Session 099: fix the enrollment classifier finding

Date: 2026-09-27

## Task and safety rules

Review all open issues. Rank them by impact, favoring low Unity CI churn. Complete the highest-priority issue with an evidence-backed fix and open a pull request.

Preserve fail-closed enrollment and cleanup checks. Do not change organization policy, licensed job behavior, or lock state.

## Issue review and priority

The live GitHub snapshot had 13 open issues and no open pull requests in the central repository. The prior #283 spacing issue is closed. Priorities use impact first, then available authority and evidence, then Unity CI cost.

| Priority | Issue | Impact and blocker | Decision |
| --- | --- | --- | --- |
| P0, authority gated | #51 | Broad App and organization-secret scope has the largest security impact. Its remedy needs owner-authorized inventory and organization secret changes. | Keep owner authority and the no-policy-change boundary. |
| P0, authority gated | #44 | Missing required Unity aggregates can allow merges before validation. Enforcement needs consumer-owner ruleset changes. | Keep the staged ruleset and owner prerequisites. |
| P0, evidence gated | #83 | Shared-seat returns can quarantine a clean runner. Safe classification needs exact return-order and portal evidence. | Preserve quarantine until the required proof exists. |
| P0, ready | #113 | Two DoxReloaded aggregate findings block a clean organization audit. The workflow and analyzer evidence are available without a Unity run. | Selected. Fix the classifier ordering and exact analyzer contract. |
| P1, live canaries | #29 | Lifecycle, recovery, capacity, and seven-day monitoring evidence remain open. | Wait for the listed hardware, portal, and owner evidence. |
| P1, design and load | #53 | Runner starvation occurs before FIFO admission. A fix needs a fail-closed protocol and real load evidence. | Do not change seat or queue policy without that evidence. |
| P1, platform evidence | #153 | Darwin and container return paths need native platform proof. | Keep admission fail closed until platform canaries pass. |
| P1, platform evidence | #229 | The remaining trusted-return work needs native canaries and exact return evidence. | Keep the platform rollout evidence gated. |
| P1, authorization gated | #231 | Darwin release authorization needs a measured team ID, reviewed SHA, and native canary. | Do not infer or add authorization values. |
| P1, authorization gated | #249 | The published Darwin policy remains empty pending the same identity and canary evidence. | Keep the empty list fail closed. |
| P1, causal evidence | #269 | An editor assertion with zero failed leaves can make a clean revision red. Peer correlation and a bounded policy need live evidence. | Do not add licensed retries from inference. |
| P2, evidence unavailable | #277 | Retained GitHub records do not identify the canceller for the cited runs. | Keep the incident record; revisit if an event source exposes actor evidence. |
| P2, premise unresolved | #278 | Session 097 refuted the cited lock-collision records. The remaining editor report lacks its original suite log. | Do not implement wait-and-queue from the refuted premise. |

## Hypothesis and baseline

Hypothesis: the exact-shape analyzer rejected DoxReloaded's classifier because a consumer script ran before the approved classifier action. Both typed aggregate findings should disappear if the check runs after that action and the analyzer accepts only that exact, failure-propagating check.

The starting central commit was `ef3cfdd31dd437a9c2fb464f275f05cf569b1b5b`; the worktree was clean. GitHub's combined-status response contained no status rows, so it did not prove that `main` was green.

The central audit reproduced the issue on the six commits listed in alert #113:

```text
Audited 6/6 enrolled repositories; active-jobs=113 findings=2 complete=true
```

Both findings were on DoxReloaded `build-deploy.yml`: `missing-unity-aggregate` and `missing-fallback-aggregate`. The workflow had the approved classifier action, but it ran `lint-line-length.py` first. The analyzer correctly rejected that three-step classifier shape.

## Change

The central analyzer now accepts the existing two-step classifier or one exact `Check added rule lines` step after the classifier action. The allowed step has only `name` and `run`, uses the two documented commands, and cannot suppress failure. Tests reject a pre-classifier script, output forgery, failure suppression, and an inherited environment.

DoxReloaded commit `6d2fea3026be411bc403348ee37559ed0706ee75` moves the same check after the classifier action. It does not change a licensed job. The full-history comparison remains intact, so the line check keeps its merge-base behavior and adds no checkout or Unity wait.

## Validation

- The new analyzer fixture failed under the old two-step rule with both aggregate findings.
- The focused enrollment test and full enrollment package test passed after the change.
- `bash .devcontainer/scripts/verify.sh` passed twice: 900 Node tests, six skipped, all Go packages, module checks, workflow checks, and credential audit.
- The central audit passed on the committed DoxReloaded tree: 6/6 repositories, 113 jobs, zero findings.
- DoxReloaded actionlint, line-length self-test, solver-impact self-test, plan-leanness checks, and `git diff --check` passed.
- No organization policy, lock configuration, action runtime, or licensed job changed.

## Adversarial review and learning

The current collaboration mode did not authorize sub-agent delegation. The main thread performed separate implementation, review, and remediation passes. The review checked classifier order, the exact step allowlist, failure propagation, output bindings, audit results, and licensed job scope. It found no remaining actionable issue.

The review rejected moving the check to a shallow static job: that would lose the existing merge-base comparison or require a full-history checkout. The narrow post-classifier exception keeps the output trusted and preserves the current CI path.

Learning decision: revise `docs/consumer-enrollment.md`, the authoritative contract, with the exact allowed post-classifier check. The analyzer tests enforce the contract. No `.llm/` guidance change was needed, so the LLM harness did not need regeneration.

## Remaining work

The central and DoxReloaded branches still need GitHub pull requests, CI, review, and merge. The post-merge central audit and green `main` status remain required before closing this objective.
