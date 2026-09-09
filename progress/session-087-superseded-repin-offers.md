# Session 087: superseded repin offers close themselves

## Task

Address issue #261 follow-ups 1 and 2: close open repin offers the default
branch already outruns, and publish the consumer verdict-compare contract.

## Baseline

- Central `main` at `861414aab`: Build lock CI, enrollment audit, merge-policy
  audit, reaper, and incident-recovery runs all green (runs 34391709588,
  34391709725, 34391709571, 34392113956, 34391778702).
- No open central pull requests. Session 086 merged as #262.
- Issue #261 tracked three follow-ups from session 086. Items 1 and 2 are
  central work; item 3 (DoxReloaded companions) is probe-based and waits for
  its next repin offer.
- DoxReloaded #801 had stayed open and red for a day: its default branch
  adopted v1.14.2 through merged #810, so the older v1.14.0 offer could never
  merge, and no automation step closed it.

## Change 1: the repin run closes its own superseded offers (#261 item 2)

`tools/workflows/repin-consumer-locks.sh` now proves supersession in the run
itself. When the rewrite moves no pin and no companion line, the default
branch needs no lock-pin change to reach the authorized release. The run then
closes every open pull request on the automation's `automation/repin-lock-`
branch prefix with a comment that names the release, records the count in the
run summary, and stays green.

Safety properties, each covered by a test:

- The close scan runs only when the rewrite moved nothing, so an offer that
  still carries needed work is never closed ("keeps offers open while the
  default branch still needs the pin").
- The close list filter matches only the automation's exact branch grammar
  `automation/repin-lock-<7 hex>`. A fixture offer with a foreign head
  branch (`consumer/own-work`) is never closed. The test harness answers
  the script's own `--jq` filter with real `jq`, so the ownership filter
  runs for real and cannot be deleted while the suite stays green.
- Closed branches stay untouched, and a closed offer never re-opens; a
  future release opens a new offer, mirroring the consumer closed-offer
  rule. A closed offer is final for its target whoever closed it; a manual
  reopen is the recovery path.
- A failed close fails the repository and the run closed
  ("fails closed when a superseded offer cannot be closed").
- The comment carries only the release label and SHA, both derived from the
  reviewed policy and the tag grammar; no credential or unbounded input.

## Change 2: the verdict-compare contract is published (#261 item 1)

`docs/consumer-enrollment.md` gains canary item 11: consumer tests that read
a central runtime verdict must assert the reviewed fields and tolerate
reviewed additive fields. A deep-equal of a whole verdict object turns every
reviewed central addition into a consumer break, and the repin offer that
carries the addition goes red. Onboarding reviews sweep for strict verdict
compares before a repository joins the enrollment.

## Documentation

- `docs/consumer-enrollment.md`: the repin paragraph states the supersession
  rule; canary item 11 records the verdict-compare contract.
- `docs/operations-runbook.md`: the repin automation section states when the
  close happens, what the comment names, and the summary row.

## Adversarial review round

An independent adversarial review found six findings; all are fixed:

1. Blocker: the test harness answered the offer-list call without running
   the script's jq filter, so the ownership filter was dead code under test
   and the progress record claimed coverage that did not exist. The harness
   now returns raw pull-request lists and runs the script's own `--jq`
   filter with real `jq`, and a foreign-head fixture pins the filter.
2. The filter was a loose prefix (`startswith`); a consumer branch named
   `automation/repin-lock-experiment` would have matched. The filter now
   requires the exact branch grammar `automation/repin-lock-<7 hex>`, which
   is the only shape the automation creates.
3. An automation-closed offer was later misreported as a consumer decline
   after a default-branch regression. The summary row and the docs now say a
   closed offer is final for its target whoever closed it, with a manual
   reopen as the recovery path.
4. "Needs no lock-pin change" was imprecise when a reviewed exception or a
   witness pin-literal companion keeps a stale pin. All new copy now says
   "no permitted lock-pin change remains".
5. Simplified Technical English fixes: "so automation" to "so the
   automation", the idiom "goes red" removed, and the long runbook sentence
   split.
6. The workflow job name said only "Open consumer repin pull requests"; the
   job now also closes superseded offers. Renamed to "Repin consumer lock
   pull requests" with the workflow-policy test updated.

## Bugbot round

Cursor Bugbot found one issue on pull request #264: the offer close scan
used `gh pr list` without a limit, so its default page cap of 30 newest pull
requests could hide a stale offer. Fixed:

- The offer scan passes `--limit 0`, which fetches every open pull request.
- The test harness now applies the default 30 cap faithfully (server-side
  state and head filters first, then the cap), and a new test buries the
  stale offer behind 31 newer foreign pull requests. The test is red
  without the fix and green with it.
- The remaining `gh pr list` call sites are head-filtered existence checks.
  GitHub filters server-side before the cap applies, so a nonzero count can
  never truncate to zero; no change needed there.

## Verification

- `node --test test/workflow-scripts.test.js`: 40 pass, 0 fail, three
  consecutive runs (four new end-to-end tests; the harness gained an
  at-target consumer state, raw pull-request list fixtures answered with
  the script's own jq filter, and a `pr close` shim).
- `node --test test/*.test.js`: 889 tests, 883 pass, 6 skipped
  (architecture-gated), 0 fail.
- `node tools/llm-harness.mjs check`: pass.
- `go test ./...`, `go test -race ./...`, `go vet ./...`: pass.
- `go mod verify`, `go mod tidy -diff` (both modules): clean.
- `golangci-lint run --timeout=5m`: 0 issues.
- `bash tools/workflows/ci.sh javascript`: clean.
- `bash tools/workflows/ci.sh shellcheck`: clean.
- `go run ./cmd/workflow-credential-audit .`: pass.
- `.devcontainer/scripts/verify.sh`: pass (run before the adversarial
  fixes; the fixes touch only files it covers).

## Dispositions and follow-ups

- Issue #261 item 3 stays open by design: DoxReloaded's companions are
  declared when its first repin offer shows a derived gate.
- The remaining #255 and #113 findings are consumer decisions
  (DxMessaging Integration bypass review, unity-helpers merge gate and
  contract fixes behind #749).
- PLAN.md M3 updated: DxMessaging #562 merged 2026-09-09; #749 remains the
  only open consumer contract pull request.
