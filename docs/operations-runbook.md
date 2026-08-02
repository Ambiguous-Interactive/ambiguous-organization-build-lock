# Unity Build Lock Operations

This is the steady-state operator runbook for the organization Unity build
lock. The completed migration and incident chronology are preserved in
[Historical Secure Two-Seat Unity Rollout](secure-two-seat-rollout.md).

Never put Unity serials, App private keys, tokens, raw licensing logs, or
reversible credential transformations in a repository, issue, workflow
summary, or artifact. Operational evidence is limited to repository and run
identity, physical runner name, timestamps, reason codes, opaque reservation or
incident IDs, and non-reversible digests.

## Live configuration

The committed sources of truth are
`locks/wallstop-organization-builds.config.json` for live capacity controls and
`docs/operations-facts.json` for the reviewed schema, release, and inventory:

- State schema: `5` (account health enabled)
- Maximum holders: `2`
- Runner serialization: `enabled`
- Resource lifecycle: `enabled`
- Confirmed-cleanup cooldown: `1` second
- Published compatibility release: `v1.10.0` at
  `3741b56ceab4a68ba4c09fe7e91e804b53ff2412`

The one-second cooldown remains the live value. Issue #60 tracks literal zero,
but the concurrent shared-entitlement return collision in issue #83 must be
resolved with independently returnable identities and live reconciliation
before a zero-cooldown claim is safe. Do not describe zero as live.

Effective capacity is `maxHolders` minus active holders and
capacity-consuming reservations. A normal confirmed-cleanup cooldown consumes
one slot until it expires. A runner quarantine consumes one slot until
same-runner recovery or an exact-ID operator recovery. A global account
incident blocks all new admission regardless of nominal capacity.

## Enrolled consumers

`unity-enrollment-policy.json` is the authoritative reviewed paid or
lock-aware perimeter. It retains this required baseline:

- `Ambiguous-Interactive/DoxReloaded` <!-- enrollment-baseline -->
- `Ambiguous-Interactive/DxMessaging` <!-- enrollment-baseline -->
- `Ambiguous-Interactive/IshoBoy` <!-- enrollment-baseline -->
- `Ambiguous-Interactive/qora-redux` <!-- enrollment-baseline -->
- `Ambiguous-Interactive/unity-builder` <!-- enrollment-baseline -->
- `Ambiguous-Interactive/unity-helpers` <!-- enrollment-baseline -->

Enrollment changes are reviewed policy changes, not automatic consequences of
organization ownership. Run the secretless `Request Unity repository
onboarding` workflow from `main`; its trusted consumer verifies the requested
repository metadata and opens a registry-only pull request. Review the retained
metadata evidence before merging. The continuous audit evaluates the new
repository's workflows after the policy reaches `main` and reports any drift in
the central issue. Follow [Consumer Enrollment](consumer-enrollment.md) for the
consumer-side rollout.

## Continuous enrollment audit

`unity-enrollment-policy.json` is the reviewed extensible repository registry
and immutable lock-action allowlist. The `Organization Unity enrollment audit`
workflow runs daily at `23 8 * * *`, can be dispatched manually, and also runs
after relevant policy changes reach `main`. It uses the reader App to check out
each current default branch without persisting credentials, analyzes exact Git
objects without executing consumer code—including immutable workflows, actions,
and checked-in PowerShell scripts—and revalidates every default-branch head
before reporting.

The audit derives the reader-App token scope, checkout targets, and exact-head
revalidation set from the validated registry. The required baseline cannot be
removed, repositories outside `Ambiguous-Interactive` are rejected, and
duplicate or malformed entries fail closed.

Repository additions start with the secretless `Request Unity repository
onboarding` workflow on `main`. Its trusted-main `workflow_run` consumer rejects
unsuccessful, off-main, and cross-repository requests before using credentials.
It then scopes a reader-App token to the requested repository and verifies the
canonical full name, default branch, fork status, and exact branch-head SHA.
The generated registry-only PR retains those sanitized facts and the evidence
run URL. A repository typo, stale branch declaration, or missing reader-App
installation therefore fails before a PR can be opened or merged.
Default branches are additionally restricted to the audited URL-safe ASCII
subset (`A-Z`, `a-z`, `0-9`, `.`, `_`, `@`, `+`, `-`, and `/`) before they are
used in any GitHub REST ref path; percent escapes and fragment markers are
rejected rather than interpreted.

