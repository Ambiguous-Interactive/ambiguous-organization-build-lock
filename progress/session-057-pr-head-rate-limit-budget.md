# Session 057: fail early on an unhonorable PR-head rate limit (issue #203)

Date: 2026-08-20

## Objective and safety invariants

Complete issue #203 without consuming a Unity seat or weakening admission:

- a `403` with `Retry-After: 60` makes one request under the guard's 30-second
  budget and reports why no retry can succeed;
- an instruction that fits the remaining budget retains the existing bounded
  wait and retry behavior;
- the standalone action still exits nonzero and leaves `is-current` unwritten;
- embedded acquire callers still treat lookup failure as terminal validation
  failure before lock-state access.

No lock schema, queue, holder, cleanup, credential scope, workflow, action
manifest, consumer pin, or Unity execution changes are in scope. Missing or
ambiguous PR evidence remains fail closed.

## Live issue, PR, and dependency triage

At baseline GitHub reported 16 open issues, no open or draft PR, and a clean
`main` synchronized with `origin/main` at `ec14cc50`. Priority weighs production
and security impact first, then favors work that creates the least licensed
Unity churn. A lower rank can reflect missing authority or live-evidence cost,
not low raw severity.

| Rank | Issue | Impact and Unity-CI cost | Disposition |
| ---: | --- | --- | --- |
| 1 | #203 | PR-head guard wastes requests against a rate limit it cannot outwait; repository-only, zero Unity churn. | Selected. |
| 2 | #206 | A second cross-repository checkout has failed in the trusted Unity prefix. | High benefit, but imports a 260 KiB validator and requires consumer contract work. |
| 3 | #83 | Concurrent returns repeatedly produce runner quarantine after entitlement collisions. | Highest licensed-path impact; needs independent entitlement and two-holder evidence. |
| 4 | #113 | Latest enrollment audit reports 168 findings across 94 active inventory rows. | Broad multi-consumer remediation with substantial Unity churn. |
| 5 | #51 | Writer and Unity secret visibility exceeds the reviewed enrollment perimeter. | Security critical, but completion requires forbidden organization-policy changes and owner probes. |
| 6 | #44 | Consumer merges are not uniformly gated by truthful Unity aggregates. | Requires consumer rulesets and representative licensed runs. |
| 7 | #188 | Two workflows use deprecated App-ID input semantics. | Zero Unity churn, but requires a distinct owner-provisioned client-ID secret. |
| 8 | #53 | Self-hosted jobs can starve before entering the central FIFO. | Significant admission architecture and multi-runner canaries. |
| 9 | #49 | The unity-helpers compatibility graph can consume capacity for over an hour. | Needs a data-backed matrix policy and broad paid CI evidence. |
| 10 | #99 | Acquire and return paths still lack exhaustive timing and retry evidence. | Consumer-wide measurement and licensed canaries remain. |
| 11 | #60 | Literal zero cooldown remains unapplied despite released support. | Requires consumer re-pins and a cross-runner zero-20111 canary. |
| 12 | #153 | Container-owned Windows and native Darwin activations lack a trusted cleanup contract. | New platform behavior plus Windows/macOS licensed canaries. |
| 13 | #94 | Isolated actionlint remains incompatible with yaml/v4 rc.6. | Upstream actionlint v1.7.12 is still latest; no safe update exists. |
| 14 | #29 | Remaining lifecycle and monitoring canaries gate operational closure. | Controlled live Unity work rather than a checkout-only change. |
| 15 | #27 | Original lock-held incident shares #29's zero-incident closure gate. | Tracker evidence, not an independent code fix. |
| 16 | #30 | Secure-rollout umbrella retains owner audits and child closure. | Close only after its remaining children and owner work. |

Fresh dependency checks found no update to apply:

- `go list -m -u -json all` and the isolated actionlint equivalent returned no
  module with an available update;
- all nine immutable GitHub Action pins resolve to the latest stable release;
  the golangci-lint action pin is the peeled commit for annotated tag `v9.3.0`;
- GitHub reported no open dependency PR or any other open PR.

## Baseline, hypothesis, and red evidence

Observed source facts:

