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
now requires the same closed input set plus literal `set-safe-directory: false`.
Omission, `true`, expressions, and extra inputs fail closed. No organization
credential, App, runner, ruleset, or secret policy is changed.

## Red-green evidence

The new table-driven contract test proves:

- literal `set-safe-directory: false` remains enrollment-valid;
- omission is rejected;
- `set-safe-directory: true` is rejected;
- an expression-valued input is rejected; and
- an unrelated additional checkout input is rejected.

Focused verification:

```text
go test ./internal/enrollment -run 'TestUnityEnrollment(RejectsCIEditorProvisioningMutations|CheckoutSafeDirectoryTransition)$' -count=1
passed
```

Consumer migration and the real hosted-Windows proof were delivery gates before
tightening the central analyzer. The existing issue #168 evidence and the PR
timeline remain authoritative for that rollout state.

The migration has now been published on the active consumer surfaces without
changing organization policy or credentials:

- IshoBoy #338, one trusted checkout input plus its exact contract assertion;
- qora-redux #201, one trusted checkout input plus its exact contract assertion;
- DoxReloaded #305, one trusted checkout input and validator fixes for the
  intentional editor-gate version literals. It merged at `7b7760c2` after
  exact-head run #30697864858 passed static validation, EditMode and PlayMode
  XML validation, WebGL and Windows builds, artifact uploads, the typed
  aggregate (`static-validation=success` and every licensed outcome
  `success`), license return, healthy cleanup classification, lock release,
  and confirmed cleanup. RCA issue #314 records the original WebGL stall and
  the fail-closed watchdog/result-gate remediation.

The DoxReloaded investigation also exposed a second organization-wide gate
requirement: an `always()` aggregate must consume the static-validation result,
not merely list the job in `needs`. Central commit
`df3ebdd070ee55d8c924127ad347053335aa46a9` adds the required typed input and
an explicit failure when static validation is not `success`; the analyzer and
contract tests require the aggregate to pass `needs.static-validation.result`.

All three remain subject to their real Unity/Windows and repository checks;
each is treated as migrated evidence only after its exact-head checks passed and
the reviewed PR merged.
