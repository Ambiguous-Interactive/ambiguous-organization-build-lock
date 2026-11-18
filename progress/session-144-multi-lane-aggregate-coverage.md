# Session 144: several licensed lanes in one workflow

Date: 2026-11-18

Issues: #397 (decided and guarded here), #113 (unchanged), #335 (rechecked,
still blocked upstream).

## Objective and safety invariants

Carry the GOAL.md directive: rank the open issues by impact with the least Unity
CI churn, complete the highest-priority safe work, and drive it green.

Safety invariants:

- A licensed lane that cannot fail a protected pull request is not proven.
- Two lanes that report one context share one verdict, so one context cannot
  cover both.
- A dispatch, schedule, or push lane holds no merge gate, and its own run
  verdict stays authoritative.
- No licensed workflow changes here, so the Unity matrix and its seats are
  untouched.

## Baseline

- `main` at `47b17b4546`. No open pull request. The last ten runs are green,
  including the three scheduled monitors.
- Latest actionlint release is v1.7.12 (checked with `gh release list`). #335
  stays blocked, because v1.7.12 still builds against YAML rc.3 only.
- Local audit of the seven default branches with the unmodified analyzer:

  ```text
  Audited 7/7 enrolled repositories; active-jobs=136 findings=23 complete=true
  ```

- Finding classes: 13 DxMessaging shape findings, 8 expired policy exceptions,
  2 unity-helpers findings.

## Open-issue priority

| Order | Item | Impact | Unity CI churn |
| --- | --- | --- | --- |
| 1 | #397 aggregate coverage | Blocks every workflow with more than one licensed lane. Three DxMessaging and one unity-helpers finding sit in this class. | None. Central analyzer and doc only. |
| 2 | #113 DxMessaging shape | 13 consumer findings. | Low per workflow, but the dispatch lanes need consumer edits. |
| 3 | #390 consumer status adoption | Needs a consumer job-shape decision and a ruleset edit. | Low. |
| 4 | #379 merge queue adoption | Needs an owner decision to enable the queue. | Low. |
| 5 | #335 actionlint YAML | Blocked upstream. Rechecked today: v1.7.12 is still latest. | None. |
| 6 | #408 private callee policy | Needs an owner decision on the trust boundary. | None until decided. |
| 7 | #29, #51, #53, #83, #153, #229, #231, #249, #277, #278, #334 | Each needs owner authority, portal evidence, or hardware this session cannot obtain. | Unknown until the evidence exists. |

## Root cause

`hasAggregate` binds one exact-shape aggregate to one licensed job, and the
reviewed merge policy names one required context per repository. Measured with
two typed-gate lanes on one workflow:

- Both lanes pass when the policy requires both gate contexts.
- Both lanes also pass when the policy requires only the first gate context. The
  second lane then cannot block a merge, so a failed nightly lane would leave a
  green required context.
- Both lanes pass when the second gate reports the first gate's context name.
  One context then carries two verdicts.

## Change

- `auditLicensedLaneCoverage` runs once per workflow. For every licensed job it
  resolves the covering aggregate, then requires that aggregate's reported
  context in the reviewed `requiredContexts` list. A lane whose context is not
  required reports `unrequired-licensed-aggregate`.
- Two different aggregate jobs that report one required context each report
  `duplicate-licensed-aggregate-context`. One aggregate job that enforces
  several lanes is the reviewed shape, because it fails when any lane fails. The
  check reads every workflow of the snapshot, so two files that report one
  context are refused too.
- The rule applies only where a pull request or eligible `merge_group` trigger
  can reach a protected branch, and only to a lane whose job guard does not
  exclude both events. A dispatch, schedule, or push lane publishes its own run
  verdict, so it holds no merge gate. A `pull_request_target` run holds no
  licensed lane, because the reviewed trigger shape says such a job is excluded.
  A branch glob, a rejected trigger key, or a malformed trigger keeps the rule,
  because none of them proves the trigger cannot reach a merge.
- A historical readback lane, which omits the aggregate on purpose, keeps its
  reviewed exclusion. An unprovable expression or matrix name stays with
  `filtered-aggregate-gate`.
- `docs/consumer-enrollment.md` item 10 now states the multi-lane shape: one
  aggregate per lane, the classifier and preflight may be shared, and the
  default branch must require every lane context. The finding table names both
  new codes.

## Evidence

Local audit of the same seven checkouts after the change:

```text
Audited 7/7 enrolled repositories; active-jobs=136 findings=23 complete=true
```

The findings are the same 23 rows as the baseline. The first draft of the rule
also named seven dispatch, schedule, and push lanes. Each was a non-pull-request
workflow, so the protected-branch precondition removed that false positive.

Tests:

- `TestUnityEnrollmentAcceptsSeveralLicensedLanes`
- `TestUnityEnrollmentRefusesUnprovenLicensedLaneGates`, three mutations:
  unrequired lane context, shared lane context, and a gate bound to the other
  lane's result.
