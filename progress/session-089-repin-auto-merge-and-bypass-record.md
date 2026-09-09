# Session 089: repin auto-merge and the reviewed bypass record

## Task

Advance PLAN.md with the two operator decisions waiting on open issues:

- Issue 266: enable auto-merge on repin offers (option 2), reversing the
  2026-09-07 directive that the automation never merges.
- Issue 255: disposition of the DxMessaging ruleset 17663217 Integration
  actor 3977200 bypass, which the consumer attested and the audit kept
  flagging as `unexpected-bypass-actor (attested)`.

Safety invariants: unchanged. The repin target still resolves only to
authorized allowlisted releases; the enrollment gate still fails closed on
an unauthorized pin; acceptance of a bypass actor is a reviewed,
mode-scoped record, not a pass for any actor.

Also recorded: the v1.14.2 adoption cohort completed (offers #751, #877,
#382 and DxMessaging #568 merged 2026-09-09), so PLAN.md no longer lists
them as open.

## Evidence before the change

- `main == origin/main` at ee033ac77; latest scheduled runs green; no open
  or draft pull requests in this repository.
- Live merge-policy audit state (run 34391709571 reported on #255): two
  findings, the DxMessaging attested bypass and the unity-helpers merge
  gate. Both were decisions: operator (accept into expectations) or
  consumer (merge unity-helpers #749).
- Live API probe on this repository: `enablePullRequestAutoMerge` without
  a merge method defaults to merge commits. This repository disallows
  merge commits, so an omitted method would have failed here and in any
  squash-only consumer. The mutation with an explicit
  `PullRequestMergeMethod!` variable is schema-valid.
- Operator decisions taken this session: #266 option 2, and accept the
  DxMessaging actor into expectations.

## Change

`tools/workflows/repin-consumer-locks.sh`, `enable_repin_auto_merge`:

- Reads the offer identity and the repository's three allowed merge
  methods in one GraphQL query, then prefers `SQUASH`, then `MERGE`, then
  `REBASE`; each offer is one reviewed commit.
- Sends `enablePullRequestAutoMerge` with that method once, immediately
  after `gh pr create`. Both open paths (fresh push and identical-branch
  recovery) share `open_repin_pull_request`, so both request auto-merge.
- A later consumer disable is never undone: an already-open offer is never
  re-requested on later runs.
- Every failure is best-effort and visible: the offer stays open for a
  manual merge, the run stays green, a `::warning::` names the gap, and
  the step summary records one row. A repository opts out by turning off
  its `Allow auto-merge` setting.
- The offer body states the auto-merge behavior and the opt-out.

`internal/mergepolicy`:

- `BypassActor` gains a reviewed `mode` (`always`, `pull_request`, or an
  omitted default of `always`), validated by the shared bypass-mode
  validator. `allowedBypass` matches the reviewed mode exactly, so a
  changed live grant still reports as drift. This lands the session 081
  follow-up that asked for a mode-aware schema once a first reviewed actor
  existed.
- `merge-policy-expectations.json` records the DxMessaging Integration
  actor 3977200 with mode `always`.

Docs: `docs/consumer-enrollment.md` states the auto-merge contract, the
opt-out, and the mode-aware acceptance record. `docs/operations-runbook.md`
states the one-time request, the refused-request behavior, and the opt-out.

## Tests

- `internal/mergepolicy/expectations_test.go`: the reviewed fixture gains
  an explicit mode; an invalid mode is rejected.
- `internal/mergepolicy/audit_test.go`: a data-driven mode matrix proves
  reviewed default/always/pull_request acceptance against observed
  default/always/pull_request grants; mode mismatches report.
- `test/workflow-scripts.test.js`: the end-to-end harness gains a GraphQL
  shim (identity read plus mutation, with failure and no-merge-method
  fixtures). New cases: both open paths request auto-merge exactly once;
  a refused request keeps the run green with the summary row; no allowed
  merge method sends no mutation; an already-open offer is never
  re-requested.
- `test/workflow-policy.test.js`: the repin contract test now locks the
  auto-merge path (`enablePullRequestAutoMerge` present, direct merge
  commands absent, failure text present).

## Verification

- `node --test test/*.test.js`: 888 pass, 0 fail, 6 skipped
  (architecture-gated).
- `go test ./...`, `go test -race` (mergepolicy), `go vet ./...`: pass.
- `go mod verify`, `go mod tidy -diff` (both modules): clean.
- `golangci-lint run --timeout=5m`: 0 issues.
- `bash tools/workflows/ci.sh javascript`, `ci.sh shellcheck`: clean.
- `node tools/llm-harness.mjs check`: pass.
- `go run ./cmd/workflow-credential-audit .`: pass.
- Live: `audit-merge-policy` over all six enrolled consumers reports 1
  finding (`unity-helpers` `missing-required-context`, behind open
  consumer PR #749); the DxMessaging bypass finding is gone.
- Live: the identity-plus-methods query returns `PR_...` + `SQUASH` for
  this repository, and the mutation schema is proven with an explicit
  method variable.

## Dispositions and follow-ups

- Auto-merge failures deliberately keep the run green: the offer remains
  fully functional, and every failure lands in the step summary. A red run
  would punish a consumer configuration choice with no central remedy.
- Closing #266 with the implemented decision; #255 and #113 now close
  automatically on the first complete clean audit after unity-helpers
  #749 merges.
- The next scheduled repin run is the live proof of the auto-merge path;
  no offer exists today, so the first post-merge release exercises it.
