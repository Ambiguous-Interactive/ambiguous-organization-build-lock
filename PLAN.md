# Plan

Living milestone plan for the organization build lock. Keep it current:
remove completed or obsolete items after each session. Order milestones by
impact on licensed-resource safety and consumer CI churn.

## Current state (2026-09-13, session 096)

- Session 096 fixed the `Repin consumer lock references` failure (red since
  2026-09-10): the superseded-offer scan passed `--limit 0` to `gh pr list`,
  which current `gh` rejects. The scan now takes a bounded page of 100 and
  fails closed on a full page; the test mock mirrors real `gh`. Live
  verification lands with the first scheduled run after the fix merges.
- Session 096 also RCA'd the four post-flip findings on unity-helpers
  `unity-tests`: #776 added a dynamic `selected-version` matrix axis, which
  defeats the audit's static cell enumeration, so the return-input and
  editor-gate proofs fail together. Reviewed consumer fix: unity-helpers
  #785 restores the #772 static axis. Verified with the unmodified analyzer
  over all six snapshots: findings=0, complete=true, 119 active jobs. #113
  auto-closed 2026-09-12 21:36 UTC on the first clean audit, then reopened
  for these four findings.
- The #274 flip cohort is complete. Four flip pull requests merged
  (DoxReloaded #835, DxMessaging #584, IshoBoy #906, unity-helpers #776);
  qora-redux `main` already canceled (#396 closed as compliant) and
  unity-builder is the exempt fork with manual paid workflows, so neither
  needed a flip. The contract enforces literal
  `cancel-in-progress: true` on workflow scopes that reach acquire, keeps
  aggregate reporters on literal false, and admits the literal standalone
  profile on a static matrix.
- v1.14.0 (PR #224) and v1.14.2 (d79e1cc2a, PR #247) are released and
  authorized for consumer pins. v1.14.1 stays unauthorized by design
  (superseded within minutes; discovery offers only the newest release).
- `Auto release` opens the release-authorization pull request after every
  release. Merging it stays the human decision.
- The cleanup classifier attributes generic return failures through
  `licensing-codes-checked` and `licensing-code-matched` outputs.
- The enrollment audit rejects licensed Unity jobs on GitHub-hosted or
  ambiguous runners (`unsafe-hosted-unity-runner`), admits the central
  return on Windows and, for pins listed in the reviewed
  `approvedDarwinReturnShas` allowlist, on macOS. The allowlist is empty
  until a Darwin verifier release exists (#153, #228).
- The Darwin trusted return runtime landed (PR #240, squash-merged as
  6a384393c). The analyzer still refuses every Darwin return until
  `approvedDarwinReturnShas` names a release (#231).
- Repin automation honors reviewed, expiring `repinExceptions`, closes its
  own superseded offers, normalizes release version comments for
  Dependabot visibility, and enables auto-merge on every offer (squash
  preferred; a repository-level `Allow auto-merge` opt-out restores a
  manual gate). A closed repin pull request is the consumer's adoption
  answer: never re-offered, never force-updated.
- The drift issue links the reviewed per-code fix contract. The 64-code
  audit vocabulary is test-locked to `docs/consumer-enrollment.md`.
- The scheduled audit survives a consumer push that lands mid-run, and
  reports stale or expired `repinExceptions` entries.
- The central merge-policy drift audit (#44 item 7, #252) compares the
  reviewed expectation list with each consumer's live rulesets daily. The
  #252 blind spot (ruleset `bypass_actors` need a ruleset-write caller) is
  filled by consumer attestations in
  `.github/merge-policy-attestation.json`, proven fresh against the live
  ruleset (session 083). All attestation pull requests merged; ruleset
  22983578 on unity-helpers requires `Unity CI Success`.
- Session 091 answered the lock-side half of #269: the release action
  publishes a redacted `peer-timeline` output and job-summary table. The
  consumer half is canary item 12 of the enrollment contract. Lock-state
  history proves no peer held the lock in either #269 casualty window.

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
      The #274 flip cohort merged across all six consumers (DoxReloaded
      #835, DxMessaging #584, IshoBoy #906, unity-helpers #776); the first
      clean audit closed #113, which then reopened for the four
      static-matrix findings that #776 regressed. Session 096 opened
      unity-helpers #785 for those. unity-helpers #749 merged 2026-09-11,
      clearing its 27 structural findings. Merges are consumer decisions.
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
