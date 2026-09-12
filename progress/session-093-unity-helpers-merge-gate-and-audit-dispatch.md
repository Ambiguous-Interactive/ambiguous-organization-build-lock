# Session 093: unity-helpers merge gate and on-demand merge-policy audit (issues 255, 113)

## Task

Merge latest `origin/main`, re-verify the green baseline, and address open
issues by impact. The top actionable item was the last #255 finding:
unity-helpers did not require `Unity CI Success` on its default branch.

Falsifiable hypothesis: the last merge-policy audit (run 34581025080,
2026-09-11 08:48 UTC) ran after unity-helpers #749 merged (2026-09-10
19:02 UTC) and still reported the finding, so the reviewed session-092
expectation "when #749 merges, a clean audit closes #255 automatically"
is false. Something besides the workflow reporter is missing.

## Baseline

- `main` at 0e40c92bd, level with `origin/main`, worktree clean. Build
  lock CI green on the session-092 merge push. No open or draft pull
  requests in this repository.
- Open issues: 269, 255, 249, 231, 229, 153, 113, 83, 53, 51, 44, 29.

## Root cause of the last #255 finding

Observed live with the repository API (read-only):

- unity-helpers `main` at `edbfe9b245c2` (the #749 merge) carries one
  ruleset only: `Copilot review for default branch` (15358326). No
  ruleset or classic branch protection requires `Unity CI Success`.
- The reporter itself is correct: `.github/workflows/unity-tests.yml`
  triggers on `pull_request` into `master`/`main` with no paths filter,
  and the `unity-ci-success` job runs `if: always()`, re-resolves the
  PR head, and fails closed on any unexpected leg result, including the
  fork-PR and Dependabot cases.
- Root cause: #749 changed files only. Required-context enforcement is
  ruleset state; no pull request can create it. A repository
  administrator must add the ruleset.

Sweep: the other five consumers already satisfy their expectations
(DoxReloaded ruleset 22595536, DxMessaging 17663217, IshoBoy 4545251,
qora-redux default branch protection). unity-helpers was the only
repository of the class.

## Fix: unity-helpers ruleset 22983578

Created with the operator's administrator authority, following the
reviewed precedent used for DoxReloaded (22595536) and qora-redux:

- Name `Required CI - Success (default branch)`, target branch,
  enforcement `active`.
- Conditions: default branch only.
- Rule `required_status_checks`: context `Unity CI Success`, strict
  policy, `do_not_enforce_on_create: false`.
- No bypass actors (`bypass_actors: []`), which satisfies the
  `requireAdminEnforcement: true` expectation.

Blast radius check before creation: unity-helpers had one open pull
request (#765) with an in-flight Unity Tests run whose final
`Unity CI Success` job reports on completion, so the new requirement
resolves without maintainer action.

Verification: the unmodified local analyzer over live state reported
`complete=true`, 24 active contexts (one more than the 23 before the
ruleset), 0 findings, exit 0. A complete clean audit closes #255
automatically on the next scheduled run or the run triggered by this
change.

Diagnostic note: a first local run reported `complete=false` with six
`merge-policy-retrieval-incomplete` findings. Cause: the caller passed
`READER_AUTHORIZATION` with a `Bearer` prefix, and the client adds the
prefix itself, so every request authenticated as `Bearer Bearer ...`.
No code change; the tooling behaved fail-closed as designed.

## Fix: on-demand merge-policy audit

Session friction observed: the scheduled run cannot be re-run
(`gh run rerun` rejects it), the workflow had no `workflow_dispatch`,
and the sibling request workflow pattern exists only for the enrollment
audit. An operator who fixes live drift had to wait for the next daily
schedule to verify the fix.

Change: `.github/workflows/merge-policy-audit.yml` gains
`workflow_dispatch`. The contract test
(`organization merge-policy audit is exact, read-only, and fail closed`)
now requires the trigger. The trigger does not weaken any fail-closed
path: the job stays read-only over ` Administration read` plus
`issues: write`, keeps its stable serial concurrency group, and fails
closed on incomplete retrieval. Sibling audits
(`dx-unity-automation-audit.yml`, the enrollment audit's request
workflow) already carry the same trigger.

## Other open issues

- #113: the single finding waits on consumer merge DxMessaging #582
  (still open, consumer decision). Nothing to do here.
- #269: lock-side work is complete (#270); the consumer half is canary
  item 12. qora-redux attempt 2 reproduced the signature; that evidence
  supports #83's capacity decision, not a lock code change.
- #29, #44, #51, #53, #83, #153, #229, #231, #249: blocked on
  organization authority, portal evidence, or live windows, per the
  recorded triage.

## Verification

- `go test ./internal/mergepolicy ./cmd/audit-merge-policy` green.
- Local live audit: complete, 0 findings (evidence above).
- `node --test test/*.test.js`, `go test ./...`, `go vet ./...`,
  `go test -race ./...`, actionlint, shellcheck, module checks, and the
  credential audit run in the PR verification; see the pull request.
