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
   The App has Actions read, Contents read, Metadata read, organization
   self-hosted runners read, and Administration read. Do not grant write
   permission.
5. Add the repository to selected-repository visibility for only the writer,
   reader, and Unity organization secrets it needs. The writer App itself
   remains installed only on
   `Ambiguous-Interactive/ambiguous-organization-build-lock` with Metadata read
   and Contents write.
6. Protect workflow changes with CODEOWNERS or rulesets and restrict write
   access to trusted principals. Trusted PR jobs do not use approval-only
   environments.
7. Use action files only from this central repository. A remote action path
   under `Ambiguous-Interactive/*/.github/actions/` is a policy finding unless
   it is under `Ambiguous-Interactive/ambiguous-organization-build-lock`;
   reusable workflow calls are audited separately as workflow graph edges.

## Release authorization

Releases are cut by the automatic `Auto release` workflow. Each release is not
usable by consumers until a reviewed pull request adds its exact SHA to
`unity-enrollment-policy.json`.

After each release, `Auto release` opens an `Authorize vN.N.N release adoption`
pull request. Every workflow run, including scheduled runs and manual
dispatch, proposes the newest release that the policy does not list yet, so a
failed or missed proposal is retried until the pull request is merged.
Merging that pull request is the human authorization decision;
the automation only opens it. Review the diff between the newest previously
approved SHA and the new release SHA. If the diff touches
`return-unity-license` or its runtime, review that credential-bearing path
before merge. Merge adds the SHA to both `approvedLockShas` and
`approvedReturnShas`.

Until the merge, consumer pins to the new release fail closed as
`unapproved-lock-ref`. The released-but-unauthorized gap is therefore visible
as an open pull request, not as a silent absence.

After each authorization merge, the central `Repin consumer lock references`
workflow opens repin pull requests in enrolled repositories. Each pull request
moves the repository's lock action references to the newly authorized release.
The automation enables auto-merge on every offer it opens, so GitHub merges
the offer once every required check and merge rule passes; no click is
needed. The merge gates stay with the consumer: a repository can turn off its
`Allow auto-merge` setting, or disable auto-merge on one offer, and merge by
hand. The automation requests auto-merge once, when it opens the offer; it
never re-enables it on a later run, so a consumer who disables auto-merge
keeps that decision. When GitHub refuses the request, the run stays green,
the offer stays open for a manual merge, and the run summary records the
gap. A closed repin offer stays closed: the automation never re-offers that
repin, and it leaves the repin branch untouched. A consumer close is a
decline; a manual reopen can restore the offer. A new release
opens a new repin pull request. When no permitted lock-pin change remains
to reach the authorized release, the automation closes every open offer
whose head branch matches its `automation/repin-lock-<short sha>` name.
The run summary records the count, and the offer branches stay untouched.
A repin branch without a pull request is
reused only when its content matches the current repin exactly; the
automation never force-updates it. A workflow file listed in a reviewed
`repinExceptions` policy entry keeps its
current pin; the pull request body names each preserved file and its review
expiry. Some consumer files derive their content from the pin: copyable
examples in operational docs, reviewed pin constants in contract tests, and
local allowlist snapshots. A reviewed `repinCompanions` policy entry names
each such file and one mechanical rewrite mode (`pin-lines`, `pin-literal`,
or `policy-snapshot`). The repin pull request moves those files with the
pins, so the offered commit is complete. The pull request body names each
changed companion file and its mode. The scheduled enrollment audit reports
an expired repin exception and
a repin exception whose protected file no longer exists. The finding codes
are `expired-repin-exception` and `stale-repin-exception`, and the audit
drift issue lists them with the repository and path.

The rewrite normalizes pin comments. A moved pin carries a `# vX.Y.Z`
comment for the new release: a pin without a comment gains one, and a pin
with a version comment is updated. A pin already at the target keeps its
current shape. A comment that is not a version, such as a reviewed witness
note, survives untouched.

