# Session 023: progress-record safety

## Scope and hypothesis

On 2026-07-28, review every open repository issue and pull request, prioritize
impact while minimizing licensed Unity CI churn, and complete issue #109 by
deciding from repository evidence whether `progress/` should be retained,
edited, removed, or purged from history.

Hypothesis: the reachable history contains no high-confidence credential or
personal-environment literals in `progress/`, so destructive history rewriting
is not justified. The recurring gap is that required future progress records
have no mechanical credential-literal guard.

Safety invariants:

- Never print, preserve, or transform a discovered credential value.
- Do not rewrite public history without concrete evidence and explicit
  authorization.
- Keep sanitized decisions, commands, issue/PR identities, commit SHAs, and
  source-free operational evidence available for audit.
- Do not change lock state, organization policy, consumer workflows, action
  pins, Unity capacity, or licensed execution.

## Issue and pull-request inventory

The repository had 16 open issues and no open or draft pull requests. The clean
checkout started at `befe1e054`, equal to the recorded `origin/main`.

| Priority | Issues | Disposition |
| --- | --- | --- |
| P0 | #83 | Highest measured production impact. Safe closure still requires independently returnable Unity identities, both return orders, and portal reconciliation. Preserve fail-closed `400006` quarantine. |
| P0 | #51, #113 | Credential scope and 286 live enrollment findings are high impact, but remediation requires prohibited organization-policy work or broad six-consumer Unity churn. |
| P1 | #27, #29, #30, #44, #53, #54, #60 | Require live canaries, multi-day evidence, ruleset/identity changes, releases, or broad consumer workflow work. |
| P2 | #109 | Selected: repository-public evidence hygiene is security-relevant, locally verifiable, and consumes no Unity seat. |
| P2 | #49, #99 | Throughput changes require licensed before/after evidence and cannot safely reinterpret cleanup uncertainty. |
| P2 | #94 | actionlint v1.7.12 remains latest; yaml/v4 rc.6 remains incompatible in the isolated linter module. |
| P3 | #79, #102 | `Date.now()` already represents a UTC epoch; TypeScript/Bun/Deno has no demonstrated safety or runtime benefit. |

No new follow-up issue was opened because every material out-of-scope finding
already has a dedicated issue.

## Investigation and dependency evidence

The issue's reproduction status is `reproduced` for the preventive gap and
`cannot reproduce` for an existing leak.

Observed facts:

- all 19 current progress records use a consistent session heading and contain
  2,777 lines of reviewable Markdown;
- a filename-only scan across every revision reachable from all local refs
  found no strict GitHub/GitLab/AWS/Slack/OpenAI token, private-key header,
  private-network URL, email address, or local user-home path signature;
- a current-tree filename-only scan likewise found no credential-shaped
  assignment;
- the existing credential audit covers workflow YAML, not progress Markdown;
- removing the records conflicts with the repository's required auditable
  session contract, while rewriting history would be destructive and has no
  evidence-backed target.

The root Go module has no available update. The isolated actionlint module has
newer transitive `goldmark` and `x/net` releases, but no newer actionlint
release; yaml/v4 rc.6 still cannot be safely adopted independently, as tracked
by #94.

Conclusion: root cause demonstrated. Required public progress records lacked a
snapshot-time credential-literal policy. No evidence supports deleting the
directory or purging history.

## Red-green implementation

The focused harness test first failed because a generated GitHub-token-shaped
literal in a progress fixture produced no error.

The harness now scans every current `progress/` file for high-confidence
private-key, token, access-key, JWT, and uppercase credential-assignment
signatures. Diagnostics identify only the record path and never echo matched
content. Data-driven fixtures cover GitHub, AWS, private-key, and Unity serial
assignment shapes, plus accepted secret references and redacted placeholders.

The canonical repository context now states that progress records are public,
sanitized audit evidence and must not contain credential literals, raw logs,
personal data, or live lock state. A contract test keeps that rule explicit.

Focused verification passed:

```text
node --test test/llm-harness-catalog.test.js test/llm-harness-contract.test.js
node tools/llm-harness.mjs check
git diff --check
```

## Review, continuous improvement, and delivery

Continuous-improvement trigger: a recurring public evidence surface gained a
new security contract and mechanical enforcement.

Promotion decision: `revise`. The evidence supports one durable rule in the
canonical context; the harness is the narrow enforcement point. No separate
skill, task record, or scanner abstraction was added.

Main-thread fallback was required because the active environment did not
authorize delegation; implementation, review, and remediation were kept as
explicitly separated passes.

Adversarial review round 1 found two actionable gaps:

- lowercase credential assignments could evade the uppercase-name matcher;
- NUL-containing progress files skipped content inspection.

Remediation made assignment names case-insensitive, treats a named credential
literal of at least 12 characters as unsafe without requiring digits, and
scans NUL-containing content. New fixtures cover a lowercase all-letter
password, a token in NUL-containing bytes, and a redacted assignment. Fresh
focused checks passed after remediation.

Adversarial review round 2 inspected the revised matcher, the full affected
files, and every harness caller. It found no actionable issues: the
staged-snapshot hook, CI, and devcontainer invoke the same check; symlinks fail;
regular and NUL-containing files are inspected; and diagnostics omit matched
content.

The complete `.devcontainer/scripts/verify.sh` passed 566 Node tests, every Go
package, actionlint, both module verification and tidy checks, the workflow
credential audit, and the LLM harness.

PR #120 opened at exact head
`9b37eb900fbe4068343a2989f8cfa432789f1ca4`. Build lock CI run
`30319402514` passed. Copilot's tagged request returned only requester-quota
exhaustion, and the reviewer API rejected its bot identity as a
non-collaborator.

Cursor Bugbot found one valid medium issue: token patterns whose final
character class allowed `-` used `\b`, which does not match between a
hyphen-ending token and following punctuation. Remediation replaces those
boundaries with exact negative character-class lookaheads and adds data-driven
GitLab, Slack, OpenAI, and JWT reproductions. The focused tests and complete
verifier passed again after remediation, including all 566 Node tests.

Fresh verification, exact-head rereview, merge, and post-merge evidence are
recorded below as they complete.
