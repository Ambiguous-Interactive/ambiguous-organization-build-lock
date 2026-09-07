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
- The enrollment audit admits the central return on Windows and, for pins
  listed in the new reviewed `approvedDarwinReturnShas` allowlist, on macOS.
  The allowlist is empty until a Darwin verifier release exists (#153, #228).
- The in-repo #229 follow-ups are done: `gofmt` is a CI formatter gate, and
  the three tests that settled only through unref'd event-loop timers now
  use ref'd keep-alive floors.
- Repin automation honors reviewed, expiring `repinExceptions`: a pin-only
  update can no longer move a caller to an action whose input contract the
  caller cannot satisfy (#233 follow-up).
- The scheduled enrollment audit reports stale or expired `repinExceptions`
  entries as `expired-repin-exception` and `stale-repin-exception` findings
  in the drift issue (#234). The repin rewrite keeps its own fail-closed
  gate.

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
      repositories for every newly authorized release (operator directive
      2026-09-07). Consumers merge; the automation never does.
- [x] Confirm the automation App's registered permissions include
      Pull requests write and Workflows write (org-wide installation is the
      standing operator configuration). Operator-confirmed 2026-09-07; no
      new App; the reader App stays read-only.
- [ ] Drive the audit findings down repo by repo. The fixes are consumer-side
      edits; this repository supplies the evidence and the contract. The
      repin workflow has not run yet; its first scheduled run is the next
      observable step.
- [ ] After M3, the scheduled audit closes alert #113 automatically on the
      first complete clean run.

## Blocked on authority or evidence (do not start here)

- #29 canaries and monitoring, #44 truthful aggregates, #51 App credential
  scope, #53 FIFO starvation: each needs organization-owner authority,
  portal decisions, or multi-week live evidence windows. Triage recorded
  2026-09-06 (session 066) and 2026-09-07 (session 067).
- #153 Windows-container trusted cleanup and the Darwin verifier release:
  PR #228 carries the Darwin action design and stays draft until the Unity
  Darwin team identifier is read on a real macOS install and an exact-head
  licensed canary runs. The enrollment-audit admission contract for the
  Darwin shape is done; the reviewed `approvedDarwinReturnShas` merge is
  the separate authorization step that follows a Darwin-capable release.
  Issue #229 tracks the remaining canary, authorization, and
  Windows-container work.
