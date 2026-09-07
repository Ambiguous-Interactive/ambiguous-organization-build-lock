---
name: github-cli-auth
description: Get a working GitHub CLI token without repeated credential modals. Use at session start when gh is not authenticated, before any gh or GitHub API call.
---

# GitHub CLI authentication

`gh` has no stored login in this environment. The only token source is the
VSCode credential helper. Every call to `git credential fill` opens a modal for
the user. Call it at most once per session, cache the token, and never call it
again.

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

The single `git credential fill` above opens one modal. If
`~/.config/gh/token` already exists (mode 0600), the cache is reused and no
modal opens.

## Rules

- Prefer an existing token in this order: `gh auth token` output, then the
  `~/.config/gh/token` cache, then one credential-helper fill to seed the
  cache.
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

## Scope limits of this token

`repo` scope covers all issue, pull request, check, and run commands against
the enrolled repositories. Commands that need organization endpoints (for
example listing all org repositories) may fail with 403; treat that as a scope
limit, not an auth bug.
