# Session 127: keep the plan lean

Date: 2026-10-06

## Task and acceptance criteria

Audit PLAN.md. Keep only open outcomes, next actions, and blockers. Preserve
removed evidence. Put durable guidance in agent knowledge. Use local repository
evidence; this task does not require a live issue sweep or policy changes.

Safety invariants: preserve every unresolved outcome and evidence boundary.
Do not change runtime behavior, admission, cleanup, capacity, or authority.

## Baseline and hypothesis

Observed baseline: PLAN.md had 134 lines, 1,163 words, and five completed
checklist items. Its current-state heading named session 125. Session 126 is
newer. The worktree was clean at 57107d1e0 (PR #337). The harness check passed.

Hypothesis: routing history and standing policy out of the plan will reduce
reading cost without losing a next action or blocker. A missing unresolved
outcome or a broken evidence link would disprove successful preservation.

## Evidence routing

| Removed content | Authoritative destination |
| --- | --- |
| Session summaries and completed M1/M2/M3 work | Existing session records and the exact archive below |
| Cancellation and fail-closed rules | .llm/context.md and build-lock-lifecycle skill |
| Release authorization, repins, audit codes, Darwin admission, merge attestations | docs/consumer-enrollment.md and docs/operations-runbook.md |
| Release and incident history, old run IDs and commits | Existing progress records and the archive below |
| Peer timeline contract | docs/operations-runbook.md, Session-phase casualty correlation |
| Plan ownership and pruning procedure | .llm/skills/task-driven-development/SKILL.md |

The archive preserves the old plan exactly. It contains dated claims, not
current operational facts. No copied claim was promoted into standing policy.
The seat-attribution research now links here instead of a removed M1 heading.

## Red-green experiment

New harness regression: a 60-line plan is accepted; a 61-line plan is refused.
Completed checklist items are refused across bullet and ordered-list forms.
LF and CRLF boundaries are covered. The baseline test failed at the intended
61-line rejection assertion: the old harness accepted the oversized plan.

The harness now checks these two limits. Canonical context points to the
existing task skill, which owns content routing and end-of-session pruning.
The 60-line ceiling is a chosen maintenance budget, not a measured optimum.
Semantic relevance still requires review. Optional fixture plans remain valid.

## Scope and remaining uncertainty

The initial plan edit used local records only. At that point, session 126
delivery and #113 needed fresh remote evidence. The continuation audit below
now verifies both. Session 126 retains the merged-main checks and issue
closures. The current plan removes those completed tasks. Remaining blockers
still require the named authority or evidence. Runtime behavior is unchanged.

## Validation and review

- `node --test test/llm-harness-*.test.js`: 18 passed, zero failures.
- `node tools/llm-harness.mjs generate` and `check`: passed; the generated
  catalog content did not change.
- `bash .devcontainer/scripts/verify.sh`: exit 0. All 1,011 Node tests ran:
  1,005 passed, zero failed, six native-platform tests skipped on Linux.
  Go tests, race checks, vet, both module verification/tidy checks, linters,
  workflow validation, and credential audit passed.
- `git diff --check`: passed.
- Exact archive comparison against `git show HEAD:PLAN.md`: passed.
- Changed Markdown file links: all targets exist.

Result: the initial edit reduced the plan to 33 lines and 238 words. After
the continuation audit, it has 26 lines and 195 words, down from 134 lines
and 1,163 words. This removes about 83% of its words. Five completed checklist
items were removed. Each remaining open outcome has a next action or blocker.
Verified session 126 delivery and the obsolete #113 task are removed.

Implementer: root. Independent reviewer: plan_review. The reviewer read the
complete diff, baseline plan, latest session, affected knowledge, and harness
tests. Its catalog suite passed 10/10; its harness check passed. It independently
confirmed archive equality, links, remaining outcomes, and evidence boundaries.
The initial review found no actionable findings. A continuation review found
stale scope and result paragraphs. This record now separates the initial
implementation from the verified current state.

## Knowledge retention

Trigger: agent guidance, harness enforcement, and evidence ownership changed.
Observed fact: the old plan mixed history, policy, and future tasks. Inference:
lack of an explicit content boundary allowed append-only session summaries.
Decision: revise the existing task skill and link it from canonical context.
Enforce the measurable subset in the existing harness, hook, and CI path.
Independent knowledge review found no actionable findings. The line budget
limits accumulation; content routing and pruning address its underlying cause.

## Continuation audit (2026-10-06)

The previous goal turn made progress through the plan, harness, and guidance
changes. A fresh complete verifier passed: 1,011 Node tests, 1,005 passed,
zero failed, six native-platform skips. All Go and policy checks passed.

Fresh GitHub evidence verified session 126 delivery and its three issue
closures. The final result now lives in session 126, not only its PR body.
The live complete enrollment audit reports zero findings over 115 active
inventory rows, and #113 is closed. Remove its dated reproduction task.
Remove session 126 delivery from the plan because its checks are now verified.
All 14 current open issues remain represented in the future-work list.
No licensed job, test coverage, CI job, or organization policy changes here.

Root also rechecked dependencies. Registry and release queries still report
ESLint 10.12.0, semantic-release 25.0.9, @semantic-release/github 12.0.10,
actionlint 1.7.12, and golangci-lint 2.14.0. Root-module `go list -m -u all`
found no upgrade. The tool module has one used upgrade: YAML rc3 to rc6,
tracked in #335. Graph-only goldmark 1.7.17 to 1.8.6 and x/net 0.52.0 to
0.59.0 are unused, as checked with `go mod why -m`. Discovery used a writable
`/tmp` GOPATH for checksum metadata; checksum verification stayed enabled.
No dependency was added.

Continuation reviewer: `review_plan_delivery`. Distinct remediator:
`remediate_plan_record`. The remediator corrected stale scope and count claims.
The fresh final review found no actionable findings. It independently checked
all 14 open issue mappings, archive equality, remote delivery, and timing.
All 18 focused harness tests passed. The final complete verifier passed after
remediation: 1,005 passed, zero failed, six native-platform skips. Root also
reproduced the new plan regression against HEAD's harness in an isolated
scratch tree. It failed at the intended 61-line rejection assertion.

## Archived plan

The following is the unchanged plan from the starting worktree. Historical
completion and release claims need their dated source before reuse.

```markdown
# Plan

Living milestone plan for the organization build lock. Keep it current:
remove completed or obsolete items after each session. Order milestones by
impact on licensed-resource safety and consumer CI churn.

## Current state (2026-10-05, session 125)

- Session 125 reviewed all 16 open issues and completed release adoption PR #333.
  It selected #329. Refused reaper history now leaves retained alert evidence
  unchanged and reports unknown delivery status in the run. No Unity run is
  needed. Hosted runner acquisition failures are tracked in #334.

- Session 124 reviewed all 13 open issues and found no open pull requests in this
  repository. It selected #326, the two monitors that named a known condition in a
  step log only. Both now state their conclusion and its reason code in the job
  summary, and the condition that keeps the run green also reaches the
  annotations tab. No licensed Unity job spends a cycle on it.
- Session 098 reviewed all 14 open issues and found no open pull requests in
  this repository. It selected #283, the current repin YAML comment defect,
  for its direct consumer CI impact and zero licensed Unity job changes.
- Session 114's #283 hard-coded two spaces before every repin version comment.
  That is IshoBoy's rule, not the organization's: unity-helpers runs Prettier
  over `.github/` and asserts one space, so the v1.16.0 offer left its `main`
  red after auto-merge (#307). The rewrite now keeps each consumer's own
  spacing, reads a new comment's gap from that repository, and fails closed on
  an absent or split precedent.
- Higher impact items remain gated by external evidence or authority: #51
  needs owner-approved secret scope changes; #83 needs entitlement and portal
  proof; #44 needs ruleset authority; #113 needs its reported findings
  reconciled against the aggregate visible in its audited workflow.

- M3 was completed (see Completed milestones). Issue #113 reopened with two
  DoxReloaded aggregate findings at commit `1bc7790`. The audited workflow
  contains a `ci-success` aggregate using the central validator; reproduce the
  exact finding before changing the consumer or analyzer.
- Session 097 verified the #279 repin fix live: dispatched run 34768908054
  completed green with the bounded superseded-offer scan in effect, and
  #280 closed with that run as evidence. The day's scheduled run
  (34743810332, created 06:52 UTC) started before #279 merged and still
  shows the old failure.
- Session 097 RCA'd #278 from lock-state history: the quoted "collision"
  lines are the release leg's normal summary output, and attempts 1 and 2
  of qora-redux run 34736599983 acquired, held, and released clean. The
  consumer's own push plus the reviewed `cancel-in-progress: true` flip
  cancelled attempt 3 before acquire. The same attribution data point went
  to #277; the remaining ask there stays an accepted evidence gap.
- The cancellation contract is standing: workflow scopes that reach acquire
  carry literal `cancel-in-progress: true`, aggregate reporters keep
  literal false, and licensed matrices use `fail-fast: false`.
- v1.14.0 (PR #224) and v1.14.2 (d79e1cc2a, PR #247) are released and
  authorized for consumer pins. v1.14.1 stays unauthorized by design
  (superseded within minutes; discovery offers only the newest release).
- `Auto release` opens the release-authorization pull request after every
  release. Merging it stays the human decision.
- The cleanup classifier attributes generic return failures through
  `licensing-codes-checked` and `licensing-code-matched` outputs.
- The enrollment audit rejects licensed Unity jobs on GitHub-hosted or
  ambiguous runners (`unsafe-hosted-unity-runner`), admits the central
  return on Windows and, for pins listed in the reviewed
  `approvedDarwinReturnShas` allowlist, on macOS. The allowlist is empty
  until a Darwin verifier release exists (#153, #228).
- The Darwin trusted return runtime landed (PR #240, squash-merged as
  6a384393c). The analyzer still refuses every Darwin return until
  `approvedDarwinReturnShas` names a release (#231).
- Repin automation honors reviewed, expiring `repinExceptions`, closes its
  own superseded offers, updates release version comments in each consumer's
  own spacing for Dependabot visibility, and enables auto-merge on every offer
  (squash preferred; a repository-level `Allow auto-merge` opt-out restores a
  manual gate). A closed repin pull request is the consumer's adoption
  answer: never re-offered, never force-updated.
- The 64-code audit vocabulary is test-locked to `docs/consumer-enrollment.md`.
- The scheduled audit survives a consumer push that lands mid-run, and
  reports stale or expired `repinExceptions` entries.
- The central merge-policy drift audit (#44 item 7, #252) compares the
  reviewed expectation list with each consumer's live rulesets daily. The
  #252 blind spot (ruleset `bypass_actors` need a ruleset-write caller) is
  filled by consumer attestations in
  `.github/merge-policy-attestation.json`, proven fresh against the live
  ruleset (session 083). All attestation pull requests merged; ruleset
  22983578 on unity-helpers requires `Unity CI Success`.
- Session 091 answered the lock-side half of #269: the release action
  publishes a redacted `peer-timeline` output and job-summary table. The
  consumer half is canary item 12 of the enrollment contract. Lock-state
  history proves no peer held the lock in either #269 casualty window.

## M1: attribute every Unity seat to a lock holder (#223, #83)

- [x] Classifier emits licensing-code attribution (PR #224).
- [x] Audit names licensed jobs that run outside the self-hosted fleet.
- [x] Decide the disposition of the unity-helpers hosted export jobs:
      unity-helpers moved both jobs to the self-hosted Windows fleet at
      audited commit `93671a56` (#226 closed 2026-09-07). The audit confirms
      `unsafe-hosted-unity-runner` no longer appears for that repository.
- [ ] Determine whether a peer activation can invalidate a live incumbent's
      seat. Needs Unity portal evidence (#223, section 3).

## M2: shared-seat capacity decision (#83)

- [x] Release the benign shared-seat handoff normally: the classifier confirms
      a `400006` return whose log proves the ULF serial return with a
      completed command (maintainer directive 2026-09-07; implements the
      re-opened #106 part 2). No quarantine, no red cleanup gate.
- [x] Keep fail-closed quarantine for a `400006` without ULF proof, degraded
      reports, timeouts, truncation, and termination. Enforced by the session
      068 classifier verdict tests; verified again 2026-09-07.
- [ ] Decide holder capacity against real seat capacity: independent
      returnable Unity identities, slot-aware state, and two-order live proof.

## Completed milestones

- M3 (consumer enrollment drift, #113) closed 2026-09-13: zero-touch repin
  automation with auto-merge, the per-code fix contract, the #274 flip
  cohort (DoxReloaded #835, DxMessaging #584, IshoBoy #906, unity-helpers
  #776; qora-redux `main` already canceled, unity-builder exempt), and the
  unity-helpers static-matrix restore (#785) drove the audit to 0 findings
  over 118 active inventory rows. The alert auto-closed as completed
  (run 34770239068).

## Blocked on authority or evidence (do not start here)

- #29 canaries and monitoring, #44 truthful aggregates, #51 App credential
  scope, #53 FIFO starvation: each needs organization-owner authority,
  portal decisions, or multi-week live evidence windows. Triage recorded
  2026-09-06 (session 066) and 2026-09-07 (session 067).
- #153 Windows-container trusted cleanup and the Darwin verifier release:
  PR #240 landed the Darwin action design with its requirement compiled in
  CI (draft #228 is closed as superseded), and stays runtime-only until
  #229's canary reads the Developer ID Application team on a real macOS
  install and an exact-head licensed canary runs. The enrollment-audit
  admission contract for the Darwin shape is done; the reviewed
  `approvedDarwinReturnShas` merge is the separate authorization step that
  follows a Darwin-capable release. Issue #229 tracks the remaining canary,
  authorization, and Windows-container work.
```
