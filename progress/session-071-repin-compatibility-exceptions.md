# Session 071: Repin compatibility exceptions

Date: 2026-09-07

## Objective and safety invariants

Address open issue #233 in this repository. Issue #233 recorded that the
central repin automation moved the pins of unity-helpers' historical
`return-unity-license` wrapper to a classifier release whose input contract
the wrapper cannot satisfy. The repinned export ran, both cleanup classifiers
failed closed, and release quarantined a reservation as
`return-log-truncated`. The consumer-side removal of the wrapper is validated
in unity-helpers PR #739. The remaining in-repo follow-up is the automation
side: a pin-only update must not be able to recreate the invalid input
contract.

Invariants: no fail-closed path weakened, no authorization change, no action
runtime change, no new pin. The quarantine recovery was already complete
through the documented reaper path before this session (issue #233 comment at
14:09 UTC; lock-state commit `0a9a0d78` shows no reservations).

## Root cause

`rewrite_pins` rewrote every `uses:` line that names this repository, with no
way to record that one caller is not yet compatible with the newest
authorized release. The reviewed policy had no vocabulary for a file-level
repin hold. The repin pull request model assumes the consumer's own contract
suite gates adoption; unity-helpers showed that gate can be bypassed by an
export job that still runs.

## Change: reviewed, expiring `repinExceptions`

- `unity-enrollment-policy.json` gains `repinExceptions: []`. Each entry
  names one repository, one normalized `.github/workflows/` YAML path, a
  reason, a review owner, and an RFC3339 expiry.
- `internal/enrollment/unity_registry.go` validates every entry fail-closed:
  registered canonical repository, one top-level `.github/workflows/` YAML
  file with no line or Markdown-format control characters, non-blank
  single-line owner and reason, RFC3339 expiry, no duplicates. The registry
  parser rejects the whole policy for one malformed entry, so
  `resolve-scope` fails before any repin runs.
- `tools/workflows/repin-consumer-locks.sh` re-checks the same contract in
  the rewrite step for every entry, including entries for other
  repositories, so the standalone `rewrite-pins` CLI cannot accept a policy
  the registry parser would reject. It then skips excepted files. An expired
  or malformed entry for the target repository makes the rewrite exit
  nonzero for that repository, so the run stays red. Preserved files are
  printed to the run log, counted in the run summary, and listed in the
  repin pull request body with owner and expiry. An unexpired exception
  whose file no longer exists is reported to the run log as unmatched, so
  stale entries stay visible without blocking the repository; an expired
  orphan still fails the repository because expiry is checked first.
- The live policy ships with an empty list: unity-helpers removed the only
  incompatible caller (PR #739), so no exception is active today.

## Regression evidence

- New registry tests: one retained valid entry; fourteen rejected mutations
  (unregistered, non-canonical, non-workflow, non-YAML, nested, escaping,
  multiline path, backtick path, missing or multiline or backtick owner,
  missing or multiline reason, invalid expiry); duplicate rejection;
  distinct-path acceptance.
- New script regression named for the failure class: an excepted
  `legacy-return.yml` keeps its old pin while a sibling file repins; the
  report records the skip; the exception does not leak to another enrolled
  repository; an orphaned exception is reported as unmatched; eight fatal
  cases (expired, path outside workflows, non-RFC3339 expiry, duplicate
  entry, malformed entry for another repository, non-canonical repository
  spelling, unregistered repository, backtick in owner) each fail the
  rewrite.
- Existing repin test updated for the repository argument and the `skipped`
  and `unmatched` report fields; behavior without exceptions is unchanged.

## Verification

- `go test ./...`, `go test -race ./internal/enrollment/`: pass.
- `node --test test/*.test.js`: 839 tests, 836 pass, 0 fail, 3 platform
  skips.
- `go run ./cmd/audit-unity-enrollment --policy
  unity-enrollment-policy.json --validate-policy-only`: policy valid.
- `go vet ./...`, `golangci-lint run --timeout=5m`, `bash
  tools/workflows/ci.sh javascript`, `bash tools/workflows/ci.sh
  shellcheck`, `node tools/llm-harness.mjs check`: pass.

## Disposition

- The in-repo #233 follow-up is done. The consumer-side wrapper removal is
  merged in unity-helpers PR #739 (merge commit `93671a56`, 16:37 UTC), so
  the incompatible caller is gone from that default branch.
- Follow-up recorded as issue #234: the enrollment audit should report stale
  or expired repin exceptions. A target-release input-contract compatibility
  check could flag unsupported callers without a manual exception; it needs
  its own reviewed design and is not started.