- the guard has `MAX_ATTEMPTS = 3` and an internal 30-second abort timeout;
- a valid server instruction is capped to 10 seconds before the caller can
  compare it with that budget;
- the retry loop discards the response, sleeps, and makes another request until
  attempts are exhausted.

Falsifiable hypothesis: retain the raw instruction long enough to compare it
with a monotonic internal deadline. If it cannot fit, discard the response and
fail immediately; otherwise preserve the 10-second delay cap and exponential
fallback. A second request after an unhonorable instruction, any output write,
success exit, changed fitting-delay behavior, or an embedded acquire regression
would disprove the implementation.

The focused red command selected the two new unit contracts. The fitting-delay
control passed. The over-budget case failed for the intended reason: it observed
the generic `GitHub pull request lookup failed with HTTP 403` after all three
requests instead of the new budget diagnosis after one.

## Architecture and verification map

Chosen approach: split raw `Retry-After` parsing from the existing capped delay,
start a monotonic deadline beside `AbortSignal.timeout`, and compare raw delay
with the remaining duration after response cleanup. Rate-limit statuses receive
the issue's specific diagnosis; other retryable statuses receive an exact
`Retry-After` budget diagnosis.

Rejected alternatives:

- increasing the 30-second guard budget would increase PR admission latency and
  still leave longer instructions unhonorable;
- removing the 10-second cap changes behavior explicitly preserved by #203;
- retrying immediately or truncating again repeats the defect;
- changing the action manifest or public inputs is unnecessary because the
  timeout remains an internal safety bound.

Affected surface and flow:

1. Standalone `require-current-pr-head` validates inputs and fetches the live PR.
2. Embedded `build-lock.js` calls the same function before lock-state access.
3. Retryable responses are classified, their bodies discarded, and either fail
   early or use the unchanged bounded retry delay.
4. Failure throws before PR JSON parsing or output writes; the standalone
   wrapper sanitizes the diagnosis and sets exit code 1.

Failure and recovery coverage:

- valid over-budget delta instruction: one request, body discarded, no sleep,
  specific terminal diagnosis;
- valid fitting instruction above the 10-second cap: one capped sleep and retry;
- invalid or absent instruction: unchanged exponential fallback;
- final retry, non-retryable status, request abort, and malformed success body:
  unchanged fail-closed paths;
- cancellation and timeout: the existing combined abort signal still governs
  fetch and default sleep;
- concurrency and persistent state: inapplicable; the guard writes no remote
  state and embedded failure occurs before lock access.

Compatibility and rollback: action inputs, outputs, manifest entrypoint, Node 24
runtime, attempt count, timeout, and delay cap are unchanged. A complete
synchronized rollback must revert the action runtime, its current-PR-head
regression tests, the README retry contract, the testing-skill guidance, and the
README contract assertions in `test/action-manifests.test.js` together. Reverting
only the runtime and its unit tests restores the prior request pattern without a
data migration, but would leave documentation and agent guidance claiming a
behavior the runtime no longer provides.

Verification maps the issue criteria to `test/current-pr-head.test.js` unit and
child-process tests, embedded caller behavior to `test/build-lock.test.js`, and
runtime/manifest synchronization to `test/action-manifests.test.js`. The full
repository verifier remains the final local gate. No product or operator choice
is needed; residual risk is limited to GitHub returning a novel rate-limit form
without a valid `Retry-After`, which retains bounded generic retry behavior.

## Implementation and focused evidence

- Raw server instructions are parsed independently from the retained 10-second
  capped delay policy.
- A monotonic deadline mirrors the internal abort timeout and is injectable for
  deterministic tests.
- An unhonorable response is discarded before the guard throws; no retry sleep
  or output write occurs.
- A real local HTTP child-process test proves one request, exit code 1, the
  sanitized rate-limit-budget diagnosis, and no output file creation.

Focused results:

- `node --test test/current-pr-head.test.js`: 28 passed, 0 failed.
- `node --test test/current-pr-head.test.js test/build-lock.test.js
  test/action-manifests.test.js`: 516 passed, 0 failed.
- `git diff --check`: passed.

## Full validation

`bash .devcontainer/scripts/verify.sh` exited 0:

