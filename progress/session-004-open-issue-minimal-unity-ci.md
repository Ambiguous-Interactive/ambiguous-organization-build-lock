# Session 004: Open issue minimal-Unity-CI delivery

Status: in progress

## Objective

Inventory and prioritize every open issue by the minimum paid/licensed Unity CI
work required in dependent repositories. Complete the highest-priority feasible
issue through exact-head review, green CI, merge, and post-merge verification.

## Constraints

- Do not change organization policies.
- Prefer the GitHub connector, then Git, then `gh`.
- Request Cursor Bugbot and GitHub Copilot after every push and address every
  non-trivial result.
- Use red-green, data-backed implementation and adversarial review.

## Preflight

- Repository: `Ambiguous-Interactive/ambiguous-organization-build-lock`
- Starting default-branch commit: `8c2bfa5897b7a760b796722becbe7d9805645f18`
- Open issues: #27, #29, #30, #42, #43, #44, #47, #48, #49, #50,
  #51, #52, #53, #54, #60, and #65.
- #65 already uses Node 24 (the current LTS line) and has CI-gated Dependabot,
  but its Go `allow` list only admits the actionlint tool. It excludes the
  direct production `go.yaml.in/yaml/v4` dependency and the rest of the module
  graph, so “update all dependencies” is not yet satisfied.
- #42 remains gated by organization App/secret-scope changes and consumer
  default-branch rollout; those organization-policy changes are out of scope.

## Work log

1. Confirmed GitHub CLI authentication and connector access.
2. Reconciled the current issue inventory with sessions 002 and 003.
3. Started independent complete-ranking, #65-scope, and adversarial-selection
   reviews.
4. All three independent reviews confirmed that #65 needs no consumer changes
   and therefore no dependent Unity CI. Two reviews independently found the Go
   allowlist gap; the third treated the issue narrowly as already complete and
   recommended #50 only if no real #65 gap existed.
5. Red first: the focused policy test failed because the Go updater contained
   an `allow` block and no wildcard group.
6. Green focused test after removing the restriction and grouping all Go
   modules: 1/1 passed.
7. Full validation passed: 374/374 Node tests, Go tests, `go mod tidy -diff`,
   actionlint, credential-literal audit, and `git diff --check`.
8. The first adversarial implementation review found that no `allow` block
   defaults Go version updates to direct dependencies and could exclude the
   repository's indirect modules (including the actionlint tool). A separate
   evaluator implemented the correct `dependency-type: "all"` rule, retained
   wildcard version-update grouping, and corrected the #43 run estimate.
9. Full validation after the correction passed again: 374/374 Node tests, Go
   tests, module tidiness, actionlint, credential audit, and diff hygiene.
10. Two fresh adversarial reviews independently returned `ZERO ISSUES` and
    confirmed the corrected Dependabot semantics, Node LTS/runtime pin, test
    coverage, auto-merge trust boundary, minimality, and PR readiness.

## Prioritized issue inventory

The ordering favors low paid/licensed Unity usage, autonomous completion under
the no-organization-policy-change constraint, then safety/impact. Counts are
acceptance-criteria lower bounds; a “suite” may contain several Unity jobs.

| Priority | Issue | Minimum dependent Unity work | Disposition |
| ---: | --- | ---: | --- |
| 1 | #65 Node LTS and Dependabot | 0 | Central-only and fully completable. Selected because Go updates were restricted to actionlint. |
| 2 | #42 continuous enrollment audit | 0 direct activation | Central code exists in draft #56, but merge gates require App/organization-secret scope changes and consumer-head rollout. |
| 3 | #51 App and organization-secret scope | 0-1 probe | Owner control-plane work conflicts with the no-organization-policy-change constraint. |
| 4 | #53 pre-FIFO runner starvation | Potentially 0 activations; at least three cross-repository probes | Requires two physical runners, three repositories, and architectural/load evidence. |
| 5 | #43 bounded Windows PR canary | At least 2 paid activations, plus an offline probe | Bounded and high-value, but requires live Windows runner and quarantine-safe testing. |
| 6 | #48 bounded macOS canary | At least 1 paid canary | Requires an enrolled macOS runner and portal evidence. |
| 7 | #54 Isho cleanup canary | 1-2 paid jobs | EditMode is mandatory; PlayMode runs unless explicitly unsupported. Portal evidence remains external. |
| 8 | #50 Isho compile checker | About 3 paid jobs | Clear code fix, but exact PR compile/EditMode/PlayMode validation is required. |
| 9 | #47 latent disabled Dx workflows | At least one 9-leg paid suite | Deletion is simple, but a Dx PR triggers the active Unity matrix and the central guard overlaps #42. |
| 10 | #44 truthful required aggregates | Multiple consumer suites | Requires consumer changes and repository ruleset enforcement, which is policy work. |
| 11 | #49 bounded unity-helpers matrix | Reduced smoke plus a 15-leg sweep | Acceptance deliberately proves the complete compatibility graph. |
| 12 | #52 cancellation safety | Multiple consumer suites and live canaries | Draft #56 and consumer rollout remain gated by #51 and broad live evidence. |
| 13 | #60 literal zero cooldown | Five consumer suites plus cross-runner canary | Requires release, five repins, and monitored live handoff proof. |
| 14 | #29 lifecycle canaries/monitoring | Multiple paid canaries over seven days | Operational program with hard-stop, incident, multi-runner, Windows/macOS, and Isho evidence. |
| 15 | #27 lock-held regression | Same evidence as #29 | Closure is coupled to #29's seven-day regression gate. |
| 16 | #30 rollout tracker | Union of remaining children | Umbrella tracker closes after implementation, security, canary, and monitoring work. |
