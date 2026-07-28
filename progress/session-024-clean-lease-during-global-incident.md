# Session 024: clean lease during a global incident

## Scope and hypothesis

On 2026-07-28, review every open issue and pull request, prioritize impact while
minimizing licensed Unity CI churn, and complete issue #121.

Hypothesis: the false red is caused by the release action conflating a caller's
cleanup report with a pre-existing account incident. Preserving caller-local
evidence while retaining the immutable incident signal will let an
independently clean lease pass its terminal gate without reopening admission or
weakening uncertain-cleanup handling.

Safety invariants:

- An active schema-5 incident continues to block every new admission.
- Missing, unknown, contradictory, or locally blocked cleanup remains red.
- Exact holder removal and coherent cooldown/direct-release evidence remain
  mandatory for an acquired job.
- Incident recovery still requires the exact incident ID and portal proof.
- No organization policy, live lock state, consumer pin, or licensed workflow
  is changed.

## Issue and pull-request inventory

The repository had 16 open issues and no open or draft pull requests. The clean
checkout started at `8f85b0ccf`, equal to `origin/main`.

| Priority | Issues | Disposition |
| --- | --- | --- |
| P0 | #121 | Selected: current production false red after a fully clean lease; locally testable and adds no Unity CI churn. |
| P0 | #83 | Highest underlying license-contention impact, but safe closure requires independently returnable Unity identities, both return orders, and portal reconciliation. |
| P0 | #51, #113 | Credential scope and live enrollment drift are high impact, but remediation requires prohibited organization-policy work or broad consumer churn. |
| P1 | #27, #29, #30, #44, #53, #54, #60 | Require live canaries, multi-day evidence, ruleset or identity changes, releases, or broad consumer workflow work. |
| P2 | #49, #99 | Throughput work requires licensed before/after evidence and must not reinterpret cleanup uncertainty. |
| P2 | #94 | actionlint v1.7.12 remains latest and does not compile with yaml/v4 rc.6. |
| P3 | #79, #102 | `Date.now()` already represents a UTC epoch; a TypeScript refactor has no demonstrated safety benefit. |

No new follow-up issue was opened because every material out-of-scope finding
already has a dedicated issue.

## Baseline and root cause

The baseline passed the LLM harness, all 566 Node tests, and every Go package.

Observed facts:

- schema 5 correctly allows existing holders to finish after an incident and
  continues blocking new admission;
- release removed the clean caller's holder and created its normal cooldown,
  but replaced the caller's `healthy/cleanup-confirmed` outputs with the
  unrelated incident's `blocked/unity-account-limit-20111`;
- the terminal gate therefore rejected the caller's release health, release
  reason, global result, and incident ID despite complete local cleanup;
- the root Go dependency is current;
- upgrading the isolated actionlint module from yaml/v4 rc.3 to rc.6 makes
  actionlint v1.7.12 fail to compile against the changed parser API.

Conclusion: the state transition is safe; the public release evidence conflates
lease-local and account-global facts, and the gate cannot score them
independently.

## Red-green implementation

The focused tests first failed because a pre-existing incident changed the
clean caller's release output to `blocked`, and because the gate rejected both
coherent cooldown and zero-cooldown global-incident shapes.

Release now preserves the caller-local resource health and reason while
continuing to report `global-quarantined` and the immutable incident ID. The
gate accepts that result only with confirmed/healthy local classification,
successful exact holder removal, caller-local confirmed release evidence, a
valid incident identity, and either a coherent cooldown or no reservation.
Blocked or unknown local evidence, missing incident identity, ordinary results
with an incident, and contradictory reservations remain red. A successful gate
emits a static warning that new admission remains blocked.

Action descriptions, the top-level contract, consumer enrollment guidance, and
the operations runbook now distinguish caller-local evidence from the global
incident without changing recovery proof.

Focused verification passed:

```text
node --test test/unity-cleanup-gate.test.js test/build-lock.test.js
git diff --check
```

## Review, continuous improvement, and delivery

The complete `.devcontainer/scripts/verify.sh` passed 571 Node tests, every Go
package, actionlint, both module verification and tidy checks, the workflow
credential audit, and the LLM harness before review remediation.

Continuous-improvement trigger: public lifecycle evidence and terminal-gate
behavior changed after a production incident exposed a reusable ownership
boundary.

Promotion decision: `revise`. The lifecycle invariant reference now states that
caller-local cleanup evidence and account-global incident evidence remain
distinct, while new admission stays blocked until exact incident recovery.

Main-thread fallback was required because the active session policy did not
permit sub-agent delegation. Adversarial review round 1 found a backward
compatibility issue: removing incident-overridden values also removed the output
path for legacy `resource-safe=true` callers. Remediation attaches caller-local
health/reason to every cleanup result and adds table-driven typed, legacy, and
zero-cooldown coverage.

Adversarial review round 2 found that the newly successful incident shape
accepted any log-safe opaque ID. Remediation requires the exact schema-5
`incident-` plus 24-lowercase-hex contract and adds a malformed-but-opaque
negative case.

Fresh focused verification passed 364 tests after remediation. Adversarial
review round 3 inspected the revised state and found no actionable issue.

Fresh post-remediation `.devcontainer/scripts/verify.sh` passed 575 Node tests,
every Go package, actionlint, both module verification and tidy checks, the
workflow credential audit, and the generated LLM harness. `git diff --check`
also passed.

Pending pull-request review, merge, and post-merge `main` verification.
