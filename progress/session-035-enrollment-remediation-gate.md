# Session 035: Enrollment remediation gate

Date: 2026-07-30

Status: central prerequisites merged; consumer rollout in progress

## Selection

GitHub reported 12 open issues and no open or draft pull requests. The latest
push CI and incident-recovery audit on `main` commit `134a74899` were green.
There was no safe dependency update: the root module is current, actionlint
v1.7.12 remains latest, and yaml/v4 rc.6 remains incompatible with that
release.

Priority order:

1. #83 is the highest active production defect, but safe closure requires
   independent entitlement identities, consumer repins, both return orders,
   and portal reconciliation. Unknown `400006` cleanup remains fail-closed.
2. #51 is the highest credential-boundary issue, but its organization policy
   and secret/App mutations are prohibited by this session.
3. #113 is the first actionable safety program. Its enrollment audit reports
   missing lifecycle, preflight, fallback, and aggregate contracts.
4. #44 overlaps #113's truthful aggregate work, but organization ruleset
   changes remain out of scope.
5. #53, #29, #99, and #49 require broader architecture, live canaries, or
   licensed timing evidence.
6. #60 depends on #83; #94 is upstream-blocked; #27 and #30 are operational
   or umbrella trackers.

## Baseline

The clean checkout matched `origin/main`. `.devcontainer/scripts/verify.sh`
passed 604 Node tests, all Go packages, both module integrity and tidy gates,
actionlint, the knowledge harness, and the credential audit.

Trusted request run `30505731359` triggered fresh organization audit run
`30505737344`. The audit retrieved all six exact default-branch commits,
revalidated their heads, uploaded source-free evidence, and synchronized #113.
It reported 113 inventory rows and 278 findings across 14 workflow files.

qora-redux is the smallest consumer slice: 11 findings in
`.github/workflows/unity-tests.yml`. Its existing local aggregate policy is
tested but opaque to the source-free central analyzer.

## Central prerequisite

The new dependency-free `classify-unity-changes` action provides one central
authority for the skip decision. It defaults to requiring Unity, validates
exact pull-request SHAs, and skips only when a bounded Git name-only diff
contains exclusively central Unity-independent paths.

The new dependency-free `require-unity-validation` action provides one typed
authority for conditional aggregate results. It accepts only:

- an exact untrusted revision skip;
- an exact audited non-Unity skip;
- complete licensed validation with successful hosted fallback and typed
  `noop`.

Missing, malformed, failed, cancelled, contradictory, or residue-bearing
execution fails. Diagnostics contain allowlisted typed values only.

The enrollment analyzer recognizes the action only at an approved immutable
lock revision with exact result/output bindings and actual aggregate
dependencies. The fallback input must come from a canonical hosted release-only
job, and that job must forward the exact release step's typed cleanup output.
It recognizes the same exact Dependabot and same-repository guard for hosted
reader preflight. It does not trust arbitrary consumer JavaScript.
The analyzer also requires a distinct exact-shape central classifier, exact
preflight, isolated jobs without inherited workflow/job execution environment,
containers, services, defaults, or matrices, and tightly bounded central
lock-action credential environments.

## Red-green evidence

The runtime test first failed because the action did not exist. The analyzer
fixture first reported missing preflight, licensed aggregate, and fallback
aggregate evidence.

After implementation:

```text
node --test test/unity-validation-gate.test.js test/action-manifests.test.js
60 tests passed
go test ./internal/enrollment -run UnityEnrollment -count=1
passed
go test ./cmd/audit-unity-enrollment -count=1
passed
```

A deliberate mutation changed the accepted fallback result from `noop` to
`released`. The licensed-success unit and committed runtime tests failed. The
mutation was reverted before the green run.

Independent adversarial review found one P1 bypass in the first analyzer
draft: the aggregate input was bound to the fallback job, but the job could
publish a literal `noop` instead of forwarding the canonical release output.
The analyzer now proves the exact step-output forwarding and its source holder
binding in both aggregate checks. A regression mutation that spoofs the job
output fails both checks.

The next review found that the first gate trusted an arbitrary classifier. A
suppressed or constant-false consumer classifier could skip Unity and still
form the accepted non-Unity matrix. The central classifier plus exact
job/action/output provenance closes that path.

The following review found an inherited process-control bypass:
workflow-level `NODE_OPTIONS` could preload checked-out pull-request code
before the immutable Node classifier. The typed path now rejects workflow and
job execution environments, defaults, containers, services, and matrices.
Mutation coverage includes suppressed failures, literal classifier output,
consumer shell, role aliasing, inherited preload, containers, matrices, extra
preflight execution, spoofed fallback output, and consumer steps before or
after the aggregate gate. Direct and nested local-composite caller environment
mutations prove that execution controls cannot bypass the leaf-action checks.

Current focused evidence is:

```text
node --test test/unity-change-classifier.test.js test/unity-validation-gate.test.js test/action-manifests.test.js
67 tests passed
go test ./internal/enrollment -run 'UnityEnrollment|ValidationGate' -count=1
passed
```

