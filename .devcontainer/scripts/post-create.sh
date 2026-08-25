#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

retry 5 sudo apt-get update
retry 3 sudo env DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
  bat \
  direnv \
  fd-find \
  hyperfine \
  jq \
  make \
  man-db \
  procps \
  ripgrep \
  shellcheck \
  tree \
  xz-utils
sudo rm -rf /var/lib/apt/lists/*
sudo ln -sf /usr/bin/batcat /usr/local/bin/bat
sudo ln -sf /usr/bin/fdfind /usr/local/bin/fd

# ~/.cache itself must be user-owned: Docker creates the parent of a named
# volume mount point as root when the base image lacks it, which breaks every
# tool that writes under ~/.cache until it is fixed.
sudo install -d -o vscode -g vscode \
  /commandhistory \
  /go/pkg/mod \
  /home/vscode/.cache \
  /home/vscode/.cache/go-build \
  /home/vscode/.npm

for tool in /usr/local/go/bin/go /go/bin/*; do
  if [[ -x "${tool}" ]]; then
    sudo ln -sf "${tool}" "/usr/local/bin/$(basename "${tool}")"
  fi
done

history_line='export HISTFILE=/commandhistory/.zsh_history'
if ! grep -Fqx "${history_line}" /home/vscode/.zshrc; then
  printf '\n%s\n' "${history_line}" >> /home/vscode/.zshrc
fi

git config --global --replace-all safe.directory "${PWD}"
retry 5 go mod download
retry 5 go -C tools/actionlint mod download
bash tools/install-git-hooks.sh

touch /home/vscode/.ambiguous-build-lock-post-create.complete

printf '\n\033[1;35m  Ambiguous Build Lock workspace is ready ✨\033[0m\n'
printf '  Run \033[1;36m.devcontainer/scripts/verify.sh\033[0m for the full local CI loop.\n\n'
