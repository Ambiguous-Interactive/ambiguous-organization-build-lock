<!-- summary: Install current Codex and OpenCode CLIs without root on every devcontainer start. -->
# Task: Install current agent CLIs on devcontainer start

## Acceptance criteria
- Every container start installs the stable npm `latest` tags for OpenAI Codex
  and OpenCode as the unprivileged remote user.
- `codex` and `opencode` resolve in standards-based VS Code terminals and the
  reduced SSH launcher on Linux amd64 and arm64 containers.
- Existing pinned toolchains, non-root workspace ownership, and verification
  behavior remain unchanged.

## Baseline
- Command: `node --test test/devcontainer.test.js`
- Observed result: 3 passed; no agent CLI installation contract existed.
- Reproduction status: reproduced by inspection; `post-start.sh` installed no
  npm packages and the configuration declared no user npm binary path.

## Hypothesis
- Claim: a user-owned `~/.local` npm prefix, installed on every start and
  exposed through both `remoteEnv` and `.zshrc`, removes root and launcher PATH
  dependencies while npm selects the container's native binary.
- Disconfirming evidence: permission errors as uid 1000, missing commands after
  installation, unsupported arm64 packages, or differing repeated-start state.
- Falsified hypotheses: none.

## Red
- Test: focused lifecycle contract in `test/devcontainer.test.js`.
- Expected failure: missing `remoteEnv.PATH` and missing installer script.
- Observed failure: both exact failures occurred; 1 passed and 2 failed.

## Risk and path matrix
- Positive: install both latest stable tags; validate both commands and versions.
- Negative: do not use sudo or a system npm prefix.
- Error: strict shell mode and post-install command checks fail startup visibly.
- Boundary/extreme: repeat installation is npm-idempotent and refreshes `latest`.
- Concurrency/ordering: fallback Node bootstrap precedes npm; concurrent starts
  for one stopped container are not reachable in the supported lifecycle.
- Cancellation/recovery: a later start retries a failed or interrupted install.
- Determinism/isolation: contract tests are offline; real install used a temporary
  HOME and the current npm registry as external evidence.
- Contract synchronization: configuration, lifecycle, test, and README changed.

## Green
- Minimal change: one installer, one post-start call, user PATH configuration,
  focused assertions, and synchronized documentation.
- Focused result: `node --test test/devcontainer.test.js` passed 3 of 3;
  `bash -n` and ShellCheck passed for every devcontainer script.

## Full validation
- Isolated real install: temporary HOME on Linux arm64, uid 1000; npm installed
  Codex 0.149.1 and OpenCode 1.18.22, both version commands passed, and all
  installed paths were owned by `vscode:vscode`.
- Registry metadata: both packages' current `latest` releases enumerate native
  Linux x64 and arm64 packages; this is external current-state evidence.
- `.devcontainer/scripts/verify.sh`: passed; 819 Node tests (816 passed, 3
  platform skips), all Go tests including race, module verification/tidy, lint,
  vet, shell checks, and credential audit passed.
- `git diff --check` and `node tools/llm-harness.mjs check`: passed.
- Dev Containers CLI `read-configuration`: could not run because this container
  deliberately has no Docker CLI/socket (`spawn docker ENOENT`). JSON parsing
  and the repository's configuration contract test passed instead.

## Adversarial review
- Unsafe success paths considered: npm top-level success without usable native
  binaries, a root-owned prefix, missing PATH in either launcher, install before
  fallback Node, interrupted installs, registry failure, and stale docs/index.
- Intent-to-diff status: done for installer, both PATH consumers, lifecycle,
  test, documentation, and generated knowledge; host OS portability remains at
  the existing Linux container boundary.
- Unverifiable items and open questions: no local Docker access for a fresh
  amd64/arm64 image build; the existing hosted workflow remains the external
  native-architecture build gate.
- Remaining uncertainty: npm `latest` and registry availability are external by
  design. A failed start is visible and the next start retries.
- Implementer: primary agent.
- Reviewer and evidence: separated main-thread pass over complete diff, affected
  files, executable modes, lifecycle order, and verification evidence.
- Actionable findings: none.
- Remediator and dispositions: primary agent; no findings required remediation.
- Latest review round outcome: clean with the Docker build limitation above.
- Main-thread fallback reason (if applicable): higher-priority collaboration
  instructions prohibit spawning agents unless the user explicitly requests it.

## Knowledge retention
- Trigger or exemption: substantial multi-surface environment change.
- Evidence: red/green contract, isolated native install, registry package
  metadata, complete verifier, and final diff review.
- Observed facts, inferences, and open questions: npm's user prefix and both
  binaries were observed on arm64; x64 compatibility is supported by package
  metadata and the existing hosted build gate but was not locally executed.
- Root cause or reusable insight: agent installation was absent; launcher PATH
  behavior already had a documented standards-versus-SSH boundary.
- Promotion decision: no additional durable learning.
- Destination or rationale: behavior belongs in the devcontainer README and
  focused task record; existing skills already require red/green and explicit
  external-evidence limits, so another skill/reference would duplicate them.
- Independent review outcome: clean main-thread separated pass; independent
  agents were disallowed for this turn by higher-priority collaboration rules.