Dependabot reads a SHA pin only through its `# vX.Y.Z` version comment, so
the normalized pins are Dependabot-visible. Two limits keep the central
repin offer as the complete update. Dependabot moves only the `uses:` line,
so a repository with reviewed companions must not merge a Dependabot-only
pin update; the offered commit would be incomplete and the consumer contract
tests would stay red. Dependabot proposes an update when a release
publishes, before the release is authorized, and that pin fails closed as
`unapproved-lock-ref`; the pull request stays red until the central
authorization pull request merges. After that merge, a rebase makes the
Dependabot pull request green. Merging either pull request answers the
adoption. The next repin run closes a superseded central offer; it never
touches a Dependabot pull request.

## Workflow contract

1. Pin every remote action, including transitive local-composite leaves, to a
   reviewed 40-character commit SHA.
2. Run `check-unity-runner-availability` in a hosted registration preflight
   before every licensed self-hosted job. It verifies only that every required
   label set has a registered runner visible to the repository; it does not
   require the runner to be online or idle. Make the licensed job depend on the
   preflight so an impossible label set fails instead of queueing forever.
   Every licensed job itself must run on the organization's self-hosted fleet.
   Declare a literal `self-hosted` label in the job's `runs-on` list. The
   enrollment audit rejects licensed work on GitHub-hosted or ambiguous
   runners as `unsafe-hosted-unity-runner`, because portal license seats
   cannot be attributed to a hosted machine identity.
