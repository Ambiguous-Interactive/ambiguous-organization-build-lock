# Plan

Living milestone plan for the organization build lock. Keep it current:
remove completed or obsolete items after each session. Order milestones by
impact on licensed-resource safety and consumer CI churn.

## Current state (2026-09-07)

- v1.14.0 is released and authorized for consumer pins (PR #224).
- `Auto release` opens the release-authorization pull request after every
  release. Merging it stays the human decision.
- The cleanup classifier attributes generic return failures through
  `licensing-codes-checked` and `licensing-code-matched` outputs.
- The enrollment audit rejects licensed Unity jobs on GitHub-hosted or
  ambiguous runners (`unsafe-hosted-unity-runner`). The live audit
  (2026-09-07) identifies the unity-helpers hosted `.unitypackage` export
  jobs as the non-self-hosted Unity seat holder seen in the portal.

## M1: attribute every Unity seat to a lock holder (#223, #83)

- [x] Classifier emits licensing-code attribution (PR #224).
- [x] Audit names licensed jobs that run outside the self-hosted fleet.
- [ ] Decide the disposition of the unity-helpers hosted export jobs
      (`release.yml` `unitypackage`, `unity-tests.yml` `unitypackage-smoke`):
      move them to the self-hosted fleet or record a reviewed exception.
      Maintainer decision, tracked in #226.
- [ ] Determine whether a peer activation can invalidate a live incumbent's
      seat. Needs Unity portal evidence (#223, section 3).

## M2: shared-seat capacity decision (#83)

- [ ] Keep fail-closed quarantine for `unity-return-400006` until the
      organization has independently returnable Unity identities, slot-aware
      state, and two-order live proof.
- [ ] Re-evaluate #106 part 2 (normal release on a benign 400006) only after
      the M2 capacity evidence exists.

## M3: consumer enrollment drift (#113)

- [ ] Drive the audit findings down repo by repo. The fixes are consumer-side
      edits; this repository supplies the evidence and the contract.
- [ ] After M3, the scheduled audit closes alert #113 automatically on the
      first complete clean run.

## Blocked on authority or evidence (do not start here)

- #29 canaries and monitoring, #44 truthful aggregates, #51 App credential
  scope, #53 FIFO starvation, #153 Darwin and container cleanup: each needs
  organization-owner authority, portal decisions, or multi-week live
  evidence windows. Triage recorded 2026-09-06 (session 066) and
  2026-09-07 (session 067).
