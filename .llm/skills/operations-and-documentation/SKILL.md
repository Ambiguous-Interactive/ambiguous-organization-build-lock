---
name: operations-and-documentation
description: Keep operational facts and guidance synchronized with behavior. Use when changing lock configuration, incident recovery, consumer enrollment, runbooks, or operations facts.
---
# Operations and Documentation

Treat `docs/operations-facts.json` as machine-readable live facts,
`docs/operations-runbook.md` as steady-state operator guidance, and
`docs/secure-two-seat-rollout.md` as historical context.

When behavior or configuration changes:

1. Identify the live source of truth and observed deployed state.
2. Update facts, runbook procedures, consumer guidance, and top-level contract
   together where applicable.
3. Preserve explicit evidence requirements for cleanup and incident recovery.
4. Avoid turning historical rollout instructions into current guidance.
5. Run `test/documentation-policy.test.js` and any behavior test that establishes
   the documented claim.

Do not infer successful external cleanup from exit zero, incomplete logs, or
absence of an error. Operational guidance must distinguish proof, uncertainty,
and required escalation.
