<!-- summary: Add a least-scope Linux IL2CPP profile to the central Unity editor action. -->
# Task: Add the Steam Linux IL2CPP profile

## Objective

Add an opt-in `Steam` profile to the central Windows Unity editor action. The
profile must request and verify only Unity's `linux-il2cpp` module. Keep CI
health checks read-only and fail closed when the runner lacks the module.

## Safety and scope

- Do not install, repair, move, or quarantine Unity editors in CI.
- Admit `Steam` only on a single job without a matrix.
- Keep Android and Linux Mono modules out of the profile.
- Do not change organization settings, secrets, runner access, or live lock state.
- This task does not complete central issue #291. The downstream player currently
  builds Windows only, and its macOS path still needs a safe license-return gate.

## Baseline

- The action runtime rejects `Steam` as an invalid profile.
- The PowerShell module table assigns `linux-il2cpp` to `Full` only.
- The enrollment analyzer accepts `EditorOnly` for non-matrix jobs and rejects
  every other profile shape.
- The payload is copied from `unity-helpers` commit
  `76712db791093a9c6b2eccdd9c7bd1b4f1cdb24d` and its original source digest is
  recorded in the pre-profile revision of `THIRD_PARTY_NOTICES.md`.

## Acceptance

- Node input parsing and diagnostics accept and bind the literal `Steam` profile.
- The payload exposes exactly `linux-il2cpp` for requested and verified modules,
  with no Android modules, and it remains self-contained.
- The enrollment analyzer accepts `Steam` only without a job matrix.
- The action manifest, enrollment guidance, runbook, provenance notice, tests,
  task index, and progress evidence agree.
- Central CI passes. Consumer enrollment, Linux and macOS depot delivery, and
  native macOS licensing remain separate evidence gates.
