# Unity 20111 Incident Outcomes, 2026-07-29

<!-- summary: Four historical 20111 latches do not establish a safe automatic-recovery signature; retain exact-ID portal-confirmed recovery. -->

## Question

Can the organization automatically recover a schema-5
`unity-account-limit-20111` incident because historical incidents are proven
false positives?

## Scope and evidence boundary

This investigation covers every revision of
`locks/wallstop-organization-builds.json` on `origin/lock-state` through
`b90fafdff12a47a968765ea0793a632d68af4c8f`. The bounded history search was:

```bash
git log origin/lock-state -S'unity-account-limit-20111' -- \
  locks/wallstop-organization-builds.json
```

The search found four latch commits and four corresponding exact-ID recovery
commits. Source and recovery workflow metadata came from the GitHub Actions API.
Public issue comments were searched by exact incident ID and source run ID.
No raw Unity log, credential, serial, evidence digest, or current lock state is
retained here.

A successful recovery workflow proves that an operator supplied the exact
incident ID and asserted portal cleanup. It does **not** independently prove
whether a portal activation was outstanding when the incident latched.

## Sanitized dataset

| Reported UTC | Source run | Runner | Incident | Recovery run | Classification | Independent outcome evidence |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-07-19 16:35:35 | `qora-redux` `29694913080` | `DAD-MACHINE` | `incident-08d2ae36d87d05ac56c5b448` | lock `29696967498` | `unprovable` | The exact-ID recovery succeeded, but no incident-specific portal observation says whether a seat was outstanding at latch time. |
| 2026-07-25 21:49:03 | `qora-redux` `30176078855` | `DAD-MACHINE` | `incident-6c6949faa4e68be6bbb24679` | lock `30178591670` | `unprovable` | `qora-redux#131` attributed the event to a sibling quarantine, then inferred a leaked activation from the later recovery. The recovery attestation is not an independent observation at latch time, and later replicated evidence in lock #83 shows that this quarantine reason can occur after a peer already returned the shared entitlement. |
| 2026-07-28 01:51:57 | `qora-redux` `30321246597` | `ELI-MACHINE` | `incident-00aa68fb286067fe80d87fa3` | lock `30324786797` | `unprovable` | The repository owner stated on lock #121 that manual recovery was required and “there was no seat leak.” This is a direct operator observation, but it does not record an incident-specific portal observation at latch time. |
| 2026-07-29 00:32:57 | `qora-redux` `30411127274` | `DAD-MACHINE` | `incident-02cd8469d5ad53d2bc56d280` | lock `30413132226` | `unprovable` | The exact-ID recovery succeeded. The later general report in lock #132 says incidents have not reflected leaks, but it does not identify this incident or record a contemporaneous portal observation. |

The source workflow differed across the window: the first two records contain
separate EditMode and PlayMode jobs, while the last two use one combined
`Unity EditMode + PlayMode` job. All four latches came from `qora-redux`, but
that does not establish that repository as the cause: the account is shared
across repositories and 20111 reports the caller that observed exhaustion.

## Measured result

- Population: 4 historical latches.
- Independently classified false positive: 0.
- Independently classified real leak: 0.
- Unprovable: 4.
- Proven false-positive lower bound: 0%.
- Possible false-positive range given the missing outcomes: 0% through 100%.

A false-positive **rate cannot be established**. Treating the operator's
statement as an independently verified portal outcome would overstate the
evidence. Likewise, zero proven real leaks is not proof that real leaks cannot
occur.

## Probe analysis

The supported Editor command-line surface exposes activation and return
operations, not a read-only account-seat query. Unity documents `-serial` as
activating a license and `-returnlicense` as returning the currently active
license. An activation attempt therefore consumes or competes for the same
resource it would be asked to measure.

This creates an unsafe ambiguity:

1. If a leaked activation exists, probing with another activation can exhaust
   or exceed the licensed capacity.
2. If the probe receives 20111, it does not establish whether a leaked
   activation exists.
3. If the probe succeeds, its own activation must be returned with the same
   physical identity and positive cleanup evidence before it says anything
   useful about capacity.
4. Runner loss, return ambiguity, or concurrent legitimate work turns the probe
   into another incident source.

No documented, supported, read-only Unity seat-availability API was identified.
Absence from the reviewed documentation is an evidence boundary, not proof
that no private or future API can exist.

## Decision

Retain the permanent schema-5 latch and exact-ID, portal-confirmed manual
recovery. Do not auto-expire, downgrade, “recover all,” or activation-probe a
20111 incident.

This is a safety decision under uncertainty, not a claim that every 20111 is a
real leak. Operator cost should be reduced through read-only incident
visibility, which is already delivered by the incident recovery audit, while
admission remains blocked until external reconciliation.

Revisit this decision only when one of these evidence upgrades exists:

- incident-specific portal occupancy captured at latch time for a representative
  sample;
- a supported read-only Unity API that reports account-seat occupancy without
  activation;
- distinct 20111 subcodes or evidence shapes with independently measured
  outcomes; or
- independently returnable license identities that remove the shared-account
  ambiguity.

## Sources

- Git history: `origin/lock-state`,
  `locks/wallstop-organization-builds.json`.
- GitHub Actions metadata for source and recovery runs named in the table.
- Public issue evidence: lock #73, lock #83, lock #121, lock #132,
  `qora-redux#131`, and `IshoBoy#300`.
- Unity Manual,
  [Unity Editor command line arguments reference](https://docs.unity3d.com/6000.0/Documentation/Manual/EditorCommandLineArguments.html)
  and
  [Manage a license from the command line](https://docs.unity3d.com/6000.0/Documentation/Manual/ManagingYourUnityLicense.html),
  reviewed 2026-07-29.
