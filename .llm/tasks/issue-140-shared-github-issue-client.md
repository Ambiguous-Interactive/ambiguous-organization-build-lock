<!-- summary: Task record for centralizing bounded fail-closed GitHub issue synchronization across three monitors. -->
# Task: Centralize GitHub issue synchronization

## Acceptance criteria

- One internal package owns the bounded same-origin HTTP client, repository
  path escaping, marker discovery, and issue state synchronization.
- All three monitors retain their command-specific classification, marker,
  title, body, and alerting decision.
- Foreign-authored lookalikes and pull requests are ignored; invalid matching
  evidence, duplicates, response overflow, and pagination exhaustion fail
  closed without mutation.
- Identical desired issue state performs no write.
- Existing monitor suites pass without weakening their safety assertions.
- The standard library remains the only dependency and no Unity job runs.

## Baseline

- Command: `go test ./cmd/reaper-delivery-audit
  ./cmd/sync-unity-enrollment-issue ./cmd/lock-recovery-audit`
- Observed result: all three suites passed while each command independently
  implemented transport, escaping, discovery, and synchronization.
- Reproduction status: reproduced by source inspection. The three copies had
  different response bounds, timeout and redirect behavior, pagination,
  title identity, create verification, and unchanged-record writes.

## Hypothesis

- Claim: one configurable standard-library package can express each monitor's
  intended alert policy while eliminating divergent fail-closed mechanics.
- Disconfirming evidence: any monitor loses a credential or response bound,
  adopts a foreign issue or pull request, rewrites retained recovery evidence,
  fails to rediscover a created recovery alert, or changes classification.
- Falsified hypotheses: a 30-item issue page is not provably below 4 MiB.
  Worst-case JSON escaping expands a 64-KiB body sixfold, so the safe shared
  page size is five while the page count rises to preserve the 1,200-item walk.

## Red

- Test: `go test ./internal/githubissue`
- Expected failure: the shared client contract does not exist.
- Observed failure: build errors for undefined `New`, `Options`, `Client`,
  `Issue`, `Identity`, `Desired`, and response-bound constants.

## Risk and path matrix

- Positive: create, update, reopen, close, retained-body close, and verified
  create all reach their command-selected state.
- Negative: absent healthy alert and byte-identical open or closed alert write
  nothing; renamed recovery alerts remain discoverable.
- Error: network failure, non-2xx status, decode/trailing-data error, redirect,
  cross-origin endpoint, oversized response, invalid matching evidence,
  duplicate marker, and pagination exhaustion fail closed.
- Boundary/extreme: five worst-case escaped 64-KiB bodies plus a representative
  API envelope and 400 KiB of reserve per issue fit within 4 MiB; 240 pages
  preserve the previous 1,200-issue total bound.
- Concurrency/ordering: creator-scoped ascending discovery validates GitHub's
  opaque same-origin cursor and rebases it onto the configured repository path,
  so concurrent creation or deletion cannot shift a later alert between
  synthesized offsets and a Link cannot change repositories; duplicates remain
  ambiguous.
- Cancellation/recovery: request contexts and explicit 20-second client
  timeouts bound stalls; recovery closes by state only and retains evidence.
- Determinism/isolation: `httptest` fixtures, no sleeps, no credentials, and no
  external or licensed execution.
- Contract synchronization: three command suites, shared package regressions,
  task/progress records, and generated knowledge index.

## Green

- Minimal change: `internal/githubissue` plus thin command adapters. The shared
  client owns transport, bounds, discovery, and open/update/close mechanics.
- Focused result: the shared package and all three migrated command suites pass.

## Full validation

- Commands and exact outcomes: recorded in
  `progress/session-030-shared-github-issue-client.md`.

## Adversarial review

- Unsafe success paths considered: credential forwarding through redirects;
  adopting public marker lookalikes; duplicate creation after failed
  discovery; title renames orphaning an alert; response-bound expansion after
  JSON encoding; rewriting retained incident evidence; and silent pagination
  truncation.
- Intent-to-diff status: recorded in the progress log.
- Unverifiable items and open questions: none for the local extraction.
- Remaining uncertainty: GitHub API envelope size is not contractually fixed.
  The encoded regression reserves 400 KiB per issue beyond representative
  fields, over 70 times the previously observed per-issue envelope, and every
  response remains hard-bounded.
- Implementer: root agent.
- Reviewer and evidence: recorded in the progress log.
- Actionable findings: recorded in the progress log.
- Remediator and dispositions: recorded in the progress log.
- Latest review round outcome: recorded in the progress log.

## Knowledge retention

- Trigger or exemption: substantial shared safety architecture and a disproved
  production response-bound assumption.
- Evidence: red compile failure, focused suites, full verifier, source review,
  and independent review recorded in the progress log.
- Observed facts, inferences, and open questions: JSON escaping can make a page
  materially larger than the sum of raw issue body sizes; envelope size remains
  variable but bounded by the same response limit.
- Root cause or reusable insight: repeated security-sensitive clients allowed
  already-decided timeout, authorship, pagination, and idempotence behavior to
  diverge. Bounds must be proven against encoded wire data.
- Promotion decision: revise.
- Destination or rationale: this task corrects the stale 30-item claim in the
  issue #132 task record; the shared package and its regression are the
  executable authoritative contract.
- Independent review outcome: recorded in the progress log.
