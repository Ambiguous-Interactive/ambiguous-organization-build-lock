#!/usr/bin/env bash
set -euo pipefail

# The workflow calls this only after semantic-release publishes no release.
# This diagnostic must never fail the release run, even if Git or output fails.
trap 'echo "::warning::Commit convention report could not complete; release processing continues." >&2; exit 0' ERR
if [[ -z "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "::warning::GITHUB_STEP_SUMMARY is not set; skipping the commit convention report." >&2
  exit 0
fi
summary_path="${GITHUB_STEP_SUMMARY}"

# Ignore the moving v1 alias. Read the full list to avoid pipefail with head.
tags="$(git tag --merged HEAD -l 'v*.*.*' --sort=-v:refname)"
last_tag="${tags%%$'\n'*}"
if [[ -z "${last_tag}" ]]; then
  echo "::warning::No reachable release tag; skipping the commit convention report." >&2
  exit 0
fi

# Capture Git failure before reading the subjects, rather than hiding it in
# process substitution. Git subjects contain no record-separating newlines.
log_output="$(git log --format='%h %s' "${last_tag}..HEAD")"
if [[ -z "${log_output}" ]]; then
  exit 0
fi
mapfile -t subjects <<<"${log_output}"
conventional_pattern='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: '
type_pattern='^([a-zA-Z0-9_]+)(\(.*\))?!?: '
drift=()
types=()
for entry in "${subjects[@]}"; do
  subject="${entry#* }"
  if [[ ! "${subject}" =~ ${conventional_pattern} ]]; then
    drift+=("${entry}")
  fi
  if [[ "${subject}" =~ ${type_pattern} ]]; then
    types+=("${BASH_REMATCH[1]}")
  else
    types+=("unparsed")
  fi
done
found_types="$(printf '%s\n' "${types[@]}" | LC_ALL=C sort -u | paste -sd ',' -)"
found_types="${found_types//,/, }"
{
  printf '### Release visibility warning\n\n'
  printf 'Unreleased commits after `%s`: %s. Types found: %s.\n\n' "${last_tag}" "${#subjects[@]}" "${found_types}"
  printf 'semantic-release published no release. Review its result and the commit release intent.\n\n'
  if [[ "${#drift[@]}" != 0 ]]; then
    printf 'Commits after `%s` without a conventional subject:\n\n' "${last_tag}"
    for subject in "${drift[@]}"; do
      printf -- '- `%s`\n' "${subject}"
    done
  fi
} >>"${summary_path}"
echo "::warning::${#subjects[@]} unreleased commit(s) after ${last_tag}; semantic-release published no release." >&2
if [[ "${#drift[@]}" != 0 ]]; then
  echo "::warning::${#drift[@]} commit(s) after ${last_tag} lack a conventional subject." >&2
fi
