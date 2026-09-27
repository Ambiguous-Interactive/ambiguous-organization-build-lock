# Session 106: Steam Mac Mono cross-build

## Cause

The Steam profile checked Linux Mono and IL2CPP. It did not check Mac Mono, so a Windows editor could not prove its Mac player module.

## Change

- Added Mac Mono to `Steam`; Android stays out.
- Updated module tests, enrollment guidance, runbook, task index, and provenance digest.
- Mac signing can run on a Mac without Unity activation. The Windows build keeps license return.

## Evidence

- Red: the module-group test listed no Mac Mono module under `Steam`.
- Green: `node --test test/unity-editor-action.test.js` (33 passed, 1 skipped).
- Green: `node tools/llm-harness.mjs check`.
- Unity 6 docs permit a Windows editor to create a macOS player; Mac signing remains on macOS.

## Review and limits

The profile only checks the module on the managed editor. It does not install missing modules in CI.
The consumer workflow still builds Windows only. No Steam depot was published.
