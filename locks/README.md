# Lock State

The lock actions create JSON state files on the `lock-state` branch.

Never edit or delete lock files by hand. Use the `Reap stale build locks`
workflow for reaping and exact-ID recovery. A runner quarantine requires Unity
portal cleanup proof plus its exact reservation ID; a global incident requires
portal reconciliation plus its exact incident ID.

## Lock Config

`<lock-name>.config.json` files in this directory (on the default branch) set
per-lock parallelism: `{ "maxHolders": N }` with N between 1 and 64. A missing
or invalid config fails closed to a single holder. Changes go through normal
pull-request review and are picked up by waiting runs within the config TTL
(default 5 minutes).

`runnerSerialization: true` activates the one-way schema-3 upgrade and limits
each physical `runner-id` to one holder. Enable it only after compatible clients
are deployed and the schema-2 holder and queue lists are empty.

`resourceLifecycle: true` activates the one-way schema-4 upgrade after schema 3
holders and queue entries drain. Schema 4 adds capacity-consuming cooldown and
quarantine reservations. `releaseCooldownSeconds` accepts 0 through 86400 and
defaults to 360 when absent; the live value is read from
`wallstop-organization-builds.config.json`. A zero value omits a reservation
only after confirmed resource-safe cleanup. Unknown cleanup always creates a
non-expiring quarantine. Configuration failure cannot downgrade an existing
schema-4 state.

`accountHealth: true` activates the one-way schema-5 upgrade after schema 4 is
fully drained, including holders, queue entries, cooldowns, and quarantines.
Schema 5 is active for the live lock. It stores at most one immutable global
account incident. A global incident blocks admission without growing the queue
and never expires. Recovery requires the exact incident ID and explicit Unity
portal cleanup proof, then applies the configured confirmed-cleanup cooldown.

## Live lock

`wallstop-organization-builds.config.json` is the reviewed source of truth for
capacity, serialization, lifecycle, account health, and cooldown. The
steady-state interpretation and operator response table are in
[Unity Build Lock Operations](../docs/operations-runbook.md).
