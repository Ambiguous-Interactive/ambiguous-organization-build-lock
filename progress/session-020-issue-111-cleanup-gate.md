# Session 020: non-acquired cleanup gate

## Scope and hypothesis

On 2026-07-27, review every open repository issue and open pull request,
prioritize impact while minimizing Unity CI churn, and complete the highest
priority issue that can be resolved without weakening fail-closed lifecycle
behavior or requiring organization-policy changes.

Hypothesis: issue #111 can distinguish exact `acquired=false` from missing or
invalid acquisition evidence. The former proves guarded licensed work did not
run, so the final cleanup gate is not applicable. The latter remains ambiguous
and must fail closed, but should diagnose acquisition state rather than emit a
list of unrelated cleanup failures.

Safety invariants:

- Licensed work remains guarded by exact `acquired == 'true'`.
- Missing, malformed, or contradictory evidence remains fail-closed.
- Confirmed holders still require coherent classification and central release.
- No lock state, capacity, queue ordering, configuration, workflow, credential,
  or organization policy changes are in scope.

## Inventory and priority

The connected GitHub app reported 18 open issues and no open pull requests from
the current account. Priority uses observed production impact first, then
licensed-CI churn and whether the acceptance evidence is available in this
repository.

| Priority | Issues | Disposition |
| --- | --- | --- |
| P0 | #83 | Highest raw production impact: shared-entitlement concurrent returns repeatedly produce `400006`, red jobs, and false quarantines. Safe closure requires independent entitlement identities or a new pre-return claim protocol, consumer repins, both return orders, and portal reconciliation. Preserve fail-closed behavior; do not reclassify `400006` from local evidence alone. |
| P0 | #111 | Highest safely completable issue with no Unity execution: more than half of sampled gate failures never acquired a license. Selected for this session because exact false can be handled without weakening ambiguous evidence. |
| P0 | #51 | Credential and organization-secret scope is a high-impact security boundary, but completion requires owner-authorized organization inventory and policy mutations expressly outside this session's authority. |
| P1 | #27, #29, #30, #54 | Live incident/canary/monitoring work needs licensed runs, portal evidence, or a multi-day observation window. Keep as operational evidence work. |
| P1 | #44, #53 | Merge-policy truthfulness and pre-runner FIFO fairness are broad cross-repository changes with significant consumer workflow churn. |
| P1 | #60 | Literal zero cooldown needs a release, five consumer repins, and live cross-runner canaries. It deliberately causes broad Unity CI churn. |
| P1 | #113 | The enrollment audit reports 286 live drift findings; remediation belongs in audited consumer repositories and must avoid treating inventory-only jobs as licensed work. |
| P2 | #49, #99 | Throughput improvements are valuable but require measured consumer changes and licensed before/after evidence. |
| P2 | #94 | Dependency update is desirable and requires no Unity seat, but actionlint v1.7.12 remains the latest and does not compile with yaml/v4 rc.6. No safe upgrade is currently available. |
| P2 | #100, #101 | Test/runtime extraction and parallelization are maintainability work; pursue only in bounded changes that preserve committed runtime contracts. |
| P3 | #79, #102 | The UTC-time suggestion is inapplicable to JavaScript `Date.now()`, and a TypeScript/Bun/Deno migration has no demonstrated safety or runtime benefit yet. |
| P3 | #109 | Removing committed progress conflicts with the current repository session-record requirement; history rewriting would also be destructive and unrelated to lock safety. |

No new out-of-scope issue was opened: every material follow-up found in this
review already has a dedicated issue above.

## Dependency and pull-request audit

- The current checkout started clean at `d45b838ad` on `main`, equal to
  `origin/main`.
- The connected GitHub app returned no open draft or in-progress pull requests
  from the current account.
- `go list -m -u -mod=readonly all` reported the root module current.
- `go -C tools/actionlint list -m -u -mod=readonly all` confirmed actionlint
  v1.7.12 is still current. yaml/v4 rc.6 remains blocked by #94; unrelated
  transitive-only modules were not pinned merely to silence update output.

## Red-green evidence

Baseline:

```text
node --test test/unity-cleanup-gate.test.js
23 passed, 0 failed
```

New regression cases initially failed for the intended reasons:

- exact `acquired=false` accumulated ten cleanup failures and exited 1;
- missing acquisition state accumulated cleanup failures instead of identifying
  ambiguous acquisition;
- the committed runtime exited 1 for the explicit non-acquired case.

Implementation:

- exact `false` returns `cleanup-safe=true` and logs that cleanup confirmation
  was not required;
- missing, empty, or invalid acquisition state fails immediately with one
  allowlisted acquisition-state diagnosis;
- exact `true` retains every existing cleanup, release, reservation, and
  incident check;
- the action manifest, README, and enrollment guide describe the same contract.

Focused verification:

```text
node --test test/unity-cleanup-gate.test.js \
  test/action-manifests.test.js \
  test/documentation-policy.test.js
68 passed, 0 failed
```

## Review and final verification

Sub-agents were not used because the selected change is a tightly coupled
single-runtime contract and no independent delegation was required. The
main-thread fallback used separate implementation, adversarial-review, and
remediation passes.

Adversarial review considered whether a consumer could mask an acquire failure
with `continue-on-error` and then rely on the now-non-applicable cleanup gate for
an unsafe green. Disposition: rejected with existing enforcement evidence.
`internal/enrollment/unity_policy.go` requires critical-step failure
propagation, and table-driven tests reject `continue-on-error` on the acquire
step, licensed job, and composite acquire wrapper as `missing-lock-acquire`.
No actionable finding remained in the latest review round.

Continuous-improvement outcome: `promote`. The exact-false/non-applicable rule
and its preconditions are durable safety knowledge, so
`.llm/skills/build-lock-lifecycle/references/build-lock-invariants.md` now states
that exact output guarding and acquisition-failure propagation are required,
while missing or invalid acquisition state remains fail-closed.

Final local verification:

```text
node tools/llm-harness.mjs generate
node tools/llm-harness.mjs check
node --test test/unity-cleanup-gate.test.js \
  test/action-manifests.test.js \
  test/documentation-policy.test.js
go test ./internal/enrollment
.devcontainer/scripts/verify.sh
```

All commands passed. The CI-equivalent verifier reported 557 Node tests passed,
all Go packages passed, both modules verified and tidy, and the workflow
credential-literal audit passed.
