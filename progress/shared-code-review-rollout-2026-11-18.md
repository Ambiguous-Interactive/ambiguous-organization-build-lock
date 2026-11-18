# Shared code review rollout

Date: 2026-11-18 UTC.

## Task and acceptance

Install the released shared reviewer in this repository. Keep build-lock admission,
cleanup, recovery, release, and required CI gates unchanged. Review must stay
advisory, use the pinned shared source, and exclude fork, bot, and draft requests.

## Baseline and hypothesis

Baseline: `3a0172adeba4e1aaa8e5f4d92dd1cdd7b31c118f`.
There is no shared review caller. A guarded call to review-tools v1.1.0 should
provide bounded partial review without executing consumer code or using licensed
resources. A conversion to draft must cancel the older review run.

## Change

- Add the SHA-pinned shared caller with one named secret and job-scoped PR write.
- Keep workflow-wide content access read-only and cancel superseded PR reviews.
- Add the workflow and its review job to both existing policy inventories.
- Document the physical temporary-root requirement for local macOS safety tests.

The caller grants full PR write capability because GitHub has no comment-only
scope. Only the pinned reusable job receives it. That implementation posts
reviews; it does not merge pull requests.

## Experiments and evidence

1. The caller file is absent on the baseline.
2. Adding the caller makes both workflow inventory checks fail, as expected.
3. Listing its one reusable job and zero inline run scripts makes all 73 workflow
   policy cases pass. Existing safety tests remain in force.
4. The default native macOS Node run has 20 failures in path-safety fixtures.
   The unchanged baseline reproduces the cleanup fixture failures. The rejected
   paths cross the host's symlinked temporary directory.
5. With `TMPDIR=/private/tmp`, the complete Node suite reports 1,050 passed,
   zero failed, and three platform-specific skips. No production path guard changes.
6. Pinned actionlint, the credential-literal audit, JavaScript and shell analyzers,
   Go tests, vet, race tests, both module verifications, both tidy-diff checks,
   and golangci-lint pass.

The local host lacks `setsid`, so the verifier's checks run as their individual
commands. The Linux CI and devcontainer workflows remain the delivery gates.
Hosted results and the live review marker must be checked before merge.

## Review and retrospective

Two independent fresh-context review rounds found no actionable issues.
The final round includes the caller, policy inventories, knowledge change, and
evidence record. The primary agent implements; separate agents review.
No remediation role is needed because neither round reports a finding.

Observed fact: a physical temporary root lets the existing safety tests exercise
the intended file operations on macOS. The symlink refusal itself is correct.
Promotion: revise the existing testing skill with that local precondition.
No new action, runtime, helper, validator, hook, or licensed workflow is needed.
