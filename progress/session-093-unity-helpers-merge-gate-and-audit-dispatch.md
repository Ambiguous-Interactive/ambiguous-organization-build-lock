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

## Second gap: the carrying ruleset needs bypass evidence

The audit run triggered by the PR merge on main (34660170332) failed
closed as designed: `merge-policy-attestation-missing` for unity-helpers
ruleset 22983578, `complete=false`, 23 active contexts. Two causes:

1. Once unity-helpers carries a ruleset, the session-083 contract
   demands bypass-actor evidence. The CI reader mints
   `administration: read` only, and GitHub returns `bypass_actors` keys
   only to ruleset-write callers, so `BypassKnown` stays false without
   a consumer attestation. The earlier clean local run used the
   operator's administrator token, which does see `bypass_actors`; it
   therefore never exercised the stricter CI path. Lesson recorded:
   local verification with a write-capable token cannot prove the CI
   reader's view.
2. The per-branch rules endpoint had not yet propagated the new
   ruleset's requirement at run time (23 contexts, not 24). It
   reported the requirement on later reads without any further change.

Fix: unity-helpers pull request #768 published the reviewed
`.github/merge-policy-attestation.json` for ruleset 22983578 with an
empty bypass list, matching the DoxReloaded schema. Prettier formatting
was corrected once (their repo style collapses single-element arrays).
A maintainer merged `main` into the branch mid-review, which restarted
the required Unity run; the failed legs were re-run and the required
`Unity CI Success` aggregate reported success. #768 merged 2026-09-12
06:12 UTC.

## Observed closure of #255

The new `workflow_dispatch` trigger ran the audit on main immediately
after the attestation merge (run 34677521508, 2026-09-12 06:12 UTC):
`Audited 6/6 enrolled repositories; active-contexts=24 findings=0
complete=true`, then `Merge policy audit is complete and clean; drift
alert is closed.` Issue #255 closed at 06:12:43 UTC. The on-demand
trigger is proven in production; the next scheduled run re-states the
same clean state.

Adversarial review of this session found the record defects above
(closure claimed before it was observed; the failed CI verification
missing; one garbled line). They are corrected here and in PLAN.md.

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
path: the job keeps `contents: read` and `issues: write`, mints an
`administration: read` reader token, keeps its stable serial
concurrency group, and fails closed on incomplete retrieval. Sibling
audits (`dx-unity-automation-audit.yml`, the enrollment audit's request
workflow) already carry the same trigger. A dispatched run executes the
workflow file from the dispatched ref with secret access; the pinned
`ref: main` checkout and the read-only job keep the audited evidence
trusted, and the enrollment audit keeps its stricter `workflow_run`
request pattern.

## Other open issues

- #255: closed live on 2026-09-12 (evidence above).
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
- Local live audit with the administrator token: complete, 0 findings.
  Superseded as closure evidence by the CI-reader run above, which also
  proves the stricter attestation path.
- Dispatched audit run 34677521508 on main: 6/6 repositories, 24 active
  contexts, 0 findings, complete; #255 closed automatically.
- `node --test test/*.test.js`, `go test ./...`, `go vet ./...`,
  `go test -race ./...`, actionlint, shellcheck, module checks, and the
  credential audit run in the PR verification; see the pull request.
