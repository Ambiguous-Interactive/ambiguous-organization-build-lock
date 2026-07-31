<!-- summary: Safety invariants that every build-lock state transition must preserve. -->
# Build Lock Invariants

- State writes use compare-and-swap semantics; conflicts are retried from a
  newly validated snapshot.
- Admission never exceeds configured capacity and respects queued order.
- Every explicit acquire-loop delay, including normal polling, cooldown-aware
  polling, authentication grace, and CAS/verification retry, is capped by the
  remaining acquire deadline. Deadline cleanup still runs afterward so an exact
  queued identity is not abandoned.
- Holder and queue cleanup targets the caller's exact logical identity.
- A newer run attempt cannot be deleted by an older attempt.
- Schema versions newer than the client fail closed.
- Stale ownership is handled by the scheduled reaper, not opportunistic
  admission.
- Scheduled reaping evaluates and checkpoints capacity-critical ownership
  before routine queue cleanup. Its status reads and CAS reconciliation use
  internal deadlines shorter than the outer workflow timeout; unverified
  identities remain unchanged, while a partial safe checkpoint fails visibly.
- Job-level stale proof requires a recorded numeric Actions job ID bound to the
  exact run attempt and physical runner, an explicitly recognized job status,
  and CAS verification that the ID survived admission or backfill. Never infer
  a job from runner/API clock windows or names; missing, malformed, ambiguous,
  mismatched, or concurrently dropped evidence retains an active run.
- Invalid or contradictory cleanup diagnostics never veto exact ownership
  cleanup; degrade their evidence conservatively, preserve capacity as unsafe,
  and fail only after the cleanup attempt.
- Unconfirmed resource cleanup creates quarantine or an account-level block; it
  does not silently return capacity.
- Caller-local cleanup evidence and account-global incident evidence remain
  distinct. An unrelated active incident never rewrites the caller's cleanup
  report, while all new admission remains blocked until exact incident recovery.
- A final licensed-cleanup gate may be non-applicable only for exact
  `acquired=false`, with licensed work guarded by exact `acquired == 'true'`
  and acquisition failures allowed to propagate. Missing or invalid acquisition
  state remains fail-closed.
- Recovery requires the exact reservation or incident identity plus external
  evidence required by the public contract.
- Recovery diagnostics name the exact workflow path that accepts every
  instructed input, with a contract test binding emitted guidance to that
  workflow declaration.
- Recovery evidence may be published automatically only by a read-only path
  that proves the state it reports. Unprovable state never opens, edits, or
  closes a published alert, and publication never relaxes the exact identity
  and external proof that recovery requires.
- Pull-request admission remains bound to the event head while queued and
  immediately before licensed work.
- Diagnostics and outputs identify safe next actions without exposing secrets.

Use the current action tests and operational runbook for detailed schema and
result-code behavior; this file is an invariant map, not a duplicate contract.
