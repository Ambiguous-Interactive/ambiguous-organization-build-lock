---
name: github-workflow-policy
description: Apply repository GitHub Actions safety policy. Use when editing workflows, action manifests, reusable workflows, action pins, permissions, concurrency, or credential handling.
---
# GitHub Workflow Policy

## Safety constraints

- Use full immutable commit SHAs for third-party actions.
- Grant the smallest job/workflow permissions required.
- Every concurrency scope capable of reaching licensed acquire must literally
  set `cancel-in-progress: false`.
- `cancel-in-progress: false` protects the running member but GitHub can still
  replace an older pending member of the same group. Periodic work must not
  share a concurrency group with proof-bearing recovery. Keep recovery outside
  automatic concurrency cancellation or isolate it from periodic groups, and
  preserve CAS/exact-ID fencing for any resulting concurrent state attempts.
- Licensed matrices set `strategy.fail-fast: false`.
- Keep credentials out of command text, URLs, diagnostics, and direct secret
  interpolation in shell.
- Preserve fork and missing-secret fail-closed behavior.
- Validate JSON value types before extraction. Do not use `jq -e` to read a
  boolean that may validly be `false`; its truthiness exit status rejects that
  value. After an exact schema check, read typed booleans with `jq -r`.
- Current-head checks and acquire-time revalidation are complementary.
- Release association is not issue-completion proof. Automated release comments
  must describe linkage without claiming resolution, and must not apply a
  `released` label unless acceptance evidence is independently enforced.

## Validation

Run focused workflow and manifest tests first. Then run actionlint, all Node
tests, the Go enrollment tests, and the credential audit. Existing policy tests
may deliberately inventory workflow run blocks; update expectations only after
proving the new block is safe.
