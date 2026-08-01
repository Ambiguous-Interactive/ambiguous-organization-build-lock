# Consumer Enrollment

Enrollment is a reviewed policy and credential-scope change. Organization
ownership alone does not authorize a repository to use the Unity credentials
or writer App. The current inventory is recorded in
[Unity Build Lock Operations](operations-runbook.md).

## Preconditions

1. Audit every workflow, reusable workflow, and repository-local composite
   action in the candidate repository. Classify paid activation, synthetic
   fixtures, intentionally disabled/manual paths, and static references.
2. Require an eligible trusted trigger: same-repository PR, protected default
   branch, or controlled dispatch. Fork and Dependabot PRs must remain
   unlicensed because organization secrets are unavailable.
3. Add the candidate to the reviewed central consumer registry and continuous
   audit. That audit must read the exact default-branch commit and fail closed
   on incomplete retrieval.
4. Add the repository to the reader App's selected-repository installation.
   The App has Actions read, Contents read, Metadata read, and organization
   self-hosted runners read. Do not grant write permission.
5. Add the repository to selected-repository visibility for only the writer,
   reader, and Unity organization secrets it needs. The writer App itself
   remains installed only on
   `Ambiguous-Interactive/ambiguous-organization-build-lock` with Metadata read
   and Contents write.
6. Protect workflow changes with CODEOWNERS or rulesets and restrict write
   access to trusted principals. Trusted PR jobs do not use approval-only
   environments.

## Workflow contract

1. Pin every remote action, including transitive local-composite leaves, to a
   reviewed 40-character commit SHA.
2. Run `check-unity-runner-availability` in a hosted registration preflight
   before every licensed self-hosted job. It verifies only that every required
   label set has a registered runner visible to the repository; it does not
   require the runner to be online or idle. Make the licensed job depend on the
   preflight so an impossible label set fails instead of queueing forever.
3. Before referencing Unity credentials or entering the organization FIFO,
   require the exact manually installed editor with a bounded,
   failure-propagating call to `ensure-editor.ps1 -CiManagedOnly
   -RequireHealthyExisting`. A missing, unhealthy, or non-canonical editor is
   an offline runner-maintenance failure; CI must not install, download,
   repair, move, quarantine, or otherwise provision an editor. Do not restore
   `UH_ENSURE_EDITOR_PROVISIONING_BUDGET_SECONDS` or
   `UH_ENSURE_EDITOR_INSTALL_TIMEOUT_SECONDS`. The enrollment audit follows
   workflow-reachable checked-in PowerShell scripts to reject hidden
   provisioning, but only a direct workflow invocation satisfies the mandatory
   gate because arbitrary wrapper control flow cannot prove that the check ran.
   Reachable wrappers must use literal checked-in script paths; unresolved
   script-variable invocation fails closed. The only permitted preceding step
   is the approved immutable, exact-input current-PR-head guard. Then run the
   approved bounded, no-profile bootstrap that removes only the exact
   `.ci/unity-helpers` directory, rejects a reparse-point `.ci` parent, and
   proves absence. Then, immediately before that gate,
   check out the approved `unity-helpers` repository, revision, and destination
   with the approved immutable `actions/checkout` revision,
   `persist-credentials: false`, `clean: true`, and literal
   `set-safe-directory: false`; no other checkout input, expression, or value
   is permitted. The checkout must be
   unconditional, failure-propagating, and contain no additional inputs; no
   intervening step may replace the helper tree. Forced recreation prevents
   persistent local `.git/config` from surviving `clean: true`. Its exact
   five-entry
   environment disables system/global Git configuration and pins
   `core.hooksPath` to `/dev/null`. Workflow- and job-level `env` mappings must
   be absent: inherited values can inject code into PowerShell/.NET before the
   first bootstrap command, or redirect Git, hooks, and the checkout action
   runtime. Put required values in step-local environments after the bootstrap
   and mandatory editor gate. The gate itself uses the approved exact
   no-profile shell template and one-line validator command, with a quoted
   literal editor release, the runner-owned
   `$env:RUNNER_TOOL_CACHE\u6-v3` root, a closed provisioning profile, no step
   environment, and no additional commands. The profile is `EditorOnly` unless
   the reviewed static `matrix.test-mode` map selects
   `StandaloneWindowsIl2Cpp` for `standalone`. Its version must exactly match the
   central return version; the only dynamic form is the reviewed static
   `matrix.unity-version` axis used by both steps.
   The optional current-head guard, bootstrap, checkout, gate, and acquire must
   omit `if`, preserving GitHub's implicit `success()` chain; `always()` is
   prohibited on this prefix because it could continue after provenance
   rejection.
