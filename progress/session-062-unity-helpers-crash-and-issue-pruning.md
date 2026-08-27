# Session 062: Unity Helpers crash RCA and issue pruning

Date: 2026-08-27

## Objective and invariants

Review the live central and Unity Helpers issue surfaces, close at least five
open issues when evidence proved them complete, duplicate, or obsolete, and
remove the Unity Helpers PR #581 test blocker without weakening fail-closed
license cleanup. The session used only the existing GitHub connector and
repository checkouts; it provisioned no app, credential, Unity editor, or
runner software.

## Baseline and inventory

The central repository began clean on `main` at `d8f187342`, equal to
`origin/main`. Sixteen central issues and twenty-four Unity Helpers issues
were open at the first inventory. Unity Helpers PR #581 was the only open
pull request and had passed every hosted gate, every Edit/Play Mode leg, both
Unity 6 standalone legs, and both Unity 6000.3 single-threaded legs, while its
2021 and 2022 standalone jobs failed.

The session kept all security contracts closed:

- ambiguous acquisition or cleanup remained red and quarantined;
- no return failure was relabeled as success;
- no issue was closed on title similarity or elapsed time alone;
- runner and account incidents remained separate from product/test defects.

## Unity standalone root cause

The first issue report attributed every red leg to runner-seat cleanup. A fresh
failed-job rerun of Unity Tests run `33050443415` disproved that hypothesis.
Both pre-Unity-6 standalone jobs failed deterministically:

- Unity 2022 job `98590263098`;
- Unity 2021 job `98590263120`.

The symbolized native stack named
`IntMapTests_MeasureAllocated` and
`KeysAndValuesViewsEnumerateLiveEntriesWithoutAllocating`. The new helper
directly called `GC.GetAllocatedBytesForCurrentThread()`. The repository's
canonical `GCAssert.IgnoreIfAllocationMeasurementUnavailable()` documents
that this API access-violates instead of throwing on IL2CPP before Unity 6 and
must run before every direct counter access.

A repository-wide source sweep found the IntMap helper was the only unguarded
allocation measurement. The test already performed its live-key/value
correctness assertions before allocation measurement, so the narrow fix adds
the canonical guard at the start of `MeasureAllocated`. Correctness still
runs everywhere; only the allocation assertion is skipped on runtimes that
cannot measure it.

The correction is Unity Helpers PR #581 commit `40379b42`. Issue #584 was
retitled and rewritten so its open acceptance criterion now describes the
deterministic crash rather than the falsified cleanup-only claim.

## Validation

The Unity Helpers change passed:

- CSharpier formatting;
- the targeted test lifecycle linter, including null-check autofix mode;
- all four test typecheck configurations (default, legacy protobuf, Odin, and
  single-threaded), each with zero warnings and errors;
- changed-file agent preflight;
- the pre-push Git/config safety gate;
- `git diff --check`.

The Git credential helper correctly failed closed because its non-interactive
cache was empty. The already-connected GitHub app wrote the byte-identical
validated file to the existing PR branch; remote content blob
`e67bf661c2ad48ce708cd208ad88034e5a16b13d` matched the local formatted blob.
No new connector or token was created.

The central `.devcontainer/scripts/verify.sh` aggregate passed on the session
record: LLM harness and repository policy checks, 824 Node tests (821 passed
and three expected platform skips), every Go package and race pass, module
verification, static analyzers, ShellCheck/actionlint policy, and the workflow
credential-literal audit.

Fresh hosted run `33094155522` passed all eight primary Edit/Play Mode jobs,
all four standalone jobs, both Unity 6000.3 single-threaded jobs, and every
non-Unity workflow. Jobs `98600745120` and `98600745298` are the direct
Unity 2022 and 2021 standalone regression proofs. Final package smoke,
aggregate, merge, and post-merge results are recorded in the delivery section.

## Issue dispositions

Six issues that were open at session start were closed with an evidence comment
before the state change:

