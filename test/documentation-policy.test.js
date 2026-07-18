const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");
const configPath = path.join(repoRoot, "locks", "wallstop-organization-builds.config.json");
const factsPath = path.join(repoRoot, "docs", "operations-facts.json");
const operationsPath = path.join(repoRoot, "docs", "operations-runbook.md");
const historyPath = path.join(repoRoot, "docs", "secure-two-seat-rollout.md");
const activeDocumentation = [
  path.join(repoRoot, "README.md"),
  path.join(repoRoot, "docs", "consumer-enrollment.md"),
  operationsPath,
  path.join(repoRoot, "locks", "README.md")
];
function read(file) {
  return fs.readFileSync(file, "utf8");
}

test("steady-state runbook reports live schema-5 configuration", () => {
  const config = JSON.parse(read(configPath));
  const facts = JSON.parse(read(factsPath));
  const operations = read(operationsPath);

  assert.equal(config.runnerSerialization, true);
  assert.equal(config.resourceLifecycle, true);
  assert.equal(config.accountHealth, true);
  assert.equal(facts.stateSchema, 5);
  assert.match(
    operations,
    new RegExp(`- State schema: \`${facts.stateSchema}\` \\(account health enabled\\)`)
  );
  assert.match(operations, new RegExp(`- Maximum holders: \`${config.maxHolders}\``));
  assert.match(
    operations,
    new RegExp(`- Confirmed-cleanup cooldown: \`${config.releaseCooldownSeconds}\` second(?:s)?`)
  );
  assert.match(operations, /- Runner serialization: `enabled`/);
  assert.match(operations, /- Resource lifecycle: `enabled`/);
});

test("steady-state runbook reports the registered release and consumer inventory", () => {
  const facts = JSON.parse(read(factsPath));
  const operations = read(operationsPath);
  const listedConsumers = [...operations.matchAll(/^- `([^`]+)` <!-- enrolled-consumer -->$/gm)].map(
    (match) => match[1]
  );

  assert.match(facts.publishedRelease.tag, /^v\d+\.\d+\.\d+$/);
  assert.match(facts.publishedRelease.commit, /^[a-f0-9]{40}$/);
  assert.match(
    operations,
    new RegExp(
      `- Published compatibility release: \`${facts.publishedRelease.tag}\` at\\s+\`${facts.publishedRelease.commit}\``
    )
  );
  assert.deepEqual(listedConsumers.sort(), [...facts.enrolledConsumers].sort());
});

test("steady-state runbook distinguishes required credential scope from the live gap", () => {
  const operations = read(operationsPath);

  assert.match(operations, /The required steady-state boundary is:/);
  assert.match(operations, /### Known live scope gap/);
  assert.match(operations, /2026-07-18[\s\S]*`repository_selection: all`/);
  assert.match(operations, /Issue #51 owns the restriction\s+and live negative probes/);
});

test("active documentation excludes obsolete rollout guidance", () => {
  const obsoleteClaims = [
    /keep `maxHolders: 1`/i,
    /keep `accountHealth: false`/i,
    /five original consumers/i,
    /reader App (?:has|with|using) all-repository access/i,
    /protected `unity-license` environment/i,
    /update the `unity-license` environment secrets/i,
    /live value is\s*`0`/i,
    /live release cooldown (?:is|of) 360 seconds/i
  ];

  for (const file of activeDocumentation) {
    const text = read(file);
    const normalizedText = text.replace(/\s+/g, " ");
    for (const claim of obsoleteClaims) {
      assert.doesNotMatch(
        normalizedText,
        claim,
        `${path.relative(repoRoot, file)} contains obsolete guidance`
      );
    }
  }
});

test("rollout history cannot be mistaken for the active runbook", () => {
  const history = read(historyPath);

  assert.match(history, /^# Historical Secure Two-Seat Unity Rollout/m);
  assert.match(history, /> \[!WARNING\][\s\S]*historical record[\s\S]*operations-runbook\.md/i);
});

test("documented remote actions use immutable references or explicit placeholders", () => {
  for (const file of activeDocumentation) {
    const text = read(file);
    for (const match of text.matchAll(/^\s*(?:-\s+)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
      const reference = match[1];
      if (reference.startsWith("./")) continue;
      assert.match(
        reference,
        /^[^/@\s]+\/[^/@\s]+(?:\/[^@\s]+)?@(?:[a-f0-9]{40}|[A-Z][A-Z0-9_]*_SHA)$/,
        `${path.relative(repoRoot, file)} must not recommend mutable action reference ${reference}`
      );
    }
  }
});
