# Session 135: accept merge group entries as a Unity trigger

Date: 2026-11-14

Issues: #377. Reviewed every open issue for priority.

## Objective and safety invariants

Carry the GOAL.md directive: rank the open issues by impact with the least
Unity CI churn, complete the highest-priority safe group, and drive it green.
No fail-closed path is weakened. A merge group is a new trigger, so the
licensed job keeps its same-repository guard. The classifier still defaults to
requiring Unity, and an unreadable revision pair still fails closed.

## Baseline

- `main` at `05c8b76d5d` was clean and green. No open pull requests.
- 17 open issues. The scheduled reaper, incident recovery, reaper delivery,
  enrollment, and merge-policy audits were green.
- Local `node --test test/*.test.js` had the same 23 failing cases recorded in
  session 134: 19 cleanup-evidence cases on macOS link semantics, one pre-commit
  hook case, and three release diagnostic cases that need Bash 4 `mapfile`.
- `go test ./...` passed before the change.

## Priority

1. #377: support `merge_group`. It is central work with no consumer edit until
   a consumer adopts the next release. A merge queue entry is the one open
   blocker for DoxReloaded's queue. Zero licensed churn for every repository
   that does not opt in.
2. #375: a Dependabot group can move a central pin to an unreviewed commit. The
   audit now names that root cause (#374). The fix still needs an owner decision
   between a consumer configuration change and a new consumer PR gate, so it is
   not a safe single change here.
3. Every other issue stays blocked on owner authority, ruleset authority, or
   licensed evidence, as `PLAN.md` records. #335 is still blocked: actionlint
   v1.7.12 is the newest release and still needs the old YAML API.

Open dependency state: no Dependabot pull request is open. The Go module,
actionlint module, and every workflow action pin are at the newest approved
release after #358, #361, and #362.

## Change 1: classify a merge group diff

- `.github/dist/classify-unity-changes.js`: `pull_request` and `merge_group`
  read the same base-to-head diff. Every other event still returns
  `unity-required=true` before any revision is read.
- A merge group has no pull request payload. GitHub reports
  `merge_group.base_sha` and `merge_group.head_sha` for the temporary queue
  branch, and that diff answers the same question. The diff also holds the
  changes from queue entries ahead of the entry, so it is conservative.
- An incomplete or malformed revision pair still fails closed.

## Change 2: admit the trigger and pin the classifier inputs

- `internal/enrollment/unity_policy.go`: `eligibleUnityTrigger` accepts
  `merge_group` under the same job guard as `pull_request`. The guard's
  event-name term is true for a merge group, which has no pull request payload.
- Only a user with write access can add a pull request to a merge queue. A
  writer can already run licensed work through a same-repository pull request,
  so the queue adds no new trust boundary.
- A workflow that listens for a merge group must pass
  `github.event.pull_request.base.sha || github.event.merge_group.base_sha`
  and the matching head expression. The audit refuses pull request only
  revisions for such a workflow, because every queue entry would block. A
  workflow without a merge group trigger keeps the old exact expressions, so no
  enrolled consumer changes.
- `docs/consumer-enrollment.md` records the trigger, the trust reason, the
  classifier expression, and a canary check for a required merge queue.

## Tests

- `test/unity-change-classifier.test.js`: a merge group diff of independent
  paths returns `unity-required=false`, a diff with `Assets/` returns `true`,
  and an incomplete revision pair fails closed. The push case now passes
  unreadable revisions, which proves the event gate runs before any diff.
- `internal/enrollment/unity_policy_test.go`: a guarded merge group is clean,
  an unguarded merge group is `ineligible-unity-trigger`, a merge group with
  the documented revisions is clean, and pull request only revisions are
  `missing-unity-aggregate`.
- The conditional validation fixture moved to
  `typedConditionalValidationWorkflow()` so both tests read one source shape.

## Validation

- `go test ./...`, `go test -race ./internal/enrollment ./cmd/audit-unity-enrollment`,
  `go vet ./...`: pass.
- `node --test test/unity-change-classifier.test.js test/action-manifests.test.js`:
  71 tests pass.
- `node --test test/*.test.js`: 1036 tests, 1010 pass, 23 fail. They are the
  same 23 cases on the baseline commit; this change adds no failure.
- `node tools/llm-harness.mjs check`, both `go mod verify` runs, both
  `go mod tidy -diff` runs, `bash tools/workflows/ci.sh javascript`, and
  `go run ./cmd/workflow-credential-audit .`: pass.
- `golangci-lint` and `shellcheck` are not installed on this macOS host.

## Follow-up

- Consumer adoption: DoxReloaded still has to add `merge_group` to its licensed
  workflow and pass the merge group revisions. That is a consumer change after
  the next authorized central release, not central work.
