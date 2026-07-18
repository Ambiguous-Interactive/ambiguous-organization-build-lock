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
- Published compatibility release: `v1.8.3` at
  `59a2fa98224569e5a697f271a3ac4b866c53ac2c`

The one-second cooldown is transitional. Issue #60 tracks publishing and
deploying allow-zero action code before changing the committed value to zero.
Until that sequence is complete, do not describe zero as live and do not change
the config independently of consumer compatibility.

Effective capacity is `maxHolders` minus active holders and
capacity-consuming reservations. A normal confirmed-cleanup cooldown consumes
one slot until it expires. A runner quarantine consumes one slot until
same-runner recovery or an exact-ID operator recovery. A global account
incident blocks all new admission regardless of nominal capacity.

## Enrolled consumers

The reviewed paid or lock-aware perimeter from `operations-facts.json` contains
six repositories:

- `Ambiguous-Interactive/DoxReloaded` <!-- enrolled-consumer -->
- `Ambiguous-Interactive/DxMessaging` <!-- enrolled-consumer -->
- `Ambiguous-Interactive/IshoBoy` <!-- enrolled-consumer -->
- `Ambiguous-Interactive/qora-redux` <!-- enrolled-consumer -->
- `Ambiguous-Interactive/unity-builder` <!-- enrolled-consumer -->
- `Ambiguous-Interactive/unity-helpers` <!-- enrolled-consumer -->

Enrollment changes are reviewed policy changes, not automatic consequences of
organization ownership. Follow [Consumer Enrollment](consumer-enrollment.md)
and update the continuous audit tracked by issue #42.

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

1. A hosted preflight proves that the repository can see an online runner with
   the required labels. Busy runners count as available infrastructure.
2. The licensed job validates local credential shape and verifies that it is
   still the current trusted PR head before entering the organization FIFO.
3. Acquire records the exact repository, run, job, holder suffix, and physical
   runner identity.
4. Unity activation and work run only after acquire succeeds. Activation uses
   bounded retry for transient seat handoff.
5. Unity returns on the same physical identity. Only exact positive return
   evidence is `confirmed/healthy`.
6. Release always runs with the acquire identity and typed cleanup evidence.
   Waiting jobs are removed from the queue even when they never acquired.
7. The stable aggregate fails on preflight failure, cancellation, unexpected
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
| Runner quarantine | One slot consumed without expiry | Prefer same-runner reclaim. Otherwise reconcile the Unity portal, then dispatch `recover` with the exact reservation ID and `resource-safe=true`. |
| Global account incident | All admission blocked | Stop canaries, reconcile every portal activation, then dispatch `recover-incident` with the exact incident ID and `portal-cleanup-confirmed=true`. |
| Waiting queue entry | No seat consumed, but a runner may be occupied | Let FIFO proceed. If the run terminates before acquire, release/fallback cleanup removes its exact queue entry. |
| Runner unavailable | Licensed work must remain pending or red | Restore eligible runner capacity. Never turn an unavailable required job into skip/green. |

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
