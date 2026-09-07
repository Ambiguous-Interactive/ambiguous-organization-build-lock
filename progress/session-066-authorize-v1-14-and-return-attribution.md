# Session 066: authorize v1.14.0, open authorization PRs, and attribute return failures

Date: 2026-09-06

## Objective and safety invariants

Achieve the standing goal: review the live open issues, prioritize by impact
and Unity CI churn, and fix the highest-priority safely actionable items.
Target at least two issues with root-cause analysis and fixes. Preserve
licensed-resource safety, queue fairness, fail-closed cleanup, immutable
action references, credential confidentiality, and operator-visible evidence.

## Baseline

- Local `main` was clean at `a3d0942f8`, one commit ahead of `origin/main`
  (`64bac4469`, the v1.14.0 release commit) with an unpushed `.gitattributes`
  LF-normalization change owned by the maintainer.
- The live central repository had nine open issues: #29, #44, #51, #53, #83,
  #113, #153, #222, #223.
- The live policy `unity-enrollment-policy.json` ended at
  `300501e91c9bec81bb9b5a977c22aa5bb2d9b649` (v1.13.0) in both allowlists.
- `docs/operations-facts.json` and `docs/operations-runbook.md` still named
  v1.10.0 (`3741b56c`) as the published compatibility release.

Triage kept #29, #44, #51, #53, #83, #113, and #153 open: each needs
organization-owner authority, consumer-side edits, paid Unity canaries,
multi-week live evidence, or new platform cleanup authorities outside this
repository. #222 and #223 were safely actionable here and are addressed below.

## Issue #222 root cause and fix

Root cause: releases are published automatically by `Auto release`
(semantic-release, weekly cron), but consumer authorization is a separate
hand-written policy commit. The two clocks are independent. v1.14.0
(`64bac446903115134dca8235410b332bc5a83547`) was released 2026-08-31 and
remained unauthorized, so consumer bumps (for example IshoBoy#827, 30 pins)
failed closed with `unapproved-lock-ref` and nothing in a consumer repository
could unblock them. A second finding: the operational facts and runbook still
described v1.10.0 as the published release, so the documentation lagged two
releases behind the policy.

Fix, in three parts:

1. Authorize v1.14.0: the release SHA was added to both `approvedLockShas`
   and `approvedReturnShas`. The authorization diff
   (`300501e9..64bac4469`) changes only the three committed action runtimes
   from reviewed PR #215 (`return-command-failed` preservation) plus docs,
   progress, devcontainer, and Go-analyzer commits without public action
   surface changes.
2. Automate the authorization pull request: `Auto release` now opens an
   `Authorize vN.N.N release adoption` pull request after each release
   (new script `tools/workflows/open-release-authorization-pr.sh`). The
   script resolves the release tag to a full SHA, skips when already
   authorized or already proposed, adds the SHA to both allowlists on a bot
   branch, opens the pull request with a bounded review checklist and the
   changed public action/runtime file list, and dispatches `Build lock CI`
   on the branch so the pull request shows real hosted results. The script
   never merges, never edits the live policy on `main`, and never approves
   anything by itself. Merging stays the human authorization decision, which
   keeps `approvedReturnShas` meaningful.
3. Document the decision point: `docs/consumer-enrollment.md` gained a
   "Release authorization" section, and the runbook and facts now record
   v1.14.0 as the published release.

## Issue #223 root cause and fix

Root cause analysis of the two questions the issue raises:

1. Was the failing return an unrecognized 400006? Deterministically no, given
   recorded evidence. The v1.14.0 classifier tests `20111`, then capture
   completeness, then `400006` before any generic failure reason. The
   occurrence recorded `evidence-capture-complete: true` and classified as
   `return-command-failed`, so the classifier's `400006` scan did not match
   the captured evidence. A `return-command-failed` verdict at v1.14.0 can
   never co-occur with a captured `400006`; issue #83's counts are not
   undercounted through this path.
2. Why did the operator still learn nothing? Because the generic verdict
   carried no attribution. The classifier fell back to
   `return-command-failed` without stating which licensing codes it scans
   for or whether any matched, so consumers could not distinguish the two
   hypotheses above from job evidence alone.

Fix: the central classifier now emits two bounded outputs on every verdict:
`licensing-codes-checked` (constant `20111,20113,400006`) and
`licensing-code-matched` (the highest-precedence code present, or `none`).
The action manifest, runtime, fail-closed default outputs, and operator log
all carry the attribution. No log content, path, or new evidence exposure is
added. `return-command-failed` with `licensing-code-matched=none` is now
direct runtime proof that the failure was not an unrecognized 400006.

The remaining #223 acceptance items stay open: whether a peer acquisition or
activation can invalidate a live incumbent's seat requires portal-side and
cross-runner evidence this repository cannot produce, and reconsidering
#106 part 2 is a maintainer policy decision.

## Validation

Red/green and full-suite evidence:

- `node --test test/*.test.js`: 827 tests, 824 passed, 0 failed, 3 expected
  platform skips. New coverage: classifier attribution verdicts (including
  `return-command-failed` with `licensing-code-matched=none` and precedence
  cases), completed classifier output lines, the authorization pull-request
  workflow contract, and updated script and manifest inventories.
- Functional dry run of `open-release-authorization-pr.sh` in a scratch clone
  with a stubbed `gh`: correct tag resolution, both-allowlist mutation byte
  identical to the manual authorization, bot commit and branch push,
  pull-request body content, `Build lock CI` dispatch call, and the
  already-authorized early exit.
- `node tools/llm-harness.mjs generate` and `check`: passed.
- `go test ./...`, `go test -race ./...`, `go vet ./...`,
  `golangci-lint run --timeout=5m` (0 issues), `go mod verify` and
  `go mod tidy -diff` for both modules, `actionlint`,
  `bash tools/workflows/ci.sh javascript`, `bash tools/workflows/ci.sh
  shellcheck`, `go run ./cmd/workflow-credential-audit .`, and
  `git diff --check`: all passed.

## Review

Adversarial self-review covered unsafe success paths (script cannot merge or
authorize by itself; classifier keeps fail-closed ordering), credential
exposure (token only through the `GH_TOKEN` step environment; no token text
in URLs or script), documentation drift (facts, runbook, enrollment doc, and
policy updated together), generated-file drift (index regenerated), and
untested boundaries (authorization idempotency and policy mutation exercised
in the dry run; hosted `gh` behavior remains a runtime dependency of the
existing workflow pattern). No unresolved findings.

## Continuous improvement

The substantial-work gate applied. Durable guidance added this session is the
user-facing writing rule (Simplified Technical English for pull requests,
comments, and similar copy) recorded in `.llm/context.md` with a pointer from
the operations-and-documentation skill. The authorization and attribution
behavior itself is enforced by the production contract tests, so no competing
`.llm` rule is warranted for them.

## Delivery

Local commit on `main`, prepared for pull-request delivery and protected-main
verification. Network publication (push, pull request, issue comments on
#222 and #223, and the hosted `Build lock CI` run) requires credentials that
this session did not have; the sanitized draft issue comments are part of the
handoff.
