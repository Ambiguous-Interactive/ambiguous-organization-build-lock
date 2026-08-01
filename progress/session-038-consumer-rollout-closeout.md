# Session 038: Consumer rollout closeout

Date: 2026-07-31

Status: in progress; the original three consumer migrations merged green,
manual-only follow-up remediation is open for DxMessaging, DoxReloaded remains
runner-blocked, and unity-helpers awaits a repository-authorized commit

## Scope

Central issue #160 was already implemented by PR #161 and authorized by PR
#162. PRs #164 and #165 added and authorized a closed alternate editor layout
after the first consumer canary exposed a path mismatch. Live manual-install
evidence then established a narrower rule: CI must never provision or repair a
Unity editor. Issue #166 records that follow-up policy work.

Consumer workflows in this rollout therefore:

- require an existing healthy editor before credentials or lock acquisition;
- exact-bind licensed execution to the canonical
  `runner.tool_cache/u6-v3/<version>/Editor/Unity.exe` path;
- omit `editor-layout`, retaining the canonical default in the authorized
  `d72d1072accbc8090874b5aa257be3e56774de5d` return action; and
- pin return and classification together to that evidence-deleting revision.

## Completed consumers

### qora-redux

PR #188 merged as `d0c4231d37f5a8e2553986eacc076f641b73df07`.
Exact PR run `30600000895` passed 129 EditMode and 107 PlayMode tests, then
passed return, classification, release, and the aggregate gate. A prior
alternate-layout canary failed closed and created a quarantine; the next
canonical lifecycle on the same physical runner reclaimed it through normal
acquisition and completed confirmed cleanup. No direct lock-state recovery was
used. Post-merge Unity and LLM workflows passed on the merge commit.

The stricter issue #166 analyzer subsequently proved that this workflow's
healthy-existing check is hidden behind the `run-workflow-step.ps1
-Operation RequireEditor` wrapper. The wrapper is audited and currently safe,
but cannot satisfy the mandatory gate because its operation dispatch is
arbitrary control flow. A direct workflow invocation remains required before
the rollout can close.

### IshoBoy

PR #317 merged as `77bd4540c2b9774f4c796e4e48df874724ecfe2a`.
Exact PR run `30600000606` passed compile validation and 652 EditMode tests,
then passed return, classification, release, fallback cleanup, and the required
aggregate. All post-merge workflows passed on the merge commit.

### DxMessaging

PR #321 merged as `2e58122ca72fab2e8eaa1ffadf1f39b5b05b737b`.
Default-branch rerun `30596850645`,
attempt 2, passed all nine Unity 2021.3, 2022.3, and 6000.3
EditMode/PlayMode/standalone legs plus the required aggregate. Every completed
leg passed central return, classification, release, and cleanup confirmation.

The stricter issue #166 audit exposed two additional reachability defects:
editor checks could skip while credentials and acquisition remained
unconditional, and `run-ci-tests.ps1` retained an automatic provisioning
fallback. PR #322 head `decb71763386d6448c550ac087afb934242b2307`
makes all five checks unconditional, uses the same immutable maintenance
helper as DoxReloaded, and requires callers to pass the validated editor.
The exact-head organization audit reports zero DxMessaging findings.

## Remaining consumers

### qora-redux

The merged issue #160 lifecycle remains green, but issue #166 requires its
editor check to move from the operation-dispatch wrapper into a direct workflow
step. The exact merge-head audit reports one
`missing-unity-editor-check` and one
`unsafe-unity-editor-provisioning` finding. No licensed rerun has been
triggered for this follow-up.

### DxMessaging

PR #322 is open at `decb71763386d6448c550ac087afb934242b2307`.
Its full 406-case JavaScript suite passes with nine expected local PowerShell
skips; formatting, line budget, Unity PR policy, packaging, spelling,
Markdown, and generated-document gates pass. The local environment lacks
`dotnet`, so the analyzer payload gate is left to hosted CI. Cursor and Copilot
were retriggered on the exact pushed head. Cursor's one exact-head finding
claimed the immutable maintenance pin lacked the requested script. The GitHub
tree API proved that pin contains `scripts/unity/ensure-editor.ps1` as blob
`53fd05cab13b19e86c7d222b03489f8c6967840a`; the evidence-backed reply was
posted and the false-positive thread resolved.

### DoxReloaded

PR #305 head `9ca115cc33eda4e02885274f9b869ee9c372ee52`
passes hosted static policy validation, local cleanup mutation and live central
contract checks, all 15 Node tests, deployment validation, and independent
review. Cursor Bugbot found no issues on the exact head; Copilot review was
unavailable because its quota was exhausted.

The licensed job fails before credentials or lock acquisition because both
trusted runners' canonical Unity 6000.5.2f1 editors lack WebGL Build Support
and Windows Build Support (IL2CPP). Run `30601275727` proved that Unity itself
starts successfully on DAD, then the build-module check reports both exact
payloads absent. Installation is intentionally a manual host operation and is
not part of CI.

### unity-helpers

PR #324 remains at `7d07ffa714ab62c08488b7b673b63c5cc761f3be`.
The repository's agent rules prohibit staging or committing, so the remote
branch has not changed. Its local worktree now contains a maintainer-ready
remediation:

- return and evidence classification both use the authorized d72 revision;
- the licensed workflow exact-binds the canonical editor and executes
  `-RequireHealthyExisting` before current-head revalidation, lock acquisition,
  and credentials;
- the healthy-existing path unconditionally probes native Unity startup even
  if the runner service environment contains the test-only probe escape hatch;
- CI provisioning budgets and the self-hosted runner-bootstrap path are
  removed, while manual maintenance derives the canonical tool-cache root from
  the runner root and proves the exact `.service` identity is stopped first;
- executable diagnostics point only to offline manual maintenance; and
- data-driven contracts reject 18 unsafe licensed-workflow mutations and three
  retired-bootstrap mutations.

PowerShell parsing, Actionlint, Prettier, central cleanup parity (11 classifier
and 9 gate cases), the 132-case release synchronization contract, and two fresh
full `validate:prepush` runs pass. The local `yamllint` wrapper reported its
documented skip because that optional binary is unavailable; independent
Actionlint and YAML-format validation pass. The first adversarial review found
two fail-closed gaps in native-startup and exact-service handling; both were
corrected, and the second exact-diff review reported zero findings.

## Safety observations

- Provisioning canaries were canceled before credentials, acquisition, or
  activation after the manual-only requirement was clarified.
- Every corrected workflow fails closed before licensed work when its required
  manual editor or modules are absent.
- The tightened central provenance rule now also requires `clean: true` and
  checkout/gate adjacency and fails closed on non-candidate external-helper
  calls. Its fresh exact-head red baseline adds two DoxReloaded findings, ten
  DxMessaging findings, and two IshoBoy findings;
  these mechanical rollout deltas must land before central enforcement.
- No organization policy, credential, secret, App, runner, or ruleset setting
  was changed.
- Consumer rollout is not complete until the qora-redux direct gate,
  DoxReloaded, DxMessaging, and unity-helpers remediations merge green and
  their default branches are verified.
