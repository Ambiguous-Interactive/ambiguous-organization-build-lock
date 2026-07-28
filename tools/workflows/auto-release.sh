#!/usr/bin/env bash
set -euo pipefail

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git tag -fa v1 -m "Update v1 alias to v${RELEASE_VERSION:?RELEASE_VERSION is required}"
git push --force origin refs/tags/v1:refs/tags/v1
