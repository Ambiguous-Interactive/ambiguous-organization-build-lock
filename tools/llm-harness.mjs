#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
export const MAX_LINES = 300;
export const POINTERS = [
  { path: "AGENTS.md", title: "Codex and OpenAI Agents", target: ".llm/context.md" },
  { path: "CLAUDE.md", title: "Claude Code", target: ".llm/context.md" },
  { path: "GEMINI.md", title: "Gemini", target: ".llm/context.md" },
  { path: ".cursorrules", title: "Cursor (legacy compatibility)", target: ".llm/context.md" },
  { path: ".windsurfrules", title: "Windsurf", target: ".llm/context.md" },
  { path: ".github/copilot-instructions.md", title: "GitHub Copilot", target: "../.llm/context.md" },
  {
    path: ".cursor/rules/repository-context.mdc",
    title: "Cursor",
    target: "../../.llm/context.md",
    frontmatter: "---\ndescription: Load the repository's canonical agent context\nalwaysApply: true\n---\n\n"
  }
];

const INDEX_PATH = ".llm/index.md";
const SKILL_PATTERN = /^\.llm\/skills\/([^/]+)\/SKILL\.md$/;
const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function countLines(text) {
  if (text.length === 0) return 0;
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length -
    (text.endsWith("\n") || text.endsWith("\r") ? 1 : 0);
}

function posix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function walk(root, relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const relativePath = posix(path.join(relativeDirectory, name));
    const absolutePath = path.join(root, relativePath);
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`${relativePath}: symbolic links are not allowed in the LLM harness`);
    }
    if (stat.isDirectory()) files.push(...walk(root, relativePath));
    else if (stat.isFile()) files.push(relativePath);
  }
  return files;
}

function parseMetadata(text, relativePath) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${relativePath}: skill must start with YAML frontmatter`);
  const output = childProcess.execFileSync(
    "go",
    ["run", "./cmd/llm-skill-metadata"],
    {
      cwd: toolRoot,
      encoding: "utf8",
      input: JSON.stringify({ path: relativePath, yaml: match[1] }),
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  const result = JSON.parse(output);
  if (result.error) throw new Error(result.error);
  return result.metadata;
}

function validateMetadata(metadata, relativePath, slug) {
  const errors = [];
  const characterCount = (value) => [...value.trim()].length;
  if (metadata.name !== slug) errors.push(`${relativePath}: name must match its directory (${slug})`);
  if (!/^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/.test(metadata.name || "")) {
    errors.push(`${relativePath}: name must follow the Agent Skills naming constraints`);
  }
  if (!metadata.description || characterCount(metadata.description) < 1 ||
      characterCount(metadata.description) > 1024) {
    errors.push(`${relativePath}: description must contain 1-1024 characters`);
  }
  if (metadata.compatibility !== undefined &&
      (characterCount(metadata.compatibility) < 1 ||
       characterCount(metadata.compatibility) > 500)) {
    errors.push(`${relativePath}: compatibility must contain 1-500 characters`);
  }
  if (metadata["allowed-tools"] !== undefined &&
      characterCount(metadata["allowed-tools"]) < 1) {
    errors.push(`${relativePath}: allowed-tools must be a non-empty space-separated string`);
  }
  return errors;
}

function summary(text, relativePath) {
  const match = text.match(/<!--\s*summary:\s*(.+?)\s*-->/i);
  if (!match) throw new Error(`${relativePath}: add a one-line <!-- summary: ... -->`);
  return match[1].trim();
}

function markdown(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function pointerContent(pointer) {
  return `${pointer.frontmatter || ""}# ${pointer.title}\n\nRead and follow the canonical repository instructions in\n` +
    `[\`${pointer.target}\`](${pointer.target}) before working.\n`;
}

