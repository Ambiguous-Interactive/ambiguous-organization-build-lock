# Session 074: modal-free GitHub auth rules and the finding-code contract

Date: 2026-09-07

## Objective and safety invariants

Advance PLAN.md toward a green PR. Merge latest origin/main. Address open
issues by impact. Record the operator-directed GitHub credential rules.

Invariants: no fail-closed path weakened, no authorization change, no pin
change, no lock-state edit, no policy-list edit.

## Baseline

origin/main at `c4cc9dcb1` (#237). Working tree clean. Build lock CI on main
green (run 34152994363). All sampled scheduled workflows green: reaper,
reaper delivery audit, incident recovery audit, enrollment audit
(run 34152567354).

Local verification on the session branch: see Disposition.

## Operator directive: never repeat credential prompts

The operator reported that this session prompted for GitHub credentials more
than once. Each prompt opens a modal and interrupts the operator.

Root cause, from observed state:

1. The token cache `~/.config/gh/token` already existed from session 073.
   This session never checked it and called `git credential fill` directly.
2. The devcontainer writes the VSCode remote-containers helper into
   `/etc/gitconfig`. A system-level helper runs before the global
   dispatcher, so every fill reached the VSCode helper and opened a modal.
   The dispatcher could never answer.

Fixes:

1. Session behavior: all `gh` calls read `GH_TOKEN` from the cache file. No
   credential-helper call happened after the directive.
2. Environment repair (once, outside the repository):
   `credential.https://github.com.helper` was reset to the dispatcher with an
   empty-helper entry first. Observed: `git credential fill` for
   `github.com` returns from the cache in 15 ms with no modal.
3. Durable knowledge: `.llm/context.md` working method gains step 0 (read the
   cache; follow the `github-cli-auth` skill before any `gh` call). The skill
   gains the cache-first rule, the no-fill-per-command rule, the
   no-fill-in-wrapper rule, and the `/etc/gitconfig` precedence repair.

One token value was printed into the session transcript by a failed
redaction filter early in the session. No token entered the repository. The
operator can rotate the token through the VSCode session if desired.

## Issue work: #113 finding-code contract

Triage state: #231, #229, #153, #83, #53, #51, #44, #29 stay blocked on
hardware, portal, or organization-owner authority, per the session 066-073
triage records. #226 closed at 01:31 UTC; PLAN.md M1 now records the
outcome. Draft PR #228 stays draft by plan (checks green, no reviews, needs
a native macOS canary).

#113 is the one open issue with in-repo work. The drift issue reported 63
findings across five consumers, but the central repository published no
per-code fix contract. A consumer had to read Go source to learn what
`cleanup-gate-inputs-not-typed` means.

### RCA of the live findings (evidence, not inference)

- qora-redux reports `missing-unity-aggregate` and
  `missing-fallback-aggregate` even though its `unity-ci` aggregate exists.
  Reading `typedValidationGateEnforces` and `validationPreflightMatches`
  (internal/enrollment/unity_policy.go:5004) shows the exact-shape validator
  requires the preflight job to hold exactly one step. qora's preflight job
  carries a second `require-current-pr-head` step, so the aggregate is not
  recognized and both findings fire. True positive under the reviewed
  contract; the fix is a consumer-side job split. No analyzer defect found
  in the sampled codes.
- DoxReloaded `unapproved-lock-ref` uses a different pin than the approved
  qora pin; the open repin PR #801 carries the fix.
- All sampled findings reduce to consumer-side contract edits.

### Change

1. `docs/consumer-enrollment.md` gains a `Finding codes` section: 62 reason
   codes, each with a one-line fix that references the contract item. The
   two `repository-*-incomplete` codes are audit-health codes; their rows
   name the central repair path, not a consumer edit.
2. `test/documentation-policy.test.js` gains a bidirectional sync test. It
   extracts emitted codes from `internal/enrollment/analyzer.go`,
   `unity_policy.go`, and `cmd/audit-unity-enrollment/main.go` (`.add`
   literals, `guardFindingCode` arguments, its kebab-case return, and the
   `Code:` literals) and requires exact set equality with the documented
   table. A new reason code cannot ship without a documented fix, and a
   documented code cannot outlive its emitter.
