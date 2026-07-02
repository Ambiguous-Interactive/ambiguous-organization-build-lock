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
