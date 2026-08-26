# Session 060: issue-212 adoption-triage disposition and open-issue refresh

Date: 2026-08-26

## Objective and invariants

Review all open issues, re-verify each recorded blockage against today's live
state, prioritize by impact with the least Unity CI churn, complete the
highest-priority completable objective, and preserve fail-closed
licensed-resource safety, queue fairness, recoverability, and operator-visible
evidence.

## Baseline

- `origin/main` was green at `b5363e615` (CI on push, 2026-08-25) and every
  scheduled lock, recovery, reaper, and enrollment-audit workflow completed
  green on 2026-08-26, including a fresh audit run publishing 209 sanitized
  findings.
- The working tree was clean; there were no open pull requests in this
  repository; `.llm/tasks/` held no uncommitted
  carried-forward work.
- The complete local CI equivalent (`.devcontainer/scripts/verify.sh`) passed
  in-session together with the individual harness, Node contract, Go, lint,
  shellcheck, race, and credential-audit gates.

## New issue #212: "Unity Helpers cannot adopt latest tech"

Filed 2026-08-26 linking the dependabot re-pin PR
[unity-helpers#559](https://github.com/Ambiguous-Interactive/unity-helpers/pull/559),
whose `Contract Suites` gate fails because both cleanup call sites omit the now
required `return-log-digest`. Verified centrally:

- The requirement is intentional fail-closed digest binding from the trusted
  return executor lineage (#149); only the central return action produces the
  digest.
- Identity-bound evidence deletion still throws
  `Identity-bound return evidence deletion requires Windows.`, so non-Windows
  legacy callers cannot adopt any post-`673eb65e` classifier even with the
  digest supplied; that platform extension is scoped here as #153 with paid
  canary prerequisites.
- Adoption additionally requires editors under the central tool-cache root on
  the self-hosted runner, i.e., physical provisioning tracked upstream
  (unity-helpers #411 blocked on #325).

Disposition: commented on #212 with the full chain so future sessions need not
re-investigate, and retained it open as the central-side adoption tracker until
unity-helpers #411/#498 land or #153 extends platform support. No central code
path was weakened to make a downstream bump green.

## Refreshed prioritized inventory

| Priority | Issue | Re-verified disposition (2026-08-26) |
| --- | --- | --- |
| P1 hygiene | #188 | Blocked: migrating `app-id` → `client-id` needs a new organization secret (`BUILD_LOCK_READER_APP_CLIENT_ID`) plus its value. Org-secret API is outside this token's authority (404) and the client-ID value is not derivable or committed anywhere; switching to an absent secret would red CI while breaking nothing safe. Two-step change remains ready once provisioned. |
| P1 tracking | #212 | Downstream-blocked as above; resolution owned by unity-helpers #411/#498 and this repo's #153 platform work. |
| P2 churn-heavy | #113 | All remediation lives in five consumer repositories' workflow files (today's audit republished sanitized findings); exactly the Unity CI churn minimized. Central analyzers stay green. |
| P2 blocked-by-#83 | #60 | Config still holds the deliberate transitional `releaseCooldownSeconds: 1`; sessions 008/027/032 record literal zero as unsafe until #83 seat-collision evidence resolves, and #83 gained fresh independent replication data keeping it open. |
| P2 maintainer-decision-blocked | #83 | Measured second-holder entitlement collision signature stays quarantined-fail-closed pending independently returnable identities and portal reconciliation. |
| P2 architecture/downstream/platform | #53, #49, #99, #153 | New admission protocol + multi-repo load evidence; consumer-repo matrix policy; consumer-side activation/return retry loops; Windows-container/Darwin trusted cleanup implementations with paid canaries. |
| P3 authority-gated | #44, #51 | Consumer ruleset enforcement and org-secret visibility changes exceed repository authority. |
| P3 live-ops | #29, #27, #30 | Seven-day monitoring windows and portal-evidence canaries remain outstanding. |
| Upstream-blocked | #94 | actionlint's latest release is still v1.7.12 (rechecked via API); it does not compile against yaml/v4 rc.6. |

## Dependency currency

- `go list -m -u` reports no available updates for either module.
- Every third-party workflow pin matches the latest upstream release commit,
  including peeling annotated tags (for example, golangci-lint-action v9.3.0
  points at exactly our pinned SHA through its tag object).
- No npm manifests exist; committed runtimes remain dependency-free by
  contract.

## Disposition

No open issue was completable without violating safety invariants, ownership
boundaries, or the churn-minimization rule; per precedent the session therefore
delivered verified evidence rather than manufactured motion: the #212 triage
comment, this record, and no source-behavior change. Scheduled workflows may be
used post-merge to confirm `main` stayed green.
