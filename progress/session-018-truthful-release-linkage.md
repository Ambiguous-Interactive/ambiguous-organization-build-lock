# Session 018: truthful release linkage

Date: 2026-07-27

Status: complete; selected issue closed and default branch green

## Objective and safety boundary

Review every open issue and pull request, prioritize production impact while
minimizing licensed Unity churn, and complete the highest-impact autonomous
scope that does not require prohibited organization-policy changes or weaken
fail-closed cleanup.

Issue #106 is selected for its release-automation defect. The default
`@semantic-release/github` success hook told issue #83 that it was resolved in
v1.10.0 and applied a `released` label even though the release did not change
the concurrent-return failure. The second, separable request in #106 remains
owned by #83: `400006` is not independent cleanup proof, so it cannot safely be
changed from quarantine to success.

This change does not alter lock state, admission, capacity, cleanup
classification, credentials, consumer workflows, or Unity execution. Unknown
cleanup remains quarantined and red.

## Open-issue priority

The connected GitHub App reported 18 open issues. The repository-wide public
pull-request inventory and the connected user's pull-request inventory both
reported no open or draft pull request.

| Priority | Issues | Impact and disposition |
| --- | --- | --- |
| P0 owner-constrained | #51 | Critical credential boundary, but acceptance requires prohibited organization-secret and App policy changes. |
| P0 evidence-constrained | #83 | Measured cross-repository `400006` collisions remain active. Safe cleanup success still requires independent entitlement identities, both return orders, and portal reconciliation. |
| P0 selected | #106 | The v1.10.0 automation asserted that referenced issue #83 was resolved and labeled it `released`; the truthful-notice correction is central-only and causes zero Unity churn. |
| P1 constrained | #42, #44 | Enrollment and required-check enforcement depend on cross-repository identity, rulesets, or the #51 control-plane boundary. |
| P1 architecture | #53 | Pre-FIFO runner starvation requires two-phase admission and cross-repository load proof. |
| P2 operational | #29, #30, #54, #60 | These require paid canaries, a monitoring window, live configuration, or owner evidence. |
| P2 throughput | #49, #99 | Matrix and lock-wait optimization need measured designs and broader rollout evidence. |
| P2 investigate | #27 | The old run-only lock-held report shares the broader lifecycle monitoring gate and lacks current causal evidence. |
| P3 dependency/not-a-defect | #79, #94 | `Date.now()` is timezone-independent; actionlint v1.7.12 remains the newest release and is incompatible with yaml/v4 rc.6. |
| P3 refactor | #100, #101, #102 | Action extraction, test decomposition, and a possible TypeScript/runtime migration have lower production impact and broader churn. |

## Hypothesis and architecture decision

Hypothesis: explicit non-resolving GitHub-plugin options prevent future release
linkage from being represented as issue completion while preserving GitHub
release publication and useful traceability.

Disconfirming evidence would be a remaining resolving phrase or released label,
loss of GitHub release publication, invalid plugin configuration, weakened
workflow permissions/concurrency, or any cleanup-policy change.

The chosen approach configures the existing GitHub plugin with:

- a neutral comment that says the issue or pull request is associated with a
  released pull request or commit and that state plus acceptance evidence remain
  authoritative;
- `releasedLabels: false`, preventing the default `released` label; and
- the existing pinned plugin, release workflow, permissions, and serialized
  publication path unchanged.

Disabling all success comments was rejected because an accurate release-linkage
record is useful. Conditional issue labels were rejected because release
association does not prove acceptance for any label-filtered subset. Reclassifying
`unknown/healthy/unity-return-400006` was rejected because the release action
does not receive independent ULF or portal proof and the current reason can be
derived from supplemental evidence.

## Affected surfaces and failure paths

The only runtime entry point is semantic-release's GitHub success hook after a
release is published. Configuration, the automated-release documentation, and
the focused contract test change together. The workflow, action pin, token
permissions, release/tag publication, and `v1` alias update are unchanged.

