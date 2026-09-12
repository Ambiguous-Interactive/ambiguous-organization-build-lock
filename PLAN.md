# Plan

Living milestone plan for the organization build lock. Keep it current:
remove completed or obsolete items after each session. Order milestones by
impact on licensed-resource safety and consumer CI churn.

## Current state (2026-09-11, session 093)

- v1.14.0 (PR #224) and v1.14.2 (d79e1cc2a, PR #247) are released and
  authorized for consumer pins. v1.14.1 stays unauthorized by design
  (superseded within minutes; discovery offers only the newest release).
- `Auto release` opens the release-authorization pull request after every
  release. Merging it stays the human decision.
- The cleanup classifier attributes generic return failures through
  `licensing-codes-checked` and `licensing-code-matched` outputs.
- The enrollment audit rejects licensed Unity jobs on GitHub-hosted or
  ambiguous runners (`unsafe-hosted-unity-runner`). The live audit
  (2026-09-07) identifies the unity-helpers hosted `.unitypackage` export
  jobs as the non-self-hosted Unity seat holder seen in the portal.
- The enrollment audit admits the central return on Windows and, for pins
  listed in the new reviewed `approvedDarwinReturnShas` allowlist, on macOS.
  The allowlist is empty until a Darwin verifier release exists (#153, #228).
- The in-repo #229 follow-ups are done: `gofmt` is a CI formatter gate, and
  the three tests that settled only through unref'd event-loop timers now
  use ref'd keep-alive floors.
- The Darwin trusted return runtime landed (PR #240, squash-merged as
  6a384393c): editor resolution inside the reviewed bundle, a `codesign`
  designated-requirement identity check, process-group termination, and
  runner-cancellation forwarding. Its `macos-latest` job runs the whole
  return-action suite on macOS; the fixture fixes behind that are #241,
  closed by session 077. The analyzer still refuses every Darwin return
  until `approvedDarwinReturnShas` names a release (#231).
- Repin automation honors reviewed, expiring `repinExceptions`: a pin-only
  update can no longer move a caller to an action whose input contract the
  caller cannot satisfy (#233 follow-up). Issue #233 is closed: unity-helpers
  #739 removed the incompatible historical wrapper, the quarantined
  reservation reconciled through the documented reaper path, and the audit
  reports stale exceptions (#236).
- The first scheduled repin run completed 2026-09-07 07:02 UTC (run
  34093552546). It opened repin PRs in DoxReloaded (#801), IshoBoy (#855),
  and unity-helpers (#738, the incompatible update closed in #233).
  DxMessaging closed its repin #553 as a duplicate and adopts the pins in its
  own PR #554.
- The repin automation now treats a closed repin pull request as the
  consumer's adoption answer: the same repin is never re-offered, the branch
  is never force-updated, and the run stays green with a summary row. An
  orphaned repin branch is reused only when its content matches the current
  repin exactly. Verified against real Git push behavior with end-to-end
  tests; without it, the next scheduled run would have failed the
  non-fast-forward push against unity-helpers' stale branch.
- The scheduled enrollment audit reports stale or expired `repinExceptions`
  entries as `expired-repin-exception` and `stale-repin-exception` findings
  in the drift issue (#234). The repin rewrite keeps its own fail-closed
  gate.
- The drift issue now links the reviewed per-code fix contract. The 64-code
  audit vocabulary is test-locked to `docs/consumer-enrollment.md`, so a new
  reason code cannot ship without its documented fix. The two head-revalidation
  codes are covered too; the sync test extracts them from the audit script.
- The scheduled audit survives a consumer push that lands mid-run: it
  re-clones the advanced repository, re-analyzes, and fails closed only when
  bounded refresh attempts cannot reconcile (2026-09-07 race on DoxReloaded,
  run 34164453758).
- The release train is repaired (issue #244): Auto release opens the
  release-authorization pull request with a writer App token scoped to
  this repository, discovery retries only the newest published release, a
  declined offer stays closed, a failed creation removes the branch when
  no pull request uses it, a run summary reports non-conventional commit
  subjects, and semantic-release no longer comments on referenced issues
  (foreign repository references cannot fail a release). Proven live:
  v1.14.2 published and its authorization pull request #247 opened by the
  App. Release-driving pull request titles must be conventional; the
  squash merge copies the title into the commit subject semantic-release
  reads.
- The central merge-policy drift audit (#44 item 7, #252) is implemented:
  a reviewed expectation list (`merge-policy-expectations.json`) is compared
  daily with each consumer's live rulesets and branch protection, and drift
  opens one deduplicated issue. Drift findings stay issue-visible with a green
  run; an incomplete audit fails the run closed.
- The first `Organization merge-policy audit` run (34285720502, pushed by
  the #253 merge) failed closed as designed. The reader App holds
  Administration read, but GitHub returns ruleset `bypass_actors` only to
  ruleset-write callers. So the carrying rulesets on DxMessaging (17663217)
  and IshoBoy (4545251) report `merge-policy-retrieval-incomplete`. True
  consumer gaps stay visible: DoxReloaded and unity-helpers do not require
  their aggregate, and qora-redux lets administrators bypass required
  checks. #254 records the credential decision: read-only paths are
  live-proven and documented insufficient, so only a ruleset-write
  credential or #252 option 3 remains. The finding-code contract no longer
  tells operators to "check Administration read" (session 082).
- The operator chose #252 option 3 (2026-09-09): consumer-attested ruleset
  bypass evidence. The audit now fills that one blind spot from
  `.github/merge-policy-attestation.json`, proves the file is fresh
  against the live ruleset, and fails closed while a carrying ruleset has
  no attestation (session 083). True drift cleared live with operator
  approval: DoxReloaded ruleset 22595536 now requires `CI Success`, and
  qora-redux branch protection no longer lets administrators bypass.
- Session 084 repaired the merge gate that ruleset 22595536 exposed
  (#258): the DoxReloaded workflow withheld `CI Success` from every pull
  request its `pull_request` paths filter excluded, so attestation PR
  #815 was blocked permanently. #815 now also removes the filter; the
  classifier still skips licensed work on inert pull requests. The
  contract is documented as item 10 of the enrollment canary checklist.
- Session 085 closed the #258 analyzer follow-up: the enrollment audit
  reports `filtered-aggregate-gate` when no workflow provably reports a
  reviewed required context on every pull request. Required contexts moved
  into `unity-enrollment-policy.json`, locked to
  `merge-policy-expectations.json` by a contract test. Coverage proofs are
  literal and fail-closed; on 2026-09-09 the live audit over all six
  consumers was byte-identical to the scheduled baseline (then 27
  unity-helpers findings, behind consumer PR #749).
- The three merge-policy attestation PRs merged (DoxReloaded #815,
  DxMessaging #564, IshoBoy #873) and DxMessaging drift fixes merged
  (#562). The remaining #255 findings are the DxMessaging Integration
  3977200 bypass review and the unity-helpers merge gate; the next
  scheduled merge-policy audit re-states the live set.
- Session 086 repaired the v1.14.2 repin offers: every red offer had one
  root cause, a reviewed consumer artifact that derives from the pin. The
  policy now declares `repinCompanions`, and the repin rewrite carries each
  declared file through one mechanical mode (`pin-lines`, `pin-literal`,
  `policy-snapshot`). Outcomes: unity-helpers #751 green end to end after a
  parity-test fix (assert reviewed verdict fields, tolerate reviewed
  additive fields); IshoBoy #877 and qora-redux #382 green after their
  companion commits; DxMessaging's maintainer closed offer #567 in favor of
  their own #568, which absorbed the complete pin cohort. DoxReloaded's
  stale v1.14.0 offer #801 closed as superseded. unity-helpers #749 is
  green with reviewer feedback answered; merges stay consumer decisions.
- Session 087 answered the #261 follow-ups: the repin run now closes its
  own open offers as superseded when the default branch needs no lock-pin
  change to reach the authorized release (branch-prefix filter, summary
  row, failed close keeps the run red), and canary item 11 in
  `docs/consumer-enrollment.md` publishes the verdict-compare contract:
  consumer tests assert reviewed verdict fields and tolerate reviewed
  additive fields.
- Session 088 answered #263: the repin rewrite normalizes release version
  comments, so every moved pin carries `# vX.Y.Z` and stays Dependabot-
  visible (live proof: DoxReloaded Dependabot #775 tracked exactly the
  commented pins). Dependabot cannot rewrite companions or see release
  authorization, so the central repin offer stays the complete update and
  an unauthorized Dependabot bump fails closed as `unapproved-lock-ref`.
- The v1.14.2 adoption cohort completed (2026-09-09): the three repin
  offers merged with their companions (unity-helpers #751, IshoBoy #877,
  qora-redux #382), and DxMessaging adopted through #568.
- Session 089 answered #266 (operator decision, option 2): the repin
  automation enables auto-merge on every offer it opens, with the merge
  method chosen from the repository's allowed methods (squash preferred).
  The request happens once at creation; a consumer disable is respected;
  a refused request keeps the run green with a summary row. The
  repository-level opt-out is the `Allow auto-merge` setting.
- Session 089 answered the last #255 review item (operator decision):
  the DxMessaging ruleset 17663217 Integration actor 3977200 (attested,
  mode `always`) is now recorded in `merge-policy-expectations.json`, and
  expectation bypass actors carry a reviewed bypass mode. The live audit
  re-run confirms only the unity-helpers merge gate remains.
- Session 090 re-verified the green baseline after the #267 merge: main
  CI green, the full local verification suite green, no open or draft
  pull requests, and no failed runs. Every open issue waits on an
  external decision or live evidence; the auto-merge path awaits its
  first live offer at the next authorized release.
- Session 091 answered the lock-side half of #269: the release action now
  publishes a redacted `peer-timeline` output and job-summary table
  replaying lock-state history for the holder's session window (peer
  acquires and returns, reservations, incidents). It is bounded,
  diagnostic-only evidence that never delays the release beyond its own
  small budget, so a consumer can finally test the acquisition-side
  hypothesis against real peer activity. The consumer half (classify the
  engine-assertion zero-failed-leaves signature, retry once inside the
  held lock) is published as canary item 12 of the enrollment contract.
- Session 092 worked the live evidence queue. unity-helpers #749 merged
  (2026-09-11) and cleared all 27 unity-helpers findings; the first clean
  merge-policy audit closes #255. The same enrollment audit caught one
  fresh finding: DxMessaging #580 inserted an input guard between the
  current-PR-head guard and the editor gate, so the gate left the reviewed
  prefix (`missing-unity-editor-check`). Session 092 recorded the root
  cause and opened the reviewed consumer fix (DxMessaging #582). The doc
  row now names the prefix rule. The unmodified local analyzer reports 0
  findings over all six snapshots with the fix applied. For #269,
  lock-state history proves no peer held the lock in either casualty
   window. Both casualties started 40-62s after a peer returned on the
   same physical runner. A full re-run reproduced the signature, so the
   class is not always transient.
- Session 093 closed the last #255 finding, and #255 closed live
  (2026-09-12 06:12 UTC, dispatched run 34677521508: 6/6 repositories,
  24 active contexts, 0 findings, complete). Root cause: unity-helpers
  #749 added the universal `Unity CI Success` reporter, but required-
  context enforcement lives in a ruleset, which no pull request can
  create. The operator created ruleset 22983578 on unity-helpers `main`
  (mirrors the reviewed DoxReloaded template: active, default branch,
  requires `Unity CI Success`, no bypass actors). Two follow-ups were
  needed before the audit went clean: the new carrying ruleset made the
  audit fail closed with `merge-policy-attestation-missing` until
  unity-helpers published its attestation (PR #768), and the
  branch-rules endpoint lagged the new ruleset on the first re-audit.
  The merge-policy audit also gained `workflow_dispatch`, so a live fix
  is verifiable on demand; the reviewed contract test now requires that
  trigger.

## M1: attribute every Unity seat to a lock holder (#223, #83)

- [x] Classifier emits licensing-code attribution (PR #224).
- [x] Audit names licensed jobs that run outside the self-hosted fleet.
- [x] Decide the disposition of the unity-helpers hosted export jobs:
      unity-helpers moved both jobs to the self-hosted Windows fleet at
      audited commit `93671a56` (#226 closed 2026-09-07). The audit confirms
      `unsafe-hosted-unity-runner` no longer appears for that repository.
- [ ] Determine whether a peer activation can invalidate a live incumbent's
      seat. Needs Unity portal evidence (#223, section 3).

## M2: shared-seat capacity decision (#83)

- [x] Release the benign shared-seat handoff normally: the classifier confirms
      a `400006` return whose log proves the ULF serial return with a
      completed command (maintainer directive 2026-09-07; implements the
      re-opened #106 part 2). No quarantine, no red cleanup gate.
- [x] Keep fail-closed quarantine for a `400006` without ULF proof, degraded
      reports, timeouts, truncation, and termination. Enforced by the session
      068 classifier verdict tests; verified again 2026-09-07.
- [ ] Decide holder capacity against real seat capacity: independent
      returnable Unity identities, slot-aware state, and two-order live proof.

## M3: consumer enrollment drift (#113)

- [x] Zero-touch repin automation: the central `Repin consumer lock
      references` workflow opens repin pull requests in enrolled
      repositories for every newly authorized release. Session 089 added
      auto-merge (operator decision on #266): offers merge on green without
      a click; a per-repository `Allow auto-merge` opt-out restores a
      manual gate.
- [x] Confirm the automation App's registered permissions include
      Pull requests write and Workflows write (org-wide installation is the
      standing operator configuration). Operator-confirmed 2026-09-07; no
      new App; the reader App stays read-only.
- [ ] Drive the audit findings down repo by repo. The fixes are consumer-side
      edits; this repository supplies the evidence and the contract. The
      per-reason-code fix contract is published in
      `docs/consumer-enrollment.md` and linked from the drift issue.
      Session 079 opened reviewed fix pull requests for every one of the
      64 findings, each verified against the unmodified local analyzer
      over all six enrolled snapshots (0 findings, complete). unity-helpers
      #749 merged 2026-09-11, clearing its 27 structural findings. New
      drift reopens the count: session 092 opened DxMessaging #582 for the
      `missing-unity-editor-check` regression that #580 introduced.
      Merges are consumer decisions.
      IshoBoy closed repin offer #855 unadopted (2026-09-07); a
      consumer-closed offer is a decline, so the automation never re-offers
      it. unity-helpers declined the earlier repin by closing #738.
- [ ] After M3, the scheduled audit closes alert #113 automatically on the
      first complete clean run. #113 stays open while any drift finding
      stands, as it did through the DxMessaging prefix regression.

## Blocked on authority or evidence (do not start here)

- #29 canaries and monitoring, #44 truthful aggregates, #51 App credential
  scope, #53 FIFO starvation: each needs organization-owner authority,
  portal decisions, or multi-week live evidence windows. Triage recorded
  2026-09-06 (session 066) and 2026-09-07 (session 067).
- #153 Windows-container trusted cleanup and the Darwin verifier release:
  PR #240 landed the Darwin action design with its requirement compiled in
  CI (draft #228 is closed as superseded), and stays runtime-only until
  #229's canary reads the Developer ID Application team on a real macOS
  install and an exact-head licensed canary runs. The enrollment-audit
  admission contract for the Darwin shape is done; the reviewed
  `approvedDarwinReturnShas` merge is the separate authorization step that
  follows a Darwin-capable release. Issue #229 tracks the remaining canary,
  authorization, and Windows-container work.
