# Historical Secure Two-Seat Unity Rollout

> [!WARNING]
> This is a historical record of the migration and incident response. It is not
> an operator runbook. Current values and recovery procedures are in
> [Unity Build Lock Operations](operations-runbook.md).

This record preserves why the schema-5 two-seat design exists. Never attach raw
PEM files, serials, logs, ZIP files, or credential values to an issue or this
repository.

## Evidence and containment

- Disable every Unity-capable DepartmentOfArrangements workflow, including its
  credential watch, Unity CI, and WebGL jobs. Freeze all licensed canaries.
- Before rotation, account for every in-flight holder and allow its exact
  activation identity to return the license.
- Preserve sanitized event/run metadata, artifact hashes, machine IDs, App
  events, and lock-state history. Classify each assertion as confirmed, likely,
  disproved, or unavailable.
- Search all refs, retained logs, artifacts, and release assets for the old
  serial and safe transformations. Record only counts, locations, and hashes;
  never print matching content.
- In the Unity portal, clear unexplained activations and record a zero-unexplained
  baseline. Do not claim an exact exfiltration path without direct evidence.

The confirmed root cause for this rollout is untracked activation capacity:
DepartmentOfArrangements activated outside the central lock; its credential
watch did not return a randomized machine identity; and other jobs attempted
return from a different stock image. Those activations exhausted two seats while
the lock state remained internally consistent.

## Historical authorization cutover

The registered organization is `Ambiguous-Interactive`, owner ID `212056428`.
The lock repository is fixed to `ambiguous-organization-build-lock`, repository
ID `1244796436`. Any canonical repository context owned by the registered
organization may enroll; the protected writer credential is the actual
authorization boundary.

The rollout first introduced a reader/writer split while the legacy App
installation remained broad, then restricted the writer App to this lock
repository. The initial reader design omitted Contents permission and used
all-repository installation. Later policy-audit requirements added Contents
read and changed the intended steady-state installation to the reviewed
consumer set. The compatibility fallback from reader operations to the broad
writer App remains code history, not the current credential boundary.

Repository-ID validation is defense in depth. In this GitHub-only design, the
shared writer App private key is the ultimate authorization boundary; a stolen
key can call GitHub without executing this action. Cryptographic caller identity
would require an OIDC broker.

## Historical consumer sequence

The first sequence migrated unity-helpers, DepartmentOfArrangements,
DxMessaging, DoxReloaded, and IshoBoy one repository at a time. Subsequent
incident work removed DepartmentOfArrangements from the active perimeter and
enrolled qora-redux and the controlled unity-builder fork. The current six-item
inventory is maintained in the operations runbook.

The original protected-environment design was replaced by selected-repository
organization secrets without manual PR approval. Persistent licensing home and
machine identity, immutable action pins, exact return evidence, and fork-secret
isolation remained safety requirements.

The shared classifier contract is:

- exact positive return evidence: `confirmed/healthy`;
- `20111`: `unknown/blocked`, reason `unity-account-limit-20111`;
- `400006`, timeout, truncation, termination, or missing positive evidence:
  `unknown/healthy` with the matching runner-local reason;
- `20113`: `unknown/healthy`, reason `unity-20113-unclassified`, until sanitized
  production evidence establishes a stronger meaning.

## Historical schema 5 activation

Before activation, the rollout proved all enrolled consumers and the reaper
were pinned to an immutable schema-5-capable SHA and found no active mutable
consumer reference. The compatible release was preserved as a rollback
artifact.

Activation drained holders, queue entries, cooldowns, and quarantines before
enabling account health at capacity one. The rollout exercised normal return,
cross-machine handoff, cancellation containment, exact-ID recovery rejection,
and exact-ID portal-confirmed recovery before raising capacity.

## Historical two-seat enablement

The portal baseline was reconciled before two distinct machines proved two
concurrent holders. Capacity then moved from one to two. Later work deployed
bounded activation retry and reduced confirmed-cleanup cooldown from 360
seconds to the current transitional value; literal zero remains tracked
separately.

The migration established the enduring capacity rule: one runner quarantine
reduces effective capacity by one, two consume both seats, and a global
incident blocks admission.

The post-activation monitoring gate was recorded in issues #27 and #29.

## Historical organization-audit scope

Use a one-time owner-authenticated collection without a permanent `admin:org`
PAT. Record sanitized principals, teams, outside/direct collaborators, service
and enterprise owners, 2FA and SAML/SCIM posture, dormant access, Apps, OAuth
Apps, PAT approvals, deploy/SSH keys, runner groups, environments, ruleset
bypasses, and secret names/scopes/update times (never values).

The rollout identified follow-up work for owner recovery, 2FA, App and secret
scope, rulesets, bypass actors, secret scanning, and quarterly principal
reviews. These are tracked work items rather than instructions to infer from
this historical snapshot.

## Review evidence

For every pushed SHA, record focused and full tests, Actions checks, exact-SHA
Cursor and Copilot requests/responses, unresolved thread inspection, fixes,
thread resolution, and the final zero-actionable-findings result. Silence or a
stale review is not consensus; retry once through the alternate supported
mechanism and record a bounded reviewer-unavailable timeout.
