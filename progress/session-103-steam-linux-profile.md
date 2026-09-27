# Session 103: Steam Linux IL2CPP profile

Date: 2026-09-27

## Objective and priority context

Continue the open-issue triage from
[`session-102-open-issue-triage-and-gemini-pointer-pr.md`](session-102-open-issue-triage-and-gemini-pointer-pr.md).
That session ranked #291 as a lower-churn candidate after recording higher
impact items that require owner-scoped credentials, consumer changes, or
licensed runner and platform evidence. This session implements only the
central action profile slice of #291. It does not change organization policy,
credentials, runner access, or live lock state.

## Baseline and evidence

- Central `main` was clean at `cb8d5396` after PR #290 merged and its main
  workflow passed.
- The central action rejected the literal `Steam` profile; its module table
  assigned Linux IL2CPP only to `Full`.
- In a read-only checkout of `doughby-td` main, `PlayerBuild.cs` defines Linux
  and macOS output paths, but `RunFromCI()` invokes only the Windows build
  method. Its current workflow is explicitly Windows-only. The downstream
  issue's statement that builder support is ready is therefore not established
  by current source.
- The central validator is a self-contained copy of
  `unity-helpers/scripts/unity/ensure-editor.ps1` from commit
  `76712db791093a9c6b2eccdd9c7bd1b4f1cdb24d`. Current upstream main has since
  gained dependencies absent from this central copy. The central copy remains
  self-contained and is described as source-derived with a reviewed local
  profile patch, not byte-identical upstream.
- Issue #291 remains open. Downstream Linux target implementation and depot
  upload, macOS depot delivery, and the macOS license-return gate remain
  independent acceptance evidence.

## Hypothesis and red evidence

Hypothesis: a narrow `Steam` profile can expose only Linux IL2CPP while keeping
the central enrollment check fail closed for matrix workflows.

Before implementation, the focused Node action test rejected `Steam` as an
invalid profile, and the targeted Go enrollment test reported
`missing-unity-editor-check` for a single-job Steam workflow. These failures
confirmed the central profile and enrollment gaps.

## Implementation

- Added the `Steam` profile to the PowerShell parameter contract, profile
  validator, action adapter, and manifest description.
- Assigned `Steam` only to the `linux-il2cpp` module row. The actual extracted
  profile functions return requested and verified module lists containing
  only `linux-il2cpp`; the Android tier returns an empty list.
- Extended the enrollment contract to allow Steam only on a job with no
  matrix. Matrix workflows still fail closed.
- Added Node and Go regression tests, including a hosted-Windows PowerShell
  behavior test for the module selection. Existing action parsing and
  diagnostic binding accept the profile by its literal name.
- Updated enrollment and operations guidance, payload provenance and digest,
  and the indexed task record.

## Adversarial review

- The Steam module table row is the only row containing `Steam`; Linux Mono,
  Android SDK/NDK, and other player modules stay excluded.
- The profile remains health validation only in CI. It does not install or
  repair Unity or modules. Missing Linux IL2CPP support fails closed through
  existing action validation.
- Enrollment accepts the profile only when the job has no matrix; a regression
  test asserts that a matrix job receives `missing-unity-editor-check`.
- The analyzer cannot establish that a downstream job actually builds the
  Linux player. That remains an open integration question and is not claimed as
  completed acceptance.
- This work changed repository code and guidance only. No live org, secret,
  runner, or license settings were touched.
- Main-thread independent-pass fallback: implementation, adversarial review,
  and remediation were done as separate passes because this environment's
  instruction explicitly prohibits spawning sub-agents unless requested. No
  actionable defects were found in the latest review pass.

## Validation

- Focused Node action, manifest, and documentation checks: 97 passed, 2
  expected hosted-Windows skips, 0 failed.
- `go test ./internal/enrollment -count=1`: passed.
- Extracted PowerShell module functions: requested `linux-il2cpp`, verified
  `linux-il2cpp`, Android `[]`; PowerShell parser passed.
- `node tools/llm-harness.mjs check`: passed after task indexing.
- `./.devcontainer/scripts/verify.sh`: passed; all modules verified, with 902
  Node checks passing, 7 expected skips, and 0 failures.
- `git diff --check`: passed.

## Disposition

PR #292 is open from `codex/issue-291-steam-profile`. Hosted Build lock CI run
`36349982200` completed successfully: the central checks, Windows action tests,
and Darwin return action tests all passed. At the latest review inspection,
there were no submitted review objects, inline review threads, or discussion
comments. The PR's automated summary labels it medium risk and reports no
blocking finding.

The profile slice is ready to merge under repository gates. The task and issue
remain open pending downstream proof that a Linux player is built and uploaded
to Steam's Linux depot. macOS depot and safe native license-return evidence
also remain open. Continue the broader issue triage after this slice is merged.
