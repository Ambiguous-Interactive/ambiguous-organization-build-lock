#!/usr/bin/env bash
set -euo pipefail

# DDorch.codium-devcontainer executes postCreateCommand while building, before
# the workspace exists. Run the workspace-dependent half after its bind mount
# is available. Standards-compatible clients have already created the marker.
git config --global --replace-all safe.directory "${PWD}"
if [[ ! -f /home/vscode/.ambiguous-build-lock-post-create.complete ]]; then
  bash .devcontainer/scripts/post-create.sh
fi
