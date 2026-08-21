# Session 058: centralize the trusted Unity editor validator (issue #206)

Date: 2026-08-21

## Objective and safety invariants

Complete issue #206 with no licensed Unity execution:

- consumers validate the runner-owned editor through one immutable central
  action pin instead of a second repository checkout;
- the public action preserves all eight upstream parameters and emits an
  `editor-path` only after successful, consistent diagnostics;
- enrolled licensed workflows remain fail closed, bounded, and safe during the
  interval between the central merge and consumer repins;
- no workflow input is interpreted by a command shell and no failure writes a
  trusted output.

## Live issue, PR, and dependency triage

GitHub reported 15 open issues and no open or draft PR. Session 057's priority
analysis remains current after closing #203; #206 is now the highest-impact
repository-only change with zero Unity churn. The remaining leading work is
#83 (entitlement collision/quarantine), #113 (organization enrollment drift),
#51 (credential perimeter), #44 (truthful consumer merge gates), #188 (App
client-ID migration), #53 (runner starvation), #49 (compatibility throughput),
#99 (timing/retry evidence), #60 (zero cooldown rollout), #153 (container and
Darwin cleanup), #94 (actionlint/yaml incompatibility), and tracker/canary
issues #29, #27, and #30.

The root Go module was already current. The isolated actionlint module retained
the compatible `github.com/mattn/go-runewidth` v0.0.27 to v0.0.28 update. An
attempted `go.yaml.in/yaml/v4` rc.3 to rc.6 update failed compilation because
actionlint 1.7.12 still uses the older parser-error API, confirming tracked
issue #94; the incompatible update was reverted. Newer `goldmark` and `x/net`
versions appear only as unused upstream actionlint module-graph requirements;
explicit overrides are removed by `go mod tidy`, so they were not forced into
the local module.

## Baseline, hypothesis, and red evidence

At clean `main` commit `57634ff29`, the enrollment analyzer required a
three-step bootstrap, `actions/checkout`, and direct `ensure-editor.ps1`
invocation pinned to `unity-helpers` commit
`76712db791093a9c6b2eccdd9c7bd1b4f1cdb24d`. The upstream script is
self-contained: 4,955 lines, no dot-source dependency, and no `$PSScriptRoot`
reference. Its LF-normalized vendored SHA-256 is
`c9a5cea6ad890bc7b2ad189a05a0d1a0514f1b850e45002318b360851289e837`.

Falsifiable hypothesis: a dependency-free Node 24 action can validate typed
inputs, invoke that exact payload through a typed PowerShell splat without a
shell, and accept its output only when diagnostics match the requested
version/profile/root/managed mode and reviewed editor layout. Any accepted
mutable pin, unsafe input, process failure, contradictory evidence, path escape,
output injection, unbounded/reordered gate, or rollout audit regression would
disprove it.

The focused red command `node --test test/unity-editor-action.test.js` failed
with `MODULE_NOT_FOUND` for `.github/dist/ensure-unity-editor.js`, demonstrating
that the action contract had no runtime.

## Implementation and compatibility

- Added `.github/actions/ensure-unity-editor/action.yml`, the approved vendored
  payload, a 51-line typed PowerShell adapter, and a dependency-free Node 24
  runtime.
- Inputs reject malformed exact versions, profiles, booleans, whitespace,
  newline/NUL injection, blank payload entries, and case-insensitive duplicate
  payload paths. Omitted optional inputs retain upstream defaults.
- `pwsh` is spawned with an argument vector, `shell: false`, and base64 JSON
  configuration. The adapter removes configuration from its environment and
  splats typed parameters without dynamic evaluation.
- A zero process exit is insufficient: diagnostics must be readable JSON and
  exactly bind version, effective profile, install root, managed-only mode,
  successful classification, and a reviewed canonical or CI-managed editor
  path before the one-line output is appended.
- The enrollment analyzer accepts only the approved central SHA, six exact safe
  inputs, literal/static-matrix version and profile bindings, a bounded
  failure-propagating first step or exact current-head successor, and no
  workflow/job/action environment. Optional provisioning inputs are prohibited
  for enrolled jobs.
- The analyzer retains the exact old bootstrap/checkout/script sequence only as
  transition compatibility. Active documentation prescribes the shorter action
  prefix and rejects copying the old shape into new or edited workflows.
- README, enrollment guidance, operations guidance, third-party provenance,
  action manifest tests, documentation policy, and the Windows CI test job were
  synchronized. The Dependabot catch-all action group is now explicitly tested.

## Focused validation

- `env -u FORCE_COLOR node --test test/unity-editor-action.test.js
  test/action-manifests.test.js test/documentation-policy.test.js`: 95 tests,
  94 passed, 1 expected hosted-Windows skip, 0 failed.
- `go test ./internal/enrollment`: passed with the complete prior legacy
  mutation suite plus new shorter-prefix mutations.
- `git diff --check`: passed.

## Adversarial review and remediation

The main agent implemented and reviewed because sub-agent delegation was not
requested. The initial intent-to-diff review found two actionable defects:

1. Replacing legacy recognition immediately would make the organization audit
   reject every enrolled consumer before it could update its central pin.
2. The first README revision showed Unity execution before lock acquisition.

Both findings were accepted. Exact predecessor compatibility and its full
negative mutation suite were restored, with an explicit removal-after-rollout
contract. The README now only shows pre-acquire validation and explains that a
later acquired step consumes the output. A fresh review of runtime, analyzer,
tests, provenance, docs, and dependency changes found no unresolved unsafe
success path or stale contract. The first full verifier separately rejected the
attempted YAML tooling upgrade with actionlint compile errors; reverting only
that incompatible dependency preserved the production fix and the compatible
`go-runewidth` update. The next full pass reached all 819 Node tests and exposed
one stale exact run-step inventory expectation for the expanded Windows action
test command; the expectation was synchronized with the reviewed CI command.
PR #209's first hosted-Windows run then passed the typed adapter contract but
failed the provenance hash because Git converted the checked-out LF blob to the
upstream CRLF bytes. The test now hashes LF-normalized source content, preserving
the approved blob-content assertion across platform checkout policies.

## Knowledge retention

The reusable lesson is to preserve an exact safe predecessor during immutable
security-contract migrations until downstream consumers can repin. Existing
architecture-and-plan-review guidance already requires compatibility,
migration, rollback, and downstream-consumer analysis. This issue's exact
transition shape is therefore retained in source comments, active docs, the
task record, and this audit record; no duplicative generic skill change was
made.

## Full validation

`bash .devcontainer/scripts/verify.sh` exited 0:

- LLM harness checks passed;
- 819 Node tests ran: 816 passed, 3 expected platform skips, 0 failed;
- all Go tests and race tests passed;
- module verification and tidy-diff checks passed for both Go modules;
- Go vet, golangci-lint, actionlint, JavaScript checks, ShellCheck, workflow
  policy, and the credential-literal audit passed.

No licensed Unity job or external lock state mutation was part of local
validation.

## Publication and post-merge evidence

Commit `3ce7a9f00` opened PR #209 and the PR was marked ready. The first exact-head
CI run passed every substantive Linux validation step and the hosted-Windows
typed PowerShell adapter, then found the platform EOL provenance-test defect
described above. Copilot reported that its review quota was exhausted and
provided no finding; Cursor Bugbot supplied a summary with no actionable
thread. The remediation push, green rerun, merge, and post-merge `main`
verification remain pending.
