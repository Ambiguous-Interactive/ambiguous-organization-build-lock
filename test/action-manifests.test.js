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
  "github-token",
  "pull-request-number",
  "expected-head-sha",
  "lock-repository",
  "state-branch",
  "timeout-minutes",
  "lease-minutes",
  "poll-seconds",
  "require-resource-lifecycle",
  "minimum-release-cooldown-seconds"
];
const acquireOutputKeys = [
  "acquired",
  "lock-name",
  "holder-id",
  "state-sha",
  "wait-ms",
  "attempts",
  "stale-recovered",
  "quarantine-recovered",
  "admission-result",
  "incident-id",
  "resource-health",
  "resource-reason"
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

function yamlTopLevelBlockText(text, blockName, manifestName) {
  const lines = text.split(/\r?\n/);
  const startIndexes = lines
    .map((line, index) => (line === `${blockName}:` ? index : -1))
    .filter((index) => index !== -1);
  assert.equal(startIndexes.length, 1, `${manifestName} must define exactly one top-level ${blockName}: block`);
  const start = startIndexes[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^\S/.test(lines[index]) && !isYamlBlankOrComment(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
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

/*
 * The runner exposes an input as INPUT_<NAME uppercased, SPACES replaced>. Hyphens survive, so the
 * underscored spelling of a hyphenated input reads as an absent input -- silently, in whichever
 * direction that action's default happens to point. classify-unity-changes shipped that way and
 * answered "not a pull request" for every pull request it ever classified.
 */
test("no action runtime reads a hyphenated input under its underscored spelling", () => {
  const distSources = fs
    .readdirSync(distRoot)
    .filter((entry) => entry.endsWith(".js"))
    .map((entry) => ({ name: entry, text: fs.readFileSync(path.join(distRoot, entry), "utf8") }));
  assert.ok(distSources.length > 0, "expected at least one committed action runtime");

  let hyphenatedInputCount = 0;
  for (const manifest of actionManifests) {
    const manifestName = path.relative(actionsRoot, manifest);
    const text = fs.readFileSync(manifest, "utf8");
    for (const inputName of yamlRequiredTopLevelMappingKeys(text, "inputs", manifestName)) {
      if (!inputName.includes("-")) {
        continue;
      }
      hyphenatedInputCount++;
      const wrong = new RegExp(`INPUT_${escapeRegExp(inputName.replace(/-/g, "_").toUpperCase())}\\b`);
      for (const source of distSources) {
        assert.ok(
          !wrong.test(source.text),
          `${source.name} reads ${manifestName} input ${inputName} as ${wrong.source}, which the runner never sets`
        );
      }
    }
  }
  assert.ok(hyphenatedInputCount > 0, "expected at least one hyphenated action input to guard");
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
  assert.equal(
    yamlTopLevelBlockText(optIn, "inputs", optInName),
    yamlTopLevelBlockText(legacy, "inputs", legacyName),
    "acquire variants must keep all input descriptions, requirements, and defaults identical"
  );
  assert.equal(
    yamlTopLevelBlockText(optIn, "outputs", optInName),
    yamlTopLevelBlockText(legacy, "outputs", legacyName),
    "acquire variants must keep all output descriptions identical"
  );
});

test("top-level action errors sanitize workflow-command data", () => {
  const source = fs.readFileSync(path.join(distRoot, "build-lock.js"), "utf8");

  assert.match(source, /console\.error\(`::error::\$\{workflowCommandData\(message\)\}`\)/);
});

test("release accepts the physical runner identity required by schema 3", () => {
  const release = readActionManifest("release-build-lock");
  const inputs = yamlRequiredTopLevelMappingKeys(release, "inputs", "release-build-lock/action.yml");

  assert.ok(inputs.includes("runner-id"));
  assert.ok(inputs.includes("holder-id"));
  assert.ok(inputs.includes("resource-safe"));
  for (const input of ["resource-cleanup-status", "resource-health", "resource-reason"]) {
    assert.ok(inputs.includes(input));
  }
  assert.match(release, /<repository>:<run-id>:<source-job-id>:<holder-id-suffix>/);
  for (const output of [
    "reservation-id",
    "reservation-state",
    "available-at",
    "incident-id",
    "resource-health",
    "resource-reason",
    "report-degraded",
    "report-validation-error"
  ]) {
    assert.match(release, new RegExp(`^  ${output}:`, "m"));
  }
});

test("reaper exposes exact confirmed reservation and incident recovery inputs", () => {
  const reaper = readActionManifest("reap-stale-locks");
  const inputs = yamlRequiredTopLevelMappingKeys(reaper, "inputs", "reap-stale-locks/action.yml");
  for (const name of ["operation", "reservation-id", "resource-safe"]) {
    assert.ok(inputs.includes(name));
  }
  for (const name of ["incident-id", "portal-cleanup-confirmed"]) assert.ok(inputs.includes(name));
  assert.match(reaper, /operation:[\s\S]*?default:\s*reap/);
  assert.match(reaper, /resource-safe:[\s\S]*?default:\s*"false"/);
});

test("runner registration action requires reader App auth and fail-closed label sets", () => {
  const manifest = readActionManifest("check-unity-runner-availability");
  const inputs = yamlRequiredTopLevelMappingKeys(
    manifest,
    "inputs",
    "check-unity-runner-availability/action.yml"
  );
  const outputs = yamlRequiredTopLevelMappingKeys(
    manifest,
    "outputs",
    "check-unity-runner-availability/action.yml"
  );

  assert.deepEqual(inputs, ["reader-app-id", "reader-app-private-key", "owner", "required-label-sets"]);
  assert.deepEqual(outputs, ["registered-runner-count", "matched-runners"]);
  assert.match(manifest, /main:\s+\.\.\/\.\.\/dist\/check-unity-runners\.js/);
});

test("central Unity cleanup actions expose exact Node 24 policy contracts", () => {
  const changeClassifier = readActionManifest("classify-unity-changes");
  assert.deepEqual(
    yamlRequiredTopLevelMappingKeys(
      changeClassifier,
      "inputs",
      "classify-unity-changes/action.yml"
    ),
    ["event-name", "base-sha", "head-sha"]
  );
  assert.deepEqual(
    yamlRequiredTopLevelMappingKeys(
      changeClassifier,
      "outputs",
      "classify-unity-changes/action.yml"
    ),
    ["unity-required"]
  );
  assert.match(changeClassifier, /using:\s*node24/);
  assert.match(
    changeClassifier,
    /main:\s+\.\.\/\.\.\/dist\/classify-unity-changes\.js/
  );

  const classifier = readActionManifest("classify-unity-cleanup-evidence");
  assert.deepEqual(
    yamlRequiredTopLevelMappingKeys(
      classifier,
      "inputs",
      "classify-unity-cleanup-evidence/action.yml"
    ),
    [
      "return-log-path",
      "return-command-completed",
      "return-exit-code",
      "evidence-capture-complete",
      "return-log-digest",
      "supplemental-evidence-paths"
    ]
  );
  assert.deepEqual(
    yamlRequiredTopLevelMappingKeys(
      classifier,
      "outputs",
      "classify-unity-cleanup-evidence/action.yml"
    ),
    [
      "resource-safe",
      "resource-cleanup-status",
      "resource-health",
      "resource-reason",
      "classification-complete",
      "evidence-digest"
    ]
  );
  assert.match(classifier, /using:\s*node24/);
  assert.match(classifier, /main:\s+\.\.\/\.\.\/dist\/classify-unity-cleanup-evidence\.js/);
  assert.match(
    classifier,
    /return-log-digest:\s*\n(?: {4}.+\n)*? {4}required:\s*true/
  );
  assert.match(
    classifier,
    /classification-complete:\s*\n {4}description:.*verified central return evidence deletion/
  );

  const returnAction = readActionManifest("return-unity-license");
  assert.deepEqual(
    yamlRequiredTopLevelMappingKeys(
      returnAction,
      "inputs",
      "return-unity-license/action.yml"
    ),
    [
      "unity-version",
      "tool-cache",
      "unity-email",
      "unity-password",
      "evidence-suffix",
      "editor-layout"
    ]
  );
  assert.match(
    returnAction,
    /  editor-layout:\n    description: Closed reviewed editor layout; canonical or ci-managed-alternate\.\n    required: false\n    default: canonical\n/
  );
  assert.deepEqual(
    yamlRequiredTopLevelMappingKeys(
      returnAction,
      "outputs",
      "return-unity-license/action.yml"
    ),
    [
      "return-log-path",
      "return-command-completed",
      "return-exit-code",
      "evidence-capture-complete",
      "return-log-digest"
    ]
  );
  assert.match(returnAction, /using:\s*node24/);
  assert.match(returnAction, /main:\s+\.\.\/\.\.\/dist\/return-unity-license\.js/);

  const gate = readActionManifest("require-confirmed-unity-cleanup");
  assert.deepEqual(
    yamlRequiredTopLevelMappingKeys(gate, "inputs", "require-confirmed-unity-cleanup/action.yml"),
    [
      "acquired",
      "classification-complete",
      "cleanup-status",
      "cleanup-health",
      "cleanup-reason",
      "release-outcome",
      "cleanup-result",
      "released",
      "release-health",
      "release-reason",
      "reservation-state",
      "reservation-id",
      "incident-id"
    ]
  );
  assert.deepEqual(
    yamlRequiredTopLevelMappingKeys(gate, "outputs", "require-confirmed-unity-cleanup/action.yml"),
    ["cleanup-safe"]
  );
  assert.match(gate, /using:\s*node24/);
  assert.match(gate, /main:\s+\.\.\/\.\.\/dist\/require-confirmed-unity-cleanup\.js/);

  const validation = readActionManifest("require-unity-validation");
  assert.deepEqual(
    yamlRequiredTopLevelMappingKeys(validation, "inputs", "require-unity-validation/action.yml"),
    [
      "static-validation-result",
      "classifier-result",
      "unity-required",
      "trusted-revision",
      "preflight-result",
      "unity-result",
      "fallback-result",
      "fallback-cleanup-result"
    ]
  );
  assert.deepEqual(
    yamlRequiredTopLevelMappingKeys(validation, "outputs", "require-unity-validation/action.yml"),
    ["validation-safe"]
  );
  assert.match(validation, /using:\s*node24/);
  assert.match(validation, /main:\s+\.\.\/\.\.\/dist\/require-unity-validation\.js/);
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
  assert.match(readme, /`account-blocked` admission is an intentional nonzero, fail-closed/);
  assert.match(readme, /portal-cleanup-confirmed=true/);
  assert.match(readme, /require-current-pr-head@IMMUTABLE_COMMIT_SHA/);
  assert.match(readme, /strategy\.fail-fast: false/);
  assert.match(readme, /github-token: \$\{\{ github\.token \}\}/);
  assert.match(readme, /pull-request-number: \$\{\{ github\.event\.pull_request\.number \}\}/);
  assert.match(readme, /expected-head-sha: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
});

test("README documents configurable parallelism and transient-auth handling", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");

  assert.match(readme, /"maxHolders"/);
  assert.match(readme, /locks\/<lock-name>\.config\.json/);
  assert.match(readme, /BUILD_LOCK_AUTH_GRACE_MS/);
  assert.match(readme, /BUILD_LOCK_CONFIG_TTL_MS/);
});
