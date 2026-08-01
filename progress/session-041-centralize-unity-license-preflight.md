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

## Delivery evidence

The consumer migration for this bounded slice merged and was re-audited:

- Central PR #172 merged as `3ac54fdfb47f79b4f794a5cdc647f2fb4804569a`.
- IshoBoy PR #345 merged as `35319da64ed967e86edb16ff484a0c7367643460` and
  migrated its Unity license preflight to the central action at the immutable
  central merge commit.
- IshoBoy's post-merge default-branch Unity validation run `30711576126` and
  cross-platform pre-commit run `30711576138` completed successfully at that
  merge commit.
- Trusted central enrollment audit run `30711594952` completed with
  `complete: true` after request run `30711587499`, reading IshoBoy default
  branch head `35319da64ed967e86edb16ff484a0c7367643460`.

Audit history and final safety evidence:

- Before the consumer merge, audit run `30711151856` read IshoBoy
  `dd17e9387d3685d7761e038000ab42bec32b8640` with two findings
  (`missing-fallback-aggregate`, `missing-unity-aggregate`).
- After the consumer merge, audit run `30711594952` reports those same two
  finding codes plus a new `unapproved-lock-ref` on
  `.github/workflows/unity-ci.yml` / `unity-validation`.
- Organization finding count rose from 109 to 110 solely from that IshoBoy
  change. PR #173 then added the central merge SHA to `approvedLockShas`.
- Final main Build lock CI run `30712163836` and enrollment audit run
  `30712163838` both completed successfully at main merge
  `8d659467aad64cdf6b0b1c2a0a2d44a898731e7c`. The final audit is complete,
  reads IshoBoy at `35319da64ed967e86edb16ff484a0c7367643460`, and reports no
  `unapproved-lock-ref` finding for IshoBoy. Its two IshoBoy findings are the
  same pre-existing aggregate gaps recorded above.

The migration therefore moved the caller off Unity Helpers and is
enrollment-clean for this bounded preflight slice.
The broad issue remains open: repository-specific diagnostic and test
composites in Unity Helpers and DxMessaging were intentionally not replaced by
this low-churn license-preflight migration. No organization policy or secret
material was changed by the central or consumer migration PRs.

## Continuous-improvement disposition

Observed fact: a successful enrollment-audit workflow conclusion is not proof
that a consumer pin is policy-clean. The authoritative boundary for this
migration is the consumer's merged default-branch workflow plus a fresh central
enrollment audit whose findings are inspected for newly introduced lock-ref
drift, not a pull-request diff or a green audit job alone. This is recorded
here because the post-merge audit exposed an authorization gap that was then
closed through a reviewed SHA-list update. No new `.llm/` guidance is
promoted; the existing approved-SHA and audit instructions already express
this invariant.
