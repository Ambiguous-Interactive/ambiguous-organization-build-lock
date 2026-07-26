---
name: adversarial-review
description: Review a change for correctness, missing intent, and production failure paths without modifying it. Use after implementation, before handoff, or as an independent review round.
---
# Adversarial Review

Review is read-only. Remediation belongs to a separately identified role and
requires change authorization.

## Fresh-context pass

Start with fresh context to reduce anchoring. Before reading the implementer's
rationale, claimed root cause, or conclusions:

1. Read the acceptance criteria, safety invariants, and authoritative contracts.
2. Resolve the comparison base; inspect the name-status diff, then the complete
   diff and full affected files. Include working-tree changes when they are in
   scope.
3. Read relevant tests, manifests, committed runtimes, callers, consumers,
   documentation, and verifier definitions.
4. Independently map intent to diff as `done`, `partial`, `changed`,
   `not done`, or `unverifiable`. A touched file is not evidence that a
   requirement is done.
5. Only then compare with the implementer's task record and validation evidence.

Literal zero knowledge is unsafe: a reviewer needs intent and invariants. The
independence boundary is the implementer's interpretation, not the contract.

## Failure-oriented pass

Search for unsafe success, missing fail-closed behavior, authorization or trust
boundary errors, races and stale state, partial writes, retry/cancellation
leaks, silent corruption, resource exhaustion, public-value consumer gaps,
credential exposure, runtime/manifest drift, nondeterminism, missing recovery,
and stale documentation.

Trace new or changed public values through every consumer outside the diff.
For a race, quote or identify both sides of the race. For a contract mismatch,
identify both sides of the contract.

## Evidence-before-finding gate

Every actionable finding must contain:

- severity and affected invariant or acceptance criterion;
- motivating `file:line` or exact command evidence;
- reachable failure scenario and impact;
- the missing or incorrect behavior;
- a focused verification that would prove remediation.

If motivating evidence cannot be cited, record an inference or open question,
not a finding. Never inflate confidence to make speculation actionable.
Distinguish pre-existing issues from regressions without treating either as
passing evidence.

## Disposition and exit

After remediation, discard stale conclusions, inspect the latest state, and
run fresh verification. Record every finding as fixed, rejected with evidence,
accepted risk by the authorized user, or blocked with the missing evidence.
A clean outcome requires no actionable findings in the latest review round and
no relevant mandatory gate failed or unrun.