function catalog(root) {
  const entries = [];
  const errors = [];
  const skillsRoot = path.join(root, ".llm", "skills");
  const skillNames = new Set();
  if (fs.existsSync(skillsRoot)) {
    for (const directory of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!directory.isDirectory()) {
        errors.push(`.llm/skills/${directory.name}: skills root may contain only skill directories`);
      } else if (!fs.existsSync(path.join(skillsRoot, directory.name, "SKILL.md"))) {
        errors.push(`.llm/skills/${directory.name}: skill directory must contain SKILL.md`);
      } else {
        skillNames.add(directory.name);
      }
    }
  }
  for (const relativePath of walk(root, ".llm")) {
    if (!relativePath.endsWith(".md")) {
      const resource = relativePath.match(/^\.llm\/skills\/([^/]+)\/.+/);
      if (resource && skillNames.has(resource[1])) {
        const extension = path.posix.extname(relativePath).slice(1).toUpperCase() || "bundled";
        entries.push({
          section: "Skill Resources",
          path: relativePath,
          description: `${extension} resource bundled with the ${resource[1]} skill.`
        });
      } else {
        errors.push(
          `${relativePath}: non-Markdown files must be bundled inside a valid Agent Skill`
        );
      }
      continue;
    }
    if ([INDEX_PATH, ".llm/context.md"].includes(relativePath)) continue;
    const text = fs.readFileSync(path.join(root, relativePath), "utf8");
    const skillMatch = relativePath.match(SKILL_PATTERN);
    try {
      if (skillMatch) {
        const metadata = parseMetadata(text, relativePath);
        errors.push(...validateMetadata(
          metadata,
          relativePath,
          path.posix.basename(path.posix.dirname(relativePath))
        ));
        entries.push({
          section: "Skills",
          path: relativePath,
          description: metadata.description || ""
        });
      } else {
        const resource = relativePath.match(/^\.llm\/skills\/([^/]+)\/.+/);
        if (resource && skillNames.has(resource[1])) {
          entries.push({
            section: "Skill Resources",
            path: relativePath,
            description: text.match(/<!--\s*summary:/i)
              ? summary(text, relativePath)
              : `Markdown resource bundled with the ${resource[1]} skill.`
          });
          continue;
        }
        const sectionName = relativePath.split("/")[1];
        entries.push({
          section: relativePath.split("/").length === 2
            ? "Harness"
            : sectionName.replace(/(^|-)([a-z])/g, (_, separator, letter) =>
              `${separator ? " " : ""}${letter.toUpperCase()}`),
          path: relativePath,
          description: summary(text, relativePath)
        });
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { entries, errors };
}

export function generateIndex(root = process.cwd()) {
  const { entries, errors } = catalog(path.resolve(root));
  if (errors.length) throw new Error(errors.join("\n"));
  const sections = new Map();
  for (const entry of entries) {
    if (!sections.has(entry.section)) sections.set(entry.section, []);
    sections.get(entry.section).push(entry);
  }
  const lines = [
    "# LLM Knowledge Index",
    "",
    "<!-- Generated by `node tools/llm-harness.mjs generate`; do not edit. -->",
    "",
    "Read only the files relevant to the current task."
  ];
  for (const section of [...sections.keys()].sort()) {
    lines.push("", `## ${section}`, "", "| File | When to read |", "| --- | --- |");
    for (const entry of sections.get(section)) {
      const link = `./${entry.path.slice(".llm/".length)}`;
      lines.push(`| [${markdown(entry.path)}](${link}) | ${markdown(entry.description)} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function verifyRepository(root = process.cwd(), options = {}) {
  root = path.resolve(root);
  const errors = [];
  let harnessFiles = [];
  try {
    harnessFiles = walk(root, ".llm");
  } catch (error) {
    errors.push(error.message);
  }
  const governed = [...harnessFiles];
  if (options.checkPointers !== false) governed.push(...POINTERS.map((pointer) => pointer.path));
  for (const relativePath of governed) {
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath)) {
      errors.push(`${relativePath}: required file is missing`);
      continue;
    }
    if (fs.lstatSync(absolutePath).isSymbolicLink()) {
      errors.push(`${relativePath}: symbolic links are not allowed in the LLM harness`);
      continue;
    }
    const bytes = fs.readFileSync(absolutePath);
    if (!bytes.includes(0)) {
      const lines = countLines(bytes.toString("utf8"));
      if (lines > MAX_LINES) errors.push(`${relativePath}: ${lines} lines exceeds ${MAX_LINES}`);
    }
  }
  if (options.checkMetadata !== false) {
    try {
      errors.push(...catalog(root).errors);
    } catch (error) {
      errors.push(error.message);
    }
  }
  const indexPath = path.join(root, INDEX_PATH);
  try {
    const expected = generateIndex(root);
    if (!fs.existsSync(indexPath) || fs.readFileSync(indexPath, "utf8") !== expected) {
      errors.push(`${INDEX_PATH}: generated index is stale; run node tools/llm-harness.mjs generate`);
    }
  } catch (error) {
    if (!errors.includes(error.message)) errors.push(error.message);
  }
  const contextPath = path.join(root, ".llm/context.md");
  if (!fs.existsSync(contextPath) || !fs.readFileSync(contextPath, "utf8").includes("./index.md")) {
    errors.push(".llm/context.md: must link to ./index.md");
  }
  if (options.checkPointers !== false) {
    for (const pointer of POINTERS) {
      const absolutePath = path.join(root, pointer.path);
      if (!fs.existsSync(absolutePath)) continue;
      const content = fs.readFileSync(absolutePath, "utf8");
      if (content !== pointerContent(pointer)) {
        errors.push(`${pointer.path}: must match the canonical thin-pointer template`);
      }
    }
  }
  return { errors: [...new Set(errors)] };
}

function main() {
  const [command = "check", ...arguments_] = process.argv.slice(2);
  const rootIndex = arguments_.indexOf("--root");
  const root = rootIndex >= 0 ? arguments_[rootIndex + 1] : process.cwd();
  if (command === "generate") {
    const output = generateIndex(root);
    fs.writeFileSync(path.join(path.resolve(root), INDEX_PATH), output, "utf8");
    console.log(`Generated ${INDEX_PATH}`);
    return;
  }
  if (command !== "check") throw new Error("Usage: llm-harness.mjs [generate|check] [--root PATH]");
  const result = verifyRepository(root);
  if (result.errors.length) {
    console.error(result.errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("LLM harness checks passed.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
