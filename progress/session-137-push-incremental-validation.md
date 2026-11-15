# Session 137: skip a push-to-main run whose tree a validated run holds

Date: 2026-11-15

Issues: #382. Reviewed all 18 open issues for priority.

## Objective and safety invariants

Carry the GOAL.md directive: rank the open issues by impact with the least Unity
CI churn, complete the highest-priority safe group, and drive it green. This
change can only remove a licensed run whose exact tree a successful pull request
run already holds. Every uncertain answer keeps Unity required. The classifier
still reads no file contents.

## Baseline

- `main` at `36bf2a3539` was clean and green. No open pull request.
- The newest runs of the build lock, enrollment, merge-policy, reaper, reaper
  delivery, and incident recovery audits are green.
- Local `node --test test/*.test.js`: 1038 tests before the change, 1015 pass,
  23 fail. The 23 are the known macOS-only failures recorded in session 136.
- `go test ./...` passed.

## Priority

1. #382: the pull request half shipped in session 136. The issue still asks to
   measure the push-to-main half before building it. 60 % of sampled pushes
   repeat a validated tree, so this is the largest safe reduction in licensed
   churn left.
2. #375: Dependabot pin drift. The audit already names the root cause (#374).
   The preventive guard needs an owner decision.
3. #335: actionlint still does not support the current YAML v4 API. A local
   build of actionlint v1.7.12 with `go.yaml.in/yaml/v4 v4.0.0` fails on
   `yaml.TypeError.Errors` and `yaml.ParserError`, so the isolated module stays
   on rc.3.
4. #379, #334, #255, #113, #44, #51, #53, #83, #153, #229, #231, #249, #277,
   #278, and #29 are blocked on releases, consumer merges, ruleset or
   organization authority, or licensed evidence. `PLAN.md` records each one.

## Measurement

Read-only sample of the last 60 push-to-main runs of
`Ambiguous-Interactive/IshoBoy` unit CI (`unity-ci.yml`), on 2026-11-15.

- 60 of 60 pushes had an associated pull request.
- 36 of 60 (60 %) wrote a tree equal to the pull request head tree that a
  successful pull request run held.
- The licensed job in those 36 runs took 413 minutes in total, about 11.5
  minutes each.
- The 24 other pushes merged after their base moved, so the squash tree
  differed from the head tree. They keep Unity required.

The production window was checked against real data. The successful record for
push `4bf18ba8` was the second newest record, and the newest push
`2e6a6bcd` had no matching record.

## Change: read the pushed tree against the run records

- `.github/dist/classify-unity-changes.js`: on `push`, the incremental mode
  reads the pushed commit tree from `GITHUB_SHA`, lists the newest 20 successful
  `pull_request` runs of the same workflow, and compares each run's head tree.
  Unity is skipped only on exact tree equality.
- A malformed pushed revision, an unreadable history, and no matching record
  keep Unity required. An unreadable record cannot justify a skip; a later
  readable record still can.
- The push path makes no git call. It reads commit objects through the API, so
  the runtime still reads no file contents and the blobless checkout still
  works.
- `incremental-validation` still requires `github-token: ${{ github.token }}`.
  The enrollment analyzer already accepts that pairing on a workflow that
  declares `push`.
- The action metadata, README, and consumer enrollment contract describe both
  halves.

## Adversarial review

- The first version accepted any successful pull request run as a record. A fork
  pull request and a Dependabot pull request both report a trusted skip, and the
  aggregate accepts that skip. Such a run does not prove licensed work, so a
  push carrying its tree could skip the only licensed run on `main`. The runtime
  now accepts only a same-repository, non-Dependabot record. The repository head
  and the actor or branch prefix supply that evidence from the run record.
- The same gap existed in the pull request half. The record selection now uses
  the same rule for both halves.
- An unreadable record first stopped the whole scan, so one deleted commit could
  disable the mode for every later push. The scan now ignores an unreadable
  record and continues; only a confirmed tree match can skip, so an unreadable
  record still cannot justify one.

## Tests

- `test/unity-change-classifier.test.js`: a data table covers twelve push
  outcomes: a matching tree, a different tree, the `GITHUB_SHA` fallback, no
  revision, the current run, a record without a commit, a fork record, a
  Dependabot record, an unreadable history, a failed lookup, and an unreadable
  record before and after a later match. The pull request table adds the same
  fork and Dependabot refusals. A further case proves the request shape and
  that the mode is opt-in. A committed-runtime case proves the mode reaches the
  action and fails closed before any request.
- `node --test test/unity-change-classifier.test.js test/action-manifests.test.js`:
  76 tests pass.

## Validation

- `go test ./...`, `go vet ./...`, both `go mod verify` runs, both
  `go mod tidy -diff` runs: pass.
- `node tools/llm-harness.mjs check`, `bash tools/workflows/ci.sh syntax`,
  `bash tools/workflows/ci.sh javascript`, and
  `go run ./cmd/workflow-credential-audit .`: pass.
- `node --test test/*.test.js`: 1041 tests, 1015 pass, 23 fail. The 23 are the
  same baseline cases; this change adds none.
- End-to-end on real data: push `4bf18ba8` returns `unity-required=false` and
  push `2e6a6bcd` returns `unity-required=true`.
- `actionlint`, `golangci-lint`, and `shellcheck` are not installed on this
  macOS host.

## Pull request

- #385 opened against `main`.
