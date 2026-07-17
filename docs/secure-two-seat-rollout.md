# Secure Two-Seat Unity Rollout

This runbook is the deployment gate for the code in this repository. Keep
`maxHolders: 1` and `accountHealth: false` until every prerequisite below is
recorded in one restricted tracking issue. Never attach raw PEM files, serials,
logs, ZIP files, or credential values to the issue or repository.

## Evidence and containment

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

The rollout treats any activation outside the central lock, mismatched
activation/return identity, or unexplained portal seat as unsafe even when lock
state is internally consistent.

## Authorization cutover

The registered organization is `Ambiguous-Interactive`, owner ID `212056428`.
The lock repository is fixed to `ambiguous-organization-build-lock`, repository
ID `1244796436`. Any canonical repository context owned by the registered
organization may enroll; the protected writer credential is the actual
authorization boundary.

1. Release the schema-4-compatible authorization change at an immutable SHA.
2. Create the reader App with Metadata read, Actions read, and organization
   Self-hosted runners read, with no Contents access, and install it with
   all-repository access in the registered organization. This read-only
   installation makes future organization repositories reaper-visible and lets
   hosted preflights fail closed on runner outages without changing App scope.
3. Create a separate policy-reader App with only Contents read. Install it only
   on the exact enrolled consumer inventory, and expose its private key only as
   repository secrets on this central lock repository.
4. Verify compatibility while the writer App still has its old installation.
5. Restrict the writer App installation to only this lock repository, with
   Contents write. Rotate its key and update the organization writer secret
   exposed to enrolled repositories.
6. Prove the reaper's reader token cannot read contents and the writer
   token cannot access a consumer repository. Prove the policy-audit token can
   read only the six enrolled repositories. The unit suite verifies requested
   token scope; the tracking issue must record live negative API probes.

If the compatibility release lands before reader credentials are provisioned,
the reaper temporarily mints its consumer-only Actions/Metadata token from the
existing broad writer App. This fallback is valid only while that App remains
installed on the five original consumers. Provision and verify the dedicated reader App
before narrowing the writer installation; operator quarantine/incident recovery
does not require the reader because it never reads workflow-run status.

Repository-ID validation is defense in depth. In this GitHub-only design, the
shared writer App private key is the ultimate authorization boundary; a stolen
key can call GitHub without executing this action. Cryptographic caller identity
would require an OIDC broker.

## Consumer sequence

Migrate one repository at a time: unity-helpers, DxMessaging, DoxReloaded,
IshoBoy, qora-redux, then unity-builder. Do not start the next PR until the prior
PR is merged, reviewed at its exact SHA, green, and canaried.

Each repository must have a data-driven policy test enumerating every Unity
secret, GameCI use, and activation reference. Licensed jobs must use the
protected `unity-license` environment, immutable action SHAs, persistent
licensing home and machine identity across activation/return. Licensed jobs may
validate protected branches, controlled manual dispatches, and trusted
same-repository pull requests. Fork and Dependabot pull requests must never
receive the licensed environment or its credentials. Same-repository PR
validation requires no manual environment approval, so repository write access
is part of the credential trust boundary. Job-scoped Unity secrets and
custom-image/stock-return mismatches are prohibited.

The shared classifier contract is:

- exact positive return evidence: `confirmed/healthy`;
- `20111`: `unknown/blocked`, reason `unity-account-limit-20111`;
- `400006`, timeout, truncation, termination, or missing positive evidence:
  `unknown/healthy` with the matching runner-local reason;
- `20113`: `unknown/healthy`, reason `unity-20113-unclassified`, until sanitized
  production evidence establishes a stronger meaning.

## Schema 5 activation and rollback

Before activation, prove all enrolled consumers and the reaper are pinned to an
immutable schema-5-capable SHA and organization-wide search finds no schema-4-
only or mutable `@v1` consumer. Preserve that schema-5-capable release as the
rollback artifact; never run a schema-4-only client against schema 5.

Drain holders, queue entries, cooldowns, and quarantines. Merge a configuration-
only PR changing `accountHealth` to `true` while leaving `maxHolders` at 1. Run
normal return, cross-machine handoff, cancellation, hard-stop reaping, synthetic
`20111`, wrong-ID recovery rejection, exact-ID confirmed recovery, and one
successful canary from each consumer.

## Two-seat enablement

Only after the portal has zero unexplained activations, prove two distinct
machines activate concurrently under two holders, both return with their
activating identities, and a third machine succeeds after cooldown. Then merge
a configuration-only PR changing `maxHolders` from 1 to 2.

At capacity two, one runner quarantine leaves effective capacity one; two leave
zero. A global incident immediately leaves zero. Do not add an automatic
configuration rollback to one holder.

Monitor for seven days. Close the incident issues only with zero `20111`
events, zero unexplained activations, zero unsafe releases admitted as clean,
and zero unauthorized caller attempts.

## Organization audit

Use a one-time owner-authenticated collection without a permanent `admin:org`
PAT. Record sanitized principals, teams, outside/direct collaborators, service
and enterprise owners, 2FA and SAML/SCIM posture, dormant access, Apps, OAuth
Apps, PAT approvals, deploy/SSH keys, runner groups, environments, ruleset
bypasses, and secret names/scopes/update times (never values).

Verify owner recovery, then enable organization 2FA. Move every all-repository
App to selected repositories and least privilege or uninstall it,
while preserving Cursor Bugbot and Copilot on the review-loop repositories.
Stage rulesets in evaluate mode, validate required App bypasses, then enforce.
Only the writer App may bypass `lock-state`; administrators may not. Enable and
test secret scanning and push protection, including a Unity-serial pattern.
Repeat the principal audit quarterly and after membership, App, or secret-scope
changes.

## Review evidence

For every pushed SHA, record focused and full tests, Actions checks, exact-SHA
Cursor and Copilot requests/responses, unresolved thread inspection, fixes,
thread resolution, and the final zero-actionable-findings result. Silence or a
stale review is not consensus; retry once through the alternate supported
mechanism and record a bounded reviewer-unavailable timeout.
