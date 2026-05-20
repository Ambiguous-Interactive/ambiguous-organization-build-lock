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

## Consumer Workflow Pattern

Validate local secret shape first, acquire immediately before the licensed Unity
section, and release with `if: always()`:

```yaml
- name: Validate Unity license secrets
  uses: ./.github/actions/validate-unity-license

- name: Acquire organization Unity lock
  uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@v1
  with:
    lock-name: wallstop-organization-builds
    holder-id-suffix: ${{ matrix.unity-version }}-${{ matrix.test-mode }}
    timeout-minutes: "180"
  env:
    BUILD_LOCK_TOKEN: ${{ secrets.ORG_BUILD_LOCK_TOKEN }}

- name: Run Unity Test Runner
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
