# Session 017: Qora quarantine investigation

Date: 2026-07-27

Status: implementation and local review complete; delivery pending

## Objective and safety boundary

Review every open issue and open pull request, prioritize production impact
while minimizing licensed Unity churn, and complete the highest-impact scope
that can be proven without changing organization policy.

Issue #84 is selected for evidence-backed closure. The investigation does not
change lock state, cleanup classification, capacity, credentials, consumer
workflows, or organization policy. Unknown cleanup remains fail closed, and
issue #83 remains open because `400006` is not positive cleanup proof.

Hypothesis: the unexplained Qora quarantine in #84 is preserved in immutable
`lock-state` history and its failure class has already been removed by the
central cleanup-policy rollout.

Disconfirming evidence would be no matching Qora quarantine, an unresolved
current classifier path that can still create the same false-green quarantine,
or missing post-rollout Unity evidence.

## Open-issue priority

The connected GitHub App reported 18 open issues and no open or draft pull
request. Priority weights safety impact, autonomous completion without
prohibited organization-policy changes, and incremental Unity churn.

| Priority | Issues | Impact and disposition |
| --- | --- | --- |
| P0 owner-constrained | #51 | Critical credential boundary, but acceptance requires prohibited organization-secret and App policy changes. |
| P0 evidence-constrained | #83 | Measured cross-repository `400006` collisions remain active. A safe fix still needs independent entitlement identities, both return orders, and portal reconciliation. |
| P0 selected | #84 | A production quarantine report lacked identifiers. Immutable state now identifies the event and the later central-policy rollout removes its divergent false-green path. |
| P1 constrained | #42, #44 | Enrollment and required-check enforcement depend on #51 or repository policy changes. |
| P1 architecture | #53 | Pre-FIFO starvation needs two-phase admission and cross-repository load proof. |
| P2 operational | #29, #30, #54, #60 | These require paid canaries, a monitoring window, or live configuration/policy changes. |
| P2 throughput | #49, #99 | Matrix and lock-wait optimization need measured designs and broader rollout evidence. |
| P2 refactor | #100, #101, #102 | Action extraction, test decomposition, and a possible TypeScript migration have lower production impact and broader churn. |
| P3 investigate | #27, #79, #94 | The old lock-held report shares the monitoring gate; `Date.now()` is timezone-independent; actionlint still blocks yaml/v4 rc.6. |

## Baseline and root cause

The baseline issue supplied only the repository name and the observation that
the Unity portal had no leaked license. Searching every quarantine addition in
the immutable state history from rollout through the issue timestamp found
exactly two Qora reservations:

| State commit | Reservation | Holder | Runner | Reason |
| --- | --- | --- | --- | --- |
| `4da96cd74b65717430caad374264d38a00bb1c97` | `0fbad229-f280-47a1-9b66-ade4497c20b0` | `qora-EditMode` in run `29606842055` | `DAD-MACHINE` | `activation-terminated` |
| `f3206441fe836783e32ddec61f5c8bc8732b1083` | `515c433b-3792-45cc-9dee-4218680312f3` | `qora-PlayMode` in run `29606842055` | `ELI-MACHINE` | `activation-terminated` |

GitHub's job record shows both Unity jobs completed their test, return,
classification, and central release steps. Both jobs later failed their test
result gate. The state therefore does not support treating the event as a
`400006` collision or as confirmed cleanup; it proves that Qora's old local
account-health fallback supplied `activation-terminated`.

The two runner-local reservations were subsequently reclaimed through the
supported same-runner acquire path at commits `8132a03f43495ff9c4da07aea0a47e1f4afe9466`
and `53e29e9d0d36e0bf04fede6fb48df661be2ffe55`. No manual state edit is present.

The root cause was divergent consumer policy. Qora's old release expression
mapped an incomplete local account-health classification to
`activation-terminated`, independently of the dedicated return evidence, and
the workflow could remain green after release created a quarantine.

## Existing remediation

Qora PR #140 merged as
`4d37ff5ca5e0760577507199412ee79082390a50`. It:

- deleted the local account-health classifier and its
  `activation-terminated` fallback;
- passed the central classifier's typed outputs directly to release;
- added the strict central final gate, so quarantine cannot remain green; and
- retained bounded private evidence and fail-closed capture semantics.

The PR's final head passed its repository validation and licensed EditMode and
PlayMode integration. Cursor Bugbot reported no issue on the reviewed head;
Copilot was requested and reported reviewer quota exhaustion. Subsequent
default-branch Unity runs, including `30240702074` and `30241291255`, completed
successfully.

Issue #84 is therefore resolved by the already-merged consumer remediation. It
is not a duplicate of #83, and closing it does not weaken `400006` quarantine
semantics.

## Dependency and default-branch audit

The production Go module already uses yaml/v4 rc.6. Actionlint v1.7.12 remains
the newest upstream tag and still pins yaml/v4 rc.3; issue #94 remains the
correct compatibility gate. `go list -m -u` advertised newer `goldmark` and
`x/net` modules, but `go mod why -m` confirmed that neither repository module
needs them. Adding direct pins would create unused dependency bloat.

Current central `main` commit
`f8c52199ecfb2dda84b7f4f3d081ffcf10e00d87` passed Build lock CI run
`30261045443`. All later scheduled reaper and delivery-audit runs observed
during this investigation also passed.

## Validation and review

This is an evidence-only progress record: runtime positive, negative, error,
boundary, concurrency, and cancellation paths are unchanged. Applicable checks
are documentation policy, generated-knowledge drift, the complete repository
verifier, and diff hygiene.

Focused validation passed:

- `node tools/llm-harness.mjs check`;
- `node --test test/documentation-policy.test.js
  test/llm-harness.test.js` with 21 tests;
- `git diff --check`; and
- the complete `.devcontainer/scripts/verify.sh` with 553 Node tests, all Go
  packages, both module verification and tidy gates, actionlint, generated
  knowledge, and the credential-literal audit.

The main-thread adversarial fallback was used because this session did not
authorize sub-agent delegation. A separate read-only pass compared the issue,
the base-to-working diff, every Qora quarantine addition before the issue
timestamp, the two reservation-removal commits, Qora PR #140 and its final
review, current classifier/gate behavior, dependency output, and current-main
workflow results.

No actionable finding remained. The review explicitly rejected three unsafe
interpretations: the incident is not #83 because its exact reason was
`activation-terminated`; the empty portal is not cleanup proof; and unused
module updates must not be converted into direct dependencies. No remediation
was required, so fresh post-remediation validation was inapplicable.

The continuous-improvement result is `no durable learning`: central cleanup
ownership, same-runner recovery, and fail-closed unknown cleanup are already
authoritative repository guidance. This record preserves the incident-specific
evidence without duplicating those rules.
