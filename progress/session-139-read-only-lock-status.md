# Session 139: read-only lock status operation

Date: 2026-11-15

Issues: #387, #375, #113.

## Baseline

- `main` at `f816cdb19e`; the last twelve `main` runs pass.
- No open pull request in this repository.
- Focused Node tests pass: `build-lock-0/1/2` 461 tests, manifests and
  workflow policy 144 tests.
- Twenty-three Node tests fail on an unmodified `HEAD` worktree. They are the
  macOS `/var` path and git-release fixtures. They are not caused by this
  session.

## Open-issue priority

The order favours impact against Unity CI churn.

| Order | Issue | Impact | Unity CI churn |
| --- | --- | --- | --- |
| 1 | #387 read-only status operation | Any consumer can name the incident or quarantine that blocks admission without a write or a licensed run. | None. Central runtime, manifest, workflow, and tests only. |
| 2 | #375 Dependabot pin guard | Closes the last consumer gap. IshoBoy #1701 is green and mergeable. | None. One Dependabot ignore line per consumer. |
| 3 | #113 enrollment drift | 22 findings remain: 14 DxMessaging shape findings and 8 expired exceptions. | High. It reshapes DxMessaging Unity jobs and needs an owner exception renewal. |
| 4 | #379 merge queue adoption | Repin DoxReloaded and add `merge_group`. | Medium. It needs a consumer trigger change after an authorized release. |
| 5 | #335 actionlint YAML | Removes a pinned dependency. | None, but blocked until the pinned linter supports the newer API. |
| 6 | #51, #83, #53, #29, #153, #229, #231, #249, #277, #278, #334 | Each needs owner authorization, live-run evidence, or portal evidence. | Unknown until the evidence exists. |

Session 139 takes #387. #375 is closed by merging the existing green consumer
pull request.

## Change

`operation=status` on `recover-build-lock.yml` and on the `reap-stale-locks`
action.

- It reads the public `lock-state` branch and the lock config with GET requests
  only. It mints no token, so it cannot write.
- It proves the lock repository is readable before it may report an empty lock
  as open. An unreadable source fails closed.
- It names the active incident, or the quarantine that consumes the last slot,
  or neither.
- It prints the holders, the reservations, the free capacity, the waiting queue,
  and the last successful scheduled reaper run.
- It publishes `admission`, `blocking-cause`, `incident-id`,
  `blocking-reservation-ids`, `free-capacity`, and `last-reaper-at`.
- A consumer repository may run it, because it cannot change admission.
- `fetchApi` now omits the `Authorization` header when no credential exists.
  Before, it sent the literal text `Bearer null`.

## Validation

- Focused Node tests: 593 pass, 0 fail.
- `node tools/llm-harness.mjs check`: pass.
- `go test ./...`, `go vet ./...`, `go mod verify`: pass.
- `go run ./cmd/workflow-credential-audit .`: pass.
- actionlint over all workflows: no findings.
- `bash tools/workflows/ci.sh javascript`: pass.
- shellcheck is not installed on this macOS host and its installer needs
  `sha256sum`. The change adds no shell code.

## Review findings and dispositions

An independent adversarial review found these issues. All are fixed in
`744e8fa`.

- Unproven lock config: status published the safe default `max-holders=1` as a
  fact when the config read failed. `readLockConfig` now has a `requireProof`
  mode that fails red. Status uses it.
- Anonymous probe diagnosis: the error claimed a credential problem for every
  failure. It now names the failed proof only.
- Empty-lock proof: a repository 404 already failed closed. A new test pins the
  other side: a readable repository with no state file reports a proven empty
  lock.
- Cooldown in `blocking-reservation-ids`: recovery accepts a quarantine only,
  so status now names quarantines only.
- Reaper run proof: the query now filters `event=schedule`, and the code
  rejects a run that is not a scheduled run. CodeRabbit asked for the same fix.
- Token scope: a new test proves that the optional token is used for the
  Actions read only, and that every contents read stays anonymous.
- Token minting: a child-process test proves that the real reap entrypoint
  with `operation=status` needs no App key. It returns a null token and a null
  reader token.
- Step summary rendering: peer-written values now use `summaryCell`.
- Contract tests: the manifest inputs are parsed instead of matched as loose
  prose, and the recover job's `actions: read` permission is asserted.

One dependency remains: #335 waits for upstream actionlint support.

