# Session 136: skip a follow-up push that changes no Unity path

Date: 2026-11-15

Issues: #382. Reviewed all 18 open issues for priority.

## Objective and safety invariants

Carry the GOAL.md directive: rank the open issues by impact with the least
Unity CI churn, complete the highest-priority safe group, and drive it green.
The new mode can only remove a licensed run it can justify. Every uncertain
answer keeps Unity required. The classifier still reads no file contents and
still makes one tree-only git call.

## Baseline

- `main` at `1f9ecd0441` was clean and green. No open pull request.
- Build lock CI run `43740458235` is green; the enrollment, merge-policy,
  reaper, reaper delivery, and incident recovery audits are green.
- Local `node --test test/*.test.js`: 1034 tests, 1008 pass, 23 fail. The 23
  cases are the known macOS-only failures recorded in session 135: 19
  cleanup-evidence link cases, one pre-commit hook case, and three release
  diagnostic cases that need Bash 4 `mapfile`.
- `go test ./...` passed.

## Priority

1. #382: a follow-up push that changes no Unity path still runs the licensed
   job. Reported data: 55 % of follow-up pushes (36 of 66) changed no file in
   `Assets/`, `Packages/`, or `ProjectSettings/`, and each one still spent a
   seat for 12.9 min median. It is central work behind an opt-in flag, so no
   consumer gains a run by adopting it.
2. #375: Dependabot pin drift. The audit already names the root cause (#374).
   The preventive guard changes a consumer pull-request gate and needs an
   owner decision between a consumer configuration change and a new gate.
3. #335, #379, #334, #255, #113, #44, #51, #53, #83, #153, #229, #231, #249,
   #277, #278, #29: blocked on upstream releases, consumer merges, ruleset or
   organization authority, or licensed evidence. `PLAN.md` records each one.

## Measurement decision

The issue asks to measure the push-to-main half before building it. That half
needs a squash tree compared with a validated merge-ref tree, and the record
has to come from run history. This session built and shipped the pull request
half only. The push-to-main half stays open on #382 with the measurement step
first.

## Change 1: read the record from the repository's own run history

- `.github/dist/classify-unity-changes.js`: new opt-in
  `incremental-validation` input. When the whole-pull-request diff requires
  Unity, the action reads this repository's run history for the newest
  successful `pull_request` run of the same workflow on the same branch, and
  compares that head with the current head through the comparison API.
- The record is not a pull request input. A pull request cannot supply a
  baseline tree, and a green `Unity CI Success` alone is not a record.
- A successful run of a workflow that carries the central aggregate proves
  its head tree either passed the licensed job or needed none. Both cases make
  the tree a validated baseline.
- Unity is skipped only when every path in that delta is independent. No
  record, a diverged branch, a truncated 300-file comparison, an unparseable
  workflow reference, a missing token, and a failed request all keep Unity
  required. The `true` output is written before any lookup, so a crash cannot
  leave a skip behind.
- The comparison is the API's own file list, so the runtime keeps its single
  tree-only git call and its blobless, credential-free checkout.
- A merge group keeps the whole-diff answer: it has no pull request branch to
  read a record from.
- The lookup is bounded by a 20 s abort and never logs the token.

## Change 2: refuse an unsafe credential pairing

- `internal/enrollment/unity_policy.go`: the typed classifier accepts the two
  new keys, and `incrementalValidationInputSafe` accepts only one pairing: the
  literal `incremental-validation: true` with `github-token: ${{ github.token }}`.
  A literal token, another secret, the mode without a token, a token without
  the mode, a mode from an expression, and `false` are refused.
- The aggregate needs no change: it already consumes the one boolean the
  classifier reports.

## Tests

- `test/unity-change-classifier.test.js`: one data table runs thirteen
  outcomes through `run`: a document-only delta, a Unity path, a rename out of
  a Unity path, an identical tree, a rewritten history, a truncated list, a
  comparison without files, no successful run, a run on another branch, the
  current run, a record with no commit, an unreadable history, and a failed
  lookup. Two further cases prove the request scoping (one run-history read,
  one comparison, both on the expected URLs), the merge group and opt-in
  refusals, and the workflow-reference grammar.
- `internal/enrollment/unity_policy_test.go`: seven pairings cover one
  accepted shape and six refused shapes.
- `test/action-manifests.test.js`: the classifier interface assertion lists
  the two new inputs.

## Adversarial review

- The first version wrote the decision only through the return value, so the
  action emitted `unity-required=true` beside a false return. The output write
  now follows the decision, and the tests read the emitted line, not only the
  return value.
- The first version accepted `github-token` without the mode. A credential
  with no reader widens the surface for nothing, so the audit now refuses it.
- The 300-file comparison ceiling is treated as unknown rather than as a short
  list, because the API truncates at that count.
- `previous_filename` is compared too, so a rename out of `Assets/` cannot
  look like an independent addition.

## Validation

- `go test ./...`, `go vet ./...`, both `go mod verify` runs, both
  `go mod tidy -diff` runs: pass.
- `node --test test/action-manifests.test.js test/unity-change-classifier.test.js`:
  72 tests pass.
- `node --test test/*.test.js`: 1037 tests, 1011 pass, 23 fail. The 23 are
  the same baseline cases; this change adds none.
- `node tools/llm-harness.mjs check`, `bash tools/workflows/ci.sh syntax`,
  `bash tools/workflows/ci.sh javascript`, and
  `go run ./cmd/workflow-credential-audit .`: pass.
- `actionlint`, `golangci-lint`, and `shellcheck` are not installed on this
  macOS host.

## Follow-up

- #382 keeps the push-to-main half: measure squash-tree equality against a
  validated merge-ref tree before building it.
- Consumer adoption is a one-step workflow edit: add the literal mode and
  `github-token: ${{ github.token }}` to the classifier step.
