# Session 011: issue #52 admission safety

Date: 2026-07-20

## Open-issue priority

Impact is primary; expected Unity CI churn breaks ties.

1. **#52 cancellation safety** — critical availability/safety risk; automatic
   cancellation after acquire can quarantine one or both seats. Land the central
   guard and acquire-time revalidation with zero licensed CI first, then publish,
   repin, and canary consumers.
2. **#51 App and organization-secret scoping** — critical control-plane blast
   radius, but acceptance requires owner/settings work and cannot be completed by
   an ordinary repository PR without changing organization policy.
3. **#77 delayed stale-lock reaping** — high measured availability impact and
   zero-Unity central documentation/monitoring work; keep separate from admission.
4. **#44 truthful required Unity aggregates** — high merge-integrity impact with
   consumer and ruleset churn; depends on safe cancellation behavior.
5. **#42 continuous enrollment audit** — high defense-in-depth value and mostly
   hosted CI; split from draft PR #56 after the #51 privilege boundary is proven.
6. **#53 runner starvation before FIFO** — high throughput/fairness impact but a
   large two-phase admission design and high multi-repository canary cost.
7. **#49 unity-helpers matrix bounds** — medium-high throughput impact and high
   licensed matrix churn; depends on #52 and truthful aggregates.
8. **#54 Isho cleanup canary** — medium assurance value with one or two licensed
   paths; perform after the #52 rollout.
9. **#29 lifecycle canaries and seven-day monitoring** — critical closure evidence,
   but not a standalone code PR; start the window after #52, #54, and #77.
10. **#60 literal zero cooldown** — low incremental impact because live cooldown is
    already approximately one second; combine the release repin with #52, but keep
    the zero-cooldown canary distinct.
11. **#79 Date.now/UTC** — no demonstrated bug: JavaScript `Date.now()` already
    returns UTC epoch milliseconds.
12. **#27 lock-held regression** — duplicate/subset of the #29 operational gate.
13. **#30 rollout tracker** — umbrella tracker and owner evidence; close last.

## Draft PR #56 disposition

Do not merge or delete it. Head `17f191a96a215ac171da270ac6383e7ac2880ccf`
is conflicting and thirteen commits behind current main, all six policy manifest
heads are stale, and its before/after/manual cancellation canaries are incomplete.
Live consumer defaults still reference commits in its lineage, so preserve the ref
until replacements are released and repinned. The safe path is to supersede it in
stages: central admission safety first, the #42 analyzer/audit later, then retire
the old lineage only after repository-wide reference verification.

## This PR scope

- Add a bounded, fail-closed `require-current-pr-head` action.
- Add PR identity inputs to both acquire action manifests.
- Revalidate the PR before lock-state access, periodically in FIFO, immediately
  before admission, and after verified admission before licensed work can start.
- Retract the caller's exact queue/holder identity when stale or unverifiable.
- Preserve a reclaimed quarantine's exact provenance and never create a lifecycle
  reservation for known pre-activation retraction.
- Document the pre-setup guard, acquire binding, and matrix `fail-fast: false`.

The #42 transitive policy analyzer, live consumer repins, and controlled licensed
canaries remain follow-on stages under #52; they are intentionally excluded from
this zero-Unity-churn central slice.

## Validation

- JavaScript syntax: all action distributions and tests passed.
- actionlint v1.7.12: passed through the isolated tool module.
- Node test suite after CI and reviewer remediation: 441 passed, 0 failed.
- Go tests: passed.
- Root and actionlint module verification/tidy checks: passed.
- Workflow credential-literal audit: passed.
- Focused PR-head coverage proves entry rejection, periodic queue revalidation,
  pre-admission checking, and post-verification exact retraction without a new
  reservation.
- Adversarial follow-up also covers terminal PR authorization failure, cleanup
  CAS exhaustion, timeout classification, holder/quarantine provenance, ambiguous
  recovery conflicts, and runtime parsing of all three PR identity inputs.
- The standalone guard's terminal error command escapes percent sequences before
  writing to the GitHub Actions command channel; injection-shaped regression
  coverage verifies percent and newline handling.

Root dependencies and pinned GitHub Actions are current. The actionlint tool
module's YAML rc.3 has a newer rc.6 available, but a clean compatibility probe
failed compilation against actionlint v1.7.12, so that isolated pin is retained.

Five unrelated untracked progress artifacts were present when the clean branch was
created. They were not modified or staged.

## Hosted CI RCA

PR #80 run `29778788595` exposed a test-environment leak: GitHub-hosted pull
request jobs set `GITHUB_EVENT_NAME=pull_request`, but the build-lock test helper
did not include that variable in its controlled Actions environment. Fifty-one
legacy non-PR acquire tests could therefore enter the new fail-closed PR path only
on hosted CI. Production behavior was correct. The harness now scrubs/restores
`GITHUB_EVENT_NAME` like every other Actions variable, while PR-specific tests
continue to set it explicitly.

Bugbot then identified that a signal abort during embedded PR validation could
write a typed PR failure before normal cancellation cleanup. Acquire now checks
cancellation at every PR lookup/cleanup boundary and rethrows directly to the
existing signal handler. SIGINT lookup cancellation and both validation-error and
stale-head cleanup cancellation paths prove exit 130, exact queue cleanup, no
unrelated state removal, and no `pr-head-*` output misclassification.
