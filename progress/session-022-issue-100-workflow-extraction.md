# Session 022: testable workflow automation

## Scope and hypothesis

On 2026-07-28, review every open repository issue and pull request, prioritize
impact while minimizing licensed Unity CI churn, and complete issue #100 by
extracting nontrivial workflow logic into directly testable repository scripts.

Hypothesis: the long inline shell programs in trusted workflows can move
byte-for-byte into strict Bash entrypoints without changing permissions,
credentials, state transitions, outputs, or operator evidence. A workflow
contract can then prevent the inline logic from growing back.

Safety invariants:

- Trusted-main and exact-head validation remain fail-closed.
- Credential values remain environment-only and absent from command text.
- Workflow permissions, immutable action pins, concurrency, and evidence
  retention remain unchanged.
- The privileged Dependabot `pull_request_target` job never checks out
  pull-request or repository code.
- No licensed Unity job, consumer repin, lock state, capacity, queue behavior,
  organization policy, or credential scope changes are in scope.

## Issue and pull-request inventory

The repository had 17 open issues and no open or draft pull requests. One
remote issue-52 branch was 11 days old, had no PR, and was superseded by
changes already on `main`.

| Priority | Issues | Disposition |
| --- | --- | --- |
| P0 | #83 | Highest raw production impact, but safe closure requires independent entitlement identities, consumer repins, both return orders, and portal proof. Preserve fail-closed `400006` quarantine. |
| P0 | #51, #113 | Credential scope and 286 live enrollment findings are high impact, but require owner or broad consumer changes outside this bounded no-churn implementation. |
| P1 | #27, #29, #30, #44, #53, #54, #60 | Require live canaries, multi-day evidence, ruleset changes, releases, or broad consumer workflow churn. |
| P2 | #49, #99 | Throughput work needs licensed before/after evidence. |
| P2 | #100 | Selected: removes privileged automation logic from YAML, is locally battle-testable, and consumes no Unity seat. |
| P2 | #94 | actionlint v1.7.12 remains latest and yaml/v4 rc.6 remains incompatible; no safe upgrade exists. |
| P3 | #79, #102 | `Date.now()` already represents UTC epoch time; TypeScript/Bun/Deno has no demonstrated safety or runtime benefit. |
| P3 | #109 | Removing progress records conflicts with the active session contract, and history rewriting is destructive. |

No new out-of-scope issue was opened because each material follow-up already
has a dedicated issue.

## Dependency audit

- The checkout started clean at `6c89e29cd`, equal to the recorded
  `origin/main`.
- The root Go module has no available updates.
- actionlint v1.7.12 remains the latest release. Its yaml/v4 rc.6 update is
  still blocked by #94's reproduced parser API incompatibility.
- Newer transitive-only actionlint modules were not promoted to unused direct
  dependencies.

## Red-green evidence and implementation

The new workflow contract failed first on `auto-release.yml:43`, proving that
multiline programs were still embedded in workflow YAML.

Implementation:

- five strict Bash entrypoints now own release tagging, CI command groups,
  onboarding request creation, trusted onboarding, and enrollment-audit shell
  behavior;
- eligible workflow `run` steps contain one command and delegate nontrivial
  logic to those scripts;
- policy tests inspect both workflow YAML and referenced scripts, preserving
  permission, trust, exact-head, evidence, and credential checks;
- the three privileged Dependabot programs remain inline because extracting
  them would require a checkout in a write-token `pull_request_target` job;
- focused behavioral tests cover Bash syntax, command dispatch, typed request
  evidence, workflow-run trust rejection, malformed request rejection, output
  ordering, and incomplete audit failure.

The extracted onboarding test exposed a pre-existing defect: `jq -er .fork`
and `jq -er .allowWorkflowDispatch` exit nonzero for the valid JSON value
`false`. Both typed booleans now use `jq -r` after the preceding schema check,
so default `fork: false` requests validate without weakening type enforcement.

Focused verification passed:

```text
node --test test/workflow-policy.test.js test/workflow-scripts.test.js
go -C tools/actionlint run -mod=readonly github.com/rhysd/actionlint/cmd/actionlint -color
go run ./cmd/workflow-credential-audit .
```

The focused Node run passed 66 tests. Actionlint and the credential-literal
audit also passed.

## Review, continuous improvement, and delivery

The complete `.devcontainer/scripts/verify.sh` passed 564 Node tests, every Go
package, actionlint, both module verification and tidy checks, the workflow
credential audit, and the LLM harness.

Main-thread adversarial review was used because the workflow programs and their
callers are one coupled trust boundary. The first pass found three actionable
gaps:

- script changes did not trigger the enrollment audit immediately;
- `.sh` files were outside the repository text-policy inventory;
- the secretless request workflow checked out the selected dispatch ref before
  rejecting non-`main`.

Remediation added the script path trigger, extended policy scanning and secret
expression checks to shell files, and pinned request automation checkout to
trusted `main`. Fresh focused and complete verification passed afterward. A
second full diff review found no actionable issues.

Continuous-improvement outcome: `revise`. The valid-false defect is a reusable
workflow authoring failure class, so the GitHub workflow policy skill now
requires exact JSON schema validation before extraction and forbids `jq -e`
when a typed boolean may validly be false. The behavioral regression remains
the mechanical enforcement for the affected workflow.

PR #118 published exact head `06bf3c5de1c165293cb1c7aa1b34c222c67c3f02`.
The lock validation passed in Actions run `30317937637`; Cursor Bugbot
completed successfully with no findings. Copilot was requested both through
the reviewer API and with an exact-head comment, but its two checks reported
only that the requester's monthly review quota was exhausted. There was no
Copilot code feedback to remediate.

GitHub reported the PR cleanly mergeable, and the exact-head guarded squash
merge produced `4af5176fc7653dc42efb17ac27dd4aca05673d91` on `main`, closing
#100 as completed. On that exact merge commit, lock validation run
`30318243869` and enrollment audit run `30318243935` both completed
successfully; the Dependabot auto-merge workflow-run check skipped as
expected. No licensed Unity job ran and no organization policy changed.
