---
name: build-lock-lifecycle
description: Preserve build-lock state and safety invariants. Use when changing acquire, release, queues, schemas, quarantine, cooldown, reaping, or account incidents.
---
# Build Lock Lifecycle

Read [the invariant reference](references/build-lock-invariants.md) before
changing lock behavior.

## Change checklist

- Trace read, validation, compare-and-swap write, retry, and cleanup paths.
- Preserve exact holder identity and run-attempt fencing.
- Keep FIFO behavior and maximum-holder enforcement atomic with state updates.
- Treat newer schemas, malformed configuration, uncertain cleanup, and
  unverifiable pull-request identity as fail-closed.
- Check both fresh state and every supported migration path.
- Keep action outputs and `cleanup-result` / `admission-result` values stable
  unless the public contract intentionally changes.
- Add focused tests for success, stale reads, retries, ambiguous failure, and
  exact ownership boundaries.

Changes to lifecycle semantics commonly require synchronized updates to action
manifests, README state documentation, the operations runbook, and lock facts.
