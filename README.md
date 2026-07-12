# Ambiguous Organization Build Lock

This repository provides a central organization-level lock for licensed Unity
build sections. GitHub Actions `concurrency` is repository-scoped, so repos
that share one Unity Pro seat must use this lock before invoking Unity.
> [!NOTE]
> Consumer workflows must provide lock credentials with `contents: read/write` on this repository; stale-holder recovery also requires `actions: read` on consumer repositories. GitHub App credentials are described below; `BUILD_LOCK_TOKEN` remains available only for staged compatibility.
## Automated Releases

The `Auto release` workflow runs on a weekly schedule and via manual dispatch.
It uses conventional commits to determine semantic version bumps, creates
GitHub releases/tags only when there are changes since the previous release, and
force-updates the `v1` major alias when publishing a new `v1.x.y` release.
The workflow has a stable `auto-release` concurrency group with
`cancel-in-progress: false`, so scheduled and manual release runs queue instead
of racing or canceling an active publish/tag update.
Because `@semantic-release/github` publishes GitHub releases and performs its
default issue/PR updates, the workflow grants `contents: write`, `issues: write`,
and `pull-requests: write`. The `v1` alias is pushed through the authenticated
`origin` configured by `actions/checkout`; workflow policy tests reject
credentialed GitHub HTTPS URLs and direct `${{ secrets.* }}` or
`${{ github.token }}` interpolation in shell scripts.

## Consumer Workflow Pattern

Validate local secret shape first, acquire immediately before the licensed Unity
section, guard every licensed step on the acquire output, and release with
`if: always()`:

```yaml
- name: Validate Unity license secrets
  uses: ./.github/actions/validate-unity-license

- name: Acquire organization Unity lock
  id: acquire-build-lock
  uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@v1
  with:
    lock-name: wallstop-organization-builds
    holder-id-suffix: ${{ matrix.unity-version }}-${{ matrix.test-mode }}
    runner-id: ${{ runner.name }}
    timeout-minutes: "180"
    require-resource-lifecycle: "true"
    minimum-release-cooldown-seconds: "360"
  env:
    BUILD_LOCK_APP_ID: ${{ secrets.BUILD_LOCK_APP_ID }}
    BUILD_LOCK_APP_PRIVATE_KEY: ${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}

- name: Run Unity Test Runner
  if: ${{ steps.acquire-build-lock.outputs.acquired == 'true' }}
  uses: game-ci/unity-test-runner@v4

- name: Return Unity license
  id: return-unity-license
  if: always() && steps.acquire-build-lock.outputs.acquired == 'true'
  uses: ./.github/actions/return-unity-license

- name: Release organization Unity lock
  if: always()
  uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/release-build-lock@v1
  with:
    lock-name: wallstop-organization-builds
    holder-id-suffix: ${{ matrix.unity-version }}-${{ matrix.test-mode }}
    runner-id: ${{ runner.name }}
    resource-safe: ${{ steps.return-unity-license.outputs.resource-safe == 'true' }}
  env:
    BUILD_LOCK_APP_ID: ${{ secrets.BUILD_LOCK_APP_ID }}
    BUILD_LOCK_APP_PRIVATE_KEY: ${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}
```

The two acquire requirements are opt-in for backward compatibility. Lifecycle-aware
consumers should set both as shown. Acquire validates them against each lock config
snapshot it actually uses, including periodic refreshes while queued, and fails
before reading or mutating lock state if the initial snapshot cannot satisfy them.
This also makes a missing, malformed, or temporarily unreadable config fail closed
for consumers that require lifecycle protection.

The Unity return helper must be non-masking and emit `resource-safe=true` only
when the return command succeeds or an allowlisted response proves the local
activation is already absent. Missing credentials or tools, timeouts,
termination, and unrecognized responses must emit false. Give the return step an
ID and pass that proof to the unconditional release as shown above.

