# Session 108: correct the issue 278 summary

Date: 2026-09-28

## Task and safety rules

Recheck the open issue and pull request state after session 107. Correct claims
that the lock evidence disproves. Preserve the original report and the missing
evidence. Do not change lock behavior, licensed workflows, or organization
policy.

## Baseline

- `main` was clean at `47f0190a8199f7f9b7f7550c48f0cc43a5f91081`.
- GitHub still showed 12 open issues and no open pull requests.
- Build Lock CI passed on this exact main commit in run `36374252443`.
- Issues #269 and #278 still described the same Baselib teardown class.
- The latest comment on #278 records the lock-state RCA for all attempts.

## Evidence and change

The #278 RCA shows both attempts acquired and released normally. The quoted
`Lock is held by` and cooldown lines are standard release output. The first
attempt began after the full-lock window ended. It had no acquire failure or
queue timeout. The retry had a separate editor teardown failure.

The issue title said a seat collision caused the failure. I changed it to
`Unity test failures occurred after clean lock admission and release`.
I added a dated status section that records the RCA and links the remaining
editor failure to #269. I preserved the original report below that section.

The issue remains open. Its first Unity failure has no retained test log, and
consumer retry behavior remains unresolved. This record does not claim that
those items are fixed.

## Priority review

The open issue inventory remains the one recorded in session 107. The highest
impact items still need owner policy changes or live Unity evidence. Issue #269
has no remaining central implementation work identified. No safe, higher
impact central code change is available from current evidence.

## Adversarial review and disposition

- The title no longer claims a lock collision caused the test failure.
- The original report remains intact as historical evidence.
- The status section distinguishes observed lock events from the missing test
  cause and the separate consumer work.
- No lock, cleanup, queue, license, or organization policy path changed.
- No durable repository guidance was found to promote from this issue edit.

## Validation

Run `.devcontainer/scripts/verify.sh` after this record is added. Run hosted
Build Lock CI and review checks on the resulting pull request before merge.
