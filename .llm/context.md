# Repository Agent Context

This is the canonical entry point for every coding agent working in this
repository. Vendor-specific instruction files are pointers only.

## Mission

Maintain the organization-wide Unity build lock and its fail-closed safety
controls. A change is correct only when it preserves licensed-resource safety,
queue fairness, recoverability, and operator-visible evidence.

## Progressive disclosure

Start with the [generated knowledge index](./index.md). Read only the skills,
research, references, and samples relevant to the current task. Do not load the
entire `.llm` tree by default.

Skills follow the open [Agent Skills](https://agentskills.io/specification)
format: one skill directory, a `SKILL.md` with standard YAML `name` and
`description` frontmatter, and optional bundled resources. Run
`node tools/llm-harness.mjs generate` after adding, removing, moving, or editing
indexed knowledge.

## Working method

0. Before any `gh` call or GitHub API use, follow the
   [github-cli-auth skill](./skills/github-cli-auth/SKILL.md). Read the token
   cache at `~/.config/gh/token`. Run `git credential fill` only when the
   cache is missing, never per command.
1. State the task, safety invariants, and a falsifiable hypothesis.
2. Inspect current behavior and record a baseline.
3. Add or identify a failing test that represents the desired behavior.
4. Make the smallest coherent change that makes the test pass.
5. Run focused checks, then the complete repository verification.
6. Review the diff adversarially for unsafe success paths, stale documentation,
   generated-file drift, credentials, and untested boundaries. For substantial
   work, use the independent review and remediation loop defined by the
   continuous-improvement skill.
7. After substantial work, run the
   [continuous-improvement skill](./skills/continuous-improvement/SKILL.md):
   analyze evidence and root causes, then promote durable learning into the
   narrowest authoritative LLM resource or record why none should be stored.
8. Report commands and outcomes; distinguish observed facts from inference,
   and preserve an auditable record of review findings and dispositions.

Never weaken a fail-closed path merely to make a check green. Do not edit
unrelated user changes in a dirty worktree.

## User-facing writing

Use Simplified Technical English (STE) for all copy you present to users:
pull-request titles, descriptions, and comments, code comments, issue
comments, commit messages, and review replies.

- Keep it short. Say the needed thing in the fewest clear words.
- Write short sentences (about 20 words or fewer), one idea each.
- Use active voice and simple everyday words.
- No idioms, jokes, marketing words, or filler.
- In lists, keep one point per bullet.

`progress/` records still keep their required evidence detail, but write even
those in plain, direct language.

## Repository map

- `.github/actions/`: public composite and JavaScript action manifests.
- `.github/dist/`: committed dependency-free Node.js action runtimes.
- `cmd/` and `internal/`: Go policy and enrollment analyzers.
- `locks/`: live lock configuration contract and state documentation.
- `docs/`: consumer enrollment, operational facts, and runbooks.
- `test/`: dependency-free Node.js contract and policy tests.
- `tools/actionlint/`: isolated module for the pinned workflow linter.

## Validation

Prefer the narrowest relevant test during development. Before handoff run:

```bash
node tools/llm-harness.mjs check
node --test test/*.test.js
go test ./...
go mod verify
go -C tools/actionlint mod verify
go mod tidy -diff
go -C tools/actionlint mod tidy -diff
golangci-lint run --timeout=5m
bash tools/workflows/ci.sh javascript
bash tools/workflows/ci.sh shellcheck
go vet ./...
go test -race ./...
go run ./cmd/workflow-credential-audit .
```

Run the complete local CI equivalent with `.devcontainer/scripts/verify.sh`
when the development-container files are present.

## Non-negotiable safety rules

- Licensed paths cancel: every workflow concurrency scope that can reach
  acquire has a block with literal `cancel-in-progress: true`; an existing
  job-level group cancels too, while aggregate-reporter groups keep literal
  `false`; licensed matrices use `fail-fast: false`.
- Remote actions in policy and documentation use immutable full commit SHAs or
  explicit immutable placeholders.
- Admission, runner inventory, lifecycle cleanup, and incident recovery fail
  closed when evidence is missing or ambiguous.
- Never expose credentials in workflow shell interpolation or logs.
- Treat `progress/` records as public audit evidence: retain sanitized facts and
  decisions, never credential literals, raw logs, personal data, or live lock
  state.
- Keep action manifests, committed runtime files, tests, docs, and operational
  facts synchronized when a public contract changes.

## Harness maintenance

All files under `.llm/` and all vendor pointer files have a hard maximum of 300
physical lines. The generated index is included in that limit. Existing
production and legacy test files are outside this scoped policy because several
are intentionally bundled or already exceed 300 lines.

Install the repository hook with `bash tools/install-git-hooks.sh`. The hook
validates the staged snapshot, while CI independently rejects drift. See
[.llm/README.md](./README.md) for authoring details.
