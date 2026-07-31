# Session 039: Prohibit Unity editor provisioning in CI

Date: 2026-07-31

Status: implementation validated locally; central enforcement remains gated on
clean audited consumer default branches

## Trigger and priority

Issue #166 is the least-churn follow-up to the issue #160 consumer rollout.
Manual runner investigation proved that Unity Hub ownership and module repair
are host-maintenance concerns: a workflow cannot safely repair an editor whose
installation registry, canonical directory, and running processes disagree.
The previous audit enforced lock and cleanup lifecycle shape but did not
enforce a manual-only editor boundary or require the editor check to precede
credential references.

The policy is therefore fail-closed and narrow:

- CI may only check an existing canonical editor with
  `-CiManagedOnly -RequireHealthyExisting`;
- the check is bounded, failure-propagating, and precedes credential references
  and lock acquisition;
- the immutable validator checkout is unconditional, failure-propagating,
  clean, and immediately adjacent to the direct gate; a first-step no-profile
  bootstrap rejects a reparse-point parent, removes the exact prior checkout,
  and proves absence, while global/system Git configuration is disabled and
  hooks are pinned to `/dev/null`, so skipped, stale, overwritten, or
  config-mutated helper content cannot establish provenance;
- the provisioning and installation timeout environment controls are
  prohibited; and
- install, download, repair, relocation, and quarantine remain manual offline
  runner operations.

No organization policy, credential, secret, App, runner, or ruleset setting was
changed.

## Red-green evidence

The mutation suite was added before the analyzer implementation. Each mutation
was initially accepted or lacked the required stable finding:

| Mutation | Required finding |
| --- | --- |
| Remove `-RequireHealthyExisting` | `unsafe-unity-editor-provisioning` |
| Remove `-CiManagedOnly` | `unsafe-unity-editor-provisioning` |
| Restore either provisioning-budget control | `unity-editor-provisioning-control` |
| Remove or exceed the bounded gate timeout | `unbounded-unity-editor-check` |
| Ignore gate failure | `unsafe-unity-editor-check` |
| Move the checkout/gate after acquire | `missing-unity-editor-check` |
| Move the checkout/gate after credential references | `missing-unity-editor-check` |
| Hide an unsafe call behind a two-hop checked-in script | `unsafe-unity-editor-provisioning` |
| Skip or ignore failure from the trusted helper checkout | `missing-unity-editor-check` |
| Disable checkout cleaning or redirect its server | `missing-unity-editor-check` |
| Overwrite the helper tree between checkout and gate | `missing-unity-editor-check` |
| Inject checkout Git configuration or hook paths | `missing-unity-editor-check` |
| Run a setup step before the trusted checkout | `missing-unity-editor-check` |
| Inject the checkout Node runtime from job environment | `missing-unity-editor-check` |
| Omit or weaken forced checkout-directory recreation | `missing-unity-editor-check` |

The green implementation includes all checked-in PowerShell files in the
immutable exact-commit snapshot, follows workflow-reachable script calls with
cycle protection, ignores full-line comment decoys, and audits direct and
delegated editor calls. A direct workflow invocation is required to satisfy the
gate: an adversarial mutation proved that a wrapper could otherwise contain a
safe invocation behind a branch that its workflow arguments never execute.
Snapshot tests prove that both workflow and PowerShell bytes remain bound to
the requested Git object even in the presence of a local replace ref. The
trusted gate additionally requires the exact immutable checkout to be the
immediately preceding top-level step with exactly the five approved inputs:
repository, ref, path, `persist-credentials: false`, and `clean: true`.
Focused Go tests for the enrollment analyzer and command pass.

The durable lesson is enforced at the narrowest executable boundary by the
analyzer and mutation tests. Duplicating it as general agent guidance would not
strengthen the runtime policy.

## Default-branch audit and rollout gate

A fresh six-repository exact-head audit first found five ordering violations in
DxMessaging and the expected old-policy violations in DoxReloaded and
unity-helpers. A diagnostics filename containing `unity-editor-check.json`
also exposed an analyzer false positive: a safe editor check was being treated
as Unity activation. The activation classifier now excludes a safe
healthy-existing invocation unless actual Unity execution flags are present.

The earlier re-audit against DoxReloaded PR #305 head
`9ca115cc33eda4e02885274f9b869ee9c372ee52`, DxMessaging PR #322 head
`decb71763386d6448c550ac087afb934242b2307`, and the current IshoBoy,
qora-redux, unity-builder, and unity-helpers heads is complete over 94 active
jobs. DoxReloaded, DxMessaging, IshoBoy, and unity-builder produce zero
findings. The remaining 88 findings are exact and source-free: two on
qora-redux because its safe call is hidden behind operation-dispatch control
flow, and 86 on the old unity-helpers default branch.

