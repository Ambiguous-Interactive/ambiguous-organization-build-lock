# Ambiguous Organization Build Lock

This repository provides a central organization-level lock for licensed Unity
build sections. GitHub Actions `concurrency` is repository-scoped, so repos
that share a finite Unity Pro seat pool must use this lock before invoking
Unity.
> [!NOTE]
> Consumer jobs use a state-writer GitHub App whose tokens are restricted to
> this repository with `contents: write`. A separate reader App has
> `actions: read`, `contents: read`, `metadata: read`, and organization
> `self-hosted runners: read`; each operation requests only the permission and
> repository subset it needs. The required selected-repository installation
> boundary and the currently open control-plane scope gap are documented in the
> steady-state runbook.
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

See [consumer enrollment](docs/consumer-enrollment.md) for the repeatable
repository/App/secret-scope checklist and canary requirements. Operators should
use the [steady-state runbook](docs/operations-runbook.md); the secure rollout
document is a historical migration record.

Run a hosted preflight before every self-hosted Unity job. It mints a
short-lived token from the reader App, asks GitHub for runner groups visible to
the calling repository, and considers only runners in those groups. It fails
closed when that inventory cannot be read, the repository has no visible runner
group, or any required label set has no accessible online runner. A busy online
runner is considered available infrastructure and may queue the licensed job.

GitHub App authentication and every paginated runner-inventory read share one
150-second deadline, leaving diagnostic and step-teardown headroom inside the
consumers' three-minute preflight job limit. Retryable API responses use bounded
exponential backoff with full jitter; a valid `Retry-After` delta-seconds or
HTTP-date value takes precedence, capped at 60 seconds. Ordinary
permission/configuration responses such as non-rate-limited 403 and 404 fail
immediately. If the bounded retries are exhausted, the action remains nonzero
but reports an API/auth availability failure explicitly; that result is not
presented as evidence that a required runner is offline.

```yaml
runner-preflight:
  name: Unity runner preflight
  runs-on: ubuntu-latest
  steps:
    - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/check-unity-runner-availability@IMMUTABLE_COMMIT_SHA
      with:
        reader-app-id: ${{ secrets.BUILD_LOCK_READER_APP_ID }}
        reader-app-private-key: ${{ secrets.BUILD_LOCK_READER_APP_PRIVATE_KEY }}
        required-label-sets: '[["self-hosted","Linux","unity"]]'
```

The licensed job must depend on this preflight. An always-reporting required
aggregate job must fail if the preflight or licensed job fails, is cancelled,
or is unexpectedly skipped. Only explicitly modeled cases such as fork-secret
safety or a documented no-change path may accept a skipped licensed job.

For pull requests, reject a superseded run before expensive setup and pass the
same immutable event identity to acquire for periodic FIFO revalidation:

```yaml
- name: Require current PR head
  uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/require-current-pr-head@IMMUTABLE_COMMIT_SHA
  with:
    github-token: ${{ github.token }}
    pull-request-number: ${{ github.event.pull_request.number }}
    expected-head-sha: ${{ github.event.pull_request.head.sha }}
```

Licensed matrix jobs must also set `strategy.fail-fast: false`; GitHub's default
matrix fail-fast behavior can cancel a sibling while it holds a Unity license.

Validate local secret shape first, acquire immediately before the licensed Unity
section, guard every licensed step on the acquire output, and release with
`if: always()`:

