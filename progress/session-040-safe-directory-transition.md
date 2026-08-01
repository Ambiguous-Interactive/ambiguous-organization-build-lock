# Session 040: Isolated checkout safe-directory transition

Date: 2026-08-01

## Selection and safety boundary

Issue #168 is the directly related highest-priority follow-up to draft PR #167.
The trusted Unity helper checkout intentionally uses `GIT_CONFIG_GLOBAL=/dev/null`
and `GIT_CONFIG_NOSYSTEM=1`; on Windows, `actions/checkout` otherwise attempts
to write `safe.directory` to the disabled global config and emits a caught
error annotation. The observed helper checkout, editor gate, credential
ordering, cleanup, and aggregate all passed, so this is a reliability defect,
not a provenance bypass.

The change preserves all five Git-isolation environment entries. The analyzer
now accepts either the existing five checkout inputs or the same closed input
set plus literal `set-safe-directory: false`. `true`, expressions, and extra
inputs fail closed. No organization credential, App, runner, ruleset, or secret
policy is changed.

## Red-green evidence

The new table-driven contract test proves:

- the literal-false transition remains enrollment-valid;
- `set-safe-directory: true` is rejected;
- an expression-valued input is rejected; and
- an unrelated additional checkout input is rejected.

Focused verification:

```text
go test ./internal/enrollment -run 'TestUnityEnrollment(RejectsCIEditorProvisioningMutations|CheckoutSafeDirectoryTransition)$' -count=1
passed
```

Consumer migration and the real hosted-Windows proof remain delivery gates
before tightening the central analyzer to require the literal input. The
existing issue #168 evidence and the PR timeline remain authoritative for that
rollout state.
