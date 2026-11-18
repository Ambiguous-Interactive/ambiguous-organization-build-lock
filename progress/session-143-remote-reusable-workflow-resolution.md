# Session 143: remote reusable workflow calls stay unresolved

Date: 2026-11-18

Issues: #406 (fixed here), #397 (measured, decision still open), #113 (alert
class cleared).

Pull request: this repository's #407.

## Objective and safety invariants

Carry the GOAL.md directive: rank open issues by impact with the least Unity CI
churn, complete the highest-priority safe work, and drive it green.

Safety invariants:

- An unresolved reusable workflow call stays license-capable.
- A resolved callee with a licensed job makes the caller a paid job, so no
  licensing work escapes the paid shape rules.
- A caller that forwards Unity or lock credentials stays unresolved.
- No licensed workflow changes, so the Unity matrix is untouched.

## Baseline

- `main` at `3a0172adeb`. No open pull request. `main` CI and both scheduled
  monitors pass.
- Local audit of the seven default branches with the unmodified analyzer:
  `Audited 7/7 enrolled repositories; active-jobs=149 findings=53 complete=true`.
- Finding classes:
  - 31 remote reusable workflow calls in six repositories.
  - 14 DxMessaging workflow shape findings.
  - 8 expired policy exceptions.

## Open-issue priority

| Order | Item | Impact | Unity CI churn |
| --- | --- | --- | --- |
| 1 | #406 remote reusable workflow calls | 31 of 53 findings. The alert cannot close while they stay unresolved. | None. Central analyzer only. |
| 2 | #397 aggregate coverage | 6 of the 14 DxMessaging findings wait on the decision. | None central; consumer edits later. |
| 3 | #113 DxMessaging shape, expired exceptions | 14 consumer findings and 8 expired exceptions. | Low for the dispatch-only workflows; the exceptions need an owner re-review. |
| 4 | #390 consumer status adoption | Needs a consumer job shape decision, already recorded. | Low. Consumer side only. |
| 5 | #379 merge queue adoption | Needs an owner decision to enable the queue. | Low. |
| 6 | #335 actionlint YAML | Blocked upstream. Rechecked today: latest actionlint is still v1.7.12. | None. |
| 7 | #29, #51, #53, #83, #153, #229, #231, #249, #277, #278, #334 | Each needs owner authority, portal evidence, or hardware that this session cannot obtain. | Unknown until the evidence exists. |

## Root cause

`analyzer.jobLicensed` treats a remote reusable workflow call as
license-capable and reports `unresolved-reusable-workflow`, because the snapshot
holds one repository tree. `auditPaidJob` then reports `missing-licensed-steps`
and `unsafe-hosted-unity-runner` for the same job, which cannot define steps.

Six enrolled repositories call `Ambiguous-Interactive/review-tools` for
`agent-metrics.yml` and `openai-review.yml`. Both callees hold only checkout,
Python setup, and artifact steps. The callers cannot remove the findings: the
callee is in another repository.

## Change

- `analyzer` holds an optional `ReusableWorkflowSource`. Before the call is
  classified, the call target splits into a callee repository and workflow
  path. A full commit SHA and a normalized `.github/workflows/<file>.yml` path
  are required.
- The callee workflow is parsed as its own snapshot and each of its jobs is
  classified with a sub-analyzer. Its findings are dropped; only the licensed
  verdict matters. A callee that uses a repository-local action or calls
  another reusable workflow therefore stays unproven.
- A callee job with a third-party Unity action holds no central acquire step, so
  any Unity marker in the callee text also makes the caller paid.
- `reusableMemo` and `reusableVisiting` share one cache per audit, so a cycle
  and a repeated call cost one read and one verdict. Only the repository and
  commit fold case; the workflow file name stays exact.
- Any unproven case keeps the old verdict: `unresolved-reusable-workflow` and
  license-capable.
- `okReusableCaller` refuses a resolved call whose job text names a Unity
  serial, email, password, license, or lock credential. It also refuses
  `secrets: inherit` and any secrets expression that names no exact secret, and
  it requires each `secrets:` mapping value to be exactly one secret reference,
  which may rename the secret.
- `remoteReusableTarget` accepts one plain YAML file name directly under
  `.github/workflows/`, so a percent-encoded or quoted segment cannot reach a
  different path at a mirror.
- `cmd/audit-unity-enrollment` supplies the resolver: one anonymous raw read of
  `raw.githubusercontent.com/<repository>/<sha>/<path>`, a 15-second timeout, a
  256 KiB bound, a status check, a redirect bound on the reviewed host, and a
  per-run cache. `--reusable-workflow-base-url` exists for tests.
- `docs/consumer-enrollment.md` states the rule in preconditions item 7, in
  workflow contract item 1, and in the `unresolved-reusable-workflow` row.

## Evidence

Local audit of the same seven snapshots after the change:

```text
Audited 7/7 enrolled repositories; active-jobs=139 findings=22 complete=true
```

The 31 remote-call findings are gone. The remaining 22 are the 14 DxMessaging
shape findings and the 8 expired policy exceptions.

Tests:

- `TestUnityEnrollmentResolvesNonLicensingRemoteReusableWorkflow`
- `TestUnityEnrollmentKeepsUnresolvedRemoteReusableWorkflowConservative`
- `TestUnityEnrollmentRefusesOpaqueSecretForwarding`
- `TestUnityEnrollmentKeepsANestedRemoteCallUnresolved`
- `TestUnityEnrollmentKeepsCalleeFileNamesCaseSensitive`
- `TestUnityEnrollmentTreatsLicensedRemoteReusableWorkflowAsPaid`
- `TestUnityEnrollmentTreatsOneLicensedCalleeJobAsPaid`
- `TestUnityEnrollmentRefusesMutableRemoteReusableWorkflow`
- `TestRemoteReusableTargetAcceptsOnlyAResolvableIdentity`
- `TestReusableWorkflowFetcherReadsOneImmutableIdentity`
- `TestReusableWorkflowFetcherRefusesOversizedContent`
- `TestReusableWorkflowFetcherRefusesAHostChange`
- `TestRunResolvesNonLicensingRemoteReusableWorkflow`

## Review findings and dispositions

An independent adversarial review found these. All are fixed.

- High: `with: { all: ${{ toJSON(secrets) }} }` and a computed secret mapping
  passed the caller check. Each mapped value must now be one exact secret
  reference, and an opaque secrets expression is refused.
- Medium: a nested call chain had no depth bound, so a consumer could chain
  reads without limit. The callee analyzer now gets no resolver, so any nested
  call stays unresolved.
- Low: the memo key folded the case of the workflow file name, so `Foo.yml`
  and `foo.yml` shared one verdict. Only the repository and commit fold now.
- Low: a percent-encoded path segment reached `url.JoinPath` unchanged. The
  callee name now accepts only plain YAML file characters.
- Low: the fetcher followed a redirect to any host. It now refuses a scheme or
  host change and bounds the chain.
- Low: the docs claimed a nested call always stays unresolved. A nested call is
  now never resolved: the callee analyzer gets no resolver.
- Low: the callee marker set keeps a bare `unity` token on purpose. A callee
  that mentions Unity keeps the caller paid, which is the fail-closed
  direction. The measured review-tools callees hold no Unity token.

## Out of scope

- #397 keeps its open decision. This session added the measured two-lane
  evidence to it.
- The 8 expired policy exceptions need an owner re-review.
- The 14 DxMessaging findings need a consumer change.
