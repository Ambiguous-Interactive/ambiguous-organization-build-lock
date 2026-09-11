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
- Published compatibility release: `v1.14.0` at
  `64bac446903115134dca8235410b332bc5a83547`

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
workflow runs daily at `23 8 * * *` and also runs
after relevant policy changes reach `main`. It uses the reader App to check out
each current default branch without persisting credentials, analyzes exact Git
objects without executing consumer code—including immutable workflows, actions,
and checked-in PowerShell scripts—and revalidates every default-branch head
before reporting. When a consumer pushes while the audit runs, the audit
re-clones the advanced repository, re-analyzes the refreshed snapshots, and
fails closed after the bounded refresh attempts.

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

## Consumer repin automation

The scheduled `Repin consumer lock references` workflow removes the manual
repin step from consumer adoption. On each run it resolves the repin target
from the reviewed policy itself: the newest authorized release tag that both
`approvedLockShas` and `approvedReturnShas` approve. An untagged or
return-unapproved SHA is never a target, so repins cannot outrun the human
authorization merge.

For each enrolled repository the workflow clones the default branch, rewrites
only the `@<sha>` suffix of `uses:` references to this repository's actions
(plus the `# vX.Y.Z` comment: a moved pin without a comment gains one, and a
comment that is not a version stays), carries the reviewed companion files
named in the policy through their mechanical rewrites, and opens one pull
request per repository on the stable branch prefix `automation/repin-lock-`.
The per-repository result is recorded in the run summary; any repository
failure keeps the run red. Idempotency: a repository with no stale reference
is skipped, and an open repin pull request for the same target is never
duplicated. When the rewrite moves no pin, no permitted lock-pin change
remains to reach the authorized release. The automation closes every open
pull request whose head branch matches `automation/repin-lock-<short sha>`
as superseded. The close comment names the release. The run summary records
the count. Offers on any other branch are never touched. A closed repin
pull request is final for that target, whoever closed it. A consumer close
is a decline. The automation skips that repository with a summary row, and
it never updates the branch underneath the closed pull request; a manual
reopen can restore the offer. A
repin branch without an open or closed pull request is a partially failed
run; the next run reuses it only when its content matches the current repin
exactly, opens the pull request from it, and never force-updates a branch
that holds other work.

Dependabot reads a SHA pin only through its `# vX.Y.Z` comment, so the
rewrite gives every moved pin one and pins stay Dependabot-visible
(2026-09-09 issue 263). A non-empty target version must match
`vMAJOR.MINOR.PATCH`, or the rewrite fails closed; the scheduled resolver
emits only that grammar. Dependabot cannot carry companion rewrites or
release authorization: a pin to an unauthorized SHA fails closed as
`unapproved-lock-ref`, and a companion repository that merges a
Dependabot-only pin update leaves its offered commit incomplete. The central
repin offer stays the complete update. When either merge answers the
adoption first, the next run closes a superseded central offer; a
Dependabot pull request is outside the automation branch filter, so the
run never touches it. A repin branch pushed before the comment
normalization reads as different content; delete such a branch once, and
the next run pushes a fresh one.

A reviewed, expiring `repinExceptions` entry in
`unity-enrollment-policy.json` protects one workflow file in one repository
from repinning. Use it only when a pin-only update would move a caller to an
action whose input contract the caller cannot satisfy. Each entry names the
repository, the top-level `.github/workflows/` YAML file, the reason, the
review owner, and an RFC3339 expiry. The registry parser rejects malformed
entries, and the rewrite fails closed when an exception has expired. A
preserved file stays untouched and is listed in the run log and the repin
pull request body; the run summary records the count. An exception whose file
no longer exists is reported in the run log, so stale entries stay visible
until a reviewer removes them. The scheduled enrollment audit reports the
same staleness as operator-visible findings: an expired entry and an entry
whose protected file no longer exists on the audited default branch become
`expired-repin-exception` and `stale-repin-exception` findings in the drift
issue. Keep the rewrite behavior unchanged; the audit finding is the visible
report, and the rewrite failure is the safety gate.

A reviewed `repinCompanions` entry in `unity-enrollment-policy.json` names
one consumer file that derives its content from the pin, with one mechanical
rewrite mode. `pin-lines` applies the same `uses:` pin rewrite to every line
of the file. `pin-literal` replaces the pinned SHAs that this rewrite
removes, as standalone tokens only, so a SHA embedded in a longer hex
constant survives. When a rewrite removes no pin, a `pin-literal` companion
that names no target pin anywhere still carries a stale pin, and the rewrite
fails closed: it cannot tell a stale pin constant from a reviewed historical
witness, so an operator updates that file by hand. `policy-snapshot` mirrors
the reviewed `approved*Shas` lists exactly, the same content a consumer
snapshot refresh derives from the policy. The registry parser rejects a
malformed entry, and the rewrite accepts only the reviewed policy fields.
The rewrite lists each changed companion in the run log and the pull
request body. A companion whose file no longer exists is reported in both
places. That visibility comes from repin runs only; the enrollment audit
has no companion finding, so a stale entry in a repository that no longer
receives repin offers stays invisible until the next repin.

