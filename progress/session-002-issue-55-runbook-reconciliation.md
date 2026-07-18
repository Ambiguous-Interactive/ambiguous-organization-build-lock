# Session 002: issue 55 runbook reconciliation

## Objective

Inspect every open central issue, prioritize work by dependent-project Unity CI
cost and operational value, then complete the highest-priority fully autonomous
zero-Unity-run issue. Publish, review, merge, and verify the result without
human intervention.

## Evidence baseline

- Repository: `Ambiguous-Interactive/ambiguous-organization-build-lock`.
- Default branch at triage: `268009ac`.
- Open-issue inventory captured on 2026-07-18: #27, #29, #30, #42, #43, #44,
  #45, #47, #48, #49, #50, #51, #52, #53, #54, #55, and #60.
- Live committed config: schema 5/account health, two holders, runner
  serialization, resource lifecycle, and a transitional one-second confirmed
  cleanup cooldown.
- Reviewed active perimeter: unity-helpers, DxMessaging, DoxReloaded, IshoBoy,
  qora-redux, and the controlled unity-builder fork.
- “Dependent Unity runs” means paid or licensed Unity jobs in consumer
  repositories. Central Node/Go/static CI does not consume that pool.

## Prioritized issue inventory

The ordering favors: (1) zero dependent Unity runs, (2) autonomous completion
with current repository/GitHub access, (3) safety or security impact, then
(4) breadth and validation cost. Run counts are lower-bound estimates from each
issue's acceptance criteria and the current workflow topology; “policy
dependent” means a PR event may expand according to that consumer's required
matrix.

| Priority | Issue | Minimum dependent Unity runs | Disposition |
| ---: | --- | ---: | --- |
| 1 | #55 steady-state runbooks | 0 | Central-only, safety-critical stale operator guidance, and fully completable. Selected. |
| 2 | #42 continuous enrollment audit | 0 | Central policy code can be static, but existing draft #56 and live App/secret-scope gates must be reconciled first. |
| 3 | #45 Codecov credential literal | 0 | Security-urgent, but completion requires unity-builder plus Codecov rotation/audit authority unavailable in this checkout. Its paid matrix is manual. |
| 4 | #51 App and org-secret scope | 0-1 | Most work is control-plane-only; final supported positive probe may exercise one consumer. Requires organization/App administration. |
| 5 | #47 latent disabled Dx workflows | Policy dependent | Deleting inactive files does not itself need Unity, but a Dx PR can trigger the active required matrix. |
| 6 | #50 Isho compile-wiring checker | At least 1 workflow matrix | The issue explicitly requires exact-PR Unity validation after changing Isho policy code. |
| 7 | #43 bounded unity-builder Windows canary | 1 | Acceptance is deliberately one paid Windows smoke leg. |
| 8 | #48 bounded unity-builder macOS canary | 1 | Acceptance is deliberately one paid macOS smoke leg. |
| 9 | #54 Isho cleanup canary | 1-2 | EditMode is mandatory; PlayMode either runs or receives a tested unsupported classification. |
| 10 | #44 truthful aggregates/rulesets | At least 5 representative consumer runs | Every paid PR consumer must emit and prove its stable aggregate; unity-builder needs a separate manual policy. |
| 11 | #60 literal zero cooldown | At least 5 plus a cross-runner canary | The issue explicitly requires five consumer repin PRs and live handoff evidence. |
| 12 | #49 unity-helpers throughput | Representative PR plus a 15-leg full sweep | Optimization must preserve and prove the full trusted compatibility graph. |
| 13 | #52 cancellation safety | Multi-repository matrix plus canaries | Existing draft #56 spans the consumer inventory and still requires live before/after-acquire behavior. |
| 14 | #53 pre-FIFO runner starvation | Multi-repository load | Acceptance requires at least three repositories, two physical runners, and real load evidence. |
| 15 | #29 lifecycle canaries/monitoring | Multiple canaries over seven days | Deliberate hard-stop, account incident, third-machine, platform canaries, and monitoring are intrinsic. |
| 16 | #27 lock-held regression | Same evidence as #29 | Closure is explicitly coupled to #29's live seven-day gate. |
| 17 | #30 rollout tracker | Sum of child issues | Tracker closure requires the remaining implementation, security, canary, and monitoring work rather than one PR. |

## Red-green work log

1. Added a focused documentation-policy suite before modifying documentation.
   The red run failed all five checks: the steady-state runbook did not exist,
   active docs contained obsolete capacity/App/environment claims, the rollout
   file presented itself as current instructions, and the README recommended a
   mutable GameCI tag.
2. Added `docs/operations-runbook.md` with config-backed live facts, the
   six-repository perimeter, selected-repository App/secret boundaries, the
   normal lifecycle, a cancellation procedure, and an operator state/response
   table.
3. Converted `docs/secure-two-seat-rollout.md` into an explicitly historical
   migration/RCA record and linked the active runbook.
4. Rewrote consumer enrollment around selected-repository access, immutable
   transitive pins, hosted preflight, current-head guards, exact same-runner
   lifecycle, fail-closed aggregates, non-cancellable holders, and canary
   evidence.
5. Corrected README and lock-state documentation for active schema 5, capacity
   two, the transitional config-backed cooldown, the current reader permission
   set, no reliance on compatibility fallback, and exact-ID recovery.
6. Replaced the mutable GameCI example tag with an explicit immutable-SHA
   placeholder. Active workflow policy already rejects placeholders and mutable
   refs in executable workflows.
7. Focused green run: `node --test test/documentation-policy.test.js` — 5/5
   passed.
8. The first adversarial sweep queried the live GitHub installation metadata
   and disproved an intended-state claim: both build-lock Apps still report
   `repository_selection: all`. The docs now separate the required
   selected-repository boundary from this dated live #51 gap. The current CLI
   token received the expected admin-scope rejection for organization-secret
   visibility, so the runbook records the latest sanitized evidence without
   claiming a fresh secret-scope read.
9. Extended the policy contract to require both the desired boundary and the
   dated live-gap disclosure. Focused green run: 6/6 passed.
10. The completion audit found that prose and an embedded test array were too
    weak for the issue's schema/release/inventory drift requirement. Added
    `docs/operations-facts.json` as the committed registry for schema 5, the
    current `v1.8.3` release commit, and the six consumers. The test now renders
    expectations from that registry and the live lock config. A fresh
    default-branch audit also confirmed the consumers use immutable central
    action references; several intentionally use different commits per action,
    so the registry records the published compatibility release rather than
    falsely claiming one universal deployed SHA.

## Remaining gates

- Run the complete repository CI command set and adversarial stale-claim sweep.
- Commit and push the coherent change.
- Request exact-head Cursor Bugbot and GitHub Copilot review through supported
  reviewer and comment mechanisms.
- Address every non-trivial finding, keep CI green, merge, and verify `main`.
