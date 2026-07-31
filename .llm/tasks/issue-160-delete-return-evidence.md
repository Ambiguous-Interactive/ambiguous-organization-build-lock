<!-- summary: Delete consumed central Unity return evidence before cleanup classification can complete. -->
# Task: Delete consumed Unity return evidence

## Acceptance criteria
- The classifier deletes the exact current-run central return log and its empty
  action-owned directory only after bounded read, UTF-8 validation, digest
  verification, and classification.
- Path escape, arbitrary names, link/reparse ancestry, unexpected directory
  entries, identity mutation, deletion failure, and failed absence verification
  leave classification incomplete.
- Completed outputs appear only after verified deletion; supplemental evidence
  remains outside central deletion ownership.
- The four-step terminal consumer suffix and fail-closed release/gate behavior
  remain unchanged.

## Baseline
- Command: `node --test test/unity-cleanup-evidence.test.js`
- Observed result: 44 passed and the new successful-run deletion assertion
  failed because the evidence directory still existed.
- Reproduction status: reproduced.

## Hypothesis
- Claim: deriving one deletion target from GitHub run identity and
  `RUNNER_TEMP`, then identity-binding read and deletion, removes consumed
  evidence without granting caller-selected filesystem deletion authority.
- Disconfirming evidence: any completed output before verified absence, deletion
  outside the exact owned directory, accepted link/reparse or identity mutation,
  or removal of supplemental evidence.
- Falsified hypotheses: parent-directory timestamps cannot be required to remain
  unchanged after deleting their child; device/inode/type are the stable
  post-mutation identity.

## Red
- Test: successful classification must leave no central return evidence
  directory.
- Expected failure: current classifier emits completed outputs without deletion.
- Observed failure: `true !== false` on the directory-presence assertion.

## Risk and path matrix
- Positive: exact POSIX and Windows path models select one digest-bound log and
  its empty owned directory; a hosted-Windows smoke test executes the production
  identity-bound deletion helper.
- Negative: traversal, wrong run/attempt/name, arbitrary path, link/reparse
  ancestry, missing digest, and unexpected sibling.
- Error: native deletion failure, no-op deletion, post-delete presence, and
  identity mutation.
- Boundary/extreme: existing bounded empty/oversized/invalid UTF-8 and traversal
  budgets remain authoritative.
- Concurrency/ordering: the directory is atomically claimed under a random
  private name before its authoritative read. Native handles verify object
  identity and delete those exact objects; file and directory pathname
  substitutes survive and prevent completed outputs.
- Cancellation/recovery: initial fail-closed outputs are written first and
  completed outputs are withheld on every deletion failure.
- Determinism/isolation: temporary directories and injected filesystem/path
  models; no Unity, credentials, network, or sleep.
- Contract synchronization: runtime, manifest, action contract test, enrollment
  guide, rollout guide, README, task record, and progress record.

## Green
- Minimal change: require the central digest, validate and atomically claim the
  exact current-run return path, identity-bind collection, and use
  `SetFileInformationByHandle` on verified Windows file/directory handles with
  no pathname-delete fallback. The file handle excludes mutation sharing and
  reverifies the exact digest before disposition. Verify absence before
  completed outputs.
- Focused result: 63 classifier tests pass on Linux with two Windows-native
  tests skipped; 65 workflow-policy tests and the enrollment analyzer package
  pass. CI executes native success and metadata-forgery rejection on
  `windows-latest`.

## Full validation
- `.devcontainer/scripts/verify.sh`: passed after final remediation (676 Node
  tests: 674 pass and 2 Windows-only skips; all Go packages/modules, actionlint,
  harness, and credential audit).
- `go -C tools/actionlint run -mod=readonly
  github.com/rhysd/actionlint/cmd/actionlint -color`: passed after adding the
  narrow hosted-Windows job.
- First hosted-Windows run: failed because cold Windows PowerShell `Add-Type`
  compilation reached the original 30-second subprocess bound; the bound was
  raised to 120 seconds. The next run completed compilation and exposed that
  denying delete sharing on the directory blocked disposition of its child;
  the directory now permits delete sharing while the file still excludes both
  write and delete sharing. The revised native path requires CI confirmation.

## Adversarial review
- Unsafe success paths considered: unreadable/empty-digest evidence, mutation
  between collection and classification, legacy digestless composite trust,
  pathname replacement during file deletion, directory replacement before
  removal, restored Windows ChangeTime, and restoration of every settable
  metadata field after an equal-size byte rewrite.
- Intent-to-diff status: implementation complete; external immutable repins
  remain a post-merge rollout boundary.
- Unverifiable items and open questions: live consumer repins require the merged
  immutable commit.
- Remaining uncertainty: hosted-Windows execution and remote review remain CI
  gates after publication.
- Implementer: primary agent.
- Reviewer and evidence: independent `adversarial_review` agent, source/test
  inspection, and direct race reproductions.
- Actionable findings: round 1 found read failures collapsing to empty evidence,
  stale pathname classification, and analyzer trust in the obsolete
  digestless composite. Round 2 confirmed those fixes and found that post-hoc
  descriptor checks still allowed pathname substitutes to be deleted. Round 3
  found missing Windows ChangeTime validation. Round 4 proved that even
  ChangeTime is caller-settable, so metadata alone cannot bind classified
  bytes to deletion.
- Remediator and dispositions: all findings accepted. Failed authoritative
  reads now throw; claim/read/digest/classification are one identity chain; the
  analyzer rejects the obsolete composite; pathname unlink/rmdir were removed
  in favor of identity-verified Windows native handles. The helper excludes
  write/delete sharing and reverifies SHA-256 through the exact opened handle
  before disposition. Regression tests prove file/directory substitutes
  survive and fully restored metadata cannot hide changed bytes.
- Latest review round outcome: PASS; no actionable high-impact findings remain.
- Main-thread fallback reason (if applicable): not applicable; review is
  independently delegated.

## Knowledge retention
- Trigger or exemption: substantial public safety-action change; continuous
  improvement review required after validation.
- Evidence: the reviewer directly reproduced pathname and metadata-forgery
  races; replacement-survival and exact-handle digest regressions now pass, and
  the full verifier is green.
- Observed facts, inferences, and open questions: validating an inode after
  `unlink(path)` detects damage but cannot prevent deletion of a substituted
  path object. Windows handle disposition binds deletion to the opened object.
- Root cause or reusable insight: destructive TOCTOU tests must assert that a
  substitute survives, not merely that the operation later reports failure;
  mutable metadata is not a content binding, so byte identity must be verified
  under the same exclusive handle used for disposition.
- Promotion decision: retain as focused runtime regressions and this task
  record; do not broaden repository skills for a platform-specific primitive.
- Destination or rationale: `test/unity-cleanup-evidence.test.js` is the
  executable contract closest to the risk.
- Independent review outcome: PASS.
