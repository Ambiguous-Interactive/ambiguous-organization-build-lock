# Session 070: Test determinism floors and the gofmt CI gate

Date: 2026-09-07

## Objective and safety invariants

Advance the open issues by impact. Open issue #229 carries three in-repo
"suggested improvements" besides its hardware-blocked canary and container
work. This session addressed all three. Invariants: no fail-closed path
changed, no authorization change, no action runtime change.

## Baseline

- `origin/main` at `10eba8d11`. Observed through the GitHub API: all six
  check runs on that commit finished success, with the Dependabot auto-merge
  check skipped as designed. Main CI is green.
- `gofmt -l .` named `cmd/workflow-credential-audit/main.go`. The drift was
  one mis-indented `if` at line 197. Logic was correct; only whitespace was
  wrong. `.golangci.yml` did not enable a formatter, so CI could not see it.
- `node --test test/*.test.js`: 838 tests, 835 pass, 0 fail, 3 platform
  skips, 0 cancelled. The #229 flake did not reproduce on Node 24.18.0.

## Change 1: gofmt hygiene plus a formatter gate

- Applied `gofmt` to `cmd/workflow-credential-audit/main.go`. Whitespace
  only.
- Enabled the `gofmt` formatter in `.golangci.yml`. Verified against the
  pinned golangci-lint v2.12.2: schema accepted, repo run reports 0 issues,
  and a deliberately misformatted file fails with `File is not properly
  formatted (gofmt)`. The failure mode cannot return silently.

## Change 2: deterministic settle paths for timer-bound tests

Issue #229 reported an event-loop drain flake: a test whose only settle path
is an unref'd timer can be cancelled when nothing else keeps the loop alive.

- Primitive reproduced outside the test runner: a script that awaits only
  `verifyUnityEditor` with a fake spawn exits before the unref'd 1 ms timer
  fires; the promise never settles. A second script confirmed
  `AbortSignal.timeout` also does not keep the loop alive.
- Sweep of all `unref` and `AbortSignal.timeout` sites in `.github/dist/`
  against their tests found three tests of this class:
  1. `test/unity-license-return.test.js` "Authenticode verification is
     bounded and terminates a hung verifier" (settles only through the
     unref'd verify timeout);
  2. `test/current-pr-head.test.js` "a caller cancellation signal does not
     disable the bounded request timeout" (settles only through the unref'd
     `AbortSignal.timeout(1)`);
  3. `test/build-lock.test.js` "a phase deadline that fires mid-request
     reports an unrecorded release" (settles only through unref'd phase
     deadline signals; found by the round-1 review sweep).
- All three now attach `.then` handlers that record the settled outcome,
  hold the loop with a ref'd delay that outlives the scheduled timers, and
  then assert. Round-1 review mutation-verified the pattern: with the
  production timeout disabled, each edited test fails loudly with outcome
  `null`. The tests cannot pass vacuously and cannot hang.
- The first build-lock floor of 400 ms was wrong and the suite caught it:
  the hang lives in the cleanup phase whose share is 1000 ms, so the
  assertion fired before settle. The floor is now 1200 ms with a comment,
  traced against the share arithmetic in `build-lock.js`.
- Production `unref` calls stay: they keep the action process from lingering
  on timers. This is a test-side fix per the fix philosophy.

## Change 3: durable lessons in the narrowest resource

`.llm/skills/testing-and-validation/SKILL.md` "Determinism and isolation"
gained two rules: never let a test settle only through a timer that does not
keep the loop alive (the ref'd delay is a keep-alive, not a timing
assertion), and a mutation scan needs red to prove coverage (a mutant that
cannot build or run is inconclusive, not covered). The restore-after-failure
rule already present covers the harness `finally` trap. Harness
`generate`/`check` run clean; no index drift.

## Validation

- `node --test test/*.test.js`: 838 tests, 835 pass, 0 fail, 3 expected
  platform skips, 0 cancelled. The two #229-flagged files were run
  standalone ten consecutive times: 46/46 each run.
- `go build ./...`, `go test ./...`, `go test -race ./...`, `go vet ./...`,
  `go mod verify` and `go mod tidy -diff` for both modules: pass.
- `golangci-lint run --timeout=5m` at the pinned v2.12.2 with the new
  formatter gate: 0 issues.
- `node tools/llm-harness.mjs check`, workflow gates `javascript` and
  `shellcheck`, and `go run ./cmd/workflow-credential-audit .`: pass.
- No `.github/dist/` file changed, so action runtime drift is impossible.

## Review

Two adversarial review rounds. Round 1 returned one MAJOR (the skill rule
 overstated an unreproduced node:test cancellation as universal fact) and
 three smaller findings (a missed same-class test, a contradiction with the
 no-real-sleep rule, over-long comments). All were applied: the rule now
 states the defensible invariant, the build-lock test was added to the fix,
 the contradiction is closed by an explicit sentence, and comments were
 trimmed. Round 2 verified the remediation, the 1200 ms floor against every
 settle path, and the class sweep, and approved with two cosmetic notes;
 one was applied (sentence split). The other confirmed both lint files are
 intended for this changeset.

The Bugbot PR review found one more gap in the phase-deadline test: the
`Promise.all` form still awaited the attempt after the floor fired, so a
production regression that removed the deadline could drain the loop and
cancel the test before the assertion. The test now awaits only the ref'd
floor; the recorded outcome carries the assertion and a missing deadline
fails loudly. Focused and full-file runs stay green (437/437, 0
cancelled).

## Issue dispositions

- #229: the three in-repo suggested improvements are implemented. The
  remaining items (native macOS canary, immutable SHA authorization, the
  Windows-container half) stay blocked on hardware and authority; the
  container half needs a real Docker daemon and must not start here.
- #231, #153, #113, #83: unchanged. Each is blocked on maintainer
  authorization, portal evidence, or consumer-side work as recorded in
  `PLAN.md`. No central defect was found for any of them.
- Draft PR #228 is untouched: it is blocked by design on macOS evidence.
