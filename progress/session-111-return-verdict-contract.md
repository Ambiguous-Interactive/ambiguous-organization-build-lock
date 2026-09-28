# Session 111: Unity return verdict contract

## Task and invariant

Address the remaining false-red path in issue #83. A completed Unity return
whose dedicated log proves cleanup must be able to reach the central cleanup
classifier, while missing or unsafe proof must continue to fail closed. The
return action must not classify its own evidence, and no `continue-on-error`
or policy change is allowed.

## Baseline and finding

Baseline: `65e9f179ff9690c37eee21a1eed6ec6cd6709627` (`main`, after session 110).

The classifier already accepts exact entitlement-return and client-ULF-return
proof, including the narrowly scoped 400006 handoff case. However, the return
action still failed every nonzero process exit. This prevented the classifier
and the mandatory aggregate gate from evaluating valid proof, leaving a
false-red after the classifier fix.

## Change

The return action now reports a completed run with complete capture to the
classifier even when Unity exits nonzero. The action emits a warning containing
the exit code and does not infer cleanup status. Incomplete capture,
termination by signal, and timeout still fail the action. The cleanup
classifier and final gate remain authoritative; missing proof stays unknown
and fails closed.

Updated the action description and consumer documentation to state this
contract. Added coverage for a nonzero completed run with exact positive proof,
one without proof, and a signaled run with positive-looking output.

## Validation

- Red-green focused baseline: the new completed-nonzero cases failed before
  the implementation with the return completion error.
- `node --test test/unity-license-return.test.js test/unity-cleanup-evidence.test.js test/action-manifests.test.js`:
  169 tests, 167 passed, 2 platform skips, 0 failed.
- `go test ./internal/enrollment`: passed.
- `.devcontainer/scripts/verify.sh`: passed (exit code 0), including the LLM
  harness, repository JavaScript checks, Go tests, module verification, and
  workflow credential-literal policy.
- `git diff --check`: passed.

## Adversarial review and disposition

- A completed nonzero exit with full capture is only a transport of evidence;
  the focused test runs that evidence through the separate classifier and
  verifies `confirmed` only when exact return proof is present.
- A completed nonzero exit with no proof classifies as `unknown`; existing
  quarantine and final-gate behavior remains fail-closed.
- Signal termination remains an immediate action failure even if captured
  output looks positive. Timeout and incomplete-capture conditions remain in
  the immediate-failure branch.
- The change adds no `continue-on-error`, skips no aggregate gate, and does not
  change organization settings or enrollment policy.
- No `.llm` instruction change is needed; this is an implementation of the
  existing classifier/action separation and fail-closed requirements.

## Remaining boundary

This central code change does not itself prove independent two-seat capacity
or live portal reconciliation for #83. Keep the issue open until those
acceptance facts and the authorized release/adoption path are established.
