const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");
const configPath = path.join(repoRoot, "locks", "wallstop-organization-builds.config.json");
const factsPath = path.join(repoRoot, "docs", "operations-facts.json");
const enrollmentPolicyPath = path.join(repoRoot, "unity-enrollment-policy.json");
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

test("reaper delivery SLO facts and guidance stay synchronized", () => {
  const facts = JSON.parse(read(factsPath));
  const operations = read(operationsPath);
  const readme = read(path.join(repoRoot, "README.md"));

  assert.deepEqual(facts.reaperDelivery, {
    requestedSchedule: "*/5 * * * *",
    monitorSchedule: "7,17,27,37,47,57 * * * *",
    maximumDeliveryDelaySeconds: 1800,
    maximumRunDurationSeconds: 900
  });
  assert.match(operations, /requested five-minute cron is not a guaranteed delivery cadence/i);
  assert.match(operations, /30-minute delivery threshold/);
  assert.match(operations, /15-minute run-duration threshold/);
  assert.match(operations, /independent `Reaper delivery audit` workflow/);
  assert.match(operations, /run IDs, timestamps,\s+reason codes, and commit SHAs only/);
  assert.match(operations, /separate `Recover build lock` workflow/);
  assert.match(operations, /no automatic concurrency\s+cancellation/);
  assert.match(operations, /cannot replace or cancel running or\s+pending recovery/);
  assert.match(readme, /requests reaping every five minutes/i);
  assert.doesNotMatch(readme, /reaper(?: workflow)? runs every 5 minutes/i);
});

test("incident recovery alert facts and guidance stay synchronized", () => {
  const facts = JSON.parse(read(factsPath));
  const operations = read(operationsPath).replace(/\s+/g, " ");
  const locks = read(path.join(repoRoot, "locks", "README.md")).replace(/\s+/g, " ");

  assert.deepEqual(facts.incidentRecoveryAudit, {
    schedule: "2,12,22,32,42,52 * * * *",
    alertMarker: "build-lock-incident-recovery",
    stateRef: "lock-state",
    recoveryWorkflow: ".github/workflows/recover-build-lock.yml"
  });
  assert.match(operations, /`Build lock incident recovery audit`/);
  assert.match(
    operations,
    new RegExp(`runs at \`${facts.incidentRecoveryAudit.schedule.replace(/\*/g, "\\*")}\``)
  );
  assert.match(operations, /reads committed `lock-state` JSON through the workflow token/);
  assert.match(operations, /exact incident identifier and the declared `recover-incident` inputs/);
  assert.match(operations, /never opens, edits, or closes the alert on unprovable state/);
  assert.match(operations, /leaves any existing alert exactly as it was/);
  assert.match(operations, /omitted incident ID is frozen from the first canonical state read/);
  assert.match(operations, /closes the alert without rewriting it/);
  assert.match(operations, /covers the global account incident only/);
  assert.match(
    locks,
    /Operators do not need to read this branch to recover an incident/,
    "lock state guidance must point operators at the published alert"
  );
});

test("steady-state runbook reports the registered release and consumer inventory", () => {
  const facts = JSON.parse(read(factsPath));
  const enrollmentPolicy = JSON.parse(read(enrollmentPolicyPath));
  const operations = read(operationsPath);
  const listedBaseline = [...operations.matchAll(/^- `([^`]+)` <!-- enrollment-baseline -->$/gm)].map(
    (match) => match[1]
  );
  const requiredBaseline = [
    "Ambiguous-Interactive/DoxReloaded",
    "Ambiguous-Interactive/DxMessaging",
    "Ambiguous-Interactive/IshoBoy",
    "Ambiguous-Interactive/qora-redux",
    "Ambiguous-Interactive/unity-builder",
    "Ambiguous-Interactive/unity-helpers"
  ];

  assert.match(facts.publishedRelease.tag, /^v\d+\.\d+\.\d+$/);
  assert.match(facts.publishedRelease.commit, /^[a-f0-9]{40}$/);
  assert.match(
    operations,
    new RegExp(
      `- Published compatibility release: \`${facts.publishedRelease.tag}\` at\\s+\`${facts.publishedRelease.commit}\``
    )
  );
  assert.deepEqual(listedBaseline.sort(), requiredBaseline.sort());
  const registered = new Set(enrollmentPolicy.repositories.map((entry) => entry.repository));
  for (const repository of requiredBaseline) {
    assert.equal(registered.has(repository), true);
  }
  assert.match(operations, /`unity-enrollment-policy\.json` is the authoritative reviewed/);
  assert.equal(enrollmentPolicy.repositories.find((entry) => entry.repository.endsWith("/unity-builder")).fork, true);
  assert.ok(enrollmentPolicy.approvedLockShas.includes(facts.publishedRelease.commit));
  assert.ok(Array.isArray(enrollmentPolicy.approvedReturnShas));
  assert.ok(enrollmentPolicy.approvedReturnShas.every(
    (sha) => enrollmentPolicy.approvedLockShas.includes(sha)
  ));
});

test("continuous enrollment audit facts and guidance stay synchronized", () => {
  const facts = JSON.parse(read(factsPath));
  const operations = read(operationsPath);
  const readme = read(path.join(repoRoot, "README.md"));

  assert.deepEqual(facts.unityEnrollmentAudit, {
    policyPath: "unity-enrollment-policy.json",
    schedule: "23 8 * * *",
    onboardingWorkflow: "Request Unity repository onboarding",
    alertMarker: "unity-enrollment-audit:v1"
  });
  assert.match(operations, /`Organization Unity enrollment audit`/);
  assert.match(operations, /runs daily at `23 8 \* \* \*`/);
  assert.match(operations, /analyzes exact Git\s+objects without executing consumer code/);
  assert.match(operations, /repository, commit, workflow path, job, classification, and stable reason\s+code/);
  assert.match(operations, /complete clean audit/);
  assert.match(operations, /registry exception with repository, path, classification, owner, and RFC3339\s+expiry/);
  assert.match(operations, /`Request Unity repository\s+onboarding` workflow on `main`/);
  assert.match(operations, /reader-App token scope, checkout targets, and exact-head\s+revalidation set from the validated registry/);
  assert.match(operations, /complete source-free JSON audit is retained as a 30-day Actions artifact/);
  assert.match(operations, /deterministic bounded preview, and explicit omitted-row\s+counts/);
  assert.match(readme, /`unity-enrollment-policy\.json`/);
  assert.match(readme, /secretless `Request Unity repository\s+onboarding` workflow on `main`/);
  assert.match(readme, /one\s+deduplicated issue/);
  assert.match(readme, /complete source-free JSON audit for 30 days/);
  assert.match(readme, /deterministic bounded preview with explicit omission counts/);
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
