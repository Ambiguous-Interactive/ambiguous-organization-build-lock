# Session 114: classify Qora editor-session failures

## Goal and priority

The fresh GitHub inventory found these 13 open issues and no open central pull
requests:

| Priority | Issues | Impact and current boundary |
| --- | --- | --- |
| P0 | #51 | App and organization-secret scope needs owner inventory, scope changes, and negative probes. |
| P0 | #44, #255 | Four live rulesets accept any source App. Fixing issuer binding changes merge policy, which this task forbids. |
| P0 | #83 | The central classifier fix shipped. Independent-seat and portal evidence still need owner-authorized Unity operations. |
| P1 | #269 | Consumer failure classification and run evidence are in scope. This has the strongest safe code action with one Qora Unity CI run. |
| P1 | #278 | Missing consumer test logs and exact retry behavior still need owner-run evidence. |
| P1 | #153, #229, #231, #249 | Native macOS and container return work needs reviewed authorization and licensed canaries. |
| P1 | #29 | Lifecycle canaries and seven-day monitoring need owner-run licensed operations. |
| P1 | #53 | Runner fairness needs a fail-closed design, synthetic multi-repository tests, and physical runner load evidence. |
| P2 | #277 | GitHub retained no canceller identity for the reported event. |

Issue #269 is the highest-impact task in this inventory that has a safe
consumer code action. Its current status narrows the remaining work to a
distinct failure class and the existing redacted peer timeline in the consumer
result.

## Evidence and decision

Qora's `main` was `689c97ab97ddc575708f2314ee2e9b30239f04db` before this change.
Its NUnit harness rejected a suite failure with zero failed test leaves, but it
used a generic setup or teardown failure class. The pinned central release
action already provided `peer-timeline` as bounded redacted JSON.

Qora PR [#423](https://github.com/Ambiguous-Interactive/qora-redux/pull/423)
recognizes only the zero-failed-leaf report with the known Baselib TLS
assertion. It labels the run `editor-session-crash` and keeps the Unity step
failed. The existing result harness appends the classification and a pointer to
the job summary. The release action appends the redacted event table later in
that summary. No retry, lock policy, or admission behavior changed.

## Review and verification

- Scope verdict: CLEAN. The two code files, focused tests, and progress record
  match the selected consumer classification task.
- Code review found no P1 or P2 findings. Manual adversarial review checked
  the exact signature, zero failed leaves, generic nearby failures, summary
  write errors, and fail-closed result behavior.
- Mutation proof: changing the expected `GetLastError() == 0L` expression made
  the exact-match test fail. Broadening the match made the nearby non-match
  test fail.
- Focused harness, workflow-contract, and failure-summary tests passed: 108
  total, 103 passed, and 5 platform-specific skips.
- `npm run llm:check`, JavaScript syntax validation, PowerShell parsing, and
  `git diff --check` passed in the Qora checkout.
- Local `npm test` ran 409 tests: 397 passed, 7 failed, and 5 were skipped.
  The seven failures required `dotnet`, which was absent locally. Qora's Linux,
  Windows, engine-free, and licensed Unity CI all passed on this change.
- Unity EditMode and PlayMode passed. License return and confirmed lock
  cleanup passed. Review submissions and inline review threads were empty.

The first summary design added a workflow step and broke four cleanup-order
contracts. The final design writes the pointer from the existing result
harness; it keeps the cleanup step last and avoids passing the bounded peer
timeline through Windows environment variables.

## Completion

Qora PR #423 merged as
`2b2237326ad0a9cbcdb99c4d3773ac26e4e291c1`. Its progress note was then
corrected in [Qora PR #424](https://github.com/Ambiguous-Interactive/qora-redux/pull/424),
merged as `c806a83e1c9a6dbc023107cfbb659f694f909752`. Qora `main` now points to
that commit. Its code and progress files match the versions covered by CI.
PR #424 passed LLM Harness run 1255 and Unity Validation run 1010; its licensed
Unity tests were skipped because the diff changed only progress documentation.
Central issue
[#269](https://github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/issues/269)
was updated with the evidence and closed. No organization policy changed.

The root checkout fast-forwarded to `9716da70346a359eeabde11350f6c43d2ab4bd7e`.
The fresh central issue inventory remains in the priority table above; owner
or policy blockers remain outside this selected work.
