# Session 076: repin closed-PR decisions and stale-branch recovery

Date: 2026-09-07

## Objective and safety invariants

Advance PLAN.md toward a green PR. Merge latest origin/main. Address open
issues by impact. Keep main CI green.

Invariants: no fail-closed path weakened, no authorization change, no pin
change, no lock-state edit, no policy-list edit. Consumer adoption decisions
stay sovereign.

## Baseline

origin/main at `657a8c1a9` (#239). Working tree clean. Build lock CI green
(run 34168370706). The scheduled enrollment audit green (run 34168370804).
All session PRs through 075 merged. Draft PR #228 stays draft by plan.

## Open-issue triage

Open issues: #29, #44, #51, #53, #83, #113, #153, #229, #231. The 2026-09-06
and 2026-09-07 triage records keep #29, #44, #51, #53, #83, #153, #229, and
#231 blocked on hardware, portal evidence, or organization-owner authority.
PR #228 stays draft until a native macOS canary runs. No issue closes this
session; the most impacting actionable work is the PLAN.md "next observable
step": the scheduled repin run's handling of stale repin branches and closed
pull requests.

## Failure RCA: the next repin run fails on unity-helpers

`Repin consumer lock references` runs daily at 06:37 UTC. The first run
(2026-09-07 07:02 UTC, run 34093552546) pushed `automation/repin-lock-64bac44`
and opened PRs in DoxReloaded (#801), IshoBoy (#855), and unity-helpers
(#738). unity-helpers closed #738 during the #233 incident. Observed state:

- unity-helpers still has branch `automation/repin-lock-64bac44` at
  `b6a41d6b`, no open repin PR, and stale pins.
- DoxReloaded and IshoBoy have open repin PRs on the same branch name.

`repin_consumer` cloned the default branch, created a divergent repin commit
on the same branch name, and ran a plain `git push`. Verified locally with a
real bare repository: the push is rejected (`fetch first`,
non-fast-forward) whenever the remote branch exists, because the new commit's
parent is the current default head and not the old branch tip. The script
turns any push failure into `::error::` plus a red run. So the next scheduled
run would fail on unity-helpers, and every later run while the state holds.

Root cause: the automation modeled only two branch states (open PR, no
branch). A closed PR with a surviving branch was unhandled.

## Change: three-state branch handling, consumer decisions respected

`tools/workflows/repin-consumer-locks.sh`:

- A closed repin pull request for the repin branch is the consumer's
  adoption answer. The automation skips the repository, prints a note, and
  records a summary row. It never re-offers the same repin and never updates
  that branch. A new release opens a new branch name and a fresh offer.
- A remote repin branch with no open and no closed pull request is a
  partially failed run (push succeeded, `pr create` failed). The script
  fetches the branch tip and reuses it only when its tree equals the tree of
  the local repin commit. It then opens the pull request without a push.
  A branch with different content is left untouched with a summary row.
  The automation still never force-pushes and never deletes a branch.
- The pull request body and create call moved into `open_repin_pull_request`
  with explicit arguments, so the fresh-push path and the recovery path
  cannot drift.
- Fix found by the new tests: the run summary printed `1 lines`. The word is
  now singular for one changed line.

Red-green: three new tests fail against the previous script with the exact
production rejection (`! [rejected] ... (fetch first)`), and pass with the
fix. Two more tests lock the fresh-push and open-PR paths.

## Tests

`test/workflow-scripts.test.js` gains the first end-to-end coverage of the
`repin-consumers` operation. The harness uses real Git: local bare
repositories stand in for the consumers, and `GIT_CONFIG_GLOBAL`
`url.insteadOf` rewrites the production `https://github.com/` push, fetch,
and ls-remote URLs to them. Real push rejection semantics are therefore
exercised, not simulated. `gh` is shimmed for clone and PR list/create with
state files. `resolve_repin_target` resolves against a local tag, so the
policy fixture needs no network.

Five scenarios: closed PR skips and stays green while a fresh consumer in
the same run still repins; an orphaned branch with identical content is
reused without a push; a stale branch with different content is left
untouched; a fresh consumer pushes and opens the PR with the new pin; an
open PR is never duplicated and the branch is untouched.

## Sweep for the same class

Fixed branch name plus a plain push is shared only by this script.
`onboard-unity-repository.sh` uses a run-scoped branch name
(`automation/unity-enrollment-<run_id>-<run_attempt>`), so a collision is
not reachable. `auto-release.sh` and `open-release-authorization-pr.sh`
force-push reused refs by reviewed design. No other instance exists.

## Documentation

- `docs/operations-runbook.md`: the idempotency paragraph records the
  closed-PR skip, the identical-branch reuse, and the never-force-update
  rule.
- `docs/consumer-enrollment.md`: the repin paragraph records that closing a
  repin pull request is the adoption decision and that the branch is left
  untouched.

## Issue work

- #113: the M3 repin arm is hardened; the consumer merge decisions remain
  the gating work and stay external.
- #83, #153, #229, #231, #29, #44, #51, #53: unchanged, still blocked per
  the recorded triage.

## Validation

Observed on the session branch:

- `node tools/llm-harness.mjs check`: pass.
- `node --test test/*.test.js`: 850 tests, 847 pass, 0 fail, 3 skipped (the
  pre-existing conditional skips).
- `go test ./...` and `go test -race ./...`: pass. `go vet ./...`: clean.
- `gofmt -l .`: empty.
- `golangci-lint run --timeout=5m`: 0 issues.
- `go mod verify`, `go -C tools/actionlint mod verify`, and both
  `mod tidy -diff` checks: pass.
- `bash tools/workflows/ci.sh javascript`: pass.
- `bash tools/workflows/ci.sh shellcheck`: pass. Direct shellcheck on the
  changed script reports only the pre-existing SC2016 info on the reviewed
  credential-helper pattern, now in three mirrored calls.
- `go run ./cmd/workflow-credential-audit .`: policy passed.

## Adversarial review disposition

- Does the closed-PR skip hide drift? No. The audit keeps reporting the
  repository's findings, and every run records the skip in the summary and
  the log.
- Can the recovery path open a PR with wrong content? Only when the remote
  branch tree byte-equals the intended rewrite of the current default
  branch. The PR diff then shows exactly the pin changes, and the consumer
  still reviews and merges it.
- Can the recovery path race? The only branch writer is this workflow, and
  its concurrency group serializes runs with `cancel-in-progress: false`.
- Is a tolerated skip a false success? No. `repin_consumer` exits 0 only for
  classified states; clone, rewrite, commit, ls-remote, fetch, push, and
  create failures still exit 1 and keep the run red.
- Are credentials exposed? The ls-remote and fetch calls mirror the reviewed
  push credential-helper pattern exactly; the credential audit passes.
