# Session 056: bound required CI runtime (issue #205)

Date: 2026-08-20

## Objective and acceptance criteria

Complete issue #205 without consuming a Unity seat or weakening any lock path:

- every job in `.github/workflows/ci.yml` has a reviewed runtime bound;
- ShellCheck setup has its own named, shorter bound;
- the observed unbounded `apt-get` mirror dependency is removed;
- ShellCheck is installed from the latest upstream release using an immutable
  version and the upstream-published digest;
- workflow policy prevents those bounds, pin, and digest verification from
  silently disappearing;
- focused checks, the complete verifier, PR CI/review, merge, and post-merge
  `main` CI are green.

The licensed-resource invariants are unchanged: no workflow in this change can
reach acquire, no concurrency or matrix policy changes, and no credentials or
live lock state enter the workflow, test, script, or this record.

## Live issue and dependency triage

At baseline the repository had 17 open issues, no open or draft pull request,
and a clean `main` at `22d9f1bf`. The current `main` Build lock CI run was green
only after run `32206855482` spent about 95 minutes pending in `Install
ShellCheck` and was rerun; normal recent runs complete in roughly two minutes.

Implementation order below weighs production/security impact first, then
prefers repository-contained work that creates no Unity CI churn. A lower rank
does not mean lower raw severity when authority or live evidence blocks safe
execution.

| Rank | Issue | Impact and Unity-CI cost | Current disposition |
| ---: | --- | --- | --- |
| 1 | #205 | A demonstrated required check can hang for six hours; repository-only and zero Unity churn. | Selected; implementation and fresh local validation are complete. |
| 2 | #203 | The PR-head fail-closed guard spends requests against a rate limit it cannot outwait; repository-only and zero Unity churn. | Next small reliability fix; separate fail-closed behavior change. |
| 3 | #206 | A second cross-repository checkout already failed on the trusted Unity prefix. | High benefit, but imports a 260 KiB validator and needs consumer trusted-prefix/Unity evidence. |
| 4 | #83 | Concurrent returns repeatedly misclassify entitlement collisions as dirty-runner incidents. | Highest live licensed-path impact; needs a reviewed concurrency design and real two-holder evidence. |
| 5 | #113 | The latest organization enrollment audit reports 168 findings across 94 inventory rows. | Broad multi-consumer remediation with substantial Unity churn. |
| 6 | #51 | Writer/Unity secret scope is broader than the reviewed perimeter. | Security-critical, but requires owner organization policy changes that this objective forbids. |
| 7 | #44 | Consumer merges are not uniformly gated by truthful Unity aggregates. | High policy impact; requires consumer ruleset changes and representative Unity runs. |
| 8 | #188 | Two workflows still use deprecated App-ID input semantics. | Zero Unity churn, but safely completing it requires a distinct owner-provisioned client-ID secret. |
| 9 | #53 | Self-hosted jobs can starve before entering the central FIFO. | Significant throughput/fairness architecture with multi-runner canaries. |
| 10 | #49 | The unity-helpers compatibility graph can consume organization capacity for over an hour. | Requires a data-backed matrix policy and broad paid CI evidence. |
| 11 | #99 | Acquire/return paths still need exhaustive timing and retry evidence. | Consumer-wide measurement and licensed canaries remain. |
| 12 | #60 | Literal zero cooldown remains unapplied despite newer releases. | Requires consumer re-pins and a cross-runner zero-20111 canary. |
| 13 | #153 | Container-owned Windows and native Darwin activations lack a trusted central cleanup contract. | New platform authority plus Windows/macOS licensed canaries. |
| 14 | #94 | The isolated actionlint module cannot yet move from yaml/v4 rc.3 to rc.6. | Zero Unity churn, but upstream actionlint `v1.7.12` is still the latest and incompatible. |
| 15 | #29 | Remaining hard-stop, incident, third-runner, and monitoring canaries gate operational closure. | Live controlled Unity operations, not a checkout-only change. |
| 16 | #27 | The original lock-held incident remains tied to #29's zero-incident closure gate. | Tracker/monitoring evidence rather than an independent code fix. |
| 17 | #30 | Umbrella secure-rollout tracker retains owner audits and child-issue closure. | Close last after its children and owner-only work. |

