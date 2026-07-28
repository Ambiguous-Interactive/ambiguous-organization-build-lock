# Session 026: cooldown-aware acquire polling

## Scope and hypothesis

On 2026-07-28, review every open issue and pull request, prioritize impact while
minimizing licensed Unity CI churn, complete issue #128, and make a bounded
repository-side advance toward issue #99 without claiming broader consumer
completion.

Hypothesis: acquire's fixed `poll-seconds` sleep delays a FIFO waiter after a
known cooldown expiry, and every fixed loop sleep can cross the advertised
`timeout-minutes` maximum. Bounding state-aware polling by the earliest
validated future cooldown and every explicit delay by the remaining deadline
reduces avoidable lock wait without changing admission, capacity, cleanup, or
incident semantics.

Disconfirming evidence would be an acquire loop that already wakes at cooldown
expiry, a state shape in which `availableAt` is untrusted, or a focused test
showing that the shorter poll admits before expiry or treats quarantine as
available capacity.

Safety invariants:

- Admission remains CAS-protected, FIFO-eligible, and within `maxHolders`.
- A cooldown continues consuming capacity through its exact `availableAt`.
- Quarantine and ambiguous cleanup never gain an expiry or shorten polling.
- API/auth uncertainty, holders, configuration ambiguity, and account
  incidents keep their existing fail-closed behavior.
- No organization policy, live lock configuration, consumer workflow, or
  licensed Unity job changes.

## Issue and pull-request inventory

The clean checkout started at `95f4ce4ef`, equal to `origin/main`. The GitHub
connector returned 13 open issues and no open or draft pull requests.

| Priority | Issues | Disposition |
| --- | --- | --- |
| P0 | #51, #83, #113 | Highest security and production impact, but not safely completable in this repository-only PR. #51 requires organization-policy changes prohibited by the objective. #83 must retain fail-closed quarantine until independent entitlement identities, both return orders, and portal reconciliation exist. #113 closes only after broad consumer remediation and a complete clean audit. |
| P1 | #27, #29, #30, #44, #53, #54, #60 | Require live canaries, multi-day evidence, consumer or ruleset changes, or a new queue/claim protocol. The runbook explicitly blocks #60's zero-cooldown transition on unresolved #83 evidence. |
| P2 | #49 | Requires consumer workflow changes and licensed before/after matrix evidence. |
| P2 | #94 | Externally gated: actionlint v1.7.12 remains latest and still selects yaml/v4 rc.3; the root module is already current on rc.6. |
| P2 | #99 | Selected for a safely actionable low-churn advance: remove deterministic post-cooldown polling delay without consuming a Unity seat or weakening resource evidence. The issue remains broader than this repository change. |

