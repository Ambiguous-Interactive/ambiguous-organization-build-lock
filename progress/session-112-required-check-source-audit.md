# Session 112: audit required check sources

## Task and boundary

Continue `GOAL.md`: refresh the issue and pull request inventory, rank open
work by impact and Unity CI churn, then complete the highest-priority safe
change. Do not change organization or consumer merge settings. Preserve the
read-only audit and fail-closed drift reporting.

## Fresh repository and dependency baseline

- Baseline: clean `main` at `c530a53d7c9fdca00e246d58ffcb993bfb496af3`.
- Connector inventory: 12 open central issues and no open central pull
  requests.
- Main-module `GOSUMDB=off go list -m -u all` reports no module updates.
- The isolated actionlint module remains on the newest tagged actionlint,
  `v1.7.12`. It reports newer indirect goldmark, YAML, and x/net candidates;
  prior compatibility work found no safe tidy/build update. No dependency
  change was made.

## Priority and disposition

| Priority | Issue | Impact and evidence boundary |
| --- | --- | --- |
| P0, owner security action | #51 | Shared App and organization-secret scope is the widest security boundary. App and secret settings, owner inventories, and negative probes need owner authority. |
| P0, merge-policy source binding | #44 | Required Unity aggregate names are active. Four rulesets leave `integration_id` unbound; Qora classic protection pins App ID 15368. Live ruleset edits are outside this task. |
| P0, licensed-seat proof | #83 | The central false-quarantine and false-red paths are fixed. Independent two-seat and portal reconciliation proof, plus authorized release adoption, remain open. |
| P1, consumer test outcome | #269 | The shipped peer timeline found no concurrent peer in the reported failures. Consumer retry and assertion classification remain open. |
| P1, missing consumer evidence | #278 | Lock admission and release were clean. The first test log and consumer retry details remain missing. |
| P1, platform cleanup | #153, #229, #231, #249 | Native or container canaries and immutable authorization need owner-run licensed evidence. |
| P1, lifecycle evidence | #29 | Hard-stop, account-block, third-runner, and seven-day monitoring canaries need live operations. |
| P1, runner fairness | #53 | A safe fix needs multi-repository design and physical runner load evidence, with more Unity churn than a central audit fix. |
| P2, cancellation attribution | #277 | GitHub does not retain an actor for the unexplained cancellation. No actor can be recovered from current run records. |

I selected the in-repository #44 monitor gap. It has high merge-safety impact,
needs no licensed Unity job, and can improve detection without changing a live
merge rule.

## Hypothesis and root cause

The merge-policy audit compares required context names and bypass actors, but
does not retain the source App ID returned by ruleset or classic branch
protection APIs. It can report a clean audit while a required context accepts
status from any App.

Hypothesis: adding an explicit expected source App ID to reviewed expectations
and auditing each active carrier will report unbound or wrong-source checks.
The audit will keep settings unchanged and publish the evidence through the
existing sanitized drift issue.

## Change

- Upgrade `merge-policy-expectations.json` to schema 2. Every required context
  now names expected source App ID 15368. The exempt manual canary has no
  source ID.
- Read `integration_id` from ruleset checks and `app_id` from classic
  protection. Record each observed ID in the sanitized audit inventory.
- Report `unexpected-required-check-source` when an active carrier is unbound
  or uses another App. Report missing source evidence separately.
- Include source IDs in the deduplicated audit issue and document both finding
  codes.
- No organization or consumer settings changed.

The App ID is supported by the Qora classic-protection audit and current
check-run records sampled from DoxReloaded, IshoBoy, qora-redux, and
unity-helpers. DxMessaging's latest default-branch check-run page contained
only scheduled watchdog checks, so its source was not independently sampled
in this session. The expected ID follows the GitHub Actions producer used by
its required aggregate.

## Validation

- Red-green baseline: the new model test failed because an unbound active
  ruleset produced no source finding.
- Focused Go suites passed for `internal/mergepolicy`,
  `cmd/audit-merge-policy`, and `cmd/sync-merge-policy-issue`.
- `go run ./cmd/audit-merge-policy --policy unity-enrollment-policy.json --expectations merge-policy-expectations.json --validate-only` passed.
- `.devcontainer/scripts/verify.sh` passed with exit code 0. It includes the
  LLM harness, JavaScript checks, Go tests and analyzers, module checks, and
  workflow credential-literal audit.
- `git diff --check` passed before this record was added.

## Main-thread adversarial review

Sub-agent review was unavailable because the active developer instructions
prohibit spawning agents. I performed a separate review pass after
implementation.

- Active contexts remain authoritative; an inactive ruleset cannot satisfy
  the check or trigger a source pass.
- Every active carrier for the context is checked, including duplicate
  carriers and classic branch protection.
- A null or omitted App ID maps to “any source” and fails the expected source
  comparison. Missing ruleset detail produces a separate finding.
- Audit output contains only bounded integer App IDs, sanitized names, and
  existing repository metadata. Issue sync rejects negative source IDs.
- Issue sync still deduplicates findings and runs through the existing audit
  workflow. No write endpoint or merge-policy API was added.
- A malformed negative API ID is normalized to the unbound value, so the
  existing issue-sync validator can publish the fail-closed finding instead
  of rejecting its artifact.
- Schema 1 is rejected. Exempt repositories cannot name an expected source.
- No `.llm` rule needs revision. The source-binding requirement now lives in
  the typed policy and operator documentation, while the unresolved owner
  work stays in #44 and #51.

## Remaining acceptance

The central audit can now detect and report unbound required checks. It does
not bind the four live rulesets. Leave #44 open until an authorized owner
updates those rules and a fresh live audit proves the App binding.
