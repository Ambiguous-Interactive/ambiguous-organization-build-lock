# Consumer Enrollment

Organization-owned repositories can enroll without changing or releasing the
lock action. The protected writer credential remains the authorization boundary.

## Repository setup

1. Confirm the reader GitHub App is installed only on the exact active consumer
   inventory. The App has Actions read, Contents read, Metadata read, and
   organization Self-hosted runners read. Each operation mints a token with only
   the subset it needs.
2. Confirm the organization-level writer, reader, and Unity secrets are visible
   to the repository. Do not add per-repository environments or approval gates.
   The writer App itself stays installed only on
   `ambiguous-organization-build-lock` with Contents write.
3. Treat the shared reader private key as a cross-repository read boundary.
   Restrict organization-secret visibility to the active trusted consumers and
   this central repository; do not make it organization-wide.
4. Pin acquire and release actions to one reviewed immutable commit SHA.
5. Restrict licensed pull-request jobs to same-repository heads. Reject fork and
   Dependabot pull requests before the job can enter `unity-license`.
6. Keep Unity activation, tests/build, positive return evidence classification,
   and lock release in one job on one physical runner identity.
7. Add a hosted `runner-preflight` job using
   `check-unity-runner-availability`. The action filters runner groups by the
   calling repository before checking online runners, so an online runner that
   the repository cannot use does not pass the preflight. Make every licensed
   self-hosted job depend on it, and add an always-reporting required aggregate.
   The aggregate must reject a failed/cancelled preflight and any unexpected
   skipped licensed job.

No environment approval is required for a trusted same-repository pull request.
Repository write access is therefore part of the credential trust boundary: a
writer can propose workflow code that receives organization secrets. Restrict
write access to trusted principals, protect workflow changes with
CODEOWNERS/rulesets where available, and keep fork and Dependabot pull requests
outside the licensed job. Branch protection on the default branch does not by
itself protect secrets used by same-repository pull-request workflows.

## Canary

Before making the Unity check required or raising lock capacity:

1. Open a same-repository pull request and confirm the licensed job starts without
   an environment approval prompt.
2. Confirm acquire reports the expected repository, run, attempt, and runner.
3. Confirm Unity produces test/build results.
4. Confirm return classification reports `cleanup-confirmed`.
5. Confirm release enters cooldown, with no holder, quarantine, or global incident.
6. Confirm a fork pull request skips the licensed job and receives no credentials.
7. Confirm the scheduled reaper can read the new repository's workflow-run status.

If credential validation fails, update the `unity-license` environment secrets
in that repository. If reaper lookup fails, verify the dedicated reader secrets
exist on the lock repository and that its all-repository installation includes
the repository; do not broaden the contents-writing App. Never copy credential
values into repository files or diagnostic output.