1. Unity Helpers #325, completed: IshoBoy PR #317 merged and its exact-head
   Unity CI run `30600000606` passed; remaining migration work has its own
   #411/#498 trackers.
2. Unity Helpers #356, duplicate: corrected evidence showed its reported
   reason was not the underlying failure; #411/#498 own the durable digest and
   evidence contract.
3. Central #27, duplicate: #29 owns the same seven-day canary acceptance
   window.
4. Central #60, not planned: the requested release/pin prerequisites are
   obsolete, while literal zero cooldown remains unsafe until #83 resolves
   entitlement collision behavior.
5. Central #94, not planned: upstream and module checks both reported
   actionlint v1.7.12 as latest; yaml v4 rc.6 remains incompatible and
   Dependabot will surface the next actionable release.
6. Unity Helpers #584, completed: both deterministic pre-Unity-6 standalone
   crashes passed on the patched head, together with their results verification
   and confirmed cleanup gates.

Central #126 initially remained open correctly. Re-running its successful
reaper job performed a fresh fenced reap, but replaying an old scheduled run
did not prove schedule delivery recovered. GitHub later delivered fresh
scheduled run `33096409342` at 17:03 UTC; the independent monitor changed its
body to `healthy` and closed it automatically. That is a seventh resolved
open-at-start issue without overriding the monitor's evidence authority.
Merging Unity Helpers PR #581 then auto-closed #582 through its exact
`Fixes #582` reference, producing an eighth resolved open-at-start issue.

All other reviewed open issues retained concrete TODO acceptance criteria.
Broad feature, performance, documentation, enrollment, secret-authority, and
POSIX cleanup work was not closed merely because it was inactive or large.

## Latest-action adoption evidence

The prior adoption record also assumed the shared runners needed editor
provisioning. Live sibling evidence falsified that assumption:
DxMessaging's default-branch Unity workflow uses the same
`[self-hosted, Windows, RAM-64GB]` pool, validates all four exact Unity
Helpers versions under `${{ runner.tool_cache }}\\u6-v3` with healthy-existing
enforcement, and returns through the central action.

No editor provisioning or reprovisioning is needed for the Windows migration.
Unity Helpers #411 now records the exact no-provision path: place the pinned
central `ensure-unity-editor` action immediately after the immutable head
guard and bind its validated `editor-path`.

Full-repository adoption remains a real TODO rather than a dead issue. Two
Ubuntu/Docker package-export callers hold licensed seats, while post-v1.13
identity-bound evidence deletion deliberately fails closed off Windows.
Unity Helpers #498 and central #153 own that platform implementation. This
session did not relax the digest, exact path, one-entry directory, or
identity-bound deletion requirements.

## Adversarial review and durable learning

The main-thread review explicitly tested the competing cleanup-only and
runner-only explanations against rerun evidence. Native symbols, a two-version
boundary, passing Unity 6 controls, and the repository's existing crash guard
falsified both. A second pass verified the fix executes before warmup and
counter access and that correctness assertions remain unconditional.

No delegated reviewer was used because delegation was not requested and the
session's execution policy prohibited proactive sub-agents. The main-thread
fallback is recorded here as required.

No new durable instruction was added. Existing test-failure guidance already
requires treating every failure as real, distinguishing test defects from
production defects, preserving assertions where they remain measurable, and
recording exact remote evidence. The corrected issue body, regression guard,
PR comment, and this progress record are the durable artifacts.

## Delivery

- Unity Helpers: [PR #581](https://github.com/Ambiguous-Interactive/unity-helpers/pull/581)
  merged as `836dccf5e9789629961c4b78faca54afef27abe9` after PR run
  `33094155522` completed green. Protected-branch run `33097700100`
  repeated every hosted gate, eight primary legs, four standalone legs, two
  single-threaded legs, Linux package smoke, and the aggregate on the exact
  merge commit; every job passed.
- Central session record: pending this record's pull request.

The remaining delivery gate is this record's central pull request and its
post-merge `main` verification.
