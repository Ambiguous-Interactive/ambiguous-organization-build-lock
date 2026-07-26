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

## Handoff evidence

Report the relevant commands, whether they passed, and any checks that could
not run. Never describe an unexecuted check as passing.
