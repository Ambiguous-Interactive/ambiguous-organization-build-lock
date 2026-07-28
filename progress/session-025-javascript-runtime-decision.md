# Session 025: JavaScript runtime decision

## Scope and hypothesis

On 2026-07-28, review every open issue and pull request, prioritize impact while
minimizing licensed Unity CI churn, and complete the safely related
investigations in issues #79 and #102.

Hypothesis: `Date.now()` already supplies the UTC time value required by the
lock, while migrating the dependency-free committed JavaScript runtimes to
TypeScript, Bun, or Deno would add a build/runtime contract without a measured
correctness, safety, or performance benefit.

Disconfirming evidence would be a local-time-dependent use of `Date.now()`, a
runtime type defect that the proposed TypeScript mode would prevent, a
repository dependency graph that benefits from a different package manager, or
a GitHub JavaScript-action execution contract that natively selects Bun or
Deno.

Safety invariants:

- Time comparisons and persisted timestamps continue to represent absolute UTC
  instants.
- Action manifests and committed runtimes remain synchronized and directly
  executable by GitHub's declared Node 24 runtime.
- No generated-runtime drift, third-party runtime dependency, organization
  policy change, live lock mutation, consumer repin, or licensed Unity run is
  introduced without evidence that it solves a real defect.

## Issue and pull-request inventory

The clean checkout started at `a7cde6fbc`, equal to `origin/main`. On
2026-07-28, the GitHub connector query `is:issue is:open` returned 15 issues;
the dedicated open-PR query returned no open or draft pull requests.

| Priority | Issues | Disposition |
| --- | --- | --- |
| P0 | #51, #83, #113 | Highest security and production impact, but not eligible for the required single-PR delivery. #51 requires organization-secret/App scope changes prohibited by GOAL.md. #83 is externally gated as detailed below. #113 is a generated derived alert whose clean-audit closure depends on changes and green evidence in six different consumer repositories, not a change in this repository. |
| P1 | #27, #29, #30, #44, #53, #54, #60 | Require live canaries, multi-day evidence, consumer workflow changes, ruleset work, or a zero-cooldown rollout. They cannot be truthfully completed by a repository-only PR. |
| P2 | #49, #99 | Throughput work requires licensed before/after evidence and must not weaken FIFO, activation, or cleanup proof. |
| P2 | #94 | Externally gated: actionlint v1.7.12 remains the latest release, and its current main branch still pins yaml/v4 rc.3. An unreleased pseudo-version does not satisfy the issue's release gate. |
| P2 | #79, #102 | Selected as the highest immediately completable repository-local group after the higher-impact items were mapped to their live, cross-repository, or prohibited gates. Both ask whether the existing JavaScript runtime model should change, need no Unity seat, and can be resolved by reproducible language/runtime evidence. |

No new follow-up issue was opened because every material out-of-scope item has
an existing dedicated issue.

Issue #83's apparent repository-local alternatives are not safely actionable:

- Reducing licensed capacity to one violates the issue's explicit requirement
  to retain two concurrent runners.
- Serializing only return does not help a shared account-wide entitlement: one
  return still happens second, after the first return has removed the shared
  seat. The existing issue #42 task record preserves this falsified hypothesis.
- Reclassifying `unknown/healthy/unity-return-400006` as confirmed would turn
  ambiguous cleanup green without evidence that the runner-local entitlement
  returned. The latest reconciled #83 comment explicitly retains fail-closed
  quarantine until independent entitlement identities, both return orders, and
  portal reconciliation exist:
  <https://github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/issues/83#issuecomment-5096615949>.

Creating those independent Unity identities is outside repository code and no
such evidence currently exists. The #113 alert is likewise not an independent
single-repository objective: its body says a complete clean audit closes it,
and the issue #42 task record explicitly places consumer remediation tracked by
#113 outside the audit implementation. Closing it requires multiple consumer
PRs plus their default-branch evidence; no PR in this repository can satisfy
that condition. With the higher-impact items either prohibited, externally
gated, derived from multi-repository work, or dependent on licensed evidence,
#79/#102 are the highest-ranked group eligible for GOAL.md's singular PR
delivery and its preference for the least Unity CI churn.

## Baseline and experiments

The unmodified `.devcontainer/scripts/verify.sh` passed the LLM harness, all 575
Node tests, every Go package, actionlint, both module verification and tidy
checks, and the workflow credential audit.

Dependency inspection found:

- no `package.json`, lockfile, `tsconfig.json`, or Bun/Deno configuration;
- ten committed action runtime files, fourteen dependency-free Node test files,
  and one Node harness;
- only Node built-ins and repository-local modules in runtime and test imports;
- a current root Go module;
- actionlint v1.7.12 still current, with yaml/v4 rc.6 blocked by its parser API
  incompatibility under #94.

Every public JavaScript action manifest declares `using: node24` and points
directly at a committed `.github/dist/*.js` entrypoint. GitHub's JavaScript
action guidance says packaged action code runs directly on the runner and
should be pure JavaScript without relying on other binaries:
<https://docs.github.com/en/actions/tutorials/create-actions/create-a-javascript-action>.
Replacing that execution boundary with Bun or Deno is therefore not a package
manager swap; it would require a different action architecture and an extra
runner dependency.

