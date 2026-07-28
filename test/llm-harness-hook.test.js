const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const repoRoot = path.join(__dirname, "..");
const toolPath = path.join(repoRoot, "tools", "llm-harness.mjs");

async function loadHarness() {
  return import(pathToFileURL(toolPath));
}

function repositoryHarnessFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llm-repository-"));
  for (const relativePath of [
    ".llm",
    ".githooks",
    "cmd/llm-skill-metadata",
    "go.mod",
    "go.sum",
    "tools/llm-harness.mjs"
  ]) {
    const source = path.join(repoRoot, relativePath);
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
  }
  return root;
}

test("pre-commit validates staged content rather than the working tree", async (t) => {
  const root = repositoryHarnessFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { POINTERS, pointerContent } = await loadHarness();
  for (const pointer of POINTERS) {
    const destination = path.join(root, pointer.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, pointerContent(pointer));
  }
  const run = (command, arguments_) =>
    childProcess.execFileSync(command, arguments_, { cwd: root, stdio: "pipe" });
  run("git", ["init", "-q"]);
  run("node", ["tools/llm-harness.mjs", "generate"]);
  run("git", ["add", "."]);

  const skillPath = path.join(root, ".llm", "skills", "task-driven-development", "SKILL.md");
  fs.writeFileSync(
    skillPath,
    fs.readFileSync(skillPath, "utf8")
      .replace("Plan and execute non-trivial", "Plan and carefully execute non-trivial")
  );
  run("node", ["tools/llm-harness.mjs", "generate"]);
  run("git", ["add", ".llm/index.md"]);

  assert.throws(
    () => run("bash", [".githooks/pre-commit"]),
    (error) => error.status === 1 && /staged LLM harness is inconsistent/.test(error.stderr)
  );
});
