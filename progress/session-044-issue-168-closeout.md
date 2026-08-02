# Session 044: Issue #168 safe-directory rollout closeout

Date: 2026-08-01

## Selection and priority audit

The live open-issue inventory was reviewed before selecting work. Priority
orders reliability and security impact first, then the amount of dependent
Unity/consumer churn and the availability of a safe, directly actionable
change:

| Priority | Issues | Disposition |
| --- | --- | --- |
| P0 | #27, #44, #51, #53, #83, #113, #160 | Lock-held incidents, truthful aggregates, credential scope, runner starvation, entitlement return behavior, enrollment drift, and return-evidence safety remain active follow-ups. |
| P1 | #49, #60, #94, #99, #132, #153 | Throughput, cooldown, dependency, minimal-lifecycle, recovery-ergonomics, and non-Windows cleanup work require broader validation or separate rollout. |
| P2 | #29, #30 | Monitoring and rollout tracking remain operational follow-ups. |

Issue #168 was selected as the highest-impact low-churn issue that could be
completed without changing organization policy, credentials, runner capacity,
or live lock state. Its scope was the isolated trusted `unity-helpers`
checkout: preserve the five Git-isolation environment entries and require the
literal `set-safe-directory: false` input.

## Completion evidence

Central policy tightening and contract coverage were already merged in PR
#167. The remaining consumer rollout was completed by the exact-head PRs
IshoBoy #338, qora-redux #201, DoxReloaded #305, and finally
[DxMessaging #339](https://github.com/Ambiguous-Interactive/DxMessaging/pull/339).

PR #339 added the literal opt-out to all five trusted validator checkouts:
`perf-numbers.yml`, `unity-benchmarks.yml`, `unity-tests.yml`, and both
affected `release.yml` checkouts. Its contract test is step-scoped and
requires, in order, `GIT_CONFIG_NOSYSTEM: 1`, `GIT_CONFIG_GLOBAL: /dev/null`,
the exact repository and path, `persist-credentials: false`, `clean: true`,
and `set-safe-directory: false`.

At exact head `bcfd722cc052cb72b2f9b6d06c7d3f250a0ba3d5`:

- 17 focused contract tests passed and the JavaScript line budget held at
  17612/17612;
- static, documentation, formatting, script, devcontainer, and .NET checks
  passed;
- all nine Unity editor/mode jobs, head freshness, runner preflight, and
  `Unity CI Success` passed;
- Cursor and Copilot reviews found no remaining issues after the contract was
  hardened; and
- the protected merge succeeded at
  `23b1c916530680247d1c61a34badeb39312de562`.

The live `master` clone at that merge commit contains `set-safe-directory:
false` in all five trusted checkout sites. Issue #168 is closed by GitHub with
state reason `completed`.

The real Unity matrix proves the trusted Windows checkout and complete
acquire/test/return/classify/release/cleanup lifecycle. A broad enrollment
scan still reports unrelated drift tracked by #113; that is intentionally not
represented as resolved by this issue closeout.

## Default-branch verification

At the time of this record, the post-merge `master` CI, devcontainer,
release-drafter, and stuck-job watchdog runs were green at the merge commit.
The post-merge Performance Numbers and Unity Tests runs were still queued and
remain required follow-up verification before declaring the default branch
fully green.

No credentials, licensed logs, raw runner diagnostics, organization policy,
runner capacity, or live lock state are recorded here.