4. Validate local Unity secret shape, then check that a PR run is still the
   current head immediately before expensive setup and again before acquire.
5. Acquire immediately before the activation-capable section. Pass a stable,
   non-empty `runner.name` and set lifecycle downgrade guards compatible with
   the committed live configuration.
6. Keep activation, tests/build, return, central evidence classification, release,
   and the final cleanup gate in one job on one physical runner identity. Use
   bounded activation retry for transient seat handoff.
7. Run the pinned central `return-unity-license` action and
   `classify-unity-cleanup-evidence` with exactly
   `always() && steps.<acquire-id>.outputs.acquired == 'true'`. Bind both to
   the one approved acquire step used by the cleanup gate. The return action
   constructs the editor path from a literal Unity version and the immutable
   `${{ runner.tool_cache }}` context. Its optional `editor-layout` is a closed
   literal selector: omitted or `canonical` resolves
   `u6-v3/<version>/Editor/Unity.exe`, while `ci-managed-alternate` resolves
   `u6-v3/_ci-managed-editors/<version>/Editor/Unity.exe`. Arbitrary roots and
   executable paths are never cleanup authority. The action rejects
   reparse-point ancestry and requires an exact centrally allowlisted Unity
   Authenticode signer with the code-signing EKU; consumer scripts,
   caller-selected executable paths, and caller-selected signer identities are
   not cleanup authority. It reports a dedicated run-scoped log path,
   command-completed state, signed exit code,
   capture-complete attestation, and SHA-256 of the exact redacted log bytes.
   Bind that digest directly into the classifier so later workflow steps
   cannot replace evidence. The classifier accepts only the exact current-run
   `RUNNER_TEMP/unity-return-<run>-<attempt>-<suffix>/return-license.log`
   contract, rejects link/reparse ancestry, hard links, and identity changes,
   then atomically claims the action-owned directory under a private random
   name. The authoritative bounded read, digest check, and classification occur
   only after that claim. On the central action's required Windows runner, the
   classifier opens the exact file and empty directory through
   identity-verified native handles. The file handle excludes write/delete
   sharing while it rechecks the digest and deletes those objects with no
   pathname fallback, and verifies absence before it reports
   `classification-complete=true`. Run typed release and the final cleanup gate
   with literal `always()`. Only exact entitlement and ULF success lines in the
   dedicated return log are `confirmed/healthy`; exit zero, supplemental proof,
   or a missing serial is not proof. Supplemental evidence is classified but
   is not deletion-owned by the central classifier; its producer must retain a
   separately bounded stale-evidence policy without changing the terminal
   return/classifier/release/gate suffix.
   Signer rotation requires a reviewed central action release. The immediate
   signature-check-to-process-start interval assumes no concurrently executing
   same-account process is mutating the verified editor image; sequential
   consumer workflow steps are not trusted to establish editor identity.
   The central return pin must appear in both `approvedLockShas` and the
   narrower `approvedReturnShas`; older globally approved releases do not
   authorize this credential-bearing action.
8. Preserve fallback cleanup for runner loss. It must target the exact acquire
   identity and fail closed to quarantine when positive return cannot be
   proven. A separate fallback job is classified as `fallback-cleanup`, not as
   a second paid lifecycle, only when it cannot acquire or activate Unity, runs
   on a hosted runner under `always()`, contains only one approved release
   action with the exact literal source-job holder identity and
   `unknown/healthy/return-terminated`, propagates release failure, and is
   covered with its source job by a hosted always-reporting aggregate.