3. `cmd/sync-unity-enrollment-issue/main.go` links the contract from the
   drift issue body. `main_test.go` asserts the link stays present.

Red-green: the sync test failed before the doc section existed; it passes
with the 62-row table. The exact-62 result confirms the table covers every
emitted code and no extra code.

### Independent adversarial review

A separate reviewer sub-agent examined the branch. Findings and
dispositions:

1. Blocker: `cmd/audit-unity-enrollment/main.go` emits
   `repository-retrieval-incomplete` and `repository-analysis-incomplete`
   outside the tested sources, so the issue-body sentence was false on the
   fail-closed path. Fixed: both codes documented with central repair
   guidance, the command joined the sync test, PLAN.md corrected to 62.
2. Should-fix: the `invalid-current-head-guard` row described the wrong
   trigger. Fixed: the row now says to pin the guard action to the approved
   SHA.
3. Should-fix: the `job-scoped-unity-credential` fix missed the
   fallback-cleanup path, which rejects any job `env`. Fixed in the row.
4. Should-fix: `approval-environment` fires for any `environment`, not only
   approval-only ones. Fixed in the row.
5. Should-fix: the skill's repair-verify command could hang and printed the
   credential. Fixed with a stdin-fed, redirected form.
6. Nit: the issue-body link is the only relative link in an issue body.
   Kept relative on purpose: GitHub resolves it against the default branch,
   and the contract is a living reviewed document. No change.
7. Nit: sync-test section parsing and return-literal breadth are latent
   fragilities. Hardened the section bound at the next heading; accepted
   the residual risk, which the record above already discloses.
8. Nit: skill prose stated the fresh-shell fact and the no-fill rule too
   broadly. Qualified both.

Second review round: all findings verified fixed, 62 documented codes equal
62 extracted codes, no new code findings. The round flagged one process
blocker, the uncommitted remediation state; the state is committed now.
The reviewer's test-source-index nit is fixed with a named variable.

## Validation

Observed on the session branch after all changes:

- `node tools/llm-harness.mjs check`: pass.
- `node --test test/*.test.js`: 840 tests, 837 pass, 0 fail, 0 cancelled,
  3 skipped (the skips are the pre-existing conditional skips).
- `go test ./...`: pass. `go test -race ./...`: pass.
- `gofmt -l .`: empty. `go vet ./...`: clean.
- `golangci-lint run --timeout=5m`: 0 issues.
- `go mod verify` and `go -C tools/actionlint mod verify`: all verified.
- `go mod tidy -diff` and `go -C tools/actionlint mod tidy -diff`: no diff.
- `bash tools/workflows/ci.sh javascript`: pass.
- `bash tools/workflows/ci.sh shellcheck`: pass.
- `go run ./cmd/workflow-credential-audit .`: policy passed.

## Adversarial review disposition

- Does the sync test give false confidence? It parses Go source with
  regexes, so a future dynamic emission with a different shape could evade
  it. Accepted: the patterns cover the current emission surface, and a
  dynamic code would still flow through `.add` or `guardFindingCode`.
- Does the doc table weaken policy? No. It documents existing behavior and
  cites existing contract items. The test only enforces documentation
  completeness.
- Does the issue-body link leak anything? No. It is a relative repository
  link to a public contract document. The body-bound tests still pass.
- Could the environment repair surprise the operator? It is scoped to
  `github.com` credentials and restores the documented zero-modal dispatcher
  design. The repair commands are recorded in the skill for reversibility.

## Disposition

Open issues advanced: #113 (finding-code contract published and linked;
per-code RCA recorded), #226 (closed upstream; PLAN.md M1 reconciled). All
other open issues remain blocked on evidence or authority outside this
repository. Session PR carries the auth-knowledge commit and this work in
one branch.