The complete verifier on the composite-hardened tree passed 635 Node tests,
every Go package, module integrity and tidy checks, actionlint, the generated
knowledge harness, and the credential audit.

The final independent adversarial pass returned PASS with no remaining
reachable green bypass across classifier authority, inherited execution
controls, recursive composite ancestry, role/dependency/output binding,
immutable pins, fallback evidence, or aggregate state handling.

## Review and rollout boundary

Independent planning found that consumer-only edits would either game static
recognition or weaken acquired-scoped return, trust guards, exact fallback
identity, and aggregate truth. The central typed action is therefore a required
prerequisite.

The new action cannot safely be pinned until its merge commit is reachable.
After this prerequisite merges, add that exact main SHA to the reviewed policy,
then update qora-redux and require zero scoped findings. No Unity execution is
added by this central change.

PR #147 merged the central prerequisite as
`1ec035504397eeff3f5c27059081d56ff7987802`. Build lock CI run
`30513504991` and organization enrollment audit run `30513504990` both passed
on that exact `main` commit. Cursor Bugbot found no issues on the PR head;
Copilot responded that the requesting account had reached its review quota.

PR #148 added the reachable typed-gate SHA to `approvedLockShas` and merged as
`cfc45d4b28ce7405eaa3e821f280472f6b638277`. Build lock CI run
`30513726346` and organization enrollment audit run `30513726347` both passed
on that exact `main` commit. Cursor Bugbot found no issues on the PR head;
Copilot again reported that the requesting account had reached its review
quota.

The first proposed Qora remediation would have authorized its checked-in
PowerShell return wrapper by repository, path, and audited blob digest.
Adversarial review found a P1 runtime-substitution bypass: an earlier build or
checkout step can replace that workspace path after the commit audit, causing
the exact cleanup invocation to execute different bytes with Unity
credentials. The digest-registry prototype was removed before commit.

The replacement prerequisite is a pinned central `return-unity-license`
Node 24 action. It accepts no consumer script or caller-selected executable,
constructs the CI-managed editor path from a literal Unity version and the
immutable `runner.tool_cache` context, invokes Unity without a shell, bounds
captured stdout and stderr, and emits five typed return-evidence outputs.
The enrollment analyzer accepts that action only at a SHA in the dedicated
`approvedReturnShas` subset, with exact credential and tool-cache inputs, no
workflow/job execution environment, defaults, container, or services, one
unambiguous acquire, an explicit self-hosted Windows runner, and the exact
acquired-scoped predicate on both return and classifier. Return, classifier,
release, and gate form the terminal consecutive job suffix. Release and the
cleanup gate remain literal `always()`.

Adversarial implementation review then found four P1 bypasses in the first
central draft: a later step could replace path-only return evidence; licensed
work could run again after accepted cleanup; workflow/job `NODE_OPTIONS` could
preload the Node actions when a legacy aggregate was present; and a mutable or
reparse-directed tool-cache executable could impersonate Unity. The permanent
contract now binds a return-log SHA-256 into the classifier, structurally
forbids any interleaved or later executable step, rejects inherited workflow/job
execution wrappers for the central path, rejects reparse points throughout the
editor path, and requires a centrally allowlisted Unity Authenticode leaf
thumbprint plus code-signing EKU immediately before process start.

A temporary no-checkout, no-secret diagnostic did not launch Unity or acquire a
seat. Run `30515221048` confirmed the installed standalone Unity CLI's current
Unity Technologies SF leaf and DigiCert G4 code-signing issuer on the exact
Windows runner. The diagnostic workflow was then deleted. The allowlist retains
the observed current leaf and one immediately prior Unity leaf for reviewed
rotation overlap; consumers cannot provide either value. Captured return
evidence is credential-redacted before persistence, Windows termination falls
back to direct process kill when bounded tree termination fails, and analyzer
mutations reject short step timeouts.

The permanent diagnostic-free tree passed the full verifier with 654 Node
tests, every Go package, module integrity and tidy checks, actionlint, the
generated knowledge harness, and the credential audit. A final independent
adversarial review returned PASS with no actionable correctness or security
finding.

PR #149 merged the trusted return prerequisite as
`27c1e6322b673c2d0ffab8d7ca57531f17aca6b8`. Build lock CI run
`30516240447` and organization enrollment audit run `30516240439` both passed
on that exact `main` commit. Cursor Bugbot passed on the exact PR head; the
required Copilot attempt failed only because the account had exceeded its
monthly quota.

This separate policy change adds that reachable SHA to both
`approvedLockShas` and the return-action-specific `approvedReturnShas` before
any consumer can use the credential-bearing action.

PR #150 approved the trusted return revision and merged as
`d1dc52f66b91c6e5414ebfe9c80272e658a3c9ad`. A live Qora canary then proved
that the action's first editor root did not match the repository's established
CI-managed installation. PR #151 corrected the action to the established
`u6-v3/<version>/Editor/Unity.exe` root and merged as
`08fc83e83fa4cae89c0177005b388585ffdb1d9a`; PR #152 approved that exact
replacement as `f18b986ff8d2777bb37a93a8d1a53dfb8e287b7f`.

