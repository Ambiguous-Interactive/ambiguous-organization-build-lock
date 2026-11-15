# Session 133: readable cleanup failures and DxAudio onboarding

Date: 2026-11-15

Issues: #360, #363. Pull requests: #364 (central fix), #365 (enrollment),
Ambiguous-Interactive/DxAudio#11 (consumer workflow).

## Objective and safety invariants

Carry the GOAL.md directive: rank open issues by impact with the least Unity CI
churn, complete the highest-priority safe work, and drive it green. The
operator also asked for DxAudio onboarding.

Safety invariants: no fail-closed path is weakened; the classifier reads,
digests, and classifies only after it claims the exact return evidence; the
licensed cleanup suffix stays exact; the enrollment registry stays the only
authority for paid consumers.

## Baseline

- `main` at `f556633883` was clean and green.
- 17 open issues, no open pull requests. #363 was filed 2026-11-15.
- The scheduled reaper, incident recovery, and enrollment monitors were green.
- `node --test test/*.test.js` on this macOS host: three release-diagnostic
  cases fail because `/bin/bash` 3.2 has no `mapfile`. They are unchanged by
  this session and run on the Linux CI runner.

## Priority

1. #360: a green consumer run fails on a return log nobody can read. Two runs
   spent a seat each. Central fix, no consumer churn.
2. #363: DxAudio is the operator-requested new consumer. It needs a licensed
   workflow, one ruleset, and two reviewed central policy entries.
3. The remaining issues stay blocked on owner authority, ruleset authority, or
   licensed evidence, as `PLAN.md` records.

## Change 1: #360

- A classification failure reports `cleanup-evidence-unknown` and prints its
  bounded, sanitized cause. `return-log-truncated` stays reserved for a
  completed read with incomplete capture.
- A verdict other than `cleanup-confirmed` prints a bounded tail (4096 bytes,
  40 lines) of the verified return log. The return action redacts that log
  before it writes it. Control characters and workflow commands are
  neutralized.
- `require-confirmed-unity-cleanup` states the seat and the lock separately, so
  a freed seat with an unwritten lock record does not read like a held seat.
- An evidence-capture overflow now names that cause in the return action.

## Change 2: #363

- Workflow `Request Unity repository onboarding` ran for DxAudio at target head
  `da86016bfe50130d2618b0f6fec4d08ef7e75817`. The reader App check passed.
- That run pushed its branch but could not open a pull request: the
  organization refuses pull requests created by GitHub Actions (#244). A
  maintainer opened the branch as #365, and the onboarding workflow now mints a
  repository-scoped writer-App token for that step so the next run needs no
  manual step.
- #365 adds the reviewed `requiredContexts` for DxAudio and its
  `merge-policy-expectations.json` entry. The audit and retrieval tests now
  derive the repository count from the registry.
- DxAudio#11 adds `unity-tests.yml`, `scripts/unity/run-editmode-tests.ps1`,
  and the merge-policy attestation for live ruleset `27288634`. The test script
  creates a disposable project that includes the audio module. The central
  analyzer reports zero DxAudio findings at its head commit.
- The workflow first failed on the editor invocation, and the new redacted tail
  named each cause. Two fixes followed: stream the editor log with
  `Tee-Object`, and test the 6000.5 editor the fleet already runs. The final
  run on `c63c17c` passed both legs and reported `Unity CI Success`.
- The licensed jobs started only after both RAM-64GB runners freed. The reader
  App proved the Default group is visible to DxAudio, and both runners reported
  `busy=true` on work outside this repository.

## Validation

- `go test ./...`: pass.
- `node --test test/unity-cleanup-evidence.test.js test/unity-cleanup-gate.test.js test/unity-license-return.test.js`:
  147 pass at the merge commit, 149 after the follow-up tests.
- `node --test test/workflow-scripts-0.test.js test/workflow-policy.test.js test/documentation-policy.test.js`:
  150 pass.
- `node --test test/*.test.js` on this macOS host: 1027 pass, 3 fail. The
  three are the release-diagnostic cases that need Bash 4 `mapfile`; they are
  unchanged by this session and run on the Linux CI runner.
- Central analyzer over committed consumer snapshots: DxAudio findings 0 at
  consumer head `01afea6b`.
- Local Unity 6000.5.2f1 probe of the consumer test project: package and
  `Tests/Editor` compile with no error, and 92 of 92 EditMode tests pass. The
  probe used the same manifest and `testables` entry as the workflow.
- `node tools/llm-harness.mjs check`, `go vet ./...`, `bash tools/workflows/ci.sh javascript`,
  and `go run ./cmd/workflow-credential-audit .`: pass.
- Merged on `main`: #364 at `38edf531d1`, #365 at `a0fe05b78c`. Build lock CI
  is green on both commits.

## Remaining monitor state

- `Organization Unity enrollment audit` is red because unity-helpers'
  default branch names a local action file that is absent from its snapshot,
  so the audit reports `repository-analysis-incomplete` and `complete=false`.
  This is consumer drift, and it predates this session (red since 2026-11-10).
- `Organization merge-policy audit` reports 6 findings and `complete=false`.
  Five are pre-existing: four `unexpected-required-check-source` reads that
  return App ID 0, and one qora-redux `missing-required-context`. The sixth is
  DxAudio's missing attestation, which clears when DxAudio#11 merges.
- DxAudio's two licensed jobs wait for a self-hosted Windows runner. The
  reader App proves the Default group is visible to DxAudio and both
  RAM-64GB runners are `busy=true`.

## Continuous improvement

No durable LLM resource promoted. The return-evidence contract in
`docs/consumer-enrollment.md` item 7 already owns the rule; this session made
the text match the code.

## Disposition

- #360: fixed by #364 at `38edf531d1`, with the pinned diagnostics tests in
  #368 at `0ad530317d`. Build lock CI is green on both.
- #363: complete. The registry and merge-policy entries are merged in #365.
  DxAudio#11 merged at `f86874b1690f62029d40ff58e519ffbef9a648c4` after a
  DxAudio PR run reported `Unity CI Success` with both EditMode legs green.
  The enrollment audit (`43675412968`) reports no DxAudio finding at that
  commit, and the merge-policy audit (`43675382033`) is complete with no
  DxAudio finding.
- Follow-up: #369 is fixed by #372 at `abe0f0a907`. The enrollment audit
  (`43676607331`) is now complete with `complete=true` and no DxAudio finding.
- DxAudio `main` advanced to `ffea43cb` after the merge, and its `Unity Tests`
  run on that head passed. Onboarding is live, not just merged.

