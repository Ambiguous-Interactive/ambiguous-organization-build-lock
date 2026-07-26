# Session 014: invalid cleanup reports cannot strand lock ownership

Date: 2026-07-26

Status: complete; implementation merged and verified green on main

## Objective and boundary

Review every open repository issue, prioritize impact while minimizing licensed
Unity churn, and complete the highest-priority coherent zero-Unity scope.

Issue #89 is selected. A malformed or contradictory cleanup report currently
throws in `config()` before release reads or writes lock state, so diagnostic
validation can strand a live holder for its lease. Issue #88 is the safely
related completed prerequisite: `return-ulf-skipped` is already classified and
allowlisted on `main`, but the issue remains open pending delivery evidence.

This change does not alter lock schema, configured capacity, queue ordering,
caller authorization, recovery proof, consumer workflows, organization policy,
or Unity execution.

## Open-issue priority

All 17 issues open at session start were read through the connected GitHub App.
There were no open or draft PRs. The dependency experiment later produced the
detailed out-of-scope follow-up #94, bringing the open inventory to 18.

| Priority | Issues | Impact and churn assessment |
| --- | --- | --- |
| P0 selected | #89, with #88 | A production-observed input-validation failure can strand the organization-wide lock. The whole class is reproducible and fixable in the committed action runtime with no Unity use. #88's precise reason is already present and tested on `main`. |
| P0 constrained | #51 | Broad writer/Unity secret visibility is the highest security boundary risk, but remediation requires owner-authorized organization settings and policy changes that this session is explicitly prohibited from making. |
| P1 | #83, #84 | Repeated `400006` return collisions and false quarantines affect live throughput. A safe semantic change needs two-identity return-order and portal evidence; classifying the event clean without that evidence would weaken fail-closed cleanup. |
| P1 | #42, #44 | Continuous enrollment and truthful required checks close important policy gaps, but require cross-repository and ruleset changes with broad CI/Unity churn. |
| P1 | #77 | Delayed scheduled reaping extends capacity loss. The issue needs independent monitoring and concurrency design; #89 is the more immediate deterministic wedge. |
| P1 | #53 | Pre-FIFO runner starvation affects fairness and throughput, but requires a new two-phase admission architecture and multi-repository load evidence. |
| P2 | #29, #30 | Operational rollout trackers contain multiple live canaries, monitoring windows, and security tasks rather than one bounded zero-churn implementation. |
| P2 | #85 | Central cleanup policy exists; remaining consumer adoption is cross-repository and intentionally staged to limit Unity churn. |
| P2 | #60 | Literal zero cooldown requires publishing, repinning consumers, a config change, and live canaries. The current one-second transition remains safe. |
| P2 | #49 | Compatibility-matrix throughput is material but requires consumer policy changes and paid Unity before/after evidence. |
| P2 | #54 | The remaining Isho cleanup evidence is explicitly a paid licensed canary. |
| P3 investigate/close | #27 | The issue contains only an old run link and predates multiple lifecycle fixes; it needs refreshed causal evidence before another production change. |
| P3 not a defect | #79 | JavaScript `Date.now()` is already milliseconds since the UTC Unix epoch; replacing it with a .NET API is not applicable. |
| P3 dependency follow-up | #94 | The latest yaml parser is source-incompatible with the latest actionlint release. The detailed zero-Unity tracker records the reproduction and joint-upgrade gate. |

## Baseline and hypothesis

- Baseline command:
  `node --test --test-name-pattern='release report compatibility|schema 5 uncertainty reasons' test/build-lock.test.js`
- Baseline result: 9/9 tests passed, confirming strict report validation and
  existing unknown-cleanup quarantine semantics independently.
- Source observation: `config()` called `parseReleaseReport()` before
  `release()`, and every invalid rule threw before state-branch access, state
  read, or CAS cleanup.
- Hypothesis: resolve only recognized report-validation failures to one
  `unknown/healthy/cleanup-evidence-unknown` report, run exact CAS cleanup, then
  fail the action. If correct, the holder becomes a quarantine, outputs remain
  diagnostic, and CI cannot report false success.
- Disconfirming evidence: any invalid case reaches no state write, frees
  capacity as confirmed, creates an account incident without confirmed `20111`,
  logs/persists the rejected value, succeeds the action, or changes queue/CAS
  behavior.

## Red and green

The initial red test added nine validation classes plus a holder-level
integration. It failed 11/11 subtests because `resolveReleaseReport` did not
exist. Independent review later found a tenth contradictory tuple that the
authoritative classifier could never emit:
`confirmed/blocked/unity-account-limit-20111`.

The implementation attaches stable codes to expected validation errors,
resolves them to one conservative runner-local unknown report, and preserves
unexpected exceptions. Release writes two synchronized outputs:
`report-degraded` and `report-validation-error`. It warns using only the stable
code, removes exact ownership through the existing CAS path, writes normal
release outputs, and then throws. The rejected value is neither logged nor
stored.

Latest focused green evidence after review remediation:

- ten invalid classes, committed release-entrypoint wiring, exact schema-5
  holder quarantine/no-incident behavior, and degraded queue/noop diagnostics:
  16/16 passed;
