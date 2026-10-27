# Session 132: actionlint indirect dependency updates

Date: 2026-10-27

Issues: #335 (YAML move stays blocked), dependency sweep across all open issues.

## Objective and safety invariants

Carry forward the GOAL.md dependency directive. Update every available
dependency to the newest version its consumer already accepts, without
changing the fail-closed lock behavior or the pinned linter.

Safety invariants: the actionlint module stays pinned at v1.7.12; the
`go.yaml.in/yaml/v4` module stays at rc.3 inside the tool module and rc.6 in
the root module; no workflow or policy behavior changes.

## Baseline

Observed facts:

- `main` at `9ba38e044` was clean and in sync with `origin/main`.
- 14 open issues, no open PRs, all scheduled monitors green.
- The worktree carried uncommitted `tools/actionlint/go.mod`/`go.sum` edits
  from an earlier session: doublestar 4.10.2 -> 4.10.4, go-colorable
  0.1.15 -> 0.1.16, go-runewidth 0.0.30 -> 0.0.31, x/sync 0.23.0 -> 0.24.0,
  x/sys 0.48.0 -> 0.49.0. All are indirect deps of actionlint v1.7.12.
- Root module `go list -m -u all` showed no newer version than
  `go.yaml.in/yaml/v4 v4.0.0-rc.6`, so the root module is already current.
- Issue #335 remains blocked: actionlint v1.7.12 (2026-03-30) still pins
  YAML rc.3, so the tool module cannot move to the rc.6 API.

## Change

PR #358 commits the five indirect bumps on `tools/actionlint`. The pins,
the workflow, and all policy code stay unchanged. This unblocks the
`/tools/actionlint` gomod Dependabot config and clears the drift from the
worktree.

## Validation

- `go -C tools/actionlint mod verify`: all modules verified.
- `go -C tools/actionlint mod tidy -diff`: no diff.
- `go -C tools/actionlint run -mod=readonly github.com/rhysd/actionlint/cmd/actionlint -color`: passes on all workflows.
- Full local CI equivalent `.devcontainer/scripts/verify.sh`: exit 0.
- PR CI: all three `Build lock CI` jobs pass; Cursor Bugbot passes.
- Post-merge `main` CI run 40425694969 started green.

## Issue recheck

- #334: scheduled reaper delivery audit, reap stale build locks, and
  incident recovery audit all ran on hosted runners and succeeded at
  23:39-00:14 UTC. The 2026-10-05 acquisition failure was the documented
  GitHub Actions outage; the independent-delivery-signal follow-up stays
  open as its own item.
- #113 and #255: the open findings live in consumer repos or rulesets
  (unity-helpers structural fixes, required-check source binding). Both
  need consumer merges or ruleset authority, so they stay blocked per
  `PLAN.md`.

## Continuous improvement

No durable LLM resource promoted: the pin rationale is already recorded in
issue #335 and `PLAN.md` lists the blocker.

## Disposition

PR #358 merged at `25ad987b70`. The dependency sweep is complete for the
versions the current pins allow. All other open issues need owner decisions,
consumer merges, or more evidence collection, per `PLAN.md`.
