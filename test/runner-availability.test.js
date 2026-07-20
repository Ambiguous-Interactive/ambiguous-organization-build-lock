const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  RUNNER_INVENTORY_TIMEOUT_MS,
  classifyRunnerInventoryError,
  execute,
  matchingOnlineRunners,
  parseRequiredLabelSets,
  parseRepository,
  readAccessibleOrganizationRunners,
  readAllRunnerGroups,
  runnerInventoryApiOptions,
  run
} = require("../.github/dist/check-unity-runners.js");

const testKey = crypto
  .generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" });

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
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

test("calling repository identity is canonical and organization-owned", () => {
  assert.equal(
    parseRepository("Ambiguous-Interactive/unity-helpers", "Ambiguous-Interactive"),
    "Ambiguous-Interactive/unity-helpers"
  );
  for (const invalid of [
    "",
    "unity-helpers",
    "Ambiguous-Interactive/unity-helpers/extra",
    "Other-Organization/unity-helpers",
    "Ambiguous-Interactive/unity helpers",
    "Ambiguous-Interactive/unity-helpers\n::error::injected"
  ]) {
    assert.throws(() => parseRepository(invalid, "Ambiguous-Interactive"), /repository/i);
  }
});

test("runner inventory uses a shared 150-second deadline and full-jitter retry policy", () => {
  const signal = new AbortController().signal;
  const options = runnerInventoryApiOptions(signal);

  assert.equal(RUNNER_INVENTORY_TIMEOUT_MS, 150_000);
  assert.deepEqual(
    {
      maxAttempts: options.maxAttempts,
      baseDelayMs: options.baseDelayMs,
      maxDelayMs: options.maxDelayMs,
      fullJitter: options.fullJitter,
      signal: options.signal
    },
    {
      maxAttempts: 13,
      baseDelayMs: 5000,
      maxDelayMs: 60000,
      fullJitter: true,
      signal
    }
  );
});

test("runner inventory failures distinguish API unavailability from runner unavailability", () => {
  const retryableCases = [
    { status: 500, requestId: "request-500" },
    { status: 502, requestId: "request-502" },
    { status: 429, requestId: "request-429" },
    { status: 401, requestId: "request-401" },
    { message: "fetch failed" }
  ];

  for (const details of retryableCases) {
    const error = Object.assign(new Error(details.message || `HTTP ${details.status}`), details, {
      retryable: true,
      attempts: 13,
      path: "/orgs/Ambiguous-Interactive/actions/runner-groups"
    });
    const classified = classifyRunnerInventoryError(error);

    assert.equal(classified.code, "RUNNER_INVENTORY_API_UNAVAILABLE");
    assert.match(classified.message, /not evidence that a required runner is offline/i);
    assert.match(classified.message, /failed closed/i);
    if (details.requestId) {
      assert.match(classified.message, new RegExp(details.requestId));
    }
  }

  for (const status of [403, 404]) {
    const error = Object.assign(new Error(`HTTP ${status}`), { status, retryable: false });
    assert.equal(classifyRunnerInventoryError(error), error, `ordinary HTTP ${status} must remain fail-fast`);
  }
});

test("accessible runner-group pagination fails closed on malformed responses", async () => {
  const pages = [
    {
      total_count: 101,
      runner_groups: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }))
    },
    { total_count: 101, runner_groups: [{ id: 101 }] }
  ];
  const paths = [];
  const groups = await readAllRunnerGroups(
    "Ambiguous-Interactive",
    "unity-helpers",
    async (path) => {
      paths.push(path);
      return pages.shift();
    }
  );

  assert.equal(groups.length, 101);
  assert.deepEqual(paths, [
    "/orgs/Ambiguous-Interactive/actions/runner-groups?visible_to_repository=unity-helpers&per_page=100&page=1",
    "/orgs/Ambiguous-Interactive/actions/runner-groups?visible_to_repository=unity-helpers&per_page=100&page=2"
  ]);

  for (const response of [
    null,
    {},
    { total_count: "1", runner_groups: [] },
    { total_count: 1, runner_groups: null }
  ]) {
    await assert.rejects(
      () =>
        readAllRunnerGroups(
          "Ambiguous-Interactive",
          "unity-helpers",
          async () => response
        ),
      /runner-group inventory/i
    );
  }

  await assert.rejects(
    () =>
      readAllRunnerGroups(
        "Ambiguous-Interactive",
        "unity-helpers",
        async () => ({
          total_count: 101,
          runner_groups: Array.from({ length: 100 }, (_, id) => ({ id }))
        }),
        1
      ),
    /pagination exceeded/i
  );
});

