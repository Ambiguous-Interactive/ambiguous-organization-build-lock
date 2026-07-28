# Session 021: scoped harness tests and metadata batching

## Scope and hypothesis

On 2026-07-27, review every open repository issue and pull request, prioritize
production impact while minimizing licensed Unity CI churn, and complete issue
#101 with a focused test-maintenance improvement.

Hypothesis: the Node suite's critical path is not the 7,773-line build-lock
test alone. Repeated `go run` startup in the LLM harness and one sequential
harness test file are independently measurable bottlenecks. Batch metadata
validation and separate the independent catalog, contract, and Git-hook test
scopes so Node can schedule them in parallel processes.

Safety invariants:

- Skill metadata validation, generated index contents, pointer validation, and
  staged-snapshot hook behavior remain unchanged.
- Invalid metadata remains fail-closed and every batch result stays associated
  with its input path and position.
- Repository credential-text policy covers newly created files during local
  verification and does not fail by reading deleted tracked paths.
- No public action runtime, lock state, workflow, capacity, credential,
  organization policy, or consumer repository changes are in scope.

## Issue and pull-request inventory

The connected GitHub app reported 18 open issues and no open or draft pull
requests. Priority reflects observed impact, authority, evidence availability,
and licensed CI churn.

| Priority | Issues | Disposition |
| --- | --- | --- |
| P0 | #83 | Highest production impact, but safe closure still requires independent entitlement identities, both return orders, consumer repins, and portal proof. Preserve fail-closed quarantine. |
| P0 | #51 | Credential scope is a high-impact security boundary, but completion requires owner-authorized organization inventory and policy mutations outside this session's authority. |
| P0 | #113 | The live audit proves 286 consumer drift findings. Remediation spans six repositories and substantial licensed CI; it is genuine drift rather than analyzer overreach. |
| P1 | #27, #29, #30, #44, #53, #54, #60 | Require live canaries, multi-day evidence, ruleset changes, or broad consumer workflow/repin churn. |
| P2 | #49, #99 | Throughput work needs licensed before/after consumer evidence. |
| P2 | #94 | actionlint v1.7.12 remains latest and yaml/v4 rc.6 remains incompatible. No safe direct upgrade exists. |
| P2 | #101 | Selected: measurable repository verification latency, no Unity execution, and independently testable behavior. |
| P2 | #100 | Broader runtime extraction carries more action-contract risk than the selected test-only work. |
| P3 | #79, #102 | `Date.now()` is already UTC epoch time; a TypeScript/Bun/Deno migration has no demonstrated safety or runtime benefit. |
| P3 | #109 | Removing progress records conflicts with the current repository session-record contract; history rewriting is destructive. |

No new follow-up issue was opened because the material out-of-scope work is
already represented by the issues above.

## Dependency audit

- The checkout started clean at `495b0caae`, equal to `origin/main`.
- The root Go module is current.
- actionlint v1.7.12 remains current. Its transitive yaml/v4 rc.6 update is
  blocked by #94's documented parser API incompatibility.
- Newer actionlint transitive modules were not promoted to unused direct
  requirements merely to silence `go list -m -u`.

## Baseline, red proof, and implementation

Measured before changes:

- full Node suite: about 2.99 seconds, 557 tests;
- `test/build-lock.test.js`: about 2.49 seconds;
- `test/llm-harness.test.js`: about 2.80-2.96 seconds;
- `node tools/llm-harness.mjs check`: about 0.58-0.61 seconds.

This falsified the initial assumption that splitting only the largest test file
would reduce the suite critical path: the smaller harness test was slower.

The new batch regression failed before implementation with:

```text
json: cannot unmarshal array into Go value of type main.request
```

Implementation:

- the Go metadata helper validates an ordered request batch in one process;
- the Node harness batches all skill frontmatter while retaining local
  missing-frontmatter diagnostics and per-document validation errors;
- the monolithic harness test is separated into catalog, contract, and Git-hook
  files, preserving all 14 original tests;
- the documented focused command addresses the scoped files;
- the credential-text inventory now includes tracked and untracked non-ignored
  files and omits deleted paths, with a regression for both boundaries.

Measured after changes:

- full Node suite: about 2.29 seconds, 558 tests (about 23% faster);
- scoped harness tests: about 1.02 seconds;
- `node tools/llm-harness.mjs check`: about 0.10 seconds (about 83% faster).

No timing threshold was added because wall-clock performance assertions would
be environment-coupled and fragile. The behavioral batch and inventory
contracts are deterministic.

## Validation and review

Focused checks passed:

```text
go test ./cmd/llm-skill-metadata
node --test test/llm-harness-*.test.js test/workflow-policy.test.js
node tools/llm-harness.mjs check
```

The complete `.devcontainer/scripts/verify.sh` passed 558 Node tests, every Go
package, actionlint, both module verification and tidy checks, the workflow
credential audit, and the LLM harness.

Main-thread adversarial review was used because this cohesive internal
test-tool refactor did not require separable delegated work. It found one
cleanup item: per-test concurrency flags were misleading because synchronous
subprocess calls dominate those cases; file-level process isolation supplies
the actual concurrency. The remediation removed the flags. No fail-open path,
public action change, credential exposure, or lifecycle impact was found.

## Continuous improvement

Outcome: `no durable learning`.

Observed facts are encoded at the narrowest useful locations: ordered batch
behavior in the Go regression, tracked/untracked/deleted inventory behavior in
the Node regression, and the focused test command in `.llm/README.md`.
Repository guidance already requires deterministic isolation, central
invariants, focused checks, and complete verification. Adding another skill or
reference would duplicate that guidance. The timing result is environment
specific and should remain in this dated session record rather than become a
normative rule.

## Delivery

PR, hosted review, CI, merge, issue closure, and final `main` verification
evidence will be appended after those steps complete.
