# Session 065: complete Unity Helpers v1.13 adoption

Date: 2026-08-28

## Objective and safety invariants

Complete the highest-impact remaining Unity Helpers adoption work without
provisioning another App or token, weakening fail-closed cleanup, fabricating a
consumer-owned digest, or holding the organization lock during artifact work.
Review the live issue and pull-request surface, close only completed or
duplicate work, and retain every remaining substantive item as actionable work.

## Baseline and priority

The issue-consolidation pass in sessions 062 and 063 had already closed or
consolidated more than the requested five issues with evidence comments. The
live central surface contained eight issues, while Unity Helpers contained
thirteen. Unity Helpers #411 was the highest-impact repository-local item: its
four Windows licensed jobs were the last callers that returned their own Unity
license and therefore could not satisfy the digest-bound central classifier.

Dependabot PR #590 exposed the immediate failure. It updated the local
classifier to v1.13.0 but did not supply the new required
`return-log-digest`, so one of 64 workflow contracts failed closed. The durable
fix was not to weaken that input or hash repository-owned evidence. The
Windows callers needed the central editor and return authorities. The two
Ubuntu/Docker callers cannot use the Windows identity-bound deletion contract
and remain on their historical fail-closed lifecycle until central #153 adds a
trusted container executor.

## Central authorization and analyzer support

Central PR #218 authorized the exact v1.13.0 release commit
`300501e91c9bec81bb9b5a977c22aa5bb2d9b649` in both the global action policy
and the narrower credential-bearing return policy. The release tag and bytes
had already passed protected-main CI; the authorization PR and its post-merge
Build lock CI and organization audit were green.

The first safe Unity candidate used reviewed static matrix axes with dynamic
exclusions so manual dispatch pins remained truthful. It also released the
organization lock immediately after return/classification, then ran
diagnostics and uploads before a final fail-closed cleanup gate. The enrollment
analyzer rejected those two safe shapes because it understood only dynamic
include matrices and a gate immediately adjacent to release. Central PR #219
added regression coverage and accepted exclusion-only static matrices plus
post-release diagnostics while retaining the required adjacent
return/classifier/release chain and final cleanup gate. Its protected-main
Build lock CI and organization audit were green.

## Unity Helpers migration

Unity Helpers PR #592 superseded #590 and migrated all four Windows licensed
jobs to the immutable v1.13.0 lifecycle:

- central editor authority under `${{ runner.tool_cache }}\u6-v3` before
  repository-controlled code;
- acquire, central return, digest-bound classification, typed release, and a
  final confirmed-cleanup gate;
- static reviewed version/mode axes plus exclusion-only dispatch filters;
- exact JSON profile lookup by matrix mode so an empty assembly profile cannot
  fall through to another mode;
- return/classify/release immediately after Unity work, before diagnostics and
  artifact uploads;
- central return ownership for the post-test return while preserving the
  pre-activation reclaim and the fresh activation that follows it;
- the historical local lifecycle only for the two container-owned callers
  tracked by central #153 and Unity Helpers #323.

Contract coverage fixes the four-central/two-container split, dispatch
exclusions, exact assembly-profile selection, editor root, digest propagation,
step ordering, and ordered pre-return/activation/final-return ownership.

## Live canary RCA

The first central-path canary ran all 4,777 selected Unity tests successfully,
but the final gate quarantined `unity-return-400006`. Sanitized job evidence
showed the repository-local `run-ci-tests.ps1` finally block had already
returned the seat immediately before the central executor ran. The central
executor therefore performed a redundant second return and correctly treated
the ambiguous response as unsafe.

The correction makes central callers skip only the repository-local post-test
return. It deliberately preserves the return-at-start defense because a fresh
activation follows it; that reclaim handles a seat leaked by a prior
force-killed self-hosted job without consuming the later central evidence.
Subsequent licensed jobs completed central return, digest-bound
`cleanup-confirmed` classification, successful release into cooldown, and the
final cleanup gate without a redundant 400006.

## Review and validation

Cursor Bugbot reported five actionable findings, all accepted and fixed:

