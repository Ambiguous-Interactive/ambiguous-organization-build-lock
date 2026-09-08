# Session 080: checkout credential hygiene, doc truth, dead-code removal

The goal sweep found no open CI failure and no unblocked issue in the
tracker. Every open issue waits on external evidence or a consumer
decision. This session fixed the three real defects an adversarial
exploration sweep found in the repository itself.

## Baseline

- `main` at `c38e844b0`. CI green (run 34268416578).
- `node --test test/*.test.js`: 871 pass, 0 fail, 6 skipped.
- No open pull requests here, no open Dependabot pull requests.
- All scheduled workflows green in the last 60 runs.

## RCA of observed red runs (no action needed)

- `Auto release` failed 2026-09-07 09:14 (run 34104911681) and
  2026-09-08 05:47 (run 34191956733). Both are pre-repair failures of
  the release train. Session 078 fixed the causes in #245 and #246
  (issue #244): a foreign `#738` reference broke the success-comment
  plugin. The run at 2026-09-08 06:14 succeeded and published v1.14.2.
- `Repin consumer lock references` run 34196638945 opened no v1.14.2
  offers. Root cause is ordering, not a bug: the run read `main` at
  06:52Z and the v1.14.2 authorization (#247) merged at 15:45Z. The
  target resolver saw v1.14.0 as the newest authorized release. The
  next scheduled run opens the fresh offers.

## Issue sweep (all blocked, none actionable here)

- #249, #231, #229 items 1-2: need the native macOS canary. The
  container is Linux; the canary is a hardware act by design.
- #229 item 3: needs Docker; this container has none, and the issue
  says not to start it here.
- #113: four consumer fix pull requests wait for consumer review.
- #83, #29: need portal evidence and live runner windows.
- #51: org-secret visibility and the reader `client-id` migration need
  an owner action; org secrets are not enumerable with this token.
- #44: item 7 needs a ruleset-readable credential; filed as a separate
  follow-up issue (see Follow-ups).

## Fix 1: no persisted checkout credentials outside the release checkout

Before this change, six workflows set `persist-credentials: false` on
every checkout, five more workflows ran checkouts that persisted the
workflow token, and `auto-release.yml` is the one documented exception.
No test locked the convention:

- `ci.yml` (three jobs), `devcontainer.yml`, `reap-stale-locks.yml`,
  and `recover-build-lock.yml` ran with the workflow token stored in
  the workspace git config. Nothing there pushes; the reaper jobs even
  receive App private keys in the same job.
- `onboard-unity-repository.yml` genuinely used the persisted token:
  `open_pr` pushed the enrollment branch with it. The push now uses a
  command-scoped credential helper that reads `GH_TOKEN`, the same
  reviewed pattern the repin script uses. The checkout persists no
  credentials.
- `auto-release.yml` stays the one documented exception: semantic-
  release pushes tags and the `v1` alias through the checkout origin
  (README, Auto release section).

`test/workflow-policy.test.js` now rejects any checkout without
`persist-credentials: false` in its own step block, in any workflow
except `auto-release.yml`, where it pins exactly one checkout and no
persisted credential.

## Fix 2: enrollment audit trigger facts

README and the operations runbook called the enrollment audit
"manually dispatchable". The workflow has no `workflow_dispatch` on
purpose, and `test/workflow-policy.test.js` locks that. An operator
following the old text would fail a dispatch. The manual path is the
`Request organization Unity enrollment audit` workflow, which the same
documents already describe.

## Fix 3: remove the superseded cancellation-policy command

`cmd/audit-cancellation-policy` had no caller, no documentation, and no
index entry. The central enrollment analyzer now emits
`unsafe-workflow-cancellation` and `unsafe-job-cancellation`, which
supersede it. Removed the command, its tests, and the `.gitignore`
entry. The tracked-binary guard in the policy tests covers the class.

## Verification

- `bash .devcontainer/scripts/verify.sh` (the complete local CI
  equivalent): pass. This includes actionlint on all workflows,
  shellcheck, golangci-lint (0 issues), `go test ./...`,
  `go test -race ./...`, `go vet`, `go mod verify`, both
  `go mod tidy -diff` checks, and `node --test test/*.test.js`.
- Node suite after the changes: 872 pass, 0 fail, 6 skipped (one new
  policy test).
- `go run ./cmd/workflow-credential-audit .`: passed.
- Commit subjects avoid `fix`/`feat`: no consumer-pinned action file
  changed, so no release train is warranted.

## Follow-ups

- Learning disposition: the checkout convention is enforced by the new
  workflow-policy test, and the auto-release exception is documented in
  the README. No `.llm` resource is needed for it.
- New issue: the #44 item 7 central merge-policy drift audit needs a
  credential that can read consumer rulesets, and no current App has
  that permission. The issue records the design and the decision ask.
- The four consumer fix pull requests stay merge decisions for their
  maintainers.
- The Darwin canary, authorization, and container work stay gated on
  hardware and authority (#249, #231, #229, #153).
