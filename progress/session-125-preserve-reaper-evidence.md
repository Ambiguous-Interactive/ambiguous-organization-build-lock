# Session 125: preserve reaper evidence on a refused read

Date: 2026-10-05

## Objective and issue priority

Review every open issue. Complete the highest-impact safe repository change with
minimal Unity CI churn. Finish existing relevant work, refresh dependencies,
review, merge, and prove the resulting main checks.

Baseline: clean main at c5463a9e0. Sixteen issues were open. PR #333 was the only
open PR, including drafts. No local work needed preservation.

| Priority | Issues | Impact and next action |
| --- | --- | --- |
| P0, owner security | #51 | App and org-secret scope. Owner acts needed; no org-policy change is authorized. |
| P0, merge safety | #255, #44 | Live required-check source binding. Keep audit findings; do not change org policies. |
| P0, licensed capacity | #83 | Independent seat capacity needs portal and return-order proof. |
| P1, retained operator evidence | #329 | A refused read can erase the retained reaper run ID. Selected. No Unity run needed. |
| P1, misleading reap conclusion | #328 | Summary can claim clean state after an ambiguous holder status. Separate runtime safety review needed. |
| P1, queue fairness | #53 | Admission design and live two-runner load remain. Item 6 is complete. |
| P1, platform proof | #153, #229, #231, #249 | Native/container canaries and release authorization need hardware and portal evidence. |
| P1, operational canaries | #29 | Deliberate failure and seven-day monitoring evidence remain. |
| P1, new scheduled admission | #332 | Changes unattended licensed admission. Larger safety design than evidence preservation; defer. |
| P1, consumer test evidence | #278 | Lock admission and release were clean. Consumer failure/retry evidence remains missing. |
| P2, release visibility | #330 | Conventional but unreleasable train is silent. Separate release semantics task. |
| P2, cancellation actor | #277 | GitHub run records do not identify the actor. Keep the evidence boundary. |

PR #333 authorizes existing v1.16.1 consumer adoption. Its public runtime diff
received an independent review, with 518 Node tests and focused Go tests passing.
All three PR validation checks passed; no reviewer feedback existed. It merged
as 5c5926aff. The credential-bearing return runtime did not change.

## Hypothesis and baseline

The reaper monitor synchronizes the alert before checking whether history was
read and classified. Moving the refusal before synchronization should preserve
all retained issue evidence and report unknown delivery status in the run.

Safety invariants: preserve all licensed admission, hold, cleanup, and recovery
semantics. Valid classified outcomes still synchronize their incident. A refused
history never creates, updates, closes, or even reads an alert issue.

Baseline `.devcontainer/scripts/verify.sh` passed. The new table regression failed
for API refusal, malformed JSON, and invalid classified evidence. Each failure
observed an issue request despite a refused history.

## Implementation and class sweep

- Refuse unreadable or invalid history before alert synchronization.
- Keep the original refusal reason on stderr and the job summary.
- Replace the old test that required synchronization after an ambiguous read.
- Assert zero issue requests even when the issue API is unavailable. This proves
  the refusal reason cannot be replaced with an incident-sync failure.
- State retained-alert behavior in the operations runbook.

The lock-recovery monitor already refuses invalid lock state before syncAlert.
Both monitors now keep their retained operator record when evidence is refused.
Merge-policy and enrollment audits have separate shell evidence and synchronization
contracts; this change introduces no new runtime output or licensed action pin.

## Hosted runner failure analysis

Two sampled main failures had zero steps, runner ID 0, and no runner name:
37369358493/job 111962851867 and 37368905208/job 111960771290.
Both annotations state that the hosted runner could not acquire the job after
multiple attempts. They ended after about 15 minutes. Main CI 36961339280 passed
on the same commit. Reap run 37370930690 also passed.

Fact: these failures occurred before monitor code ran. Inference: shared hosted
scheduler availability can affect both delivery and its monitoring. Detailed
follow-up #334 records evidence, boundaries, and acceptance criteria. No safety
hold or org policy was changed to mask these failures.

## Verification and review

- Focused Go suites passed for both monitors, runnotice, and githubissue.
- `.devcontainer/scripts/verify.sh` passed after the monitor fix.
- Independent reviewer review329 found no actionable findings. Its focused
  race tests passed. It checked refused history, retained identifiers, run
  summaries, valid synchronization, sync failures, and publication failures.
- Independent reviewer release_review found no actionable adoption findings in
  #333. Review was read-only, and all PR feedback was checked.

## Continuous improvement

Trigger: public monitor behavior, tests, operational guidance, and an investigation.
Evidence: red-green tests, both monitor entry points, independent review, local
verifier results, and GitHub job annotations.

Root cause: synchronization accepted an unproven observation before the caller
checked its classification. The existing fail-closed guidance already covers
this order. Decision: no durable learning to add to `.llm`; the runbook now
states the operator contract, and the regression enforces it.

Dependency refresh and final remote checks are recorded below after verification.

## Dependency refresh

Updated actionlint's used go-shellwords dependency from v1.0.15 to v1.0.16.
Root YAML already uses latest rc.6. Latest actionlint v1.7.12 cannot compile with
YAML rc.6: TypeError.Errors changed type and ParserError was removed. The
isolated linter keeps rc.3; follow-up #335 records the compatibility gate.
Goldmark and x/net have newer graph entries, but `go mod why -m` shows neither
is used by this module. No unused requirement was added.

Dependency discovery initially failed because the default GOPATH sumdb cache
was not writable. A temporary writable GOPATH with the existing module cache
allowed discovery and retained checksum verification. Both module verification
and tidy checks, root Go tests, and actionlint passed after the refresh.

The full tooling audit also updated ESLint to 10.12.0, semantic-release to
25.0.9, its GitHub plugin to 12.0.10, and GitHub CLI to 2.102.0. Both CLI
architecture archives were downloaded and matched the release API SHA256.
The feature pin, fallback URLs, paths, hashes, and contract tests agree.
All configured action pins and devcontainer feature versions already match
latest releases. The base digest matches the current Go 1.27 Bookworm image.
Go 1.27.1, supported Node 24.21.0, golangci-lint 2.14.0, PowerShell 7.6.6,
ShellCheck 0.11.0, and actionlint 1.7.12 were current at this audit.
Plugin peer ranges support the updated semantic-release runtime. Seventy-seven
focused tests, ESLint 10, actionlint, ShellCheck, and credential audit passed.
