#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  syntax)
    node --check tools/llm-harness.mjs
    for action_file in .github/dist/*.js; do
      node --check "${action_file}"
    done
    for test_file in test/*.test.js; do
      node --check "${test_file}"
    done
    ;;
  verify-modules)
    go mod verify
    go -C tools/actionlint mod verify
    ;;
  tidy-modules)
    go mod tidy -diff
    go -C tools/actionlint mod tidy -diff
    ;;
  javascript)
    npx --yes eslint@9.35.0 \
      --no-config-lookup \
      --rule 'no-alert:error' \
      --rule 'no-constant-condition:error' \
      --rule 'no-debugger:error' \
      --rule 'no-dupe-keys:error' \
      --rule 'no-duplicate-case:error' \
      --rule 'no-func-assign:error' \
      --rule 'no-import-assign:error' \
      --rule 'no-invalid-regexp:error' \
      --rule 'no-irregular-whitespace:error' \
      --rule 'no-new-native-nonconstructor:error' \
      --rule 'no-obj-calls:error' \
      --rule 'no-self-assign:error' \
      --rule 'no-sparse-arrays:error' \
      --rule 'no-unexpected-multiline:error' \
      --rule 'no-unreachable:error' \
      --rule 'no-unsafe-finally:error' \
      --rule 'no-unused-vars:["error",{"argsIgnorePattern":"^_","varsIgnorePattern":"^_","caughtErrors":"none"}]' \
      .github/dist/*.js tools/*.mjs test/*.js
    ;;
  install-shellcheck)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    : "${GITHUB_PATH:?GITHUB_PATH is required}"

    shellcheck_version="v0.11.0"
    case "$(uname -m)" in
      x86_64)
        shellcheck_architecture="x86_64"
        shellcheck_sha256="8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198"
        ;;
      aarch64|arm64)
        shellcheck_architecture="aarch64"
        shellcheck_sha256="12b331c1d2db6b9eb13cfca64306b1b157a86eb69db83023e261eaa7e7c14588"
        ;;
      *)
        echo "unsupported ShellCheck runner architecture: $(uname -m)" >&2
        exit 1
        ;;
    esac

    archive_path="${RUNNER_TEMP}/shellcheck-${shellcheck_version}.linux.${shellcheck_architecture}.tar.xz"
    bundle_path="${RUNNER_TEMP}/shellcheck-${shellcheck_version}"
    download_url="https://github.com/koalaman/shellcheck/releases/download/${shellcheck_version}/shellcheck-${shellcheck_version}.linux.${shellcheck_architecture}.tar.xz"

    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --retry 3 --retry-connrefused --retry-max-time 240 --connect-timeout 10 --max-time 60 --output "${archive_path}" "${download_url}"
    printf '%s  %s\n' "${shellcheck_sha256}" "${archive_path}" | sha256sum --check --status
    tar -xJf "${archive_path}" -C "${RUNNER_TEMP}"
    test -x "${bundle_path}/shellcheck"
    "${bundle_path}/shellcheck" --version
    printf '%s\n' "${bundle_path}" >> "${GITHUB_PATH}"
    ;;
  shellcheck)
    shellcheck -S warning tools/*.sh tools/workflows/*.sh .devcontainer/scripts/*.sh
    ;;
  *)
    echo "usage: $0 <syntax|verify-modules|tidy-modules|javascript|install-shellcheck|shellcheck>" >&2
    exit 2
    ;;
esac
