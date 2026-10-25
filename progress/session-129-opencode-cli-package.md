# Session 129: carry the OpenCode CLI package rename to a merge

Date: 2026-10-25

## Objective and safety invariants

Finish the in-progress working-tree work left uncommitted by session 128:

- `.devcontainer/scripts/install-agent-clis.sh` and `.devcontainer/README.md`
  switch the OpenCode install to `@opencode/cli@latest`;
- `test/devcontainer.test.js` pins the new package name in the lifecycle
  contract.

Safety invariants: no Unity job, workflow, lock state, or policy change. Only
the devcontainer agent-CLI provisioning contract changes.

## Baseline and hypothesis

Baseline: three unstaged edits sat on `ff1a5e55a4`; `main` moved to
`7e9f31ee5` before this commit, with the same three edits still uncommitted.
The contract test failed while the script still named `opencode-ai@latest`.

Hypothesis: the publisher moved the current distribution of the same tool to
`@opencode/cli`, so the registry and a fresh install support the rename.

## Registry and live evidence

- Registry: `opencode-ai` latest is 1.19.4 (published 2026-10-22). Its 1.x
  line still publishes releases and has no deprecation notice.
- `@opencode/cli` latest is 2.1.4 (first 2.0.0 on 2026-09-11). Its
  homepage and repository point to `github.com/anomalyco/opencode`.
- Inference: the rename is publisher-driven. Same package maintainer
  (`thdxr`), and the upstream project's own README documents
  `npm i -g @opencode/cli@latest`.
- This container runs `opencode v2.1.4` from
  `~/.local/lib/node_modules/@opencode/cli` as the unprivileged user.
- A fresh isolated install into a temporary HOME, as user `vscode`, with the
  script's exact npm invocation, exited 0 and printed `opencode v2.1.4`.

## Red-green experiment

The updated contract test failed against the HEAD script and passed with the
renamed script. `node --test test/devcontainer.test.js` went from `pass 4,
fail 1` to `pass 5, fail 0`. No tracked file names the old package. This
record's own historical mentions are the only remaining ones.

## Verification

- `bash -n` and ShellCheck pass for the installer; CI shellcheck mode
  (`bash tools/workflows/ci.sh shellcheck`, which lints all devcontainer
  scripts) passed.
- Focused `node --test test/devcontainer.test.js`: 5 passed, 0 failed.
- Complete local verifier `bash .devcontainer/scripts/verify.sh`: exit 0.
  Node stage totals: 1,028 tests, 1,022 passed, 6 expected hosted-Windows
  skips, 0 failed. Go, lint, actionlint, workflow-policy, and
  credential-audit stages ran without error.
- Independent reviewer reproduced the red-green transition in a throwaway
  clone and re-ran the focused test, shellcheck stage, and registry queries.

## Independent review findings and dispositions

One round: the implementation ran on the main agent; an independent
sub-agent reviewed the diff against HEAD, the draft record, the registry,
and the lifecycle wiring.

1. MEDIUM — the record claimed "no stale package-name reference remains
   anywhere in the repository"; after commit, the record itself would be the
   only remaining mention and the sentence would read false. **Accepted.**
   The claim is now scoped to tracked files.
2. LOW — "publisher-driven rename, not a look-alike threat" stated an
   inference as fact. **Accepted.** The section now labels it an inference
   and cites the repository/homepage and the upstream README install line.
3. LOW — "stale 1.x pin" overstated the registry facts: the 1.x package is
   alive, not deprecated. **Accepted.** Wording now says the publisher's
   current major is 2.x while the 1.x line still publishes.
4. LOW — three STE defects in the record: one run-on hypothesis sentence,
   "proves", and one unclear semicolon sentence. **Accepted.** Rewritten in
   short active-voice sentences; "supports" replaces "proves".
5. INFO — baseline drift: HEAD moved to `7e9f31ee5` after the record called
   out `ff1a5e55a4`. **Accepted**; the baseline paragraph now states both.
6. INFO — the reviewer did not re-run every Go/lint stage of the local
   verifier. **No action**; the verifier run is this session's own evidence
   and the boundary is stated above.
7. INFO — task record `.llm/tasks/devcontainer-agent-clis.md` keeps dated
   OpenCode 1.18.22 evidence. **No action**; dated history stays accurate,
   and its acceptance criteria remain valid.

Areas confirmed clean: no script, test, README, or workflow surface names
the old package; the contract keeps the pre-existing install-order and
no-sudo assertions; the devcontainer CI build gates both architectures; the
post-start lifecycle calls the installer on every start; the new install
leaves no old-package residue. Verdict after remediation: clean, zero
remaining actionable findings.

## Session context

- Open issue priority review: no open pull requests existed. All open
  issues remain gated by owner authority, live Unity evidence, or upstream
  support, matching PLAN.md; the carried working-tree work was the only
  immediately actionable item and costs zero Unity CI churn.
- Dependency review: `go list -m -u all` reports no used upgrade in either
  module; upstream actionlint is still v1.7.12, so #335 stays upstream-
  blocked; no root `package.json` exists.
