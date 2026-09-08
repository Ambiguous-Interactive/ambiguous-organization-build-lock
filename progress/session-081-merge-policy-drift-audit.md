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
- `cmd/audit-merge-policy`: bounded reads of the per-branch active rules,
  ruleset list, ruleset details, and classic branch protection; sanitized
  bounded artifact; exit 1 on findings or any retrieval failure. Rule
  targeting comes from the per-branch endpoint, which GitHub resolves
  authoritatively, so the audit implements no condition matching of its own.
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

## Adversarial review loop (independent reviewer, then remediation)

The first implementation passed every suite but the reviewer reproduced four
real defects; all were fixed before the PR:

- Fail-open in ruleset targeting: the audit matched ref-name conditions with
  exact string rules, so an `exclude: ["refs/heads/ma*"]` glob could switch
  the gate off while the audit still reported the context as carried. Fixed
  by reading `GET /repos/{org}/{repo}/rules/branches/{branch}` instead and
  deleting all condition matching; the endpoint reports only active rules.
- Fail-open in bypass evidence: GitHub omits `bypass_actors` for callers
  without ruleset write access, and Go decodes a missing key to nil while an
  explicit `[]` stays non-nil. A carrying ruleset whose bypass evidence is
  absent now fails the audit closed with a naming detail instead of passing.
- Alert-channel death: the sanitizer's output alphabet (`:`, `?`) exceeded
  the sync validator's, and a rename detail could exceed the 256-byte detail
  bound; hostile-but-legal names made `sync-merge-policy-issue` reject the
  whole artifact, so no issue could open, update, or close. Fixed with one
  shared alphabet constant, producer-side clamping, and a round-trip test
  that feeds sanitizer outputs into the validator.
- Protection 404 ambiguity: any 404 read as "no protection". Now only the
  documented `Branch not protected` body means absent; anything else fails
  closed.

Minor remediation: branch grammar aligned between parser and validator,
`per_page` set to GitHub's 100 cap, dead code and a typo removed, the
finding-code lock selects its sources by content instead of position, and
the workflow trigger paths include `internal/githubissue/**`.

Follow-up recorded: an expectation bypass actor currently accepts any
observed bypass mode; a mode-aware schema needs a first reviewed actor to
justify its shape.

## Second review round (Bugbot on the pull request)

- Accepted: the per-branch active-rules read sent no `per_page`, so GitHub's
  30-item default page silently truncated the authoritative rule list; a
  carrying ruleset hidden on a later page would have dodged the bypass
  check. Fixed by requesting 100 items and failing closed on a next-page
  Link header, with a dedicated test. Re-run live: identical complete result.
- Rejected with evidence: the claim that a `null` `required_status_checks`
  breaks the protection decode. Go's `encoding/json` documents `null` as a
  no-op for non-pointer struct fields; a reproduction decodes the documented
  response shape with `err=nil` and zero checks, which is the correct
  "protection present, no required checks" outcome.

## Live verification after remediation

The redesigned audit reproduced the same live result over real GitHub
(`complete=true`, 22 observed required checks, the same four findings), and
every repository read came through the per-branch authority.

## Follow-ups

- The first scheduled run mints its own App token and opens the drift issue;
  its artifact is the authoritative evidence for the four findings above.
- Maintainers may review bypass evidence into `allowedBypassActors` or ask
  consumers to remove the bypass; both are one-file or consumer-side edits.
- #252 stays open until the first live run closes the loop; #44 item 7
  acceptance is met by this audit.
