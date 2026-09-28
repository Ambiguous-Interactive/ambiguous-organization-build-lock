# Session 110: refresh live issue and policy evidence

Date: 2026-09-28

## Task and safety rules

Recheck the open issues, pull requests, and available dependencies. Rank work
by impact, then by the authority and evidence needed. Do not change live
organization or consumer merge policies. Preserve fail-closed Unity cleanup.

## Baseline

- `main` was clean at `5e356d6c3569952a4a4814c71893d6c94bc7e9a2`.
- The full open-issue search returned 12 central issues. The central repository
  had no open pull requests.
- Post-merge Build Lock CI run `36375692036` passed on this `main` commit.
- The latest merge-policy audit, run `36307374092`, completed all six
  repositories with zero findings. Its artifact records the reviewed active
  check contexts.

## Updated priority

| Priority | Issue | Current impact and boundary |
| --- | --- | --- |
| P0, owner security action | #51 | Organization secrets remain broader than the enrolled set. The issue records that both Apps are installed org-wide by owner choice. Scope and negative probes need owner action. |
| P0, live policy binding | #44 | Reviewed contexts are active, but four live rulesets return `integration_id: null`. Qora Redux classic protection reports App ID `15368`. Binding issuers requires a merge-policy change, which this task forbids. |
| P0, licensed evidence | #83 | PR #227 and v1.15.0 fix the proven false quarantine when the peer already returned the seat. Two independently returnable identities and live portal reconciliation remain unproven. |
| P1, consumer test handling | #269 | PR #270 shipped the peer timeline. Replay found no concurrent peer in either reported failure. A peer returned on the same runner 40 to 62 seconds earlier. This is correlation, not cause. A full rerun reproduced the assertion; an in-lock retry remains untested. |
| P1, editor teardown | #278 | Its RCA records clean lock admission and release. The missing Unity test log and consumer retry behavior remain open. |
| P1, native cleanup and authorization | #153, #229, #231, #249 | Native canaries and reviewed platform authorization still need owner-run licensed evidence. |
| P1, lifecycle evidence | #29 | Remaining canaries and seven-day monitoring need owner-run licensed operations and portal evidence. |
| P1, runner capacity | #53 | A safe starvation fix still needs fail-closed design, synthetic multi-repository tests, and physical runner load evidence. |
| P2, event evidence gap | #277 | GitHub does not retain the canceller identity for the unexplained run. Central code cannot recover the missing actor. |

Issue #44 also has active status contexts across the enrolled consumers. The
read-only audit and check-run evidence do not show an issuer restriction for
four rulesets. I added these facts to #44 without changing settings.

The latest lock-state replay for #269 does not support the original concurrent
holder hypothesis for those two attempts. I updated #269 to state this limit,
retain the historical report, and keep the consumer work open.

## Dependency review

- No central dependency pull request is open.
- The main module reports no available module upgrade. It already uses YAML
  parser `v4.0.0-rc.6`.
- Actionlint `v1.7.12` is the newest tagged version.
- The actionlint module reports newer `goldmark` and `x/net` candidates, but
  neither is required by the wrapper's imports and `go mod tidy` removes
  explicit additions. The YAML parser's `rc.6` candidate is incompatible with
  actionlint `v1.7.12`, as session 100 recorded.
- No safe dependency change is available without a compatible actionlint
  release.

## Disposition

The central code work for #83's measured false quarantine and #269's peer
timeline is already shipped. The remaining highest-impact work requires owner
security or merge-policy changes, live Unity account evidence, or consumer
workflow changes. This session records fresh evidence and does not claim those
issues are resolved. No organization setting, consumer setting, lock behavior,
or dependency changed.

## Review

- The #83 status keeps the two-seat capacity question separate from the
  classifier fix.
- The #269 status distinguishes the observed timeline from cause.
- The #44 status reports active contexts and unbound issuer fields separately.
- No durable agent guidance change is needed. The new findings are current
  organization evidence, not a repository-wide rule change.