A later adversarial provenance review proved that this result still trusted a
matching checkout that could be skipped, failure-tolerant, stale, or
overwritten before the gate. After closing that bypass, a fresh immutable
six-repository audit remained complete over 94 active jobs and produced 95
findings: one missing clean provenance gate on DoxReloaded, five on DxMessaging
where diagnostics also intervene between checkout and gate, one on IshoBoy,
the same two qora-redux findings, and the same 86 old-default unity-helpers
findings. This is the expected new red rollout baseline, not a green claim.

After missing delegated targets became fail-closed, the same immutable heads
produce the latest expected baseline: the audit is complete over 94 active
jobs with 102 findings. DoxReloaded has two, DxMessaging ten, IshoBoy two,
qora-redux two, unity-helpers 86, and unity-builder zero. The seven additional
findings are the unsafe non-candidate calls whose immutable-helper path is
absent from the consumer snapshot; adopting the exact validated gate removes
both each repository's missing-gate and unsafe-call findings.

The DxMessaging red-green sequence first removed conditional gates, which
reduced ordering findings but correctly left five provisioning findings. The
second mutation replaced local provisioning-capable calls with the immutable
maintenance helper, but the recursive audit still caught the reachable
`run-ci-tests.ps1` automatic fallback. Removing that fallback and requiring the
prevalidated editor reduced DxMessaging to zero findings. PR #322 keeps all
five editor gates before credential validation without moving credentials
across acquisition. Its targeted 17-case workflow contract, Prettier, line
budget, Unity PR policy, and 406-test JavaScript suite pass; nine PowerShell
cases are expected local skips. Packaging, spelling, Markdown, and generated
document checks also pass. The local environment has no `dotnet`, so hosted CI
must execute the analyzer-payload build. Cursor and Copilot were retriggered on
the exact pushed head. Cursor's only finding claimed the pinned maintenance
script did not exist; the exact Git tree proves the path at blob
`53fd05cab13b19e86c7d222b03489f8c6967840a`, so the false-positive thread was
answered with that evidence and resolved.

The unity-helpers PR #324 worktree has a separately validated
maintainer-ready patch with two full pre-push passes and a zero-finding second
adversarial review. Repository instructions prohibit this session from
staging, committing, or pushing that patch. DoxReloaded PR #305 is
now blocked by its static package-version contract: the reviewed workflow has
two intentionally scoped `6000.5.2f1` literals, while the old check requires
exactly one. DxMessaging PR #326 completed all nine real Unity matrix jobs and
the Unity aggregate successfully; its remaining failures are five yamllint
line-length findings and a JavaScript line budget exceeded by five lines.

Qora PR #191 merged as `d9ba9c1c7c6cbfc73acbc538fcc89725c530f939`
after Ubuntu, Windows, engine-free, Cursor, real EditMode/PlayMode, fallback
cleanup, and aggregate checks passed. IshoBoy PR #322 merged as
`ffb8329cb10bd14974614ed88f8b0500d0a328ed` after 720 Python tests, 23 Node
tests, adversarial review, and its full licensed runner lifecycle passed. A
neutral Cursor check contained one valid inline finding: unchanged fallback
and aggregate assertions had been indented into the cleanup mutation test.
Follow-up PR #323 restored them to the clean typed-shape contract, passed
Cursor with no inline findings plus a second real Unity lifecycle, and merged
as `04aa6531ed8e69b2d486e625f8a3fb49cdaebcf8`.

The exact default-branch audit now reads those Qora and IshoBoy merge commits
and reports zero findings for both. The complete six-repository result remains
red only because the unmerged DxMessaging, DoxReloaded, and unity-helpers
consumer snapshots still contribute the expected rollout findings.

Merged-main Windows execution also exposed a non-bypassing checkout defect.
The trusted helper checkout passed, but `actions/checkout` attempted its
default global `safe.directory` write while `GIT_CONFIG_GLOBAL=/dev/null`
intentionally disabled runner-global configuration, producing a caught
`could not lock config file /dev/null` annotation. Independent source review
classified this P2, not a provenance bypass: Git ownership protection remains
enabled and the exact helper checkout and gate passed. The safe transition is
to retain all five Git-isolation environment entries while centrally allowing,
then requiring, literal `set-safe-directory: false`; consumers must move under
the transitional policy before it is tightened.

Central enforcement must not merge while it would make an enrolled default
branch red. Publication and merge therefore wait for DoxReloaded, DxMessaging,
and unity-helpers to merge green, the Windows-safe checkout transition to land,
and a fresh exact-default audit to return zero findings.

