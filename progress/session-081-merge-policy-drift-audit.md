# Session 081: central merge-policy drift audit

Issue #252 recorded that #44 item 7 (a central audit of consumer default-branch
merge policy) was blocked on a ruleset-readable credential. The owner comment
"Updated permissions accepted and implemented" lifted the blocker. This
session shipped the audit end to end.

## Task, invariants, hypothesis

- Task: compare each enrolled default branch with a reviewed expectation list
  and open one deduplicated issue on drift.
- Invariants: fail closed on missing evidence; no credential in shell
  interpolation; no write permission anywhere; sanitized evidence only.
- Hypothesis: the Rulesets API and branch-protection endpoints are readable
  with a per-repository reader token, so a fail-closed comparison is possible.

## Baseline facts observed before implementation

- Main CI was green; no open pull requests existed.
- `gh api repos/Ambiguous-Interactive/<repo>/rulesets` listed rulesets for all
  five non-fork consumers. The apparent 404 on ruleset details in an early
  probe was a zsh word-splitting artifact (`set -- $rs` does not split), not a
  permission boundary; the later Go client read every detail. Correction to
  the #252 body: detail reads worked with a `repo`-scope user token here.
  The workflow still requests Administration read for the App token, because
  App installations resolve visibility differently from user tokens.
- Default-branch aggregate names, read from each consumer's reviewed
  workflow shape: DoxReloaded `CI Success`, DxMessaging `Unity CI Success`,
  IshoBoy `Unity CI Success`, qora-redux `Unity CI`, unity-helpers
  `Unity CI Success`. unity-builder is exempt (fork, manual canary).
- Session 079 status today: DoxReloaded #810 and qora-redux #374 merged;
  DxMessaging #562 and unity-helpers #749 still open.

## What landed

- `merge-policy-expectations.json`: reviewed repository set, default branches,
  required aggregate contexts, empty reviewed bypass allowlist. The audit
  command refuses to run when this set drifts from
  `unity-enrollment-policy.json`.
- `internal/mergepolicy`: strict expectations parser plus the pure
  comparison. Detection: missing, case-renamed, disabled-ruleset, and
  unexpected bypass actors (ruleset actors, classic admin bypass).
- `cmd/audit-merge-policy`: bounded ruleset list, ruleset details, and branch
  protection reads; sanitized bounded artifact; exit 1 on findings or any
  retrieval failure.
- `cmd/sync-merge-policy-issue`: deduplicated alert
  (`<!-- merge-policy-audit:v1 -->`) through the shared issue client.
- `.github/workflows/merge-policy-audit.yml` plus
  `tools/workflows/merge-policy-audit.sh`: daily at `41 8 * * *` and on push
  to the owned paths; reader App token minted with Administration read only;
  drift findings stay issue-visible while an incomplete audit fails the run.
- Docs: `docs/consumer-enrollment.md` gained the Merge policy audit section
  and the five new finding-code rows.

## Live verification (read-only GETs, cached session token)

`go run ./cmd/audit-merge-policy --policy unity-enrollment-policy.json
--expectations merge-policy-expectations.json --output ...` returned
`Audited 6/6; active-contexts=22 findings=4 complete=true`:

- DoxReloaded: `missing-required-context` for `CI Success`; no active
  ruleset requires it. True gap against #44 acceptance.
- DxMessaging: aggregate required, but ruleset 17663217 grants actor type
  `Integration` id 3977200 bypass mode `always`. Reported as
  `unexpected-bypass-actor`.
- IshoBoy: clean; `protect main` requires the aggregate.
- qora-redux: classic protection requires `Unity CI` with
  `enforce_admins` disabled. Reported as `unexpected-bypass-actor`.
- unity-helpers: no protection at all; `missing-required-context`.
- unity-builder: exempt, silent.

The four findings are exactly the remaining consumer merge-gate decisions.
They are reported for consumer choice, not auto-remediated.

## Verification

- `node --test test/*.test.js`: 874 pass, 6 skipped (platform-gated).
- `go test ./...`, `go vet ./...`, `go test -race` on the new packages: pass.
- `golangci-lint run --timeout=5m`: 0 issues (after dropping an unused
  parameter the unparam linter found).
- actionlint, shellcheck, `ci.sh javascript`, module verify and tidy,
  workflow credential audit, llm harness check: pass.
- Contract locks updated: workflow job/script inventories, finding-code sync
  (now locks merge-policy codes too), script summary fail-closed test.

## Follow-ups

- The first scheduled run mints its own App token and opens the drift issue;
  its artifact is the authoritative evidence for the four findings above.
- Maintainers may review bypass evidence into `allowedBypassActors` or ask
  consumers to remove the bypass; both are one-file or consumer-side edits.
- #252 stays open until the first live run closes the loop; #44 item 7
  acceptance is met by this audit.
