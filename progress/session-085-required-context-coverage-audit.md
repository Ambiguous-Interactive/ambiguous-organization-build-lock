# Session 085: the audit now proves the required context reports on every pull request

Issue #258 recorded the failure class: a workflow whose check a ruleset
requires is a gate workflow, and a `pull_request` path filter can withhold
that check from some pull requests forever. Session 084 fixed the one known
consumer (DoxReloaded #815) and documented the rule. This session closed the
follow-up: the enrollment audit now detects the whole class.

## Task, invariants, hypothesis

- Task: teach `cmd/audit-unity-enrollment` to flag a required context whose
  reporting workflow cannot provably report on every pull request.
- Invariants: no existing finding path weakens; missing or ambiguous evidence
  becomes a finding, never a pass; the finding-code contract stays
  synchronized with `docs/consumer-enrollment.md`; the six live consumers
  gain zero false findings.
- Hypothesis: a static, literal-shape coverage proof can accept every
  reviewed consumer shape and reject every broken shape, because reviewed
  gates are either unfiltered or paired with a literal lockstep companion.

## Evidence (red-green, data-backed)

- Baseline: the analyzer could not see trigger filters at all. The new
  `TestUnityEnrollmentRejectsUnreportableAggregateGate` failed on every
  broken shape before the implementation landed.
- The first live sweep over fresh clones of all six consumers surfaced two
  findings against DxMessaging. Both were design input, not noise:
  - `unity-ci-success` (required context): its companion
    `unity-docs-gate.yml` reports the context through an expression `name`
    that resolves to `'Unity CI Success'` on documentation-only pull
    requests. Literal-only name matching was blind to the reviewed shape.
  - `perf-unity-success` (`perf-numbers.yml`): an unrequired context with a
    deliberate filter. Flagging it would contradict the reviewed design,
    because no ruleset requires it and nothing blocks on it.
- Scope correction: the finding now applies only to contexts listed in the
  reviewed `requiredContexts`. That list moved into
  `unity-enrollment-policy.json` and a new Node contract test locks it to
  `merge-policy-expectations.json`, the single reviewed source of what each
  default branch must require.
- Final live result after hardening: `Audited 6/6 enrolled repositories;
  active-jobs=115 findings=27 complete=true`, identical to the scheduled
  run (34309494262). All 27 findings are the known unity-helpers structural
  set behind open consumer PR #749. Zero `filtered-aggregate-gate` findings.

## What landed

- New finding code `filtered-aggregate-gate`
  (`internal/enrollment/unity_policy.go`), emitted when an aggregate that
  reports a required context sits behind a trigger that cannot prove
  pull-request coverage and no companion proves it:
  - coverage proofs, all literal and fail-closed: an unfiltered companion
    trigger that runs for the protected branch; or for one `paths-ignore`
    trigger, a companion `paths` list that contains every ignored pattern
    and runs for the protected branch;
  - the companion reporting job carries no condition and no `needs`, or
    exactly `always()` (a skipped required check counts as passing, so a
    needs-skipped reporter proves a false green), and may not exclude pull
    request events;
  - a companion expression `name` counts only through its exact
    single-quoted literal (the reviewed DxMessaging shape); the gate side
    requires a literal name, because GitHub appends matrix values to matrix
    job names;
  - `branches`/`branches-ignore` prove protected-branch reachability only
    through exact literal membership; globs and the rejected both-keys
    combination fail closed;
  - malformed triggers, expression or matrix aggregate names, and
    push-only workflows on a required context all fail closed.
- `workflowPREvents` and the new filter parser now share one `on:` traversal
  (`pullRequestEventConfigs`), so the two trigger readers cannot drift.
- Registry contract: per-repository `requiredContexts` in
  `unity-enrollment-policy.json`, strict validation (trimmed single-line
  names, `^[A-Za-z0-9_.+ /()-]{1,128}$`, at most 32, no duplicates — both
  bounds mirror `internal/mergepolicy/expectations.go`), and `omitempty` so
  onboarding never writes nulls.
- Contract test `test/workflow-policy.test.js`: enrollment policy
  `requiredContexts` must equal merge-policy expectations per repository.
- Docs: finding-code row for `filtered-aggregate-gate` and the coverage
  boundary written into canary item 10 of `docs/consumer-enrollment.md`.

## Verification

- `go test ./...`, `go test -race ./internal/enrollment/`,
  `node --test test/*.test.js` (875 pass, 0 fail),
  `golangci-lint run --timeout=5m`, `go vet ./...`, `go mod verify`,
  `go mod tidy -diff`, both `tools/workflows/ci.sh` legs,
  `workflow-credential-audit`, and `llm-harness check`: all green.
- Live negative controls during review: removing the DxMessaging companion
  fires exactly `filtered-aggregate-gate` on `unity-ci-success`; renaming
  the perf gate context to the required spelling fires on it because its
  ignore list exceeds the companion's `paths` list (lockstep exactness).
- Three adversarial review rounds converged: round one found the scoping
  and soundness items (blocker through nit), round two verified all
  remediations with live controls and found the needs-skip false green and
  the unfiltered-proof gap, round three verified those fixes and found two
  LOW items (docs wording, companion matrix literal corner). All are fixed
  in this session; nothing is deferred.

## Dispositions and residuals

- The perf-numbers context stays flaggable in the future if a ruleset ever
  requires it: the scope check reads the reviewed list, so enforcement and
  detection move together through the locked contract.
- Companion coverage proof still cannot evaluate expression arms or
  classifier outputs; that stays a reviewed companion decision, now stated
  in the contract.