test("only runners in repository-visible groups are returned", async () => {
  const paths = [];
  const runners = await readAccessibleOrganizationRunners(
    "Ambiguous-Interactive",
    "unity-helpers",
    async (path) => {
      paths.push(path);
      if (path.includes("runner-groups?")) {
        return { total_count: 1, runner_groups: [{ id: 42, name: "Unity" }] };
      }
      if (path.includes("runner-groups/42/runners")) {
        return {
          total_count: 1,
          runners: [{ id: 7, name: "accessible-unity-runner", status: "online", labels: [] }]
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    }
  );

  assert.deepEqual(runners.map((runner) => runner.id), [7]);
  assert.deepEqual(paths, [
    "/orgs/Ambiguous-Interactive/actions/runner-groups?visible_to_repository=unity-helpers&per_page=100&page=1",
    "/orgs/Ambiguous-Interactive/actions/runner-groups/42/runners?per_page=100&page=1"
  ]);

  await assert.rejects(
    () =>
      readAccessibleOrganizationRunners(
        "Ambiguous-Interactive",
        "unity-helpers",
        async (path) =>
          path.includes("runner-groups?")
            ? { total_count: 0, runner_groups: [] }
            : { total_count: 0, runners: [] }
      ),
    /no runner groups visible/i
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
  process.env.GITHUB_REPOSITORY = "Ambiguous-Interactive/unity-helpers";
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
    if (parsed.pathname === "/orgs/Ambiguous-Interactive/actions/runner-groups") {
      assert.equal(options.headers.Authorization, "Bearer short-lived-reader-token");
      assert.equal(parsed.searchParams.get("visible_to_repository"), "unity-helpers");
      return jsonResponse({ total_count: 1, runner_groups: [{ id: 42, name: "Unity" }] });
    }
    if (parsed.pathname === "/orgs/Ambiguous-Interactive/actions/runner-groups/42/runners") {
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
  await assert.rejects(() => execute(), /No accessible online organization runner matches/);
});

test("runner retry policy also covers GitHub App installation discovery", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  const originalLog = console.log;

  t.after(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    console.log = originalLog;
  });

  console.log = () => {};
  process.env["INPUT_READER-APP-ID"] = "12345";
  process.env["INPUT_READER-APP-PRIVATE-KEY"] = testKey;
  process.env.INPUT_OWNER = "Ambiguous-Interactive";
  process.env.GITHUB_REPOSITORY = "Ambiguous-Interactive/unity-helpers";
  process.env["INPUT_REQUIRED-LABEL-SETS"] = '[["self-hosted","Windows","unity"]]';

  let installationCalls = 0;
  global.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/orgs/Ambiguous-Interactive/installation") {
      installationCalls++;
      if (installationCalls < 4) {
        return jsonResponse(
          { message: "upstream unavailable" },
          502,
          { "x-github-request-id": `auth-${installationCalls}` }
        );
      }
      return jsonResponse({ id: 99 });
    }
    if (parsed.pathname === "/app/installations/99/access_tokens") {
      return jsonResponse({ token: "short-lived-reader-token", expires_at: "2099-01-01T00:00:00Z" });
    }
    if (parsed.pathname === "/orgs/Ambiguous-Interactive/actions/runner-groups") {
      return jsonResponse({ total_count: 1, runner_groups: [{ id: 42, name: "Unity" }] });
    }
    if (parsed.pathname === "/orgs/Ambiguous-Interactive/actions/runner-groups/42/runners") {
      return jsonResponse({
        total_count: 1,
        runners: [{
          id: 1,
          name: "windows-unity",
          status: "online",
          labels: [{ name: "self-hosted" }, { name: "Windows" }, { name: "unity" }]
        }]
      });
    }
    return jsonResponse({ message: "unexpected test request" }, 404);
  };

  const result = await execute({
    signal: new AbortController().signal,
    apiOptions: {
      maxAttempts: 4,
      baseDelayMs: 0,
      maxDelayMs: 0,
      random: () => 0,
      sleep: async () => {}
    }
  });

  assert.equal(installationCalls, 4);
  assert.equal(result.onlineRunnerCount, 1);
});

test("terminal runner preflight preserves classified API diagnostics safely", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runner-preflight-terminal-"));
  const controller = new AbortController();
  const errors = [];

  t.after(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  console.log = () => {};
  console.error = (message) => errors.push(String(message));
  process.exitCode = 0;
  process.env["INPUT_READER-APP-ID"] = "12345";
  process.env["INPUT_READER-APP-PRIVATE-KEY"] = testKey;
  process.env.INPUT_OWNER = "Ambiguous-Interactive";
  process.env.GITHUB_REPOSITORY = "Ambiguous-Interactive/unity-helpers";
  process.env["INPUT_REQUIRED-LABEL-SETS"] = '[["self-hosted","Windows","unity"]]';
  process.env.GITHUB_STEP_SUMMARY = path.join(tempRoot, "summary.md");

  global.fetch = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/orgs/Ambiguous-Interactive/installation");
    return jsonResponse(
      { message: "upstream auth\nunavailable%temporarily" },
      502,
      { "x-github-request-id": "terminal-auth-request" }
    );
  };

  await run({
    signal: controller.signal,
    apiOptions: {
      maxAttempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 1000,
      sleep: async (_delay, { signal }) => {
        controller.abort(new DOMException("runner inventory deadline elapsed", "TimeoutError"));
        throw signal.reason;
      }
    }
  });

  assert.equal(process.exitCode, 1);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /^::warning::/);
  assert.match(errors[0], /API\/auth availability failure/);
  assert.match(errors[1], /^::error::Unity runner preflight failed closed:/);
  for (const command of errors) {
    assert.equal(/[\r\n]/.test(command), false, "workflow commands must stay on one line");
    assert.match(command, /upstream auth unavailable%25temporarily/);
    assert.equal(command.split("terminal-auth-request").length - 1, 1, "request ID must not be duplicated");
  }
});

test("runtime validates repository identity before parsing credentials or making requests", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  t.after(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  process.env["INPUT_READER-APP-ID"] = "not-an-app-id";
  process.env["INPUT_READER-APP-PRIVATE-KEY"] = "not-a-key";
  process.env.INPUT_OWNER = "Ambiguous-Interactive";
  process.env.GITHUB_REPOSITORY = "Other-Organization/unity-helpers";
  process.env["INPUT_REQUIRED-LABEL-SETS"] = '[["self-hosted","Windows"]]';
  global.fetch = async () => assert.fail("repository validation must precede network access");

  await assert.rejects(() => execute(), /repository owner is not authorized/i);
});