- `TestUnityEnrollmentRequiresALaneGateOnlyWhereAMergeCanBeBlocked`, eleven
  trigger shapes: push only, merge group, merge group only, pull request, an
  allow list of unprotected branches, every protected branch denied, an allow
  glob, a deny glob, an all-branches glob, a denied release-branch glob, and a
  `+` quantifier glob.
- `TestUnityEnrollmentDoesNotRequireAMergeGateForALaneOffMergeEvents`
- `TestUnityEnrollmentAcceptsOneAggregateThatEnforcesSeveralLanes`
- `TestUnityEnrollmentRefusesOneRequiredContextForTwoAggregateJobs`

Local checks:

- `go test ./...`, `go vet ./...`, `go test -race ./...`: pass.
- `go mod verify`, both `go mod tidy -diff` commands: pass.
- `go run ./cmd/workflow-credential-audit .`: pass.
- `node tools/llm-harness.mjs check`: pass.
- `bash tools/workflows/ci.sh javascript` and `shellcheck`: pass.
- `node --test test/*.test.js` reports 20 failures on this macOS host. The same
  20 tests fail on the untouched tree (identical failure sets, checked with
  `git stash`), and each reads a symbolic-link, hard-link, inode, or git-hook
  case that the host filesystem does not provide. CI runs them on Linux.
- `golangci-lint` is not installed on this host. CI runs it.

## Review findings and dispositions

An independent adversarial review found these. All are fixed.

- High: a branch glob disabled the whole rule. `pullRequestEventFilters` reports
  a glob filter as "not proven", which fails closed for the filter rule and would
  fail open for this one. `triggerMayReachProtectedBranches` now answers the
  opposite question: only an exact unprotected allow list, or a deny list that
  names every protected branch, proves the trigger cannot reach a merge. A glob,
  a rejected trigger key, and a malformed trigger all keep the rule.
- Medium: two workflow files that reported one context were accepted, because
  the duplicate map was per workflow. The map now spans the snapshot, and the
  check refuses two different aggregate jobs that report one context.
- Medium: one aggregate job that enforces several lanes was refused. That job
  fails when any lane fails, so it is the reviewed shape. Only two different
  aggregate jobs that share a context are refused now.
- Medium: the docs and the code comment said "pull request" only, and did not
  name the merge group or the shared-aggregate shape. Both are corrected. The
  plan keeps only the open DxMessaging action.
- Low: a `pull_request_target` only workflow produced a false positive. A
  licensed job is required to be excluded from that event, so the rule now reads
  `pull_request` and `merge_group` only.
- Low: the trigger list was parsed twice. One `pullRequestEventConfigs` pass
  answers both questions.
- Low: the audit evidence was measured before the merge group support. The audit
  was re-run at the final code, and the count held at 23.

Second round, from the advisory review and CodeRabbit:

- Medium: a lane whose job guard excludes both merge events was refused. That
  lane never fails a protected pull request, so the rule now reads the job guard
  with `jobExcludedFromEvents` and skips it.
- Low: the merge group fixture always declared a pull request trigger beside it.
  A merge-group-only case now sits in the table, with the all-branches and
  denied-release glob cases CodeRabbit asked for.
- The request to change the shared `triggerRunsOnProtectedBranches` to glob
  semantics is declined. That helper serves the path-filter rule, where "not
  proven" must fail closed. The lane rule has its own may-reach test.

Third round, from the advisory review:

- High: a pattern with `+` could match a protected branch while the rule read it
  as a plain name. `literalBranchName` now accepts only letters, digits, `.`,
  `-`, `_`, and `/`. Every other pattern keeps the rule.

## Merge and verification

- Pull request #411 merged on `main` as `0722c77ddf` (squash) on 2026-11-18.
- `Build lock CI` run 44397021167 on `0722c77ddf`: success.
- Organization Unity enrollment audit run 44397021295 on `0722c77ddf`:
  success, with 23 findings across 3 repositories. The classes are the same as
  the baseline: `expired-policy-exception` x8, `missing-unity-aggregate` x4,
  `missing-unity-editor-check` x5, `unsafe-central-return-suffix` x3,
  `unsafe-workflow-queue` x3. No `unrequired-licensed-aggregate` and no
  `duplicate-licensed-aggregate-context` appears, so the new rule found no
  consumer drift today.
- Reaper delivery audit run 44397106604 on `0722c77ddf`: success. Build lock
  incident recovery audit run at 20:53 on the parent commit: success. Its next
  scheduled run reads this commit.
- Every review thread is answered and resolved. The advisory review on the final
  commit reports zero findings. The CodeRabbit changes-requested review was
  dismissed because every actionable comment was fixed and CodeRabbit did not
  re-review.
- #397 is closed. #412 tracks the consumer aggregate work that remains.

## Out of scope

- The 3 DxMessaging and 1 unity-helpers aggregate findings need consumer edits,
  tracked in #113 and #397.
- The 8 expired policy exceptions need an owner re-review.
- #113 DxMessaging shape findings other than the aggregate class.
