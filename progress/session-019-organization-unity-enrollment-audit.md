# Session 019: organization Unity enrollment audit

## Goal and selection

Inventoried the 18 open issues and confirmed there were no open or draft pull
requests. Issue #83 has the highest raw production impact, but safe completion
is externally blocked by the shared Unity entitlement: serializing the two
returns still leaves one identity returning second, and the measured `400006`
result must remain quarantined until independent identities and both return
orders are proven. Issue #42 was therefore selected as the highest-impact
central change that can be completed without consuming a Unity license.

Issue #101 is feasible but lower impact: splitting its Node test process would
reduce the measured suite from about 2.9 seconds to a projected 1.4 seconds.
Issue #94 remains blocked because the current actionlint release still depends
on an incompatible YAML API. No dependency pull requests were open.

## Baseline and implementation evidence

- Starting `main`: `e87e1a26b9c62d2900104a3baf1e9089985676b1`,
  matching `origin/main`.
- Starting Build lock CI run `30304824741`: successful at that exact commit.
- Red proof: the focused enrollment package did not compile before the new
  organization policy API existed.
- Added a strict reviewed extensible registry with an immutable six-repository
  baseline, including the `unity-builder` fork, approved releases from v1.8.2
  through v1.10.0, and owned expiring synthetic-workflow exceptions.
- Added an exact-Git-object analyzer that flattens local composite actions and
  classifies Unity-related jobs without executing consumer code.
- Paid jobs are checked for eligible triggers, acquire-before-activation,
  immutable approved actions, positive typed cleanup evidence, always-run
  release and final gate, reader preflight, stable aggregate behavior,
  cancellation/fail-fast safety, and credential/environment placement.
- Added a bounded source-free JSON artifact and a marker-fenced issue
  synchronizer that creates, updates, reopens, or closes one central drift
  issue.
- Added a daily/manual workflow that derives a least-privilege Contents-read
  token scope, checkout targets, and head revalidation from the reviewed
  registry.
- PR #110 feedback requested a repeatable expansion path. The `Onboard Unity
  repository` manual workflow now validates one organization entry on trusted
  `main`, updates the registry atomically, and opens a registry-only pull
  request. Runtime coordination no longer requires four hand-maintained lists.

## Public dry-run evidence

The local token cannot retrieve the three internal/private consumers. A
no-Unity dry run over the three public repositories therefore correctly
reported `complete=false` and one sanitized
`repository-retrieval-incomplete` finding for each unavailable repository.
After eliminating exception bypasses and permissive shell inference, the latest
public dry run audited 73 Unity-related jobs and reported 135 conservative
policy findings. Three findings are the expected unavailable-private-repository
diagnostics; the remaining public findings identify jobs that do not match a
statically proven canonical lifecycle:

- DxMessaging and unity-helpers paid jobs use scheduled/tag/unreviewed trigger
  paths or lack an always-reporting aggregate.
- unity-builder controlled macOS/Windows jobs retain older cleanup contracts;
  the Windows job also has an unbounded push trigger.

The artifact contains repository, exact commit, workflow path, job,
classification, and reason code only. A complete scan with findings is green
only after the central issue is synchronized; that issue is the operational-red
signal. Incomplete evidence or issue synchronization remains workflow-red. The
standalone command returns nonzero in both cases.

## Validation and review

The first independent adversarial review found unsafe aggregate recognition,
credential references hidden at workflow/composite scope, syntactic rather
than producer-bound cleanup evidence, permissive triggers, selected-ref manual
secret exposure, and inconsistent registry expansion. A distinct remediator
added red regressions and closed the analyzer/registry findings. Manual dispatch
now uses a secretless launcher; its completion triggers the secret-bearing
workflow from trusted `main`.

Two fresh review rounds then found aliased and dynamically indexed secrets,
unguarded fork PRs, fabricated direct return evidence, failure-dependent
cleanup conditions, and aggregate fallthrough/preflight mismatches. The
remediator closed each path with negative fixtures and conservative canonical
contracts. Final focused re-review reported no findings.

PR #110 feedback requested an operator onboarding path. Three additional
adversarial rounds closed selected-ref write-token exposure, green-skipped
requests, missing metadata evidence, case-insensitive identities, unsafe Git
refs, workflow-output injection, canonical baseline/exception casing, and raw
REST fragment ambiguity. The final fresh review reported no actionable
findings.

Cursor Bugbot then found that disabled acquire and preflight steps could count
as affirmative evidence. The remediator generalized the contract across
critical jobs, direct steps, and enclosing composite calls: evidence must be
runnable and failure-propagating, with only absent or literal-false
`continue-on-error` accepted. Follow-up review also closed disabled aggregate
and failure-suppressed cleanup/aggregate paths. The final fresh review reported
no actionable findings.

`node tools/llm-harness.mjs generate` refreshed the knowledge index.
`.devcontainer/scripts/verify.sh` then passed 556 Node tests, every Go package,
actionlint, module verification, tidy-diff, workflow credential policy, and the
knowledge harness. Pull-request review, live registered-repository audit evidence,
merge, and post-merge main verification remain pending.