Manual operation starts the secretless `Request organization Unity enrollment
audit` workflow. Its completed run triggers the secret-bearing audit through
`workflow_run`, whose definition and executable policy are loaded from trusted
`main`. The secret-bearing workflow deliberately has no direct
`workflow_dispatch` trigger, so selecting a feature-branch ref cannot expose the
reader App credential to branch-controlled workflow code.

The audit fails closed if a repository, workflow, reachable checked-in
PowerShell script, commit, reader credential, exception, or revalidation result
is missing or ambiguous. Findings contain
only repository, commit, workflow path, job, classification, and stable reason
code. They never contain matched source. The workflow opens or updates one
marker-fenced drift issue and closes it only after a complete clean audit.
Never copy matched workflow source,
secret values, or raw API responses into that issue. The sanitized active
inventory and exact commit list in the issue are the retained evidence linked
to issue #42 and rollout tracker #30.

The complete source-free JSON audit is retained as a 30-day Actions artifact.
The issue includes its validated exact artifact URL, total finding and
inventory counts, a deterministic bounded preview, and explicit omitted-row
counts. Use the artifact—not the preview—as the complete evidence set. Artifact
upload/link validation and issue synchronization are mandatory; failure keeps
the workflow red.

A complete scan that finds policy drift keeps the workflow run green only after
the marker-fenced issue has been synchronized; that open issue is the
operational-red state. Retrieval, analysis, head-revalidation, or issue-sync
ambiguity keeps the workflow run red because no trustworthy policy result was
established. The standalone audit command returns nonzero for both drift and
incomplete evidence.

Synthetic or deliberately disabled Unity-shaped workflows require an explicit
registry exception with repository, path, classification, owner, and RFC3339
expiry. An expired, unused, duplicate, or unregistered exception is drift. A
paid-serial job cannot be excepted from lifecycle enforcement. A canonical
hosted recovery job is inventoried separately as `fallback-cleanup`; it must
remain incapable of acquisition or activation and must prove exact
literal source identity, a release-only failure-propagating job, and hosted
aggregate coverage instead of pretending to perform a second paid Unity
lifecycle.

## Credential and App boundary

The required steady-state boundary is:

- The writer App is installed only on
  `Ambiguous-Interactive/ambiguous-organization-build-lock` with Metadata read
  and Contents write. Acquire and release request a repository-restricted token.
- The reader App is installed only on the reviewed consumer inventory. It has
  Actions read, Contents read, Metadata read, and organization self-hosted
  runners read. Each operation requests only the permissions and repositories
  it needs: preflight uses runner inventory, reaping uses Actions/Metadata, and
  the central policy audit uses Contents.
- Writer, reader, and Unity organization secrets use selected-repository
  visibility. They are exposed only to enrolled consumers and to this policy
  repository where an operation requires them.
- Trusted same-repository PR validation has no approval-only environment gate.
  Fork and Dependabot PRs cannot receive these credentials. Repository write
  access and workflow review are therefore part of the trust boundary.

### Known live scope gap

The value-free GitHub installation query on 2026-07-18 still reported
`repository_selection: all` for both `ambiguous-build-lock-automation` and
`ambiguous-build-lock-reader`. The latest sanitized organization-secret
inventory also reported all-repository visibility; the current CLI token cannot
independently re-read that admin-only setting. Issue #51 owns the restriction
and live negative probes. Until it closes, the enrollment registry is a policy
gate, not proof that an unrelated trusted workflow cannot receive or mint with
the shared credentials.

The code retains a compatibility fallback for old deployments, but steady-state
operations must not rely on a broad writer installation or all-repository
reader access. Treat either condition as scope drift.

## Normal job lifecycle

1. A hosted preflight proves that the repository can see a registered runner
   with the required labels. Busy and temporarily offline runners both count as
   available infrastructure; the job queues until one accepts it.
