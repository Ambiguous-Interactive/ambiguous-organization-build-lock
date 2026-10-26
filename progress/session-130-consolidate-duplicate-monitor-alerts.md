# Session 130: consolidate duplicate monitor alerts

Date: 2026-10-25

## Objective and safety invariants

Restore monitoring that fail-closed itself into permanent silence:

- the `Reaper delivery audit` failed every run for three days with
  `incident-sync-failed`, so reaper delivery status stayed unknown;
- three open twin alert issues (duplicate automation issue evidence) made
  every shared-client synchronization refuse;
- all four monitors share the failure class, so the whole class must heal.

Safety invariants: every health and alerting state stays proven by the
run history; no fail-closed rule gets weaker without an explicit
consolidation decision per monitor; no twin's last published evidence is
rewritten; no licensed or Unity-adjacent job changes; no credential or
log content grows.

## Baseline and observed failure chain

Observed facts, all reproducible with repository code and live API data:

- `internal/githubissue.Find` refuses a second derivation-same match with
  `duplicate automation issue evidence`; `Sync` surfaces it and the monitor
  fails its run.
- A throwaway clone run of the live repository against the live API
  returns that refusal within seconds (three open twins exist).
- Live API: `reap-stale-locks.yml` delivered on schedule repeatedly the
  last day, so the monitor's own classification is `healthy`; a healthy
  close-out is also blocked by the same refusal.
- Issue history: the monitor created twins #345, #346, #347 in about two
  hours on 2026-10-22 (`14:56`, `15:54`, `16:59` UTC), each at its own
  body timestamp and none ever updated.
- Run logs around that window alternate minute by minute between create
  outcomes and `incident-sync-failed`, which proves the API's
  creator-scoped issue list transiently omitted bot-authored matches:
  the create path ran (`existing == nil`), then minutes later the same
  list saw the twins and refused.
- External corroborations: same-title closed twin #126 is in the same
  `state=all` creator listing today, and GitHub had partial API
  instability on 2026-10-22.

Inference: a GitHub-side transient list inconsistency produced the twins;
the refusal's lack of a bounded recovery path then turned it permanent.
The create-time number matching is not contradictory with the invariant —
it is the documented effect of the transient.

## Red-green experiment

Red (compile-failure level, standard repository form): the new
`TestSyncConsolidatesDuplicateAlerts` pins the consolidation contract that
did not exist.

Green after the smallest coherent change:

- `internal/githubissue`: `Find` now routes through a private
  `matchAlerts` walk with the same validations; `Desired` gains
  `ConsolidateDuplicates`; `Sync` heals an opted-in cluster before the
  normal desired-state logic; `ActionConsolidated` reports a heal.
- Heal contract: the oldest open match stays alive; when none is open the
  oldest match becomes the keeper; other open twins close with a state-only
  patch; closed twins are never touched again; the keeper follows every
  existing identical, verify-create, and re-read rule.
- The heal is idempotent: a second run performs no extra write once
  twins are closed.
- `cmd/reaper-delivery-audit`, `cmd/lock-recovery-audit`,
  `cmd/sync-merge-policy-issue`, and `cmd/sync-unity-enrollment-issue`
  opt in; the reaper audit also names its sync failure cause, through
  `jsonstrict.SanitizeCause`, in the run log so an operator can tell a
  refusal apart from a transport failure.
- Removed stale test `TestSyncRejectsDuplicateMarkerIssues` from the
  enrollment suite: it pinned the old duplicate-refusal behavior that
  `TestSyncConsolidatesDuplicateAlerts` now supersedes with the heal
  contract. The refusal contract stays pinned in the shared
  `internal/githubissue` suite for callers that do not opt in.
- `docs/operations-runbook.md` documents the heal for operators.

## Verification

- `go test` for `internal/githubissue` and all four monitor commands:
  consolidation, eager-refusal, repeated-number, failed-close-resume, and
  every pre-existing refuse/close/reopen/create contract pass.
