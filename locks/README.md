# Lock State

The lock actions create JSON state files on the `lock-state` branch.

Do not edit lock files by hand unless recovering from an outage. Prefer the
`Reap stale build locks` workflow, or remove a holder only after confirming the
referenced workflow run is no longer queued or in progress.

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
quarantine reservations. `releaseCooldownSeconds` controls confirmed-cleanup
cooldowns and defaults to 360 seconds. Configuration failure cannot downgrade an
existing schema-4 state. Keep lifecycle disabled until every consumer reports
explicit cleanup proof to the release action.

`accountHealth: true` activates the one-way schema-5 upgrade after schema 4 is
fully drained, including holders, queue entries, cooldowns, and quarantines.
Schema 5 stores at most one immutable global account incident. A global incident
blocks admission without growing the queue and never expires. Keep account
health disabled until every consumer and the reaper is pinned to a reviewed,
schema-5-capable immutable SHA. Recovery requires the exact incident ID and
explicit Unity portal cleanup proof, then starts the normal cooldown.
