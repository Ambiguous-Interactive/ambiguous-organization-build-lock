const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const actionsRoot = path.join(__dirname, "..", ".github", "actions");
const actionManifests = fs
  .readdirSync(actionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(actionsRoot, entry.name, "action.yml"));

test("all JavaScript actions target the supported GitHub Actions runtime", async (t) => {
  assert.ok(actionManifests.length > 0, "expected at least one local action manifest");

  for (const manifest of actionManifests) {
    await t.test(path.relative(process.cwd(), manifest), () => {
      const text = fs.readFileSync(manifest, "utf8");
      assert.match(text, /^\s*using:\s*node24\s*$/m);
      assert.doesNotMatch(text, /^\s*using:\s*node20\s*$/m);
    });
  }
});
