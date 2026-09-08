#!/usr/bin/env bash
set -euo pipefail

# semantic-release skips commits whose subject is not conventional, so a
# stalled release train stays silent. Report the drift in the run summary.
# This is a diagnostic only: it never fails the run, because a week with no
# releasable change is a normal result.

summary_path="${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"

if ! last_tag="$(git describe --tags --abbrev=0 2>/dev/null)"; then
  echo "::error::No reachable release tag; cannot report commit convention drift." >&2
  exit 1
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
