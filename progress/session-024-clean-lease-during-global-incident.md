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

PR #123 opened with remote head
`1ea35c938e122016bea41aa2654959025ec2f276`; its tree
`70262448c496929be71456a3ee9b066cd2731ce4` exactly matched the fully verified
local tree. Build lock CI run `30329311109` passed. Cursor Bugbot's exact-head
summary reported the intended evidence boundary and no finding or review
thread. Copilot was requested through both the reviewer API and an exact-head
tagged comment, then returned its terminal requester-quota-exhaustion response.

The evidence update produced final implementation head
`51588d8b629799c15ee8ee3c486e66a1c1cbcfb9`; its tree
`4b98296652e648c784a29fdfaa87db181f43028c` exactly matched the verified local
tree. Build lock CI run `30329409085` passed on that exact head. Cursor Bugbot's
fresh exact-head summary reported no finding or review thread. Copilot was
requested again through both the reviewer API and an exact-head tagged comment
and returned its terminal requester-quota-exhaustion response.

PR #123 was squash-merged as
`508662bdde6082f4c12761a172fc9c7cbaa39366`, closing issue #121. Push-triggered
Build lock CI run `30329458668` and Organization Unity enrollment audit run
`30329458649` both passed on that exact `main` commit.

## Completion-audit dependency follow-up

A fresh requirement-by-requirement audit found that the first dependency review
covered the Go modules but had not independently compared every pinned GitHub
Action with its current upstream release. The audit confirmed that checkout
v7.0.1, setup-node v7.0.0, setup-go v7.0.0, semantic-release-action v6.0.0,
devcontainers/ci v0.3.1900000450, and create-github-app-token v3.2.0 were
current. It found two retainable updates:

- download-artifact v4.3.0 to v8.0.1, including fail-closed digest mismatch
  handling;
- upload-artifact v4.6.2 to v7.0.1 in both producer workflows.

The request/onboarding producer-consumer pair moves together. Its existing
archive upload and authenticated run-scoped download inputs remain supported;
the audit workflow's archive upload also remains supported. Every use remains
pinned to the immutable commit behind its release tag.

The module audit also reconfirmed that the root yaml/v4 dependency is current
and actionlint itself is current. yaml/v4 rc.6 remains blocked by actionlint's
parser incompatibility under issue #94. `goldmark` and `x/net` appear as newer
versions in actionlint's upstream module graph, but `go mod why` confirms that
the isolated module does not need either module and `go mod tidy -diff` removes
attempted direct pins, so retaining them would create unused dependency
requirements.

Dependency PR #125 opened with initial exact head
`674e9761e931cf72ce93452dd838cf3639d76b6b`; its tree
`98b874962b55b986b020fee07fa1c230bd9c204c` exactly matched the fully verified
local tree. Build lock CI run `30332351778` passed. Cursor Bugbot's exact-head
summary classified the update as low risk and reported no finding or review
thread. Copilot was requested through both the reviewer API and an exact-head
tagged comment, then returned its terminal requester-quota-exhaustion response.
