# Session 035: Enrollment remediation gate

Date: 2026-07-30

Status: central prerequisite merged; immutable policy approval in progress

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
captured stdout and stderr, and emits the four typed return-evidence outputs.
The enrollment analyzer accepts that action only at an approved lock SHA, with
exact credential and tool-cache inputs, no step execution environment, one
unambiguous acquire, and the exact acquired-scoped predicate on both return
and classifier. Release and the cleanup gate remain literal `always()`.

This new action cannot safely be pinned until its merge commit is reachable.
After this prerequisite merges, its exact main SHA must be added to
`approvedLockShas` in a separate policy change before Qora can consume it.
