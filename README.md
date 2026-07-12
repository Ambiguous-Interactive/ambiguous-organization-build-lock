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
  env:
    BUILD_LOCK_APP_ID: ${{ vars.BUILD_LOCK_APP_ID }}
    BUILD_LOCK_APP_PRIVATE_KEY: ${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}

- name: Run Unity Test Runner
  if: ${{ steps.acquire-build-lock.outputs.acquired == 'true' }}
  uses: game-ci/unity-test-runner@v4

- name: Release organization Unity lock
  if: always()
  uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/release-build-lock@v1
  with:
    lock-name: wallstop-organization-builds
    holder-id-suffix: ${{ matrix.unity-version }}-${{ matrix.test-mode }}
    runner-id: ${{ runner.name }}
  env:
    BUILD_LOCK_APP_ID: ${{ vars.BUILD_LOCK_APP_ID }}
    BUILD_LOCK_APP_PRIVATE_KEY: ${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}
```

The release action is intentionally safe to run even when acquire never reached
the front of the queue. It reports `cleanup-result=released`,
`cleanup-result=queue-cleaned`, or `cleanup-result=noop`; `queue-cleaned` means
the current run was waiting but never held the lock, so no licensed work should
have run. Do not gate the release step on `acquired == 'true'`; release also
cleans queue entries for runs that were interrupted while waiting.

Consumers that want an additional cancellation backstop can replace
`acquire-build-lock` with `acquire-build-lock-with-cleanup`. Keep the explicit
release step. The post cleanup is best-effort and only exists to remove this
run's held lock or queued request if later workflow steps are interrupted before
the explicit release action can run.

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

The `Reap stale build locks` workflow runs every 5 minutes. It clears a holder
when the holder workflow run has completed, or when the lease has expired and
the run cannot be proven active. The same stale predicate is used by acquire and
the reaper.

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
