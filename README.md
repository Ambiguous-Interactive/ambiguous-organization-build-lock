# Ambiguous Organization Build Lock

This repository provides a central organization-level lock for licensed Unity
build sections. GitHub Actions `concurrency` is repository-scoped, so repos
that share one Unity Pro seat must use this lock before invoking Unity.

## Required Secret

Create an organization or repository secret named `ORG_BUILD_LOCK_TOKEN` in each
consumer repository.

Minimum token access:

- `contents: read/write` on `Ambiguous-Interactive/ambiguous-organization-build-lock`
- `actions: read` on repositories whose workflow runs should be checked for
  stale-holder recovery

Missing `actions: read` is treated as a configuration error. The lock actions
only fall back to lease-based recovery when a workflow run cannot be found; they
do not hide permission failures as unknown status.

Do not use a broad personal token unless no narrower GitHub App or fine-grained
token is available.

## Publish This Repository

Before consumer workflows can use the actions here:

1. Create `Ambiguous-Interactive/ambiguous-organization-build-lock`.
2. Push this folder's contents to that repository.
3. Create and push a `v1` tag.
4. If the repository is private, enable private action access for the consumer
   repositories that call these actions.

The included `Build lock CI` workflow checks the action JavaScript syntax on
pull requests and pushes to `main`.

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
    timeout-minutes: "180"
  env:
    BUILD_LOCK_TOKEN: ${{ secrets.ORG_BUILD_LOCK_TOKEN }}

- name: Run Unity Test Runner
  if: ${{ steps.acquire-build-lock.outputs.acquired == 'true' }}
  uses: game-ci/unity-test-runner@v4

- name: Release organization Unity lock
  if: always()
  uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/release-build-lock@v1
  with:
    lock-name: wallstop-organization-builds
    holder-id-suffix: ${{ matrix.unity-version }}-${{ matrix.test-mode }}
  env:
    BUILD_LOCK_TOKEN: ${{ secrets.ORG_BUILD_LOCK_TOKEN }}
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

State never stores tokens or environment dumps. It stores only run identity,
holder timing, queue entries, and public run URLs.

Holder identity intentionally excludes `GITHUB_RUN_ATTEMPT`; reruns of the same
workflow run can therefore release a lock left by the previous attempt instead
of queueing behind themselves.

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
