#!/usr/bin/env bash
set -euo pipefail

# Retry a command with exponential backoff. Provisioning downloads (apt, Go
# modules, npm) fail transiently when the Docker Desktop VM loses DNS for a
# few seconds; a single unguarded attempt turns that into a failed build.
# Usage: retry <max-attempts> <command...>
retry() {
  local attempts="${1:?usage: retry <max-attempts> <command...>}"
  shift
  local delay="${RETRY_DELAY_SECONDS:-5}"
  local attempt=1

  until "$@"; do
    if (( attempt >= attempts )); then
      printf 'retry: giving up after %s attempt(s): %s\n' "${attempt}" "$*" >&2
      return 1
    fi
    printf 'retry: attempt %s/%s failed, sleeping %ss: %s\n' \
      "${attempt}" "${attempts}" "${delay}" "$*" >&2
    sleep "${delay}"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}
