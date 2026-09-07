# Session 075: audit head-race refresh and the head-revalidation codes

Date: 2026-09-07

## Objective and safety invariants

Advance PLAN.md toward a green PR. Merge latest origin/main. Address open
issues by impact. Keep main CI green.

Invariants: no fail-closed path weakened, no authorization change, no pin
change, no lock-state edit, no policy-list edit.

## Baseline

origin/main at `2c3330a05` (#238). Working tree clean. Build lock CI green
(run 34164453755). The scheduled enrollment audit on the same commit failed
(run 34164453758). One red run in the sampled 40-run window.

## Failure RCA: scheduled audit red on main

Run 34164453758 failed at `Revalidate default-branch heads` and
`Record sanitized audit counts`, both exit 1.

Observed evidence:

- DoxReloaded pushed `7712304a` at 21:49:24Z. The audit had cloned
  DoxReloaded at `42b3328f` minutes earlier.
- The `revalidate-heads` step ran at 21:49:53Z, saw the advanced head, and
  recorded `default-branch-advanced` through `record_finding`.
- The artifact shows `complete: false`, 64 findings (63 real + 1
  revalidation), and the drift issue updated with "Retrieval: incomplete
  (fail closed)".

Conclusion: the fail-closed head-revalidation guard worked as designed. The
defect is not the guard; it is that one mid-run consumer push left main red
for up to a day (next scheduled run 08:23 UTC). A race is transient; the
correct response is to refresh the stale snapshot inside the same run, not
to report stale evidence.

## Change 1: bounded in-run head refresh

`tools/workflows/unity-enrollment-audit.sh`:

- `revalidate_heads` now loops up to 3 attempts.
- Each attempt revalidates every enrolled head and records stale
  repositories in a `RUNNER_TEMP` ledger.
- If an attempt finds stale snapshots and attempts remain, the script
  re-clones only the stale repositories at their default branch, re-runs
  `go run ./cmd/audit-unity-enrollment` to rewrite the artifact from the
  refreshed tree, and revalidates again.
- If the final attempt still finds stale evidence, the script prints the
  fail-closed reason and exits 1. The artifact keeps the revalidation
  findings with `complete: false`. The uploaded evidence, drift issue, and
  `record-counts` failure are unchanged from the previous behavior.

The guard is not weakened: a reconciled refresh publishes only evidence
whose heads matched at report time. Persistent races still fail closed.

Red-green: the new tests fail against the previous script (which had no
refresh), pass with it.

Tests in `test/workflow-scripts.test.js` use `git`, `gh`, and `go` shims
with state files. They cover: all heads match (no clone, no analyze), one
advanced head (one re-clone plus one re-analyze, then green), a branch that
advances past every refresh (2 refresh attempts, then exit 1 with the
finding retained), and a head read that keeps failing (exit 1 with two
`default-branch-revalidation-incomplete` findings retained).

## Change 2: document the shell-emitted finding codes

Gap found during triage: `default-branch-advanced` and
`default-branch-revalidation-incomplete` are emitted only by the audit
shell script. The finding-code contract documented 62 codes from the Go
emitters and did not know these two, although the live drift issue renders
them. A consumer reading the issue table found no fix row.

- `docs/consumer-enrollment.md` gains both rows as central audit-health
  codes and the intro sentence now says the repository and
  head-revalidation codes are not consumer drift.
- `test/documentation-policy.test.js` now extracts `record_finding` codes
  from the audit script and requires the same exact-set equality as for
  the Go emitters. Documented codes: 64.

Red-green: removing the `default-branch-advanced` row fails the sync test
with "the analyzer emits reason codes that the consumer contract does not
document"; the restored row passes.

Sweep for the same class: the audit artifact's findings come only from the
Go analyzer and this script. No other script or action emits audit finding
codes. `docs/operations-runbook.md` records the refresh behavior next to
the revalidation sentence.

## Issue work

- #113: the drift alert path is now race-resilient and its two
  head-revalidation codes have documented fix rows.
- #229: the three "suggested improvements" boxes are checked with an
  evidence comment. Each was already done on main: #232 added the ref'd
  keep-alive floors and the gofmt gate; the mutation-harness traps live in
  `.llm/skills/testing-and-validation/SKILL.md`. Items 1 (native macOS
  canary) and 2 (reviewed `approvedReturnShas` merge) stay blocked on
  hardware and authority.
- #228 (draft PR) stays draft by plan: all three checks green; the native
  macOS canary is a human and hardware act.
- #231, #153, #83, #53, #51, #44, #29: still blocked on hardware, portal,
  or organization-owner authority, per the 2026-09-06 and 2026-09-07
  triage records.

## Transient recovery

The failed run was re-run (`gh run rerun 34164453758`) after the DoxReloaded
push settled. The rerun re-cloned at the new head and completed green. Main
is green again while the durable fix prevents the next day-long red.

## Validation

Observed on the session branch:

- `node tools/llm-harness.mjs check`: pass.
- `node --test test/*.test.js`: 844 tests, 844 pass, 0 fail, 0 cancelled,
  3 skipped (the pre-existing conditional skips).
- `go test ./...`: pass. `go test -race ./...`: pass.
- `gofmt -l .`: empty. `go vet ./...`: clean.
- `golangci-lint run --timeout=5m`: 0 issues.
- `go mod verify` and `go -C tools/actionlint mod verify`: all verified.
- `go mod tidy -diff` and `go -C tools/actionlint mod tidy -diff`: no diff.
- `bash tools/workflows/ci.sh javascript`: pass.
- `bash tools/workflows/ci.sh shellcheck`: pass (also run directly on the
  changed script).
- `go run ./cmd/workflow-credential-audit .`: policy passed.

## Adversarial review disposition

- Does the refresh hide real drift? No. A refresh re-clones and re-analyzes;
  the published artifact lists findings only at the refreshed heads, and the
  head check runs again after every refresh. Evidence that cannot reconcile
  still fails closed with the finding retained.
- Can the loop spin? No. The loop is bounded at 3 attempts with no
  environment override.
- Does the refresh reuse a stale artifact if the analyzer fails? If the
  re-analyze fails, the artifact keeps the current attempt's findings with
  `complete: false`, and `record-counts` fails the job. No green path.
- Is the ledger file a leak? It holds repository names and branch names
  only, lives in `RUNNER_TEMP`, and is removed on every path.
- Are the shims test-only? Yes. They live in the test file and no
  production hook was added to the script.
