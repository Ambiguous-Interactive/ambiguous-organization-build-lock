# Session 033: one-command incident recovery

## Scope and hypothesis

On 2026-07-29, review every open issue and pull request, prioritize impact
while minimizing licensed Unity CI churn, and complete the remaining safe
ergonomics work in issue #132.

Hypothesis: the bot-authored recovery alert already proves and publishes the
exact active incident identifier, but still makes an operator transfer three
inputs into a workflow form. Publishing the equivalent prefilled
`gh workflow run` command removes the separate identifier copy/paste without
changing the exact-ID or portal-proof requirements.

Disconfirming evidence would be a command that can recover an incident other
than the one published, omits explicit portal proof, interpolates untrusted
shell text, needs a writer credential in the monitor, or changes lock state
without the existing compare-and-swap recovery path.

Safety invariants:

- Global incident recovery still requires the exact incident ID and explicit
  portal-cleanup proof.
- The monitor remains read-only and holds no writer, reader, or Unity
  credential.
- Invalid or unprovable lock state never publishes recovery instructions.
- The existing recovery workflow and action remain the only write path.
- No consumer re-pin or licensed Unity CI run is required.

## Issue and pull-request inventory

The clean checkout started at `cd4da10a7`, equal to `origin/main`. GitHub
reported 14 open issues, no open or draft pull requests, and successful
`Build lock CI` and `Organization Unity enrollment audit` runs on that exact
head.

| Priority | Issues | Disposition |
| --- | --- | --- |
| P0 | #132 | Selected. It is the freshest operator-reported stability issue, and the remaining safe interaction cost can be reduced centrally with no Unity churn. |
| P0 | #51, #83, #113 | Critical security, shared-entitlement, and enrollment work requiring prohibited organization-policy changes, independent Unity identities and portal proof, or multi-repository Unity workflow remediation. |
| P1 | #44, #53 | Merge gating and pre-runner FIFO fairness require organization or consumer policy/protocol changes. |
| P2 | #49, #99 | Consumer throughput work requires multi-repository timing, retry, and compatibility evidence; #129 already completed acquire deadline/cooldown polling. |
| Operational | #27, #29, #30, #54 | Live canaries, tracker work, and observation windows requiring Unity or portal evidence. |
| Safety-blocked | #60 | Literal zero cooldown remains intentionally blocked by shared-entitlement uncertainty in #83. |
| Upstream-blocked | #94 | actionlint v1.7.12 remains latest and does not compile with yaml/v4 rc.6. |

Dependency inspection found no update in the root Go module. The isolated
actionlint module reports newer unused transitives, but `go mod tidy` does not
retain direct overrides for them and #94 explicitly requires an upstream
compatible actionlint release. No Dependabot pull request is open.

## Architecture and red-green evidence

Rejected designs:

- Automatic recovery or a seat-availability activation probe: issue #139's
  measured investigation found no safe distinguishing signal and retained
  exact-ID portal-confirmed recovery.
- Resolving whichever incident is active at dispatch time: the incident could
  change after portal reconciliation and recover an identity the operator did
  not verify.
- A second lock-state write path: unnecessary and would expand credential and
  recovery semantics.

Chosen design: extend the deterministic alert renderer with a prefilled
`gh workflow run recover-build-lock.yml` command. Every dynamic shell word is
quoted, the repository and incident values also pass strict patterns, the
workflow and operation are constants, and the command supplies
`portal-cleanup-confirmed=true`. GitHub still dispatches the existing recovery
workflow, whose action reloads fresh state and rejects a mismatched incident ID.

Baseline `go test ./cmd/lock-recovery-audit` passed. The new regression then
failed because the alert did not contain the exact prefilled command. After the
renderer change, the focused package passed.

## Validation and review

Fresh complete local verification after remediation passed:

```text
.devcontainer/scripts/verify.sh
LLM harness checks passed.
tests 604; pass 604; fail 0
all Go packages passed
both modules verified
Workflow credential-literal policy passed.
```

The main-thread fallback was used because this is one tightly coupled renderer,
test, and documentation change; no safely independent implementation slice
required another agent. Implementation, adversarial review, and remediation
were performed as explicitly separated passes.

Adversarial review round 1 found one P1 command-injection risk. Go's URL parser
accepts quotes and semicolons in a host, while the initial command rendered the
configured server host as an unquoted shell word. A nonstandard server origin
could therefore turn a pasted recovery command into additional shell syntax.
The remediator quoted every dynamic shell word using the standard single-quote
escape sequence and added a hostile-value regression. The full verifier above
is fresh evidence from after that remediation.

Adversarial review round 2 re-read the latest renderer, hostile-value test,
workflow input declaration and action wiring, operator guidance, and complete
diff. It found no actionable issue. The exact incident remains bound at alert
render time and is revalidated from fresh state by the existing recovery
action; a changed incident fails closed. The monitor remains read-only.

Pull request #145 opened at exact implementation head `0d9c9c401`. Build lock
CI passed on that head. Cursor Bugbot reviewed that exact commit and found no
new issue or review thread. GitHub Copilot was requested through both the
reviewer API and a tagged comment; it responded that the requester's quota was
exhausted and supplied no code feedback. This documentation-only finalization
commit records those results; every later PR head remains subject to fresh CI
and both supported reviewer triggers before merge, with the PR timeline as the
authoritative final-head evidence.

## Continuous improvement

Trigger: the change affects operator guidance and a proof-bearing recovery
surface. The evidence examined is the issue inventory, issue #139 research,
the alert renderer and tests, the recovery workflow/action contracts, and the
red-green result above.

Observed fact: a deterministic read-only alert can publish an exact command
without becoming a recovery authority. Inference: fewer manual transfers
should reduce routine operator interaction; no live incident was created to
measure elapsed-time improvement. Promotion decision: no new durable learning.
The existing lifecycle invariant already separates automatic evidence
publication from proof-bearing recovery, and the issue #132 task record is the
narrowest place to record this extension.