The release action is intentionally safe to run even when acquire never reached
the front of the queue. It reports `cleanup-result=cooldown-started`,
`cleanup-result=quarantined`, `cleanup-result=queue-cleaned`, or
`cleanup-result=noop`. `cleanup-result=released` is also possible before schema 4
or when an ambiguous schema-4 release is confirmed after its reservation expires.
`released=true` remains the backward-compatible
indication that holder ownership was removed. `queue-cleaned` means
the current run was waiting but never held the lock, so no licensed work should
have run. Do not gate the release step on `acquired == 'true'`; release also
cleans queue entries for runs that were interrupted while waiting.

Cleanup ownership is keyed to the exact logical `holderId`. In schema 3, a
monotonic run-attempt fence prevents a late older attempt from deleting a newer
rerun. `runnerId` controls admission only: a same-attempt fallback cleanup may
execute on a different physical runner. A separate fallback job must pass the
original acquire output as the release action's `holder-id`. If hard runner loss
makes that output unavailable, reconstruct it using the stable `v1` contract
`<repository>:<run-id>:<source-job-id>:<holder-id-suffix>`. Here `source-job-id`
is the acquiring job's YAML key (`GITHUB_JOB`), and every other value is the
exact value used by acquire. `GITHUB_RUN_ATTEMPT` is intentionally excluded so
a rerun can clean older ownership. Explicit targets are restricted to the
current repository and workflow run. The fallback passes its own non-empty
`runner-id` after runner serialization is activated.

`holder-id-suffix` may contain internal spaces or colons, but must not contain
line breaks or leading/trailing whitespace; the actions reject those values so
every acquired holder ID remains exactly reproducible by fallback cleanup.

Consumers that want an additional cancellation backstop can replace
`acquire-build-lock` with `acquire-build-lock-with-cleanup`. Keep the explicit
release step. The post cleanup is best-effort and removes this run's queued
request; under schema 4 it moves held ownership into quarantine because it
cannot prove external resource cleanup.

Keep `runs-on` broad enough for all eligible Unity runners. The lock serializes
only the licensed section; it should not be replaced with a single-runner label.

## State

Lock files live on the `lock-state` branch under `locks/<lock-name>.json`.
The actions create the branch and state files on first use.

State schema 2 stores a `holders` array so a lock can admit more than one
concurrent holder (see Configurable Parallelism). A legacy `holder` mirror of
the first slot is still written so pre-semaphore clients keep waiting
conservatively; schema-1 files are migrated on read, and state files written by
a newer schema than the running action fail closed with an upgrade error.
Schema 3 adds `runnerId` to holders and queue entries. Compatible clients keep
writing schema 2 until `runnerSerialization` is activated, then the state
upgrades one-way so a temporary configuration outage cannot disable it.

Schema 4 adds `reservations`. Confirmed resource cleanup creates a cooldown;
unknown cleanup creates a non-expiring quarantine. Both consume capacity.
Cooldowns expire automatically. A queued job may atomically reclaim a
quarantine only on the same physical runner, preserving return-at-start
recovery. Stale holders, post-action cleanup, and scheduled reaping become
quarantines because those paths cannot prove the external activation was
returned. Once schema 4 exists, configuration cannot downgrade lifecycle
protection.

State never stores tokens or environment dumps. It stores only run identity,
holder timing, queue entries, and public run URLs.

Holder identity intentionally excludes `GITHUB_RUN_ATTEMPT`; reruns of the same
workflow run can therefore release a lock left by the previous attempt instead
of queueing behind themselves.

## Configurable Parallelism

Each lock defaults to a single holder (a mutex). To let N clients hold a lock
concurrently, commit `locks/<lock-name>.config.json` to this repository's
default branch:

```json
{
  "maxHolders": 2
}
```

The config lives on the default branch (not `lock-state`) so parallelism
changes go through normal pull-request review. `maxHolders` must be an integer
between 1 and 64; a missing file or an invalid value fails closed to 1, which
can never over-run a license. Acquire reads the config at start and refreshes
it on a TTL (`BUILD_LOCK_CONFIG_TTL_MS`, default 5 minutes) while waiting, so
raising the limit also unblocks runs that are already queued. With runner
serialization active, admission scans the FIFO queue for up to F distinct
runners; a blocked request does not waste a free slot when a later request is
on another runner, while FIFO order within each runner is preserved.

