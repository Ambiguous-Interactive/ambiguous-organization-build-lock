const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const actionsRoot = path.join(__dirname, "..", ".github", "actions");
const repoRoot = path.join(__dirname, "..");
const actionManifests = fs
  .readdirSync(actionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(actionsRoot, entry.name, "action.yml"));

function readActionManifest(actionName) {
  return fs.readFileSync(path.join(actionsRoot, actionName, "action.yml"), "utf8");
}

function yamlTopLevelKeys(text, blockName) {
  const lines = text.split(/\r?\n/);
  const blockIndex = lines.findIndex((line) => new RegExp(`^${blockName}:\\s*$`).test(line));
  if (blockIndex === -1) {
    return [];
  }
  const keys = [];
  for (let index = blockIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (/^\S/.test(line)) {
      break;
    }
    const match = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) {
      keys.push(match[1]);
    }
  }
  return keys;
}

test("all JavaScript actions target the supported GitHub Actions runtime", async (t) => {
  assert.ok(actionManifests.length > 0, "expected at least one local action manifest");

  for (const manifest of actionManifests) {
    await t.test(path.relative(process.cwd(), manifest), () => {
      const text = fs.readFileSync(manifest, "utf8");
      assert.match(text, /^\s*using:\s*['"]?node24['"]?\s*$/m);
      assert.doesNotMatch(text, /^\s*using:\s*['"]?node20['"]?\s*$/m);
    });
  }
});

test("opt-in acquire cleanup action has post cleanup while legacy acquire remains explicit-only", () => {
  const legacy = readActionManifest("acquire-build-lock");
  const optIn = readActionManifest("acquire-build-lock-with-cleanup");

  assert.match(legacy, /^\s*main:\s*..\/..\/dist\/acquire\.js\s*$/m);
  assert.doesNotMatch(legacy, /^\s*post:\s*/m);
  assert.match(optIn, /^\s*main:\s*..\/..\/dist\/acquire-with-cleanup\.js\s*$/m);
  assert.match(optIn, /^\s*post:\s*..\/..\/dist\/post-cleanup\.js\s*$/m);
});

test("legacy and opt-in acquire actions expose the same interface", () => {
  const legacy = readActionManifest("acquire-build-lock");
  const optIn = readActionManifest("acquire-build-lock-with-cleanup");

  assert.deepEqual(yamlTopLevelKeys(optIn, "inputs"), yamlTopLevelKeys(legacy, "inputs"));
  assert.deepEqual(yamlTopLevelKeys(optIn, "outputs"), yamlTopLevelKeys(legacy, "outputs"));
});

test("README documents guarded acquire usage and unconditional release cleanup", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");

  assert.match(readme, /^\s*id:\s*acquire-build-lock\s*$/m);
  assert.match(readme, /if:\s*\$\{\{\s*steps\.acquire-build-lock\.outputs\.acquired == 'true'\s*\}\}/);
  assert.match(readme, /^\s*if:\s*always\(\)\s*$/m);
  assert.match(readme, /Do not gate the release step on `acquired == 'true'`/);
  assert.match(readme, /acquire-build-lock-with-cleanup/);
  assert.match(readme, /Keep the explicit\s+release step/);
});
