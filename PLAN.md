# Plan

Living milestone plan for the organization build lock. Keep it current:
remove completed or obsolete items after each session. Order milestones by
impact on licensed-resource safety and consumer CI churn.

## Current state (2026-09-13, session 097)

- M3 is complete (see Completed milestones). No enrollment drift remains; a
  reopening follows the per-code contract in `docs/consumer-enrollment.md`.
- Session 097 verified the #279 repin fix live: dispatched run 34768908054
  completed green with the bounded superseded-offer scan in effect, and
  #280 closed with that run as evidence. The day's scheduled run
  (34743810332, created 06:52 UTC) started before #279 merged and still
  shows the old failure.
- Session 097 RCA'd #278 from lock-state history: the quoted "collision"
  lines are the release leg's normal summary output, and attempts 1 and 2
  of qora-redux run 34736599983 acquired, held, and released clean. The
  consumer's own push plus the reviewed `cancel-in-progress: true` flip
  cancelled attempt 3 before acquire. The same attribution data point went
  to #277; the remaining ask there stays an accepted evidence gap.
- The cancellation contract is standing: workflow scopes that reach acquire
  carry literal `cancel-in-progress: true`, aggregate reporters keep
  literal false, and licensed matrices use `fail-fast: false`.
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
- The 64-code audit vocabulary is test-locked to `docs/consumer-enrollment.md`.
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

## Completed milestones

- M3 (consumer enrollment drift, #113) closed 2026-09-13: zero-touch repin
  automation with auto-merge, the per-code fix contract, the #274 flip
  cohort (DoxReloaded #835, DxMessaging #584, IshoBoy #906, unity-helpers
  #776; qora-redux `main` already canceled, unity-builder exempt), and the
  unity-helpers static-matrix restore (#785) drove the audit to 0 findings
  over 118 active inventory rows. The alert auto-closed as completed
  (run 34770239068).

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
