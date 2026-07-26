---
name: architecture-and-plan-review
description: Challenge a proposed change before implementation. Use when reviewing architecture, decomposing substantial work, validating a task plan, or mapping failure and verification paths.
---
# Architecture and Plan Review

Review the proposal against repository evidence before endorsing a design.
Remain read-only unless the user also authorizes plan edits.

## Review sequence

1. Restate the problem, acceptance criteria, non-goals, and safety invariants.
   Identify decisions that require product, operator, or external authority.
2. Search for existing code, mechanism, or solution for every subproblem.
   Prefer extension or deletion over a parallel abstraction. Explain why the
   smallest coherent approach is sufficient.
3. Produce an affected-surface map covering implementation, public contracts,
   callers and consumers, committed runtimes, manifests, configuration, tests,
   operations, documentation, and generated knowledge.
4. Trace state and data flow from each entry point through validation, writes,
   outputs, cleanup, and observability. Show a diagram only when it clarifies a
   concurrent, branching, or multi-system relationship better than prose.
5. Enumerate failure and recovery paths: missing or ambiguous evidence,
   partial writes, stale reads, cancellation, timeout, retry exhaustion,
   duplicate or concurrent requests, dependency failure, and operator action.
6. Examine compatibility, migration, rollout, rollback or reversibility, and
   how an interrupted transition returns to a safe state.
7. Build a test and verification map that connects each acceptance criterion,
   invariant, branch, and failure mode to the cheapest authoritative check.
   Mark external state as unverifiable and name the required evidence.
8. Challenge performance and reliability with concrete load, contention,
   latency, resource, and degradation scenarios. Do not invent scale concerns
   without a reachable path.

## Decision gate

Classify each issue as `blocking`, `non-blocking`, or `open question`, with
source evidence and impact. Reject plans that lack a safe failure path, omit a
public-contract consumer, depend on unverifiable success, or cannot explain
recovery.

Avoid arbitrary file-count thresholds, universal abstractions, and scope
expansion unrelated to the affected surface. Prefer explicit, boring mechanisms
that a new maintainer can verify locally.

The review output must include the chosen approach and alternatives rejected,
affected-surface map, state/data flow, failure and recovery map, compatibility
and rollback posture, test/verification map, open questions, and residual risk.