The ECMAScript specification defines `Date.now()` as the time value designating
the UTC date and time of the call, relative to the 1970 UTC epoch:
<https://tc39.es/ecma262/2025/multipage/numbers-and-dates.html#sec-date.now>.
The repository uses the returned number for deadlines and converts persisted
values with ISO timestamps. There is no `DateTime.UtcNow` API in JavaScript and
no local-calendar conversion in `Date.now()` to replace.

Node 24 can strip erasable TypeScript syntax, but that mode performs no type
checking and ignores `tsconfig.json`; full TypeScript support still requires a
third-party tool:
<https://nodejs.org/docs/latest-v24.x/api/typescript.html>. Native stripping
would therefore add annotations without proving types, while a compiler would
add a dependency and a source-to-committed-runtime synchronization boundary.

An isolated compiler spike tested the alternative rather than inferring its
cost. A temporary copy of all ten committed runtimes installed
`typescript@next` and `@types/node@latest`, then ran strict `allowJs`/`checkJs`
without emitting code:

```text
TypeScript 7.1.0-dev.20260728.1
typecheck_exit=1
diagnostic_lines=538
typed diagnostics=533
installed top-level package directories=4
installed node_modules size=33M
```

The diagnostic set contained 304 implicit parameters, 109 unchecked property
accesses, 43 unknown caught values, 23 implicit destructured values, and
smaller nullability and assignment groups. This proves that strict type
checking is not a zero-cost switch and that a meaningful migration would need
hundreds of reviewed annotations plus a compiler/output contract. It does not
prove types have no value; it bounds the migration against the current
evidence: 575 behavioral tests are green and the issue identifies no recurring
runtime type defect for the new boundary to prevent.

## Decision and validation

The hypothesis held:

- Request closure of #79 as not a bug. `Date.now()` already returns the required UTC epoch
  value; replacing it with a nonexistent JavaScript analogue of
  `DateTime.UtcNow` would not change semantics.
- Request closure of #102 with no runtime migration. Keep dependency-free JavaScript and
  Node's built-in test runner. Do not add TypeScript, Bun, or Deno until a
  concrete defect or measured maintenance cost supplies acceptance criteria
  that outweigh generated-runtime and runner-compatibility risk.
- Revisit TypeScript only if a recurring runtime type failure survives existing
  behavioral tests or the source/runtime boundary changes for another
  justified reason. Revisit Bun or Deno only if GitHub JavaScript actions
  natively support the runtime or the project deliberately moves to a
  container/composite architecture with measured benefit.

No red-green implementation test applies because the selected issues are
investigations and the evidence supports no production change. Adding a test
that merely restates standardized `Date.now()` behavior or scaffolding an
unused toolchain would be unnecessary bloat. The progress record is the
required auditable deliverable; complete repository verification remains the
delivery gate.

## Review and continuous improvement

Continuous-improvement trigger: the session performed multiple experiments,
reviewed all live work items, and made a repository runtime/tooling decision.

Evidence examined: GOAL.md; the 2026-07-28 GitHub issue and PR inventory; issue
#83's reconciliation comments; `.llm/tasks/issue-42-unity-enrollment-audit.md`;
action manifests; committed runtimes and imports; module update output; the
ECMAScript specification; pinned Node 24 and GitHub runtime documentation; the
isolated TypeScript 7 strict-check spike; focused policy tests; and the complete
repository verifier. The actionlint check observed release v1.7.12 and upstream
main commit `011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7` on 2026-07-28; both still
select yaml/v4 rc.3.

Promotion decision: `no durable learning`. The stable repository-specific
rules are already authoritative in `.llm/context.md`: public action runtimes
are dependency-free committed Node files, and synchronized manifests/runtimes
are mandatory. The no-migration result is conditional on the current absence
of a recurring type defect and belongs in this dated investigation record,
not a new permanent rule that could suppress a future evidence-backed
migration.

Implementer and remediator: root agent. Independent reviewer:
`session025_review`.

Review round 1 found five actionable gaps:

- the issue count said 14 although the table and connector result contained 15;
- P0 blockers were asserted too tersely to justify selecting P2 work;
- the TypeScript decision lacked a real compiler experiment;
- the record described issue completion before PR delivery existed;
- the required review and continuous-improvement evidence was absent.

Remediation corrected the count and query date, tied each P0 disposition to its
authoritative external or cross-repository gate, ran and recorded the isolated
TypeScript 7 strict-check experiment, treats closure and delivery as pending
until GitHub evidence exists, and adds this retrospective.

Fresh focused validation passed 15 policy/documentation tests, the credential
audit, and `git diff --check`. Fresh post-remediation
`.devcontainer/scripts/verify.sh` passed all 575 Node tests, every Go package,
actionlint, both module verification and tidy checks, the workflow credential
audit, and the LLM harness. Independent review round 2 found one remaining
priority inconsistency around the derived #113 alert; remediation tied its
closure condition to six consumer repositories and the issue #42 task record.
Independent review round 3 then reported no actionable content findings.

PR #127 opened with exact head
`663c373cbcfc7f15e13cd90eb835539c486b8c89`; its tree
`8dad1f4913867e818b715ca4b38b9fa6a1987758` exactly matched the fully
verified local tree. Build lock CI run `30383482968` passed. Cursor Bugbot's
exact-head summary classified the change as documentation-only/low-risk and
reported no finding or review thread. Copilot was requested through both the
reviewer API and an exact-head tagged comment, then returned its terminal
requester-quota-exhaustion response with no code feedback.
