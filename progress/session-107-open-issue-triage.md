# Session 107: open issue triage and dependency review

Date: 2026-09-28

## Task and safety rules

Review every open issue, rank by impact while favoring low Unity CI churn, and
select the highest-priority safe work. Preserve licensed-resource safety,
fail-closed cleanup, queue fairness, and operator-visible evidence. Do not
change organization policy.

## Baseline

- `main` was clean at `f6a3179920338f9aba09275aa5c14f163b388ffd`.
- GitHub showed 12 open issues and no open pull requests.
- Build lock CI passed on this exact main commit in run `36357323048`.
- Organization enrollment audit passed in run `36357323031`.
- The latest incident recovery and reaper delivery audits also passed.
- The local `agent/session-059-issue-triage` branch is 60 commits behind
  `main`; it adds no work that needs carrying forward.

## Priority and disposition

| Priority | Issue | Impact and current boundary |
| --- | --- | --- |
| P0, owner authority | #51 | Writer and Unity secret scope is a security boundary. The required inventory, secret changes, and live probes need owner authority. The goal forbids organization policy changes. |
| P0, live license evidence | #83 | Shared entitlement returns can fail after concurrent Unity sessions. A safe policy change needs fresh return-order and portal evidence. Preserve the current fail-closed cleanup and capacity. |
| P0, owner policy | #44 | Inconsistent Unity merge gates can allow incomplete validation to merge. Enforcement needs coordinated ruleset changes across consumer repositories. |
| P1, consumer work | #269 | The central peer timeline shipped in #270. Consumer classification and any retry still need exact consumer workflow evidence. Enrollment guidance describes the proposed contract. |
| P1, root cause corrected | #278 | The issue's RCA says the cited lock attempts acquired and released normally. The remaining editor teardown failure overlaps #269. Do not add wait-and-queue behavior; it already exists. |
| P1, platform and authorization evidence | #153, #229, #231, #249 | Darwin and container cleanup need native platform canaries, measured identity, and reviewed immutable SHA authorization. Do not populate an authorization list from inference. |
| P1, operational evidence | #29 | Remaining lifecycle canaries and the seven-day monitor need owner-run licensed operations and portal evidence. |
| P1, architecture and load evidence | #53 | Runner starvation needs a fail-closed admission design, synthetic multi-repository tests, and real load across physical runners. |
| P2, evidence source gap | #277 | GitHub does not retain the canceller identity for the unexplained cancellation. Existing records rule out known push and watchdog cases; no central fix can recover missing actor data. |

This ranks by unresolved impact, then available authority and evidence, then
expected Unity CI churn. The highest-impact issues are blocked by the explicit
authority boundary or missing licensed evidence. #269 is the strongest central
candidate, but its remaining acceptance work is consumer-side. No issue has a
safe central patch ready in this worktree.

## Dependency review

- No dependency-upgrade pull request is open.
- The main module already selects `go.yaml.in/yaml/v4` at `v4.0.0-rc.6`.
- The isolated actionlint tool module pins actionlint `v1.7.12`. Its YAML
  parser stays at `v4.0.0-rc.3`; session 100 recorded that rc.6 breaks its
  build.
- The module graph reports newer transitive `goldmark` and `x/net` versions.
  Adding explicit overrides makes `go mod tidy -diff` remove those entries,
  because the actionlint wrapper does not directly use those modules. The
  trial changes were reverted. No dependency change remains.

## Result and follow-up

No issue was selected for implementation. The open issue inventory confirms
that the current blockers need authority, consumer changes, or live license
evidence. Continue with a fresh issue and dependency sweep after one of those
prerequisites changes. Do not claim this triage resolves any issue.
