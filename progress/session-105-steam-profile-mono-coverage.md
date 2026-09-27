# Steam profile Linux Mono coverage

## Task

Revisit #291 after the owner asked for Mono and IL2CPP coverage across Steam,
web, iOS, Google Play, and itch.io.

## Cause

The `Steam` profile selected only Linux IL2CPP. It did not check Linux Mono,
though the target matrix includes both Linux backends.

## Change

- Added `Steam` to the Linux Mono module row.
- Kept Android and its module tier out of `Steam`.
- Updated module tests, consumer guidance, runbook, and provenance digest.
- Marked the earlier profile record as historical at its original head.

## Evidence

- Red: profile tests expected Linux Mono and IL2CPP, but found only IL2CPP.
- Green: `node --test test/unity-editor-action.test.js`.
- Green: `node --test test/*.test.js` (906 passed, 6 skipped).
- Green: `go test ./internal/enrollment`.
- Green: `node tools/llm-harness.mjs check`.
- Green: `.devcontainer/scripts/verify.sh`.
- The PowerShell test confirms `Steam` requests and verifies both Linux modules.
  It finds no Android modules.

## Review and limits

An independent review found one unclear historical statement in session 104.
The record now names the profile state at that session's head.
The reviewer confirmed this fix. The second review found no further issues.

This profile fix does not finish #291. Consumer builds and the three-depot
Steam acceptance run remain open. Mac signing and licensed Mac return also
remain separate gates.
