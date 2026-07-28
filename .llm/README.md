<!-- summary: Harness layout, authoring contract, automation, and troubleshooting. -->
# LLM Harness

`.llm/context.md` is the one canonical entry point. Root and editor-specific
files contain links, not duplicated instructions. The generated `index.md`
provides progressive discovery across the rest of this directory.

## Layout

- `skills/<name>/SKILL.md`: standard Agent Skills with discovery metadata.
- `references/`: stable contracts and invariants shared by multiple skills.
- `research/`: dated or evidence-backed exploratory findings.
- `code-samples/`: small, reviewed patterns; never blind copy/paste snippets.
- `tasks/`: templates for hypothesis-driven work and evidence capture.
- `index.md`: deterministic generated catalog; do not edit it manually.

## Agent Skills

Skills follow the open [Agent Skills specification](https://agentskills.io/specification).
Each skill is a self-contained folder with `SKILL.md` and optional `scripts/`,
`references/`, and `assets/` resources. Agents discover `name` and `description`,
load the instructions on activation, and read bundled resources only as needed.

```markdown
---
name: example
description: Perform example work. Use when an example task is requested.
---
# Example
```

The name follows the standard naming rules and must match its immediate parent
directory. The description says both what the skill does and when to use it;
it is the standard activation mechanism. Standard optional fields (`license`,
`compatibility`, `metadata`, and experimental `allowed-tools`) are accepted.
Keep detailed supporting material inside the skill rather than duplicating it
globally.

Validation uses the repository's existing Go YAML library so standard block
scalars, quoted values, mappings, and field types are parsed as YAML.

Non-skill Markdown files need a one-line
`<!-- summary: Why an agent should read this file. -->` comment.
Top-level authored knowledge under `.llm/` is Markdown so every file has a
readable summary. Agent Skills may bundle the standard resource directories or
any additional files and directories allowed by the format; all receive
generated resource entries. Text resources share the 300-line cap, while binary
assets have no meaningful physical-line count.

## Commands

```bash
node tools/llm-harness.mjs generate
node tools/llm-harness.mjs check
node --test test/llm-harness-*.test.js
bash tools/install-git-hooks.sh
```

Generation is deterministic, recursive, timestamp-free, and uses repository
relative POSIX paths. `check` validates metadata, pointer thinness, index drift,
forbidden symlinks, and the exact 300-line maximum.

The committed pre-commit hook materializes and validates the staged Git index,
so partially staged work cannot pair source knowledge with an index generated
from different working-tree content. CI and the devcontainer verifier run the
same check. The installer changes only this clone's `core.hooksPath`.

If validation reports a stale index, regenerate and stage `.llm/index.md`. If a
file reaches 301 lines, split it by concern and add summaries to the new files.
