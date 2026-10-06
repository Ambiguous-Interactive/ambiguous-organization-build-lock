---
name: task-driven-development
description: Plan and execute non-trivial changes with hypotheses, red-green tests, evidence, and adversarial review. Use when implementing changes, fixing bugs, or exploring uncertain behavior.
---
# Task-Driven Development

## Protocol

1. Translate the request into a bounded task and observable acceptance criteria.
2. Identify safety invariants and what evidence could disprove the current
   hypothesis.
3. Capture a baseline using a focused command or fixture.
4. Add a failing test before implementation when behavior can be tested.
5. Confirm the failure is for the intended reason.
6. Implement the smallest coherent solution.
7. Re-run the focused test, adjacent tests, and finally the complete verifier.
8. Inspect the diff for collateral changes and unstated assumptions.

For exploratory work, keep facts, hypotheses, experiments, and conclusions
separate. A green test is evidence for the tested behavior, not proof of every
possible behavior.

## Plan maintenance

Treat `PLAN.md` as an index of in-progress and future work, within 60 physical
lines. Each item names an open outcome, the next action, and an issue or task
link. Blocked work names the evidence or authority needed to resume. Keep only
details needed to choose or start the next task. Do not fill the line budget.

Route supporting content to its authoritative home:

- Agent responsibilities and global rules: `.llm/context.md`.
- Repeatable procedures: the relevant `.llm/skills/` skill.
- Stable contracts or uncertain discoveries: references or dated research.
- Task hypotheses and experiments: `.llm/tasks/`.
- Completed work, decisions, validation, and session history: `progress/`.
- Operator procedures and deployed facts: existing `docs/` sources.

After each session, remove completed or obsolete items and refresh remaining
next actions. Preserve useful removed evidence in a session record first; link
to existing authoritative content instead of duplicating it. Never accumulate
session summaries, completed checklists, release histories, or policy tutorials
in the plan. Revalidate dated claims before treating them as current facts.

Run `node tools/llm-harness.mjs check`. The harness rejects plans over 60 lines
and completed checklist items. Review prose for history and context manually;
the mechanical checks cannot prove that every listed task remains open.

## Handoff evidence

Report the relevant commands, whether they passed, and any checks that could
not run. Never describe an unexecuted check as passing.
