# Session 082: merge-policy retrieval boundary

The first `Organization merge-policy audit` run (push-triggered by the
#253 merge) failed closed on main. This session records the root cause,
completes the acceptance of issue #254, and corrects the operator guidance
that the live result proved wrong.

## Task, invariants, hypothesis

- Task: inspect the first merge-policy audit run on main, record the
  credential decision path on #254, and fix every artifact the result made
  stale.
- Invariants: fail-closed behavior does not change; no credential gains
  write access; findings stay issue-visible; docs stay synchronized with the
  tested behavior.
- Hypothesis: the run failed because GitHub hides ruleset `bypass_actors`
  from read-only callers, not because the audit or its configuration is wrong.

## Evidence

- Run 34285720502 (event `push`, the #253 merge; the daily cron has not
  fired yet) concluded `failure`. The audit step printed
  `Audited 6/6 enrolled repositories; active-contexts=4 findings=5
  complete=false`; the `record-counts` step then exited 1 because
  `.complete` was not `true`. That is the designed fail-closed path.
- The drift issue (#255) reports `Retrieval: incomplete (fail closed)` and
  names the two rulesets without bypass evidence: DxMessaging
  `Required CI - Unity Tests (default branch)` (id 17663217) and IshoBoy
  `protect main` (id 4545251).
- GitHub REST documentation for `GET /repos/{owner}/{repo}/rulesets/{id}`:
  "To prevent leaking sensitive information, the `bypass_actors` property is
  only returned if the user making the API request has write access to the
  ruleset."
- Session 081's complete local run used a `repo`-scope user token. User
  tokens with `repo` scope have write access to consumer rulesets, so they
  see `bypass_actors`. The scheduled run uses the reader App token with
  Administration read, which does not. Both observations fit the documented
  rule; no code defect is involved.
- qora-redux's classic branch protection bypass evidence was visible to the
  App token (`active-admin-bypass`). The write-visibility rule is specific to
  rulesets.

## Root cause

The credential boundary is structural, not a fault. #252 option 1 (reader App
Administration read, granted) is live-proven insufficient. #252 option 2 (a
third credential with Administration read only) is insufficient by the same
documented rule. The only remaining paths are a ruleset-write credential
(overturns the #51 read-only reader boundary) or #252 option 3 (accept the
gap; ruleset bypass evidence becomes consumer-attested). Option 3 also needs
a code change here: the audit fails closed whenever a carrying ruleset lacks
bypass evidence, so consumer attestation cannot turn the run green without
reshaping that evidence path. Both paths are maintainer decisions; they are
recorded on #254.

## What landed

- `docs/consumer-enrollment.md`: the `merge-policy-retrieval-incomplete`
  table row and section bullet no longer tell operators to "check the reader
  App Administration read permission" — that permission is granted and
  live-proven insufficient. Both state the write-visibility boundary and name
  #254 as the decision record; the section bullet also states that the run
  stays red until the decision. The Merge policy audit section also records
  that classic branch protection bypass evidence stays readable with
  Administration read.
- Reader-App permission inventories in `docs/consumer-enrollment.md`
  (Precondition 4) and `docs/operations-runbook.md` (credential boundary)
  now include Administration read, granted in session 081. Both keep the
  "no write permission" rule. The runbook operation map names the
  merge-policy audit as the Administration read consumer.
- `PLAN.md`: current state moved to session 082 with the first-run outcome
  and the decision pointer; M3 now records that DoxReloaded #810 and
  qora-redux #374 merged on 2026-09-08 while DxMessaging #562 and
  unity-helpers #749 remain open.
- #254: commented the inspected first run, the documented write-visibility
  rule, and the remaining decision paths; closed the issue as completed with
  its acceptance met.

## Durable learning (continuous-improvement gate)

- Promote: the fact "ruleset `bypass_actors` requires ruleset write access"
  is now in `docs/consumer-enrollment.md`, the narrowest authoritative
  location for the consumer merge-policy contract. No `.llm` edit: the fact
  is contract-specific and docs are the canonical place consumers and
  operators already read.
- No code change: the fail-closed treatment of missing bypass evidence is
  correct and reviewed; weakening it to make the check green is forbidden.

## Verification

- `node --test test/*.test.js`: pass (finding-code lock covers code names,
  not fix text, so the corrected rows still lock).
- `go test ./...`, `go vet ./...`, `golangci-lint run --timeout=5m`,
  actionlint, shellcheck, `ci.sh javascript`, module verify and tidy,
  workflow credential audit, llm harness check: pass.
- No behavior change diff exists; the Go and workflow sources are untouched.

## Follow-ups

- A maintainer must pick a #254 path: a ruleset-write credential (re-opens
  the #51 boundary) or #252 option 3 (consumer-attested ruleset bypass
  evidence). Until then, the daily 08:41 UTC run stays red by design and
  drift issue #255 stays open.
- If an actor is ever accepted into `allowedBypassActors`, extend the
  expectation schema with its bypass mode (recorded on #254 and in session
  081).