Fresh dependency evidence:

- GitHub reported no open dependency PRs and all pinned Actions resolve to their
  latest releases.
- `go list -m -u -mod=readonly all` found no root-module update.
- The isolated module reports only transitive updates and yaml/v4 rc.6; issue
  #94 explicitly prohibits direct overrides for unused actionlint transitives,
  and upstream actionlint still has no release after `v1.7.12`.
- ShellCheck `v0.11.0` is the latest upstream release. Its release assets
  publish SHA-256 digests for Linux x86_64 and aarch64, both retained in the
  installer. Unknown architectures fail closed.

## Baseline and hypothesis

Observed source facts:

- neither `validate` nor `windows-evidence-deletion` declared
  `timeout-minutes`, so GitHub's six-hour default applied;
- `Install ShellCheck` ran unbounded `sudo apt-get update && apt-get install`;
- no workflow-policy test required a job or step timeout.

Falsifiable hypothesis: a central policy test requiring a 15-minute direct job
timeout on every `ci.yml` job will fail against `main`; a second test requiring
a five-minute pinned, digest-verified installer will fail on the apt step. The
smallest complete fix is to add those bounds and replace apt with a bounded
download of the official artifact. Evidence that a normal full verifier needs
more than 15 minutes, that the artifact does not verify or execute, or that a
supported runner architecture is omitted would disprove the design.

## Red

The focused policy command selected only the two new contracts. Against the
baseline both failed for their intended reasons:

- `ci.yml job validate must fail within the reviewed 15-minute budget` observed
  `undefined !== '15'`;
- the named ShellCheck installation step observed
  `undefined !== '5'` for its step budget.

## Risk and path matrix

- **Positive:** official x86_64 and aarch64 archives verify, extract, report
  ShellCheck 0.11.0, enter `GITHUB_PATH`, and lint the repository.
- **Negative:** an unreviewed architecture exits nonzero before any binary is
  trusted; a digest mismatch stops before extraction.
- **Error:** curl uses HTTPS-only transport, three retries, a 10-second connect
  timeout, 60-second transfer timeout, 240-second retry budget, and a five-minute
  workflow step bound.
- **Boundary/extreme:** every current and future `ci.yml` job must carry the
  exact reviewed 15-minute direct property; a nested step timeout cannot satisfy
  that assertion.
- **Concurrency/ordering:** inapplicable; the workflow has no lock admission or
  shared mutable state.
- **Cancellation/recovery:** GitHub terminates the step within five minutes and
  either job within 15; a later clean run downloads into its own runner temp
  directory.
- **Determinism/isolation:** the version and both upstream digests are literal;
  extraction stays in `RUNNER_TEMP` and no package-manager state is mutated.
- **Contract synchronization:** workflow run-script inventory, shell script
  usage, actionlint, credential audit, and the complete verifier cover the
  changed surfaces.

## Green implementation

- Both CI jobs now declare `timeout-minutes: 15`.
- `Install ShellCheck` declares `timeout-minutes: 5` and delegates to
  `tools/workflows/ci.sh install-shellcheck`.
- The repository-owned installer selects the reviewed Linux x86_64 or aarch64
  asset, verifies its official SHA-256 digest before extraction, and fails
  closed otherwise.
- Policy tests parse direct job properties, so a timeout nested only under a
  step cannot produce a false pass. They also pin the setup step, download
  bounds, version, both digests, verification, and removal of apt.

The first live installer experiment found this workspace is aarch64, falsifying
the initial x86_64-only assumption. The remediation added the official aarch64
asset and digest. A fresh live run then installed ShellCheck 0.11.0 and linted
all repository shell files successfully.

## Full validation

Fresh results after review remediation:

- `node --test test/workflow-scripts.test.js test/workflow-policy.test.js`:
  77 passed, 0 failed.
