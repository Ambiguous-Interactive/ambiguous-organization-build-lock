const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const actionsRoot = path.join(__dirname, "..", ".github", "actions");
const repoRoot = path.join(__dirname, "..");
const distRoot = path.join(repoRoot, ".github", "dist");
const actionManifests = fs
  .readdirSync(actionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(actionsRoot, entry.name, "action.yml"));
const acquireInputKeys = [
  "lock-name",
  "holder-id-suffix",
  "runner-id",
  "lock-repository",
  "state-branch",
  "timeout-minutes",
  "lease-minutes",
  "poll-seconds"
];
const acquireOutputKeys = [
  "acquired",
  "lock-name",
  "holder-id",
  "state-sha",
  "wait-ms",
  "attempts",
  "stale-recovered"
];

function readActionManifest(actionName) {
  return fs.readFileSync(path.join(actionsRoot, actionName, "action.yml"), "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isYamlBlankOrComment(line) {
  return /^[ \t]*(?:#.*)?$/.test(line);
}

function lineIndent(line) {
  return /^ */.exec(line)[0].length;
}

function stripYamlComment(value) {
  let quote = null;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];

    if (quote) {
      if (quote === "\"" && char === "\\") {
        index++;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (char === "#" && (index === 0 || /[ \t]/.test(value[index - 1]))) {
      return value.slice(0, index).trim();
    }
  }

  return value.trim();
}

function yamlScalarValue(value) {
  const trimmed = stripYamlComment(value);
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2] : trimmed;
}

function assertTrackedFile(target, message) {
  const relativeTarget = path.relative(repoRoot, target).split(path.sep).join("/");
  try {
    childProcess.execFileSync("git", ["ls-files", "--error-unmatch", relativeTarget], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe"
    });
  } catch {
    assert.fail(message);
  }
}

function yamlRequiredTopLevelScalarMap(text, blockName, manifestName) {
  const lines = text.split(/\r?\n/);
  const blockPattern = new RegExp(`^${escapeRegExp(blockName)}:\\s*(?:#.*)?$`);
  const blockIndexes = lines
    .map((line, index) => (lineIndent(line) === 0 && blockPattern.test(line) ? index : -1))
    .filter((index) => index !== -1);
  assert.equal(blockIndexes.length, 1, `${manifestName} must define exactly one top-level ${blockName}: block`);
  const blockIndex = blockIndexes[0];

  const entries = {};
  let childIndent = null;
  for (let index = blockIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (/^\S/.test(line) && !isYamlBlankOrComment(line)) {
      break;
    }
    if (isYamlBlankOrComment(line)) {
      continue;
    }

    const indent = lineIndent(line);
    if (childIndent === null) {
      childIndent = indent;
    }
    if (indent !== childIndent) {
      continue;
    }

    const match = new RegExp(`^ {${childIndent}}(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+)):(?:\\s+(.*?))?\\s*$`).exec(
      line
    );
    if (match) {
      const [, doubleQuotedKey, singleQuotedKey, bareKey, value = ""] = match;
      const key = doubleQuotedKey || singleQuotedKey || bareKey;
      assert.ok(
        !Object.prototype.hasOwnProperty.call(entries, key),
        `${manifestName} must not define duplicate ${blockName}.${key} entries`
      );
      entries[key] = yamlScalarValue(value);
    }
  }

  const keys = Object.keys(entries);
  assert.ok(keys.length > 0, `${manifestName} must define at least one ${blockName} entry`);
  return entries;
}

function yamlRequiredTopLevelMappingKeys(text, blockName, manifestName) {
  const keys = Object.keys(yamlRequiredTopLevelScalarMap(text, blockName, manifestName));
  return keys;
}

test("all JavaScript actions target the supported GitHub Actions runtime", async (t) => {
  assert.ok(actionManifests.length > 0, "expected at least one local action manifest");

  for (const manifest of actionManifests) {
    const manifestName = path.relative(actionsRoot, manifest);
    await t.test(path.relative(process.cwd(), manifest), () => {
      const text = fs.readFileSync(manifest, "utf8");
      const runs = yamlRequiredTopLevelScalarMap(text, "runs", manifestName);

      assert.equal(runs.using, "node24", `${manifestName} must run on the supported GitHub Actions runtime`);
      assert.notEqual(runs.using, "node20", `${manifestName} must not run on the retired GitHub Actions runtime`);
    });
  }
});

test("all action manifests define unique non-empty interface blocks", async (t) => {
  assert.ok(actionManifests.length > 0, "expected at least one local action manifest");

  for (const manifest of actionManifests) {
    const manifestName = path.relative(actionsRoot, manifest);
    await t.test(manifestName, () => {
      const text = fs.readFileSync(manifest, "utf8");

      for (const blockName of ["inputs", "outputs"]) {
        yamlRequiredTopLevelMappingKeys(text, blockName, manifestName);
      }
    });
  }
});