Qora PR #184 pinned the approved central contracts and merged as
`c1b38a3a55d1d6576b511d74c1c764dbc3f94d39`. Its exact-head paid Unity
matrix and post-merge default-branch matrix both passed, including 128
EditMode and 107 PlayMode tests. A fresh central audit reported zero Qora
findings.

The unity-builder fork cannot use the Windows host return action to attest
Unity activated inside a Docker container, and its Darwin job cannot use a
Windows-only action. PR #14 therefore retired those unsupported
organization-credentialed fork jobs while retaining the repository's native
cleanup implementation and private fixture contracts. It merged as
`70c59fd0ae716983c67374070fe21cb68b475e97`; its post-merge Windows and
macOS fixture workflows and complete integration workflow passed. A fresh
central audit reported zero unity-builder findings. Issue #153 tracks a future
trusted container/Darwin return contract.

DxMessaging uses statically bounded multi-version Windows host-editor
matrices. The analyzer previously accepted only a literal return-action
version, forcing either duplicated licensed jobs or a dynamic,
caller-controlled exception. The narrow matrix extension accepts
`${{ matrix.unity-version }}` only when that exact job declares a fully static,
non-empty matrix and binds every axis into an acquire/release holder suffix
whose full Cartesian expansion is collision-free.
Dynamic axes, invalid or case-duplicate versions, colliding holder identities,
oversized matrices, and `include`/`exclude` rewrite surfaces remain rejected.
The central return path also proves that release uses the acquire step's exact
lock, suffix, runner, repository, and state branch. This preserves the central
editor resolver while avoiding duplicated nine-leg paid CI topology.
The version selects the centrally resolved and Authenticode-verified executable;
it is not an activation identity. Unity documents `-returnlicense` as returning
the currently active serial-based license on the machine.
Focused Go tests and the complete verifier passed 655 Node tests, all Go
packages, module verification and tidy checks, actionlint, the generated
knowledge harness, and the credential audit.

PR #154 merged the static-matrix analyzer contract as
`6495d228d4b889794104cb3dc76595abab539a3f`. Its exact-head and post-merge
central CI passed; independent adversarial review drove closure of
matrix-holder collisions, case and expression-value substitution, release
identity drift, and unbounded Cartesian expansion. Cursor reviewed the final
head with no findings; Copilot returned only its quota-limit response.

DxMessaging's required `Unity CI Success` context must report on fork and
Dependabot pull requests even though those revisions cannot receive the
organization credentials. A narrow aggregate form recognizes that state
without trusting arbitrary consumer logic. The aggregate must be one isolated
`ubuntu-latest` job with one Bash step, exact preflight/licensed result
bindings, exact fork and Dependabot predicates, and an exact two-state script:
both jobs skipped for an untrusted revision, or both jobs successful
otherwise. Any failure, cancellation, partial execution, altered expression,
additional step, inherited execution environment, or alternate shell remains
unrecognized and red. Against the Dx candidate, the complete source-free
audit reports zero Dx findings.

PR #156 merged that trusted-skip contract as
`9c6f0ae5b733fa4fad06abab496392d9683f568b`; its exact-head and post-merge
Build Lock CI and organization audit passed. Review of the first Dx pull
request head then found that an actor-only Dependabot predicate could also
classify a Dependabot-authored default-branch push as intentionally skipped.
The corrected aggregate binds Dependabot only when the event is a pull request,
so every push must still produce successful preflight and licensed results.
The mutation suite now rejects the actor-only predicate, and the trigger parser
recognizes the corresponding PR-scoped licensed-job guard.

PR #157 merged the PR-scoped correction as
`51a7cc7f5fc724805d38db1039425a0e481392f2`; its exact-head and post-merge
Build Lock CI and organization audit passed. DoxReloaded then supplied the
missing counterexample from Cursor's first review: the same guard was accepted
as a whole job condition but not as one conjunct beside classifier and static
gates. The trigger and fallback parsers now recognize that exact scoped
conjunct as well. The typed conditional lifecycle fixture uses the compound
form, so reverting either parser branch makes the canonical fixture red.

PR #158 merged the compound-condition correction as
`15e0a13bf57f176b844ca0014f5fffa80d3b6100`; its exact-head and post-merge
Build Lock CI and organization audit passed. Exact-head consumer CI then
exposed a second Dependabot identity distinction: `github.actor` changes when
a maintainer reruns a Dependabot-authored pull request. Trusted revision,
fallback, and trusted-skip decisions must instead bind the immutable pull
request author at `github.event.pull_request.user.login`. The analyzer now
accepts only that exact PR-scoped author predicate and rejects actor-based
substitutions across all four contracts.

The final Isho adversarial pass found a credential boundary the consumer could
not safely repair: Unity may echo the paid `SC-...` serial during return, while
the central action previously redacted only its email and password inputs.
Because the analyzer requires return, classification, release, and gate to be
the terminal contiguous suffix, inserting repository shell deletion would
invalidate the evidence chain. The central return executor now redacts the
serial shape before writing bounded evidence. Its regression test supplies no
serial input and proves the echoed serial is absent, matching the real failure
mode; the complete verifier passes with 656 Node tests and all Go packages.
