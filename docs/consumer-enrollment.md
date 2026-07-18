# Consumer Enrollment

Enrollment is a reviewed policy and credential-scope change. Organization
ownership alone does not authorize a repository to use the Unity credentials
or writer App. The current inventory is recorded in
[Unity Build Lock Operations](operations-runbook.md).

## Preconditions

1. Audit every workflow, reusable workflow, and repository-local composite
   action in the candidate repository. Classify paid activation, synthetic
   fixtures, intentionally disabled/manual paths, and static references.
2. Require an eligible trusted trigger: same-repository PR, protected default
   branch, or controlled dispatch. Fork and Dependabot PRs must remain
   unlicensed because organization secrets are unavailable.
3. Add the candidate to the reviewed central consumer registry and continuous
   audit. That audit must read the exact default-branch commit and fail closed
   on incomplete retrieval.
4. Add the repository to the reader App's selected-repository installation.
   The App has Actions read, Contents read, Metadata read, and organization
   self-hosted runners read. Do not grant write permission.
5. Add the repository to selected-repository visibility for only the writer,
   reader, and Unity organization secrets it needs. The writer App itself
   remains installed only on
   `Ambiguous-Interactive/ambiguous-organization-build-lock` with Metadata read
   and Contents write.
6. Protect workflow changes with CODEOWNERS or rulesets and restrict write
   access to trusted principals. Trusted PR jobs do not use approval-only
   environments.

## Workflow contract

1. Pin every remote action, including transitive local-composite leaves, to a
   reviewed 40-character commit SHA.
2. Run `check-unity-runner-availability` in a hosted preflight before every
   licensed self-hosted job. Make the licensed job depend on the preflight.
3. Validate local Unity secret shape, then check that a PR run is still the
   current head immediately before expensive setup and again before acquire.
4. Acquire immediately before the activation-capable section. Pass a stable,
   non-empty `runner.name` and set lifecycle downgrade guards compatible with
   the committed live configuration.
5. Keep activation, tests/build, positive return-evidence classification, and
   release in one job on one physical runner identity. Use bounded activation
   retry for transient seat handoff.
6. Run return and typed release under `always()`. Only exact positive return
   evidence is `confirmed/healthy`; exit zero or a missing serial is not proof.
7. Preserve fallback cleanup for runner loss. It must target the exact acquire
   identity and fail closed to quarantine when positive return cannot be
   proven.
8. Emit one stable, always-reporting aggregate. It fails on preflight failure,
   cancellation, unexpected skip, missing matrix output, partial execution,
   missing cleanup evidence, or release failure.
9. Disable automatic cancellation for every scope that can terminate a job
   after acquire. Superseded runs exit before acquire; holders finish cleanup.

## Canary

Before enforcing the aggregate as required:

1. Open a same-repository PR and confirm the licensed job starts without an
   approval prompt.
2. Confirm preflight can see the intended online runner labels.
3. Confirm acquire records the expected repository, run, job, attempt, and
   physical runner.
4. Confirm Unity produces the intended test or build result.
5. Confirm return is `confirmed/healthy` and release removes ownership. At the
   current nonzero setting a short confirmed-cleanup cooldown is expected.
6. Confirm no holder, quarantine, or global incident remains after normal
   cleanup and cooldown expiry.
7. Confirm a fork PR receives no organization credentials and follows the
   explicit unlicensed aggregate policy.
8. Confirm the reaper can read the repository's workflow-run status and the
   policy audit can read its exact workflow commit.
9. Confirm the exact aggregate context and issuing App in the repository
   ruleset before enforcing it.

If any probe fails, narrow the diagnosis to App installation, selected-secret
visibility, runner-group visibility, immutable pins, or workflow policy. Do not
broaden either App or organization secrets as a diagnostic shortcut, and never
copy credential values into source, logs, artifacts, or comments.
