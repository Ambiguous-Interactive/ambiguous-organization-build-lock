# Unity target and backend profiles

## Task

Revisit issue #291 after the owner asked for Mono and IL2CPP coverage across
Steam, web, iOS, Google Play, and itch.io.

## Hypothesis

Store names do not select Unity build modules. Explicit target/backend profiles
can cover supported combinations while keeping the existing `Full` profile
stable. WebGL and iOS have no Mono combination. macOS and iOS final signing
remain host-specific evidence gates.

## Baseline

- `Steam` selected only `linux-il2cpp`.
- The central action lacked explicit Mono, WebGL, iOS, Android backend, and Mac
  target profiles.
- Unity documents Mono for desktop and Android. Unity documents IL2CPP for all
  platforms and requires it for iOS and WebGL.
- Unity documents that iOS export can run on any Editor host, while Xcode build
  and signing require macOS.
- Steam and itch.io map to platform depots. Google Play maps to Android.

## Change

- Added least-scope Windows, Linux, Mac, WebGL, iOS, and Android profiles.
- Kept `Steam` as the Linux IL2CPP alias and `Android` as its former alias.
- Kept the existing `Full` module set and order unchanged.
- Kept action validation read-only. Missing modules still fail closed.
- Updated enrollment policy, action runtime, docs, provenance, and task index.
- Kept Mac signing, notarization, Xcode signing, and licensed runner return
  outside this profile change.

## Validation

- Red: the target-profile contract test failed because the new profiles were
  absent.
- Green: `node --test test/unity-editor-action.test.js`.
- Green: `go test ./internal/enrollment`.
- Green: the PowerShell profile-selection test covers all new and legacy names.
- Green: synthetic filesystem tests require target-specific Mono or IL2CPP
  player evidence for Windows Mono, Mac Mono, and Mac IL2CPP.
- Green: `node tools/llm-harness.mjs check`.
- Green: `.devcontainer/scripts/verify.sh` before the final filesystem test.
- Pending: rerun the full verifier after that final test addition and review CI.

## Review

Main-thread adversarial review found two process mistakes during development.
An early Full-profile row order change and a stale payload digest both failed
focused tests. Both were fixed, and the Full profile kept its old module set
and order. No open static-review findings remain.

The file-layout probes pass synthetic evidence tests. Real runner evidence for
new Mono and Mac IL2CPP module layouts remains an acceptance gate. Distinct
agents were unavailable under the active collaboration policy.