- `bash tools/workflows/ci.sh javascript`: passed.
- `go -C tools/actionlint run -mod=readonly
  github.com/rhysd/actionlint/cmd/actionlint -color
  ../../.github/workflows/ci.yml`: passed.
- `bash tools/workflows/ci.sh shellcheck`: passed.
- `go run ./cmd/workflow-credential-audit .`: passed.
- `git diff --check`: passed.
- A real aarch64 install against the upstream release and digest reported
  ShellCheck 0.11.0 and successfully linted all repository shell files.
- `bash .devcontainer/scripts/verify.sh`: exit 0; 782 Node tests, 780 passed,
  2 expected hosted-Windows skips, 0 failures; all Go tests, vet, race detector,
  module verification/tidy checks, actionlint, golangci-lint, JavaScript and
  shell analyzers, LLM harness, and credential audit passed.

One earlier focused actionlint command supplied `.github/workflows/ci.yml`
relative to the repository while also using `go -C tools/actionlint`; it failed
to find that path. The corrected `../../.github/workflows/ci.yml` invocation
above passed, as did the full actionlint invocation in the complete verifier.
This was an operator command-path error, not a lint finding.

## Adversarial review

Roles:

- **Implementer:** main agent.
- **Round 1 reviewer:** independent adversarial-review sub-agent; read-only.
- **Remediator:** a second sub-agent distinct from the reviewer.

Round 1 found one medium-severity test gap: production correctly verified the
digest before extraction, but independent literal regexes would still pass if a
future edit used a mutable URL, ignored checksum failure, or extracted before
verification. The remediator added behavioral tests with isolated command
shims that bind architecture to exact URL/digest/curl arguments and assert the
event order. Checksum failure now proves that extraction and `GITHUB_PATH`
mutation do not occur; an unknown architecture proves curl never runs.

The remediator also ran each of the reviewer's three concrete mutations against
a temporary copy and confirmed the tests fail for mutable release URL,
`sha256sum ... || true`, and tar-before-checksum ordering. Fresh focused and
complete verification passed after remediation.

Round 2 found one adjacent medium gap: the behavioral test recorded tar
arguments but did not assert that extraction consumed the same archive path
bound to curl and checksum input. The remediator added the exact tar argument
assertion (`-xJf`, checked archive, `-C`, runner temp). A temporary mutation that
extracted `unverified.tar.xz` now fails, and a fresh complete verifier still
passes with 782 tests (780 passed, 2 expected Windows-only skips).

Round 3 independently rejected all four unsafe mutations (mutable URL, ignored
checksum failure, tar-before-checksum, and extracting a different archive) and
reported **zero actionable findings** in the latest worktree. It also confirmed
the test harness is proportionate: one isolated shim fixture covers both
supported architectures and both critical failure paths without network or
sleep.

## Knowledge retention

Trigger: workflow policy, CI dependency installation, and independently
maintained workflow/script/test surfaces changed; an architecture assumption
was falsified and a reviewer found a reusable test weakness.

- **Observed fact:** this workspace is aarch64; upstream ShellCheck v0.11.0
  publishes separate x86_64/aarch64 assets and digests; the real aarch64 asset
  verifies and executes.
- **Observed fact:** literal-presence assertions did not prove URL immutability,
  checksum failure propagation, or verify-before-extract ordering; behavioral
  command-shim tests reject all three unsafe mutations.
- **Inference:** a hosted runner label could change architecture in the future,
  so reviewing both available Linux assets prevents avoidable CI failure while
  unknown architectures should remain fail closed.
- **Open question:** none relevant to this bounded change.

Decision: **no separate durable `.llm` learning**. The repository already uses
multi-architecture digest-pinned download contracts in its devcontainer tests.
The narrow authoritative knowledge is now executable beside this installer in
`test/workflow-scripts.test.js`, while workflow bounds and delegation are
enforced in `test/workflow-policy.test.js`. Duplicating the rule in agent
guidance would be less authoritative and add drift.

Independent review of this disposition is included in the pending final review
round.