- `go test -race ./internal/githubissue/ ./cmd/...`: pass.
- `go vet ./...` and
  `golangci-lint run ./internal/githubissue/... ./cmd/...`: clean;
  `gofmt -l` reports nothing on changed packages.
- Full local verifier `bash .devcontainer/scripts/verify.sh`: pass
  (exit 0 on 2026-10-26; 1,022 node tests pass, 6 expected
  hosted-Windows skips; all Go suites and workflow checks pass).
- Live evidence after merge (observed on 2026-10-26):
  - PR #353 squash-merged as `a365fc996`; `main` stayed green (Build lock
    CI success on `a365fc996`; Dependabot auto-merge skipped as designed
    for non-Dependabot PRs).
  - The first scheduled `Reaper delivery audit` on the new commit
    (03:27:07Z) succeeded, and the run log states
    `Reaper delivery audit passed: healthy`.
  - The heal kept #345 as the oldest-open keeper and the healthy
    close-out wrote it closed with the healthy body; twins #346 and
    #347 closed state-only and still carry their own 2026-10-22
    evidence bodies.
  - All three alert issues are closed with state reason `completed`.

## Review

Two independent adversarial rounds reviewed the working tree. Every
finding carries a disposition; none remain open.

### Round 1: 9 findings — all remediated

- The shared walk ignored a number that repeats inside one listing, so a
  page-boundary re-listing could look like a twin cluster. Both walk
  modes now deduplicate by number.
- A fail-closed table case skipped its action and write assertions
  behind an early exit; a refusal now also proves no writes and no
  action.
- The runbook still said duplicate evidence wedges a monitor red and
  quoted a wrong reason; the heal paragraph also misstated what a failed
  heal leaves behind. Both paragraphs now state the implemented
  semantics.
- Two tests still named a refusal where the code heals:
  `TestRunHealsDuplicateAlertIssues` and
  `TestSyncIncidentIgnoresUntrustedMarkersAndConsolidatesDuplicates`.
- The lock-recovery keeper now pins its exact active-incident body and
  open state, not merely "not a state-only close".
- The record discloses the removed stale enrollment test and wording
  fixes; the shared table gained the close-retained consolidation case.
- INFO hygiene: the enrollment stub writes a response body on a titled
  patch; tense and plain-wording fixes in three monitor comments and in
  `applyDesiredState`'s doc comment.

### Round 2: 1 MEDIUM, 5 LOW, 3 INFO — all remediated

- The round-1 dedup itself was lazy in the refusal direction: `Find`
  collected every match before refusing, so a wedge paid for later pages
  and could surface a later reason instead of the first ambiguity. After
  review, `Find` walks in an eager-refusal mode with the prior
  single-alert contract (refuse at the second distinct match; keep the
  newest repeated-number copy), and consolidation keeps list mode, which
  keeps the first copy. Pins:
  `TestFindRefusesDuplicatesOnThePageTheyAppear`,
  `TestBothWalkModesTreatARepeatedNumberAsOneIssue`.
- The runbook promised that a failed heal keeps written closes and
  resumes, but no test injected a failure into the heal loop.
  `TestConsolidationResumesAfterAFailedTwinClose` now pins the failed
  close as the only write and the resumed heal on the next run.
- The reaper consolidation test counted writes but did not pin their
  payloads; it now asserts the twin close patches state only and the
  keeper carries the exact incident body and stays open.
- The shared consolidation table now pins patch body values.
- The runbook heal paragraph now states the no-write boundaries exactly
  (discovery failure, invalid evidence, page budget) and adds the
  all-closed-cluster reopen behavior.
- Record and comment polish: the verify-script line above records a real
  run; "in about two hours"; two comment phrases repointed for clarity.

The reviewer separately checked as sound: distinct identity markers
stop monitors from touching each other's alerts; no monitor consumes
`ActionConsolidated`, so no monitor can misclassify a heal; the reaper
refusal log grows only `jsonstrict.SanitizeCause`-filtered causes; and
flag-off callers keep the exact prior refusal contract.

Roles: this session implemented and remediated; an independent
reviewer agent produced both rounds. The loop stopped when the second
round listed no open finding after remediation.
