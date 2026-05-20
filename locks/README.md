# Lock State

The lock actions create JSON state files on the `lock-state` branch.

Do not edit lock files by hand unless recovering from an outage. Prefer the
`Reap stale build locks` workflow, or remove a holder only after confirming the
referenced workflow run is no longer queued or in progress.