1. static matrices initially ignored manual dispatch pins;
2. return and lock release initially happened after artifact uploads;
3. boolean assembly selection could fall through when the selected profile was
   empty;
4. the first double-return fix also suppressed the necessary pre-activation
   reclaim;
5. the first ownership contract miscounted the restored reclaim and the
   existing activation guard.

The final review surface had no unresolved threads. Copilot review attempts
reported quota exhaustion and supplied no code finding. One Windows Local
Gates run then exposed a contract-test defect: the test counted all ungated
credential guards and forgot that activation has its own guard. The contract
was corrected to assert the ordered return-at-start, activation, and centrally
gated final-return calls with exact invocation counts; production behavior did
not change.

Validation included YAML formatting, actionlint, build-lock input validation
for 43 calls across five workflow files and nine immutable action versions,
17 action-input parser assertions, dispatch-exclusion fixtures, exact v1.13
portable parity for 11 classifier and nine gate cases, `git diff --check`, the
full Unity Helpers Local Gates and type-check jobs, all licensed Unity tiers,
and a post-merge main run. The organization analyzer recognized all four
Windows lifecycle chains; the remaining Unity findings are the intentionally
retained container/platform work.

The first protected-main Unity Tests attempt (`33215639494`) preserved the
same production result: all eight fast tiers, four standalone tiers, and the
single-threaded editmode tier passed. GitHub never assigned the final
single-threaded playmode cell to a runner and later cancelled only that
zero-step job. The repository watchdog independently reported that no matching
idle runner was available and took no action (`33220260756`), so this was
runner availability, not a cleanup-lifecycle regression. A failed-jobs-only
retry preserved the 13 green Windows results and queued only the cancelled
cell. When a matching runner returned, that cell passed its test, central
return, digest classification, typed release, and final cleanup gate. The
subsequent package export smoke and `Unity CI Success` aggregate also passed,
making protected main fully green on attempt 2.

## Issue and pull-request disposition

- Unity Helpers #411 closed with PR #592 after the Windows migration and live
  cleanup proof completed its acceptance boundary.
- Unity Helpers PR #590 was closed as superseded after preserving its safe pin
  updates in #592 and recording the missing-digest RCA.
- Central #212 was closed again as a duplicate: #218 authorized v1.13.0, #219
  enabled the safe analyzer shapes, and #592 completed Windows adoption. The
  only remaining platform boundary is central #153 with Unity Helpers #323.
- Central #113 remains open because it is the automated active enrollment-drift
  tracker and its latest audit still reports findings.
- Unity Helpers #322 remains open because its zero-finding acceptance criterion
  is not met; #323 remains the canonical container/licensed-compatibility
  restoration item.

All other live central and Unity Helpers issues were re-read and retained only
when their bodies described unfinished security, operations, platform,
performance, feature, documentation, or measured-research work.

## Continuous improvement

This investigation crossed release authorization, consumer enrollment,
self-hosted runtime behavior, and exact matrix selection, so the continuous
improvement gate applied. The durable lessons are encoded in production
contracts, data-bound workflow tests, review dispositions, and this sanitized
progress record: a repository-local finally block can silently consume the
evidence expected by an adjacent central executor, while a pre-activation
reclaim has a different ownership boundary because activation follows it; and
boolean fallback is unsafe for exact matrix values when empty is meaningful.
Existing LLM guidance already requires fail-closed evidence, red-green tests,
and adversarial review, so no competing `.llm` rule was added.

## Delivery

- Central authorization: PR #218
- Central analyzer support: PR #219
- Unity Helpers adoption: PR #592
  (`d7c9b82f218241f91cc2a248b6fac6d96e63a18e`)
- Unity latest-head validation: Unity Tests `33211086176`, Local Gates
  `33211086231`, Repo Lint `33211086177`, CSharpier `33211086179`, and
  Prettier `33211086206`
- Unity post-merge validation: Unity Tests `33215639494` (attempt 2), Repo
  Lint `33215638943`, Local Gates `33215639026`, Docs Pages `33215642080`,
  and Docs Wiki `33215639376`
- Final central evidence: this progress record
