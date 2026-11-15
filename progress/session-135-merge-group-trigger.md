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
  `merge_group` under the same job guard as `pull_request`. The guard must keep
  its event-name term. The bare repository comparison is false on a merge
  group, because there is no pull request payload, so that shape would skip
  every queue entry.
- Only a user with write access can add a pull request to a merge queue. The
  queue entry runs the queued diff, including a fork pull request diff, with
  organization secrets once that writer adds it. The write action is the trust
  boundary, and a writer can already push the same commits to a
  same-repository branch. No new principal gains access.
- The trigger configuration is read. `types` must be absent or exactly
  `checks_requested`. `branches` must name only protected branches.
  `branches-ignore` and every other key are refused, so an eligible trigger
  provably reports on a protected branch.
- A workflow that listens for a merge group must pass
  `github.event.pull_request.base.sha || github.event.merge_group.base_sha`
  and the matching head expression. The audit refuses pull request only
  revisions for such a workflow in the typed validation shape, because every
  queue entry would block. A workflow without a merge group trigger keeps the
  old exact expressions, so no enrolled consumer changes.
- `docs/consumer-enrollment.md` records the trigger, the write-access trust
  boundary and its fork consequence, the classifier expression, and a canary
  check for a required merge queue.

## Tests

- `test/unity-change-classifier.test.js`: one data table runs both
  `pull_request` and `merge_group` through the runner input names. An
  independent diff returns `unity-required=false`, a diff with `Assets/`
  returns `true`, and an incomplete merge group revision pair fails closed.
  The push case passes unreadable revisions, which proves the event gate runs
  before any diff.
- `internal/enrollment/unity_policy_test.go`: table-driven cases cover an
  unfiltered merge group, a `types` and `branches` filter, and a sequence
  trigger. Refused cases cover a missing guard, a bare repository guard, an
  unprotected branch, `branches-ignore`, and an unknown activity type. The
  classifier cases cover both trigger spellings, and pull request only
  revisions produce `missing-unity-aggregate`.
- The conditional validation fixture moved to
  `typedConditionalValidationWorkflow()` so both tests read one source shape.

## Adversarial review

- The first version said a queue entry adds no new trust boundary. That was
  wrong: a writer can enqueue a fork pull request, and the merge group run
  holds organization secrets for that diff. The code comment and both docs now
  name the write action as the boundary and the fork consequence. The canary
  step for fork PRs now covers a queued fork PR.
- The first version reused the bare repository guard. That guard is false on a
  merge group, so the licensed job would skip and the queue would stall. The
  guard now must contain the event-name term.
- The first version ignored the trigger configuration. It now checks `types`
  and `branches`, so a filter that never fires for a protected branch is
  refused.
- `workflowDeclaresEvent` now reuses the one `on:` traversal instead of a
  second copy.
- Test cases became subtests with names, and the duplicate classifier diff
  tests became one table.

## Validation

- `go test ./...`, `go test -race ./internal/enrollment ./cmd/audit-unity-enrollment`,
  `go vet ./...`: pass.
- `node --test test/unity-change-classifier.test.js test/action-manifests.test.js`:
  69 tests pass.
- `node --test test/*.test.js`: 1034 tests, 1008 pass, 23 fail. They are the
  same 23 cases on the baseline commit; this change adds no failure.
- `node tools/llm-harness.mjs check`, both `go mod verify` runs, both
  `go mod tidy -diff` runs, `bash tools/workflows/ci.sh javascript`, and
  `go run ./cmd/workflow-credential-audit .`: pass.
- `golangci-lint` and `shellcheck` are not installed on this macOS host.

## Follow-up

- Consumer adoption: DoxReloaded still has to add `merge_group` to its licensed
  workflow and pass the merge group revisions. That is a consumer change after
  the next authorized central release, not central work.