```yaml
- name: Validate Unity license secrets
  uses: ./.github/actions/validate-unity-license

- name: Acquire organization Unity lock
  id: acquire-build-lock
  uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@COMPATIBILITY_COMMIT_SHA
  with:
    lock-name: wallstop-organization-builds
    holder-id-suffix: ${{ matrix.unity-version }}-${{ matrix.test-mode }}
    runner-id: ${{ runner.name }}
    github-token: ${{ github.token }}
    pull-request-number: ${{ github.event.pull_request.number }}
    expected-head-sha: ${{ github.event.pull_request.head.sha }}
    timeout-minutes: "180"
    require-resource-lifecycle: "true"
    # Consumers that wrap serial activation in bounded retry no longer need the
    # lock to hold a slot warm; keep this at or below the live releaseCooldownSeconds.
    minimum-release-cooldown-seconds: "0"
  env:
    BUILD_LOCK_APP_ID: ${{ secrets.BUILD_LOCK_APP_ID }}
    BUILD_LOCK_APP_PRIVATE_KEY: ${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}

- name: Run Unity Test Runner
  if: ${{ steps.acquire-build-lock.outputs.acquired == 'true' }}
  uses: game-ci/unity-test-runner@IMMUTABLE_GAMECI_COMMIT_SHA

- name: Return Unity license
  id: return-unity-license
  if: always() && steps.acquire-build-lock.outputs.acquired == 'true'
  uses: ./.github/actions/return-unity-license

- name: Release organization Unity lock
  if: always()
  uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/release-build-lock@COMPATIBILITY_COMMIT_SHA
  with:
    lock-name: wallstop-organization-builds
    holder-id-suffix: ${{ matrix.unity-version }}-${{ matrix.test-mode }}
    runner-id: ${{ runner.name }}
    resource-cleanup-status: ${{ steps.return-unity-license.outputs.resource-cleanup-status }}
    resource-health: ${{ steps.return-unity-license.outputs.resource-health }}
    resource-reason: ${{ steps.return-unity-license.outputs.resource-reason }}
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

The PR identity inputs close the race after the standalone current-head guard:
acquire revalidates periodically while queued, immediately before its admission
write, and again after verified admission but before returning control to Unity.
A superseded or unverifiable PR removes its own queued or just-admitted identity
and fails without running licensed work. Empty PR inputs on push and dispatch do
not perform PR API calls.

Replace `COMPATIBILITY_COMMIT_SHA` with the reviewed 40-character release commit;
mutable major tags are not permitted in protected consumers. The Unity return
helper must emit `resource-cleanup-status=confirmed` only for exact positive
return evidence. Exit zero or `Serial number unavailable` alone is insufficient.
Timeouts, truncated logs, termination, `400006`, `20113`, and missing positive
evidence report `unknown/healthy` with an allowlisted reason. Confirmed `20111`
reports `unknown/blocked` with `unity-account-limit-20111`.

The release action is intentionally safe to run even when acquire never reached
the front of the queue. It reports `cleanup-result=cooldown-started`,
`cleanup-result=quarantined`, `cleanup-result=queue-cleaned`, or
`cleanup-result=noop`. Under schema 5, `cleanup-result=global-quarantined`
identifies an active account incident. `cleanup-result=released` is also possible before schema 4
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

A schema-5 `account-blocked` admission is an intentional nonzero, fail-closed
result. The acquire action writes `acquired=false`, the exact `incident-id`, and
the typed health/reason outputs before failing, so `if: always()` diagnostics and
cleanup can inspect them; ordinary licensed steps must not run. If the caller
was queued or had just been admitted, acquire attempts to remove only that
caller's exact pre-activation state before it fails. A confirmed cleanup reports
`account-blocked`; an unconfirmed cleanup reports
`account-blocked-cleanup-failed`. In the latter case, do not recover the incident
or rerun until supported release, post-action, or fallback cleanup has removed
the caller from both holders and queue and a fresh lock-state read confirms it.
The error identifies the sanitized source run and recovery inputs. Operators
must reconcile every Unity Portal activation, then dispatch `Reap stale build
locks` with `operation=recover-incident`, the exact incident ID, and
`portal-cleanup-confirmed=true`. Never edit `lock-state` or recover an incident
without that external proof.

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

Schema 5 adds at most one immutable global account incident. It is active for
`wallstop-organization-builds` because the committed config enables
`accountHealth`. The one-way migration required schema-4 holders, queue entries,
cooldowns, and quarantines to be empty. A confirmed `20111` report blocks
admission immediately without growing the queue. Existing holders may finish
and clean up. Incidents never expire and cannot be recovered by same-runner
admission.

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
non-empty state. `releaseCooldownSeconds` is a config knob (integer 0-86400) for
how long a confirmed resource-safe release keeps its slot reserved before the next
job may take it. It historically absorbed the observed ~five-minute Unity
activation handoff by holding the slot warm. That handoff is now absorbed
instead by **consumer-side bounded activation retry** (see below). The committed
live value is read from
`locks/wallstop-organization-builds.config.json` and is transitional while
issue #60 tracks the immutable-release and consumer-repin sequence required for
literal zero. At `0`, a proven-clean release frees its slot immediately and
writes no reservation. Zero never weakens leak protection: unproven cleanup
still creates a non-expiring quarantine, and confirmed `20111` still raises the
global account incident.

**Consumer requirement:** because the lock no longer holds a slot warm, every
consumer's licensed Unity step MUST wrap serial activation in a bounded
retry-with-backoff that retries the transient `20111` "maximum number of
activations" contention and fails closed to the existing incident evidence only
when it persists past the budget. Do not lower `releaseCooldownSeconds` below a
consumer's `minimum-release-cooldown-seconds` until that consumer has adopted the
retry.

## Authentication

Set `BUILD_LOCK_APP_ID` and `BUILD_LOCK_APP_PRIVATE_KEY` together as
selected-repository organization secrets available to enrolled repositories.
The required steady-state installation restricts the writer App to this lock
repository. Tokens are minted for only `ambiguous-organization-build-lock` with
`contents: write`; caller owner ID/name, canonical repository ID/name, lock
repository, and lock name are validated before any credential parsing or
network access. Enrollment does not require a lock-action code change, but
App-key possession and organization-secret repository access remain the
authorization boundary. See the runbook for the known live scope gap.

The reaper additionally uses `BUILD_LOCK_READER_APP_ID` and
`BUILD_LOCK_READER_APP_PRIVATE_KEY`. The required steady-state installation
restricts that reader App to the reviewed consumer set. It has Actions read,
Contents read, Metadata read, and organization Self-hosted runners read. Each
use mints a token restricted to the operation and repositories: the reaper
requests Actions/Metadata, hosted runner preflights request runner inventory,
and the central policy audit requests Contents for exact registered commits.
Acquire and release never read cross-repository Actions state; an unreaped
holder remains authoritative and admission fails closed.

The code retains a compatibility fallback that can mint an Actions/Metadata
token from a legacy broad writer installation when reader credentials are
absent. Steady-state deployment must not rely on it: the writer App remains
lock-repository-only and missing reader credentials fail the scheduled reaper.
Operator `recover` and `recover-incident` operations do not inspect workflow
runs and therefore do not require reader credentials.

Legacy `BUILD_LOCK_TOKEN` authentication is rejected. Old pinned runs must drain
before the state-writer App key is rotated.

Consumers pin reviewed 40-character compatibility commits. Never run a
pre-semaphore client against the active two-holder state: although it sees the
mirrored first holder conservatively, its state write can drop additional
`holders` entries.

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

Under schema 4 and 5, stale holders are quarantined instead of freed. A queued job
on the same physical runner reclaims a quarantine first (return-at-start), which is
the strongest recovery because it actually returns the seat. Under **schema 5** (account health enabled) the scheduled reaper also
**auto-recovers a quarantine** once it confirms the owning run is terminal and the
reservation has aged past the lease: it converts the quarantine to a cooldown so
capacity is not pinned indefinitely (notably for quarantines tied to ephemeral
GitHub-hosted runners, which can never be same-runner-reclaimed). It is gated to
schema 5 on purpose — that is where the backstop lives: consumers wrap activation in
bounded retry, so a returned seat (the common, over-conservative case) frees the slot,
while a genuinely leaked seat trips a confirmed `20111` **global account incident**
that halts admission (operator-visible) instead of silently pinning capacity. That is
a deliberate trade of graceful degradation for a loud, actionable signal. The reaper
fails closed when the owning run status cannot be confirmed (the quarantine is kept)
and skips recovery while a global incident is already active.

Operators may still force recovery by dispatching the reaper with `operation=recover`,
the exact reservation ID, and `resource-safe=true` after confirming Unity portal
cleanup; like auto-recovery it starts a cooldown rather than freeing capacity outright.

For schema 5, dispatch `operation=recover-incident` with the exact incident ID
and `portal-cleanup-confirmed=true` only after the Unity portal inventory is
reconciled. Recovery clears the global incident into a normal cooldown; a wrong
ID or missing proof fails closed.

`stale-recovered` remains in the versioned output contract but is always false:
consumer acquire no longer replaces stale holders. The scheduled reaper is the
sole authority for cross-repository run observation and stale-state transitions.

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
