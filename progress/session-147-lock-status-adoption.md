# Session 147: adopt the read-only lock status in a consumer

Date: 2026-11-18

Issues: #390.

Pull requests: this repository's record pull request,
Ambiguous-Interactive/DoxReloaded#1279.

## Objective and safety invariants

Carry the GOAL.md directive: rank the open issues by impact with the least
Unity CI churn, complete the highest-priority safe work, and drive it green.

Safety invariants:

- The status call mints no credential and changes no lock state.
- No licensed job gains, loses, or reorders a step.
- The status job is not a required check and does not gate the merge.
- A refused or anonymous Actions read leaves a fact `unproven`; it never fails
  the report and never fakes a healthy value.

## Baseline

- `main` at `e6d8407b74`, no open pull request, `main` green.
- Local audit of all seven default-branch snapshots:

  ```text
  Audited 7/7 enrolled repositories; active-jobs=139 findings=8 complete=true
  ```

- The 8 rows are `expired-policy-exception` in `unity-builder` and
  `unity-helpers`. They expired on 2026-10-31 and need an owner re-review.
- Dependency check: `go list -m -u all` reports no update for the root module.
  `go -C tools/actionlint list -m -u all` offers only `goldmark` and `x/net`,
  which the linter does not import, and `go.yaml.in/yaml/v4 v4.0.0`, which
  actionlint `v1.7.12` cannot build against. `v1.7.12` is still the newest
  release, so #335 stays blocked upstream.

## Open-issue priority

| Order | Issue | Impact | Unity CI churn |
| --- | --- | --- | --- |
| 1 | #390 status adoption | The last central half is done. No consumer calls it, so a denied acquire still hides the shared cause. | None. One hosted job after a failure. |
| 2 | #113 enrollment drift | 8 audit rows, all of them expired exceptions. | One matrix leg per consumer fix. |
| 3 | #379 merge queue | A queue entry would run the licensed job. | High: every queue entry runs Unity. Needs the queue policy decision. |
| 4 | #335 actionlint YAML | Dependency freshness only. Blocked upstream. | None. |
| 5 | #29, #51, #53, #83, #153, #229, #231, #249, #277, #278, #334 | Each needs owner authority, a portal fact, or published evidence. | Unknown until the evidence exists. |

Selected: #390. It is the only open issue with a complete, safe change and no
licensed-job edit. #113 needs an owner policy decision, and #379 needs the
queue decision before any workflow edit is safe.

## Change

DoxReloaded#1279, merged at `7374e7f9`: all checks passed, including Static
Validation, Unity Tests and Player Builds, and `CI Success`. OpenAI review
reported 0 findings. CodeRabbit was rate limited and reviewed nothing.

- `build-deploy.yml` gains `report-build-lock`: `needs: unity-tests`,
  `if: failure() && !cancelled()`, `continue-on-error: true`, one step that
  calls central `reap-stale-locks` at `720ef47f9ab352fbc9403363ca63ae8c487a2442`
  (v1.18.1) with `operation: status`.
- `lock-action-pins.json` approves the `reap-stale-locks` pin, because the
  consumer validator refuses a central action that the pin file does not name.

The job sits beside `bee-cache-report`, the existing hosted reporter that reads
a finished licensed job. The licensed job shape does not change.

## Evidence

Red-green on the consumer validator:

```text
red:   reap-stale-locks: workflow refs ['720ef47f...'] do not match approved pin None
green: exit 0
```

Consumer checks on the changed tree:

- `python3 .github/scripts/validate-organization-build-lock-policy.py`: pass.
- `python3 scripts/verify-merge-queue-workflow.py`: pass.
- `python3 scripts/check.py`: 7 pass, 3 fail. The same 3 fail on the untouched
  `main` at `d2decff8`, with the same macOS `mypy` errors in
  `run-controlled-performance.py`. The change adds no failure.

Central audit over the merged DoxReloaded snapshot, before and after:

```text
before (d2decff8): Audited 7/7 enrolled repositories; active-jobs=139 findings=8 complete=true
after  (7374e7f9): Audited 7/7 enrolled repositories; active-jobs=140 findings=8 complete=true
findings equal: True
added rows: [(DoxReloaded, .github/workflows/build-deploy.yml, report-build-lock)] -> non-licensing-static
```

The audit adds one inventory row and no finding. The finding set is identical,
so the 8 expired exceptions stay the only open rows.

Merge queue: the queue is already enabled on DoxReloaded. The pull request
merged through it, and entry run 44464566208 (`merge_group`, success) ran the
unlicensed gates only. `build-deploy.yml` does not listen for `merge_group`, so
the queue merges a tree that Unity never tested. That gap is now recorded on
#379 with the required-context conflict that any fix must resolve.

## Review findings and dispositions

- The status job could colour a pull request that already has a licensed
  failure. Disposition: `continue-on-error: true`, and `ci-success` does not
  need the job, so it is not a required check.
- A cancelled run could report a stale denial. Disposition: `!cancelled()`
  excludes it; the cancel signal already released the lock.
- The pull request body claimed the audit adds no inventory row. That claim
  came from a snapshot that did not hold the new file. Disposition: measured
  again at both commits, and the correction is in a pull-request comment. The
  row is `non-licensing-static` and the finding set does not change.
- CodeRabbit was rate limited and reviewed nothing. OpenAI review reported 0
  findings. Every check passed, so no change followed.

## Out of scope

- The eight expired `unity-builder` and `unity-helpers` policy exceptions still
  need an owner re-review.
- #379 still needs the merge-queue decision. A licensed `merge_group` run is a
  new paid path, so this session does not add it.
- #335 still needs an actionlint release that supports the YAML v4 API.