2. Before the licensed job references Unity credentials, it performs a bounded,
   failure-propagating check for the exact canonical editor using
   `ensure-editor.ps1 -CiManagedOnly -RequireHealthyExisting`. Missing or
   unhealthy editor state keeps the job red for manual host maintenance. CI
   must not install, download, repair, move, quarantine, or provision an
   editor, and provisioning-budget environment controls are prohibited. The
   mandatory gate is a direct workflow invocation; reachable checked-in
   PowerShell wrappers are still audited for hidden provisioning and unresolved
   script-variable invocation fails closed. An approved immutable, exact-input
   current-PR-head guard may run first; no other step may precede the approved
   bounded, no-profile removal bootstrap. It rejects a reparse-point
   `.ci` parent, removes only `.ci/unity-helpers`, and proves absence. The
   trusted, immutable `unity-helpers` checkout follows and immediately precedes
   the gate, is
   unconditional and failure-propagating, sets `persist-credentials: false`
   and `clean: true`, plus literal `set-safe-directory: false`. This prevents skipped,
   stale, or subsequently overwritten helper content from satisfying
   provenance. Forced recreation prevents persistent local Git configuration
   from surviving `clean: true`. Its closed environment disables system/global
   Git configuration and sets `core.hooksPath=/dev/null`. Workflow and job
   `env` mappings must be absent. Inherited variables can preload PowerShell's
   .NET runtime before the first bootstrap command, or redirect Git, hooks,
   and the checkout action runtime. Define required values only on later
   steps, after the bootstrap and mandatory editor gate. The gate has an exact
   no-profile shell template and one-line validator command. It supplies a
   quoted literal editor release, the runner-owned
   `$env:RUNNER_TOOL_CACHE\u6-v3` root, and a closed profile, with no step-local
   environment or additional commands. The profile is `EditorOnly`, or the
   reviewed static `matrix.test-mode` map selects
   `StandaloneWindowsIl2Cpp` only for `standalone`. The release must match the
   central return input; only a bounded static `matrix.unity-version` axis may
   supply both dynamically.
   The optional current-head guard, bootstrap, checkout, gate, and acquire omit
   `if` so each inherits the preceding step's successful status. Never use
   `always()` on this prefix: provenance rejection must stop checkout and lock
   acquisition.
3. The licensed job validates local credential shape and verifies that it is
   still the current trusted PR head before entering the organization FIFO.
4. Acquire records the exact repository, run, job, holder suffix, and physical
   runner identity.
5. Unity activation and work run only after acquire succeeds. Activation uses
   bounded retry for transient seat handoff.
6. Unity returns on the same physical identity. Only exact positive return
   evidence is `confirmed/healthy`.
7. Release always runs with the acquire identity and typed cleanup evidence.
   Waiting jobs are removed from the queue even when they never acquired.
   Invalid or contradictory evidence is degraded to unknown; under schema 4 or
   newer, any removed held capacity is quarantined. The release step fails only
   after exact ownership cleanup.
8. The stable aggregate fails on preflight failure, cancellation, unexpected
   skip, partial matrix execution, missing return evidence, or failed release.

Automatic concurrency must not cancel a job after it can acquire. A superseded
run should exit before acquire; once acquired, it finishes activation, work,
return, and release. Manual cancellation remains fail-closed and may create a
runner quarantine.

## Operator quick reference

| State | Capacity effect | Required response |
| --- | --- | --- |
| Normal holder | One slot consumed | Let the owning run finish. Do not cancel it merely because a newer commit exists. |
| Confirmed-cleanup cooldown | One slot consumed until `availableAt` | Wait for expiry. At the live one-second setting this is normally transient. |
| Runner quarantine | One slot consumed without expiry | Reasons include `return-ulf-skipped`, `unity-return-400006`, timeout, termination, incomplete logs, and missing positive evidence. Prefer same-runner reclaim. Otherwise reconcile the Unity portal, then dispatch `recover` with the exact reservation ID and `resource-safe=true`. |
| Global account incident | All new admission blocked; existing holders finish cleanup. A holder with independently confirmed cleanup may pass its terminal gate with an incident warning. | Stop canaries and follow the sanitized source-run provenance in the acquire error or in the `Build lock incident recovery audit` alert issue, which publishes the exact incident ID and dispatch inputs. If cleanup is unconfirmed, first use supported release/post/fallback cleanup and verify the caller is absent from holders and queue. Reconcile every portal activation, then dispatch `recover-incident` with the exact incident ID or leave it blank to bind the single active incident, plus `portal-cleanup-confirmed=true`. Never edit lock state directly. |
| Degraded cleanup report | Exact holder/queue cleanup is attempted; under schema 4 or newer, a removed holder becomes a quarantine | Use `report-validation-error` to correct the typed inputs. The rejected value is intentionally not logged. Treat the failed step and unknown cleanup as red, reconcile the resource, and recover only by exact reservation ID when one was created. |
| Waiting queue entry | No seat consumed, but a runner may be occupied | Let FIFO proceed. If the run terminates before acquire, release/fallback cleanup removes its exact queue entry. |
| Runner unavailable | Licensed work must remain pending or red | Restore eligible runner capacity. Never turn an unavailable required job into skip/green. |