## Independent review disposition

The first independent adversarial round found that delegated safe calls could
incorrectly satisfy the mandatory gate, variable-composed script calls could
escape reachability, pipeline segments could lend switches to an unsafe
invocation, and snapshot loading lacked aggregate bounds. Each central finding
was accepted and remediated with a mutation test. The reviewer also found that
the standalone runner-repair draft used synthetic module markers rather than a
real build-capability proof and had a service-shutdown race. The separate
operator artifact now treats layout inspection as advisory, requires Unity CLI
`projects require` for an exact-version project plus native startup, identifies
the exact Windows service, and restarts only after proof. Its state-transition
suite passes under PowerShell 7 on Linux and the independent manual-script
review reports zero findings; Windows service execution remains a required
operator preflight. These runner files remain deliberately separate from the
central policy change.

Later adversarial rounds found additional bypasses: workflow-local
dynamic editor invocation was not audited, a safe literal call inside an
always-false PowerShell branch could satisfy the gate, and a delegated script
extension could be assembled from string fragments. Expression targets,
indirect variables, early successful termination, short-circuit calls,
literal `Join-Path` delegation, and `Invoke-Expression` then exposed broader
forms of the same classes. Red-green mutations now cover each form.
Workflow-local and delegated dynamic script execution fails closed, literal
script-relative `Join-Path` calls are recursively audited, dynamic evaluation
is prohibited, and only a simple literal invocation at PowerShell brace depth
zero with no prior `exit`, `return`, `break`, or `continue` can satisfy the
mandatory gate.

The final provenance round found one high-severity bypass: any matching
checkout earlier in a job could lend trust to helper content overwritten later,
or could be skipped or allowed to fail over stale content. Red mutations now
cover false conditions, ignored checkout failure, `clean: false`, a redirected
GitHub server, and an intervening checkout to the same destination. The gate
accepts only an affirmative, failure-propagating, exact-input checkout
immediately before the invocation.

The next review demonstrated a post-checkout hook injected through
`GIT_CONFIG_*`, then showed that a prior step or persistent runner global
configuration could create the same effect. The checkout's exact environment
disables system/global config and sets `core.hooksPath=/dev/null`.
Workflow/job environments are absent rather than denylisted. This prevents
Git, home, path, Node, PowerShell, or .NET runtime injection from occurring
before the trusted bootstrap; values needed later must be step-local.
Hook-injection, prior-step poisoning, Git-home, `NODE_OPTIONS`,
`DOTNET_STARTUP_HOOKS`, and otherwise-benign inherited-environment mutations
prove these paths remain closed.

The following review identified the persistent local `.git/config` left by
`clean: true`, including executable `core.fsmonitor` and credential helpers.
The accepted shape now begins with an exact bounded no-profile bootstrap that
rejects a reparse-point `.ci`, removes only `.ci/unity-helpers`, and proves the
target absent before checkout. Omission and no-op mutations keep this
recreation contract red.

The last adversarial review identified inherited .NET startup hooks and
CoreCLR profiler variables as a pre-bootstrap execution path: `pwsh` could
load attacker code before the exact first-step script ran. A finite denylist
cannot prove the absence of current and future runtime injection variables.
The trusted shape therefore rejects every workflow- and job-level `env`
mapping. Red mutations cover both `DOTNET_STARTUP_HOOKS` and an ordinary
`UNITY_VERSION` value, proving the rule is closed rather than prefix-based.

A further adversarial pass found that trusted-looking `run` text did not prove
execution: a custom shell could comment out `{0}`, gate-local .NET injection
could run first, or an earlier command in the same body could replace the
checked-out validator. The accepted gate is now an exact one-line command
under an exact no-profile shell template with no step environment. Red
mutations cover all three bypasses.

Executable review against the immutable helper then caught a contract bug in
the first exact body: `ensure-editor.ps1` requires `-UnityVersion`, so the
approved call would have failed PowerShell parameter binding. The closed body
now permits one validated, single-quoted literal `f` release while keeping
every other byte exact. It explicitly binds the runner-owned
`RUNNER_TOOL_CACHE\u6-v3` root and `EditorOnly` profile. Mutations reject a
missing or unbound expression-based version, beta release, redirected root,
and wider profile. A literal gate release must equal the central return release; the only
dynamic form is the existing bounded static `matrix.unity-version` contract,
shared by gate and return. Valid-but-mismatched literals and the helper-invalid
empty-minor form stay red. Static matrix axes use the same final-release
predicate; beta-only and mixed final/beta mutations cannot pass policy and then
fail helper parameter binding.

