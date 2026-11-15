# Session 134: audit root causes and a stale required context

Date: 2026-11-14

Issues: #113 (enrollment drift), #255 (merge-policy drift). Follow-up issue
filed for the Dependabot pin class.

## Objective and safety invariants

Carry the GOAL.md directive: rank the open issues by impact with the least
Unity CI churn, complete the highest-priority safe group, and drive it green.
No fail-closed path is weakened. A finding is never removed to make a job look
clean: the unauthorized pin is still reported, and the audit still fails.

## Baseline

- `main` at `f7170ff473` was clean and green. No open pull requests.
- 15 open issues. The scheduled reaper, incident recovery, and reaper delivery
  monitors were green.
- Scheduled enrollment audit `43676607331` was complete with 65 findings over
  124 active rows. Scheduled merge-policy audit `43675382033` was complete with
  5 findings over 25 active contexts.
- Local reproduction used a shallow `unity-helpers` clone at the audited commit
  `795903adf69d03c4d3a12695766f686d81ffb5a5` and the unmodified analyzer.

## Priority

1. #113: 44 of 65 findings were one root cause. `unity-helpers` pinned every
   central action to `f556633883` (untagged `main`), which no policy list
   authorizes. The analyzer cannot prove any lifecycle shape on an unauthorized
   identity, so it reported nine downstream codes per job. One repin fixes 37
   findings; the other nine findings are separate consumer shapes. Central fix,
   zero licensed churn.
2. #255: one of five findings was unsatisfiable. `qora-redux` declares the
   required context `Unity CI`, but it runs Godot workflows and no Unity work,
   so the requirement can never report. Central data fix.
3. Every other issue stays blocked on owner authority, ruleset authority, or
   licensed evidence, as `PLAN.md` records. #335 is still blocked: actionlint
   v1.7.12 (2026-03-30) is the newest release and still needs the old YAML API.

## Change 1: name one root cause for an unauthorized or mutable pin

- `internal/enrollment/unity_policy.go`: `centralReferenceTrust` scans a job's
  flattened steps for `uses:` values that name this repository at a mutable or
  unauthorized ref. A local composite cannot hide a pin.
- Every related job that carries such a pin is named, including non-paid
  preflight and lint jobs. Before this change, a non-paid job's pin was silent.
- When the identity is untrusted, a licensed job reports the pin cause
  (`unapproved-lock-ref` or `mutable-action-ref`) and stops. It does not also
  report `missing-unity-editor-check`, `missing-cleanup-classifier`,
  `classifier-not-always`, `missing-unity-return`, `unsafe-central-return-suffix`,
  `release-inputs-not-typed`, `cleanup-gate-inputs-not-typed`,
  `missing-runner-preflight`, or `missing-unity-aggregate`.
- Coverage verdicts read other jobs, so they still report, unless a preflight
  candidate itself carries the pin. In that case its own pin finding names the
  cause.
- Findings that do not rest on this job's identity still report: runner labels,
  workflow and job queue direction, matrix fail-fast, job credentials,
  triggers, editor provisioning, release and gate `always()` checks, and
  acquire position.
- `docs/consumer-enrollment.md` states the rule in the
  `unapproved-lock-ref` row.

Root-cause evidence: the same snapshot reported 42 `unity-helpers` findings
before the change and 9 after it. Seven name the unauthorized pin on one job
each, and two name expired reviewed exceptions.

## Change 2: replace `qora-redux`'s stale Unity context with its real gates

- `qora-redux` has no Unity workflow at the audited commit `17f8580c`. The
  enrollment inventory holds two `non-licensing-static` preflight jobs only.
- Its classic branch protection requires `Godot CI` (and `Godot CI` reports on
  every pull request from an unfiltered `pull_request` trigger) and
  `validate (ubuntu-latest)`. Both are posted by App ID 15368.
- `unity-enrollment-policy.json` and `merge-policy-expectations.json` now
  record those two contexts instead of the impossible `Unity CI`. The audit
  keeps a real gate instead of exempting the repository.
- `docs/consumer-enrollment.md` records the reason.

## Adversarial review

An independent reviewer ran the analyzer on adversarial fixtures. Findings and
dispositions:

- Workflow-wide trust let an unrelated job's pin withhold a licensed job's real
  findings and blamed the licensed job. The scan now reads each job's flattened
  steps, and a two-job regression test pins the behavior.
- Non-paid jobs with an unauthorized pin stayed silent; the scan now names them.
- The first version also withheld preflight and aggregate verdicts, which read
  other jobs. Those verdicts now report, except when a preflight candidate
  itself carries the pin and has its own finding.
- The first `qora-redux` change exempted the repository and lost all gate
  coverage. The reviewed contexts now name its real live gates instead.
- The trust scan folds the repository spelling, and a composite regression test
  now breaks a lifecycle shape so it can tell the old behavior from the new.

## Validation

- Live merge-policy audit with the reviewed token:
  `7/7 repositories; active-contexts=25 findings=4 complete=true`. The
  `qora-redux missing-required-context` finding is gone, and its inventory rows
  record `Godot CI` and `validate (ubuntu-latest)` at App ID 15368. The four
  remaining findings are `unexpected-required-check-source` reads that need
  ruleset authority.
- `go test ./...`, `go test -race ./...`, `go vet ./...`: pass.
- `node --test test/*.test.js`: 1034 tests, 1008 pass, 23 fail. The same 23
  fail on an untouched `HEAD` worktree in this environment: 19 cleanup-evidence
  cases on macOS link semantics, one pre-commit hook case, and three release
  diagnostic cases that need Bash 4 `mapfile`. This change adds no failure.
- `node --test --test-name-pattern synchronized test/workflow-policy.test.js`:
  pass.
- `node tools/llm-harness.mjs check`, `go mod verify`,
  `go -C tools/actionlint mod verify`, both `go mod tidy -diff` checks,
  `bash tools/workflows/ci.sh javascript`, and
  `go run ./cmd/workflow-credential-audit .`: pass.
- `golangci-lint` and `shellcheck` are not installed on this macOS host.

## Remaining monitor state

- Enrollment audit after the pin fix: `unity-helpers` carries seven
  `unapproved-lock-ref` rows and two `expired-policy-exception` rows,
  `unity-builder` carries six expired exceptions, and `DoxReloaded` and
  `DxMessaging` carry the reviewed consumer shape findings. The expired
  exceptions need an owner re-review; this session did not renew them.
- Merge-policy audit: four `unexpected-required-check-source` findings remain
  for DoxReloaded, DxMessaging, IshoBoy, and unity-helpers. Each live ruleset
  accepts any source for the required context. The fix is ruleset authority.
- The `unity-helpers` pins came from Dependabot PR #1165, which moved the group
  to an untagged `main` commit and kept the `v1.17.1` comments. That class is
  filed as a separate issue so a consumer fix or a central PR-time guard can be
  decided once.

## Continuous improvement

No durable LLM resource promoted. `docs/consumer-enrollment.md` already owns the
finding-code contract and the exemption rule; this session made both texts
match the code.

## Disposition

- #113: central part complete. The remaining findings are consumer merges and
  one owner re-review of expired exceptions.
- #255: the unsatisfiable finding is removed. Four real findings stay open and
  need ruleset authority.