- complete build-lock suite: 331/331 passed;
- adjacent manifest, classifier, and final-gate suites: 102/102 passed;
- JavaScript syntax and `git diff --check`: passed.

## Risk and path matrix

- Positive: valid typed and legacy reports retain their exact status, reason,
  reservation, incident, and action-success behavior.
- Negative: invalid enum values, invalid legacy boolean, every cross-field
  contradiction, and legacy/typed contradiction degrade to one safe report.
- Error: unexpected parser exceptions still throw before state mutation;
  GitHub read/write/retry and ambiguous-CAS behavior remains in the existing
  `cleanupIdentity` path.
- Boundary: missing reports retain the legacy unknown default; caller-controlled
  rejected text is not emitted.
- Concurrency: no new state transition exists; exact identity, attempt fencing,
  fresh reads, conflict retries, and ambiguous-write reconciliation are reused.
- Cancellation/recovery: a degraded held release creates an exact runner
  quarantine and fails red; operators recover only by reservation ID and
  external proof.
- Contract: committed runtime, action manifest, exact output tests, README, and
  operations runbook are synchronized.

## Dependency review

No dependency PRs were open. Immutable GitHub Action pins match the latest
upstream tags: `actions/checkout` v7.0.1, `actions/setup-node` v7.0.0,
`actions/setup-go` v7.0.0, `devcontainers/ci` v0.3.1900000450, and
`cycjimmy/semantic-release-action` v6.0.0. The pinned semantic-release runtime
is latest at 25.0.8. The root Go module has no update.

The isolated actionlint graph advertised a parser update from
`go.yaml.in/yaml/v4` rc.3 to rc.6. A measured upgrade failed to compile
actionlint v1.7.12 because rc.6 changed parser error types used by actionlint.
The update was reverted; v1.7.12 is the latest actionlint release, so rc.3 is
the latest compatible parser for the pinned verifier. `goldmark` and `x/net`
also advertise newer module versions but are unused transitive requirements of
actionlint rather than packages in this verifier build; adding direct overrides
would bloat the isolation module without changing the built tool.
Issue #94 records the exact reproduction and the acceptance criteria for a
joint actionlint/parser update after upstream compatibility exists.

## Validation, review, and delivery

The latest complete repository CI-equivalent verifier passed 550 Node tests, all Go
packages, actionlint, both module checksum and tidy checks, the knowledge
harness, JavaScript syntax, and the credential-literal audit. The first full
run found the incompatible `yaml/v4` experiment described above; the dependency
was reverted and the complete verifier then passed from a fresh run.

This public safety change triggered the continuous-improvement gate. The
observed root cause is that evidence validation and ownership cleanup shared one
pre-release control path. The narrow reusable rule is now retained in the
existing build-lock invariant reference: invalid diagnostics must degrade
conservatively and fail only after exact ownership cleanup is attempted.

## Independent adversarial review and remediation

- Implementer: root agent.
- Independent reviewer: `/root/adversarial_review`, read-only.
- Finding 1, high: `confirmed/blocked/unity-account-limit-20111` bypassed
  degradation, could create an organization-wide incident, and returned success
  despite a contradictory tuple.
- Finding 2, low: degraded queue-only/noop and legacy-schema messages claimed a
  holder release and quarantine that may not exist.
- Remediator: distinct `/root/remediate_review` agent.
- Disposition: both findings accepted and fixed. The parser now requires the
  classifier's canonical `unknown/blocked/unity-account-limit-20111` shape;
  contradictory input becomes a runner-local unknown quarantine and fails red.
  Diagnostics now name the actual `cleanup-result` and qualify lifecycle
  quarantine support. Exact-holder, no-global-incident, queue-only, and noop
  regressions pass.
- Latest review round: no actionable findings. The reviewer independently
  passed 38 focused tests plus 42 manifest/documentation tests, the harness, and
  diff checks. Real GitHub runner execution and Unity portal state remain
  intentionally outside this zero-Unity change; degraded-report cleanup reuses
  the existing independently tested ambiguous-CAS reconciliation path.

## Delivery and main verification

- PR #95 contained one implementation commit,
  `99b5495ee7d05eab2b998e146bf8d39a4f1b27a1`, whose tree
  `e3e2915e1fb163aa57505d56f0733924db4ff8d3` exactly matched the locally
  verified tree.
- Build lock CI run `30211924882` passed every validation step on that exact PR
  head.
- Cursor Bugbot reviewed that exact head and found no new issues. Copilot was
  explicitly requested and returned its terminal quota-limit response without
  code feedback. No review thread remained.
- PR #95 was squash-merged as
  `ce45a46a1bbd740b1a078be68809b3e06ac6e045`.
- Push-triggered Build lock CI run `30212609375` passed on that exact merge
  commit. Issues #88 and #89 closed as completed.
- Dependency compatibility follow-up #94 remains open with a reproducible,
  zero-Unity acceptance contract.

No Unity workflow, licensed seat, portal mutation, organization policy change,
or credential value was used for this delivery.
