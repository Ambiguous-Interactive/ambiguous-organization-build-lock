<!-- summary: Represent the reviewed CI-managed alternate Unity editor layout without trusting a caller path. -->
# Task: Support the trusted alternate editor layout

## Acceptance criteria

- `return-unity-license` accepts only the default canonical layout or the exact
  literal `ci-managed-alternate` layout.
- The alternate resolves below
  `runner.tool_cache/u6-v3/_ci-managed-editors/<version>/Editor/Unity.exe`.
- Existing path identity, signer, credential, execution, and evidence controls
  remain unchanged.
- Enrollment analysis accepts the reviewed literal and rejects expressions,
  unknown values, and arbitrary path/root inputs.
- Runtime, manifest, tests, analyzer, and enrollment documentation agree.

## Baseline and hypothesis

- Observed consumer CI: IshoBoy #317 resolved the editor under
  `_ci-managed-editors` and failed before activation because central return
  could address only the canonical layout.
- Hypothesis: a closed literal layout enum can select the reviewed path shape
  without expanding trust to caller-selected executable paths.
- Disconfirming evidence: arbitrary paths become accepted, default resolution
  changes, an unknown/expression value passes analysis, or identity/signature
  checks are bypassed.

## Risk matrix

- Positive: canonical remains default; alternate resolves one exact path.
- Negative: unknown, expression, whitespace, and arbitrary-path inputs reject.
- Error: missing editor and verification failures retain initial fail-closed
  outputs.
- Boundary: version, tool-cache, and evidence-suffix validation remain intact.
- Concurrency: layout selection is pure and precedes filesystem verification.
- Determinism: dependency-free temporary fixtures; no Unity or credentials.

## Review and retention

- Independent adversarial review is required before publication.
- Any reusable trust-boundary lesson will be recorded after validation; no
  speculative skill change is planned.

## Red and green

- Red: runtime alternate-path, invalid-layout, manifest, and analyzer acceptance
  tests failed against the canonical-only implementation.
- Green: the runtime defaults to `canonical`, accepts only the two enum values,
  inserts `_ci-managed-editors` at the reviewed location, and passes the selected
  value through the same identity/signature/execution path. The analyzer permits
  only omitted, `canonical`, or `ci-managed-alternate` literals.

## Independent review

- Finding: input-key coverage did not bind the manifest's optional canonical
  default, so a manifest-only mutation could break omitting consumers.
- Remediation: exact-bind `required: false` and `default: canonical`, and
  independently assert the runtime omission fallback.
- Outcome: PASS with no remaining actionable findings.
