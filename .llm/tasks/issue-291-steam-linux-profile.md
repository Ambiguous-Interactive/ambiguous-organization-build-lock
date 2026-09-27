<!-- summary: Steam checks Linux and Mac Mono modules; signing runs separately. -->
# Task: Add Unity target and backend profiles

## Objective

Add opt-in target/backend profiles to the central Windows Unity editor action.
Each profile must request and verify only its Unity target modules. Keep CI
health checks read-only and fail closed when the runner lacks a module.

## Safety and scope

- Do not install, repair, move, or quarantine Unity editors in CI.
- Admit target profiles only on a single job without a matrix.
- Keep unselected target modules out of each profile.
- Do not change organization settings, secrets, runner access, or live lock state.
- This task does not complete central issue #291. The downstream player currently
  builds Windows only, and its macOS path still needs a safe license-return gate.

## Baseline

- The action runtime rejects `Steam` as an invalid profile.
- Target/backend profiles were missing for Mono, iOS, WebGL, and Android.
- The enrollment analyzer accepts `EditorOnly` for non-matrix jobs and rejects
  every other profile shape.
- The payload is copied from `unity-helpers` commit
  `76712db791093a9c6b2eccdd9c7bd1b4f1cdb24d` and its original source digest is
  recorded in the pre-profile revision of `THIRD_PARTY_NOTICES.md`.

## Acceptance

- Standalone profiles cover Windows, Linux, and Mac Mono and IL2CPP modules.
- WebGL and iOS profiles cover their IL2CPP-only targets.
- Android Mono and IL2CPP profiles use the same Android module set.
- `Steam` checks Linux Mono, Linux IL2CPP, and Mac Mono. It excludes Android.
  Store names select target depots, not Unity modules.
- The enrollment analyzer accepts target profiles only without a job matrix.
- The action manifest, enrollment guidance, runbook, provenance notice, tests,
  task index, and progress evidence agree.
- Central CI passes. Mac signing and notarization run without Unity activation.
  Licensed runner return stays with the Windows build lifecycle.