3. Before referencing Unity credentials or entering the organization FIFO,
   invoke the pinned central `ensure-unity-editor` action with a ten-minute
   timeout, literal `ci-managed-only: true` and
   `require-healthy-existing: true`, the runner-owned
   `${{ runner.tool_cache }}\u6-v3` root, and
   `diagnostics-path: unity-editor-check.json`. A missing, unhealthy, or
   non-canonical editor is an offline runner-maintenance failure; CI must not
   install, download, repair, move, quarantine, or otherwise provision an
   editor. The action carries the trusted validator payload, invokes it without
   a command shell, and exposes the validated executable through the
   `editor-path` output, so consumers need neither a `unity-helpers`
   checkout nor a diagnostics-binding run step. The profile is
   `EditorOnly`, the literal `StandaloneWindowsIl2Cpp` on a static matrix
   (it verifies the IL2CPP player module on every leg, so sequential
   per-mode steps may use it), or the reviewed static `matrix.test-mode`
   map that selects `StandaloneWindowsIl2Cpp` for `standalone`. An
   `EditorOnly` profile beside a static `standalone` matrix value stays
   rejected, and the literal profile does not lift the include-based and
   dynamic matrix rejections.
   Its version must exactly match the central return version; the only dynamic
   form is the reviewed static `matrix.unity-version` axis used by both actions.
   The only permitted preceding step is the approved immutable, exact-input
   current-PR-head guard. Workflow-, job-, and editor-action `env` mappings are
   absent because inherited values can preload the Node runtime before the
   immutable action begins. The optional current-head guard, editor action, and
   acquire omit `if`, preserving GitHub's implicit `success()` chain;
   `always()` is prohibited on this prefix. Checked-in PowerShell remains
   audited for hidden editor provisioning but cannot satisfy the mandatory
   central action gate.

   During rollout, the central audit also recognizes the exact previously
   approved bootstrap/checkout/script prefix so already-enrolled default
   branches do not become noncompliant before they can repin. That compatibility
   shape is closed and must not be copied into new or edited workflows; migrate
   it to `ensure-unity-editor` at the next central pin update.
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
   only after that claim. On the central action's Windows runner, the
   classifier opens the exact file and empty directory through
   identity-verified native handles. The file handle excludes write/delete
   sharing while it rechecks the digest and deletes those objects with no
   pathname fallback, and verifies absence before it reports
   `classification-complete=true`. Run typed release and the final cleanup gate
   with literal `always()`. Only exact entitlement and ULF success lines in the
   dedicated return log are `confirmed/healthy`; exit zero, supplemental proof,
   or a missing serial is not proof. The one exception is the measured
   shared-seat handoff (issue #83): the ULF success line with a `400006` seat
   response and a completed command is `confirmed/healthy`, because the peer
   already released the seat. Supplemental evidence is classified but
   is not deletion-owned by the central classifier; its producer must retain a
   separately bounded stale-evidence policy without changing the terminal
   return/classifier/release/gate suffix.
   Signer rotation requires a reviewed central action release. The immediate
   signature-check-to-process-start interval assumes no concurrently executing
   same-account process is mutating the verified editor image; sequential
   consumer workflow steps are not trusted to establish editor identity.
   The central return pin must appear in both `approvedLockShas` and the
   narrower `approvedReturnShas`; older globally approved releases do not
   authorize this credential-bearing action. The audit admits the central
   return only on a literal self-hosted Windows or macOS runner. A Darwin
   return is additionally admitted only when its pin is listed in
   `approvedDarwinReturnShas`. That list is a separate reviewed authorization
   added after a Darwin verifier release exists; until then the list is empty
   and every Darwin return fails closed as
   `unsafe-return-execution-environment`.
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
listed in `approvedReturnShas`, and for a Darwin runner also in
`approvedDarwinReturnShas`.

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

## Finding codes

The scheduled audit reports every finding with one of these reason codes.
Fix the finding with the matching consumer edit. Item numbers refer to the
Workflow contract above. The exception codes apply to
`unity-enrollment-policy.json` in this repository. The repository,
head-revalidation, and merge-policy retrieval codes report central audit
health, not consumer drift. The merge-policy attestation codes are consumer
edits.

| Code | Consumer fix |
| --- | --- |
| `acquire-after-activation` | Move the acquire step before every activation-capable step. See item 5. |
| `ambiguous-lock-acquire` | Keep exactly one acquire action in the licensed job. See item 5. |
| `approval-environment` | Remove the `environment` key from the job. See Preconditions item 6. |
| `classifier-before-unity-return` | Order the evidence classifier after the central return. See item 7. |
| `classifier-inputs-not-typed` | Bind the classifier inputs to the exact acquire step outputs. See item 7. |
| `classifier-not-always` | Run the classifier with `always()` and failure propagation. See item 7. |
| `cleanup-gate-before-release` | Run the final cleanup gate after the release step. See item 9. |
| `cleanup-gate-inputs-not-typed` | Bind the gate inputs to the exact typed release and classifier outputs. See item 9. |
| `cleanup-gate-not-always` | Run the gate with literal `always()` and no `continue-on-error`. See item 9. |
| `default-branch-advanced` | No consumer edit. The default branch advanced while the audit read it, so the audit refreshed the snapshot and failed closed when the refresh did not reconcile. The next audit reads the new head. |
| `default-branch-revalidation-incomplete` | No consumer edit. The audit could not read the current default-branch head. Central operators check the reader token and run access. |
| `expired-policy-exception` | Renew or remove the expired registry exception in `unity-enrollment-policy.json`. |
| `expired-repin-exception` | Renew or remove the expired `repinExceptions` entry. See Release authorization. |
| `fallback-cleanup-not-always` | Guard the fallback job with `always()` and the source-job condition shape. See item 8. |
| `fallback-cleanup-not-hosted` | Run the fallback job on `ubuntu-latest`. See item 8. |
| `filtered-aggregate-gate` | Report the aggregate on every pull request: remove the trigger path filter, or pair one `paths-ignore` trigger with a companion gate whose `paths` list contains every ignored pattern. See item 10 of the canary. |
| `foreign-action-reference` | Use action files only from this repository. See Preconditions item 7. |
| `ineligible-unity-trigger` | Restrict licensed work to the eligible trusted triggers. See Preconditions item 2. |
| `invalid-acquire-pr-head-revalidation` | Give acquire the exact current-head revalidation inputs. See item 4. |
| `invalid-current-head-guard` | Pin the guard step to the approved current-head guard SHA. See item 4. |
| `invalid-fallback-release` | Keep one typed, source-matched release step in the fallback job. See item 8. |
| `invalid-fallback-timeout` | Give the fallback job a timeout of at least 5 minutes. See item 8. |
| `job-scoped-unity-credential` | Remove job-level `env` mappings; any mapping fails a fallback-cleanup job. See item 3. |
| `missing-cleanup-classifier` | Add the typed central evidence classifier. See item 7. |
| `missing-cleanup-gate` | Add the final cleanup gate. See item 9. |
| `missing-fallback-aggregate` | Cover the source and fallback jobs with one hosted always-reporting aggregate. See item 8 and the exact static shape note. |
| `missing-initial-current-head-guard` | Put the approved current-head guard first in the licensed PR job. See item 4. |
| `missing-licensed-steps` | Keep the licensed steps in the audited job. See item 6. |
| `missing-lock-acquire` | Acquire before the activation-capable section. See item 5. |
| `missing-pre-lock-current-head-guard` | Re-check the current head immediately before acquire. See item 4. |
| `missing-runner-preflight` | Add the hosted registration preflight and make the licensed job depend on it. See item 2. |
| `missing-typed-release` | Add the typed central release step. See item 7. |
| `missing-unity-aggregate` | Emit the exact-shape hosted aggregate that covers the licensed job. See item 10 and the exact static shape note. |
| `missing-unity-editor-check` | Invoke the pinned `ensure-unity-editor` action with the exact inputs in the reviewed prefix: in new or edited workflows only the current-PR-head guard may precede it. See item 3. |
| `missing-unity-return` | Run the pinned central `return-unity-license` action. See item 7. |
| `mutable-acquire-ref` | Pin acquire to a full 40-character commit SHA. |
| `mutable-action-ref` | Pin every remote action to a reviewed full commit SHA. See item 1. |
| `mutable-reusable-ref` | Pin every reusable workflow call to a full commit SHA. See item 1. |
| `release-before-classification` | Order the release step after the evidence classifier. See item 7. |
| `release-inputs-not-typed` | Bind the release inputs to the exact acquire step outputs. See item 7. |
| `release-not-always` | Run the release step with literal `always()`. See item 7. |
| `repository-analysis-incomplete` | No consumer edit. The audit failed closed while analyzing this repository. Central operators diagnose the run. |
| `repository-retrieval-incomplete` | No consumer edit. The audit failed closed before reading this repository. Central operators repair the run. |
| `stale-policy-exception` | Remove the registry exception whose protected path no longer needs it. |
| `stale-repin-exception` | Remove the `repinExceptions` entry whose protected file no longer exists. |
| `unapproved-acquire-ref` | Use an acquire SHA listed in `approvedLockShas`. See Release authorization. |
| `unapproved-lock-ref` | Pin central actions to a SHA listed in the reviewed policy lists. See Release authorization. |
| `unbounded-unity-editor-check` | Give the editor gate a timeout of 10 minutes or less. See item 3. |
| `unexpected-fallback-step` | Keep only the approved release action in the fallback job. See item 8. |
| `unity-editor-check-after-credentials` | Run the editor gate before any credential reference. See item 3. |
| `unity-editor-check-after-lock` | Run the editor gate before acquire. See item 3. |
| `unity-editor-provisioning-control` | Remove the editor provisioning control overrides. CI must not provision an editor. See item 3. |
| `unity-return-not-always` | Run the central return with `always()` on acquired work. See item 7. |
| `unresolved-reusable-workflow` | Keep every reusable workflow call resolvable at audit time. |
| `unreviewed-unity-reference` | Complete the reviewed exception or authorization for the licensed reference. |
| `unsafe-central-return-suffix` | Keep the exact return, classifier, release, and gate suffix. See item 7. |
| `unsafe-hosted-unity-runner` | Run licensed work on the self-hosted fleet with literal labels. See item 2. |
| `unsafe-job-cancellation` | Use literal `cancel-in-progress: false` on the job concurrency group. See item 11. |
| `unsafe-job-container` | Run licensed work directly on the self-hosted runner, not in a container. See item 6. |
| `unsafe-matrix-fail-fast` | Set `fail-fast: false` on licensed matrices. |
| `unsafe-node-options` | Remove workflow or job `env` that can preload Node before the immutable gate. See item 3. |
| `unsafe-return-execution-environment` | Return only on an admitted self-hosted runner with isolation and a timeout. See item 7. |
| `unsafe-unity-editor-check` | Keep the editor gate success-dependent and failure-propagating. See item 3. |
| `unsafe-unity-editor-provisioning` | Remove editor install, repair, or provisioning steps. Rely on the central gate. See item 3. |
| `unsafe-workflow-cancellation` | Use literal `cancel-in-progress: false` on the workflow concurrency group. See item 11. |
| `missing-required-context` | Require the aggregate context on the default branch. See Merge policy audit. |
| `renamed-required-context` | Restore the exact reviewed context spelling. See Merge policy audit. |
| `disabled-ruleset` | Set the ruleset enforcement to active. See Merge policy audit. |
| `unexpected-bypass-actor` | Remove the bypass actor, or record it in `merge-policy-expectations.json` after review. See Merge policy audit. |
| `merge-policy-attestation-missing` | Publish `.github/merge-policy-attestation.json`, or add the carrying ruleset to its `rulesets` list. See Merge policy audit. |
| `merge-policy-attestation-stale` | Update `.github/merge-policy-attestation.json` to the live ruleset state, or remove entries for rulesets that carry no reviewed context. See Merge policy audit. |
| `merge-policy-retrieval-incomplete` | No consumer edit. The audit failed to read this repository's live merge settings. Central operators diagnose the run. |

## Merge policy audit

A scheduled central audit compares each enrolled default branch with the
reviewed expectations in `merge-policy-expectations.json`. The expectations
name the always-reporting Unity aggregate contexts that the branch must
require before merge, plus every bypass actor that review accepted. The
repository set and default branches must match `unity-enrollment-policy.json`;
the audit refuses to run when they drift.

The audit reads live rulesets and classic branch protection with a
per-repository reader token scoped to Administration read and Contents read.
A failed read is a finding, never a pass. GitHub returns ruleset
`bypass_actors` only to callers with write access to the ruleset. The reader
App stays read-only by reviewed policy (issue #254), so the audit fills that
one blind spot from the consumer-published attestation file and fails closed
when the file is missing or stale. Classic branch protection bypass evidence
stays readable with Administration read. Findings are consumer decisions; the
audit reports and opens one deduplicated issue.

- `missing-required-context`: no active ruleset or branch protection on the
  default branch requires the reviewed aggregate. Add the requirement.
- `renamed-required-context`: the reviewed aggregate is required with a
  different letter case. Restore the reviewed spelling.
- `disabled-ruleset`: a ruleset that still declares the aggregate is not
  active on the default branch. Set its enforcement to active.
- `unexpected-bypass-actor`: a ruleset grants a bypass actor that review did
  not accept, or classic protection lets administrators bypass the aggregate.
  Remove the bypass or record the actor in `merge-policy-expectations.json`
  after review, with its exact type, id, and bypass mode; an omitted mode
  records the default `always` mode. A detail that ends with `(attested)`
  reports an actor the consumer attestation published.
- `merge-policy-attestation-missing`: a carrying ruleset has no bypass
  evidence and no attestation entry covers it. Publish the file or add the
  entry.
- `merge-policy-attestation-stale`: the attestation does not match the live
  ruleset, names a ruleset that carries no reviewed context, or is not valid
  in the reviewed schema. Update the file. When the stale file hides the
  only bypass evidence, the audit also fails closed.
- `merge-policy-retrieval-incomplete`: the audit could not read this
  repository's live merge settings. No consumer edit. Central operators
  diagnose the run.

A missing file and a central Contents-read permission failure both answer
404, so both present as `merge-policy-attestation-missing` in every
repository that has a carrying ruleset. Other contents read failures
present as `merge-policy-retrieval-incomplete`. Central operators check
the run first when the finding appears for all consumers.

### Merge policy attestation

Each consumer whose default branch has a carrying ruleset publishes
`.github/merge-policy-attestation.json`. The file attests the `bypass_actors`
list that GitHub hides from read-only callers. The audit proves freshness by
comparing every visible field with the live ruleset; any mismatch is a
finding. Update the file through a reviewed pull request whenever the
ruleset changes. The central change classifier names this exact file
Unity-independent, so publishing it never spends a licensed runner cycle;
any other `.github/` change still requires Unity validation.

```json
{
  "schemaVersion": 1,
  "repository": "Ambiguous-Interactive/DxMessaging",
  "rulesets": [
    {
      "rulesetId": 17663217,
      "rulesetName": "Required CI - Unity Tests (default branch)",
      "enforcement": "active",
      "requiredContexts": [
        "CI Success",
        "Unity CI Success",
        "Devcontainer CI Success"
      ],
      "bypassActors": [
        { "actorType": "Integration", "actorId": 3977200, "bypassMode": "always" }
      ]
    }
  ]
}
```

- `rulesets` lists exactly the active rulesets that require a reviewed
  context on the default branch.
- `rulesetName`, `enforcement`, and `requiredContexts` must equal the live
  ruleset state.
- `bypassActors` uses the same fields as the API response. An omitted
  `bypassMode` means `always`.
- Repositories whose reviewed expectations name no required context publish
  no file. Classic branch protection never needs an attestation.

`unity-builder` is exempt: it is a fork whose paid Windows workflow is a
controlled manual canary, so it declares no required context. Item 6 of
Preconditions records the same policy.

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
10. Confirm the workflow that reports the required context runs on every pull
    request. GitHub reports no check for a pull request that a `pull_request`
    `paths` filter excludes, so the required status never appears there and the
    ruleset blocks those merges forever. Remove the filter and let the change
    classifier skip licensed work, or pair the filter with a companion gate
    that reports the same context on the excluded paths. The enrollment audit
    reports `filtered-aggregate-gate` when no workflow in the repository
    provably reports a required context on every pull request. The audit
    proves coverage only through literal shapes: an unfiltered companion
    trigger that runs for the protected branch, or for one `paths-ignore`
    trigger a companion `paths` list that contains every ignored pattern and
    runs for the protected branch. The companion reporting job carries no
    condition and no `needs` dependency, or exactly `always()`, and may not
    exclude pull request events. A matrix job or a malformed trigger proves
    no exact context and fails closed. A literal job `name` names the
    context directly; an expression `name` counts only through its exact
    single-quoted literal.
11. Confirm every consumer test that reads a central runtime verdict asserts
    the reviewed fields. Tolerate reviewed additive fields. Central releases
    add verdict fields by review; additive fields are central evolution, not
    consumer drift. A test that deep-equals a whole verdict object breaks on
    each addition. The repin offer that carries the addition then fails.
    Sweep onboarding reviews for strict verdict compares before the
    repository joins the enrollment.
12. Confirm the licensed job separates an engine-internal assertion with zero
    failed test-case leaves from a real red suite. Give the signature its own
    stable reason (for example `editor-session-crash`) and retry the affected
    test phase once inside the held lock. Keep a second failure red. Surface
    the release step's redacted `peer-timeline` output next to the failure so
    an editor-session casualty can be checked against peer lock activity in
    the same window.

If any probe fails, narrow the diagnosis to App installation, selected-secret
visibility, runner-group visibility, immutable pins, or workflow policy. Do not
broaden either App or organization secrets as a diagnostic shortcut, and never
copy credential values into source, logs, artifacts, or comments.