test("all action manifest entrypoints resolve to committed JavaScript files", async (t) => {
  assert.ok(actionManifests.length > 0, "expected at least one local action manifest");

  for (const manifest of actionManifests) {
    const manifestName = path.relative(actionsRoot, manifest);
    await t.test(manifestName, () => {
      const text = fs.readFileSync(manifest, "utf8");
      const runs = yamlRequiredTopLevelScalarMap(text, "runs", manifestName);

      for (const key of ["main", "post"]) {
        if (runs[key] === undefined) {
          continue;
        }

        const target = path.resolve(path.dirname(manifest), runs[key]);
        const distRelativeTarget = path.relative(distRoot, target);

        assert.ok(
          distRelativeTarget && !distRelativeTarget.startsWith("..") && !path.isAbsolute(distRelativeTarget),
          `${manifestName} runs.${key} must resolve inside .github/dist`
        );
        assert.ok(fs.existsSync(target), `${manifestName} runs.${key} must resolve to an existing file`);
        assert.ok(fs.statSync(target).isFile(), `${manifestName} runs.${key} must resolve to a file`);
        assert.equal(path.extname(target), ".js", `${manifestName} runs.${key} must resolve to a JavaScript file`);
        assertTrackedFile(target, `${manifestName} runs.${key} must resolve to a tracked JavaScript file`);
      }
    });
  }
});

test("opt-in acquire cleanup action has post cleanup while legacy acquire remains explicit-only", () => {
  const legacy = readActionManifest("acquire-build-lock");
  const optIn = readActionManifest("acquire-build-lock-with-cleanup");
  const legacyRuns = yamlRequiredTopLevelScalarMap(legacy, "runs", "acquire-build-lock/action.yml");
  const optInRuns = yamlRequiredTopLevelScalarMap(optIn, "runs", "acquire-build-lock-with-cleanup/action.yml");

  assert.equal(legacyRuns.main, "../../dist/acquire.js");
  assert.equal(legacyRuns.post, undefined);
  assert.equal(optInRuns.main, "../../dist/acquire-with-cleanup.js");
  assert.equal(optInRuns.post, "../../dist/post-cleanup.js");
});

test("legacy and opt-in acquire actions expose the same interface", () => {
  const legacy = readActionManifest("acquire-build-lock");
  const optIn = readActionManifest("acquire-build-lock-with-cleanup");
  const legacyName = "acquire-build-lock/action.yml";
  const optInName = "acquire-build-lock-with-cleanup/action.yml";

  const legacyInputs = yamlRequiredTopLevelMappingKeys(legacy, "inputs", legacyName);
  const optInInputs = yamlRequiredTopLevelMappingKeys(optIn, "inputs", optInName);
  const legacyOutputs = yamlRequiredTopLevelMappingKeys(legacy, "outputs", legacyName);
  const optInOutputs = yamlRequiredTopLevelMappingKeys(optIn, "outputs", optInName);

  assert.deepEqual(legacyInputs, acquireInputKeys);
  assert.deepEqual(optInInputs, acquireInputKeys);
  assert.deepEqual(legacyOutputs, acquireOutputKeys);
  assert.deepEqual(optInOutputs, acquireOutputKeys);
  assert.deepEqual(optInInputs, legacyInputs);
  assert.deepEqual(optInOutputs, legacyOutputs);
});

test("release accepts the physical runner identity required by schema 3", () => {
  const release = readActionManifest("release-build-lock");
  const inputs = yamlRequiredTopLevelMappingKeys(release, "inputs", "release-build-lock/action.yml");

  assert.ok(inputs.includes("runner-id"));
  assert.ok(inputs.includes("holder-id"));
  assert.match(release, /<repository>:<run-id>:<source-job-id>:<holder-id-suffix>/);
});

test("README documents guarded acquire usage and unconditional release cleanup", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");

  assert.match(readme, /^\s*id:\s*acquire-build-lock\s*$/m);
  assert.match(readme, /if:\s*\$\{\{\s*steps\.acquire-build-lock\.outputs\.acquired == 'true'\s*\}\}/);
  assert.match(readme, /^\s*if:\s*always\(\)\s*$/m);
  assert.match(readme, /Do not gate the release step on `acquired == 'true'`/);
  assert.match(readme, /acquire-build-lock-with-cleanup/);
  assert.match(readme, /Keep the explicit\s+release step/);
  assert.match(readme, /stable `v1` contract/);
  assert.match(readme, /<repository>:<run-id>:<source-job-id>:<holder-id-suffix>/);
});

test("README documents configurable parallelism and transient-auth handling", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");

  assert.match(readme, /"maxHolders"/);
  assert.match(readme, /locks\/<lock-name>\.config\.json/);
  assert.match(readme, /BUILD_LOCK_AUTH_GRACE_MS/);
  assert.match(readme, /BUILD_LOCK_CONFIG_TTL_MS/);
});
