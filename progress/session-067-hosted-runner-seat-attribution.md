# Session 067: attribute the non-self-hosted Unity seat holder

Date: 2026-09-07

## Objective and safety invariants

Advance the standing goal: merge `origin/main`, carry forward in-progress
work, act on the highest-impact open issue, and deliver one green pull
request. Preserve licensed-resource safety, queue fairness, fail-closed
cleanup, immutable action references, credential confidentiality, and
operator-visible evidence.

## Baseline

- The worktree held an unfinished `git merge origin/main` with a conflict in
  `unity-enrollment-policy.json`. Local `main` carried two unpushed commits:
  the maintainer's `.gitattributes` LF normalization (`a3d0942f8`) and a
  bot-authored commit named `drift` (`7afe4781a`).
- `origin/main` had advanced by PR #224, which authorized v1.14.0
  (`64bac4469`) in both allowlists and shipped the classifier attribution
  and the authorization pull-request automation from session 066.
- The `drift` commit appended `a8d43dd87` to `approvedLockShas`. That SHA
  was already allowlisted at the top of the same array, so the commit added
  a duplicate entry. The enrollment audit fails closed on duplicate
  approved SHAs (`internal/enrollment/unity_policy.go`), so this commit
  would have turned every scheduled audit red without adding any
  authorization value.
- Local branches `fix/issue-222-223-release-auth-and-return-attribution`
  (content-identical to `origin/main`) and `release-authorization/v1.14.0`
  (superseded by PR #224) were stale.
- Open issues: #223, #113, #83, #153, #53, #51, #44, #29. Issue #223 carried
  a new maintainer request: identify the non-self-hosted machine shown in a
  Unity portal seat screenshot.

## Repository state recovery

- Reset `main` to `a3d0942f8`, dropping only the `drift` commit, then merged
  `origin/main` cleanly (`ac3bc717c`). The merge keeps the maintainer's
  `.gitattributes` work and the reviewed v1.14.0 authorization. The policy
  now ends at the merged state with no duplicate entries (verified by
  parsing both allowlists).
- Deleted the two stale local branches. `PLAN.md` did not exist in any
  reference; this session created it as the living milestone plan.

## Issue #223: identify the non-self-hosted seat holder

Root cause analysis of the maintainer request:

1. The portal row shows a container-style machine id, a root user, and a
   client address inside GitHub Actions range `135.232.128.0/17`. The seat
   was taken by a GitHub-hosted Actions runner, not by the self-hosted
   fleet. Method and evidence boundary recorded in
   `.llm/research/github-hosted-seat-attribution-2026-09-07.md`.
2. The audit had no finding for this class. `selfHostedJob` gated only the
   runner preflight requirement, so a paid Unity job whose `runs-on` lacked
   `self-hosted` escaped every self-hosted runner control while still
   passing lifecycle checks.

Fix: `auditPaidJob` now records `unsafe-hosted-unity-runner` for every paid
job whose `runs-on` is not a sequence containing a literal `self-hosted`
label. Dynamic or ambiguous runner expressions fail closed. The audit
remains evidence-only: it changes no admission decision and weakens no
fail-closed path.

Live verification against all six enrolled repositories at their default
branch heads: findings went from 101 to 103. The only added findings are
`unity-helpers` `release.yml` `unitypackage` and
`unity-tests.yml` `unitypackage-smoke`, both licensed export jobs on
`ubuntu-latest`. No baseline finding moved. This names the maintainer's
unknown machine: the hosted export jobs acquire the organization lock and
activate Unity inside containers on GitHub-hosted runners, which matches
the portal row exactly. Their disposition (self-hosted move or reviewed
exception) is a maintainer decision, tracked in `PLAN.md` M1.

## Validation

Red/green and full-suite evidence:

- New data-driven Go test
  `TestUnityEnrollmentRejectsLicensedJobWithoutSelfHostedRunner` covers the
  hosted label, a label set without `self-hosted`, and a dynamic
  `runs-on` expression. Red before the change, green after.
- Live audit diff before/after the change across the six enrolled
  repositories: exactly the two unity-helpers findings added, all 101
  baseline findings unchanged, `complete=true`, 114 active inventory rows.
- `go test ./...`, `go vet ./...`, `go mod verify`, `go mod tidy -diff`
  (both modules), and `golangci-lint run --timeout=5m`: passed.
- `node --test test/*.test.js`, `node tools/llm-harness.mjs check`,
  actionlint, JavaScript and ShellCheck gates, the workflow credential
  audit, and `git diff --check`: passed. Full command list matches
  `.llm/context.md` validation.

## Review

Adversarial self-review covered unsafe success paths (the finding is
evidence-only and cannot weaken admission, cleanup, or quarantine),
false-positive risk (checked against every live enrolled repository, not
just fixtures), documentation drift (enrollment contract bullet added,
research note indexed, `PLAN.md` created), and generated-file drift (harness
index regenerated and checked). The duplicate-allowlist guard already
existed in the audit, so the `drift` class needed no new guard.

## Continuous improvement

The substantial-work gate applied. The durable investigative technique
(portal address range plus audit pairing) is recorded as a research note in
`.llm/`, because it turned one opaque portal row into named workflow and job
evidence and is likely to recur while #83 and #223 stay open. The finding
itself is enforced by production code and tests, so no competing `.llm`
rule is warranted.

## Delivery

Local commits on branch `session-067-hosted-seat-attribution`, pushed to
origin. The branch carries the merged `origin/main` state, the maintainer's
`.gitattributes` commit, and this session's work as one aggregate pull
request: #225. GitHub API auth came from the VSCode GitHub session through
the git askpass path; the method is recorded in
`.llm/tasks/devcontainer-github-auth.md`. The sanitized issue comment for
#223 stays in the pull-request handoff for posting after merge.
