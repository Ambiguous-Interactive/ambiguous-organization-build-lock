# Session 010: runner API resilience

Date: 2026-07-20

## Scope selection

All open issues and the existing draft PR were inspected. Impact was ranked
first, with lower Unity CI churn breaking comparable-impact ties. Issue #51 is
the highest security risk but requires owner-authorized organization settings
and is outside this session's no-policy-change boundary. Draft PR #56 remains
important but is stale, conflicting, and incomplete across central and consumer
canaries. Issue #76 is the highest-impact safely actionable change: a real
GitHub 500/502 incident exhausted the runner preflight's short retry ladder and
made a required Unity aggregate red without a repository fault.

Prioritized inventory after the follow-up audit:

| Priority | Issue | Impact | Unity CI churn / disposition |
| --- | --- | --- | --- |
| 1 | #51 | Critical credential trust boundary | Low-medium, but owner/org-policy blocked |
| 2 | #52 | Critical cancellation safety | High; partial consumer rollout and stale #56 |
| 3 | #42 | High systemic enrollment enforcement | Low centrally; depends on #51 and stale audit work |
| 4 | #44 | High truthful merge gating | High across paid consumers |
| 5 | #76 | High required-check availability | Zero for central implementation; selected |
| 6 | #77 | High stale-recovery availability | Zero-seat design/monitoring follow-up; may need an independent trigger |
| 7 | #53 | High runner fairness/throughput | Very high; new admission architecture and load canaries |
| 8 | #54 | Medium cleanup assurance | Low/no new Unity churn likely: IshoBoy PR #160 already produced green EditMode, PlayMode, cleanup, and aggregate jobs; evidence and portal validation remain |
| 9 | #49 | Medium feedback throughput | Very high 15-leg before/after Unity sweeps |
| 10 | #29 | Medium operational assurance | High and seven-day time gate |
| 11 | #27 | Duplicate incident/regression scope | Group with #29 |
| 12 | #60 | Low incremental cooldown improvement | High five-consumer repin; group with a future #76 release rollout |
| 13 | #30 | Umbrella tracker | Close only after child/security work |

Draft PR #56 should be superseded through staged #52 replacements rather than
merged as-is: it is 12 commits behind, has 11 production/test conflicts, stale
consumer head pins, and incomplete controlled canaries. Its unique safety work
remains required under #52.

## Red-green evidence

- Baseline: 383 Node tests passed; Go tests, actionlint, module verification,
  tidy checks, and the credential-literal audit passed.
- Red: five focused tests failed before implementation, covering strict
  `Retry-After` parsing, injected full jitter/clock behavior, structured
  deadline diagnostics, runner-specific policy, and API-unavailable
  classification.
- Green: the focused build-lock and runner-preflight suite passed 309 tests
  after implementation. The complete suite then passed 397 tests with syntax,
  Go test/vet, actionlint, module verification/tidy, credential audit, and diff
  hygiene all green.

## Implementation

- Apply one 150-second deadline across reader-App authentication and every
  paginated runner-inventory request, retaining multi-minute resilience and
  leaving 30 seconds for diagnostics and teardown in three-minute consumer jobs.
- Use up to 13 attempts per request inside that shared deadline, 5-second
  exponential bases capped at 60 seconds, and full jitter.
- Honor strict `Retry-After` seconds and HTTP-date values with an injected clock.
- Preserve status, request ID, endpoint, and attempt count when a retryable API
  operation exhausts attempts or the shared deadline.
- When a sole token-refresh waiter reaches that deadline, abort its shared
  refresh and await the structured retry failure so authentication diagnostics
  are not replaced by a bare timeout; independently cancelled concurrent
  waiters still detach without aborting the refresh needed by the others.
- Distinguish API/auth availability failures from a successfully read inventory
  that contains no matching online runner while preserving fail-closed exit
  behavior.
- Update all workflow pins to actions/checkout v7.0.1 and update every
  compatible explicit actionlint-module dependency with an available newer
  version. The attempted YAML rc.3 to rc.6 upgrade was reverted after the full
  matrix proved actionlint v1.7.12 (the latest release) does not compile against
  rc.6's changed parser-error API.

## Follow-up discovered

Opened #77 after verifying that 50 successful scheduled reaper runs had a mean
38.5-minute dispatch gap (22.1-minute minimum, 85.9-minute maximum) despite the
requested five-minute cron. The issue owns monitoring, truthful documentation,
recovery SLOs, and concurrency review without weakening cleanup proof.

## Delivery state

Local implementation and battle testing are complete. Three independent
adversarial reviews converged on zero remaining code, test, documentation,
dependency, or design findings after the final strict-date-parser corrections.
PR, hosted-review, CI, merge, and default-branch evidence remain pending.