9. Run `require-confirmed-unity-cleanup` after release with `if: always()` and no
   `continue-on-error`. Exact `acquired=false` makes the gate non-applicable
   because licensed work is guarded by `acquired == 'true'`; missing or invalid
   acquisition state remains fail-closed. A local quarantine, missing
   classification, holder removal without a safe release result, or contradictory
   reservation must fail an acquired licensed job. A pre-existing global incident
   may warn rather than fail only when release reports `global-quarantined`, the
   exact incident identity, caller-local confirmed/healthy evidence, exact holder
   removal, and a coherent cooldown or direct release; the incident still blocks
   all new admission. The central return evidence has already been deleted
   before classification completes and must never be uploaded.
10. Emit one stable, always-reporting aggregate. Use the central
   `classify-unity-changes` action in a hosted, failure-propagating classifier
   job; it defaults to requiring Unity and skips only the central
   Unity-independent path allowlist. Use `require-unity-validation` for the
   aggregate when the workflow has a change-classifier or untrusted-revision
   branch. Bind its inputs directly to that classifier, preflight, licensed,
   and hosted fallback job results plus the fallback release's typed
   `cleanup-result`. It accepts only an exact untrusted skip, an exact
   classified non-Unity skip, or fully successful licensed work whose fallback
   reports `noop`. Missing, malformed, cancelled, partial, contradictory, or
   residue-bearing execution fails.
11. Disable automatic cancellation for every scope that can terminate a job
    after acquire. Superseded runs exit before acquire; holders finish cleanup.

The conditional classifier and aggregate have an exact static shape. All five
referenced jobs must be distinct and must not define workflow/job `env`,
`defaults`, containers, services, or a matrix. The classifier has exactly the
two steps below; preflight has exactly one approved preflight action; fallback
has exactly one approved release action; and the aggregate has exactly one
validation action. Replace `APPROVED_LOCK_SHA` only with a reviewed SHA listed
in `approvedLockShas`. A pin used for the central return action must also be
listed in `approvedReturnShas`.

```yaml
jobs:
  change-classifier:
    runs-on: ubuntu-latest
    outputs:
      unity-required: ${{ steps.classify.outputs.unity-required }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          fetch-depth: 0
          persist-credentials: false
      - id: classify
        uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/classify-unity-changes@APPROVED_LOCK_SHA
        with:
          event-name: ${{ github.event_name }}
          base-sha: ${{ github.event.pull_request.base.sha }}
          head-sha: ${{ github.event.pull_request.head.sha }}

  unity-ci:
    if: always()
    needs: [change-classifier, runner-preflight, unity, unity-cleanup]
    runs-on: ubuntu-latest
    steps:
      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/require-unity-validation@APPROVED_LOCK_SHA
        with:
          classifier-result: ${{ needs.change-classifier.result }}
          unity-required: ${{ needs.change-classifier.outputs.unity-required }}
          trusted-revision: ${{ github.actor != 'dependabot[bot]' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) }}
          preflight-result: ${{ needs.runner-preflight.result }}
          unity-result: ${{ needs.unity.result }}
          fallback-result: ${{ needs.unity-cleanup.result }}
          fallback-cleanup-result: ${{ needs.unity-cleanup.outputs.cleanup-result }}
```

## Canary

Before enforcing the aggregate as required:

1. Open a same-repository PR and confirm the licensed job starts without an
   approval prompt.
2. Confirm preflight can see the intended registered runner labels.
3. Confirm acquire records the expected repository, run, job, attempt, and
   physical runner.
4. Confirm Unity produces the intended test or build result.
5. Confirm the central classifier reports `confirmed/healthy`, release removes
   ownership, and the final cleanup gate passes. At the current nonzero setting a
   short confirmed-cleanup cooldown is expected.
6. Confirm no holder, quarantine, or global incident remains after normal
   cleanup and cooldown expiry.
7. Confirm a fork PR receives no organization credentials and follows the
   explicit unlicensed aggregate policy.
8. Confirm the reaper can read the repository's workflow-run status and the
   policy audit can read its exact workflow commit.
9. Confirm the exact aggregate context and issuing App in the repository
   ruleset before enforcing it.

If any probe fails, narrow the diagnosis to App installation, selected-secret
visibility, runner-group visibility, immutable pins, or workflow policy. Do not
broaden either App or organization secrets as a diagnostic shortcut, and never
copy credential values into source, logs, artifacts, or comments.
