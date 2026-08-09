# Session 050: caller-declared independent paths for the Unity change classifier

Date: 2026-08-09

## Objective

Session 049 repaired `classify-unity-changes`, which had read `INPUT_EVENT_NAME` where the runner
sets `INPUT_EVENT-NAME` and so required Unity over a diff it never read. A consumer then measured
what the repaired classifier actually decides
([DoxReloaded#430](https://github.com/Ambiguous-Interactive/DoxReloaded/issues/430)):

> **0 of its 40 most recently merged pull requests would classify `unity-required=false`** — while
> **23 of those 40 changed nothing Unity compiles.**

The repair was necessary and saves nothing on its own. This closes the gap it exposed.

## Root cause of the remaining waste

`isUnityIndependent` carries one fixed allowlist — `.llm/`, `progress/`,
`.github/ISSUE_TEMPLATE/`, root `*.md`, three named files. Everything else requires Unity,
conservatively and correctly **as a default**. But `Benchmarks/**` is inert to one consumer's Unity
build and would not be to another: inertness beyond documentation is **caller-relative**, which is
precisely what that consumer's own local detector already records
(`detect-build-inert-push.sh`: *"Inertness beyond that is CALLER-RELATIVE and cannot live in a
shared list"*) and solves with an `INERT_PATHS` input.

That local detector does not gate the licensed job. The central classifier does, and it had no
per-caller mechanism at all.

## Change

`classify-unity-changes` gains an optional `independent-paths` input: newline-separated directory
prefixes THIS caller declares inert to its own Unity build, **unioned** with the central allowlist.
A declaration can only widen what one caller skips on; it can never narrow the central floor.

The grammar is deliberately the narrowest one that expresses the need, because this is a security
gate's trusted input and it is editable by whoever can edit the calling workflow:

- **`dir/**` only.** The reviewable question stays *"is that directory inert to that repository's
  Unity build"* and never *"what does this pattern match"*. A general glob needs a matcher a
  reviewer must reason about; a directory prefix does not.
- **Reserved prefixes are refused by name**, not left to review: `Assets/`, `Packages/`,
  `ProjectSettings/` (what Unity compiles) and `.github/workflows/` — a caller that declared the
  workflow directory independent would skip Unity on the pull request editing the workflow that
  *gates* Unity, the one change that must always fail open. Overlap in either direction is refused,
  so `Assets/Scripts/**` and `.github/**` are both rejected while `.github/scripts/**` is allowed.
- **Anything else throws, and the action fails closed** to requiring Unity. Parsing happens before
  the event check, so a workflow that cannot express what it means fails on the push that
  introduced it rather than lying dormant until its first pull request.

## Verification

Red-green on four new tests, all failing before the implementation:

- a declaration widens the allowlist and leaves the central floor identical with or without one;
- ten malformed or reserved declarations are each refused, and a reserved *sibling* is not;
- the committed runtime honours a declaration through the runner's real env name
  (`INPUT_INDEPENDENT-PATHS`) over a two-commit fixture repository, classifying `false`;
- the committed runtime exits 1 with `unity-required=true` on an unparseable declaration.

`test/action-manifests.test.js`'s exact-input-list assertion was updated deliberately — that
assertion exists so an input cannot be added to a security gate silently, and the reason for this
one is recorded beside it.

`node --test test/*.test.js` — 696 tests, 677 passed, 11 failed; the same 11 fail on a clean
checkout of `main` in this container (`spawnSync go ENOENT`; Go is not installed here), where the
baseline is 692/673/11. `bash tools/workflows/ci.sh syntax` passes.

## Consumer note

No consumer changes behaviour until it declares something: the input is optional and an absent
declaration reproduces today's classification exactly.
