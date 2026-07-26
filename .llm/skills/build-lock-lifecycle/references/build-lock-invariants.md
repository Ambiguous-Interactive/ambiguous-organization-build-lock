<!-- summary: Safety invariants that every build-lock state transition must preserve. -->
# Build Lock Invariants

- State writes use compare-and-swap semantics; conflicts are retried from a
  newly validated snapshot.
- Admission never exceeds configured capacity and respects queued order.
- Holder and queue cleanup targets the caller's exact logical identity.
- A newer run attempt cannot be deleted by an older attempt.
- Schema versions newer than the client fail closed.
- Stale ownership is handled by the scheduled reaper, not opportunistic
  admission.
- Unconfirmed resource cleanup creates quarantine or an account-level block; it
  does not silently return capacity.
- Recovery requires the exact reservation or incident identity plus external
  evidence required by the public contract.
- Pull-request admission remains bound to the event head while queued and
  immediately before licensed work.
- Diagnostics and outputs identify safe next actions without exposing secrets.

Use the current action tests and operational runbook for detailed schema and
result-code behavior; this file is an invariant map, not a duplicate contract.
