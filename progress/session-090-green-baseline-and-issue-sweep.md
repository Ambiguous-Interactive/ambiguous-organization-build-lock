# Session 090: green baseline and open-issue sweep

## Task

Advance PLAN.md toward the next milestone. The goal asks for one of:

- carry in-progress work,
- fix one or more open issues,
- repair a red main CI.

Falsifiable hypothesis: after the 267 merge, at least one open issue still
has an in-repository fix. That hypothesis was tested and rejected. Every
open issue waits on an external decision or live evidence.

Safety invariants: unchanged. No fail-closed path was touched.

## Evidence before the change

- Local `main` was five commits ahead of `origin/main`. All five were the
  pre-squash ancestors of merged PR 267. `git diff origin/main main` was
  empty, so the local commits carried no unique work. Local `main` was
  reset to `origin/main` at 146e1c515.
- Main CI on 146e1c515 is green: Build lock CI (run 34415624929),
  Organization Unity enrollment audit (34415624933), Organization
  merge-policy audit (34415624928). No failed run exists in the last 30
  runs of this repository.
- Open pull requests: none. Draft pull requests: none.
- Full local verification suite: green. `node tools/llm-harness.mjs
  check`; `node --test test/*.test.js` (892 pass, 0 fail, 6 skipped, all
  six platform-gated); `go test ./...`; `go test -race ./...`; `go vet
  ./...`; `golangci-lint` (0 issues); `go mod verify` and `go mod tidy
  -diff` for both modules; `ci.sh javascript`; `ci.sh shellcheck`;
  `workflow-credential-audit`.

## Open-issue sweep (the RCA)

Each issue was inspected for an in-repository action. Ordered by impact:

- 255 (merge-policy drift): one finding left, the unity-helpers
  `Unity CI Success` required context. The fix is a unity-helpers
  ruleset change, carried by open consumer PR unity-helpers 749. The PR
  is mergeable, green on every host check, with Unity legs queued on the
  self-hosted fleet. Merging is a consumer decision.
- 113 (enrollment drift): 27 findings, all unity-helpers, all behind the
  same PR 749. Closes automatically on the first clean audit after it
  merges.
- 229, 231, 249, 153 (Darwin return chain): wait on the native macOS
  canary at exact head and the operator authorization merge. No in-repo
  step remains.
- 83, 53, 51, 44, 29: each needs organization-owner authority, Unity
  portal evidence, or multi-week live windows, per the triage recorded
  in sessions 066 and 067. Re-checked latest comments on 2026-09-09; no
  boundary moved.

## Adversarial review of the merged tip

The two newest unexercised behaviors were reviewed for latent defects:

- `enable_repin_auto_merge` (tools/workflows/repin-consumer-locks.sh):
  both open paths request auto-merge; every failure branch keeps the run
  green with a warning and a summary row; the method preference and the
  unreadable-URL and no-method dispositions are pinned by tests. A live
  GraphQL probe confirmed the `PR_` identity prefix the guard expects.
- The merge-policy bypass-mode acceptance (internal/mergepolicy): a mode
  mismatch reports as drift, and an omitted reviewed mode records the
  default `always` mode. Failure direction is safe: a changed live grant
  can never false-green the audit.

No defect found. No code change was warranted.

## Change

- `progress/session-090-green-baseline-and-issue-sweep.md`: this record.
- `PLAN.md`: current-state heading moves to session 090 with the sweep
  result. The M3 bullet drops merge history that sessions 086 through
  089 already recorded; the decline contracts and the open state stay.

## Verification

- The complete suite listed above: green before the change and re-run
  green after (`node --test test/*.test.js`, harness check, Go suite,
  linters, credential audit).
- `git diff origin/main main` empty after the reset, so no merged work
  was lost.

## Dispositions and follow-ups

- No pull request can advance 255 or 113 from this repository; their
  single dependency is the consumer merge of unity-helpers PR 749.
- The auto-merge path awaits its first live offer at the next authorized
  release; the scheduled repin run is the live proof, as session 089
  recorded.
- This PR carries the whole session: one branch, one pull request.
