---
summary: Task record for remediating organization Unity enrollment drift without duplicate licensed churn.
---
<!-- summary: Remediate organization enrollment drift one consumer at a time with typed central policy. -->
# Task: organization Unity enrollment remediation

## Objective

Close drift alert #113 by bringing every enrolled consumer workflow into the
fail-closed lifecycle contract. Remediate one consumer at a time, starting with
the smallest finding set, and reuse central typed policy actions where consumer
scripts cannot be proven safely by static analysis.

## Safety boundary

- Never classify missing or ambiguous cleanup as safe.
- Preserve exact acquire identity, same-runner activation/return, hosted
  fallback cleanup, and literal `cancel-in-progress: false`.
- Do not expose reader, writer, or Unity credentials to untrusted revisions.
- An aggregate may pass a skip only for an exact modeled untrusted or audited
  non-Unity branch.
- Do not require licensed Unity work merely to validate central static policy.

## Baseline

Fresh trusted-main audit run `30505737344` retrieved all six registered
repositories at exact default-branch commits. It reported 113 active inventory
rows and 278 findings across 14 workflow files. The smallest consumer slice is
qora-redux: 11 findings in one workflow.

The complete local verifier passed before implementation with 604 Node tests,
all Go packages, both module checks, actionlint, the generated knowledge
harness, and the credential audit.

## Hypothesis

Central dependency-free classifier and aggregate actions can represent
conditional change and untrusted-revision branches without trusting arbitrary
consumer scripts. The classifier defaults to requiring Unity and skips only a
central conservative independent-path allowlist. The enrollment analyzer can
accept the pair only at an approved immutable revision with exact job-result,
output, revision, isolation, and failure-propagation bindings.

Disconfirming evidence would be any malformed, partial, cancelled,
residue-bearing, or secret-bearing path that the gate or analyzer accepts.

## Red

`node --test test/unity-validation-gate.test.js` failed because the new runtime
did not exist. The analyzer fixture for an exact conditional aggregate reported
missing preflight, licensed aggregate, and fallback aggregate evidence.

## First green slice

The central `classify-unity-changes` action validates exact pull-request
revisions and uses a bounded, no-rename, no-external-driver Git name-only diff.
It requires Unity for non-PR events, empty diffs, malformed revisions, command
failures, and every path outside the central independent allowlist.

The central `require-unity-validation` action accepts only:

- exact untrusted skip with every credential-bearing job skipped;
- exact audited non-Unity skip with successful preflight;
- successful licensed work with successful hosted fallback and typed `noop`.

All other values fail closed. The analyzer recognizes the action only at an
approved lock SHA with exact typed inputs, actual aggregate dependencies, a
hosted failure-propagating job, the exact trust expression, and a canonical
hosted fallback whose job output forwards the exact release step's typed
cleanup output. It also accepts the same exact trust guard on reader preflight.
Classifier, preflight, licensed, fallback, and aggregate jobs must be distinct,
hosted where required, non-matrix, and isolated from workflow/job environment,
defaults, containers, and services. Central lock steps may inherit only exact
writer App credential bindings. The hosted aggregate contains exactly one
step, preventing consumer code from modifying or preloading the immutable
validation runtime.

Mutation evidence changed the accepted fallback result from `noop` to
`released`; the focused suite failed its licensed-success unit and committed
runtime cases, proving the regression is observable.

Independent adversarial review then found that the first analyzer draft proved
the aggregate's fallback input but not the fallback job-output forwarding. A
consumer could therefore have published a literal `noop` after cleanup removed
or quarantined residue. The analyzer now binds that job output to the exact
canonical release step, and a `fallback job spoofs noop output` mutation is
rejected by both licensed and fallback aggregate checks.

A second review found that the aggregate trusted an arbitrary consumer
classifier. A suppressed or constant-false classifier could skip required
Unity work. The central classifier and exact analyzer job/output contract close
that path. A third review found that workflow `NODE_OPTIONS` could preload
checked-out pull-request code before immutable Node actions. The typed path now
rejects inherited workflow/job execution environments, containers, services,
defaults, and matrices. Mutations cover suppressed classifier failures,
literal output, consumer shell, role aliasing, inherited preloads, containers,
matrices, extra preflight execution, and consumer steps before or after the
aggregate gate. Direct and nested composite callers are flattened, and every
enclosing step must also be free of inherited environment overrides.

The final independent adversarial pass found no remaining reachable green
bypass across classifier authority, process inheritance, composite ancestry,
job-role aliasing, immutable pins, dependency/output binding, cleanup evidence,
or aggregate state handling.

## Rollout sequence

1. Merge and publish the central gate and analyzer support. Completed by #147
   at main commit `1ec035504397eeff3f5c27059081d56ff7987802`;
   both post-merge CI and the organization audit passed.
2. Add that exact reachable main commit to `approvedLockShas`.
3. Update qora-redux at that immutable revision and require zero scoped audit
   findings.
4. Repeat the static-first pattern for the remaining 13 workflow files.
5. Run the complete organization audit and require zero findings before #113
   can close.

Do not pin a pull-request commit that may disappear after squash merge.

## Validation

Focused commands:

```text
node --test test/unity-change-classifier.test.js test/unity-validation-gate.test.js test/action-manifests.test.js
67 tests passed
go test ./internal/enrollment -run UnityEnrollment -count=1
passed
go test ./cmd/audit-unity-enrollment -count=1
passed
.devcontainer/scripts/verify.sh
635 Node tests passed; all Go, module, actionlint, harness, and credential checks passed
```

The central prerequisite is merged and post-merge main is green. Policy
approval, downstream delivery, and consumer evidence remain pending.
