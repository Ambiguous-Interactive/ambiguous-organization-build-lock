---
name: continuous-improvement
description: Convert evidence from substantial completed work into durable repository knowledge without speculation or duplication. Use after any substantial task, change, incident analysis, or multi-step investigation before handoff.
---
# Continuous Improvement

Run this gate after validation and adversarial review, before the final handoff.
The analysis is mandatory for substantial work; a knowledge edit is mandatory
only when the evidence supports one.

## What counts as substantial work

Use this gate when any of these is true:

- public behavior, safety policy, architecture, operations, or agent guidance changed;
- the task changed two independently maintained surfaces (such as
  implementation, tests, documentation, runtime, or workflow);
- one surface changed, but the work was operationally risky or required
  coordinated reasoning across multiple components, decision branches, or
  compatibility cases, a migration, or substantial investigation;
- the task required two or more experiments or a task record;
- a failure, incident, surprising constraint, or reusable technique was found;
- the work produced evidence that would materially help a future task.

When uncertain, run the gate. A one-line mechanical correction with no reusable
finding may record `no durable learning` in the handoff instead. Pure formatting
or generated-file refreshes are exempt only when no source or contract changed;
record the exemption and its evidence.

## Evidence-first retrospective

1. Re-read the hypothesis, baseline, task record, diff, test results, and
   adversarial review; compare the predicted and observed outcomes.
2. Separate each candidate into:
   - **Observed fact:** directly supported by a command, test, source, or diff.
   - **Inference:** plausible explanation that still needs confirmation.
   - **Open question:** unresolved and not safe to promote as guidance.
3. For every failure or inefficiency, ask why until reaching an actionable root
   cause or an explicit evidence boundary. Do not invent certainty.
4. Search `.llm/` for existing guidance before adding anything. Update the
   narrowest authoritative location; do not create a competing source of truth.
5. Decide and record one outcome:
   - `promote`: durable, reusable, repository-specific knowledge;
   - `revise`: existing guidance was incomplete or misleading;
   - `no durable learning`: already covered, too task-specific, or unsupported.

## Promotion routes

- Repeatable procedure or decision rule: update or add a skill/workflow.
- Responsibility or ownership boundary: update canonical context or the
  relevant operational role guidance.
- Stable invariant, command, or small fact: update a reference.
- Evidence-backed discovery whose stability is uncertain: add dated research
  with the experiment, result, limitations, and a revalidation trigger.
- Small reusable implementation pattern: add a reviewed code sample.

Prefer a comprehensive technique that prevents a class of failures over a note
about one symptom. Preserve useful trivia only when it is repository-specific,
searchable, and likely to change a future decision.

## Quality and safety gate

Before promoting knowledge, verify that it:

- cites reproducible evidence or names the exact observed source;
- states scope, preconditions, and important counterexamples;
- distinguishes normative guidance from provisional research and supersedes
  stale guidance instead of accumulating contradictions;
- contains no secret, credential, personal data, live lock state, or transient
  command output;
- does not weaken fail-closed behavior or claim an unrun check passed;
- is concise, deduplicated, and placed where the generated index can find it;
- adds a regression test when the new rule can be enforced mechanically.

## Independent review and remediation loop

For substantial work, use distinct agents for implementation, review, and
remediation when the environment supports agents, the task can be handed off
safely, and enough independent agents are available. The implementer provides
the evidence and diff to a reviewer. A reviewer who did not implement the
change records concrete, actionable findings with file or command evidence. If
findings exist, a remediator who is distinct from that reviewer evaluates each
finding, implements justified fixes, and records the disposition of rejected
recommendations. Send the revised result to an independent reviewer and repeat
until every reviewer in the latest review round reports no actionable findings.
Do not substitute a claim of perfection for this evidence.

Discard stale results and perform fresh verification after any remediation,
against the revised state before re-review. A previously green command is not
evidence for code changed afterward.

When distinct agents are unavailable or inappropriate (for example, the change
is not safely separable or would expose restricted context), perform the same
loop on the main thread as explicitly separated implementation, adversarial
review, and remediation passes. Record why the fallback was used and do not
treat self-review as independent review.

This is a procedural and auditable handoff contract. Repository checks can
enforce the presence and structure of its guidance and records, but cannot
prove agent identity, independence, review quality, or that every runtime
finding was resolved. The handoff evidence is authoritative for those facts.

After any `.llm/` edit, run:

```bash
node tools/llm-harness.mjs generate
node tools/llm-harness.mjs check
```

Then run the focused tests affected by the learning and the repository verifier
required by `.llm/context.md`. Review the final knowledge diff independently
from the implementation diff and apply the loop above.

## Handoff record

Report:

- trigger for this gate;
- evidence examined;
- root cause or new knowledge, clearly labeled as fact or inference;
- promotion decision and files changed, or why there was no durable learning;
- validation outcome;
- implementer, reviewer, and remediator roles (or the main-thread fallback
  reason), each finding and disposition, and the latest review round outcome.
