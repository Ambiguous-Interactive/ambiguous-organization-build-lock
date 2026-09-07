# Session 069: Darwin central-return admission contract

Date: 2026-09-07

## Objective and safety invariants

Advance the open issues by impact. Main CI was green, and the only open
pull request (#228, draft) is blocked by design on macOS evidence. The one
in-repo acceptance criterion still open on #153 was analyzer support:
"Add analyzer support only for the exact approved immutable action shape and
same-runner suffix." Invariants: fail-closed admission, immutable action
references, no authorization change, synchronized documentation.

## Baseline

- `origin/main` at `4ce58f5a7`; recent `Build lock CI`,
  `Organization Unity enrollment audit`, reaper, and recovery runs all
  green. No local drift except untracked session-068 dry-run clones under
  `consumers/` (removed; the repin script recreates them per run).
- `internal/enrollment/unity_policy.go` required every central-return job to
  carry literal `self-hosted` and `windows` labels
  (`windowsSelfHostedJob`). A Darwin job could never pass, so #153's Darwin
  half had no audit admission path.
- The `Repin consumer lock references` workflow has no runs yet; its first
  scheduled run is pending. Script guards were re-read; no defect found.
- Full Node suite: 838 tests, 835 pass, 0 fail, 3 platform skips (same as
  the session-068 baseline).

## Change: platform-aware central-return admission

- New reviewed policy list `approvedDarwinReturnShas` in
  `unity-enrollment-policy.json`. It starts empty. Validation reuses the
  return-SHA rules: full 40-character SHA, no duplicates, and each entry
  must also be an approved return SHA, which must also be an approved lock
  SHA.
- `windowsSelfHostedJob` was replaced by `returnRunnerPlatform` (exactly one
  supported family: literal `windows` or `macos`, plus literal
  `self-hosted`; missing, scalar, expression-bearing, dual-family, or
  family-less lists fail closed) and `centralReturnRunnerApproved` (Windows
  needs the platform; Darwin additionally needs every return reference in
  the Darwin allowlist).
- The check code stays `unsafe-return-execution-environment`. Windows
  behavior is unchanged for every single-family shape. One pathological
  shape tightens in the fail-closed direction: a dual-family list such as
  `[self-hosted, windows, macos]` was admitted as Windows before and now
  fails closed, and an expression-bearing label now poisons the platform
  instead of being ignored, because the audit cannot resolve it.
- `cmd/audit-unity-enrollment` now passes the Darwin list into the analysis
  policy. The registry round-trip validates it through the same analyzer
  path, so there is one interpretation of the allowlists.
- Documentation: `docs/consumer-enrollment.md` states the platform
  admission contract and the empty-until-authorized Darwin gate. The
  "required Windows runner" wording is now scoped to the Windows deletion
  mechanics sentence where it belongs.

The audit accepts the shape; it authorizes nothing. A Darwin return still
fails closed at runtime until PR #228's verifier release exists and a
reviewed merge lists its SHA in `approvedDarwinReturnShas`. That merge is
the "separate immutable SHA authorization" the #153 rollout evidence
requires.

## Evidence

- Red first: the new tests fail to compile against the unmodified policy
  (`ApprovedDarwinReturnSHAs` undefined), then the green implementation
  follows. `go test ./...` green.
- Mutation checks, each restored afterwards:
  - dropping the Darwin allowlist check reddened exactly
    `darwin_runner_without_darwin_authorization` and
    `darwin_runner_with_a_return_sha_lacking_darwin_capability`;
  - accepting `macos-latest` as Darwin reddened exactly
    `hosted_alias_label`.
- New data-driven coverage: authorized Windows runner under both policies,
  Darwin runner with authorization (including uppercase labels), and ten
  fail-closed runner mutations (no authorization, capability-missing SHA,
  dual family in both orders, hosted alias, no family, no self-hosted
  label, scalar `runs-on`, and expression-bearing labels beside and instead
  of a literal family). Registry mutations cover mutable, duplicate, and
  non-return-approved Darwin entries, plus round-trip retention.
- `test/documentation-policy.test.js` pins the new key's shape and that the
  enrollment contract documents it.

## Issue dispositions

- #153: the analyzer-support acceptance criterion is implemented here. The
  issue stays open: the team identifier read, the macOS canary, the SHA
  authorization, and the Windows-container half remain.
- #113: no central defect found. The repin workflow's first scheduled run
  is the next observable step; noted in `PLAN.md` M3.
- #83: the fail-closed class from session 068 re-verified through the full
  suite; no gap found. The capacity decision remains blocked on portal
  evidence.

## Validation

- `go test ./...`, `go vet ./...`, `golangci-lint run --timeout=5m`
  (0 issues), `go test -race ./...`: pass.
- `node --test test/*.test.js`: 838 tests, 835 pass, 0 fail, 3 expected
  platform skips.
- `node tools/llm-harness.mjs check`, workflow gates `javascript` and
  `shellcheck`, `go mod verify` and `go mod tidy -diff` for both modules,
  and `go run ./cmd/workflow-credential-audit .`: pass.

## Review

Adversarial self-review covered unsafe success paths (a Darwin return is
admitted only for a policy-listed SHA; the empty list cannot admit
anything; Windows shapes are byte-for-byte unchanged), stale documentation
(consumer contract and test pins updated together), generated-file drift
(no action runtime changed), credentials (none touched), and untested
boundaries (mutation checks above). One same-class sweep found the audit
command's direct policy construction and fixed it; no other
`UnityEnrollmentPolicy` construction sites exist. No unresolved findings.

## Continuous improvement

The substantial-work gate applied. No new `.llm` resource is warranted:
the platform admission contract is enforced by production tests in the
analyzer and the policy parser, and the authorization sequencing is
recorded in the consumer contract and `PLAN.md`.
