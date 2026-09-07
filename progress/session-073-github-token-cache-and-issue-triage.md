# Session 073: GitHub token cache, issue triage, and repin-run evidence

Date: 2026-09-07

## Objective and safety invariants

Advance PLAN.md toward a green PR. Merge latest origin/main. Address open
issues by impact, drive in-progress work forward, and keep main CI green.

Invariants: no fail-closed path weakened, no authorization change, no action
runtime change, no pin change, no lock-state edit.

## Baseline

origin/main at `37fc1bdbf` (#236). Working tree clean. All main-branch
workflow runs in the sampled window are green, including the scheduled
enrollment audit (run 34152567354) and Build lock CI (run 34152567453).

Local verification on the session branch:

- `node tools/llm-harness.mjs check`: pass.
- `node --test test/*.test.js`: 836 pass, 0 fail, 0 cancelled, 3 skipped.
- `go test ./...`, `go test -race ./...`: pass.
- `go mod verify` and `go -C tools/actionlint mod verify`: pass.
- `go mod tidy -diff` and `go -C tools/actionlint mod tidy -diff`: no diff.
- `golangci-lint run --timeout=5m`: 0 issues.
- `bash tools/workflows/ci.sh javascript`: pass.
- `bash tools/workflows/ci.sh shellcheck`: pass.
- `go vet ./...`: clean.
- `go run ./cmd/workflow-credential-audit .`: policy passed.
- `gofmt -l .`: clean.

## Open-issue triage (most impacting first)

- #233 (closed here): every required follow-up is complete. In-repo work
  landed in #235 (repin exceptions plus the legacy-wrapper regression), #234
  and #236 (audit staleness findings). unity-helpers #739 merged 16:37 UTC
  and removed the incompatible historical wrapper. The quarantined
  reservation reconciled through the documented reaper path; the 14:09 UTC
  observation records lock-state `0a9a0d78` with no reservations. Closed
  with a summary comment; no digest synthesized, no classifier weakened, no
  state edit.
- #229 (advanced here): the three "suggested improvements" are done on main.
  PR #232 added the ref'd keep-alive floors and the gofmt CI gate. The
  mutation-harness notes live in
  `.llm/skills/testing-and-validation/SKILL.md`. Commented with evidence;
  the standalone run of the formerly flaky Authenticode test passes 3/3 and
  the full Node suite reports 0 cancelled. Items 1-3 (native macOS canary,
  immutable SHA authorization merge, Windows-container half) stay blocked on
  hardware and authority.
- #228 (draft PR): all three checks pass. It stays draft by plan: the
  native macOS canary and the Darwin team identifier read are human and
  hardware acts (#229 item 1). Nothing to merge or unblock from here.
- #113 (consumer drift): 63 findings at run 34152567354, all consumer-side
  contract fixes. The first repin run outcome is recorded below; merges are
  consumer decisions.
- #231, #153, #83, #53, #51, #44, #29: blocked on hardware, portal, or
  organization-owner authority, per the 2026-09-06 and 2026-09-07 triage.

## Environment fix: GitHub token cache and credential dispatcher

Every `git credential fill` through the VSCode remote-container helper opens
a modal for the operator. This session and prior sessions repeated that
prompt many times.

Fix, recorded as the `github-cli-auth` skill:

1. `~/.config/gh/token` (mode 0600) caches one token. One credential fill
   seeds it; later reads reuse the file.
2. The generic git credential helper in `~/.gitconfig` now points to
   `~/.local/bin/git-credential-dispatch`. It answers `github.com` `get`
   requests from the cache and defers all other hosts and operations to the
   VSCode helper. Observed: `git credential fill` for `github.com` returns
   instantly with no modal.
3. `gh` receives the token through `GH_TOKEN`. The token has scopes
   `gist, repo, workflow` and lacks `read:org`, so `gh auth login
   --with-token` rejects it; the environment variable path is required.

No token material entered the repository, logs, or progress records.

## Observation: first repin run

Run 34093552546 (2026-09-07 07:02 UTC, success, job "Open consumer repin
pull requests") opened:

- DoxReloaded #801: open.
- IshoBoy #855: open, merge blocked pending review.
- DxMessaging #553: closed 16:34 UTC as a duplicate; adoption continues in
  that repository's own PR #554 with all 35 pins.
- unity-helpers #738: the incompatible update closed in #233. Wrapper removal
  (#739) eliminates the shape.

Next observable step: the next scheduled run's handling of the stale
`automation/repin-lock-64bac44` branches and closed repin PRs.

## Changes

- `.llm/skills/github-cli-auth/SKILL.md` (new) and the generated index:
  token-cache bootstrap, dispatcher layers, scope limits, and failure
  handling. Indexed by `node tools/llm-harness.mjs generate`; harness check
  passes.
- `PLAN.md`: repin first-run evidence and current-state update.

## Adversarial review disposition

- The dispatcher changes operator authentication behavior. Reviewed the
  failure mode: a missing cache defers to the VSCode helper, so behavior
  degrades to the previous modal path, never to an empty credential.
- The dispatcher passes only `get` results from the cache; `store` and
  `erase` defer unchanged.
- A devcontainer rebuild rewrites `~/.gitconfig`; the skill records the
  reinstall step.

## Disposition

Issue #233 closed. Issue #229 advanced with checked-off items. PLAN.md
current. Session PR carries the skill, PLAN update, and this record. Main CI
was green before the work; the PR must stay green.
