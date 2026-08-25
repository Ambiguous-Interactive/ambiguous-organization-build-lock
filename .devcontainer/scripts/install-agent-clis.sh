#!/usr/bin/env bash
set -euo pipefail

# Keep global npm packages writable by the unprivileged remote user. npm picks
# each package's native Linux binary for the container architecture.
npm_prefix="${HOME}/.local"
install -d "${npm_prefix}/bin"
export PATH="${npm_prefix}/bin:${PATH}"

# remoteEnv covers standards-based clients. Persist the same path for the
# reduced SSH launcher, which intentionally ignores that Dev Container field.
# shellcheck disable=SC2016 # Keep HOME and PATH dynamic in future shells.
path_line='export PATH="${HOME}/.local/bin:${PATH}"'
touch "${HOME}/.zshrc"
if ! grep -Fqx "${path_line}" "${HOME}/.zshrc"; then
  printf '\n%s\n' "${path_line}" >> "${HOME}/.zshrc"
fi

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

retry 5 npm install --global --prefix "${npm_prefix}" --no-audit --no-fund \
  @openai/codex@latest \
  opencode-ai@latest

command -v codex >/dev/null
command -v opencode >/dev/null
codex --version
opencode --version
