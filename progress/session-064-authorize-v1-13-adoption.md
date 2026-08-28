# Session 064: authorize v1.13 Unity adoption

Date: 2026-08-28

## Objective and safety invariants

Authorize the already published and reviewed v1.13.0 central action release so
Unity Helpers can migrate to the central editor and return executors without an
`unapproved-lock-ref` finding. Preserve immutable action references, the
narrower credential-bearing return allowlist, exact cleanup evidence,
identity-bound deletion, quarantine on ambiguous cleanup, and fail-closed
consumer enrollment.

## Baseline and root cause

- Central `main` was clean at `c996c750a`, equal to `origin/main`.
- Unity Helpers dependency PR #590 pinned v1.13.0 for acquire, release,
  runner-preflight, and current-head actions, but its contract suite failed at
  the two local classifier calls because the new classifier requires the digest
  produced only by the central return executor.
- The central release commit `300501e91c9bec81bb9b5a977c22aa5bb2d9b649`
  was absent from both `approvedLockShas` and `approvedReturnShas`. A correct
  consumer migration would therefore still be rejected by the organization
  enrollment audit.
- The release is the exact v1.13.0 tag and merged PR #209. Session 059 already
  records protected-main CI green at this exact commit.

Root cause demonstrated: the reviewed action release was published, but the
separate policy-authorization step required before consumer use never landed.
The consumer's missing digest is a second, downstream workflow defect; locally
hashing consumer-produced evidence is not an acceptable substitute for the
central executor.

## Authorization boundary

The global authorization comparison used the latest previously approved lock
SHA, `f5c883c96dba0cf79240df7ac150a3ef545b3287`, as its base. Every changed
public action/runtime under `.github/actions` and `.github/dist` maps to a
reviewed, merged change:

- `build-lock.js`: linear queue cleanup from PR #193, the wall-clock release
  retry budget and typed failure reason from PR #198, and shared
  server-directed/credential retry budgets from PR #202;
- `classify-unity-changes` manifest/runtime: bounded caller-declared inert
  directories from PR #194;
- `release-build-lock` manifest plus the confirmed-cleanup and Unity-validation
  gate runtimes: the release retry contract and fail-closed diagnostic from PR
  #198;
- `check-unity-runners.js`: the shared retry contract from PR #202;
- `require-current-pr-head.js`: raw rate-limit instruction honorability from PR
  #208;
- `ensure-unity-editor` manifest, runtime, typed adapter, and vendored
  validator: the reviewed central editor authority from PR #209.

The remaining commits between those SHAs changed CI, analyzer, documentation,
dependencies, or progress evidence rather than a pinned public action/runtime.
Build lock CI run `32432225968` passed both Linux and Windows jobs at the exact
v1.13.0 tree, and organization enrollment audit run `32432225995` passed at
that same commit. The current complete verifier independently re-exercised the
tree before this policy edit.

The narrower return authorization used the latest already approved return SHA,
`d72d1072accbc8090874b5aa257be3e56774de5d`, as its base. There is no byte
change through v1.13.0 in any of these credential-bearing files:

- `.github/actions/return-unity-license/action.yml`;
- `.github/dist/return-unity-license.js`;
- `.github/actions/classify-unity-cleanup-evidence/action.yml`;
- `.github/dist/classify-unity-cleanup-evidence.js`.

Authorizing the release in the narrower return list therefore does not
authorize new return-executor bytes; it allows the unchanged reviewed executor
and classifier to be pinned together with the globally reviewed v1.13 action
tree.

## Red and green evidence

Before the edit, a direct policy assertion failed and reported that v1.13.0 was
absent from both approved SHA sets. The policy now adds exactly that immutable
release commit to both sets.

Focused validation passed:

- direct policy membership assertion for both SHA sets;
- `go run ./cmd/audit-unity-enrollment -policy unity-enrollment-policy.json
  -validate-policy-only`;
- `node tools/llm-harness.mjs check`;
- all 10 documentation-policy tests;
- `go test ./internal/enrollment`;
- `git diff --check`.

The complete `.devcontainer/scripts/verify.sh` gate then passed: 824 Node
tests (821 passed and three expected platform skips), every Go package and race
test, both module verification and tidy-diff gates, Go vet, golangci-lint,
actionlint, JavaScript and ShellCheck policy, the LLM harness, and the workflow
credential-literal audit.

## Review and continuous improvement

An independent adversarial reviewer found one P3 evidence gap: the first
authorization record covered the narrow return allowlist and PR #209 but did
not inventory the other public action/runtime bytes authorized globally by
`approvedLockShas`. The finding was accepted and remediated with the complete
`f5c883c96..300501e91` public-surface inventory and PR mapping above. No runtime
defect or unsafe authorization was found. The fresh independent review of the
revised record found no actionable issue.

This investigation triggered the continuous-improvement gate because it
crossed release, enrollment-policy, and consumer adoption boundaries. The
separate post-release authorization rule and narrower return allowlist are
already explicit in `docs/consumer-enrollment.md` and exercised by the registry
parser. The missed step is release-specific history, so no competing `.llm`
guidance is warranted; this progress record is the narrow durable evidence.

## Consumer scope

This authorization does not claim Unity Helpers adoption complete. The safe
next step is to migrate its Windows callers to the central editor, return, and
classifier chain at this approved pin. Two Ubuntu/Docker callers remain on the
historical fail-closed contract until central issue #153 supplies a trusted
container-owned executor; they must not fabricate a digest or use Windows-only
identity deletion.