Adversarial review then identified a separate public-contract defect: all five
explicit acquire-loop sleeps could cross the documented `timeout-minutes`
maximum before timeout evidence and cleanup ran. [Issue #128](https://github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/issues/128)
was opened with the exact affected sites, safety boundary, and deterministic
acceptance criteria. It is the selected complete objective for this PR; the
implementation and tests below satisfy every criterion without a Unity run.

Dependency inspection found no root-module update. The isolated actionlint
module reports yaml/v4 rc.6 as newer, but actionlint v1.7.12 is still latest and
does not compile with the changed parser API; issue #94 already tracks that
paired upgrade. No open dependency PR exists.

## Baseline and red-green implementation

The public acquire input defaults `poll-seconds` to 15. The unmodified runtime
pruned expired cooldowns on each loop, but a blocked waiter always slept the
full base delay plus jitter even when a validated reservation said capacity
would become eligible sooner. A 120-second poll with 60 seconds left in the
wait budget could also sleep for the full jittered poll before timeout cleanup,
contradicting the public maximum.

The focused regression first failed with
`TypeError: acquirePollDelayMs is not a function`. Production now computes the
earliest future `cooldown.availableAt`. When it is earlier than the base delay,
the waiter sleeps only until that instant plus 0–249 ms of CAS-collision jitter.
No reservation, a quarantine, an already expired timestamp, or a cooldown
beyond the base interval retains the ordinary base delay and jitter.

The behavioral acquire test uses a 15-second base interval and a cooldown one
second in the future. It observes an exact 1,000 ms timer, then proves the
cooldown is pruned and the next runner acquires. Table-driven unit cases cover
empty state, quarantine, distant and expired cooldowns, earliest selection, and
the jitter boundary.

Every explicit acquire-loop delay is also capped by the remaining acquire
deadline. This includes normal and cooldown-aware polling, the transient-auth
grace delay, and the three CAS/post-write verification retry sites. Auth polling
is additionally capped by the end of its own grace window. Timeout cleanup is
deliberately not removed or skipped: deterministic behavior coverage proves the
deadline wakes at exactly 60,000 ms and then removes the caller's queued
identity; persistent auth failure still makes a final cleanup attempt and
reports that uncertainty.

Both acquire action manifests now carry identical `poll-seconds` metadata.
Their parity contract compares the complete input and output blocks, including
descriptions, requirements, and defaults, rather than only key names.

## Issue #99 evidence boundary

The authoritative open issue says Unity license acquisition and release should
avoid hard sleeps and retry until success. This central change proves only that
a queued acquire re-reads validated state promptly at cooldown expiry and that
the central release path already returns from its CAS-protected state result
without waiting out the cooldown.

Current default-branch GitHub evidence includes bounded activation retry and
bounded return retry in DoxReloaded, and search results identify activation
retry implementations or tests in DxMessaging, IshoBoy, and qora-redux.
However, `unity-enrollment-policy.json` registers six repositories, the central
enrollment analyzer validates lock/cleanup wiring rather than the internal
activation and return retry algorithms, and this remediation did not obtain an
exact-snapshot, path-by-path proof for every non-synthetic licensed workflow.
Therefore this change must not claim to complete or close issue #99. Closure
requires exhaustive current consumer evidence (including bounded failure and
return behavior) plus whatever licensed before/after timing evidence the issue
owner accepts.

## Validation, review, and delivery

Fresh remediation validation passed:

```text
node --test --test-name-pattern='acquire polling wakes promptly|schema 4 cooldown blocks cross-runner admission' test/build-lock.test.js
node --test --test-name-pattern='acquire retry delays|acquire polling wakes promptly|auth grace sleep stops|base poll stops exactly|schema 4 cooldown blocks' test/build-lock.test.js
node --test --test-name-pattern='legacy and opt-in acquire actions expose the same interface' test/action-manifests.test.js
node --test test/build-lock.test.js test/action-manifests.test.js test/documentation-policy.test.js
git diff --check
```

The combined adjacent run passed 394 tests. Fresh post-remediation
`.devcontainer/scripts/verify.sh` passed the LLM harness, actionlint, all 590
Node tests, every Go package, both module verification and tidy-diff checks,
and the workflow credential audit. `git diff --check` also passed.

## Independent review remediation dispositions

- **Issue #99 scope proof — justified.** The prior claim to complete issue #99
  was stronger than the evidence. The record now distinguishes the central
  polling improvement from exhaustive consumer acquire/return proof and
  explicitly leaves issue closure unsupported.
- **Opt-in manifest synchronization and parity — justified.** Updated
  `acquire-build-lock-with-cleanup/action.yml` and strengthened the contract test
  to compare complete public input/output blocks.
- **Acquire deadline bounding — justified.** Added one common delay clamp to all
  five explicit acquire-loop sleep sites. Focused table cases cover base,
  cooldown, auth, CAS, and elapsed deadlines; behavior cases cover exact timeout,
  successful queue cleanup, and attempted cleanup under persistent auth failure.
  Cancellation still uses the existing abort signal, and cleanup uncertainty
  remains fail closed.

Continuous-improvement outcome: **revise** the lifecycle invariant reference so
future acquire changes preserve deadline-bounded sleeps without suppressing
post-timeout cleanup. Observed evidence was the five uncapped runtime sleep
sites, the public timeout maximum, the deterministic injected-clock failures,
and the corrected timeout cleanup behavior. This is durable repository-specific
knowledge rather than a task-only optimization, so the narrow lifecycle
reference was the authoritative promotion target; generated index content did
not change.

Implementer: root agent. Independent reviewer: `session026_review`.
Remediator: `session026_remediation`. Review round 1 found the unsupported #99
closure claim, stale opt-in manifest metadata, and uncapped timeout sleeps. The
remediator left #99 open, synchronized and strengthened manifest parity, capped
all five delay sites, added deadline and cleanup coverage, and promoted the
lifecycle invariant. Fresh independent reviewer `session026_rereview` then
audited every #128 criterion and the complete revised diff and reported no
actionable findings.

Delivery, reviewer feedback, merge, and post-merge `main` evidence remain to be
recorded.
