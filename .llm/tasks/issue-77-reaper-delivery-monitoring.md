<!-- summary: Task record for independent scheduled-reaper delivery monitoring and uncancellable proof-bearing recovery. -->
# Task: Detect delayed reaping without canceling recovery

## Acceptance criteria

- Documentation distinguishes the requested five-minute cron from observed and
  guaranteed delivery.
- An independent data-driven audit detects overdue, stalled, unsuccessful, or
  missing scheduled reaper runs without depending on the reaper having run.
- One deduplicated incident contains only run IDs, timestamps, reason codes,
  and commit SHAs.
- Missing or ambiguous API evidence and unconfirmed issue synchronization fail
  red.
- A scheduled reaper cannot cancel running or pending proof-bearing recovery.
- No Unity activation, licensed runner, organization policy, or credential
  value is required.

## Baseline

- Command: `node --test test/workflow-policy.test.js
  test/documentation-policy.test.js`
- Observed result: 61/61 passed, while the workflow contract explicitly
  required `cancel-in-progress: true` and the README claimed the reaper ran
  every five minutes.
- Reproduction status: root cause demonstrated from the workflow and GitHub
  concurrency contract; issue #77 supplies measured 22.1-85.9 minute delivery
  gaps.

## Hypothesis

- Claim: a separate least-privilege monitor can classify sanitized workflow-run
  metadata and synchronize one operational issue, while separating
  proof-bearing recovery from scheduled reaping prevents schedule-driven
  cancellation without weakening CAS state fencing.
- Disconfirming evidence: any schedule can cancel pending recovery; a known
  alert creates duplicate issues or permanently fails healthy monitoring; API
  ambiguity passes green; incident content includes source lines, credentials,
  or raw output; or consumer Unity CI is required.
- Falsified hypotheses: a shared concurrency group with
  `cancel-in-progress: false` is insufficient because GitHub replaces an older
  pending run when another run enters the group.

## Red

- Go test: the new monitor suite failed to compile because the command did not
  exist.
- Node tests: six checks failed for the missing monitor workflow/facts and the
  old cancellation semantics.
- The failures represented missing behavior rather than an implementation
  detail.

## Risk and path matrix

- Positive: recent completed success and bounded active run; healthy state
  closes an existing incident and does not churn a closed issue.
- Negative: overdue, stalled, unsuccessful, and absent run history synchronize
  one known operational alert.
- Error: unavailable, malformed, oversized, trailing, or cross-origin API
  evidence and failed incident synchronization fail red.
- Boundary/extreme: at most two workflow runs, bounded four-MiB responses,
  bounded ten-page issue discovery, exact repository/workflow syntax, monotonic
  timestamps, full commit SHAs, and fixed reason codes.
- Concurrency/ordering: scheduled/manual reaping queues without canceling its
  running operation; recovery has no automatic concurrency cancellation;
  concurrent state attempts retain existing exact-ID CAS/retry fencing.
- Cancellation/recovery: scheduled work cannot share a cancellation group with
  proof-bearing recovery; recovery still requires exact ID and external proof.
- Determinism/isolation: injected UTC clock, `httptest` API fixtures, no sleeps,
  credentials, network, Unity, or runner use.
- Contract synchronization: workflows, committed diagnostic runtime, workflow
  tests, operations facts, README, lock docs, runbook, and progress log.

## Green

- Minimal change: one standard-library Go monitor, one least-privilege monitor
  workflow, one manual recovery workflow, reaping-only scheduled workflow,
  synchronized guidance/facts, and focused behavioral/contract tests.
- Focused result: the Go monitor suite, 395 adjacent Node tests, actionlint, and
  the workflow credential audit pass.

## Full validation

- `.devcontainer/scripts/verify.sh`: 553 Node tests, all Go packages,
  actionlint, both module verify/tidy gates, LLM harness, JavaScript syntax, and
  credential audit passed after final remediation.
- `go test -race ./cmd/reaper-delivery-audit`: passed.
- `git diff --check` and `node tools/llm-harness.mjs check`: passed.
- PR-head Build lock CI run 30219668279 passed on exact head
  `3f2fe9102969810dfbf38869b1828dc3c2584228`.
- Post-merge Build lock CI run 30219771920 passed on exact main commit
  `9f44e4a253108cdd884145d4eb95e2d0ad50b857`.
- Default-branch scheduled delivery audit run 30220739735 and job 89842628232
  passed on that same main commit with a `healthy` result and no open incident.

## Adversarial review

- Unsafe success paths considered: pending-run replacement despite
  `cancel-in-progress: false`, known alert versus broken monitor state,
  cross-origin token forwarding, oversized bodies, pagination escape,
  malformed timestamps/SHA/status, issue duplication, API-write churn, stale
  recovery workflow names, and concurrent recovery/reaping.
- Intent-to-diff status: PR #97 merged, issue #77 closed, exact-head plus
  post-merge main CI passed, and the first scheduled audit completed healthy.
- Unverifiable items and open questions: GitHub schedule delivery remains
  best-effort; a bounded recovery SLO needs an independent external trigger.
- Remaining uncertainty: GitHub schedule delivery remains best-effort and a
  bounded recovery SLO still requires an external trigger.
- Implementer: primary agent.
- Reviewer and evidence: main-thread fresh diff-first review because the active
  agent mode prohibits spawning unless explicitly requested.
- Actionable findings: shared false-cancel concurrency still allowed pending
  recovery replacement; known alerts wrongly poisoned main; queued API status
  handling was too narrow; closed healthy incidents caused repeated writes;
  live release facts were stale; and a public marker let an untrusted user
  pre-create the issue that the monitor would mutate.
- Remediator and dispositions: primary agent accepted and fixed every finding
  with workflow separation, result-state separation, supported pending states,
  no-op closed health, redirect fencing, bot-author ownership and duplicate
  rejection, and v1.9.1 fact synchronization.
- Latest review round outcome: no actionable findings after fresh diff review,
  553-test full verification, the race-enabled monitor suite, and Cursor
  Bugbot review of the exact PR head. Copilot was requested through both the
  reviewer API and an exact-head tagged comment but reported exhausted
  requester quota.
- Main-thread fallback reason: sub-agents were not explicitly requested and
  current multi-agent instructions prohibit proactive delegation.

## Knowledge retention

- Trigger or exemption: substantial operations/workflow safety change.
- Evidence: red/green suites, final diff, 553-test verifier, race-enabled
  monitor suite, and the remediated review findings above.
- Observed facts, inferences, and open questions: a false-cancel concurrency
  group does not preserve pending work; monitor health and monitored resource
  health are distinct. An external scheduler remains an open operational
  decision.
- Root cause or reusable insight: proof-bearing operations must not share
  replaceable pending concurrency with periodic work.
- Promotion decision: revise.
- Destination or rationale: `.llm/skills/github-workflow-policy/SKILL.md` now
  records that false-cancel concurrency can still replace pending work and
  periodic jobs must not share a group with proof-bearing recovery.
- Independent review outcome: main-thread review clean after remediation; not
  independent for the fallback reason recorded above.
