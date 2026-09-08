#!/usr/bin/env bash
set -euo pipefail

# semantic-release skips commits whose subject is not conventional, so a
# stalled release train stays silent. Report the drift in the run summary.
# This is a diagnostic only: it never fails the run and it stays out of the
# way when its own inputs are missing.

if [[ -z "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "::warning::GITHUB_STEP_SUMMARY is not set; skipping the commit convention report." >&2
  exit 0
fi
summary_path="${GITHUB_STEP_SUMMARY}"

# Name the newest semver release tag reachable from HEAD. The plain newest
# tag can be the moving v1 alias, which would label the report wrong.
last_tag="$(git tag --merged HEAD -l 'v*.*.*' --sort=-v:refname | head -n 1)"
if [[ -z "${last_tag}" ]]; then
  echo "::warning::No reachable release tag; skipping the commit convention report." >&2
  exit 0
fi

mapfile -t subjects < <(git log --format='%h %s' "${last_tag}..HEAD")
if [[ "${#subjects[@]}" == 0 ]]; then
  exit 0
fi

pattern='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: '
drift=()
for entry in "${subjects[@]}"; do
  subject="${entry#* }"
  if [[ ! "${subject}" =~ ${pattern} ]]; then
    drift+=("${entry}")
  fi
done

if [[ "${#drift[@]}" == 0 ]]; then
  exit 0
fi

{
  printf '### Release visibility warning\n\n'
  printf 'Commits after `%s` without a conventional subject. semantic-release skips them, so no release is published until a conventional `feat:` or `fix:` commit lands.\n\n' "${last_tag}"
  for subject in "${drift[@]}"; do
    printf -- '- `%s`\n' "${subject}"
  done
} >>"${summary_path}"
echo "::warning::${#drift[@]} commit(s) after ${last_tag} lack a conventional subject; semantic-release will not publish a release." >&2
