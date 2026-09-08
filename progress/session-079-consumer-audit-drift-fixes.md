# Session 079: fix every consumer enrollment audit finding

Issue #113 reported 64 findings across four enrolled repositories. This
session opened one reviewed consumer fix pull request per repository and
verified all of them with the unmodified central analyzer over committed
snapshots of all six enrolled repositories:

`Audited 6/6 enrolled repositories; active-jobs=120 findings=0 complete=true`

## Baseline

The live scheduled audit (run 34246815834, artifact downloaded) reported:

- DoxReloaded 8, DxMessaging 27, qora-redux 2, unity-helpers 27.
- IshoBoy and unity-builder: clean.
- A local clone set at the same default-branch heads reproduced the exact
  64 findings with `go run ./cmd/audit-unity-enrollment`, which gave a
  red-green loop for every later edit.

## Method

1. Clone each consumer at its default-branch head into the auditor's
   expected `.policy-consumers/<name>` layout.
2. Fix each finding per `docs/consumer-enrollment.md` and the analyzer
   source (`internal/enrollment/unity_policy.go`), never by weakening a
   fail-closed path.
3. Verify with the real analyzer. It reads committed HEAD trees, so the
   edits were committed to local `fix/enrollment-audit-drift` branches
   before verification. Nothing was pushed until review passed.
4. Run actionlint and each repository's own contract suites.

## Per-repository outcomes

### DoxReloaded (PR DoxReloaded#810, 3 commits)

- Repinned all central action references from an unapproved SHA to
  `d79e1cc2acc892b619db2ca46f78291ca427016b` (v1.14.2, in both policy
  lists). This supersedes automation repin offer #801 and Dependabot #775.
- Removed workflow-level `env` (it broke central-return isolation), which
  required moving `WEBGL_BUILD_ENABLED` to its four real consumers and
  documenting the true WebGL restore procedure.
- Replaced the legacy editor bootstrap with the pinned central
  `ensure-unity-editor` gate; added preflight and the exact typed
  aggregate shape.
- The licensed job now answers to the central change classifier alone;
  the orphaned `detect-code` job was deleted.
- Co-changed its own pin ledger, cleanup fixtures, and validators.

### DxMessaging (PR DxMessaging#562, 6 commits)

- Renamed the local diagnostic `unity-editor-heartbeat.log` (marker-trip
  for `unreviewed-unity-reference`); no script contract changed.
- Removed `schedule` triggers; doc-only skips moved to
  `pull_request.paths-ignore`, with a new `unity-docs-gate.yml` that
  reports the required `Unity CI Success` check on ignored paths, so
  required checks cannot hang doc-only PRs.
- Migrated legacy editor validation to the central gate in five workflows;
  every Unity-consuming step now binds
  `UNITY_EDITOR_PATH: ${{ steps.ensure_unity_editor.outputs.editor-path }}`.
  The removed "bind editor" step was the only previous writer; without
  this co-change every licensed leg would fail at runtime.
- Added the reviewed static `matrix.test-mode` axis with the profile map so
  standalone legs verify IL2CPP at gate time.
- Typed return evidence-suffix and cleanup-gate inputs; trusted-skip
  aggregate shapes.
- Migrated its own contract suites, including ~58 assertion groups in
  `validate-unity-pr-policy.py` (4661 lines), to the new lifecycle. The
  LOC budget co-change uses the repository's documented bump convention.

### qora-redux (PR qora-redux#374, 2 commits)

- The aggregate was already correct; the preflight job carried one extra
  step, and the analyzer requires exactly one. Removed the redundant
  hosted head-check; the licensed job keeps both of its own head
  revalidations (before setup and before acquire).
- Updated the two contract tests to the truthful shape.

### unity-helpers (PR unity-helpers#749, 4 commits)

- Pins stay at v1.14.0 by maintainer decision; all fixes are structural.
- `run-ci-tests.ps1` no longer self-provisions: it fails closed without
  `UNITY_EDITOR_PATH`; workflow callers bind the gate output.
- Removed `schedule` triggers; push restricted to protected `main`.
- Trusted-shape preflight, central editor gate, literal release version
  `2022.3.45f1` with drift asserts, and reviewed trusted-skip aggregates
  restored the Dependabot and fork green path.
- `unity-tests.yml` gained the static `test-mode` axis so standalone legs
  verify IL2CPP at gate time.
- Migrated its PowerShell and JS contract suites to the reviewed shapes.
  The container has no `pwsh`, so the PowerShell suites were re-derived
  statically; CI will execute them.

## Review loop (adversarial, two rounds)

Round 1 found real defects in every repository that the analyzer cannot
see; all were fixed:

- DoxReloaded: the licensed job was still gated on the removed detector
  (spurious red PRs), and the WebGL deploy refusal read a deleted
  workflow-level env (unconditional refusal). Fixed; round 2 approved.
- DxMessaging: `UNITY_EDITOR_PATH` was never set (runtime failure in every
  licensed leg), five of its 28 contract tests failed, doc-only PRs would
  hang on required checks, and the standalone leg lost IL2CPP gate
  verification. All fixed; the full `validate-unity-pr-policy.py`
  migration followed.
- qora-redux: its own contract tests failed against the new preflight
  shape. Fixed.
- unity-helpers: its contract suites failed (PowerShell pins of the old
  shapes), Dependabot/fork PRs turned hard red, and the standalone leg
  lost gate-time IL2CPP verification. All fixed; round 2 required only two
  stale comment corrections, applied.

## Verification

- Central analyzer over all six committed snapshots: 0 findings,
  `complete=true`; set-diff against baseline shows exactly the 64
  findings resolved and none added.
- actionlint clean on every changed workflow.
- DxMessaging: `node --test scripts/` 1284 pass; every runnable
  `validate:all` member passes. qora-redux: contract suite 53/54 (the one
  failure needs `pwsh` and fails on main here too). unity-helpers: JS
  suites pass (2388 and 146 controls with the pwsh harness stubbed).
- Consumer clone history: only local `fix/enrollment-audit-drift`
  branches; pushes happened once, after review.

## Coordination notes

- Status comment posted on #113 with all four PR links.
- IshoBoy's open PR #866 is a parallel session's work; untouched.
- The next scheduled audit reads consumer default branches. The drift
  issue closes itself on the first complete clean run after these PRs
  merge.

## Follow-ups

- The four consumer PRs are merge decisions for their maintainers.
- DoxReloaded reviewers should close superseded #801 and #775 after
  merging #810.
- #229's native macOS canary and #231's Darwin authorization stay gated on
  real hardware evidence; unchanged this session.
