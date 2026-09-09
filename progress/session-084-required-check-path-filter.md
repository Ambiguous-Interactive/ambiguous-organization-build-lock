# Session 084: required check withheld by a pull_request paths filter

The operator reported that the merge policy created on DoxReloaded is
broken. RCA confirmed it: the session 083 ruleset requires a check that
GitHub withholds from every pull request the reporting workflow's path
filter excludes. The rule and the fix are recorded in issue #258.

## Task, invariants, hypothesis

- Task: repair the DoxReloaded merge gate, keep every fail-closed path
  intact, and record the rule so the next enforcement cannot repeat it.
- Invariants: the licensed job still runs exactly when the classifier
  demands it; the aggregate still fails closed; no credential gains scope.
- Hypothesis: removing the `pull_request` paths filter restores the
  required report on every pull request at zero licensed cost, because the
  classifier already converts inert pull requests into audited skips.

## Evidence

- Ruleset 22595536 `Required CI - Success (default branch)` (session 083)
  requires `CI Success` on every DoxReloaded pull request to `main`.
- The `Build and Deploy` workflow produces that context through its
  `ci-success` job. Its `pull_request` trigger carried a `paths:`
  allowlist of 14 globs. `.github/merge-policy-attestation.json` matched
  none of them.
- Observed on attestation PR DoxReloaded #815: `mergeStateStatus BLOCKED`,
  checks limited to `Solver Impact` and `Supersede Licensed Runs`, no
  `CI Success`. A required status that never reports blocks a merge
  forever and nothing a maintainer re-runs can produce it.
- The defect was general, not specific to the attestation file: any pull
  request touching only unlisted paths (a README-only change) was
  permanently unmergeable.
- Precedent: qora-redux's gate workflow carries no `pull_request` filter
  and states the rule in-file; DxMessaging pairs its `paths-ignore`d
  Unity workflow with a companion gate that reports the required contexts
  on the excluded paths; IshoBoy's gate is unfiltered. Session 079
  recorded the DxMessaging companion for exactly this reason.
- The central gate contract already covers cost: `require-unity-validation`
  accepts `unity-required=false` with skipped licensed work as an
  `audited non-Unity skip` (`.github/dist/require-unity-validation.js`).

## What landed

- DoxReloaded #815 now carries two coherent halves:
  - the attestation file, as before;
  - the gate repair: `pull_request` runs unfiltered, `push` keeps its
    `paths:` filter, and the stale lockstep-list comments now state the
    gate rule with the #815 measurement. Committed as `cb94c16bf`.
- `docs/consumer-enrollment.md`: item 10 of `Before enforcing the
  aggregate as required` — confirm the reporting workflow runs on every
  pull request before enforcing the aggregate as required.
- Issue #258: RCA, why the central audits cannot see the defect, the
  five-repository class sweep, and the optional analyzer follow-up.
- Issue #255 comment: status and consumer-side disposition.

## Verification

- DoxReloaded local gates over the edited workflow: YAML parse,
  `lint-workflow-trigger-paths.py` self-test and live (1 workflow),
  `validate-inert-path-declaration.py` self-test and live
  (1 declaration): pass.
- Observed on #815 after the push: `Classify Unity-relevant changes`,
  `Static Validation`, and `Windows runner registration preflight` pass;
  the workflow now reports on this pull request, which it never did
  before. The licensed leg runs because the pull request edits a workflow
  file, which the classifier fail-closed treats as Unity-relevant.
- Central repository checks: see the pull request for the full suite.

## Follow-ups

- Merge DoxReloaded #815 once green; the merge unblocks the attestation.
- Optional, not scheduled: teach the enrollment audit to flag a required
  aggregate whose reporting workflow filters its `pull_request` trigger
  without a companion gate (#258).
- Before enforcing an aggregate on unity-helpers, apply item 10; its
  workflows have not been read against the rule yet (#255 finding).
