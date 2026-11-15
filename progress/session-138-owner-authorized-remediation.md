# Session 138: owner-authorized consumer remediation

Date: 2026-11-15

Issues: #44, #255, #113, #375. Owner authorization covered the required-check
bindings, DoxReloaded, and consumer pull requests. The owner kept both Apps
installed org-wide and punted on the evidence-only issues.

## Baseline

- Session 137 left `main` at `7fe232588c` and green.
- Merge-policy audit `43764676137`: 4 findings.
- Enrollment audit `43761221801`: 25 findings. DoxReloaded had three:
  `missing-fallback-aggregate`, `missing-unity-aggregate`, and
  `unsafe-unity-editor-provisioning`.

## Required-check source binding

Bound `Unity CI Success` to the reviewed GitHub Actions App ID `15368` on:

- DxMessaging ruleset `17663217`
- IshoBoy ruleset `4545251`
- unity-helpers ruleset `22983578`

DoxReloaded's `CI Success` and `Harness Success` were bound in a second step.
The attestation change in its pull request exposed that finding.

## DoxReloaded pull request

DoxReloaded #1230 merged at `e6474d3`. It made these changes:

- `ci-success` keeps exactly one central `require-unity-validation` step.
- The static-lint and .NET result checks moved into `Static Validation`. That
  job now needs both sibling jobs, so the aggregate still fails closed.
- The EditMode fixture list moved from `change-classifier` to
  `Static Validation`. The classifier returns to the exact three-step shape.
- The uv and Python calls are literal. The pinned interpreter directory is
  added to `GITHUB_PATH`, and `DOX_SHADOW_PYTHON` remains for the existing
  fallback checks.
- The merge-policy attestation lists `Harness Success`.
- Dependabot ignores the central build-lock actions.
- The merge-queue `static-validation` job stays in lockstep.
- The local policy and helper tests assert the new literal command.

The first run failed one yamllint empty-line check. The next run passed.

## Evidence

- DoxReloaded #1230 checks: Static Lints, Contract tests on .NET, Static
  Validation, Unity Tests and Player Builds, CI Success, and Harness Success all
  pass. The merged commit `e6474d3` reports the same required checks green.
- Merge-policy audit `43769808886`:
  `Audited 7/7 enrolled repositories; active-contexts=25 findings=0 complete=true`.
- Enrollment audit `43769990981`:
  `Audited 7/7 enrolled repositories; active-jobs=133 findings=22 complete=true`.
  DoxReloaded has no findings.
- Local DoxReloaded checks: `actionlint`, the organization policy check, the
  licensed-job tests, and the run-unity-build tests. The two remaining
  run-unity-build failures are the known macOS `/var` path cases; they fail on
  the unmodified checkout too.

## Issues

- #255 closed: zero merge-policy findings.
- #44 closed: every aggregate source is bound and DoxReloaded emits the exact
  aggregate.
- #113 remains open: 14 DxMessaging shape findings and 8 expired exceptions.
- #375 remains open: DoxReloaded is done; six consumers need the same
  Dependabot ignore.

## Review of the DxMessaging findings

The DxMessaging findings are not a quick copy of DoxReloaded:

- `unity-tests.yml` reports `missing-unity-editor-check` and
  `unsafe-central-return-suffix`. The job has the central gate, but its three
  axis matrix and a post-gate cache step do not match the reviewed shape.
- `perf-numbers.yml` reports `missing-unity-editor-check`. Its matrix also has
  an extra axis beside the reviewed `test-mode` map.
- `runner-bootstrap.yml` reports four shape findings on each of three
  operator-only audit jobs. It is a workflow-dispatch audit, not a CI gate, and
  its `cancel-in-progress: false` is deliberate.

Each needs a reviewed shape change or a policy exception. None should be
changed without reading its job contract first.

## Validation

- `node tools/llm-harness.mjs check`: pass.
- The central repository checks from session 137 still pass.