- LLM harness generation drift and policy checks passed;
- 785 Node tests ran: 783 passed, 2 expected hosted-Windows skips, 0 failed;
- all Go tests, module verification and tidy-diff checks passed;
- Go vet, race tests, golangci-lint, actionlint, JavaScript checks, ShellCheck,
  workflow policy, and credential-literal audit passed.

No licensed Unity job or external state mutation is part of local verification.

## Adversarial review

Roles:

- implementer: main agent;
- reviewer: the same independent read-only sub-agent performed the initial,
  follow-up, and final-review passes;
- remediator: distinct remediation agent
  `/root/issue203_knowledge_remediation`.

The initial reviewer independently mapped every issue criterion to the diff,
inspected the standalone action, embedded build-lock caller, manifest, and tests,
and reported **zero actionable findings**. It separately passed:

- the 28-test focused suite;
- 488 embedded-caller and manifest tests;
- additional elapsed-budget probes;
- the complete verifier with the same 783 passes and 2 platform skips;
- `git diff --check`.

On follow-up, the same reviewer reported one medium actionable finding: the
knowledge retention decision was incorrect because issues #200 and #203
demonstrate the same recurring information-loss class, while the testing skill
required only test mechanics and did not state the decision-order invariant.
The reviewer also found the README's claim that every action shares one
60-second ceiling contradicted the PR-head guard's intentionally retained
10-second cap and 30-second budget. The finding was accepted. The remediator
added the durable rule to the narrow existing skill, scoped the README's
60-second behavior to the shared client, documented the PR-head exception, and
strengthened the README contract test.

On final review, the same reviewer confirmed that medium finding was fixed and
reported two progress-record findings: the roles incorrectly described a
distinct follow-up reviewer, and the rollback covered only runtime and unit-test
files rather than every synchronized contract surface. Both findings were
accepted and fixed in this record. Independent re-review of these final
record-only edits reported zero actionable findings. The latest review round
therefore has no unresolved finding.

## Knowledge retention

Trigger: public fail-closed action behavior and its independently maintained
tests changed, and the task required a multi-step investigation and task record.

- **Observed fact:** the guard discarded the raw server instruction by applying
  its delay cap before the bounded caller could decide whether a retry was
  possible. The red test reproduced three requests and a generic diagnosis.
- **Observed fact:** retaining the raw duration until after response cleanup
  makes the remaining-budget decision deterministic while preserving both
  existing delay policies.
- **Observed fact:** issue #200 previously truncated the shared client's raw
  instruction to a backoff cap; issue #203 repeated the information-loss class
  in a separate guard before a caller-specific budget decision.
- **Observed fact:** the testing skill required injected clocks and assertions
  for retries, delays, diagnostics, and deadlines, but did not require retaining
  the raw instruction until semantic and budget decisions were complete.
- **Inference:** preserving the raw instruction through those decisions prevents
  this class without imposing one sleep ceiling or deadline policy on callers
  with different contracts.
- **Open question:** none for this scope.

Decision: **revise** existing guidance. The durable rule now lives in
`.llm/skills/testing-and-validation/SKILL.md`: preserve raw external retry
instructions until every caller-specific semantic and remaining-budget decision
is complete, then cap only the eventual sleep under that caller's contract. The
README and `test/action-manifests.test.js` state and enforce the shared-client
60-second behavior without universalizing it, and make the PR-head guard's
10-second cap, 30-second budget, and fail-early exception explicit.

Remediation validation:

- `node tools/llm-harness.mjs generate`: regenerated `.llm/index.md`, exit 0;
- `node tools/llm-harness.mjs check`: passed;
- the skill-creator `quick_validate.py` could not run directly because it is not
  executable, and `python3` could not import its uninstalled `yaml` dependency;
  the repository harness remained the authoritative successful skill check;
- the first combined focused run exposed two stale README regex expectations
  after the prose was scoped; no runtime assertion failed;
- final `env -u FORCE_COLOR node --test test/current-pr-head.test.js
  test/build-lock.test.js test/action-manifests.test.js`: 516 passed, 0 failed.

## Publication and post-merge evidence

Pending commit, PR CI/reviewer feedback, merge, and post-merge `main`
verification. This section will be updated only with observed remote evidence.
