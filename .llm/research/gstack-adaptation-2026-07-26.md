<!-- summary: Pinned comparison of gstack practices with this repository and the evidence-backed adopt, adapt, defer, and reject decisions. -->
# gstack Adaptation Analysis

## Scope and method

Observed on 2026-07-26 from
`garrytan/gstack@a3259400a366593e0c909dd9ac3e59752efd2488`.
The comparison used the source tree, not README claims alone. Three independent
read-only analyses covered architecture/review, testing/debugging, and LLM
structure. Recommendations were retained only where they filled a local gap
without weakening build-lock safety or duplicating the `.llm` source of truth.

Revalidate when gstack changes its review, investigation, plan, ship, or skill
generation architecture materially, or when this repository adds a second LLM
host that genuinely requires different authored instructions.

## Observed source practices

- [`review/SKILL.md:947-983`](https://github.com/garrytan/gstack/blob/a3259400a366593e0c909dd9ac3e59752efd2488/review/SKILL.md#L947-L983)
  maps planned intent to `DONE`, `PARTIAL`, `NOT DONE`, `CHANGED`, or
  `UNVERIFIABLE` and requires conservative evidence.
- [`review/SKILL.md:1221-1267`](https://github.com/garrytan/gstack/blob/a3259400a366593e0c909dd9ac3e59752efd2488/review/SKILL.md#L1221-L1267),
  [`:1356`](https://github.com/garrytan/gstack/blob/a3259400a366593e0c909dd9ac3e59752efd2488/review/SKILL.md#L1356),
  and [`:1691-1700`](https://github.com/garrytan/gstack/blob/a3259400a366593e0c909dd9ac3e59752efd2488/review/SKILL.md#L1691-L1700)
  gate findings on motivating source lines and instruct fresh-context
  specialist/adversarial passes.
- [`investigate/SKILL.md:834-850,936-1027`](https://github.com/garrytan/gstack/blob/a3259400a366593e0c909dd9ac3e59752efd2488/investigate/SKILL.md#L834-L1027)
  separates reproduction, one hypothesis, experiments, root cause, regression,
  and verification.
- [`plan-eng-review/sections/review-sections.md:163-244`](https://github.com/garrytan/gstack/blob/a3259400a366593e0c909dd9ac3e59752efd2488/plan-eng-review/sections/review-sections.md#L163-L244)
  maps conditionals, fallbacks, invalid/empty input, concurrency, stale state,
  recovery, and test layer selection.
- [`CONTRIBUTING.md:155-161,238-256`](https://github.com/garrytan/gstack/blob/a3259400a366593e0c909dd9ac3e59752efd2488/CONTRIBUTING.md#L155-L256)
  tests generated skills with static, end-to-end, and judge tiers;
  [`ARCHITECTURE.md:347-359,405-427`](https://github.com/garrytan/gstack/blob/a3259400a366593e0c909dd9ac3e59752efd2488/ARCHITECTURE.md#L347-L427)
  emphasizes process isolation, diagnostic artifacts, incremental writes, and
  tiered cost.
- [`CONTRIBUTING.md:260-288`](https://github.com/garrytan/gstack/blob/a3259400a366593e0c909dd9ac3e59752efd2488/CONTRIBUTING.md#L260-L288)
  and [`setup:441-455`](https://github.com/garrytan/gstack/blob/a3259400a366593e0c909dd9ac3e59752efd2488/setup#L441-L455),
  [`setup:774-777`](https://github.com/garrytan/gstack/blob/a3259400a366593e0c909dd9ac3e59752efd2488/setup#L774-L777)
  generate multiple host formats from templates and avoid duplicate discovery
  roots.

These are observations about that pinned revision, not proof that every gstack
workflow is correct or appropriate here.

### Reproduce the source inspection

```bash
git clone --filter=blob:none https://github.com/garrytan/gstack.git /tmp/gstack
git -C /tmp/gstack checkout --detach a3259400a366593e0c909dd9ac3e59752efd2488
git -C /tmp/gstack rev-parse HEAD
git -C /tmp/gstack show HEAD:review/SKILL.md | sed -n '947,983p'
git -C /tmp/gstack show HEAD:investigate/SKILL.md | sed -n '834,850p'
git -C /tmp/gstack show HEAD:plan-eng-review/sections/review-sections.md | sed -n '163,244p'
```

Use the pinned links above for the remaining ranges. These commands reproduce
source text, not runtime behavior, reviewer independence, or agent identity.

## Adopted and adapted

| Practice | Local adaptation | Why |
| --- | --- | --- |
| Root-cause debugging discipline | `investigation` skill | Prevents guess/fix loops and preserves analysis-only scope. |
| Architecture failure-path review | `architecture-and-plan-review` skill | Makes state, recovery, compatibility, and verification explicit before code. |
| Fresh-context red-team review | `adversarial-review` skill | Reduces implementer anchoring while retaining required intent/invariants. |
| Evidence-before-finding | Review finding contract | Turns unsupported suspicions into open questions instead of false positives. |
| Intent-to-diff completeness | Review completion states | Prevents touched files or green tests from standing in for delivered intent. |
| Risk/path test matrix | Testing skill and task record | Covers positive, negative, error, boundary, race, cancellation, and recovery paths. |
| Hermetic deterministic tests | Testing skill | Promotes existing injected clock/random/sleep/I/O patterns and rejects retry-masked flakes. |
| Category-level tripwires | Testing skill | Couples a behavioral regression with the narrowest central unsafe-shape check. |

The local continuous-improvement loop already provides a stronger blocking
implementer/reviewer/remediator contract than gstack's additive non-blocking
adversarial pass, so it remains authoritative.

## Preserved local strengths

- `.llm/context.md` is the canonical entry point; the generated index performs
  deterministic progressive discovery and vendor files remain thin pointers.
- Skills use portable Agent Skills metadata and stay below 300 lines.
- Repository task records keep hypotheses, evidence, reviews, and dispositions
  auditable in the same revision as the change.
- CI, the staged-snapshot hook, and local verification enforce the same harness
  contract without network updates or hidden user-global state.
- Domain tests already exercise authentication failures, malformed responses,
  aborts, retries/deadlines, ambiguous writes, concurrency, stale state, and
  recovery. The adaptation codifies selection, rather than duplicating cases.

## Rejected or deferred

- Reject giant generated preambles, router duplication, host-specific prompt
  branches, telemetry, auto-updates, global memory, and WIP auto-commits. They
  harm portability, privacy, determinism, or the repository SSOT.
- Reject blanket 100% coverage claims, subjective quality arithmetic, and
  adaptive suppression of safety reviewers. Path evidence matters more than a
  score, and rare critical categories remain always relevant.
- Reject test retries as a green gate. Repeat runs may diagnose a flake, but
  divergence or a first-attempt failure remains a failure.
- Reject LLM-as-judge as mandatory correctness evidence. It may be an opt-in,
  pinned research evaluation with raw artifacts, never a substitute for
  deterministic policy and behavior checks.
- Reject automatic fixes during review-only work, arbitrary complexity/file
  thresholds, unconditional web search, mandatory diagrams, and expanding
  unrelated scope under completeness language.
- Defer generated-skill end-to-end model scenarios and model-authored diagnostic
  artifacts. This repository has no pinned agent runner or prompt compiler, so
  such a gate would not yet be deterministic or prove product correctness.
  Reconsider when a committed runner can replay fixed scenarios offline, or
  repeated agent failures show that the instruction-contract tests miss a
  material class of defects.
- Defer template-to-host generation and schema-validated committed task records
  until actual host divergence or task-record drift demonstrates the need.

## Evidence boundary

This analysis evaluated source practices and local contracts; it did not
benchmark model behavior under both prompt systems. Claims about improved agent
outcomes are therefore inferences. The deterministic instruction-contract
tests prove presence and drift resistance of the guidance, not agent identity,
compliance, review independence, or semantic correctness.