Malformed configuration fails before publication through semantic-release and
is also rejected by JSON parsing in the contract test. A referenced issue
receives a neutral linkage notice with no release label. Existing issue state
is not changed by this configuration. Release failure reporting keeps its
current permissions and behavior.

Rollback is one configuration revert. No state migration, consumer repin,
credential update, or licensed canary is required.

## Red-green and dependency evidence

The new focused contract failed against `main` because the GitHub plugin was
still the bare default string. After configuring the neutral notice and label
policy, the focused and adjacent release/workflow/documentation suites passed
66 tests, and `git diff --check` passed.

The root module is current at yaml/v4 rc.6. Actionlint v1.7.12 is still the
newest upstream release and still selects yaml/v4 rc.3; newer advertised
`goldmark` and `x/net` modules are unused transitive modules and are not promoted
to direct dependency bloat. No dependency pull request is open.

Current `main` commit `93fbd3edd6557a710c93c42bb50f876cccaed5fe`
passed Build lock CI run `30283195157`; later scheduled reaper and delivery
audit runs inspected during this session also passed.

## Validation, review, and durable learning

Fresh validation after remediation passed:

- generated knowledge refresh and `node tools/llm-harness.mjs check`;
- 80 focused release, workflow, documentation, and harness tests;
- `git diff --check`; and
- the complete `.devcontainer/scripts/verify.sh` with 553 Node tests, all Go
  packages, both module verification/tidy gates, actionlint, generated
  knowledge, and the credential-literal audit.

The main-thread adversarial fallback was used because this session did not
authorize sub-agent delegation. The review compared the acceptance boundary,
exact v12.0.9 plugin documentation and success-hook source, base-to-working
diff, workflow permissions/concurrency, tests, documentation, and dependency
versions before reading the implementation record.

One actionable wording finding was accepted: the first draft said each target
was "referenced by changes," but the plugin also comments on the pull request
associated with each released commit. The remediation changed the notice and
documentation to the accurate shared relation, "associated with a pull request
or commit included in version." Fresh focused and complete validation then
passed. The latest review found no remaining actionable issue; lifecycle
uncertainty stays fail closed and the historical misleading issue state is
explicitly pending external correction after merge.

Continuous-improvement outcome: `promote`. Observed fact from the exact pinned
plugin source and issue #83 is that release association can reach a target
without proving its acceptance criteria. The existing GitHub workflow-policy
skill now states that release comments must remain non-resolving and release
labels require independently enforced acceptance evidence. The focused
configuration test mechanically enforces the repository's exact policy.

## Delivery

The exact locally verified tree was published through the connected GitHub App
after the environment's SSH push and unauthenticated `gh` transports were
unavailable. Remote commit `3b53c247de1e6a809df2a4211c3e6c0c334384a2`
had tree `03cf98f74ad6c0a99cddf1a59477027ff427c177`, exactly matching
the local verified tree.

PR #107 passed Build lock CI run `30303612805` on that exact head. Cursor
Bugbot's exact-head artifact reported zero findings. Copilot was triggered by
the reviewer and tagged-comment paths and returned its terminal requester-quota
response without code feedback. The thread inventory was empty.

PR #107 was squash-merged with an expected-head fence as
`5ef3352ccdfcb3058c8090e6433813126a67f379`. Its `Closes #106`
directive closed the selected issue as completed. Issue #83 remains open: the
misleading `released` label was removed and correction comment
`5096615949` records that v1.10.0 did not fix the collision, while preserving
the historical bot notice as evidence.

On the exact merged `main` commit, Build lock CI run `30303825866` and Reaper
delivery audit run `30304087463` passed. The workflow-run-triggered Dependabot
follow-up correctly skipped. No Unity workflow, live lock-state mutation,
consumer repin, credential update, or organization-policy change occurred.
