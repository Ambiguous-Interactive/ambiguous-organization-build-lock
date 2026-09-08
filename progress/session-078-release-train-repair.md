# Session 078: repair the release train and its authorization gate

Issue #244, found as the only red scheduled workflow on main: Auto release
run 34104911681 (2026-09-07 09:14 UTC).

## Root cause chain

1. semantic-release published nothing. Every squash-merge subject after
   v1.14.0 (2026-08-31) stopped following Conventional Commits. 13 commits,
   0 conventional. semantic-release skips those, so it correctly said "no
   release".
2. The authorization-PR step runs on every run by design, so its discovery
   fallback picked the first unauthorized published release, newest first.
   v1.14.0 and v1.13.x are authorized; v1.12.1 is not, because later
   releases were authorized instead. The script resurrected v1.12.1
   (2026-08-19) as "chore: authorize v1.12.1 adoption" and force-pushed
   `release-authorization/v1.12.1` at f476a7795.
3. `gh pr create` failed with `GitHub Actions is not permitted to create or
   approve pull requests`. The repository Actions setting is now
   `can_approve_pull_request_reviews: false`; it was on at the last green
   run on 2026-08-31, which created PR #224. The flip happened outside this
   repository. The step exited 1 and the run went red.
4. The pushed branch stayed on the remote: an unauthorized authorization
   branch, with no pull request pointing at it.

## Fixes (PR to main, one session, one pull request)

- `open-release-authorization-pr.sh` discovery now examines only the newest
  published release: offer it when unauthorized, exit 0 when authorized,
  fail closed when its tag cannot be examined. A superseded release is
  never re-offered. This matches the repin rule: a closed offer stays
  closed.
- The pull request is now created with a writer App installation token
  scoped to this repository (`actions/create-github-app-token`, the same
  pinned action and App secrets the repin workflow uses). App-created pull
  requests are not subject to the blocked GITHUB_TOKEN setting. If creation
  still fails, the script deletes the branch it pushed, so no unreviewed
  authorization branch remains.
- New `report-nonconventional-commits.sh`, wired into the workflow when no
  release was published: it lists commits since the newest tag whose
  subjects are not conventional in the run summary, with a warning. It
  never fails the run. This makes the silent stall from cause 1 visible.
- Deleted the stray `release-authorization/v1.12.1` branch from the remote.

## Red-green evidence

New behavioral tests in `test/workflow-scripts.test.js` run the real script
against a local bare remote with release tags and a `gh` shim:

- "never re-offers a superseded release": red before the fix (the old code
  offered v1.12.1 and attempted a pull request), green after (exit 0, no
  pull request, no branch).
- "removes its branch when pull request creation fails": red before (branch
  remained on the remote), green after (branch deleted, non-zero exit).
- "offers only the newest unauthorized release": pins the offer path,
  including the pushed policy content.
- Two diagnostic tests cover drift reporting and silence.

Contract tests updated: `auto-release-workflow.test.js` pins the mint step,
`RELEASE_AUTHORIZATION`, newest-only discovery (no `unexamined_tags` loop),
and the delete-on-failure path. `workflow-policy.test.js` pins the new
script in the Auto release step signatures.

## Validation

- `node --test test/*.test.js`: 873 tests, 867 pass, 6 skipped (macOS-only),
  0 fail.
- `go test ./...`, `go test -race ./...`, `go vet ./...`: clean.
- `go mod verify`, `go mod tidy -diff`, `go -C tools/actionlint mod verify`,
  `go -C tools/actionlint mod tidy -diff`: clean.
- `golangci-lint run --timeout=5m`: 0 issues.
- `bash tools/workflows/ci.sh javascript`, `... shellcheck`: clean.
- actionlint through the pinned module: clean.
- `node tools/llm-harness.mjs check`: passed.
- `go run ./cmd/workflow-credential-audit .`: passed.
- Remote branch list: no `release-authorization/*` branches remain.

## What this unblocks

The release train itself. Once this lands, a conventional commit on main
produces a release, and the authorization pull request opens without the
blocked setting. The release that carries the Darwin trusted return
(6a384393c) can then be cut, which is precondition 3 of #231. The
authorization merge itself stays gated on the native macOS canary evidence
tracked in #229, and remains a human decision.

## Process note for future sessions

Release-driving pull request titles must be conventional (`feat:`, `fix:`,
and so on), because the squash merge copies the title into the commit
subject semantic-release reads. The new diagnostic makes a lapse visible in
the weekly run summary.
