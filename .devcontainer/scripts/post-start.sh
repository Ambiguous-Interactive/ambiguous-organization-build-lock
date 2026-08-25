#!/usr/bin/env bash
set -euo pipefail

# DDorch.codium-devcontainer executes postCreateCommand while building, before
# the workspace exists. Run the workspace-dependent half after its bind mount
# is available. Standards-compatible clients have already created the marker.
git config --global --replace-all safe.directory "${PWD}"
# Docker creates named-volume mount points as root when the base image lacks
# the directory. Normalize ownership on every start so caches stay writable by
# the unprivileged remote user even before post-create has ever succeeded.
sudo install -d -o vscode -g vscode \
  /commandhistory \
  /go/pkg/mod \
  /home/vscode/.cache \
  /home/vscode/.cache/go-build \
  /home/vscode/.npm
if [[ ! -f /home/vscode/.ambiguous-build-lock-post-create.complete ]]; then
  bash .devcontainer/scripts/post-create.sh
fi

bash .devcontainer/scripts/install-agent-clis.sh