The workflow mints one installation token per run through the automation App
(`BUILD_LOCK_APP_*` credentials). Both Apps are installed org-wide by
operator decision; the token stays scoped to exactly the enrolled repository
list with Contents write, Pull requests write, and Workflows write
(workflow-file edits are refused without that permission). The reader App
never gains write. The automation never force-pushes, never edits a default
branch, and never uses a PAT. Each offer it opens enables auto-merge, so
GitHub merges only after the consumer's required checks and merge rules pass
(decision on #266, 2026-09-09). The request happens once at offer creation;
a later consumer disable is never undone. A refused request leaves the offer
open, keeps the run green, and adds one summary row, so the gap stays
operator-visible. The repository-level opt-out is the `Allow auto-merge`
setting.

## Credential and App boundary

The required steady-state boundary is:

- The writer App is installed only on
  `Ambiguous-Interactive/ambiguous-organization-build-lock` with Metadata read
  and Contents write. Acquire and release request a repository-restricted token.
- The reader App is installed only on the reviewed consumer inventory. It has
  Actions read, Contents read, Metadata read, organization self-hosted
  runners read, and Administration read. Each operation requests only the
  permissions and repositories it needs: preflight uses runner inventory,
  reaping uses Actions/Metadata, the central policy audit uses Contents, and
  the central merge-policy audit uses Administration read and Contents read
  (merge-policy attestations).
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
2. Before the licensed job references Unity credentials, it invokes the pinned
   central `ensure-unity-editor` action with a ten-minute timeout, the exact
   runner-owned `${{ runner.tool_cache }}\u6-v3` root, literal
   `ci-managed-only: true` and `require-healthy-existing: true`, and a closed
   provisioning profile. Missing or unhealthy editor state keeps the job red
   for manual host maintenance. CI must not install, download, repair, move,
   quarantine, or provision an editor. The central action carries the trusted
   validator and binds its successful diagnostics to the `editor-path` output;
   there is no separate `unity-helpers` checkout, bootstrap, or consumer
   diagnostics parser on the critical path. An approved immutable, exact-input
   current-head guard may run first; no other step may precede the editor gate.
   Workflow-, job-, and gate-level `env` mappings are absent so inherited values
   cannot preload the action's Node runtime. The profile is `EditorOnly`, or the
   reviewed static `matrix.test-mode` map selects
   `StandaloneWindowsIl2Cpp` only for `standalone`. The release must match the
   editor action's version; only a bounded static `matrix.unity-version` axis
   may supply both dynamically. The optional current-head guard, editor gate,
   and acquire omit `if` so each inherits the preceding step's successful
   status. Never use `always()` on this prefix: editor rejection must stop lock
   acquisition.

   The enrollment audit temporarily accepts the exact previously approved
   bootstrap/checkout/script prefix for unchanged consumers during rollout.
   Treat it as migration compatibility, not steady-state guidance, and replace
   it when advancing the consumer's central action pin.
3. The licensed job validates local credential shape and verifies that it is
   still the current trusted PR head before entering the organization FIFO.
4. Acquire records the exact repository, run, job, holder suffix, and physical
   runner identity.
5. Unity activation and work run only after acquire succeeds. Activation uses
   bounded retry for transient seat handoff.
6. Unity returns on the same physical identity. Only exact positive return
   evidence is `confirmed/healthy`. The measured `400006` seat-handoff
   signature with ULF proof and a completed command is also confirmed
   (issue #83); a `400006` without ULF proof stays unknown and quarantines.
7. Release always runs with the acquire identity and typed cleanup evidence.
   Waiting jobs are removed from the queue even when they never acquired.
   Invalid or contradictory evidence is degraded to unknown; under schema 4 or
   newer, any removed held capacity is quarantined. The release step fails only
   after exact ownership cleanup. After the release write, the release action
   also publishes the redacted `peer-timeline` output and a job-summary table
   with the peer holder, reservation, and incident events observed on the
   lock-state branch during this holder's session window.
8. The stable aggregate fails on preflight failure, cancellation, unexpected
   skip, partial matrix execution, missing return evidence, or failed release.

Automatic concurrency must not cancel a job after it can acquire. A superseded
run should exit before acquire; once acquired, it finishes activation, work,
return, and release. Manual cancellation remains fail-closed and may create a
runner quarantine.

### Session-phase casualty correlation

A licensed run that dies inside the editor with zero failed test cases is not
proof of a code failure. To tell an editor-session casualty from a real red
suite, read the run's release `peer-timeline` evidence:

- `status=ok` means the bounded replay saw the whole window without gaps and
  lists the peer holder acquires and returns it observed. Treat the list as
  best-effort evidence within those bounds, not as an absolute guarantee.
- `status=partial` means the replay was truncated or had gaps. Treat the
  window as unproven, not as proof of absence or presence.
- `status=unavailable` means the history could not be read. Same disposition.
- `status=not-applicable` means the run never held a session.

The evidence carries holder IDs, runner IDs, reason codes, and timestamps only.
It never contains logs. It is correlation evidence, not proof of cause.

## Operator quick reference

| State | Capacity effect | Required response |
| --- | --- | --- |
| Normal holder | One slot consumed | Let the owning run finish. Do not cancel it merely because a newer commit exists. |
| Confirmed-cleanup cooldown | One slot consumed until `availableAt` | Wait for expiry. At the live one-second setting this is normally transient. |
| Runner quarantine | One slot consumed without expiry | Reasons include `return-ulf-skipped`, `unity-return-400006` without ULF proof, `return-command-failed`, timeout, termination, incomplete logs, and missing positive evidence. A `400006` whose return log proves the ULF serial return with a completed command is confirmed cleanup and does not quarantine (issue #83). Prefer same-runner reclaim. Otherwise reconcile the Unity portal, then dispatch `recover` with the exact reservation ID and `resource-safe=true`. |
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
scheduled or manual reaper run. Only a fresh scheduled delivery can close a
stale alert; a manual dispatch or rerun can reap stale state, but cannot prove
scheduled delivery recovered. The issue contains run IDs, timestamps,
reason codes, and commit SHAs only. It synchronizes an alert when:

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
