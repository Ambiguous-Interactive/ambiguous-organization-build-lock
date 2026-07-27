---
summary: Task record for the fail-closed organization Unity enrollment audit.
---
<!-- summary: Build and validate the fail-closed six-repository Unity enrollment audit. -->
# Task: organization Unity enrollment audit

## Acceptance criteria

- Audit the declared six-repository inventory, including private/internal
  repositories and the `unity-builder` fork, from exact default-branch commits.
- Classify every Unity-related job without treating checked-in text fixtures as
  paid consumers.
- Reject paid jobs without immutable approved lock actions, acquire-before-
  activation, typed always-run release, cleanup classification/final gate,
  self-hosted runner preflight, and an always-reporting aggregate.
- Reject approval environments, job-scoped Unity/writer credentials, unsafe
  cancellation, matrix fail-fast, and mutable remote actions.
- Fail closed when any repository, commit, workflow, or policy exception is
  missing, malformed, stale, or changes during the audit.
- Open or update one sanitized deduplicated drift issue; close it only after a
  complete clean audit.
- Run daily, manually, and after relevant policy changes without consuming a
  Unity license.

## Baseline

- Command: GitHub issue/PR inventory plus `go test ./...`.
- Observed result: issue #42 is open; no open or draft PR implements it. The
  existing analyzer enforces cancellation/current-head policy only and the
  scheduled workflow audits only registered DxMessaging Unity files.
- Reproduction status: reproduced.

## Hypothesis

- Claim: extending the exact-commit enrollment analyzer and running it over a
  strict reader-App-scoped registry can detect policy drift without executing
  consumer code or Unity.
- Disconfirming evidence: a fixture with an unprotected `UNITY_SERIAL`
  reference passes, a repository can be omitted without failure, retrieval can
  be partial while reporting green, or issue output exposes source/credentials.
- Falsified hypotheses: issue #83 can be solved by serializing return; measured
  behavior and the current shared entitlement mean one serialized return still
  occurs second.

## Red

- Test: focused Go enrollment policy fixtures.
- Expected failure: the organization enrollment policy API does not yet exist.
- Observed failure: `go test ./internal/enrollment` failed to compile with
  `undefined: AnalyzeUnityEnrollment` and the related policy types before the
  implementation was added.

## Risk and path matrix

- Positive: six exact commits, safe paid jobs, clean sanitized inventory.
- Negative: unprotected secret, mutable/old action, missing lifecycle step,
  environment gate, job-scoped credential, expired/unregistered exception.
- Error: missing repository, checkout failure, malformed YAML/policy, moving
  default branch, API/issue synchronization failure.
- Boundary/extreme: zero Unity references, duplicate repositories/exceptions,
  empty inventory, bounded issue output.
- Concurrency/ordering: acquire precedes activation; release/classifier/gate
  ordering is preserved; default heads are revalidated after analysis.
- Cancellation/recovery: audit concurrency never cancels a running audit and
  the alert synchronizer runs after failed analysis.
- Determinism/isolation: sorted outputs, fixed clocks in tests, exact Git
  objects, no consumer code execution.
- Contract synchronization: registry, workflow, analyzer, tests, docs,
  operations facts, and generated knowledge index.

## Green

- Minimal change: strict six-repository registry; exact-object analyzer;
  source-free bounded artifact; marker-fenced issue synchronizer; daily/manual
  reader-App workflow with exact-head revalidation; policy/docs invariants.
- Focused result: enrollment and command Go packages pass; workflow and
  documentation policy suites pass. A no-Unity dry run over the three public
  consumers produces only retrieval findings for the unavailable private
  repositories plus concrete lifecycle findings, with no credential values or
  matched source.

## Full validation

- Commands and exact outcomes: `node tools/llm-harness.mjs generate` updated
  the generated index; `.devcontainer/scripts/verify.sh` passed 555 Node tests,
  every Go package, actionlint, both module-verification checks, tidy-diff,
  workflow credential audit, and knowledge-harness checks.

## Adversarial review

- Unsafe success paths considered: partial repository retrieval, moving default
  heads, mutable or old pins, local-composite indirection, synthetic fixtures,
  unbounded triggers, incomplete return evidence, missing aggregate, duplicate
  alerts, hostile output fields, and oversized issue content.
- Intent-to-diff status: implementation covers exact reads, classification,
  lifecycle/trigger/preflight/aggregate enforcement, sanitization, issue
  synchronization, daily/manual delivery, and retained evidence. Live
  reader-App and private-repository behavior remains post-push evidence.
- Unverifiable items and open questions: live reader-App checkout and issue
  synchronization require exact-head Actions evidence.
- Remaining uncertainty: private/internal repository access, live reader-App
  scope, `workflow_run` delivery, exact-head revalidation, and real issue
  create/update/close require post-push Actions evidence.
- Implementer: root agent.
- Reviewer and evidence: independent `issue42_adversarial` agent reviewed the
  complete worktree and ran focused Go, Node, and credential-audit checks.
- Actionable findings: unsafe aggregate recognition, incomplete inherited and
  composite credential detection, syntactic cleanup provenance, permissive
  triggers, selected-ref manual secret exposure, and inconsistent registry
  expansion.
- Remediator and dispositions: distinct `issue42_remediation` agent added red
  regressions and closed the analyzer/registry findings. Root split manual
  dispatch into a secretless launcher and trusted-default-branch
  `workflow_run`. The reviewer accepted command-level drift failure plus a
  synchronized operational-red issue as consistent with #42; incomplete
  evidence or synchronization remains workflow-red.
- Latest review round outcome: two fresh review rounds found additional alias,
  PR-origin, shell-evidence, aggregate, condition, and dynamic-secret escape
  hatches. The remediator replaced permissive inference with conservative
  canonical contracts and added regressions. Final focused re-review reported
  no findings.
- Main-thread fallback reason: not applicable; independent agents are available.

## Knowledge retention

- Trigger or exemption: substantial security/policy automation.
- Evidence: the public dry run exposed local composite indirection and
  noncanonical shell evidence; adversarial fixtures proved substring-based
  shell recognition and name-based secret checks are unsafe.
- Observed facts, inferences, and open questions: exact workflow structure can
  be proven statically; arbitrary shell semantics cannot. Private-repository
  retrieval and App scope remain live-only facts.
- Root cause or reusable insight: security policy analyzers should recognize
  narrow canonical contracts and fail closed on dynamic secret lookup or
  unstructured evidence rather than infer intent from substrings.
- Promotion decision: retained in the analyzer invariants, regression suite,
  README, and operations runbook.
- Destination or rationale: these are durable enrollment and incident-response
  contracts used by maintainers and future policy changes.
- Independent review outcome: final focused re-review reported no findings;
  live-only evidence remains explicitly deferred to the post-push workflow.
