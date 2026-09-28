# Session 109: refresh release facts and review shared-seat evidence

Date: 2026-09-28

## Task and safety rules

Continue the open-issue triage. Favor a small central change with low Unity CI
churn. Preserve cleanup proof, fail-closed admission, and the two-holder limit.
Do not change organization policy.

## Baseline

- `main` was clean at `01994c9be727ccb53ae66dd021009a1ec98f50c2`.
- Build Lock CI passed on main after PR #298.
- The operations facts and runbook still named v1.14.0, while v1.15.0 was the
  latest published release and its SHA was in `approvedLockShas` and
  `approvedReturnShas`.
- `approvedDarwinReturnShas` is empty. Darwin return approval remains a
  separate policy decision.

## Evidence and change

PR #227 already fixed the reported 400006 shared-seat classification. The
classifier accepts cleanup only when it has return proof, a completed command,
and no termination or timeout. It keeps weaker evidence unknown and fail
closed. Tests cover the exact shared-seat case and fail-closed variants.

Recent consumer evidence also shows v1.15.0 in DoxReloaded's workflow. IshoBoy
PR #995 and the scheduled repin workflow completed with v1.15.0. These facts
show rollout progress. They do not resolve issue #83's separate question about
independently returnable identities and live portal reconciliation.

I updated `docs/operations-facts.json` and `docs/operations-runbook.md` to name
v1.15.0 as the latest authorized release for lock and standard return actions.
The runbook points readers to the separate Darwin approval list. I updated the
documentation contract test to enforce this wording.

## Priority review

The shared-seat CI false-red described in issue #83 has a central fix and
consumer adoption evidence. The remaining capacity question needs independent
return identities and live reconciliation evidence. Do not claim that question
is solved or lower the cooldown based on the classifier fix.

Issue #278 remains open after its RCA correction in session 108. The cited lock
events show clean admission and release. The first Unity test log and consumer
retry details are still missing.

## Adversarial review and disposition

- The release SHA is authorized for lock and standard return actions.
- Darwin return approval remains governed by its separate allowlist.
- No action runtime, lock behavior, capacity, cooldown, or policy file changed.
- The docs now state the exact approval scope and release commit.
- No durable agent guidance change is needed. The change corrects current
  operational facts and adds a test for the scope wording.

## Validation

`node --test test/documentation-policy.test.js` passed all 11 tests. The full
`.devcontainer/scripts/verify.sh` check passed, including the repository tests,
Go checks, linters, and credential audit. `git diff --check` passed.

Run hosted Build Lock CI on the pull request before merge.
