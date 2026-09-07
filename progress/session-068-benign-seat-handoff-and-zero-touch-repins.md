# Session 068: benign seat-handoff release and zero-touch consumer repins

Date: 2026-09-07

## Objective and safety invariants

Act on five maintainer directives from the merged session 067 work: file the
unity-helpers repin work, re-evaluate #83 toward "faster, better, do not brick
CI", record the #223 incident outcome, explain and extend App usage (#51), and
make consumer enrollment zero-touch (#113). Preserve licensed-resource safety,
queue fairness, fail-closed cleanup, immutable action references, credential
confidentiality, and operator-visible evidence.

## Issue hygiene

- Opened Ambiguous-Interactive/unity-helpers#736: move the hosted
  `unitypackage` export jobs to the self-hosted fleet. This is the work item
  behind the maintainer's #226 disposition decision.
- #226: decision recorded, closed as completed.
- #223: closed as completed. Every acceptance item is resolved or redirected:
  the return was not an unrecognized 400006 (`matched=none`, PR #224), the
  hosted seat holder is identified (unity-helpers#736), the incident
  auto-mitigated with no leaked seats (maintainer-confirmed), and #106 part 2
  is re-opened under #83 with the maintainer directive.
- #51: answered the "why aren't we using the App" question with the audited
  credential inventory. The reader App and writer App are in active use and
  least-privilege; the open risk is org-secret visibility, which is an
  organization-settings action.

## Issue #83: release the benign seat handoff normally

Root cause of the CI cost: the classifier's `400006` scan ran before proof
parsing, so the measured #83 signature (entitlement return answers `400006`
because the peer already released the shared seat, ULF serial return
succeeds, command completes, account healthy) was classified
`unknown/healthy/unity-return-400006`. The release path then quarantined the
runner, consumed a capacity slot indefinitely, and the consumer's cleanup
gate went red on a proven-benign outcome.

Fix, one decision point: inside the `400006` branch of
`classifyEvidenceVerdict`, a `400006` whose dedicated return log proves the
ULF serial return with a completed command (not terminated, not timed out)
is `confirmed/healthy/cleanup-confirmed`. The existing release path treats
it like any confirmed cleanup: a one-second cooldown reservation instead of
a quarantine, and the consumer gate passes. Every weaker shape keeps the
fail-closed `unknown/healthy/unity-return-400006` verdict and quarantines:
`400006` without ULF proof, ULF skipped, truncated capture, termination,
timeout, incomplete command. Degraded reports still quarantine. No release,
gate, reaper, or recovery code changed; the resource-reason vocabulary and
all fail-closed defaults are untouched.

Evidence: the #83 measurements (21 of 22 second-returner, p = 5.5e-6; ULF
return succeeds; "nothing is stranded, nothing leaks a lock") and the #223
occurrence (exit 1, capture complete, ULF returned) are the exact signature
the new branch requires. The maintainer directive "faster, better, not brick
my runners/CI" authorizes the re-evaluation that #106 part 2 needed.

## Issue #113: zero-touch consumer repins

New scheduled workflow `Repin consumer lock references`
(`.github/workflows/repin-consumer-locks.yml`, daily `37 6 * * *`, manual
dispatch) plus `tools/workflows/repin-consumer-locks.sh`:

- The repin target is derived from the reviewed policy, never from the
  newest published release: the newest authorized release tag that both
  `approvedLockShas` and `approvedReturnShas` approve. Untagged or
  return-unapproved SHAs are refused, so repins cannot outrun the
  authorization merge.
- Per enrolled repository: clone the default branch, rewrite only the
  `@<sha>` suffix of `uses:` references to this repository's actions and
  matching `# vX.Y.Z` comments, and open one pull request on the stable
  branch prefix `automation/repin-lock-`. Non-lock references, run text, and
  non-version comments are untouched; the rewrite is idempotent.
- Guards: an open repin pull request for the same target is never
  duplicated; the staged diff is verified nonempty; no merge, no force-push,
  no default-branch edits, no PAT; the token travels only through
  environment-backed git credential helpers.
- Authority: one installation token per run minted through new
  `BUILD_LOCK_CONSUMER_APP_*` App credentials with Contents write and Pull
  requests write on the enrolled repositories. The maintainer must install
  and scope that App; the workflow fails visibly until the credentials
  exist. Per-repository results land in the run summary and any failure
  keeps the run red.

## Validation

Red/green and full-suite evidence:

- Classifier: new data-driven test `the shared-seat 400006 signature
  confirms cleanup instead of quarantining` (benign signature plus six
  fail-closed variants), and the two corrected precedence fixtures for
  `400006` with full proof. Red before the change, green after.
- Repin automation: new `workflow-scripts` test covers the rewrite contract
  (three lock references rewritten, version comment normalized, non-version
  comment preserved, non-lock `uses:` and run text untouched, idempotent
  rerun, unapproved and malformed targets refused) and the new
  `workflow-policy` test pins the workflow's triggers, permissions,
  concurrency, pinned actions, App-secret bindings, and script contract.
- Functional dry runs against the live repository:
  `resolve-scope` validated the policy and emitted the six-repo scope;
  the repin-target resolver returned `64bac446903115134dca8235410b332bc5a83547`
  / `v1.14.0` from live release tags and both allowlists.
- Full stubbed dry run of `repin-consumers` against six local bare remotes
  (three stale consumers, one stale composite wrapper, two current
  repositories). The first run exposed a false-success path: bash ignores
  errexit for a function called from a result-inspecting caller, so a
  tolerated clone or rewrite failure still reported a successful repin and
  the run exited zero. Fixed with explicit status guards on every fallible
  command; a failed pull-request listing is now an error instead of a skip,
  and a failed push never opens a pull request. The corrected dry run opened
  exactly four pull requests with the right diff counts and bodies, skipped
  the two current repositories, reran with perfect idempotency, and the
  forced-failure run stayed red with no pull request.
- `node --test test/*.test.js`: 838 tests, 835 passed, 0 failed, 3 expected
  platform skips. `go test ./...`, `go test -race ./...`, `go vet ./...`,
  `golangci-lint run --timeout=5m` (0 issues), `go mod verify` and
  `go mod tidy -diff` for both modules: passed. Workflow gates `syntax`,
  `verify-modules`, `tidy-modules`, `javascript`, `shellcheck`, the
  workflow credential audit, and `git diff --check`: passed.
- Documentation synchronized: runbook gained "Consumer repin automation"
  plus the confirmed `400006` seat-handoff semantics; README and consumer
  enrollment contract state the same classifier exception;
  `docs/operations-facts.json` records the repin schedule and App secret
  prefix; `PLAN.md` M2 and M3 updated.

## Review

Adversarial self-review covered unsafe success paths (the benign verdict
requires ULF proof in the dedicated return log, a completed command, and no
termination or timeout; all weaker shapes quarantine; degraded reports
still quarantine; repins are authorization-gated and never merge; the
stubbed dry run caught and fixed the tolerated-failure path), credential
exposure (tokens only through step environments and environment-backed
credential helpers; no token-bearing usernames or URLs), documentation
drift (four docs plus facts updated together), and untested boundaries
(live tag resolution, scope resolution, the rewrite matrix, and the full
clone-rewrite-commit-push-pull-request loop with idempotency and failure
injection). No unresolved findings.

## Continuous improvement

The substantial-work gate applied. No new `.llm` resource is warranted: the
benign verdict and the repin contract are enforced by production tests, and
the App-credential boundary was already documented in
`.llm/tasks/devcontainer-github-auth.md` territory. The durable record of
this session is the runbook section and the synchronized plan.

## Delivery

Local commits on branch `session-068-benign-400006-and-zero-touch-repins`,
pushed to origin as one aggregate pull request. The unity-helpers work item,
the #226 decision, the #223 closure, and the #51 answer are already live as
repository administration.