Cursor review found an expression-resolution bypass after the first push:
`Join-Path $env:TEMP 'install.ps1'` could be treated as repository-relative,
and a missing snapshot target returned an empty safe audit. Parenthesized
script invocation now accepts only one literal repository path rooted at
`$PSScriptRoot` or `GITHUB_WORKSPACE`; external roots fail closed. Missing
delegated files are unsafe except for the immutable helper whose bytes are
proved by the separate checkout contract at the exact gate. A follow-up review
caught that this exception was initially path-global: modified helper bytes
could be invoked again later. The exemption now exists only by skipping
delegated-file lookup for the fully validated gate candidate; every other
missing reference, including a later call to the same path, is unsafe.
External-root, missing-target, and post-gate overwrite/reinvoke mutations
reproduce the reviewed exploits.

The next pass found that accepting `if: always()` severed the status dependency
between bootstrap, checkout, gate, and acquire. A rejected reparse parent could
therefore be followed by checkout into attacker-controlled state and lock
acquisition even though the job ultimately stayed red. Those four steps now
require absent `if` values and thus GitHub's implicit `success()` chain.
Mutations cover `always()` at every boundary.

Consumer dry-run then found that the exact prefix conflicted with the
established stale-PR contract: licensed jobs put the immutable current-head
guard first. The policy now permits exactly that one approved, bounded,
closed-input, failure-propagating action before bootstrap. No arbitrary setup
step can use the optional slot; bootstrap, checkout, and gate remain adjacent.
Mutations close conditions, excess timeout, step environment, extra inputs,
and a substituted head identity.

DxMessaging dry-run exposed the final profile mismatch: standalone matrix legs
must verify Windows IL2CPP modules before acquisition, while edit/play legs
need only the editor. The exact gate now accepts one closed static `fromJSON`
map from `matrix.test-mode`: `standalone` selects
`StandaloneWindowsIl2Cpp`, and `editmode`/`playmode` select `EditorOnly`.
The bounded axis permits only unique values from those three modes; an unbound
expression mutation stays red.

## Bounded PowerShell invocation review

Cursor's unresolved-call finding initially prompted an experimental
PowerShell data-flow interpreter. Adversarial counterexamples showed that the
experiment could not soundly model aliases, functions, process launchers, and
the rest of a Turing-complete language without becoming a second PowerShell
implementation. That experiment was discarded before publication.

The reviewed policy instead states and enforces a finite lexical boundary:
workflow and job call targets must be static, direct `pwsh` or `powershell`
`-File` targets must be static, and checked-in delegated scripts retain the
existing recursive repository-path audit. Quote-aware tokenization preserves
literal dollars, recognizes the approved workspace and script-root forms, and
audits direct hosts at command, assignment, grouping, block, and return
pipeline boundaries. It distinguishes the PowerShell 7 background operator
from the call operator and treats GitHub expressions as opaque workflow
tokens. Arbitrary alias, function, `Start-Process`, and `cmd` data flow is
outside this targeted rule rather than incompletely claimed as covered.

Independent review reproduced and remediated mixed subexpression and automatic
variable targets, segmented stop-parsing and workspace paths, nested and
assignment-host invocations, typed and attributed assignment targets, return
pipelines, and benign argument/background forms. Every accepted finding has an
exact regression. The latest independent round reported no actionable
findings. On the reviewed state, `go test ./internal/enrollment -count=1`,
`git diff --check`, and the full repository verifier pass; the verifier reports
678 tests, 676 passes, and the two expected Windows-only skips.

DxMessaging binding then exposed a separate activation-classifier false
positive: the data-only names `unity-editor-check.json` and
`dx-unity-editor-validation` were treated as launching Unity. Replacing raw
substring matching with exact, quote-aware executable relationships removed
those five findings. Adversarial mutations cover direct, assigned, returned,
subexpression, module-qualified, aliased, and `Start-Process` launches;
quoted path data, redirect paths, and relative lookalikes remain inert.
`Start-Process` parameter handling follows the documented exact or unique
prefix forms and distinguishes value-taking parameters from switches. The
return-license exemption now requires an exact argument and does not hide
mixed activation arguments. The latest independent activation review reports
no actionable findings.

A fresh immutable six-repository audit remains complete over 94 active jobs
with the stable 90-finding rollout baseline: two each on IshoBoy and
qora-redux, 86 on unity-helpers, and zero on DoxReloaded, DxMessaging, and
unity-builder. This is rollout evidence, not authorization to merge central
enforcement before consumer defaults are clean.

Continuous-improvement disposition: revise this task record and promote the
bounded rule through executable analyzer regressions. The observed failure was
an over-broad analysis model, not a missing general agent instruction; adding
another prose-only source of truth would not strengthen enforcement.
