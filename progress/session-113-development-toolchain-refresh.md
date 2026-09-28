# Session 113: refresh development toolchains

Date: 2026-09-28. Baseline was clean `main` at `24243bc0`. The central
repository had 13 open issues and no open pull requests. No organization or
consumer policy changed.

## Task and hypothesis

Continue `GOAL.md`: review available dependencies and complete safe work with
low Unity CI churn. The main Go module had no dependency updates. The isolated
actionlint module still selected its newest tagged actionlint release, but the
Dev Container and CI toolchain pins had newer compatible releases.

Hypothesis: refreshing those toolchains, feature digests, and checksum tests
will keep development and CI aligned without changing licensed workflows.

## Changes

- Upgrade Go from 1.26 to 1.27.1 in both Go module directives, the Dev
  Container, documentation, and the workflow linter toolchain.
- Upgrade Node.js 24.18.0 to 24.21.0, GitHub CLI 2.96.0 to 2.101.0, and
  golangci-lint 2.12.2 to 2.14.0.
- Upgrade Dev Container features to common-utils 2.7.0, GitHub CLI 1.1.3,
  and Go 1.4.0. Feature lock digests were regenerated with Dev Container CLI
  0.89.0. Node feature 2.1.0 was already current.
- Pin the Go 1.27 Bookworm base image by its OCI index digest.
- Update both architecture checksums for Go, Node.js, and GitHub CLI. Tests
  assert the versioned URLs, checksums, feature digests, and image digest.
- Update the development documentation and generated LLM index.
- No Unity action, runtime, licensed workflow, organization rule, or consumer
  setting changed.

## Dependency evidence

- `go list -m -u all` reports no main-module updates.
- The actionlint module reports only goldmark, YAML, and x/net candidates.
  Actionlint remains at `v1.7.12`, its latest release. The YAML `rc.6` update
  remains incompatible. Goldmark and x/net overrides are removed by
  `go mod tidy -diff`; they are not imported by the wrapper.
- `devcontainer outdated` reports every configured feature at its latest
  version.
- Official release metadata supplied Go 1.27.1, Node.js 24.21.0, GitHub CLI
  2.101.0, and golangci-lint 2.14.0. The Go, Node, and GitHub CLI checksums
  came from their official release metadata. Downloaded arm64 Go, Node, and
  golangci-lint archives matched those checksums.
- The OCI registry returned the base-image index digest for
  `mcr.microsoft.com/devcontainers/go:1.27-bookworm`.

## Validation

- `node tools/llm-harness.mjs generate` and `check`: passed.
- `node --test test/devcontainer.test.js`: 5 passed.
- `go mod tidy -diff` and actionlint `go mod tidy -diff`: passed.
- `devcontainer upgrade --dry-run`: resolved all feature manifests and
  digests. The lock file matches the generated resolutions.
- `devcontainer outdated`: no feature updates remain.
- `.devcontainer/scripts/verify.sh`: passed with Go 1.27.1, Node 24.21.0,
  and golangci-lint 2.14.0. It reports 909 JavaScript tests passed, 6
  skipped, all Go tests passed, modules verified, and credential audit passed.
- Local container image build was unavailable because Docker is not installed.
  The pull request's hosted Dev Container workflow must validate both
  architectures.

## Main-thread review

The active instructions prohibit sub-agents, so implementation, review, and
remediation used separate main-thread passes. Review checked all version
references, both architecture mappings, published checksums, image digest,
feature lock data, module tidy output, generated LLM files, and the full
verification result. It found no actionable issue. The local Docker build
limit remains for hosted CI to verify.

Continuous-improvement decision: revise the repository map and testing skill
to record the Go 1.27 baseline. No new reusable safety rule was established.