Add `"runnerSerialization": true` only after every consumer passes the same
non-empty `${{ runner.name }}` to acquire and release and all schema-2 holders
and queued requests have drained. Activation against non-empty schema-2 state
fails closed. This assumes one registered runner agent per physical machine.

Add `"resourceLifecycle": true` only after all consumers pass cleanup proof and
schema-3 holders and queue entries have drained. Activation fails closed on
non-empty state. `"releaseCooldownSeconds": 360` retains a one-minute safety
margin over the observed five-minute Unity activation handoff. During rollout,
keep `maxHolders` at 1; restore 2 only after cross-runner canaries show no Unity
activation-limit failures.

## Authentication

Set `BUILD_LOCK_APP_ID` and `BUILD_LOCK_APP_PRIVATE_KEY` together. The App must
be installed on the lock repository and every consumer with Metadata read,
Actions read, and Contents read/write. The client mints an organization
installation token only when needed, keeps it only in memory, refreshes it five
minutes before expiry, and remints immediately after a 401. Partial App
credentials fail closed. `BUILD_LOCK_TOKEN` remains temporarily supported for
staged migration and should be removed after every old run drains.

Rollout note: upgrade every consumer to the latest `v1` before raising
`maxHolders` above 1. Pre-semaphore clients see only the mirrored first holder
(they wait conservatively and never over-admit), but a state write from such a
client drops the extra `holders` entries.

## Transient Auth Failures

GitHub intermittently rejects valid tokens with `401 Bad credentials` (auth
replica lag); GitHub's guidance is to retry after a short delay. All API calls
therefore treat 401 as retryable within the standard backoff budget
(`BUILD_LOCK_API_MAX_ATTEMPTS`, `BUILD_LOCK_API_RETRY_BASE_MS`,
`BUILD_LOCK_API_RETRY_MAX_MS`), and the acquire wait loop additionally keeps
polling through 401s under a consecutive-failure grace window
(`BUILD_LOCK_AUTH_GRACE_MS`, default 5 minutes; `0` restores fail-fast).
Genuinely bad credentials still fail once the grace window is exhausted, and
the holder-status poll continues to treat post-retry 401s as "status unknown"
governed by the holder lease.

## Stale Recovery

The `Reap stale build locks` workflow runs every 5 minutes. Before schema 4 it clears a holder
when the holder workflow run has completed, or when the lease has expired and
the run cannot be proven active. The same stale predicate is used by acquire and
the reaper.

Under schema 4, stale holders are quarantined instead of freed. Operators may
dispatch the reaper with `operation=recover`, the exact reservation ID, and
`resource-safe=true` only after confirming Unity portal cleanup. Recovery starts
a cooldown; it never frees capacity immediately.

The acquire actions set `stale-recovered=true` after GitHub accepts a
stale-holder replacement write. If a race prevents the action from verifying and
using that replacement before timeout, `acquired=false` remains authoritative for
guarding licensed work while `stale-recovered=true` preserves the diagnostic.

## Dependabot Auto-Merge

The Dependabot auto-merge workflow only acts on same-repository Dependabot PRs.
It checks the exact PR head SHA against the `Build lock CI` workflow before
enabling auto-merge, and it also listens for successful `Build lock CI`
`workflow_run` completions so a later CI rerun can enable auto-merge without a
new PR event. PR and CI-completion triggers share one per-head-SHA concurrency
key, so duplicate automation for the same Dependabot commit is deduplicated by
canceling older same-SHA runs while stale CI completions for older commits
cannot cancel newer PR automation.
Pull request events also recheck the event head SHA against the freshly fetched
PR before emitting outputs, so delayed older events do not operate on newer
commits.
Actions API failures are not swallowed; `GITHUB_TOKEN` must include
`actions: read` in addition to the write scopes used to enable auto-merge.
