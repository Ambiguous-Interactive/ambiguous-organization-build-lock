<!-- summary: Obtain GitHub API auth in this devcontainer from the VSCode GitHub session through the git askpass path; never prompt, print, or store the token. -->
# Task: GitHub API auth from the VSCode GitHub connector

## Acceptance criteria
- Agents obtain GitHub API credentials for `gh` and API calls from the
  VSCode GitHub session that already exists in this devcontainer.
- No interactive prompt, no browser flow, and no token printed or stored.
- The repo's credential audit and progress records stay free of secrets.

## Baseline
- Command: `gh auth status`
- Observed result: not logged in. No `GH_TOKEN` in the environment and no
  token in VSCode global storage.
- Reproduction status: reproduced on every fresh shell in this container.

## Hypothesis
- Claim: VSCode injects `GIT_ASKPASS` plus `VSCODE_GIT_IPC_HANDLE`, and its
  askpass answers GitHub credential prompts from the signed-in GitHub
  connector session. The Dev Containers credential helper configured under
  `credential.helper` is a different path and hangs for github.com.
- Disconfirming evidence: askpass returns no password or the helper is the
  only working path.
- Falsified hypotheses: the Dev Containers IPC helper
  (`/tmp/vscode-remote-containers-*.js git-credential-helper get`) is a
  working credential source for github.com; it timed out (exit 124) on
  repeated attempts, so it is not used.

## Green
- Minimal change: read the credential through the askpass-backed fill and
  export it for the current command only:

  ```bash
  export GH_TOKEN=$(printf "protocol=https\nhost=github.com\n\n" \
    | git -c credential.helper= credential fill \
    | sed -n 's/^password=//p')
  ```

  `-c credential.helper=` bypasses the hanging Dev Containers helper so the
  askpass path answers. Scope the export to the command that needs it.
- Focused result: `gh auth status` reported the signed-in account with
  `repo` and `workflow` scopes, and `gh pr create` succeeded (PR #225).

## Full validation
- `gh pr create` with the exported token opened PR #225 against `main`.
- `gh auth status` listed the expected scopes: `read:user`, `repo`,
  `user:email`, `workflow`.
- No token value appears in this record, command history of the record, or
  repository output.

## Adversarial review
- Unsafe success paths considered: echoing the token in tool output, writing
  it to a file, or persisting it in shell state across sessions.
- Intent-to-diff status: the command reads the token into a shell variable
  and pipes only masked metadata onward.
- Unverifiable items and open questions: token lifetime is the VSCode
  session's lifetime; a fresh sign-in by the user renews it.
- Remaining uncertainty: none observed within this container.
- Implementer: primary agent.
- Reviewer and evidence: session 067 progress record; PR #225 creation.
- Actionable findings: none.
- Remediator and dispositions: not applicable.
- Latest review round outcome: clean.
- Main-thread fallback reason (if applicable): not applicable.

## Knowledge retention
- Trigger or exemption: recurring environment friction for every session
  that needs `gh` or the GitHub API.
- Evidence: baseline failures, repeated helper timeouts, successful fill and
  PR creation.
- Observed facts, inferences, and open questions: the askpass bridge is the
  only responsive auth path found in this container.
- Root cause or reusable insight: two VSCode credential bridges exist; the
  Dev Containers helper hangs for github.com while the git askpass path
  answers from the GitHub connector session.
- Promotion decision: promote.
- Destination or rationale: this task record; it is the narrowest
  authoritative home for devcontainer environment behavior.
- Independent review outcome: clean main-thread separated pass.
