# Session 133: readable cleanup failures and DxAudio onboarding

Date: 2026-11-15

Issues: #360, #363. Pull requests: #364 (central fix), #365 (enrollment),
Ambiguous-Interactive/DxAudio#11 (consumer workflow).

## Objective and safety invariants

Carry the GOAL.md directive: rank open issues by impact with the least Unity CI
churn, complete the highest-priority safe work, and drive it green. The
operator also asked for DxAudio onboarding.

Safety invariants: no fail-closed path is weakened; the classifier reads,
digests, and classifies only after it claims the exact return evidence; the
licensed cleanup suffix stays exact; the enrollment registry stays the only
authority for paid consumers.

## Baseline

- `main` at `f556633883` was clean and green.
- 17 open issues, no open pull requests. #363 was filed 2026-11-15.
- The scheduled reaper, incident recovery, and enrollment monitors were green.
- `node --test test/*.test.js` on this macOS host: three release-diagnostic
  cases fail because `/bin/bash` 3.2 has no `mapfile`. They are unchanged by
  this session and run on the Linux CI runner.

## Priority

1. #360: a green consumer run fails on a return log nobody can read. Two runs
   spent a seat each. Central fix, no consumer churn.
2. #363: DxAudio is the operator-requested new consumer. It needs a licensed
   workflow, one ruleset, and two reviewed central policy entries.
3. The remaining issues stay blocked on owner authority, ruleset authority, or
   licensed evidence, as `PLAN.md` records.

## Change 1: #360

- A classification failure reports `cleanup-evidence-unknown` and prints its
  bounded, sanitized cause. `return-log-truncated` stays reserved for a
  completed read with incomplete capture.
- A verdict other than `cleanup-confirmed` prints a bounded tail (4096 bytes,
  40 lines) of the verified return log. The return action redacts that log
  before it writes it. Control characters and workflow commands are
  neutralized.
- `require-confirmed-unity-cleanup` states the seat and the lock separately, so
  a freed seat with an unwritten lock record does not read like a held seat.
- An evidence-capture overflow now names that cause in the return action.

## Change 2: #363

- Workflow `Request Unity repository onboarding` ran for DxAudio at target head
  `da86016bfe50130d2618b0f6fec4d08ef7e75817`. The reader App check passed.
- Organization settings refuse pull requests created by GitHub Actions, so a
  maintainer opened the pushed branch as #365.
- #365 adds the reviewed `requiredContexts` for DxAudio and its
  `merge-policy-expectations.json` entry. The audit and retrieval tests now
  derive the repository count from the registry.
- DxAudio#11 adds `unity-tests.yml` and the merge-policy attestation for live
  ruleset `27288634`. The analyzer reports zero DxAudio findings at
  `1fb396a3ecce4d57b9f3fc38a2058f11f43ec773`.

## Validation

- `go test ./cmd/audit-unity-enrollment ./internal/enrollment ./internal/mergepolicy`:
  pass.
- `node --test test/unity-cleanup-evidence.test.js test/unity-cleanup-gate.test.js test/unity-license-return.test.js`:
  147 pass.
- `node --test test/workflow-scripts-0.test.js test/workflow-policy.test.js test/documentation-policy.test.js`:
  150 pass.
- Central analyzer over committed consumer snapshots: DxAudio findings 0.
- `node tools/llm-harness.mjs check`: pass.
- `go vet ./...`: pass.

## Continuous improvement

No durable LLM resource promoted. The return-evidence contract in
`docs/consumer-enrollment.md` item 7 already owns the rule; this session made
the text match the code.