Do not auto-expire, bulk-recover, or activation-probe a `20111` incident.
Historical evidence includes an operator statement that one incident had no
seat leak, but lacks incident-specific portal observations at latch time, so no
outcome is independently classifiable and no safe false-positive rate or
automatic-recovery signature is established. Unity activation consumes the
resource it would be asked to probe. Keep exact-ID, portal-confirmed recovery
until a supported read-only seat query or incident-specific outcome dataset
provides stronger evidence. The bounded investigation and revalidation
triggers are recorded in
[Unity 20111 Incident Outcomes](../.llm/research/20111-incident-outcomes-2026-07-29.md).

Never edit or delete `lock-state` JSON directly. A recovery with a wrong ID,
missing portal proof, or incomplete run-status evidence must fail closed.

## Cancellation and force-cancel

Before cancelling a workflow, determine whether its licensed job is still
GitHub-queued, waiting in the organization FIFO, holding a slot, or cleaning
up. Prefer normal cancellation first. If GitHub leaves a run stuck after a
normal cancellation request, force-cancel only after confirming that cleanup
has finished or that the resulting quarantine is understood and recoverable.

After any cancellation:

1. inspect the workflow's release and fallback-cleanup results;
2. inspect sanitized lock state for its exact holder/queue identity;
3. verify that no unexplained Unity portal activation remains;
4. recover only an exact quarantine or incident ID with the required portal
   proof; and
5. record the run ID, runner, timestamps, cleanup reason, and evidence digest.

## Monitoring and drift

The scheduled reaper confirms terminal workflow runs and applies schema-5
recovery semantics. It keeps state unchanged when run status cannot be proven.
The requested five-minute cron is not a guaranteed delivery cadence. GitHub
schedule delivery is best effort; the current observed delivery can be tens of
minutes late.

The independent `Reaper delivery audit` workflow requests checks at minutes
7, 17, 27, 37, 47, and 57. It queries scheduled reaper run history rather than
depending on the reaper itself having run. It opens, updates, reopens, or closes
one marker-identified incident issue. It also re-runs after each completed
scheduled/manual reaper run, so a healthy delivery closes a stale alert without
waiting for the next schedule. The issue contains run IDs, timestamps, reason codes, and commit SHAs only. It synchronizes an alert when:

- no scheduled run history can be proven;
- the latest delivery exceeds the 30-minute delivery threshold;
- a delivered run remains active beyond the 15-minute run-duration threshold;
- the latest run is unsuccessful.

A known condition is a successful monitor outcome once the issue is
synchronized; the open issue carries the operational red state without making
every scheduled monitor run itself fail. The workflow fails red when run
history is unavailable, malformed, oversized, cross-origin, or otherwise
ambiguous, or when incident synchronization cannot be confirmed.

The independent `Build lock incident recovery audit` workflow runs at
`2,12,22,32,42,52 * * * *`. It reads committed `lock-state` JSON through the
workflow token, proves that any active global incident is internally consistent,
and synchronizes one marker-identified alert issue carrying the exact incident
identifier and the declared `recover-incident` inputs. Operators recover from
that alert either through the linked workflow form or through its prefilled
`gh workflow run` command after portal reconciliation. The command binds the
exact incident identifier automatically, avoiding a separate branch lookup or
identifier copy/paste while preserving explicit `portal-cleanup-confirmed=true`
proof instead of requiring the operator to read lock state by hand. The alert
body is deterministic, so an unchanged incident does not churn the issue. A
recovered lock closes the alert without rewriting it, so the closed issue stays
readable as the retained incident record. An omitted incident ID is frozen from
the first canonical state read and must still match on every CAS retry; a
changed or absent incident fails closed.

