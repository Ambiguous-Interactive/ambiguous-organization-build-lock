# Session 015: reaper delivery monitoring

Date: 2026-07-26

Status: locally verified and review-clean; delivery pending

## Objective and boundary

Review every open issue, prioritize impact while minimizing licensed Unity
churn, and complete the highest-priority autonomous zero-Unity scope.

Issue #77 is selected. GitHub receives a requested `*/5` reaper schedule, but
the issue records observed delivery gaps of 22.1 to 85.9 minutes. The current
workflow also puts scheduled reaping and proof-bearing recovery in one
`cancel-in-progress: true` group.

This change does not alter lock schema, capacity, admission, cleanup evidence,
organization policy, consumer workflows, or Unity execution.

## Open-issue priority

All 16 open issues were read through the connected GitHub App. There were no
open or draft PRs.

| Priority | Issues | Impact and churn assessment |
| --- | --- | --- |
| P0 constrained | #51 | Highest credential-boundary risk, but owner-authorized organization policy changes are explicitly prohibited. |
| P0 selected | #77 | Delayed stale recovery reduces effective capacity, current timing guidance is false, and schedule/manual concurrency can cancel proof-bearing work. Central-only and zero Unity. |
| P1 evidence-constrained | #83, #84 | Repeated concurrent-return false quarantines are production-impacting. Existing accepted evidence proves `400006` is not cleanup proof; safe closure needs independent entitlement/portal evidence and consumer rollout. |
| P1 | #42, #44 | Enrollment and required-check gaps are material but need cross-repository identity/ruleset work and broad Unity churn. |
| P1 | #53 | Pre-FIFO starvation harms fairness but requires a two-phase architecture and cross-repository load evidence. |
| P2 | #29, #30 | Umbrella operational/security trackers require paid canaries, owner evidence, and a monitoring window. |
| P2 | #85 | Central cleanup actions exist; remaining adoption is a staged consumer rollout. |
| P2 | #60 | Literal zero cooldown still needs config change and a cross-runner Unity canary. |
| P2 | #49 | Matrix throughput work requires consumer policy changes and paid before/after evidence. |
| P2 | #54 | Explicitly requires a paid Isho lifecycle canary. |
| P3 investigate/close | #27 | Old run-only report predates multiple lifecycle fixes and needs refreshed causal evidence. |
| P3 not a defect | #79 | JavaScript `Date.now()` already reports UTC Unix epoch milliseconds. |
| P3 dependency-gated | #94 | yaml/v4 rc.6 remains incompatible with latest actionlint v1.7.12; joint upgrade is not available. |

## Baseline and hypothesis

- Focused baseline: 61/61 workflow/documentation tests passed.
- Source observation: the test and workflow explicitly required
  `cancel-in-progress: true`; README said the reaper “runs every 5 minutes.”
- Hypothesis: independently classify scheduled-run metadata and maintain one
  sanitized incident, while separating exact-proof recovery from scheduled
  reaping.
- Disconfirming evidence: duplicate/unsafe incident content, ambiguous API
  success, schedule-driven recovery cancellation, or required Unity work.

## Red and green

The first Go suite failed at compile because the monitor did not exist. Six
Node contract checks failed for missing workflow/facts and old concurrency.

The implementation now:

- classifies overdue, stalled, unsuccessful, absent, and ambiguous run evidence;
- caps API responses, bounds pagination, and rejects cross-origin links and
  redirects;
- synchronizes one marker-identified issue with only IDs/timestamps/reason/SHA;
- treats a known alert as successful monitoring while broken evidence remains
  red;
- isolates `recover` / `recover-incident` in a no-cancellation manual workflow;
- leaves scheduled/manual `reap` in a stable false-cancel group; and
- updates the stale five-minute claim and published v1.9.1 fact.

Focused green evidence: monitor Go tests passed; 395 adjacent Node tests passed;
actionlint and the credential audit passed.

## Dependency and PR inventory

No dependency PR or other open/draft PR exists. The production root Go module
is current. The isolated actionlint module still advertises only unused
transitive `goldmark` / `x/net` updates plus yaml/v4 rc.6; issue #94 documents
why overriding those transitive versions would bloat the verifier or fail its
build. The latest compatible actionlint remains v1.7.12.

## Review and delivery

Main-thread adversarial review found and remediated pending-run replacement,
monitor/resource state conflation, overly narrow active statuses, repeated
closed-issue writes, cross-origin redirect risk, stale release facts, and
untrusted issue-marker ownership.

The fresh complete verifier passed 553 Node tests, all Go packages, actionlint,
both module checksum/tidy gates, the harness, syntax checks, and the credential
audit. The monitor also passed `go test -race`.

Exact-head review/CI, merge, post-merge monitor execution, issue closure, and
main verification are pending.
