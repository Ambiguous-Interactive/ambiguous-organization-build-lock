# Session 037: Represent the managed alternate editor

Date: 2026-07-31

Status: central implementation merged and verified; authorization pending

## Trigger

Issue #160 consumer rollout reached IshoBoy #317. Its trusted provisioning guard
observed the editor at
`runner.tool_cache/u6-v3/_ci-managed-editors/6000.5.2f1/Editor/Unity.exe`.
Central return can currently address only
`runner.tool_cache/u6-v3/6000.5.2f1/Editor/Unity.exe`, so the job correctly
failed before credentials or activation.

Changing `tool-cache` cannot insert `_ci-managed-editors` after the action's
hard-coded `u6-v3` segment. A proposed consumer-only adjustment was independently
rejected before commit because it would have constructed a nonexistent path and
risked leaving an activated seat held.

## Direction

Issue #163 defines a closed `editor-layout` selector. The default preserves the
canonical path; the only alternate literal selects the reviewed helper layout.
Arbitrary paths and expressions remain outside cleanup authority.

## Evidence

Red tests failed at alternate runtime resolution, manifest synchronization,
invalid-layout rejection, and analyzer acceptance. The minimal implementation
adds a manifest default and validates the enum independently in both input
parsing and path resolution. It then feeds the resolved path through the
existing reparse, file-identity, Authenticode, bounded execution, redaction, and
typed-evidence controls.

Focused evidence:

- Return runtime plus action manifest: 63 passed.
- Enrollment alternate acceptance plus mutation suite: passed.
- Diff whitespace validation: passed.

Full verification passed 678 Node tests (676 passed, two Windows-native
classifier tests skipped locally), every Go package, both module verifiers,
actionlint, the LLM harness, and the credential-literal audit.

## Review and durable learning

The independent reviewer found one P2 compatibility gap: tests asserted that
the manifest exposed `editor-layout`, but did not bind `required: false` and
`default: canonical`. A manifest-only mutation could therefore redirect every
omitting consumer while runtime tests still exercised the JavaScript fallback.
The manifest test now exact-binds the optional canonical default, and the
runtime test independently proves that omission resolves to canonical. The
reviewer returned PASS after remediation.

The reusable lesson is already retained at the narrowest executable boundary:
public action defaults need manifest-level assertions in addition to runtime
fallback tests. No repository-wide skill change is justified by this single
interface addition.

## Immutable rollout boundary

PR #164 squash-merged as
`d72d1072accbc8090874b5aa257be3e56774de5d`. Post-merge Build lock CI run
`30596311160` passed both Linux and hosted-Windows jobs, and organization
enrollment audit run `30596311153` passed on that exact `main` commit.

This separate authorization change adds that now-reachable implementation to
both `approvedLockShas` and the narrower credential-bearing
`approvedReturnShas`. Consumers may pin it only after this authorization merges
and main remains green. Exact-head consumer canary evidence remains pending.
