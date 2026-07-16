const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  execute,
  matchingOnlineRunners,
  parseRequiredLabelSets,
  readAllOrganizationRunners
} = require("../.github/dist/check-unity-runners.js");

const testKey = crypto
  .generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" });

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("required runner label sets are strict non-empty JSON arrays", () => {
  assert.deepEqual(parseRequiredLabelSets('[["self-hosted","Windows","unity"]]'), [
    ["self-hosted", "windows", "unity"]
  ]);

  for (const invalid of [
    "",
    "{}",
    "[]",
    "[[]]",
    '[["self-hosted",""]]',
    '[["Windows"]]',
    '[["self-hosted","Windows\\n::error::injected"]]'
  ]) {
    assert.throws(() => parseRequiredLabelSets(invalid), /required-label-sets/i);
  }
});

test("runner matching requires every label and an online status", () => {
  const runners = [
    {
      id: 1,
      name: "windows-online-busy",
      status: "online",
      busy: true,
      labels: [{ name: "self-hosted" }, { name: "Windows" }, { name: "unity" }]
    },
    {
      id: 2,
      name: "linux-offline",
      status: "offline",
      busy: false,
      labels: [{ name: "self-hosted" }, { name: "Linux" }, { name: "unity" }]
    },
    {
      id: 3,
      name: "linux-missing-unity-label",
      status: "online",
      busy: false,
      labels: [{ name: "self-hosted" }, { name: "Linux" }]
    }
  ];

  assert.deepEqual(
    matchingOnlineRunners(runners, ["self-hosted", "windows", "unity"]).map((runner) => runner.id),
    [1],
    "an online busy runner is available infrastructure and may queue work"
  );
  assert.deepEqual(matchingOnlineRunners(runners, ["self-hosted", "linux", "unity"]), []);
});

test("organization runner inventory pagination fails closed on malformed responses", async () => {
  const pages = [
    { total_count: 101, runners: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) },
    { total_count: 101, runners: [{ id: 101 }] }
  ];
  const paths = [];
  const runners = await readAllOrganizationRunners("Ambiguous-Interactive", async (path) => {
    paths.push(path);
    return pages.shift();
  });

  assert.equal(runners.length, 101);
  assert.deepEqual(paths, [
    "/orgs/Ambiguous-Interactive/actions/runners?per_page=100&page=1",
    "/orgs/Ambiguous-Interactive/actions/runners?per_page=100&page=2"
  ]);

  for (const response of [null, {}, { total_count: "1", runners: [] }, { total_count: 1, runners: null }]) {
    await assert.rejects(
      () => readAllOrganizationRunners("Ambiguous-Interactive", async () => response),
      /runner inventory/i
    );
  }

  await assert.rejects(
    () =>
      readAllOrganizationRunners(
        "Ambiguous-Interactive",
        async () => ({ total_count: 101, runners: Array.from({ length: 100 }, (_, id) => ({ id })) }),
        1
      ),
    /pagination exceeded/i
  );
});

test("runtime requests only organization runner read permission and rejects an empty match", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  const originalLog = console.log;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runner-preflight-"));

  t.after(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    console.log = originalLog;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  console.log = () => {};

  process.env["INPUT_READER-APP-ID"] = "12345";
  process.env["INPUT_READER-APP-PRIVATE-KEY"] = testKey;
  process.env.INPUT_OWNER = "Ambiguous-Interactive";
  process.env["INPUT_REQUIRED-LABEL-SETS"] = '[["self-hosted","Windows","unity"]]';
  process.env.GITHUB_OUTPUT = path.join(tempRoot, "output.txt");
  process.env.GITHUB_STEP_SUMMARY = path.join(tempRoot, "summary.md");

  let tokenRequest;
  global.fetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/orgs/Ambiguous-Interactive/installation") {
      return jsonResponse({ id: 99 });
    }
    if (parsed.pathname === "/app/installations/99/access_tokens") {
      tokenRequest = JSON.parse(options.body);
      return jsonResponse({ token: "short-lived-reader-token", expires_at: "2099-01-01T00:00:00Z" });
    }
    if (parsed.pathname === "/orgs/Ambiguous-Interactive/actions/runners") {
      assert.equal(options.headers.Authorization, "Bearer short-lived-reader-token");
      return jsonResponse({
        total_count: 1,
        runners: [
          {
            id: 1,
            name: "windows-unity",
            status: "online",
            busy: false,
            labels: [{ name: "self-hosted" }, { name: "Windows" }, { name: "unity" }]
          }
        ]
      });
    }
    return jsonResponse({ message: "unexpected test request" }, 404);
  };

  const result = await execute();
  assert.deepEqual(tokenRequest, { permissions: { organization_self_hosted_runners: "read" } });
  assert.equal(result.onlineRunnerCount, 1);
  assert.match(fs.readFileSync(process.env.GITHUB_OUTPUT, "utf8"), /^online-runner-count=1$/m);

  process.env["INPUT_REQUIRED-LABEL-SETS"] = '[["self-hosted","Linux","unity"]]';
  await assert.rejects(() => execute(), /No online organization runner matches/);
});
