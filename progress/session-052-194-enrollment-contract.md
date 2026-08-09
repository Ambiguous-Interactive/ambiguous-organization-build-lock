# Session 052: caller-declared classifier enrollment contract

Date: 2026-08-09
Status: follow-up fix ready for publication.

## Scope

Adversarial review of merged PR #194 found that the new optional
`independent-paths` classifier input was accepted by the action manifest and
runtime but rejected by the enrollment analyzer's exact classify-input map.
That would make the caller-relative optimization unusable for enrolled
repositories while preserving the intended fail-closed default.

## Change and evidence

- Allow `independent-paths` in the typed classify step input contract.
- Require the declaration to be a literal `dir/**` list with no expressions or
  traversal segments and no overlap with Unity/workflow reserved prefixes,
  matching the runtime parser.
- Add a regression fixture proving an enrolled workflow declaring
  `Benchmarks/**` remains policy-clean.
- No consumer workflow, organization policy, credential, runner capacity, or
  lock-state change was made.

The focused enrollment tests and `.devcontainer/scripts/verify.sh` pass before
the final review remediation. The final remediation adds rejection coverage
for expression, malformed-glob, and reserved-prefix declarations; its complete
verification is being rerun against the revised commit.

## Review disposition

Both review findings were actionable and are fixed in the central analyzer plus
regression coverage. The prior ShellCheck review findings for PR #193 were
rechecked and are already satisfied in the merged tree: CI installs ShellCheck
and the workflow-policy signature includes that install step.

Continuous-improvement decision: no `.llm/` change. The durable contract is
enforced in the analyzer and test; this record preserves the dated defect and
its evidence without duplicating normative policy.
