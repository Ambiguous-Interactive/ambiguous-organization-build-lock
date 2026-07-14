# Consumer Enrollment

Organization-owned repositories can enroll without changing or releasing the
lock action. The protected writer credential remains the authorization boundary.

## Repository setup

1. Confirm the dedicated reader GitHub App is installed with all-repository access
   in the registered organization. The App has only Actions read and Metadata read,
   so future organization repositories require no reader installation change.
2. Create a `unity-license` environment with no required reviewers or wait timer.
3. Store the writer App ID/private key and Unity credentials as environment
   secrets on `unity-license` in this repository. Do not use repository or
   organization secrets for these credentials: GitHub organization-secret
   selection limits repositories, not environments. The writer App itself stays
   installed only on `ambiguous-organization-build-lock` with Contents write.
4. Pin acquire and release actions to one reviewed immutable commit SHA.
5. Restrict licensed pull-request jobs to same-repository heads. Reject fork and
   Dependabot pull requests before the job can enter `unity-license`.
6. Keep Unity activation, tests/build, positive return evidence classification,
   and lock release in one job on one physical runner identity.

No environment approval is required for a trusted same-repository pull request.
Repository write access is therefore part of the credential trust boundary: a
writer can propose workflow code that receives the licensed environment's
secrets. Restrict write access to trusted principals, protect workflow changes
with CODEOWNERS/rulesets where available, and keep fork and Dependabot pull
requests outside the licensed job. Branch protection on the default branch does
not by itself protect secrets used by same-repository pull-request workflows.

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
