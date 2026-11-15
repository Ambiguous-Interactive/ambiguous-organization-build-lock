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

## Change: read the pushed tree against a run that covered the merged base

- `.github/dist/classify-unity-changes.js`: on `push`, the incremental mode
  reads the pushed commit tree from `GITHUB_SHA`, finds the merged pull request
  whose `merge_commit_sha` is that commit, and reads its base commit time.
- It lists the newest 20 successful `pull_request` runs of the same workflow.
  Unity is skipped only when all of these hold: the run started at or after the
  merged base existed, its head is the merged pull request head, its tree equals
  the pushed tree, and it comes from this repository and a non-Dependabot actor.
- The base-time proof covers both checkout shapes. With the final base in
  place, a run that checks out the head tests the pushed tree. A run that checks
  out the merge ref tests the same tree, because the pushed squash tree equals
  the head tree and the final base is an ancestor of that head tree.
- A malformed pushed revision, a direct push with no merged pull request, an
  unreadable history, a run before the merged base, and no matching record all
  keep Unity required. An unreadable record cannot justify a skip; a later
  readable record still can.
- The push path makes no git call. It reads commit objects and the pull request
  through the API, so the runtime still reads no file contents and the blobless
  checkout still works.
- The mode needs `actions: read` for run history, `contents: read` for commit
  trees, and `pull-requests: read` for the merged pull request lookup.
- The action metadata, README, and consumer enrollment contract describe both
  halves and the three scopes.

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

- `test/unity-change-classifier.test.js`: a data table covers twenty-two push
  outcomes: a matching tree, a different tree, the `GITHUB_SHA` fallback, an
  ignored caller-supplied head revision, no revision, a run before and after the
  merged base, a run without a start time, an unreadable record, the current
  run, a record on another head, a fork record, a Dependabot record, no merged
  pull request, an unmerged pull request, a push that is not the merge commit,
  an incomplete revision pair, a base without a commit time, an unreadable base,
  a pull request payload that is not a list, an unreadable history, and a failed
  lookup. The pull request table adds the same fork and Dependabot refusals. A
  further case proves the request shape and that the mode is opt-in. A
  committed-runtime case proves the mode reaches the action and fails closed
  before any request.
- `node --test test/unity-change-classifier.test.js test/action-manifests.test.js
  test/documentation-policy.test.js`: 90 tests pass.

## Validation

- `go test ./...`, `go vet ./...`, both `go mod verify` runs, both
  `go mod tidy -diff` runs: pass.
- `node tools/llm-harness.mjs check`, `bash tools/workflows/ci.sh syntax`,
  `bash tools/workflows/ci.sh javascript`, and
  `go run ./cmd/workflow-credential-audit .`: pass.
- `node --test test/*.test.js`: 1041 tests, 1015 pass, 23 fail. The 23 are the
  same baseline cases; this change adds none.
- `go test -race ./...` and `go -C tools/actionlint run ... actionlint`: pass.
- End-to-end on real data: push `4bf18ba8` returns `unity-required=false` and
  push `2e6a6bcd` returns `unity-required=true`.
- `golangci-lint` and `shellcheck` are not installed on this macOS host.

## Review

- CodeRabbit requested changes for two reasons.
- The first was the token scope. A commit-tree read needs `contents: read`, not
  only `actions: read`; the merged pull request lookup needs
  `pull-requests: read`. The action metadata, README, and consumer contract now
  name all three, and the documented classifier job grants them.
- The second was the record's merge-ref evidence. A successful pull request run
  may have checked out the merge ref, and a base move could make its tree differ
  from the pushed tree. The push path now finds the merged pull request, reads
  its base commit time, and accepts a run only when it started at or after that
  base existed. With the final base in place, both checkout shapes test the
  pushed tree.
- Both threads are answered and resolved. The stale changes-requested review was
  dismissed because CodeRabbit did not re-review after the fix.
- The `main-pr-ci` ruleset requires resolved threads, not an approval.

## Merge and post-merge

- Merged #385 on `main` as `afe8e6c0b4` (squash).
- Build lock CI run `43761221778` is green on that commit.
- Organization Unity enrollment audit `43761221801` is green:
  `Audited 7/7 enrolled repositories; active-jobs=133 findings=25 complete=true`.
  The 25 findings are the consumer-side items already tracked in #113.
- Reaper delivery audit `43761295576` is green. Build lock incident recovery
  audit `43760613265` is green.
- #382 is closed. Adoption is one classifier step edit per repository and adds
  no run. No consumer change ships here.
