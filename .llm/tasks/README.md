<!-- summary: Template for recording bounded tasks, hypotheses, experiments, and validation evidence. -->
# Task Record Template

Use a task record when work spans multiple experiments or handoffs.

```markdown
# Task: concise outcome

## Acceptance criteria
- Observable behavior
- Preserved safety invariant

## Baseline
- Command:
- Observed result:
- Reproduction status: reproduced, intermittent, cannot reproduce, or not applicable

## Hypothesis
- Claim:
- Disconfirming evidence:
- Falsified hypotheses:

## Red
- Test:
- Expected failure:
- Observed failure:

## Risk and path matrix
- Positive:
- Negative:
- Error:
- Boundary/extreme:
- Concurrency/ordering:
- Cancellation/recovery:
- Determinism/isolation:
- Contract synchronization:

## Green
- Minimal change:
- Focused result:

## Full validation
- Commands and exact outcomes:

## Adversarial review
- Unsafe success paths considered:
- Intent-to-diff status:
- Unverifiable items and open questions:
- Remaining uncertainty:
- Implementer:
- Reviewer and evidence:
- Actionable findings:
- Remediator and dispositions:
- Latest review round outcome:
- Main-thread fallback reason (if applicable):

## Knowledge retention
- Trigger or exemption:
- Evidence:
- Observed facts, inferences, and open questions:
- Root cause or reusable insight:
- Promotion decision: promote, revise, or no durable learning
- Destination or rationale:
- Independent review outcome:
```

Do not store secrets, tokens, live lock state, or unnecessary command output in
task records. These fields make the handoff auditable; automated checks can
verify their structure, but not reviewer independence or review quality.
