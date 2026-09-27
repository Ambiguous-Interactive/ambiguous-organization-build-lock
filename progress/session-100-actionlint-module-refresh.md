# Session 100: refresh actionlint module dependencies

Date: 2026-09-27

## Task and safety rules

Review the live open-issue set, carry forward relevant open dependency work, and prefer changes with low Unity CI churn. Keep fail-closed enrollment and license cleanup behavior intact. Do not change organization policy, license scope, runner capacity, or licensed job behavior.

## Open issue review and priority

The live central repository snapshot contains 12 open issues: #278, #277, #269, #249, #231, #229, #153, #83, #53, #51, #44, and #29. Issue #113 closed automatically after the merged enrollment classifier fix from session 099.

| Priority | Issue | Impact and current blocker | Decision |
| --- | --- | --- | --- |
| P0, owner authority | #51 | App credential and organization-secret scope is the broadest security boundary. Fresh owner-authorized inventory, secret visibility changes, and live negative probes are required. | No org policy or secret changes without owner evidence. |
| P0, owner authority | #44 | Missing consumer Unity required checks can permit premature merges. Ruleset enforcement requires each consumer owner and explicit unity-builder canary policy. | Keep staged until authorized. |
| P0, portal evidence | #83 | Shared-seat return failures can quarantine a clean runner. Safe handling requires exact return ordering and portal proof. | Preserve quarantine and current capacity. |
| P1, live monitoring | #29 | Remaining hard-stop, incident, third-runner, cleanup and seven-day canaries require physical runners and portal evidence. | Do not synthesize live evidence. |
| P1, design/load | #53 | Starvation occurs before FIFO admission. A fix needs a fail-closed protocol, synthetic fairness tests, and two-runner load evidence. | No admission or capacity change without proof. |
| P1, platform evidence | #153 | Container/Darwin cleanup acceptance requires platform-native canaries. | Keep current fail-closed behavior. |
| P1, platform evidence | #229 | Darwin canary and authorization plus the container workflow shape remain outstanding. | Continue only with exact native evidence. |
| P1, authorization | #231 | Darwin authorization requires measured team identity, reviewed immutable SHA, and native canary. | Do not infer identity or authorize a release. |
| P1, authorization | #249 | `approvedDarwinReturnShas` correctly remains empty pending the same authorization evidence. | Preserve empty fail-closed list. |
| P1, causal evidence | #269 | The lock-side peer timeline shipped in #270; consumer classification and any bounded retry require live evidence. | No retry policy based on a hypothesis. |
| P2, attribution unavailable | #277 | Retained GitHub records do not identify who cancelled the queued runs. | Preserve the RCA; revisit if a source exposes actor data. |
| P2, premise disputed | #278 | Session 097 refuted the cited seat-collision premise; the remaining editor report lacks its original suite log. | Do not implement wait-and-queue from unsupported evidence. |

## Selected work and dependency findings

Completed issue #113 remains fully merged and audited as recorded in `progress/session-099-open-enrollment-contract-fix.md` (central PR #286 and DoxReloaded PR #946). No central pull request was open at the start of this dependency pass.

The actionlint module pins actionlint v1.7.12, which is current. The safe compatible transitive updates available in its module graph are:

- `github.com/bmatcuk/doublestar/v4` v4.10.0 → v4.10.2
- `github.com/mattn/go-runewidth` v0.0.28 → v0.0.30
- `github.com/mattn/go-shellwords` v1.0.14 → v1.0.15
- `golang.org/x/sync` v0.22.0 → v0.23.0
- `golang.org/x/sys` v0.47.0 → v0.48.0
- Go directive normalized to 1.26.0

The YAML parser candidate v4.0.0-rc.6 breaks actionlint v1.7.12 compilation (`ParserError` and parser error API changes), so this graph retains the currently pinned v4.0.0-rc.3. Root module review found no available update. The full verifier passed after restoring the compatible YAML pin.

## Downstream pull request audit

The session carried forward two relevant consumer changes:

- DxMessaging PR #601 repinned the central lock action to authorized v1.15.0 and merged as `747342b2470336991aa53cf8109f297bfc5647d9`. Its PR checks, including all Unity matrix jobs, passed. At the time of this record, post-merge `Unity Tests` run 36282799766 and `Performance Numbers` run 36282799975 remained queued; completion must be recorded before handoff.
- IshoBoy Dependabot PR #1003's `smol-toml` update exposed a test assumption about object prototypes. A focused own-field comparison preserves the production parser output. The repair is in PR #1015: https://github.com/Ambiguous-Interactive/IshoBoy/pull/1015. The full `npm test` suite and focused MCP test passed locally (70/70 focused tests); all currently completed PR workflows passed. Pre-Commit and Unity CI Validation were pending at the time of this record. The licensed Unity jobs are expected not to be needed for this test-only/dependency change; inspect actual job results before merge. No submitted review or inline thread was present at last check.

## Central validation and remaining work

`bash .devcontainer/scripts/verify.sh` passed on the dependency changes, including repository Node/Go checks, actionlint, workflow validation, module verification, and credential-literal audit. No production action, enrollment policy, lock state, or Unity workflow changed.

The central branch has not yet been committed or opened as a PR. Remaining session work: poll the two DxMessaging post-merge runs and IshoBoy PR #1015 checks; address failures or reviewer feedback; merge the consumer fix only after its checks are green; install/confirm central hooks; commit the dependency update and this progress record with the carried-forward session-099 edit; push and open the central PR; drive central PR CI/review to completion; merge; then verify `main` and enrollment audit remain green. Record final evidence here before declaring the session complete.
