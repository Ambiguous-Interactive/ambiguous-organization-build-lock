# Session 041: Centralize Unity license preflight

Date: 2026-08-01

## Selection

The live repository inventory contained no open pull requests. Issue #171 is
the highest-impact actionable issue that does not require an organization
policy change. A bounded cross-organization scan found one direct consumer
reference to `Ambiguous-Interactive/unity-helpers/.github/actions/validate-unity-license`:
IshoBoy's Unity CI workflow. The selected slice is to move that credential
preflight into this repository and migrate that one caller. The remaining
Unity Helpers composites are repository-specific diagnostics and test-assembly
logic and are not interchangeable license authority.

## Safety contract

The central preflight runs before lock acquisition and fails closed unless
classic serial activation has non-empty `UNITY_SERIAL`, `UNITY_EMAIL`, and
`UNITY_PASSWORD`. It rejects the retired `UNITY_LICENSING_SERVER` credential.
Only presence booleans are written to GitHub outputs or notices; credential
values are never emitted. No secret, runner, organization policy, or live lock
state is changed.

## Red-green evidence

The central action uses the repository's supported Node 24 action runtime and a
committed dependency-free runtime. Tests cover complete credentials, missing
credentials, the retired licensing-server input, output presence booleans, and
the action-manifest/runtime contract.

Focused verification:

```text
node --test test/unity-license-preflight.test.js test/action-manifests.test.js
51 passed
git diff --cached --check
```

## Delivery boundary

This central PR provides the reviewed immutable action target. The IshoBoy
consumer must be updated in a separate consumer PR to point at this action's
merged commit, then its exact default-branch workflow must pass before the
direct Unity Helpers action reference can be removed from the organization
inventory. The central action is not promoted as the sole organization
enrollment proof until that consumer migration is complete.