The audit covers the global account incident only. A runner quarantine is
reclaimed by the same physical runner or auto-recovered by the scheduled reaper
once the owning run is proven terminal, so alerting on one would add noise
rather than remove manual work.

The audit holds no writer, reader, or Unity credential and never writes lock
state. It never opens, edits, or closes the alert on unprovable state: an
unavailable, oversized, malformed, wrong-lock, unsupported-schema, or
digest-inconsistent read fails the run red and leaves any existing alert exactly
as it was. Publishing the alert never relaxes recovery, which still requires the
exact incident identifier plus explicit portal-cleanup proof.

Discovery asks only for the issues this automation created, so it stays bounded
by that automation's own output rather than by the repository's issue history.
Publication is self-verifying: after creating an alert the audit re-runs
discovery and fails red unless it finds exactly what it just created, so a
discovery filter that stopped matching cannot silently republish the alert on
every run. Two conditions wedge the audit red until an operator intervenes:
`duplicate alert issue evidence` means more than one automation-authored marker
issue exists, and `alert issue pagination exceeded` means discovery ran past its
page budget. For both, delete or retitle the extra automation-authored marker
issue so exactly one remains; never resolve them by editing lock state.

The alert is identified by its marker plus this automation's own authorship, not
by its title. The repository is public, so a foreign-authored lookalike is
ignored rather than adopted or treated as fatal; treating it as fatal would let
any user suppress incident publication. Renaming the alert for context is
therefore safe. Provenance that is awkward to render is escaped and truncated
rather than rejected, because refusing to publish a provable incident is the
failure this audit exists to prevent.

The monitor is itself GitHub-scheduled, so it improves detection but does not
create a bounded recovery SLO. If recovery must be guaranteed within 30
minutes, provision an independent least-privilege trigger that can dispatch
only the existing reaper workflow; it must not receive writer or Unity
credentials and cannot bypass exact reservation/incident proof.

`Reap stale build locks` owns scheduled and manual `reap` operations.
Proof-bearing `recover` / `recover-incident` operations run only through the
separate `Recover build lock` workflow, which has no automatic concurrency
cancellation. The scheduled/manual reaper has a stable group with cancellation
disabled, so a schedule cannot replace or cancel running or pending recovery.
Concurrent reaping and recovery still use the lock action's compare-and-swap
retry and exact-ID fencing.

Scheduled reaping is capacity-first. It evaluates holders before routine queue
cleanup and commits a proven stale-holder quarantine/reap immediately, leaving
the FIFO unchanged for the next five-minute run. Status scanning has an
eight-minute deadline, while state writes share a separate nine-minute total
deadline inside the workflow's ten-minute timeout. A timed-out lookup never
proves cleanup:
the current and all unscanned identities remain in their original order. If a
completed queue entry was already proven within the scanned FIFO prefix, that
bounded cleanup is checkpointed and the action still fails red to make the
incomplete scan operator-visible.

Job-level proof is the numeric Actions job ID recorded by acquire after finding
exactly one active job on the declared runner. Never substitute a timestamp
window or a similarly named matrix leg. If `jobId` is absent (including state
written by an older client), malformed, missing from the exact run attempt, or
bound to another runner, retain the holder or queue entry while the workflow
run is active. Run-level terminal status and lease-governed unavailable-run
handling remain valid fallback evidence.

Monitor and alert on:

- `20111` or any account-blocked classification;
- unexplained portal activations;
- unknown cleanup and quarantine creation;
- App permission, installation, or selected-secret scope drift;
- unauthorized caller attempts;
- runner wait versus organization FIFO wait; and
- required aggregate deletion, rename, unexpected skip, or cancellation.

Use [Lock State](../locks/README.md) for the state/config contract and
[Consumer Enrollment](consumer-enrollment.md) for adding a repository.
