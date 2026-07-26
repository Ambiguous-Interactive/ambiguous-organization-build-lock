#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
git -C "${repo_root}" config --local core.hooksPath .githooks
echo "Configured this clone to use .githooks."
