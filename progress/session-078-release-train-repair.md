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
  never re-offered.
- A closed-without-merge authorization pull request is a declined release
  and is never re-offered, the same rule the repin automation follows.
  A merged authorization never reaches this path because the policy then
  lists the SHA.
- The pull request is now created with a writer App installation token
  scoped to this repository (`actions/create-github-app-token`, the same
  pinned action and App secrets the repin workflow uses). App-created pull
  requests are not subject to the blocked GITHUB_TOKEN setting. If creation
  fails, the script re-checks for an open pull request on the branch
  (creation can fail after a server-side success) and deletes the pushed
  branch only when nothing uses it. A deletion failure is reported, never
  silent.
- New `report-nonconventional-commits.sh`, wired into the workflow when no
  release was published: it lists commits since the newest reachable semver
  tag whose subjects are not conventional in the run summary, with a
  warning. It never fails the run: a missing summary variable or a missing
  tag degrades to a warning and exit 0.
- Deleted the stray `release-authorization/v1.12.1` branch from the remote.

## Red-green evidence

New behavioral tests in `test/workflow-scripts.test.js` run the real script
against a local bare remote with release tags. The `gh` shim executes the
script's own `--jq` program with real `jq` against a raw releases payload,
so the production filter, semver sort, and newest-only selection all run.

Discrimination proof: the pre-fix script (origin/main version) under this
same harness resurrected v1.12.1 and pushed
`release-authorization/v1.12.1` at 6520f75 in the fixture, exit 0. The
fixed script exits 0 with "Every published release is already authorized."
and pushes nothing. An earlier shim draft answered the API with a
pre-filtered one-line list; it let the old loop pass too, so it was
replaced before merge. The review caught it; the record here states the
final, verified behavior.

Covered paths:

- Superseded release never re-offered (draft and prerelease noise filtered,
  shuffled payload order).
- Newest unauthorized release offered once, with the pushed policy content
  checked.
- Unexaminable newest tag fails closed with a non-zero exit.
- A declined release (closed-without-merge pull request) is not re-offered.
- A failed pull request creation removes the branch.
- An empty release list reports and offers nothing.
- Diagnostic drift reporting, silence, and the two degraded paths.

Contract tests updated: `auto-release-workflow.test.js` pins the mint step,
`RELEASE_AUTHORIZATION`, newest-only discovery (no `unexamined_tags` loop),
and the delete-on-failure path. `workflow-policy.test.js` pins the new
script in the Auto release step signatures.

## Validation

- `node --test test/*.test.js`: 877 tests, 871 pass, 6 skipped (macOS-only),
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

## Second failure class, found by the live proof (post-merge)

With PR #245 merged (c4f1a7e36), the dispatched Auto release run
34191956733 published release v1.14.1 and its tag, then failed in the
semantic-release success stage: `Could not resolve to an issue or pull
request with the number of 738`. The release range bodies (squash-merge
descriptions of #242 and #243) legitimately reference consumer-repository
issues (`unity-helpers #738`, `DoxReloaded #801`). The
`@semantic-release/github` success step resolves every `#N` reference
against THIS repository, so a foreign number hard-fails the run, and a
colliding local number would receive a false "included in version" notice.

No release-tag alias update happened (v1 still names v1.14.0), and the
authorization step was skipped. The v1.14.1 release itself is intact.

## Disposition

- `.releaserc.json` sets `successComment: false` for
  `@semantic-release/github`. `releasedLabels` was already false, so the
  success step is now a no-op: foreign references cannot fail a release and
  no issue receives an automated linkage notice. Release linkage stays
  visible through the tag and the release notes.
- The contract test now pins `successComment: false` and records why.
- The next release (v1.14.2, from this fix commit) supersedes v1.14.1, so
  discovery correctly offers only v1.14.2 for authorization.

## Outcomes after the merges

- PR #245 squash-merged to main as c4f1a7e36, with the conventional
  subject preserved. PR #246 squash-merged as d79e1cc2a after one Bugbot
  finding was answered and its thread resolved: the pinned plugin source
  (semantic-release/github v12.0.9, lib/success.js) shows the whole
  comment block is skipped before any issue lookup when
  `successCommentCondition` is false, so the reported failure mode
  cannot happen. The commit moved to the option the plugin recommends.
- v1.14.1 remains unauthorized by design. It was published minutes
  before v1.14.2 superseded it, and discovery offers only the newest
  release. Consumers pinning v1.14.1 would be flagged
  `unapproved-lock-ref`, which is the fail-closed behavior wanted.
- Live proof, Auto release run 34193801123: every step green.
  v1.14.2 published (d79e1cc2a), the `v1` alias updated, the writer App
  token minted, and authorization pull request #247 opened by
  `app/ambiguous-build-lock-automation` while the repository setting
  that blocks GITHUB_TOKEN pull requests stayed off.
- PR #247 diff reviewed: it adds only d79e1cc2a to `approvedLockShas`
  and `approvedReturnShas`. `approvedDarwinReturnShas` stays empty.
- Issue #244 closed (auto-closed by the merge, evidence comment added).
  Status comments posted on #231 and #229: the release exists, the
  authorization pull request is open, and both stay gated on the
  native macOS canary evidence and a human merge.

The session ends with the authorization merge itself deliberately
unmade: that decision belongs to a reviewer with the #229 canary
evidence in hand.
