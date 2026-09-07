---
name: github-cli-auth
description: Get a working GitHub CLI token without repeated credential modals. Use at session start when gh is not authenticated, before any gh or GitHub API call.
---

# GitHub CLI authentication

`gh` has no stored login in this environment. The only token source is the
VSCode credential helper. Every modal-free path depends on a token cache.

## Layers

1. `~/.config/gh/token` (mode 0600) holds the cached token.
2. The generic git credential helper is
   `~/.local/bin/git-credential-dispatch`. It serves `github.com` `get`
   requests from the cache and defers every other host and operation to the
   VSCode helper. While the cache exists, `git credential fill` for
   `github.com` resolves instantly and opens no modal, no matter which
   process calls it.
3. `gh` reads the cache through the `GH_TOKEN` environment variable; it does
   not read git credential helpers.

## Bootstrap (once per machine, zero modals afterwards)

```bash
mkdir -p ~/.config/gh && chmod 700 ~/.config/gh
[ -s ~/.config/gh/token ] || {
  printf 'protocol=https\nhost=github.com\n\n' |
    git credential fill | sed -n 's/^password=//p' > ~/.config/gh/token
  chmod 600 ~/.config/gh/token
}
export GH_TOKEN=$(cat ~/.config/gh/token)
```

The first seed on a fresh machine opens one modal. If the cache already
exists, the fill is answered by the dispatcher and no modal opens.

## Rules

- Check the cache before any credential work: `[ -s ~/.config/gh/token ]`.
  While the cache is valid, never run `git credential fill` in the session;
  the bootstrap step is the only fill.
- Export `GH_TOKEN` from the cache at session start. Do not call
  `git credential fill` per command; the dispatcher makes it safe, but the
  cache read is cheaper and has no helper dependency.
- Agent tool calls in this environment run in fresh shells: shell state does
  not carry between commands. Re-export `GH_TOKEN` from the cache in every
  command that needs it, or wrap `gh` in a script that reads the cache file.
  Never re-fill.
- Never put `git credential fill` inside a per-command wrapper script. That
  pattern turned one modal into one modal per `gh` call (2026-09-07). A
  wrapper may read the cache only; seeding stays a manual, once-per-machine
  step.
- Never run `git credential fill` twice in one session. Never run it inside a
  loop or a per-command export.
- Strip the `password=` prefix before use. Piping the raw line gives
  `gh` the literal text `password=...`, which fails with HTTP 401.
- Do not run `gh auth login --with-token`. The VSCode token has scopes
  `gist, repo, workflow` and lacks `read:org`, so login rejects it. The token
  works fine as `GH_TOKEN`; use the environment variable.
- `gh auth status` reports a `read:org` scope warning. It is expected and
  harmless; do not run `gh auth refresh`, which opens another modal.
- Never print the token, write it to the repository, or embed it in logs.
  Redirect the fill output only to the cache file.
- If the API returns 401, the cached token expired. Re-seed the cache with one
  credential-helper fill.
- On a devcontainer rebuild the devcontainer rewrites the credential helper
  line in `/etc/gitconfig`. A system-level helper runs before the global
  dispatcher, so every fill hits the VSCode helper first and opens a modal.
  Repair once with a scoped reset that bypasses the system helper only for
  `github.com`:

  ```bash
  git config --global --add credential.https://github.com.helper ""
  git config --global --add credential.https://github.com.helper \
    "$HOME/.local/bin/git-credential-dispatch"
  ```

  Verify the repair once with
  `printf 'protocol=https\nhost=github.com\n\n' | git credential fill >/dev/null`:
  it must return from the cache in milliseconds with no modal.

## Scope limits of this token

`repo` scope covers all issue, pull request, check, and run commands against
the enrolled repositories. Commands that need organization endpoints (for
example listing all org repositories) may fail with 403; treat that as a scope
limit, not an auth bug.
