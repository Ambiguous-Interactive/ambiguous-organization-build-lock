const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  acquire,
  api,
  authorizeCaller,
  config,
  createAppJwt,
  createGitHubAppAuth,
  credential,
  emptyState: productionEmptyState,
  evaluateStale,
  installAcquireSignalCleanup,
  isRetryableResponse,
  normalizeState,
  parseReleaseReport,
  postCleanup,
  readLockConfig,
  readerCredential,
  release,
  reap,
  runCancellationCleanup,
  selectEligibleQueueEntries,
  writeState
} = require("../.github/dist/build-lock.js");

const testAppKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const testAppPrivateKey = testAppKeys.privateKey.export({ type: "pkcs8", format: "pem" });

// Older unit fixtures exercise the supported schema-1 singleton shape. New schema-2
// and schema-3 behavior uses the explicit semaphoreState helper below.
function emptyState(lockName) {
  return productionEmptyState(lockName, 1);
}

function jsonResponse(status, body = {}, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers
    }
  });
}

const actionEnvNames = [
  "GITHUB_REPOSITORY",
  "GITHUB_REPOSITORY_ID",
  "GITHUB_REPOSITORY_OWNER_ID",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_WORKFLOW",
  "GITHUB_JOB",
  "GITHUB_OUTPUT",
  "GITHUB_STEP_SUMMARY",
  "GITHUB_STATE",
  "STATE_build_lock_cleanup"
];

const authorizedConsumerEnv = {
  GITHUB_REPOSITORY: "Ambiguous-Interactive/unity-helpers",
  GITHUB_REPOSITORY_ID: "737391131",
  GITHUB_REPOSITORY_OWNER_ID: "212056428"
};

const acquireOutputNames = [
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

const releaseOutputNames = [
  "released",
  "queue-cleaned",
  "cleanup-result",
  "lock-name",
  "holder-id",
  "state-sha",
  "held-by",
  "held-by-run-url",
  "reservation-id",
  "reservation-state",
  "available-at",
  "incident-id",
  "resource-health",
  "resource-reason"
];

const reapOutputNames = ["reaped", "state-sha"];

async function withActionEnv(values, callback) {
  const previous = Object.fromEntries(actionEnvNames.map((name) => [name, process.env[name]]));
  for (const name of actionEnvNames) {
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      process.env[name] = values[name];
    } else {
      delete process.env[name];
    }
  }
  try {
    return await callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

async function withEnvironment(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return await callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

async function withImmediateTimers(callback) {
  const previousSetTimeout = global.setTimeout;
  global.setTimeout = (handler, _timeout, ...args) => previousSetTimeout(handler, 0, ...args);
  try {
    return await callback();
  } finally {
    global.setTimeout = previousSetTimeout;
  }
}

async function withTempFile(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "build-lock-test-"));
  const file = path.join(directory, "env-file");
  fs.writeFileSync(file, "", "utf8");
  try {
    return await callback(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function readEnvironmentFile(file) {
  const entries = [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line === "") {
      return;
    }
    const equals = line.indexOf("=");
    assert.notEqual(equals, -1, `${file}:${index + 1} must be NAME=VALUE, got ${JSON.stringify(line)}`);
    assert.notEqual(equals, 0, `${file}:${index + 1} must use a non-empty name, got ${JSON.stringify(line)}`);
    entries.push([line.slice(0, equals), line.slice(equals + 1)]);
  });
  const names = entries.map(([name]) => name);
  assert.equal(new Set(names).size, names.length, `environment file must not contain duplicate names: ${names.join(", ")}`);
  return Object.fromEntries(entries);
}

function assertOutputContract(outputs, names) {
  assert.deepEqual(Object.keys(outputs).sort(), [...names].sort());
}

test("environment file parser fails closed on malformed output lines", async () => {
  await withTempFile(async (file) => {
    fs.writeFileSync(file, "valid=value\nmissing-equals\n", "utf8");

    assert.throws(
      () => readEnvironmentFile(file),
      new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:2 must be NAME=VALUE`)
    );
  });
});

test("environment file parser rejects empty names", async () => {
  await withTempFile(async (file) => {
    fs.writeFileSync(file, "=value\n", "utf8");

    assert.throws(
      () => readEnvironmentFile(file),
      new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:1 must use a non-empty name`)
    );
  });
});

async function withMockedFetch(fetchImplementation, callback) {
  const previousFetch = global.fetch;
  const previousLog = console.log;
  const logs = [];
  global.fetch = fetchImplementation;
  console.log = (line) => {
    logs.push(String(line));
  };
  try {
    return await callback(logs);
  } finally {
    global.fetch = previousFetch;
    console.log = previousLog;
  }
}

test("api retries transient GitHub API failures", async (t) => {
  const cases = [
    { status: 408, name: "request timeout" },
    { status: 429, name: "rate limit" },
    { status: 500, name: "server error" },
    { status: 502, name: "bad gateway" },
    { status: 503, name: "service unavailable" },
    { status: 504, name: "gateway timeout" }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let calls = 0;
      let sleeps = 0;
      await withMockedFetch(
        async () => {
          calls++;
          if (calls === 1) {
            return jsonResponse(testCase.status, { message: testCase.name }, { "x-github-request-id": "ABC123" });
          }
          return jsonResponse(200, { ok: true });
        },
        async (logs) => {
        const result = await api("PUT", "/repos/o/r/contents/locks/x.json", { x: 1 }, "token", {
          maxAttempts: 2,
          baseDelayMs: 0,
          maxDelayMs: 0,
          sleep: async () => {
            sleeps++;
          }
        });

        assert.deepEqual(result, { ok: true });
        assert.equal(calls, 2);
        assert.equal(sleeps, 1);
          assert.match(logs.join("\n"), /request-id=ABC123/);
        }
      );
    });
  }
});

test("api retries fetch failures before receiving a response", async () => {
  let calls = 0;
  await withMockedFetch(
    async () => {
      calls++;
      if (calls === 1) {
        throw new TypeError("fetch failed");
      }
      return jsonResponse(200, { ok: true });
    },
    async (logs) => {
    const result = await api("GET", "/repos/o/r", undefined, "token", {
      maxAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
      sleep: async () => {}
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
      assert.match(logs.join("\n"), /fetch failed/);
    }
  );
});

test("api does not retry expected contents CAS conflicts", async (t) => {
  for (const status of [409, 422]) {
    await t.test(`HTTP ${status}`, async () => {
      let calls = 0;
      await withMockedFetch(
        async () => {
          calls++;
          return jsonResponse(status, { message: "conflict" });
        },
        async () => {
        await assert.rejects(
          () =>
            api("PUT", "/repos/o/r/contents/locks/x.json", { x: 1 }, "token", {
              maxAttempts: 3,
              baseDelayMs: 0,
              maxDelayMs: 0,
              sleep: async () => {}
            }),
          (error) => {
            assert.equal(error.status, status);
            return true;
          }
        );
        assert.equal(calls, 1);
        }
      );
    });
  }
});

test("api fails fast for non-retryable auth and configuration responses", async (t) => {
  const cases = [
    { status: 400, message: "bad request" },
    { status: 403, message: "Resource not accessible by integration" },
    { status: 404, message: "not found" }
  ];

  for (const testCase of cases) {
    await t.test(`HTTP ${testCase.status}`, async () => {
      let calls = 0;
      await withMockedFetch(
        async () => {
          calls++;
          return jsonResponse(testCase.status, { message: testCase.message }, { "x-github-request-id": "REQID" });
        },
        async (logs) => {
          await assert.rejects(
            () =>
              api("GET", "/repos/o/r", undefined, "token", {
                maxAttempts: 3,
                baseDelayMs: 0,
                maxDelayMs: 0,
                sleep: async () => {}
              }),
            (error) => {
              assert.equal(error.status, testCase.status);
              assert.match(error.message, /request-id=REQID/);
              return true;
            }
          );
          assert.equal(calls, 1);
          assert.equal(logs.length, 0);
        }
      );
    });
  }
});

test("api retries transient 401 responses before succeeding", async (t) => {
  // GitHub intermittently returns 401 "Bad credentials" for valid tokens (auth replica lag);
  // GitHub's own guidance is to retry at least once with a delay. See issue #12.
  for (const method of ["GET", "PUT"]) {
    await t.test(method, async () => {
      let calls = 0;
      let sleeps = 0;
      await withMockedFetch(
        async () => {
          calls++;
          if (calls === 1) {
            return jsonResponse(401, { message: "Bad credentials" }, { "x-github-request-id": "AUTH401" });
          }
          return jsonResponse(200, { ok: true });
        },
        async (logs) => {
          const result = await api(
            method,
            "/repos/o/r/contents/locks/x.json",
            method === "PUT" ? { x: 1 } : undefined,
            "token",
            {
              maxAttempts: 2,
              baseDelayMs: 0,
              maxDelayMs: 0,
              sleep: async () => {
                sleeps++;
              }
            }
          );

          assert.deepEqual(result, { ok: true });
          assert.equal(calls, 2);
          assert.equal(sleeps, 1);
          assert.match(logs.join("\n"), /HTTP 401; retrying/);
          assert.match(logs.join("\n"), /request-id=AUTH401/);
        }
      );
    });
  }
});

test("api surfaces persistent 401 responses after exhausting retries", async () => {
  let calls = 0;
  await withMockedFetch(
    async () => {
      calls++;
      return jsonResponse(401, { message: "Bad credentials" }, { "x-github-request-id": "AUTH401" });
    },
    async () => {
      await assert.rejects(
        () =>
          api("GET", "/repos/o/r", undefined, "token", {
            maxAttempts: 3,
            baseDelayMs: 0,
            maxDelayMs: 0,
            sleep: async () => {}
          }),
        (error) => {
          assert.equal(error.status, 401);
          assert.match(error.message, /Bad credentials/);
          return true;
        }
      );
      assert.equal(calls, 3);
    }
  );
});

test("GitHub App JWT uses bounded RS256 claims and a valid signature", () => {
  const now = Date.parse("2026-07-11T12:00:00Z");
  const jwt = createAppJwt("12345", testAppKeys.privateKey, now);
  const [headerPart, payloadPart, signaturePart] = jwt.split(".");
  const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));

  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.deepEqual(payload, {
    iat: Math.floor(now / 1000) - 60,
    exp: Math.floor(now / 1000) + 540,
    iss: "12345"
  });
  assert.equal(
    crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${headerPart}.${payloadPart}`),
      testAppKeys.publicKey,
      Buffer.from(signaturePart, "base64url")
    ),
    true
  );
});

test("GitHub App auth caches and refreshes installation tokens before expiry", async () => {
  let now = Date.parse("2026-07-11T12:00:00Z");
  let installationReads = 0;
  let tokenMints = 0;
  const auth = createGitHubAppAuth({
    appId: "12345",
    privateKey: testAppPrivateKey,
    owner: "Ambiguous-Interactive",
    now: () => now
  });

  await withMockedFetch(async (url, options = {}) => {
    const parsed = new URL(url);
    assert.match(options.headers.Authorization, /^Bearer ey/);
    if (parsed.pathname === "/orgs/Ambiguous-Interactive/installation") {
      installationReads++;
      return jsonResponse(200, { id: 987 });
    }
    if (parsed.pathname === "/app/installations/987/access_tokens") {
      tokenMints++;
      return jsonResponse(201, {
        token: `installation-token-${tokenMints}`,
        expires_at: new Date(now + 60 * 60 * 1000).toISOString()
      });
    }
    return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
  }, async (logs) => {
    assert.deepEqual(await Promise.all([auth.getToken(), auth.getToken()]), [
      "installation-token-1",
      "installation-token-1"
    ]);
    now += 56 * 60 * 1000;
    assert.equal(await auth.getToken(), "installation-token-2");
    assert.ok(logs.includes("::add-mask::installation-token-1"));
    assert.ok(logs.includes("::add-mask::installation-token-2"));
    assert.equal(
      logs.filter((line) => !line.startsWith("::add-mask::")).join("\n").includes("installation-token-"),
      false
    );
  });

  assert.equal(installationReads, 1);
  assert.equal(tokenMints, 2);
});

test("api refreshes GitHub App credentials immediately after a 401", async () => {
  const now = Date.parse("2026-07-11T12:00:00Z");
  let tokenMints = 0;
  let resourceCalls = 0;
  const auth = createGitHubAppAuth({
    appId: "12345",
    privateKey: testAppPrivateKey,
    owner: "Ambiguous-Interactive",
    now: () => now
  });

  await withMockedFetch(async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/orgs/Ambiguous-Interactive/installation") {
      return jsonResponse(200, { id: 987 });
    }
    if (parsed.pathname === "/app/installations/987/access_tokens") {
      tokenMints++;
      return jsonResponse(201, {
        token: `installation-token-${tokenMints}`,
        expires_at: new Date(now + 60 * 60 * 1000).toISOString()
      });
    }
    if (parsed.pathname === "/repos/o/r/contents/lock.json") {
      resourceCalls++;
      if (options.headers.Authorization === "Bearer installation-token-1") {
        return jsonResponse(401, { message: "Bad credentials" });
      }
      assert.equal(options.headers.Authorization, "Bearer installation-token-2");
      return jsonResponse(200, { ok: true });
    }
    return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
  }, async () => {
    assert.deepEqual(await api("GET", "/repos/o/r/contents/lock.json", undefined, auth), { ok: true });
  });

  assert.equal(tokenMints, 2);
  assert.equal(resourceCalls, 2);
});

test("api performs at most one renewable credential refresh per logical request", async () => {
  let token = "token-1";
  let invalidations = 0;
  let tokenReads = 0;
  let resourceCalls = 0;
  const auth = {
    renewable: true,
    async getToken() {
      tokenReads++;
      return token;
    },
    invalidateToken(rejected) {
      invalidations++;
      assert.equal(rejected, "token-1");
      token = "token-2";
    }
  };

  await withMockedFetch(async () => {
    resourceCalls++;
    return jsonResponse(401, { message: "Bad credentials" });
  }, async () => {
    await assert.rejects(
      () => api("GET", "/repos/o/r", undefined, auth, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }),
      /HTTP 401/
    );
  });

  assert.equal(invalidations, 1);
  assert.equal(resourceCalls, 4, "three normal attempts plus one immediate refreshed replay");
  assert.equal(tokenReads, 4);
});

test("GitHub App installation lookup honors cancellation", async () => {
  const controller = new AbortController();
  const auth = createGitHubAppAuth({
    appId: "12345",
    privateKey: testAppPrivateKey,
    owner: "Ambiguous-Interactive"
  });

  await withMockedFetch(async (_url, options = {}) => {
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      setTimeout(() => controller.abort(new Error("cancel auth lookup")), 0);
    });
  }, async () => {
    await assert.rejects(
      () => api("GET", "/repos/o/r", undefined, auth, { signal: controller.signal }),
      /cancel auth lookup/
    );
  });
});

test("concurrent GitHub App token waiters cancel independently", async () => {
  const firstController = new AbortController();
  const secondController = new AbortController();
  let finishInstallationLookup;
  const auth = createGitHubAppAuth({
    appId: "12345",
    privateKey: testAppPrivateKey,
    owner: "Ambiguous-Interactive"
  });

  await withMockedFetch(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/orgs/Ambiguous-Interactive/installation") {
      return new Promise((resolve) => {
        finishInstallationLookup = () => resolve(jsonResponse(200, { id: 987 }));
      });
    }
    if (parsed.pathname === "/app/installations/987/access_tokens") {
      return jsonResponse(201, {
        token: "shared-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      });
    }
    return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
  }, async () => {
    const first = auth.getToken({ signal: firstController.signal });
    const second = auth.getToken({ signal: secondController.signal });
    await new Promise((resolve) => setImmediate(resolve));
    firstController.abort(new Error("first waiter cancelled"));
    finishInstallationLookup();

    await assert.rejects(first, /first waiter cancelled/);
    assert.equal(await second, "shared-token");
  });
});

test("GitHub App auth re-discovers a replaced installation once", async () => {
  let now = Date.parse("2026-07-11T12:00:00Z");
  let installationReads = 0;
  const auth = createGitHubAppAuth({
    appId: "12345",
    privateKey: testAppPrivateKey,
    owner: "Ambiguous-Interactive",
    now: () => now
  });

  await withMockedFetch(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/orgs/Ambiguous-Interactive/installation") {
      installationReads++;
      return jsonResponse(200, { id: installationReads === 1 ? 111 : 222 });
    }
    if (parsed.pathname === "/app/installations/111/access_tokens") {
      if (now > Date.parse("2026-07-11T12:00:00Z")) {
        return jsonResponse(404, { message: "installation replaced" });
      }
      return jsonResponse(201, {
        token: "old-installation-token",
        expires_at: new Date(now + 60 * 60 * 1000).toISOString()
      });
    }
    if (parsed.pathname === "/app/installations/222/access_tokens") {
      return jsonResponse(201, {
        token: "new-installation-token",
        expires_at: new Date(now + 60 * 60 * 1000).toISOString()
      });
    }
    return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
  }, async () => {
    assert.equal(await auth.getToken(), "old-installation-token");
    now += 56 * 60 * 1000;
    assert.equal(await auth.getToken(), "new-installation-token");
  });

  assert.equal(installationReads, 2);
});

test("GitHub App auth rejects malformed installation and token responses", async (t) => {
  const cases = [
    { name: "missing installation id", installation: {}, token: null, error: /installation id/ },
    { name: "missing token", installation: { id: 987 }, token: { expires_at: "2099-01-01T00:00:00Z" }, error: /token or expiry/ },
    { name: "invalid expiry", installation: { id: 987 }, token: { token: "sentinel", expires_at: "nope" }, error: /token or expiry/ },
    { name: "expired token", installation: { id: 987 }, token: { token: "sentinel", expires_at: "2000-01-01T00:00:00Z" }, error: /token or expiry/ }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const auth = createGitHubAppAuth({
        appId: "12345",
        privateKey: testAppPrivateKey,
        owner: "Ambiguous-Interactive"
      });
      await withMockedFetch(async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/orgs/Ambiguous-Interactive/installation") {
          return jsonResponse(200, testCase.installation);
        }
        if (parsed.pathname === "/app/installations/987/access_tokens") {
          return jsonResponse(201, testCase.token);
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await assert.rejects(() => auth.getToken(), testCase.error);
      });
    });
  }
});

test("credential selection requires complete GitHub App configuration and rejects legacy tokens", async (t) => {
  const cases = [
    { name: "app id only", appId: "123", privateKey: undefined, token: "legacy", error: /provided together/ },
    { name: "private key only", appId: undefined, privateKey: testAppPrivateKey, token: "legacy", error: /provided together/ },
    { name: "legacy token only", appId: undefined, privateKey: undefined, token: "legacy", error: /Provide BUILD_LOCK_APP_ID/ }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await withEnvironment(
        {
          BUILD_LOCK_APP_ID: testCase.appId,
          BUILD_LOCK_APP_PRIVATE_KEY: testCase.privateKey,
          BUILD_LOCK_TOKEN: testCase.token
        },
        async () => {
          await withMockedFetch(async () => jsonResponse(500), async (logs) => {
            assert.throws(
              () => credential({ owner: "Ambiguous-Interactive", repo: "ambiguous-organization-build-lock" }),
              testCase.error
            );
            assert.equal(logs.join("\n").includes("legacy"), false);
          });
        }
      );
    });
  }
});

test("config rejects holder suffixes that fallback cleanup cannot reproduce", async (t) => {
  const cases = [
    { name: "internal spaces and colons", value: "matrix: Edit Mode" },
    { name: "leading whitespace", value: " leading", error: true },
    { name: "trailing whitespace", value: "trailing ", error: true },
    { name: "line feed", value: "line\nbreak", error: true },
    { name: "carriage return", value: "line\rbreak", error: true }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await withEnvironment(
        {
          "INPUT_LOCK-NAME": "wallstop-organization-builds",
          "INPUT_HOLDER-ID-SUFFIX": testCase.value,
          "INPUT_LOCK-REPOSITORY": "Ambiguous-Interactive/ambiguous-organization-build-lock",
          GITHUB_REPOSITORY: authorizedConsumerEnv.GITHUB_REPOSITORY,
          GITHUB_REPOSITORY_ID: authorizedConsumerEnv.GITHUB_REPOSITORY_ID,
          GITHUB_REPOSITORY_OWNER_ID: authorizedConsumerEnv.GITHUB_REPOSITORY_OWNER_ID,
          BUILD_LOCK_APP_ID: testCase.error ? "partial-app-credentials" : "12345",
          BUILD_LOCK_APP_PRIVATE_KEY: testCase.error ? undefined : testAppPrivateKey
        },
        async () => {
          if (testCase.error) {
            assert.throws(
              () => config(),
              /holder-id-suffix must not have leading\/trailing whitespace or line breaks/
            );
          } else {
            assert.equal(config().holderIdSuffix, testCase.value);
          }
        }
      );
    });
  }
});

test("config validates acquire lifecycle requirements", async (t) => {
  const cases = [
    { name: "defaults preserve compatibility", lifecycle: undefined, cooldown: undefined, expected: [false, 0] },
    { name: "explicit requirements", lifecycle: "true", cooldown: "360", expected: [true, 360] },
    { name: "invalid lifecycle boolean", lifecycle: "yes", cooldown: undefined, error: /must be true or false/ },
    { name: "negative cooldown", lifecycle: undefined, cooldown: "-1", error: /must be a non-negative integer/ },
    { name: "fractional cooldown", lifecycle: undefined, cooldown: "1.5", error: /must be a non-negative integer/ },
    { name: "cooldown above supported maximum", lifecycle: undefined, cooldown: "86401", error: /must be <= 86400/ }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await withEnvironment(
        {
          "INPUT_LOCK-NAME": "wallstop-organization-builds",
          "INPUT_LOCK-REPOSITORY": "Ambiguous-Interactive/ambiguous-organization-build-lock",
          GITHUB_REPOSITORY: authorizedConsumerEnv.GITHUB_REPOSITORY,
          GITHUB_REPOSITORY_ID: authorizedConsumerEnv.GITHUB_REPOSITORY_ID,
          GITHUB_REPOSITORY_OWNER_ID: authorizedConsumerEnv.GITHUB_REPOSITORY_OWNER_ID,
          "INPUT_REQUIRE-RESOURCE-LIFECYCLE": testCase.lifecycle,
          "INPUT_MINIMUM-RELEASE-COOLDOWN-SECONDS": testCase.cooldown,
          BUILD_LOCK_APP_ID: "12345",
          BUILD_LOCK_APP_PRIVATE_KEY: testAppPrivateKey
        },
        () => {
          if (testCase.error) {
            assert.throws(() => config(), testCase.error);
          } else {
            const parsed = config();
            assert.deepEqual(
              [parsed.requireResourceLifecycle, parsed.minimumReleaseCooldownSeconds],
              testCase.expected
            );
          }
        }
      );
    });
  }
});

test("GitHub App configuration rejects invalid private keys without exposing them", async () => {
  const sentinel = "not-a-private-key-secret";
  await withMockedFetch(async () => jsonResponse(500), async (logs) => {
    assert.throws(
      () =>
        createGitHubAppAuth({
          appId: "12345",
          privateKey: sentinel,
          owner: "Ambiguous-Interactive"
        }),
      /not a valid private key/
    );
    assert.equal(logs.join("\n").includes(sentinel), false);
  });
});

test("complete GitHub App credentials select renewable scoped authentication", async () => {
  await withEnvironment(
    {
      BUILD_LOCK_APP_ID: "12345",
      BUILD_LOCK_APP_PRIVATE_KEY: String(testAppPrivateKey).replace(/\n/g, "\\n")
    },
    () => {
      const selected = credential({ owner: "Ambiguous-Interactive", repo: "ambiguous-organization-build-lock" });
      assert.equal(selected.renewable, true);
      assert.equal(typeof selected.getToken, "function");
    }
  );
});

test("config rejects unauthorized callers before credential parsing", async (t) => {
  for (const testCase of [
    { name: "wrong owner id", env: { ...authorizedConsumerEnv, GITHUB_REPOSITORY_OWNER_ID: "1" } },
    { name: "non-canonical owner id", env: { ...authorizedConsumerEnv, GITHUB_REPOSITORY_OWNER_ID: "0212056428" } },
    { name: "wrong repository id", env: { ...authorizedConsumerEnv, GITHUB_REPOSITORY_ID: "1" } },
    { name: "repository name and id mismatch", env: { ...authorizedConsumerEnv, GITHUB_REPOSITORY: "Ambiguous-Interactive/IshoBoy" } },
    { name: "wrong state branch", env: authorizedConsumerEnv, inputs: { "INPUT_STATE-BRANCH": "main" } }
  ]) {
    await t.test(testCase.name, async () => {
      await withActionEnv(testCase.env, async () => {
        await withEnvironment({
          "INPUT_LOCK-NAME": "wallstop-organization-builds",
          "INPUT_LOCK-REPOSITORY": "Ambiguous-Interactive/ambiguous-organization-build-lock",
          ...(testCase.inputs || {}),
          BUILD_LOCK_APP_ID: "123",
          BUILD_LOCK_APP_PRIVATE_KEY: "deliberately-invalid-private-key"
        }, () => {
          assert.throws(() => config(), /not authorized|canonical/i);
        });
      });
    });
  }
});

test("authorization registry accepts only the lock repository and five canonical consumers", async (t) => {
  const repositories = [
    ["Ambiguous-Interactive/DxMessaging", "101020635"],
    ["Ambiguous-Interactive/unity-helpers", "737391131"],
    ["Ambiguous-Interactive/DoxReloaded", "825469040"],
    ["Ambiguous-Interactive/IshoBoy", "885525263"],
    ["Ambiguous-Interactive/DepartmentOfArrangements", "1079492096"],
    ["Ambiguous-Interactive/ambiguous-organization-build-lock", "1244796436"]
  ];
  for (const [repository, repositoryId] of repositories) {
    await t.test(repository, async () => {
      await withActionEnv({
        GITHUB_REPOSITORY: repository,
        GITHUB_REPOSITORY_ID: repositoryId,
        GITHUB_REPOSITORY_OWNER_ID: "212056428"
      }, () => {
        assert.equal(
          authorizeCaller({
            lockName: "wallstop-organization-builds",
            lockRepository: "Ambiguous-Interactive/ambiguous-organization-build-lock",
            mode: repository.endsWith("/ambiguous-organization-build-lock") ? "reap" : "acquire"
          }).repository,
          repository
        );
      });
    });
  }
});

test("authorization separates lock-repository reaping from consumer lock operations", async () => {
  await withActionEnv({
    GITHUB_REPOSITORY: "Ambiguous-Interactive/ambiguous-organization-build-lock",
    GITHUB_REPOSITORY_ID: "1244796436",
    GITHUB_REPOSITORY_OWNER_ID: "212056428"
  }, () => {
    assert.throws(
      () => authorizeCaller({
        lockName: "wallstop-organization-builds",
        lockRepository: "Ambiguous-Interactive/ambiguous-organization-build-lock",
        mode: "acquire"
      }),
      /only for the scheduled reaper/
    );
  });
  await withActionEnv(authorizedConsumerEnv, () => {
    assert.throws(
      () => authorizeCaller({
        lockName: "wallstop-organization-builds",
        lockRepository: "Ambiguous-Interactive/ambiguous-organization-build-lock",
        mode: "reap"
      }),
      /Only the lock repository/
    );
  });
});

test("state-writer App tokens are limited to the lock repository and contents write", async () => {
  const requests = [];
  await withMockedFetch(async (url, options = {}) => {
    const parsed = new URL(url);
    requests.push({ path: parsed.pathname, method: options.method, body: options.body && JSON.parse(options.body) });
    if (parsed.pathname.endsWith("/installation")) return jsonResponse(200, { id: 42 });
    return jsonResponse(201, { token: "scoped-writer", expires_at: "2999-01-01T00:00:00Z" });
  }, async () => {
    const auth = createGitHubAppAuth({
      appId: "123",
      privateKey: testAppPrivateKey,
      owner: "Ambiguous-Interactive",
      repository: "ambiguous-organization-build-lock",
      repositories: ["ambiguous-organization-build-lock"],
      permissions: { contents: "write" }
    });
    assert.equal(await auth.getToken(), "scoped-writer");
  });
  assert.equal(requests[0].path, "/repos/Ambiguous-Interactive/ambiguous-organization-build-lock/installation");
  assert.deepEqual(requests[1].body, {
    repositories: ["ambiguous-organization-build-lock"],
    permissions: { contents: "write" }
  });
});

test("reaper reader App token is limited to consumer Actions and Metadata read", async () => {
  const requests = [];
  await withEnvironment({
    BUILD_LOCK_READER_APP_ID: "456",
    BUILD_LOCK_READER_APP_PRIVATE_KEY: testAppPrivateKey
  }, async () => {
    await withMockedFetch(async (url, options = {}) => {
      const parsed = new URL(url);
      requests.push({ path: parsed.pathname, body: options.body && JSON.parse(options.body) });
      if (parsed.pathname.endsWith("/installation")) return jsonResponse(200, { id: 84 });
      return jsonResponse(201, { token: "scoped-reader", expires_at: "2999-01-01T00:00:00Z" });
    }, async () => {
      assert.equal(await readerCredential("Ambiguous-Interactive").getToken(), "scoped-reader");
    });
  });
  assert.equal(requests[0].path, "/orgs/Ambiguous-Interactive/installation");
  assert.deepEqual(requests[1].body, {
    repositories: ["DxMessaging", "unity-helpers", "DoxReloaded", "IshoBoy", "DepartmentOfArrangements"],
    permissions: { actions: "read", metadata: "read" }
  });
  assert.equal(requests[1].body.repositories.includes("ambiguous-organization-build-lock"), false);
  assert.equal(Object.hasOwn(requests[1].body.permissions, "contents"), false);
});

test("writeState does not mark a 401-then-conflict sequence as an ambiguous write", async () => {
  // A 401 is rejected before GitHub processes the mutation, so a later CAS conflict
  // cannot mean "our write was silently accepted".
  let calls = 0;
  await withEnvironment({ BUILD_LOCK_API_RETRY_BASE_MS: "0", BUILD_LOCK_API_RETRY_MAX_MS: "0" }, async () => {
    await withMockedFetch(async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse(401, { message: "Bad credentials" });
      }
      return jsonResponse(409, { message: "sha does not match" });
    }, async () => {
      const result = await writeState(
        {
          lockRepo: { owner: "o", repo: "r" },
          statePath: "locks/x.json",
          stateBranch: "lock-state",
          token: "token"
        },
        "previous-sha",
        emptyState("x"),
        "Acquire x"
      );

      assert.deepEqual(result, { conflict: true, sha: "", ambiguous: false });
      assert.equal(calls, 2);
    });
  });
});

test("api honors Retry-After for retryable responses", async () => {
  let calls = 0;
  const delays = [];
  await withMockedFetch(
    async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse(429, { message: "secondary rate limit" }, { "retry-after": "2" });
      }
      return jsonResponse(200, { ok: true });
    },
    async () => {
      const result = await api("GET", "/repos/o/r", undefined, "token", {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 5000,
        sleep: async (delay) => {
          delays.push(delay);
        }
      });

      assert.deepEqual(result, { ok: true });
      assert.deepEqual(delays, [2000]);
    }
  );
});

test("api passes AbortSignal to retry sleep for retryable responses", async () => {
  const controller = new AbortController();
  let calls = 0;
  const sleepSignals = [];

  await withMockedFetch(
    async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse(503, { message: "service unavailable" });
      }
      return jsonResponse(200, { ok: true });
    },
    async () => {
      const result = await api("GET", "/repos/o/r", undefined, "token", {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        signal: controller.signal,
        sleep: async (_delay, options = {}) => {
          sleepSignals.push(options.signal);
        }
      });

      assert.deepEqual(result, { ok: true });
      assert.equal(calls, 2);
      assert.deepEqual(sleepSignals, [controller.signal]);
    }
  );
});

test("api passes AbortSignal to retry sleep for fetch failures", async () => {
  const controller = new AbortController();
  let calls = 0;
  const sleepSignals = [];

  await withMockedFetch(
    async () => {
      calls++;
      if (calls === 1) {
        throw new TypeError("fetch failed");
      }
      return jsonResponse(200, { ok: true });
    },
    async () => {
      const result = await api("GET", "/repos/o/r", undefined, "token", {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        signal: controller.signal,
        sleep: async (_delay, options = {}) => {
          sleepSignals.push(options.signal);
        }
      });

      assert.deepEqual(result, { ok: true });
      assert.equal(calls, 2);
      assert.deepEqual(sleepSignals, [controller.signal]);
    }
  );
});

test("api forwards AbortSignal to fetch", async () => {
  const controller = new AbortController();
  await withMockedFetch(
    async (_url, options = {}) => {
      assert.equal(options.signal, controller.signal);
      return jsonResponse(200, { ok: true });
    },
    async () => {
      assert.deepEqual(await api("GET", "/repos/o/r", undefined, "token", { signal: controller.signal }), { ok: true });
    }
  );
});

test("api fails fast when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort("cancelled before request");
  let calls = 0;
  let sleeps = 0;

  await withMockedFetch(
    async () => {
      calls++;
      return jsonResponse(200, { ok: true });
    },
    async (logs) => {
      await assert.rejects(
        () =>
          api("GET", "/repos/o/r", undefined, "token", {
            maxAttempts: 3,
            baseDelayMs: 0,
            maxDelayMs: 0,
            signal: controller.signal,
            sleep: async () => {
              sleeps++;
            }
          }),
        /cancelled before request/
      );

      assert.equal(calls, 0);
      assert.equal(sleeps, 0);
      assert.equal(logs.length, 0);
    }
  );
});

test("api fails fast for aborted fetch failures", async (t) => {
  const cases = [
    {
      name: "aborted signal reason",
      setupError: (controller) => {
        controller.abort(new Error("cancelled by caller"));
        return controller.signal.reason;
      },
      expected: /cancelled by caller/
    },
    {
      name: "AbortError",
      setupError: () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        return error;
      },
      expected: /The operation was aborted/
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const controller = new AbortController();
      let calls = 0;
      let sleeps = 0;
      await withMockedFetch(
        async () => {
          calls++;
          throw testCase.setupError(controller);
        },
        async (logs) => {
          await assert.rejects(
            () =>
              api("GET", "/repos/o/r", undefined, "token", {
                maxAttempts: 3,
                baseDelayMs: 0,
                maxDelayMs: 0,
                signal: controller.signal,
                sleep: async () => {
                  sleeps++;
                }
              }),
            testCase.expected
          );

          assert.equal(calls, 1);
          assert.equal(sleeps, 0);
          assert.equal(logs.length, 0);
        }
      );
    });
  }
});

test("api fails fast for aborted response body reads", async () => {
  const error = new Error("body read aborted");
  error.name = "AbortError";
  let calls = 0;
  let sleeps = 0;

  await withMockedFetch(
    async () => {
      calls++;
      return {
        text: async () => {
          throw error;
        }
      };
    },
    async (logs) => {
      await assert.rejects(
        () =>
          api("GET", "/repos/o/r", undefined, "token", {
            maxAttempts: 3,
            baseDelayMs: 0,
            maxDelayMs: 0,
            sleep: async () => {
              sleeps++;
            }
          }),
        /body read aborted/
      );

      assert.equal(calls, 1);
      assert.equal(sleeps, 0);
      assert.equal(logs.length, 0);
    }
  );
});

test("api fails fast when cancellation arrives before a retry delay", async () => {
  const controller = new AbortController();
  let calls = 0;
  let sleeps = 0;

  await withMockedFetch(
    async () => {
      calls++;
      controller.abort(new Error("stopped before retry"));
      return jsonResponse(500, { message: "server error" });
    },
    async (logs) => {
      await assert.rejects(
        () =>
          api("GET", "/repos/o/r", undefined, "token", {
            maxAttempts: 3,
            baseDelayMs: 0,
            maxDelayMs: 0,
            signal: controller.signal,
            sleep: async () => {
              sleeps++;
            }
          }),
        /stopped before retry/
      );

      assert.equal(calls, 1);
      assert.equal(sleeps, 0);
      assert.equal(logs.length, 0);
    }
  );
});

test("api normalizes primitive abort reasons while retry sleep is pending", async () => {
  const controller = new AbortController();
  let calls = 0;

  await withMockedFetch(
    async () => {
      calls++;
      return jsonResponse(503, { message: "service unavailable" });
    },
    async (logs) => {
      setTimeout(() => {
        controller.abort("cancelled during retry sleep");
      }, 0);

      await assert.rejects(
        () =>
          api("GET", "/repos/o/r", undefined, "token", {
            maxAttempts: 2,
            baseDelayMs: 1000,
            maxDelayMs: 1000,
            signal: controller.signal
          }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.equal(error.name, "AbortError");
          assert.match(error.message, /cancelled during retry sleep/);
          return true;
        }
      );

      assert.equal(calls, 1);
      assert.match(logs.join("\n"), /HTTP 503; retrying/);
    }
  );
});

test("api normalizes primitive abort reasons from injected retry sleep", async () => {
  const controller = new AbortController();
  let calls = 0;

  await withMockedFetch(
    async () => {
      calls++;
      return jsonResponse(503, { message: "service unavailable" });
    },
    async (logs) => {
      await assert.rejects(
        () =>
          api("GET", "/repos/o/r", undefined, "token", {
            maxAttempts: 2,
            baseDelayMs: 0,
            maxDelayMs: 0,
            signal: controller.signal,
            sleep: async () => {
              controller.abort("custom sleep cancelled");
              throw controller.signal.reason;
            }
          }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.equal(error.name, "AbortError");
          assert.match(error.message, /custom sleep cancelled/);
          return true;
        }
      );

      assert.equal(calls, 1);
      assert.match(logs.join("\n"), /HTTP 503; retrying/);
    }
  );
});

test("signal cleanup handler marks cancellation and aborts acquire work", () => {
  const previousLog = console.log;
  const initialSigintListeners = process.listenerCount("SIGINT");
  const initialSigtermListeners = process.listenerCount("SIGTERM");
  const cancellation = {
    requested: false,
    signalName: "",
    exitCode: 0,
    abortController: new AbortController(),
    cleanupAbortController: null
  };
  const remove = installAcquireSignalCleanup(cancellation);
  console.log = () => {};

  try {
    assert.equal(process.listenerCount("SIGINT"), initialSigintListeners + 1);
    assert.equal(process.listenerCount("SIGTERM"), initialSigtermListeners + 1);

    process.emit("SIGINT", "SIGINT");

    assert.equal(cancellation.requested, true);
    assert.equal(cancellation.signalName, "SIGINT");
    assert.equal(cancellation.exitCode, 130);
    assert.equal(cancellation.abortController.signal.aborted, true);
  } finally {
    console.log = previousLog;
    remove();
    remove();
    assert.equal(process.listenerCount("SIGINT"), initialSigintListeners);
    assert.equal(process.listenerCount("SIGTERM"), initialSigtermListeners);
  }
});

test("repeated pre-cleanup signals update exit code without repeating first-cancel work", () => {
  const previousLog = console.log;
  const logs = [];
  const cancellation = {
    requested: false,
    signalName: "",
    exitCode: 0,
    abortController: new AbortController(),
    cleanupAbortController: null
  };
  const remove = installAcquireSignalCleanup(cancellation);
  console.log = (line) => {
    logs.push(String(line));
  };

  try {
    process.emit("SIGINT", "SIGINT");
    process.emit("SIGTERM", "SIGTERM");

    assert.equal(cancellation.requested, true);
    assert.equal(cancellation.signalName, "SIGTERM");
    assert.equal(cancellation.exitCode, 143);
    assert.equal(cancellation.abortController.signal.aborted, true);
    assert.equal(logs.length, 1);
  } finally {
    console.log = previousLog;
    remove();
  }
});

for (const testCase of [
  { firstSignal: "SIGINT", secondSignal: "SIGINT", exitCode: 130 },
  { firstSignal: "SIGTERM", secondSignal: "SIGTERM", exitCode: 143 },
  { firstSignal: "SIGINT", secondSignal: "SIGTERM", exitCode: 143 },
  { firstSignal: "SIGTERM", secondSignal: "SIGINT", exitCode: 130 }
]) {
  test(`second ${testCase.secondSignal} during ${testCase.firstSignal} cancellation cleanup aborts cleanup`, () => {
    const previousExit = process.exit;
    const previousLog = console.log;
    let exitCode = null;
    const cancellation = {
      requested: false,
      signalName: "",
      exitCode: 0,
      abortController: new AbortController(),
      cleanupAbortController: null
    };
    const remove = installAcquireSignalCleanup(cancellation);
    process.exit = (code) => {
      exitCode = code;
    };
    console.log = () => {};

    try {
      process.emit(testCase.firstSignal, testCase.firstSignal);
      cancellation.cleanupAbortController = new AbortController();
      process.emit(testCase.secondSignal, testCase.secondSignal);

      assert.equal(cancellation.cleanupAbortController.signal.aborted, true);
      assert.equal(exitCode, testCase.exitCode);
    } finally {
      console.log = previousLog;
      process.exit = previousExit;
      remove();
    }
  });
}

test("second signal during cancellation cleanup exits with the new signal code", () => {
  const previousExit = process.exit;
  let exitCode = null;
  const cancellation = {
    requested: true,
    signalName: "SIGINT",
    exitCode: 130,
    abortController: new AbortController(),
    cleanupAbortController: new AbortController()
  };
  const remove = installAcquireSignalCleanup(cancellation);
  process.exit = (code) => {
    exitCode = code;
  };

  try {
    process.emit("SIGTERM", "SIGTERM");

    assert.equal(cancellation.cleanupAbortController.signal.aborted, true);
    assert.equal(exitCode, 143);
  } finally {
    process.exit = previousExit;
    remove();
  }
});

test("acquire removes signal cleanup listeners when setup fails", async () => {
  const initialSigintListeners = process.listenerCount("SIGINT");
  const initialSigtermListeners = process.listenerCount("SIGTERM");

  await withActionEnv(
    {
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKFLOW: "Perf",
      GITHUB_JOB: "perf-benchmarks"
    },
    async () => {
      await withEnvironment({ BUILD_LOCK_API_MAX_ATTEMPTS: "1" }, async () => {
        await withMockedFetch(async (url) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(401, { message: "Bad credentials" });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await assert.rejects(
            () =>
              acquire({
                token: "token",
                lockName: "wallstop-organization-builds",
                holderIdSuffix: "playmode",
                lockRepository: "o/r",
                lockRepo: { owner: "o", repo: "r" },
                stateBranch: "lock-state",
                statePath: "locks/wallstop-organization-builds.json",
                timeoutMinutes: 1,
                leaseMinutes: 240,
                pollSeconds: 1
              }),
            /Bad credentials/
          );
        });
      });
    }
  );

  assert.equal(process.listenerCount("SIGINT"), initialSigintListeners);
  assert.equal(process.listenerCount("SIGTERM"), initialSigtermListeners);
});

test("cancellation cleanup removes this run queue entry with a fresh cleanup path", async () => {
  let state = {
    ...emptyState("wallstop-organization-builds"),
    queue: [
      {
        holderId: "owner/repo:123:perf-benchmarks:playmode",
        repository: "owner/repo",
        workflow: "Perf",
        job: "perf-benchmarks",
        runId: "123",
        runAttempt: "1",
        runUrl: "https://github.com/owner/repo/actions/runs/123",
        queuedAt: "2026-06-06T00:00:00.000Z"
      }
    ]
  };

  await withActionEnv(
    {
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKFLOW: "Perf",
      GITHUB_JOB: "perf-benchmarks"
    },
    async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        assert.ok(options.signal, "cancellation cleanup should use its own abort signal");
        if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
          if (options.method === "PUT") {
            const body = JSON.parse(options.body);
            state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "state-after-cleanup" } });
          }
          return jsonResponse(200, {
            content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
            sha: "state-before-cleanup"
          });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async (logs) => {
        await runCancellationCleanup(
          {
            token: "token",
            lockName: "wallstop-organization-builds",
            holderIdSuffix: "playmode",
            lockRepository: "o/r",
            lockRepo: { owner: "o", repo: "r" },
            stateBranch: "lock-state",
            statePath: "locks/wallstop-organization-builds.json"
          },
          {
            holderId: "owner/repo:123:perf-benchmarks:playmode"
          },
          {
            requested: true,
            signalName: "SIGINT",
            exitCode: 130,
            abortController: new AbortController(),
            cleanupAbortController: null
          }
        );

        assert.match(logs.join("\n"), /Build-lock cleanup after signal SIGINT: queue-cleaned/);
        assert.match(logs.join("\n"), /No build-lock cleanup needed after signal SIGINT second pass/);
      });
    }
  );

  assert.deepEqual(state.queue, []);
});

test("api treats rate-limited 403 responses as retryable but not ordinary forbidden responses", () => {
  assert.equal(
    isRetryableResponse(jsonResponse(403, { message: "You have exceeded a secondary rate limit." }), {
      message: "You have exceeded a secondary rate limit."
    }),
    true
  );

  assert.equal(isRetryableResponse(jsonResponse(403, { message: "Resource not accessible by integration" }), {
    message: "Resource not accessible by integration"
  }), false);
});

test("writeState marks CAS conflicts after a retryable mutation failure as ambiguous", async () => {
  let calls = 0;
  const previousBase = process.env.BUILD_LOCK_API_RETRY_BASE_MS;
  const previousMax = process.env.BUILD_LOCK_API_RETRY_MAX_MS;
  process.env.BUILD_LOCK_API_RETRY_BASE_MS = "0";
  process.env.BUILD_LOCK_API_RETRY_MAX_MS = "0";

  try {
    await withMockedFetch(async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse(500, { message: "backend unavailable" }, { "x-github-request-id": "REQ500" });
      }
      return jsonResponse(409, { message: "sha does not match" });
    }, async () => {
    const result = await writeState(
      {
        lockRepo: { owner: "o", repo: "r" },
        statePath: "locks/x.json",
        stateBranch: "lock-state",
        token: "token"
      },
      "previous-sha",
      emptyState("x"),
      "Acquire x"
    );

    assert.deepEqual(result, { conflict: true, sha: "", ambiguous: true });
    assert.equal(calls, 2);
    });
  } finally {
    if (previousBase === undefined) {
      delete process.env.BUILD_LOCK_API_RETRY_BASE_MS;
    } else {
      process.env.BUILD_LOCK_API_RETRY_BASE_MS = previousBase;
    }
    if (previousMax === undefined) {
      delete process.env.BUILD_LOCK_API_RETRY_MAX_MS;
    } else {
      process.env.BUILD_LOCK_API_RETRY_MAX_MS = previousMax;
    }
  }
});

test("writeState preserves unambiguous CAS conflict handling", async () => {
  let calls = 0;

  await withMockedFetch(async () => {
    calls++;
    return jsonResponse(409, { message: "sha does not match" });
  }, async () => {
    const result = await writeState(
      {
        lockRepo: { owner: "o", repo: "r" },
        statePath: "locks/x.json",
        stateBranch: "lock-state",
        token: "token"
      },
      "previous-sha",
      emptyState("x"),
      "Acquire x"
    );

    assert.deepEqual(result, { conflict: true, sha: "", ambiguous: false });
    assert.equal(calls, 1);
  });
});

test("writeState does not mark rate-limit rejections as ambiguous writes", async (t) => {
  const previousBase = process.env.BUILD_LOCK_API_RETRY_BASE_MS;
  const previousMax = process.env.BUILD_LOCK_API_RETRY_MAX_MS;
  process.env.BUILD_LOCK_API_RETRY_BASE_MS = "0";
  process.env.BUILD_LOCK_API_RETRY_MAX_MS = "0";

  try {
    for (const testCase of [
      {
        name: "HTTP 429",
        response: () => jsonResponse(429, { message: "secondary rate limit" })
      },
      {
        name: "rate-limited HTTP 403",
        response: () => jsonResponse(403, { message: "You have exceeded a secondary rate limit." })
      }
    ]) {
      await t.test(testCase.name, async () => {
        let calls = 0;
        await withMockedFetch(async () => {
          calls++;
          if (calls === 1) {
            return testCase.response();
          }
          return jsonResponse(409, { message: "sha does not match" });
        }, async () => {
          const result = await writeState(
            {
              lockRepo: { owner: "o", repo: "r" },
              statePath: "locks/x.json",
              stateBranch: "lock-state",
              token: "token"
            },
            "previous-sha",
            emptyState("x"),
            "Acquire x"
          );

          assert.deepEqual(result, { conflict: true, sha: "", ambiguous: false });
          assert.equal(calls, 2);
        });
      });
    }
  } finally {
    if (previousBase === undefined) {
      delete process.env.BUILD_LOCK_API_RETRY_BASE_MS;
    } else {
      process.env.BUILD_LOCK_API_RETRY_BASE_MS = previousBase;
    }
    if (previousMax === undefined) {
      delete process.env.BUILD_LOCK_API_RETRY_MAX_MS;
    } else {
      process.env.BUILD_LOCK_API_RETRY_MAX_MS = previousMax;
    }
  }
});

test("acquire succeeds idempotently when this run already holds the lock", async () => {
  const holder = {
    holderId: "owner/repo:123:perf-benchmarks:playmode",
    repository: "owner/repo",
    workflow: "Perf",
    job: "perf-benchmarks",
    runId: "123",
    runAttempt: "1",
    runUrl: "https://github.com/owner/repo/actions/runs/123",
    queuedAt: "2026-06-06T00:00:00.000Z",
    acquiredAt: "2026-06-06T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z"
  };
  const state = {
    ...emptyState("wallstop-organization-builds"),
    holder,
    updatedAt: "2026-06-06T00:00:00.000Z"
  };
  let calls = [];

  await withTempFile(async (outputFile) => {
    await withActionEnv(
      {
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_WORKFLOW: "Perf",
        GITHUB_JOB: "perf-benchmarks",
        GITHUB_OUTPUT: outputFile
      },
      async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          calls.push({ method: options.method || "GET", path: parsed.pathname });
          if (options.method === "PUT") {
            throw new Error("acquire should not write when the current run already holds the lock");
          }
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
            return jsonResponse(200, {
              content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
              sha: "state-sha"
            });
          }
          if (parsed.pathname === "/repos/owner/repo/actions/runs/123") {
            return jsonResponse(200, { status: "in_progress", conclusion: null });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async (logs) => {
          await acquire({
            token: "token",
            lockName: "wallstop-organization-builds",
            holderIdSuffix: "playmode",
            lockRepository: "o/r",
            lockRepo: { owner: "o", repo: "r" },
            stateBranch: "lock-state",
            statePath: "locks/wallstop-organization-builds.json",
            timeoutMinutes: 1,
            leaseMinutes: 240,
            pollSeconds: 1
          });

          assert.match(logs.join("\n"), /Already holds wallstop-organization-builds/);
        });
      }
    );

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, acquireOutputNames);
    assert.equal(outputs.acquired, "true");
    assert.equal(outputs["lock-name"], "wallstop-organization-builds");
    assert.equal(outputs["holder-id"], "owner/repo:123:perf-benchmarks:playmode");
    assert.equal(outputs["state-sha"], "state-sha");
    assert.equal(outputs.attempts, "1");
    assert.equal(outputs["stale-recovered"], "false");
  });

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      "GET /repos/o/r/contents/locks/wallstop-organization-builds.config.json",
      "GET /repos/o/r/git/ref/heads/lock-state",
      "GET /repos/o/r/contents/locks/wallstop-organization-builds.json"
    ]
  );
});

test("acquire recovers when a successful lock write is reported as a transient failure", async () => {
  let holderState = null;
  let putCalls = 0;
  const calls = [];

  await withActionEnv(
    {
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKFLOW: "Perf",
      GITHUB_JOB: "perf-benchmarks"
    },
    async () => {
      await withImmediateTimers(async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          calls.push({ method: options.method || "GET", path: parsed.pathname });
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
            if (options.method === "PUT") {
              putCalls++;
              const body = JSON.parse(options.body);
              holderState = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
              if (putCalls === 1) {
                return jsonResponse(500, { message: "accepted but response failed" });
              }
              return jsonResponse(409, { message: "sha does not match" });
            }
            return jsonResponse(200, {
              content: Buffer.from(JSON.stringify(holderState || emptyState("wallstop-organization-builds")), "utf8").toString(
                "base64"
              ),
              sha: holderState ? "state-sha-after-put" : "state-sha-before-put"
            });
          }
          if (parsed.pathname === "/repos/owner/repo/actions/runs/123") {
            return jsonResponse(200, { status: "in_progress", conclusion: null });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async (logs) => {
          await acquire({
            token: "token",
            lockName: "wallstop-organization-builds",
            holderIdSuffix: "playmode",
            lockRepository: "o/r",
            lockRepo: { owner: "o", repo: "r" },
            stateBranch: "lock-state",
            statePath: "locks/wallstop-organization-builds.json",
            timeoutMinutes: 1,
            leaseMinutes: 240,
            pollSeconds: 1
          });

          assert.equal(putCalls, 2);
          assert.equal(holderState.holder.holderId, "owner/repo:123:perf-benchmarks:playmode");
          assert.match(logs.join("\n"), /HTTP 500; retrying/);
          assert.match(logs.join("\n"), /Already holds wallstop-organization-builds/);
        });
      });
    }
  );

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      "GET /repos/o/r/contents/locks/wallstop-organization-builds.config.json",
      "GET /repos/o/r/git/ref/heads/lock-state",
      "GET /repos/o/r/contents/locks/wallstop-organization-builds.json",
      "PUT /repos/o/r/contents/locks/wallstop-organization-builds.json",
      "PUT /repos/o/r/contents/locks/wallstop-organization-builds.json",
      "GET /repos/o/r/contents/locks/wallstop-organization-builds.json"
    ]
  );
});

test("acquire keeps waiting when a lock-state read hits a transient 401 outage", async () => {
  // Regression test for issue #12: ensureStateBranch succeeded and the very next
  // contents read returned HTTP 401 with the same token. The acquire loop must ride
  // out such blips instead of failing the whole build.
  let holderState = null;
  let contentReads = 0;

  await withTempFile(async (outputFile) => {
    await withActionEnv(
      {
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW: "Perf",
        GITHUB_JOB: "perf-benchmarks",
        GITHUB_OUTPUT: outputFile
      },
      async () => {
        await withEnvironment({ BUILD_LOCK_API_MAX_ATTEMPTS: "1" }, async () => {
          await withImmediateTimers(async () => {
            await withMockedFetch(async (url, options = {}) => {
              const parsed = new URL(url);
              if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
                return jsonResponse(200, { object: { sha: "branch-sha" } });
              }
              if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
                if (options.method === "PUT") {
                  const body = JSON.parse(options.body);
                  holderState = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
                  return jsonResponse(200, { content: { sha: "state-after-acquire" } });
                }
                contentReads++;
                if (contentReads === 1) {
                  return jsonResponse(401, { message: "Bad credentials" }, { "x-github-request-id": "AUTH401" });
                }
                return jsonResponse(200, {
                  content: Buffer.from(
                    JSON.stringify(holderState || emptyState("wallstop-organization-builds")),
                    "utf8"
                  ).toString("base64"),
                  sha: holderState ? "state-after-acquire" : "state-before-acquire"
                });
              }
              return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
            }, async (logs) => {
              await acquire({
                token: "token",
                lockName: "wallstop-organization-builds",
                holderIdSuffix: "playmode",
                lockRepository: "o/r",
                lockRepo: { owner: "o", repo: "r" },
                stateBranch: "lock-state",
                statePath: "locks/wallstop-organization-builds.json",
                timeoutMinutes: 1,
                leaseMinutes: 240,
                pollSeconds: 1
              });

              assert.match(logs.join("\n"), /HTTP 401/);
              assert.match(logs.join("\n"), /treating it as transient/);
            });
          });
        });
      }
    );

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, acquireOutputNames);
    assert.equal(outputs.acquired, "true");
    assert.equal(outputs["holder-id"], "owner/repo:123:perf-benchmarks:playmode");
  });

  assert.ok(contentReads >= 2);
});

test("acquire fails once 401 responses persist beyond the auth grace window", async () => {
  const originalNow = Date.now;
  let now = 0;
  let contentReads = 0;
  let wrote = false;

  Date.now = () => {
    now += 30000;
    return now;
  };

  try {
    await withTempFile(async (outputFile) => {
      await withActionEnv(
        {
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_WORKFLOW: "Perf",
          GITHUB_JOB: "perf-benchmarks",
          GITHUB_OUTPUT: outputFile
        },
        async () => {
          await withEnvironment({ BUILD_LOCK_API_MAX_ATTEMPTS: "1", BUILD_LOCK_AUTH_GRACE_MS: "60000" }, async () => {
            await withImmediateTimers(async () => {
              await withMockedFetch(async (url, options = {}) => {
                const parsed = new URL(url);
                if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
                  return jsonResponse(200, { object: { sha: "branch-sha" } });
                }
                if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
                  if (options.method === "PUT") {
                    wrote = true;
                    return jsonResponse(401, { message: "Bad credentials" });
                  }
                  contentReads++;
                  return jsonResponse(401, { message: "Bad credentials" }, { "x-github-request-id": "AUTH401" });
                }
                return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
              }, async (logs) => {
                await assert.rejects(
                  () =>
                    acquire({
                      token: "token",
                      lockName: "wallstop-organization-builds",
                      holderIdSuffix: "playmode",
                      lockRepository: "o/r",
                      lockRepo: { owner: "o", repo: "r" },
                      stateBranch: "lock-state",
                      statePath: "locks/wallstop-organization-builds.json",
                      timeoutMinutes: 30,
                      leaseMinutes: 240,
                      pollSeconds: 1
                    }),
                  /Bad credentials/
                );

                assert.match(logs.join("\n"), /treating it as transient/);
              });
            });
          });
        }
      );

      assert.deepEqual(readEnvironmentFile(outputFile), {});
    });
  } finally {
    Date.now = originalNow;
  }

  assert.ok(contentReads >= 2, `expected the acquire loop to retry within the grace window, saw ${contentReads} reads`);
  assert.equal(wrote, false);
});

test("acquire fails fast on 401 when the auth grace window is disabled", async () => {
  let contentReads = 0;

  await withActionEnv(
    {
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKFLOW: "Perf",
      GITHUB_JOB: "perf-benchmarks"
    },
    async () => {
      await withEnvironment({ BUILD_LOCK_API_MAX_ATTEMPTS: "1", BUILD_LOCK_AUTH_GRACE_MS: "0" }, async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json" && options.method !== "PUT") {
            contentReads++;
            return jsonResponse(401, { message: "Bad credentials" });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await assert.rejects(
            () =>
              acquire({
                token: "token",
                lockName: "wallstop-organization-builds",
                holderIdSuffix: "playmode",
                lockRepository: "o/r",
                lockRepo: { owner: "o", repo: "r" },
                stateBranch: "lock-state",
                statePath: "locks/wallstop-organization-builds.json",
                timeoutMinutes: 1,
                leaseMinutes: 240,
                pollSeconds: 1
              }),
            /Bad credentials/
          );

          assert.equal(contentReads, 1);
        });
      });
    }
  );
});


test("acquire records post cleanup state only when opt-in cleanup is enabled", async () => {
  let holderState = null;

  await withTempFile(async (stateFile) => {
    await withTempFile(async (outputFile) => {
      await withActionEnv(
        {
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_WORKFLOW: "Perf",
          GITHUB_JOB: "perf-benchmarks",
          GITHUB_STATE: stateFile,
          GITHUB_OUTPUT: outputFile
        },
        async () => {
          await withMockedFetch(async (url, options = {}) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
              return jsonResponse(200, { object: { sha: "branch-sha" } });
            }
            if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
              if (options.method === "PUT") {
                const body = JSON.parse(options.body);
                holderState = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
                return jsonResponse(200, { content: { sha: "state-after-acquire" } });
              }
              return jsonResponse(200, {
                content: Buffer.from(JSON.stringify(holderState || emptyState("wallstop-organization-builds")), "utf8").toString(
                  "base64"
                ),
                sha: holderState ? "state-after-acquire" : "state-before-acquire"
              });
            }
            return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
          }, async () => {
            await acquire({
              token: "token",
              lockName: "wallstop-organization-builds",
              holderIdSuffix: "playmode",
              lockRepository: "o/r",
              lockRepo: { owner: "o", repo: "r" },
              stateBranch: "lock-state",
              statePath: "locks/wallstop-organization-builds.json",
              timeoutMinutes: 1,
              leaseMinutes: 240,
              pollSeconds: 1,
              registerPostCleanup: true
            });
          });
        }
      );

      const outputs = readEnvironmentFile(outputFile);
      assertOutputContract(outputs, acquireOutputNames);
      assert.equal(outputs.acquired, "true");
      assert.equal(outputs["lock-name"], "wallstop-organization-builds");
      assert.equal(outputs["holder-id"], "owner/repo:123:perf-benchmarks:playmode");
      assert.equal(outputs["state-sha"], "state-after-acquire");
      assert.equal(outputs.attempts, "1");
      assert.equal(outputs["stale-recovered"], "false");
    });

    assert.equal(readEnvironmentFile(stateFile).build_lock_cleanup, "enabled");
  });

  assert.equal(holderState.holder.holderId, "owner/repo:123:perf-benchmarks:playmode");
});

test("legacy acquire does not record post cleanup state", async () => {
  let holderState = null;

  await withTempFile(async (stateFile) => {
    await withActionEnv(
      {
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW: "Perf",
        GITHUB_JOB: "perf-benchmarks",
        GITHUB_STATE: stateFile
      },
      async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
            if (options.method === "PUT") {
              const body = JSON.parse(options.body);
              holderState = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
              return jsonResponse(200, { content: { sha: "state-after-acquire" } });
            }
            return jsonResponse(200, {
              content: Buffer.from(JSON.stringify(holderState || emptyState("wallstop-organization-builds")), "utf8").toString(
                "base64"
              ),
              sha: holderState ? "state-after-acquire" : "state-before-acquire"
            });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await acquire({
            token: "token",
            lockName: "wallstop-organization-builds",
            holderIdSuffix: "playmode",
            lockRepository: "o/r",
            lockRepo: { owner: "o", repo: "r" },
            stateBranch: "lock-state",
            statePath: "locks/wallstop-organization-builds.json",
            timeoutMinutes: 1,
            leaseMinutes: 240,
            pollSeconds: 1
          });
        });
      }
    );

    assert.deepEqual(readEnvironmentFile(stateFile), {});
  });
});

test("opt-in acquire does not record post cleanup state before lock state mutation", async () => {
  await withTempFile(async (stateFile) => {
    await withActionEnv(
      {
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW: "Perf",
        GITHUB_JOB: "perf-benchmarks",
        GITHUB_STATE: stateFile
      },
      async () => {
        await withEnvironment({ BUILD_LOCK_API_MAX_ATTEMPTS: "1" }, async () => {
          await withMockedFetch(async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
              return jsonResponse(401, { message: "Bad credentials" });
            }
            return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
          }, async () => {
            await assert.rejects(
              () =>
                acquire({
                  token: "token",
                  lockName: "wallstop-organization-builds",
                  holderIdSuffix: "playmode",
                  lockRepository: "o/r",
                  lockRepo: { owner: "o", repo: "r" },
                  stateBranch: "lock-state",
                  statePath: "locks/wallstop-organization-builds.json",
                  timeoutMinutes: 1,
                  leaseMinutes: 240,
                  pollSeconds: 1,
                  registerPostCleanup: true
                }),
              /Bad credentials/
            );
          });
        });
      }
    );

    assert.deepEqual(readEnvironmentFile(stateFile), {});
  });
});

test("opt-in acquire records post cleanup state when this run is already queued", async () => {
  const originalNow = Date.now;
  let now = 0;
  const state = {
    ...emptyState("wallstop-organization-builds"),
    holder: {
      holderId: "other/repo:999:perf-benchmarks:editmode",
      repository: "other/repo",
      workflow: "Perf",
      job: "perf-benchmarks",
      runId: "999",
      runAttempt: "1",
      runUrl: "https://github.com/other/repo/actions/runs/999",
      queuedAt: "2026-06-06T00:00:00.000Z",
      acquiredAt: "2026-06-06T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z"
    },
    queue: [
      {
        holderId: "owner/repo:123:perf-benchmarks:playmode",
        repository: "owner/repo",
        workflow: "Perf",
        job: "perf-benchmarks",
        runId: "123",
        runAttempt: "1",
        runUrl: "https://github.com/owner/repo/actions/runs/123",
        queuedAt: "2026-06-06T00:00:00.000Z"
      }
    ]
  };

  Date.now = () => {
    now += 30000;
    return now;
  };

  try {
    await withTempFile(async (stateFile) => {
      await withActionEnv(
        {
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_WORKFLOW: "Perf",
          GITHUB_JOB: "perf-benchmarks",
          GITHUB_STATE: stateFile
        },
        async () => {
          await withImmediateTimers(async () => {
            await withMockedFetch(async (url, options = {}) => {
              const parsed = new URL(url);
              if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
                return jsonResponse(200, { object: { sha: "branch-sha" } });
              }
              if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
                if (options.method === "PUT") {
                  return jsonResponse(200, { content: { sha: "state-after-cleanup" } });
                }
                return jsonResponse(200, {
                  content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
                  sha: "state-before-read"
                });
              }
              if (parsed.pathname === "/repos/other/repo/actions/runs/999") {
                return jsonResponse(200, { status: "in_progress", conclusion: null });
              }
              return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
            }, async () => {
              await assert.rejects(
                () =>
                  acquire({
                    token: "token",
                    lockName: "wallstop-organization-builds",
                    holderIdSuffix: "playmode",
                    lockRepository: "o/r",
                    lockRepo: { owner: "o", repo: "r" },
                    stateBranch: "lock-state",
                    statePath: "locks/wallstop-organization-builds.json",
                    timeoutMinutes: 1,
                    leaseMinutes: 240,
                    pollSeconds: 1,
                    registerPostCleanup: true
                  }),
                /Timed out waiting for build lock/
              );
            });
          });
        }
      );

      assert.equal(readEnvironmentFile(stateFile).build_lock_cleanup, "enabled");
    });
  } finally {
    Date.now = originalNow;
  }
});

test("acquire timeout includes holder context and cleans this run queue entry", async () => {
  const originalNow = Date.now;
  let now = 0;
  let state = {
    ...emptyState("wallstop-organization-builds"),
    holder: {
      holderId: "other/repo:999:perf-benchmarks:editmode",
      repository: "other/repo",
      workflow: "Perf",
      job: "perf-benchmarks",
      runId: "999",
      runAttempt: "1",
      runUrl: "https://github.com/other/repo/actions/runs/999",
      queuedAt: "2026-06-06T00:00:00.000Z",
      acquiredAt: "2026-06-06T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z"
    }
  };

  Date.now = () => {
    now += 30000;
    return now;
  };

  try {
    await withTempFile(async (outputFile) => {
      await withActionEnv(
        {
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_WORKFLOW: "Perf",
          GITHUB_JOB: "perf-benchmarks",
          GITHUB_OUTPUT: outputFile
        },
        async () => {
          await withImmediateTimers(async () => {
            await withMockedFetch(async (url, options = {}) => {
              const parsed = new URL(url);
              if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
                return jsonResponse(200, { object: { sha: "branch-sha" } });
              }
              if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
                if (options.method === "PUT") {
                  const body = JSON.parse(options.body);
                  state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
                  return jsonResponse(200, { content: { sha: "state-after-write" } });
                }
                return jsonResponse(200, {
                  content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
                  sha: "state-before-read"
                });
              }
              if (parsed.pathname === "/repos/other/repo/actions/runs/999") {
                return jsonResponse(200, { status: "in_progress", conclusion: null });
              }
              return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
            }, async (logs) => {
              await assert.rejects(
                () =>
                  acquire({
                    token: "token",
                    lockName: "wallstop-organization-builds",
                    holderIdSuffix: "playmode",
                    lockRepository: "o/r",
                    lockRepo: { owner: "o", repo: "r" },
                    stateBranch: "lock-state",
                    statePath: "locks/wallstop-organization-builds.json",
                    timeoutMinutes: 1,
                    leaseMinutes: 240,
                    pollSeconds: 1
                  }),
                /holder=other\/repo:999:perf-benchmarks:editmode.*queue-position=1.*reason=awaiting scheduled reaper/
              );

              assert.match(logs.join("\n"), /Build-lock cleanup after timeout: queue-cleaned/);
              const outputs = readEnvironmentFile(outputFile);
              assertOutputContract(outputs, acquireOutputNames);
              assert.equal(outputs.acquired, "false");
              assert.equal(outputs["lock-name"], "wallstop-organization-builds");
              assert.equal(outputs["holder-id"], "owner/repo:123:perf-benchmarks:playmode");
              assert.equal(outputs["state-sha"], "");
              assert.equal(outputs.attempts, "1");
              assert.equal(outputs["stale-recovered"], "false");
            });
          });
        }
      );
    });
  } finally {
    Date.now = originalNow;
  }

  assert.deepEqual(state.queue, []);
  assert.equal(state.holder.holderId, "other/repo:999:perf-benchmarks:editmode");
});





test("release is idempotent when this run is not the holder", async () => {
  const state = {
    ...emptyState("wallstop-organization-builds"),
    holder: {
      holderId: "other/repo:999:perf-benchmarks:editmode",
      repository: "other/repo",
      workflow: "Perf",
      job: "perf-benchmarks",
      runId: "999",
      runAttempt: "1",
      runUrl: "https://github.com/other/repo/actions/runs/999",
      queuedAt: "2026-06-06T00:00:00.000Z",
      acquiredAt: "2026-06-06T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z"
    }
  };
  let wrote = false;

  await withActionEnv(
    {
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKFLOW: "Perf",
      GITHUB_JOB: "perf-benchmarks"
    },
    async () => {
    await withMockedFetch(async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
        return jsonResponse(200, { object: { sha: "branch-sha" } });
      }
      if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
        if (options.method === "PUT") {
          wrote = true;
        }
        return jsonResponse(200, {
          content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
          sha: "state-sha"
        });
      }
      return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
    }, async () => {
      await release({
        token: "token",
        lockName: "wallstop-organization-builds",
        holderIdSuffix: "playmode",
        lockRepository: "o/r",
        lockRepo: { owner: "o", repo: "r" },
        stateBranch: "lock-state",
        statePath: "locks/wallstop-organization-builds.json"
      });

      assert.equal(wrote, false);
    });
    }
  );
});

test("release reports released when this run holds the lock", async () => {
  const state = {
    ...emptyState("wallstop-organization-builds"),
    holder: {
      holderId: "owner/repo:123:perf-benchmarks:playmode",
      repository: "owner/repo",
      workflow: "Perf",
      job: "perf-benchmarks",
      runId: "123",
      runAttempt: "1",
      runUrl: "https://github.com/owner/repo/actions/runs/123",
      queuedAt: "2026-06-06T00:00:00.000Z",
      acquiredAt: "2026-06-06T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z"
    }
  };
  let writtenState = null;

  await withTempFile(async (outputFile) => {
    await withActionEnv(
      {
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_WORKFLOW: "Perf",
        GITHUB_JOB: "perf-benchmarks",
        GITHUB_OUTPUT: outputFile
      },
      async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
            if (options.method === "PUT") {
              const body = JSON.parse(options.body);
              writtenState = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
              return jsonResponse(200, { content: { sha: "state-after-release" } });
            }
            return jsonResponse(200, {
              content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
              sha: "state-before-release"
            });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await release({
            token: "token",
            lockName: "wallstop-organization-builds",
            holderIdSuffix: "playmode",
            lockRepository: "o/r",
            lockRepo: { owner: "o", repo: "r" },
            stateBranch: "lock-state",
            statePath: "locks/wallstop-organization-builds.json"
          });
        });
      }
    );

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, releaseOutputNames);
    assert.equal(outputs.released, "true");
    assert.equal(outputs["queue-cleaned"], "false");
    assert.equal(outputs["cleanup-result"], "released");
    assert.equal(outputs["lock-name"], "wallstop-organization-builds");
    assert.equal(outputs["holder-id"], "owner/repo:123:perf-benchmarks:playmode");
    assert.equal(outputs["state-sha"], "state-after-release");
    assert.equal(outputs["held-by"], "");
    assert.equal(outputs["held-by-run-url"], "");
  });

  assert.equal(writtenState.holder, null);
});

test("release reports released after an accepted cleanup write returns retryable failure then conflict", async () => {
  let state = {
    ...emptyState("wallstop-organization-builds"),
    holder: {
      holderId: "owner/repo:123:perf-benchmarks:playmode",
      repository: "owner/repo",
      workflow: "Perf",
      job: "perf-benchmarks",
      runId: "123",
      runAttempt: "1",
      runUrl: "https://github.com/owner/repo/actions/runs/123",
      queuedAt: "2026-06-06T00:00:00.000Z",
      acquiredAt: "2026-06-06T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z"
    }
  };
  let releasePutCalls = 0;

  await withTempFile(async (outputFile) => {
    await withActionEnv(
      {
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_WORKFLOW: "Perf",
        GITHUB_JOB: "perf-benchmarks",
        GITHUB_OUTPUT: outputFile
      },
      async () => {
        await withImmediateTimers(async () => {
          await withMockedFetch(async (url, options = {}) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
              return jsonResponse(200, { object: { sha: "branch-sha" } });
            }
            if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
              if (options.method === "PUT") {
                releasePutCalls++;
                const body = JSON.parse(options.body);
                state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
                if (releasePutCalls === 1) {
                  return jsonResponse(500, { message: "accepted but response failed" });
                }
                return jsonResponse(409, { message: "sha does not match" });
              }
              return jsonResponse(200, {
                content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
                sha: state.holder ? "state-before-release" : "state-after-release"
              });
            }
            return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
          }, async (logs) => {
            await release({
              token: "token",
              lockName: "wallstop-organization-builds",
              holderIdSuffix: "playmode",
              lockRepository: "o/r",
              lockRepo: { owner: "o", repo: "r" },
              stateBranch: "lock-state",
              statePath: "locks/wallstop-organization-builds.json"
            });

            assert.match(logs.join("\n"), /Released wallstop-organization-builds/);
          });
        });
      }
    );

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, releaseOutputNames);
    assert.equal(outputs.released, "true");
    assert.equal(outputs["queue-cleaned"], "false");
    assert.equal(outputs["cleanup-result"], "released");
    assert.equal(outputs["state-sha"], "state-after-release");
    assert.equal(outputs["held-by"], "");
    assert.equal(outputs["held-by-run-url"], "");
  });

  assert.equal(releasePutCalls, 2);
  assert.equal(state.holder, null);
});

test("release preserves fresh holder context after an ambiguous accepted cleanup write", async () => {
  const nextHolder = {
    holderId: "other/repo:456:perf-benchmarks:editmode",
    repository: "other/repo",
    workflow: "Perf",
    job: "perf-benchmarks",
    runId: "456",
    runAttempt: "1",
    runUrl: "https://github.com/other/repo/actions/runs/456",
    queuedAt: "2026-06-06T00:01:00.000Z",
    acquiredAt: "2026-06-06T00:01:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z"
  };
  let state = {
    ...emptyState("wallstop-organization-builds"),
    holder: {
      holderId: "owner/repo:123:perf-benchmarks:playmode",
      repository: "owner/repo",
      workflow: "Perf",
      job: "perf-benchmarks",
      runId: "123",
      runAttempt: "1",
      runUrl: "https://github.com/owner/repo/actions/runs/123",
      queuedAt: "2026-06-06T00:00:00.000Z",
      acquiredAt: "2026-06-06T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z"
    }
  };
  let releasePutCalls = 0;

  await withTempFile(async (outputFile) => {
    await withActionEnv(
      {
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_WORKFLOW: "Perf",
        GITHUB_JOB: "perf-benchmarks",
        GITHUB_OUTPUT: outputFile
      },
      async () => {
        await withImmediateTimers(async () => {
          await withMockedFetch(async (url, options = {}) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
              return jsonResponse(200, { object: { sha: "branch-sha" } });
            }
            if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
              if (options.method === "PUT") {
                releasePutCalls++;
                const body = JSON.parse(options.body);
                if (releasePutCalls === 1) {
                  state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
                  state = { ...state, holder: nextHolder, holders: [nextHolder] };
                  return jsonResponse(500, { message: "accepted but response failed" });
                }
                return jsonResponse(409, { message: "sha does not match" });
              }
              return jsonResponse(200, {
                content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
                sha: state.holder && state.holder.holderId === nextHolder.holderId
                  ? "state-after-next-acquire"
                  : "state-before-release"
              });
            }
            return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
          }, async (logs) => {
            await release({
              token: "token",
              lockName: "wallstop-organization-builds",
              holderIdSuffix: "playmode",
              lockRepository: "o/r",
              lockRepo: { owner: "o", repo: "r" },
              stateBranch: "lock-state",
              statePath: "locks/wallstop-organization-builds.json"
            });

            assert.match(logs.join("\n"), /Lock is held by other\/repo:456:perf-benchmarks:editmode/);
            assert.match(logs.join("\n"), /Released wallstop-organization-builds/);
          });
        });
      }
    );

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, releaseOutputNames);
    assert.equal(outputs.released, "true");
    assert.equal(outputs["queue-cleaned"], "false");
    assert.equal(outputs["cleanup-result"], "released");
    assert.equal(outputs["state-sha"], "state-after-next-acquire");
    assert.equal(outputs["held-by"], "other/repo:456:perf-benchmarks:editmode");
    assert.equal(outputs["held-by-run-url"], "https://github.com/other/repo/actions/runs/456");
  });

  assert.equal(releasePutCalls, 2);
});

test("release reports queue-cleaned when this run never acquired the lock", async () => {
  const state = {
    ...emptyState("wallstop-organization-builds"),
    holder: {
      holderId: "other/repo:999:perf-benchmarks:editmode",
      repository: "other/repo",
      workflow: "Perf",
      job: "perf-benchmarks",
      runId: "999",
      runAttempt: "1",
      runUrl: "https://github.com/other/repo/actions/runs/999",
      queuedAt: "2026-06-06T00:00:00.000Z",
      acquiredAt: "2026-06-06T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z"
    },
    queue: [
      {
        holderId: "owner/repo:123:perf-benchmarks:playmode",
        repository: "owner/repo",
        workflow: "Perf",
        job: "perf-benchmarks",
        runId: "123",
        runAttempt: "1",
        runUrl: "https://github.com/owner/repo/actions/runs/123",
        queuedAt: "2026-06-06T00:00:00.000Z"
      }
    ]
  };
  let writtenState = null;

  await withTempFile(async (outputFile) => {
    await withActionEnv(
      {
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW: "Perf",
        GITHUB_JOB: "perf-benchmarks",
        GITHUB_OUTPUT: outputFile
      },
      async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
            if (options.method === "PUT") {
              const body = JSON.parse(options.body);
              writtenState = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
              return jsonResponse(200, { content: { sha: "state-after-release" } });
            }
            return jsonResponse(200, {
              content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
              sha: "state-before-release"
            });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async (logs) => {
          await release({
            token: "token",
            lockName: "wallstop-organization-builds",
            holderIdSuffix: "playmode",
            lockRepository: "o/r",
            lockRepo: { owner: "o", repo: "r" },
            stateBranch: "lock-state",
            statePath: "locks/wallstop-organization-builds.json"
          });

          assert.match(logs.join("\n"), /Removed queued request/);
        });
      }
    );

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, releaseOutputNames);
    assert.equal(outputs.released, "false");
    assert.equal(outputs["queue-cleaned"], "true");
    assert.equal(outputs["cleanup-result"], "queue-cleaned");
    assert.equal(outputs["lock-name"], "wallstop-organization-builds");
    assert.equal(outputs["holder-id"], "owner/repo:123:perf-benchmarks:playmode");
    assert.equal(outputs["state-sha"], "state-after-release");
    assert.equal(outputs["held-by"], "other/repo:999:perf-benchmarks:editmode");
    assert.equal(outputs["held-by-run-url"], "https://github.com/other/repo/actions/runs/999");
  });

  assert.equal(writtenState.holder.holderId, "other/repo:999:perf-benchmarks:editmode");
  assert.deepEqual(writtenState.queue, []);
});

test("release reports queue-cleaned after an accepted cleanup write returns retryable failure then conflict", async () => {
  let state = {
    ...emptyState("wallstop-organization-builds"),
    holder: {
      holderId: "other/repo:999:perf-benchmarks:editmode",
      repository: "other/repo",
      workflow: "Perf",
      job: "perf-benchmarks",
      runId: "999",
      runAttempt: "1",
      runUrl: "https://github.com/other/repo/actions/runs/999",
      queuedAt: "2026-06-06T00:00:00.000Z",
      acquiredAt: "2026-06-06T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z"
    },
    queue: [
      {
        holderId: "owner/repo:123:perf-benchmarks:playmode",
        repository: "owner/repo",
        workflow: "Perf",
        job: "perf-benchmarks",
        runId: "123",
        runAttempt: "1",
        runUrl: "https://github.com/owner/repo/actions/runs/123",
        queuedAt: "2026-06-06T00:00:00.000Z"
      }
    ]
  };
  let releasePutCalls = 0;

  await withTempFile(async (outputFile) => {
    await withActionEnv(
      {
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW: "Perf",
        GITHUB_JOB: "perf-benchmarks",
        GITHUB_OUTPUT: outputFile
      },
      async () => {
        await withImmediateTimers(async () => {
          await withMockedFetch(async (url, options = {}) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
              return jsonResponse(200, { object: { sha: "branch-sha" } });
            }
            if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
              if (options.method === "PUT") {
                releasePutCalls++;
                const body = JSON.parse(options.body);
                state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
                if (releasePutCalls === 1) {
                  return jsonResponse(500, { message: "accepted but response failed" });
                }
                return jsonResponse(409, { message: "sha does not match" });
              }
              return jsonResponse(200, {
                content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
                sha: state.queue.length ? "state-before-release" : "state-after-release"
              });
            }
            return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
          }, async (logs) => {
            await release({
              token: "token",
              lockName: "wallstop-organization-builds",
              holderIdSuffix: "playmode",
              lockRepository: "o/r",
              lockRepo: { owner: "o", repo: "r" },
              stateBranch: "lock-state",
              statePath: "locks/wallstop-organization-builds.json"
            });

            assert.match(logs.join("\n"), /Removed queued request/);
          });
        });
      }
    );

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, releaseOutputNames);
    assert.equal(outputs.released, "false");
    assert.equal(outputs["queue-cleaned"], "true");
    assert.equal(outputs["cleanup-result"], "queue-cleaned");
    assert.equal(outputs["state-sha"], "state-after-release");
    assert.equal(outputs["held-by"], "other/repo:999:perf-benchmarks:editmode");
    assert.equal(outputs["held-by-run-url"], "https://github.com/other/repo/actions/runs/999");
  });

  assert.equal(releasePutCalls, 2);
  assert.equal(state.holder.holderId, "other/repo:999:perf-benchmarks:editmode");
  assert.deepEqual(state.queue, []);
});

test("release reports noop with holder context when this run has no state to clean", async () => {
  const state = {
    ...emptyState("wallstop-organization-builds"),
    holder: {
      holderId: "other/repo:999:perf-benchmarks:editmode",
      repository: "other/repo",
      workflow: "Perf",
      job: "perf-benchmarks",
      runId: "999",
      runAttempt: "1",
      runUrl: "https://github.com/other/repo/actions/runs/999",
      queuedAt: "2026-06-06T00:00:00.000Z",
      acquiredAt: "2026-06-06T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z"
    }
  };
  let wrote = false;

  await withTempFile(async (outputFile) => {
    await withActionEnv(
      {
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW: "Perf",
        GITHUB_JOB: "perf-benchmarks",
        GITHUB_OUTPUT: outputFile
      },
      async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
            if (options.method === "PUT") {
              wrote = true;
            }
            return jsonResponse(200, {
              content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
              sha: "state-sha"
            });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await release({
            token: "token",
            lockName: "wallstop-organization-builds",
            holderIdSuffix: "playmode",
            lockRepository: "o/r",
            lockRepo: { owner: "o", repo: "r" },
            stateBranch: "lock-state",
            statePath: "locks/wallstop-organization-builds.json"
          });
        });
      }
    );

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, releaseOutputNames);
    assert.equal(outputs.released, "false");
    assert.equal(outputs["queue-cleaned"], "false");
    assert.equal(outputs["cleanup-result"], "noop");
    assert.equal(outputs["lock-name"], "wallstop-organization-builds");
    assert.equal(outputs["holder-id"], "owner/repo:123:perf-benchmarks:playmode");
    assert.equal(outputs["state-sha"], "state-sha");
    assert.equal(outputs["held-by"], "other/repo:999:perf-benchmarks:editmode");
    assert.equal(outputs["held-by-run-url"], "https://github.com/other/repo/actions/runs/999");
  });

  assert.equal(wrote, false);
});

test("reap writes full output contract when no stale state is found", async () => {
  const state = emptyState("wallstop-organization-builds");
  let wrote = false;

  await withTempFile(async (outputFile) => {
    await withActionEnv({ GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
          if (options.method === "PUT") {
            wrote = true;
          }
          return jsonResponse(200, {
            content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
            sha: "state-sha"
          });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await reap({
          token: "token",
          lockName: "wallstop-organization-builds",
          lockRepository: "o/r",
          lockRepo: { owner: "o", repo: "r" },
          stateBranch: "lock-state",
          statePath: "locks/wallstop-organization-builds.json"
        });
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, reapOutputNames);
    assert.equal(outputs.reaped, "false");
    assert.equal(outputs["state-sha"], "state-sha");
  });

  assert.equal(wrote, false);
});

test("reap writes full output contract when a stale holder is removed", async () => {
  let state = {
    ...emptyState("wallstop-organization-builds"),
    holder: {
      holderId: "owner/repo:123:perf-benchmarks:playmode",
      repository: "owner/repo",
      workflow: "Perf",
      job: "perf-benchmarks",
      runId: "123",
      runAttempt: "1",
      runUrl: "https://github.com/owner/repo/actions/runs/123",
      queuedAt: "2026-06-06T00:00:00.000Z",
      acquiredAt: "2026-06-06T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z"
    }
  };

  await withTempFile(async (outputFile) => {
    await withActionEnv({ GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
          if (options.method === "PUT") {
            const body = JSON.parse(options.body);
            state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "state-after-reap" } });
          }
          return jsonResponse(200, {
            content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
            sha: "state-before-reap"
          });
        }
        if (parsed.pathname === "/repos/owner/repo/actions/runs/123") {
          return jsonResponse(200, { status: "completed", conclusion: "success" });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await reap({
          token: "token",
          lockName: "wallstop-organization-builds",
          lockRepository: "o/r",
          lockRepo: { owner: "o", repo: "r" },
          stateBranch: "lock-state",
          statePath: "locks/wallstop-organization-builds.json"
        });
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, reapOutputNames);
    assert.equal(outputs.reaped, "true");
    assert.equal(outputs["state-sha"], "state-after-reap");
  });

  assert.equal(state.holder, null);
});

test("reap reports reaped after an accepted write returns retryable failure then conflict", async () => {
  let state = {
    ...emptyState("wallstop-organization-builds"),
    holder: {
      holderId: "owner/repo:123:perf-benchmarks:playmode",
      repository: "owner/repo",
      workflow: "Perf",
      job: "perf-benchmarks",
      runId: "123",
      runAttempt: "1",
      runUrl: "https://github.com/owner/repo/actions/runs/123",
      queuedAt: "2026-06-06T00:00:00.000Z",
      acquiredAt: "2026-06-06T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z"
    }
  };
  let reapPutCalls = 0;

  await withTempFile(async (outputFile) => {
    await withActionEnv({ GITHUB_OUTPUT: outputFile }, async () => {
      await withImmediateTimers(async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
            if (options.method === "PUT") {
              reapPutCalls++;
              const body = JSON.parse(options.body);
              state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
              if (reapPutCalls === 1) {
                return jsonResponse(500, { message: "accepted but response failed" });
              }
              return jsonResponse(409, { message: "sha does not match" });
            }
            return jsonResponse(200, {
              content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
              sha: state.holder ? "state-before-reap" : "state-after-reap"
            });
          }
          if (parsed.pathname === "/repos/owner/repo/actions/runs/123") {
            return jsonResponse(200, { status: "completed", conclusion: "success" });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await reap({
            token: "token",
            lockName: "wallstop-organization-builds",
            lockRepository: "o/r",
            lockRepo: { owner: "o", repo: "r" },
            stateBranch: "lock-state",
            statePath: "locks/wallstop-organization-builds.json"
          });
        });
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, reapOutputNames);
    assert.equal(outputs.reaped, "true");
    assert.equal(outputs["state-sha"], "state-after-reap");
  });

  assert.equal(reapPutCalls, 2);
  assert.equal(state.holder, null);
});

test("reap writes full output contract when only completed queue entries are removed", async () => {
  let state = {
    ...emptyState("wallstop-organization-builds"),
    queue: [
      {
        holderId: "owner/repo:123:perf-benchmarks:playmode",
        repository: "owner/repo",
        workflow: "Perf",
        job: "perf-benchmarks",
        runId: "123",
        runAttempt: "1",
        runUrl: "https://github.com/owner/repo/actions/runs/123",
        queuedAt: "2026-06-06T00:00:00.000Z"
      }
    ]
  };

  await withTempFile(async (outputFile) => {
    await withActionEnv({ GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
          if (options.method === "PUT") {
            const body = JSON.parse(options.body);
            state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "state-after-reap" } });
          }
          return jsonResponse(200, {
            content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
            sha: "state-before-reap"
          });
        }
        if (parsed.pathname === "/repos/owner/repo/actions/runs/123") {
          return jsonResponse(200, { status: "completed", conclusion: "success" });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await reap({
          token: "token",
          lockName: "wallstop-organization-builds",
          lockRepository: "o/r",
          lockRepo: { owner: "o", repo: "r" },
          stateBranch: "lock-state",
          statePath: "locks/wallstop-organization-builds.json"
        });
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, reapOutputNames);
    assert.equal(outputs.reaped, "true");
    assert.equal(outputs["state-sha"], "state-after-reap");
  });

  assert.deepEqual(state.queue, []);
});

test("post cleanup noops without saved action state", async () => {
  let calls = 0;

  await withActionEnv({}, async () => {
    await withMockedFetch(async () => {
      calls++;
      return jsonResponse(500, { message: "should not be called" });
    }, async (logs) => {
      await postCleanup({
        token: "token",
        lockName: "wallstop-organization-builds",
        holderIdSuffix: "playmode",
        lockRepository: "o/r",
        lockRepo: { owner: "o", repo: "r" },
        stateBranch: "lock-state",
        statePath: "locks/wallstop-organization-builds.json"
      });

      assert.match(logs.join("\n"), /No build-lock post cleanup state recorded/);
    });
  });

  assert.equal(calls, 0);
});

test("post cleanup warns instead of throwing when cleanup cannot contact lock state", async () => {
  await withActionEnv(
    {
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKFLOW: "Perf",
      GITHUB_JOB: "perf-benchmarks",
      STATE_build_lock_cleanup: "enabled"
    },
    async () => {
      await withEnvironment({ BUILD_LOCK_API_MAX_ATTEMPTS: "1" }, async () => {
        await withMockedFetch(async (url) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(401, { message: "Bad credentials" });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async (logs) => {
          await postCleanup({
            token: "token",
            lockName: "wallstop-organization-builds",
            holderIdSuffix: "playmode",
            lockRepository: "o/r",
            lockRepo: { owner: "o", repo: "r" },
            stateBranch: "lock-state",
            statePath: "locks/wallstop-organization-builds.json"
          });

          assert.match(logs.join("\n"), /::warning::Post cleanup for wallstop-organization-builds failed/);
        });
      });
    }
  );
});

test("post cleanup reports cleanup after an accepted write returns retryable failure then conflict", async () => {
  let state = {
    ...emptyState("wallstop-organization-builds"),
    holder: {
      holderId: "owner/repo:123:perf-benchmarks:playmode",
      repository: "owner/repo",
      workflow: "Perf",
      job: "perf-benchmarks",
      runId: "123",
      runAttempt: "1",
      runUrl: "https://github.com/owner/repo/actions/runs/123",
      queuedAt: "2026-06-06T00:00:00.000Z",
      acquiredAt: "2026-06-06T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z"
    }
  };
  let cleanupPutCalls = 0;

  await withActionEnv(
    {
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKFLOW: "Perf",
      GITHUB_JOB: "perf-benchmarks",
      STATE_build_lock_cleanup: "enabled"
    },
    async () => {
      await withImmediateTimers(async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
            if (options.method === "PUT") {
              cleanupPutCalls++;
              const body = JSON.parse(options.body);
              state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
              if (cleanupPutCalls === 1) {
                return jsonResponse(500, { message: "accepted but response failed" });
              }
              return jsonResponse(409, { message: "sha does not match" });
            }
            return jsonResponse(200, {
              content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
              sha: state.holder ? "state-before-cleanup" : "state-after-cleanup"
            });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async (logs) => {
          await postCleanup({
            token: "token",
            lockName: "wallstop-organization-builds",
            holderIdSuffix: "playmode",
            lockRepository: "o/r",
            lockRepo: { owner: "o", repo: "r" },
            stateBranch: "lock-state",
            statePath: "locks/wallstop-organization-builds.json"
          });

          assert.match(logs.join("\n"), /Post cleanup for wallstop-organization-builds: released/);
        });
      });
    }
  );

  assert.equal(cleanupPutCalls, 2);
  assert.equal(state.holder, null);
});

test("post cleanup wrapper exits successfully when saved state exists but token is missing", () => {
  const result = childProcess.spawnSync(process.execPath, [path.join(__dirname, "..", ".github", "dist", "post-cleanup.js")], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      BUILD_LOCK_TOKEN: "",
      GITHUB_REPOSITORY: authorizedConsumerEnv.GITHUB_REPOSITORY,
      GITHUB_REPOSITORY_ID: authorizedConsumerEnv.GITHUB_REPOSITORY_ID,
      GITHUB_REPOSITORY_OWNER_ID: authorizedConsumerEnv.GITHUB_REPOSITORY_OWNER_ID,
      "INPUT_LOCK-NAME": "wallstop-organization-builds",
      STATE_build_lock_cleanup: "enabled"
    }
  });

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /::warning::Build lock post cleanup could not start: Provide BUILD_LOCK_APP_ID with BUILD_LOCK_APP_PRIVATE_KEY/
  );
  assert.equal(result.stderr, "");
});

test("stale evaluation fails fast when run status cannot be read due to missing actions permission", async () => {
  const holder = {
    holderId: "owner/repo:123:perf-benchmarks:playmode",
    repository: "owner/repo",
    workflow: "Perf",
    job: "perf-benchmarks",
    runId: "123",
    runAttempt: "1",
    runUrl: "https://github.com/owner/repo/actions/runs/123",
    queuedAt: "2026-06-06T00:00:00.000Z",
    acquiredAt: "2026-06-06T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z"
  };

  await withMockedFetch(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/repos/owner/repo/actions/runs/123") {
      return jsonResponse(403, { message: "Resource not accessible by integration" });
    }
    return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
  }, async () => {
    await assert.rejects(
      () => evaluateStale(holder, "token"),
      /Ensure the build-lock credentials have actions: read access/
    );
  });
});

test("stale evaluation keeps lease fallback only for missing workflow runs", async () => {
  const holder = {
    holderId: "owner/repo:123:perf-benchmarks:playmode",
    repository: "owner/repo",
    workflow: "Perf",
    job: "perf-benchmarks",
    runId: "123",
    runAttempt: "1",
    runUrl: "https://github.com/owner/repo/actions/runs/123",
    queuedAt: "2026-06-06T00:00:00.000Z",
    acquiredAt: "2026-06-06T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z"
  };
  const calls = [];

  await withMockedFetch(async (url) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname);
    if (parsed.pathname === "/repos/owner/repo/actions/runs/123") {
      return jsonResponse(404, { message: "Not Found" });
    }
    if (parsed.pathname === "/repos/owner/repo") {
      return jsonResponse(200, { full_name: "owner/repo" });
    }
    return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
  }, async () => {
    assert.deepEqual(await evaluateStale(holder, "token"), {
      stale: false,
      reason: "holder status unavailable before lease expiry"
    });
  });

  assert.deepEqual(calls, ["/repos/owner/repo/actions/runs/123", "/repos/owner/repo"]);
});

test("stale evaluation rejects lease fallback when the repository cannot be read", async () => {
  const holder = {
    holderId: "owner/private-repo:123:perf-benchmarks:playmode",
    repository: "owner/private-repo",
    workflow: "Perf",
    job: "perf-benchmarks",
    runId: "123",
    runAttempt: "1",
    runUrl: "https://github.com/owner/private-repo/actions/runs/123",
    queuedAt: "2026-06-06T00:00:00.000Z",
    acquiredAt: "2026-06-06T00:00:00.000Z",
    expiresAt: "2026-06-06T01:00:00.000Z"
  };

  await withMockedFetch(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/repos/owner/private-repo/actions/runs/123") {
      return jsonResponse(404, { message: "Not Found" });
    }
    if (parsed.pathname === "/repos/owner/private-repo") {
      return jsonResponse(404, { message: "Not Found" });
    }
    return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
  }, async () => {
    await assert.rejects(
      () => evaluateStale(holder, "token"),
      /Ensure the build-lock credentials can read this repository and have actions: read access/
    );
  });
});

test("stale evaluation keeps waiting when the run-status poll returns 401 before lease expiry", async () => {
  const holder = {
    holderId: "owner/repo:123:perf-benchmarks:playmode",
    repository: "owner/repo",
    workflow: "Perf",
    job: "perf-benchmarks",
    runId: "123",
    runAttempt: "1",
    runUrl: "https://github.com/owner/repo/actions/runs/123",
    queuedAt: "2026-06-06T00:00:00.000Z",
    acquiredAt: "2026-06-06T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z"
  };

  await withEnvironment({ BUILD_LOCK_API_MAX_ATTEMPTS: "1" }, async () => {
    await withMockedFetch(
      async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/owner/repo/actions/runs/123") {
          return jsonResponse(401, { message: "Bad credentials" }, { "x-github-request-id": "REQID" });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      },
      async (logs) => {
        // A transient/expired-credential 401 on the read-only holder poll must NOT abort the
        // wait: report status unknown and let the lease govern (keep waiting until it expires).
        assert.deepEqual(await evaluateStale(holder, "token"), {
          stale: false,
          reason: "holder status unavailable before lease expiry"
        });
        assert.match(logs.join("\n"), /HTTP 401/);
      }
    );
  });
});

test("stale evaluation delegates newer run-attempt reconciliation to the reaper", async () => {
  const holder = {
    holderId: "owner/repo:123:perf-benchmarks:playmode",
    repository: "owner/repo",
    workflow: "Perf",
    job: "perf-benchmarks",
    runId: "123",
    runAttempt: "1",
    runUrl: "https://github.com/owner/repo/actions/runs/123",
    queuedAt: "2026-06-06T00:00:00.000Z",
    acquiredAt: "2026-06-06T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z"
  };
  await withMockedFetch(
    async () => jsonResponse(200, { status: "in_progress", run_attempt: 2 }),
    async () => {
      assert.deepEqual(await evaluateStale(holder, "reader"), {
        stale: true,
        reason: "workflow run advanced from attempt 1 to 2"
      });
    }
  );
});

// ---------------------------------------------------------------------------
// Configurable parallelism (issue #13): the lock acts as a counting semaphore.
// locks/<lock-name>.config.json on the lock repository's default branch sets
// {"maxHolders": N}; missing or invalid config fails closed to a single holder.
// ---------------------------------------------------------------------------

const SEMAPHORE_STATE_PATH = "/repos/o/r/contents/locks/wallstop-organization-builds.json";
const SEMAPHORE_CONFIG_PATH = "/repos/o/r/contents/locks/wallstop-organization-builds.config.json";

function semaphoreHolder(repository, runId, suffix) {
  return {
    holderId: `${repository}:${runId}:perf-benchmarks:${suffix}`,
    repository,
    workflow: "Perf",
    job: "perf-benchmarks",
    runId,
    runAttempt: "1",
    runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
    queuedAt: "2026-06-06T00:00:00.000Z",
    acquiredAt: "2026-06-06T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z"
  };
}

function withRunner(entry, runnerId) {
  return { ...entry, runnerId };
}

function semaphoreQueueEntry(repository, runId, suffix) {
  const { acquiredAt: _acquiredAt, expiresAt: _expiresAt, ...entry } = semaphoreHolder(repository, runId, suffix);
  return entry;
}

function semaphoreState(holders, queue = []) {
  return {
    schemaVersion: 2,
    lock: "wallstop-organization-builds",
    holder: holders[0] || null,
    holders,
    queue,
    updatedAt: "2026-06-06T00:00:00.000Z"
  };
}

function lifecycleReservation(holder, overrides = {}) {
  return {
    reservationId: `reservation-${holder.runnerId}`,
    holderId: holder.holderId,
    repository: holder.repository,
    workflow: holder.workflow,
    job: holder.job,
    runId: holder.runId,
    runAttempt: holder.runAttempt,
    runUrl: holder.runUrl,
    runnerId: holder.runnerId,
    state: "quarantine",
    reason: "cleanup outcome unknown",
    createdAt: "2026-06-06T00:01:00.000Z",
    ...overrides
  };
}

function lifecycleState(holders = [], queue = [], reservations = []) {
  return {
    ...semaphoreState(holders, queue),
    schemaVersion: 4,
    reservations
  };
}

function semaphoreConfig(overrides = {}) {
  return {
    token: "token",
    lockName: "wallstop-organization-builds",
    holderIdSuffix: "playmode",
    lockRepository: "o/r",
    lockRepo: { owner: "o", repo: "r" },
    stateBranch: "lock-state",
    statePath: "locks/wallstop-organization-builds.json",
    configPath: "locks/wallstop-organization-builds.config.json",
    timeoutMinutes: 1,
    leaseMinutes: 240,
    pollSeconds: 1,
    ...overrides
  };
}

function base64Content(value, sha) {
  return jsonResponse(200, {
    content: Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64"),
    sha
  });
}

test("acquire fails closed when its loaded config snapshot does not meet lifecycle requirements", async (t) => {
  const cases = [
    {
      name: "lifecycle is disabled",
      lockConfig: { maxHolders: 1, resourceLifecycle: false, releaseCooldownSeconds: 360 },
      requirements: { requireResourceLifecycle: true, minimumReleaseCooldownSeconds: 0 },
      error: /requires resourceLifecycle=true/
    },
    {
      name: "cooldown is below the requested minimum",
      lockConfig: {
        maxHolders: 1,
        runnerSerialization: true,
        resourceLifecycle: true,
        releaseCooldownSeconds: 359
      },
      requirements: { requireResourceLifecycle: true, minimumReleaseCooldownSeconds: 360 },
      error: /releaseCooldownSeconds >= 360.*loaded value is 359/
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let stateReads = 0;
      let stateBranchAccesses = 0;
      await withActionEnv(semaphoreActionEnv, async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            stateBranchAccesses++;
            return jsonResponse(404, { message: `unexpected state branch ${options.method || "GET"}` });
          }
          if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.config.json") {
            return base64Content(testCase.lockConfig, "config-sha");
          }
          if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
            stateReads++;
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await assert.rejects(() => acquire(semaphoreConfig(testCase.requirements)), testCase.error);
        });
      });
      assert.equal(stateBranchAccesses, 0, "requirements must reject before state branch access");
      assert.equal(stateReads, 0, "requirements must reject the loaded acquire snapshot before state mutation");
    });
  }
});

test("acquire revalidates lifecycle requirements on the refreshed config snapshot", async () => {
  let configReads = 0;
  let stateReads = 0;
  await withEnvironment({ BUILD_LOCK_CONFIG_TTL_MS: "0" }, async () => {
    await withActionEnv(semaphoreActionEnv, async () => {
      await withMockedFetch(async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.config.json") {
          configReads++;
          return base64Content(
            configReads === 1
              ? {
                  maxHolders: 1,
                  runnerSerialization: true,
                  resourceLifecycle: true,
                  releaseCooldownSeconds: 360
                }
              : { maxHolders: 1, resourceLifecycle: false, releaseCooldownSeconds: 360 },
            `config-${configReads}`
          );
        }
        if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
          stateReads++;
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await assert.rejects(
          () =>
            acquire(
              semaphoreConfig({
                requireResourceLifecycle: true,
                minimumReleaseCooldownSeconds: 360
              })
            ),
          /requires resourceLifecycle=true/
        );
      });
    });
  });
  assert.equal(configReads, 2);
  assert.equal(stateReads, 0, "the rejected refreshed snapshot must not be used for state mutation");
});

const semaphoreActionEnv = {
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_REPOSITORY_ID: "101020635",
  GITHUB_REPOSITORY_OWNER_ID: "212056428",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_WORKFLOW: "Perf",
  GITHUB_JOB: "perf-benchmarks"
};

test("consumer acquire keeps expired holders authoritative without cross-repository status reads", async () => {
  const originalNow = Date.now;
  let now = 0;
  const active = {
    ...withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-b"),
    expiresAt: "1970-01-01T00:00:01.000Z"
  };
  const state = lifecycleState([active]);
  let actionsReads = 0;
  Date.now = () => {
    now += 30000;
    return now;
  };
  try {
    await withActionEnv(semaphoreActionEnv, async () => {
      await withImmediateTimers(async () => {
        await withMockedFetch(async (url) => {
          const parsed = new URL(url);
          if (parsed.pathname.includes("/actions/runs/")) {
            actionsReads++;
            return jsonResponse(200, { status: "completed" });
          }
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) return base64Content({ maxHolders: 1, runnerSerialization: true, resourceLifecycle: true }, "cfg");
          if (parsed.pathname === SEMAPHORE_STATE_PATH) return base64Content(state, "state");
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await assert.rejects(
            () => acquire(semaphoreConfig({ runnerId: "runner-a", timeoutMinutes: 1 })),
            /timed out/i
          );
        });
      });
    });
  } finally {
    Date.now = originalNow;
  }
  assert.equal(actionsReads, 0);
});

test("committed lock config files are well-formed", () => {
  // An invalid committed config fails closed to one holder at runtime; catch it here
  // at review time instead.
  const locksDirectory = path.join(__dirname, "..", "locks");
  const configFiles = fs.readdirSync(locksDirectory).filter((name) => name.endsWith(".config.json"));
  for (const file of configFiles) {
    const parsed = JSON.parse(fs.readFileSync(path.join(locksDirectory, file), "utf8"));
    assert.ok(
      Number.isInteger(parsed.maxHolders) && parsed.maxHolders >= 1 && parsed.maxHolders <= 64,
      `${file} must declare an integer maxHolders between 1 and 64, got ${JSON.stringify(parsed.maxHolders)}`
    );
    if (Object.hasOwn(parsed, "runnerSerialization")) {
      assert.equal(
        typeof parsed.runnerSerialization,
        "boolean",
        `${file} runnerSerialization must be a boolean when present`
      );
    }
    if (Object.hasOwn(parsed, "resourceLifecycle")) {
      assert.equal(typeof parsed.resourceLifecycle, "boolean", `${file} resourceLifecycle must be a boolean`);
      if (parsed.resourceLifecycle) {
        assert.equal(parsed.runnerSerialization, true, `${file} enabled lifecycle requires runnerSerialization=true`);
      }
    }
    if (Object.hasOwn(parsed, "accountHealth")) {
      assert.equal(typeof parsed.accountHealth, "boolean", `${file} accountHealth must be a boolean`);
      if (parsed.accountHealth) {
        assert.equal(parsed.resourceLifecycle, true, `${file} enabled account health requires resourceLifecycle=true`);
      }
    }
    if (Object.hasOwn(parsed, "releaseCooldownSeconds")) {
      assert.ok(
        Number.isInteger(parsed.releaseCooldownSeconds) &&
          parsed.releaseCooldownSeconds >= 1 &&
          parsed.releaseCooldownSeconds <= 86400,
        `${file} releaseCooldownSeconds must be an integer between 1 and 86400`
      );
    }
  }
});

test("readLockConfig fails closed to a single holder", async (t) => {
  const cases = [
    { name: "missing config file", response: () => jsonResponse(404, { message: "Not Found" }), maxHolders: 1 },
    {
      name: "config read auth outage",
      response: () => jsonResponse(401, { message: "Bad credentials" }, { "x-github-request-id": "AUTH401" }),
      maxHolders: 1,
      warning: /Unable to read lock config.*HTTP 401.*AUTH401/
    },
    { name: "valid maxHolders", response: () => base64Content({ maxHolders: 3 }, "cfg"), maxHolders: 3 },
    {
      name: "runner serialization enabled",
      response: () => base64Content({ maxHolders: 2, runnerSerialization: true }, "cfg"),
      maxHolders: 2,
      runnerSerialization: true
    },
    {
      name: "resource lifecycle enabled",
      response: () => base64Content({
        maxHolders: 2,
        runnerSerialization: true,
        resourceLifecycle: true,
        releaseCooldownSeconds: 420
      }, "cfg"),
      maxHolders: 2,
      runnerSerialization: true,
      resourceLifecycle: true,
      releaseCooldownSeconds: 420
    },
    {
      name: "account health enabled",
      response: () => base64Content({
        maxHolders: 1,
        runnerSerialization: true,
        resourceLifecycle: true,
        accountHealth: true
      }, "cfg"),
      maxHolders: 1,
      runnerSerialization: true,
      resourceLifecycle: true,
      accountHealth: true
    },
    {
      name: "account health requires resource lifecycle",
      response: () => base64Content({ runnerSerialization: true, accountHealth: true }, "cfg"),
      maxHolders: 1,
      warning: /accountHealth=true.*resourceLifecycle must also be true/
    },
    {
      name: "resource lifecycle requires runner serialization",
      response: () => base64Content({ maxHolders: 2, resourceLifecycle: true }, "cfg"),
      maxHolders: 1,
      warning: /runnerSerialization must also be true; using safe defaults \(max-holders=1, runner-serialization=false, resource-lifecycle=false/
    },
    {
      name: "invalid runner serialization fails disabled",
      response: () => base64Content({ maxHolders: 2, runnerSerialization: "true" }, "cfg"),
      maxHolders: 1,
      warning: /Ignoring invalid runnerSerialization.*using safe defaults \(max-holders=1, runner-serialization=false, resource-lifecycle=false/
    },
    {
      name: "invalid resource lifecycle fails safe",
      response: () => base64Content({ maxHolders: 2, runnerSerialization: true, resourceLifecycle: "true" }, "cfg"),
      maxHolders: 1,
      warning: /Ignoring invalid resourceLifecycle.*using safe defaults \(max-holders=1, runner-serialization=false, resource-lifecycle=false/
    },
    { name: "numeric string maxHolders", response: () => base64Content({ maxHolders: "4" }, "cfg"), maxHolders: 4 },
    { name: "config without maxHolders", response: () => base64Content({}, "cfg"), maxHolders: 1 },
    {
      name: "malformed JSON",
      response: () => base64Content("{oops", "cfg"),
      maxHolders: 1,
      warning: /not valid JSON/
    },
    {
      name: "zero maxHolders",
      response: () => base64Content({ maxHolders: 0 }, "cfg"),
      maxHolders: 1,
      warning: /Ignoring invalid maxHolders/
    },
    {
      name: "fractional maxHolders",
      response: () => base64Content({ maxHolders: 2.5 }, "cfg"),
      maxHolders: 1,
      warning: /Ignoring invalid maxHolders/
    },
    {
      name: "maxHolders above the cap",
      response: () => base64Content({ maxHolders: 1000 }, "cfg"),
      maxHolders: 1,
      warning: /Ignoring invalid maxHolders/
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await withMockedFetch(
        async (url) => {
          const parsed = new URL(url);
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return testCase.response();
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        },
        async (logs) => {
          const lockConfig = await readLockConfig(semaphoreConfig(), {
            apiOptions: {
              maxAttempts: 1,
              baseDelayMs: 0,
              maxDelayMs: 0,
              sleep: async () => {}
            }
          });
          assert.deepEqual(lockConfig, {
            maxHolders: testCase.maxHolders,
            runnerSerialization: testCase.runnerSerialization || false,
            resourceLifecycle: testCase.resourceLifecycle || false,
            accountHealth: testCase.accountHealth || false,
            releaseCooldownSeconds: testCase.releaseCooldownSeconds || 360
          });
          if (testCase.warning) {
            assert.match(logs.join("\n"), testCase.warning);
          } else {
            assert.equal(logs.filter((line) => line.includes("::warning::")).length, 0);
          }
        }
      );
    });
  }
});

test("acquire fails closed when the initial lock config read hits an auth outage", async () => {
  let state = semaphoreState([]);
  let configReads = 0;
  let putCalls = 0;

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withEnvironment({ BUILD_LOCK_API_MAX_ATTEMPTS: "1" }, async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            configReads++;
            return jsonResponse(401, { message: "Bad credentials" }, { "x-github-request-id": "AUTH401" });
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              putCalls++;
              const body = JSON.parse(options.body);
              state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
              return jsonResponse(200, { content: { sha: "state-after-acquire" } });
            }
            return base64Content(state, "state-sha");
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async (logs) => {
          await acquire(semaphoreConfig());

          assert.match(logs.join("\n"), /Unable to read lock config/);
          assert.match(logs.join("\n"), /Max concurrent holders: 1/);
        });
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, acquireOutputNames);
    assert.equal(outputs.acquired, "true");
  });

  assert.equal(configReads, 1);
  assert.equal(putCalls, 1);
  assert.deepEqual(
    state.holders.map((entry) => entry.holderId),
    ["owner/repo:123:perf-benchmarks:playmode"]
  );
});

test("normalizeState migrates legacy single-holder files and dedupes the mirror", () => {
  const holder = semaphoreHolder("other/repo", "999", "editmode");

  const legacy = normalizeState(
    { schemaVersion: 1, lock: "wallstop-organization-builds", holder, queue: [] },
    "wallstop-organization-builds"
  );
  assert.equal(legacy.schemaVersion, 2);
  assert.equal(legacy.holders.length, 1);
  assert.equal(legacy.holders[0].holderId, holder.holderId);

  const mirrored = normalizeState(
    semaphoreState([holder, semaphoreHolder("other/repo", "888", "playmode")]),
    "wallstop-organization-builds"
  );
  assert.deepEqual(
    mirrored.holders.map((entry) => entry.holderId),
    ["other/repo:999:perf-benchmarks:editmode", "other/repo:888:perf-benchmarks:playmode"]
  );
});

test("normalizeState rejects state files written by a newer schema", () => {
  assert.throws(
    () =>
      normalizeState(
        { schemaVersion: 6, lock: "wallstop-organization-builds", holders: [], queue: [] },
        "wallstop-organization-builds"
      ),
    /unsupported/
  );
});

test("schema 3 preserves physical runner identity", () => {
  const holder = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "unity-runner-a");
  const queued = withRunner(semaphoreQueueEntry("other/repo", "888", "playmode"), "unity-runner-b");

  const normalized = normalizeState(
    { ...semaphoreState([holder], [queued]), schemaVersion: 3 },
    "wallstop-organization-builds"
  );

  assert.equal(normalized.schemaVersion, 3);
  assert.equal(normalized.holders[0].runnerId, "unity-runner-a");
  assert.equal(normalized.queue[0].runnerId, "unity-runner-b");
});

test("schema 3 rejects entries without physical runner identity", () => {
  assert.throws(
    () =>
      normalizeState(
        { ...semaphoreState([semaphoreHolder("other/repo", "999", "editmode")]), schemaVersion: 3 },
        "wallstop-organization-builds"
      ),
    /missing runnerId/
  );
});

test("runner-aware admission skips blocked runners without wasting free slots", async (t) => {
  const a1 = withRunner(semaphoreQueueEntry("queue/repo", "101", "a1"), "runner-a");
  const a2 = withRunner(semaphoreQueueEntry("queue/repo", "102", "a2"), "runner-a");
  const b1 = withRunner(semaphoreQueueEntry("queue/repo", "201", "b1"), "runner-b");
  const c1 = withRunner(semaphoreQueueEntry("queue/repo", "301", "c1"), "runner-c");
  const activeA = withRunner(semaphoreHolder("active/repo", "1", "active-a"), "runner-a");

  const cases = [
    {
      name: "two requests from one runner consume only one of two slots",
      holders: [],
      queue: [a1, a2, b1],
      freeSlots: 2,
      expected: [a1.holderId, b1.holderId]
    },
    {
      name: "an active runner does not block a later different runner",
      holders: [activeA],
      queue: [a1, b1],
      freeSlots: 1,
      expected: [b1.holderId]
    },
    {
      name: "FIFO is retained within each runner",
      holders: [],
      queue: [a1, b1, a2, c1],
      freeSlots: 3,
      expected: [a1.holderId, b1.holderId, c1.holderId]
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      assert.deepEqual(
        selectEligibleQueueEntries(testCase.holders, testCase.queue, testCase.freeSlots).map(
          (entry) => entry.holderId
        ),
        testCase.expected
      );
    });
  }
});

test("runner serialization activation upgrades only an empty schema 2 state", async () => {
  let state = semaphoreState([]);

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
          return base64Content({ maxHolders: 2, runnerSerialization: true }, "cfg");
        }
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            const body = JSON.parse(options.body);
            state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "schema-3-state" } });
          }
          return base64Content(state, "state-sha");
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await acquire(semaphoreConfig({ runnerId: "unity-runner-a" }));
      });
    });

    assert.equal(readEnvironmentFile(outputFile).acquired, "true");
  });

  assert.equal(state.schemaVersion, 3);
  assert.equal(state.holders[0].runnerId, "unity-runner-a");
});

test("runner serialization activation fails closed without a runner or with live schema 2 state", async (t) => {
  const cases = [
    { name: "missing runner id", state: semaphoreState([]), runnerId: "", error: /runner-id is required/ },
    {
      name: "live schema 2 holder",
      state: semaphoreState([semaphoreHolder("other/repo", "999", "editmode")]),
      runnerId: "unity-runner-a",
      error: /drain the lock/
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let putCalls = 0;
      await withActionEnv(semaphoreActionEnv, async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return base64Content({ maxHolders: 2, runnerSerialization: true }, "cfg");
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              putCalls++;
            }
            return base64Content(testCase.state, "state-sha");
          }
          if (parsed.pathname === "/repos/other/repo/actions/runs/999") {
            return jsonResponse(200, { status: "in_progress", conclusion: null });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await assert.rejects(
            () => acquire(semaphoreConfig({ runnerId: testCase.runnerId })),
            testCase.error
          );
        });
      });
      assert.equal(putCalls, 0);
    });
  }
});

test("schema 3 acquire skips a queued request whose runner already holds a slot", async () => {
  const activeA = withRunner(semaphoreHolder("other/repo", "999", "active"), "runner-a");
  const queuedA = withRunner(semaphoreQueueEntry("queue/repo", "888", "waiting"), "runner-a");
  let state = { ...semaphoreState([activeA], [queuedA]), schemaVersion: 3 };

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
          return base64Content({ maxHolders: 2, runnerSerialization: true }, "cfg");
        }
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            const body = JSON.parse(options.body);
            state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "schema-3-state" } });
          }
          return base64Content(state, "state-sha");
        }
        if (
          parsed.pathname === "/repos/other/repo/actions/runs/999" ||
          parsed.pathname === "/repos/queue/repo/actions/runs/888"
        ) {
          return jsonResponse(200, { status: "in_progress", conclusion: null });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await acquire(semaphoreConfig({ runnerId: "runner-b" }));
      });
    });

    assert.equal(readEnvironmentFile(outputFile).acquired, "true");
  });

  assert.deepEqual(
    state.holders.map((holder) => [holder.holderId, holder.runnerId]),
    [
      [activeA.holderId, "runner-a"],
      ["owner/repo:123:perf-benchmarks:playmode", "runner-b"]
    ]
  );
  assert.deepEqual(state.queue.map((entry) => entry.holderId), [queuedA.holderId]);
});


test("schema 3 rejects one run attempt reporting conflicting physical runners", async () => {
  const active = withRunner(semaphoreHolder("owner/repo", "123", "playmode"), "runner-old");
  const state = { ...semaphoreState([active]), schemaVersion: 3 };
  let putCalls = 0;

  await withActionEnv(semaphoreActionEnv, async () => {
    await withMockedFetch(async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
        return jsonResponse(200, { object: { sha: "branch-sha" } });
      }
      if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
        return base64Content({ maxHolders: 2, runnerSerialization: true }, "cfg");
      }
      if (parsed.pathname === SEMAPHORE_STATE_PATH) {
        if (options.method === "PUT") {
          putCalls++;
        }
        return base64Content(state, "state-sha");
      }
      if (parsed.pathname === "/repos/owner/repo/actions/runs/123") {
        return jsonResponse(200, { status: "in_progress", conclusion: null });
      }
      return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
    }, async () => {
      await assert.rejects(
        () => acquire(semaphoreConfig({ runnerId: "runner-new" })),
        /refusing conflicting identity/
      );
    });
  });

  assert.equal(putCalls, 0);
});

test("schema 3 rejects a stale run attempt after a newer rerun owns the holder", async () => {
  const newerAttempt = {
    ...withRunner(semaphoreHolder("owner/repo", "123", "playmode"), "runner-new"),
    runAttempt: "2"
  };
  const state = { ...semaphoreState([newerAttempt]), schemaVersion: 3 };

  await withActionEnv(semaphoreActionEnv, async () => {
    await withMockedFetch(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
        return jsonResponse(200, { object: { sha: "branch-sha" } });
      }
      if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
        return base64Content({ maxHolders: 2, runnerSerialization: true }, "cfg");
      }
      if (parsed.pathname === SEMAPHORE_STATE_PATH) {
        return base64Content(state, "state-sha");
      }
      if (parsed.pathname === "/repos/owner/repo/actions/runs/123") {
        return jsonResponse(200, { status: "in_progress", conclusion: null });
      }
      return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
    }, async () => {
      await assert.rejects(
        () => acquire(semaphoreConfig({ runnerId: "runner-old" })),
        /refusing stale attempt 1/
      );
    });
  });
});

test("schema 3 queue identity advances monotonically across reruns", async (t) => {
  const cases = [
    { name: "older attempt rejected", storedAttempt: "2", incomingAttempt: "1", error: /refusing stale attempt 1/ },
    {
      name: "same attempt on another runner rejected",
      storedAttempt: "1",
      incomingAttempt: "1",
      error: /refusing conflicting identity/
    },
    { name: "malformed stored attempt rejected", storedAttempt: "invalid", incomingAttempt: "1", invalid: true },
    { name: "malformed incoming attempt rejected", storedAttempt: "1", incomingAttempt: "0", invalid: true },
    { name: "newer attempt replaces and acquires", storedAttempt: "1", incomingAttempt: "2" }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const queued = {
        ...withRunner(semaphoreQueueEntry("owner/repo", "123", "playmode"), "runner-stored"),
        runAttempt: testCase.storedAttempt
      };
      let state = { ...semaphoreState([], [queued]), schemaVersion: 3 };
      let putCalls = 0;

      await withActionEnv({ ...semaphoreActionEnv, GITHUB_RUN_ATTEMPT: testCase.incomingAttempt }, async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return base64Content({ maxHolders: 2, runnerSerialization: true }, "cfg");
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              putCalls++;
              const body = JSON.parse(options.body);
              state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
              return jsonResponse(200, { content: { sha: "updated" } });
            }
            return base64Content(state, "state-sha");
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          const operation = () => acquire(semaphoreConfig({ runnerId: "runner-incoming" }));
          if (testCase.invalid) {
            await assert.rejects(operation, {
              name: "Error",
              message:
                "Queued request owner/repo:123:perf-benchmarks:playmode has invalid run attempts " +
                `(stored=${JSON.stringify(testCase.storedAttempt)}, ` +
                `incoming=${JSON.stringify(testCase.incomingAttempt)}); expected positive decimal integers.`
            });
          } else if (testCase.error) {
            await assert.rejects(operation, testCase.error);
          } else {
            await operation();
          }
        });
      });

      if (testCase.error || testCase.invalid) {
        assert.equal(putCalls, 0);
      } else {
        assert.equal(state.holders[0].runAttempt, "2");
        assert.equal(state.holders[0].runnerId, "runner-incoming");
      }
    });
  }
});

test("activated acquire rejects schema downgrade during post-write verification", async () => {
  let stateReads = 0;
  const downgradedHolder = semaphoreHolder("owner/repo", "123", "playmode");

  await withActionEnv(semaphoreActionEnv, async () => {
    await withImmediateTimers(async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
          return base64Content({ maxHolders: 2, runnerSerialization: true }, "cfg");
        }
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            return jsonResponse(200, { content: { sha: "claimed-write" } });
          }
          stateReads++;
          return stateReads === 1
            ? base64Content(semaphoreState([]), "state-before")
            : base64Content(semaphoreState([downgradedHolder]), "downgraded-state");
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await assert.rejects(
          () => acquire(semaphoreConfig({ runnerId: "runner-a" })),
          /drain the lock/
        );
      });
    });
  });
});

test("normalizeState fails closed on malformed schemas and duplicate active runners", async (t) => {
  const holderA = withRunner(semaphoreHolder("other/repo", "999", "a"), "runner-a");
  const holderA2 = withRunner(semaphoreHolder("other/repo", "888", "b"), "runner-a");
  const cases = [
    { name: "null state", state: null, error: /JSON object/ },
    { name: "non-object", state: [], error: /JSON object/ },
    { name: "empty object", state: {}, error: /lock mismatch/ },
    {
      name: "nonnumeric version",
      state: { schemaVersion: "garbage", lock: "wallstop-organization-builds", holder: null, queue: [] },
      error: /unsupported/
    },
    {
      name: "null schema 3 queue entry",
      state: { ...semaphoreState([]), schemaVersion: 3, queue: [null] },
      error: /queue entries.*non-empty holderId/
    },
    {
      name: "null schema 2 holder",
      state: { ...semaphoreState([]), holders: [null] },
      error: /holder entries.*non-empty holderId/
    },
    {
      name: "primitive schema 2 holder",
      state: { ...semaphoreState([]), holders: ["holder"] },
      error: /holder entries.*non-empty holderId/
    },
    {
      name: "missing schema 2 legacy mirror",
      state: { schemaVersion: 2, lock: "wallstop-organization-builds", holders: [], queue: [] },
      error: /legacy holder mirror/
    },
    {
      name: "null schema 2 mirror with active holder",
      state: { ...semaphoreState([semaphoreHolder("other/repo", "999", "active")]), holder: null },
      error: /mirror.*match the first holder/
    },
    {
      name: "mismatched schema 2 mirror",
      state: {
        ...semaphoreState([
          semaphoreHolder("other/repo", "999", "first"),
          semaphoreHolder("other/repo", "888", "second")
        ]),
        holder: semaphoreHolder("other/repo", "888", "second")
      },
      error: /mirror.*match the first holder/
    },
    {
      name: "same-id schema 2 mirror with mismatched run metadata",
      state: (() => {
        const holder = semaphoreHolder("other/repo", "999", "first");
        return { ...semaphoreState([holder]), holder: { ...holder, runId: "different" } };
      })(),
      error: /mirror.*match the first holder/
    },
    {
      name: "malformed legacy holder",
      state: { schemaVersion: 1, lock: "wallstop-organization-builds", holder: "holder", queue: [] },
      error: /Legacy holder/
    },
    {
      name: "schema 3 holders not array",
      state: { schemaVersion: 3, lock: "wallstop-organization-builds", holders: {}, queue: [] },
      error: /holders.*array/
    },
    {
      name: "duplicate physical holder",
      state: { ...semaphoreState([holderA, holderA2]), schemaVersion: 3 },
      error: /multiple active holders/
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      assert.throws(() => normalizeState(testCase.state, "wallstop-organization-builds"), testCase.error);
    });
  }
});

test("acquire takes a free slot alongside an active holder when max holders allows", async () => {
  const activeHolder = semaphoreHolder("other/repo", "888", "editmode");
  let state = semaphoreState([activeHolder]);
  let putCalls = 0;

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
          return base64Content({ maxHolders: 2 }, "cfg");
        }
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            putCalls++;
            const body = JSON.parse(options.body);
            state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "state-after-acquire" } });
          }
          return base64Content(state, "state-sha");
        }
        if (parsed.pathname === "/repos/other/repo/actions/runs/888") {
          return jsonResponse(200, { status: "in_progress", conclusion: null });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async (logs) => {
        await acquire(semaphoreConfig());

        assert.match(logs.join("\n"), /Max concurrent holders: 2/);
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, acquireOutputNames);
    assert.equal(outputs.acquired, "true");
    assert.equal(outputs["stale-recovered"], "false");
  });

  assert.equal(putCalls, 1);
  assert.deepEqual(
    state.holders.map((entry) => entry.holderId),
    ["other/repo:888:perf-benchmarks:editmode", "owner/repo:123:perf-benchmarks:playmode"]
  );
  assert.equal(state.schemaVersion, 2, "compatible clients must keep writing schema 2 before activation");
  assert.equal(state.holders.some((entry) => Object.hasOwn(entry, "runnerId")), false);
  assert.equal(state.holder.holderId, activeHolder.holderId, "legacy mirror must stay the first holder");
  assert.deepEqual(state.queue, []);
});

test("acquire waits when the configured max holders are all active", async () => {
  const originalNow = Date.now;
  let now = 0;
  let state = semaphoreState([
    semaphoreHolder("other/repo", "888", "editmode"),
    semaphoreHolder("other/repo", "999", "playmode")
  ]);

  Date.now = () => {
    now += 30000;
    return now;
  };

  try {
    await withTempFile(async (outputFile) => {
      await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
        await withImmediateTimers(async () => {
          await withMockedFetch(async (url, options = {}) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
              return jsonResponse(200, { object: { sha: "branch-sha" } });
            }
            if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
              return base64Content({ maxHolders: 2 }, "cfg");
            }
            if (parsed.pathname === SEMAPHORE_STATE_PATH) {
              if (options.method === "PUT") {
                const body = JSON.parse(options.body);
                state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
                return jsonResponse(200, { content: { sha: "state-after-write" } });
              }
              return base64Content(state, "state-sha");
            }
            if (
              parsed.pathname === "/repos/other/repo/actions/runs/888" ||
              parsed.pathname === "/repos/other/repo/actions/runs/999"
            ) {
              return jsonResponse(200, { status: "in_progress", conclusion: null });
            }
            return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
          }, async () => {
            await assert.rejects(() => acquire(semaphoreConfig()), /Timed out waiting for build lock/);
          });
        });
      });

      const outputs = readEnvironmentFile(outputFile);
      assertOutputContract(outputs, acquireOutputNames);
      assert.equal(outputs.acquired, "false");
    });
  } finally {
    Date.now = originalNow;
  }

  assert.deepEqual(
    state.holders.map((entry) => entry.holderId),
    ["other/repo:888:perf-benchmarks:editmode", "other/repo:999:perf-benchmarks:playmode"]
  );
  assert.deepEqual(state.queue, [], "timeout cleanup must remove this run's queue entry");
});

test("acquire admits a second queue entry when two slots are free", async () => {
  let state = semaphoreState([], [semaphoreQueueEntry("other/repo", "888", "editmode")]);
  let putCalls = 0;

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
          return base64Content({ maxHolders: 2 }, "cfg");
        }
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            putCalls++;
            const body = JSON.parse(options.body);
            state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "state-after-acquire" } });
          }
          return base64Content(state, "state-sha");
        }
        if (parsed.pathname === "/repos/other/repo/actions/runs/888") {
          return jsonResponse(200, { status: "in_progress", conclusion: null });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await acquire(semaphoreConfig());
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, acquireOutputNames);
    assert.equal(outputs.acquired, "true");
  });

  assert.equal(putCalls, 1);
  assert.deepEqual(
    state.holders.map((entry) => entry.holderId),
    ["owner/repo:123:perf-benchmarks:playmode"]
  );
  assert.deepEqual(
    state.queue.map((entry) => entry.holderId),
    ["other/repo:888:perf-benchmarks:editmode"],
    "the earlier queue entry must keep its place at the queue front"
  );
});


test("acquire picks up a raised max-holders limit while waiting", async () => {
  const originalNow = Date.now;
  let now = 0;
  let configReads = 0;
  let state = semaphoreState([semaphoreHolder("other/repo", "888", "editmode")]);

  Date.now = () => {
    now += 30000;
    return now;
  };

  try {
    await withTempFile(async (outputFile) => {
      await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
        await withEnvironment({ BUILD_LOCK_CONFIG_TTL_MS: "60000" }, async () => {
          await withImmediateTimers(async () => {
            await withMockedFetch(async (url, options = {}) => {
              const parsed = new URL(url);
              if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
                return jsonResponse(200, { object: { sha: "branch-sha" } });
              }
              if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
                configReads++;
                return base64Content({ maxHolders: configReads === 1 ? 1 : 2 }, "cfg");
              }
              if (parsed.pathname === SEMAPHORE_STATE_PATH) {
                if (options.method === "PUT") {
                  const body = JSON.parse(options.body);
                  state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
                  return jsonResponse(200, { content: { sha: "state-after-write" } });
                }
                return base64Content(state, "state-sha");
              }
              if (parsed.pathname === "/repos/other/repo/actions/runs/888") {
                return jsonResponse(200, { status: "in_progress", conclusion: null });
              }
              return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
            }, async (logs) => {
              await acquire(semaphoreConfig({ timeoutMinutes: 30 }));

              assert.match(logs.join("\n"), /Max concurrent holders changed from 1 to 2/);
            });
          });
        });
      });

      const outputs = readEnvironmentFile(outputFile);
      assertOutputContract(outputs, acquireOutputNames);
      assert.equal(outputs.acquired, "true");
    });
  } finally {
    Date.now = originalNow;
  }

  assert.ok(configReads >= 2, `expected the lock config to be re-read on TTL, saw ${configReads} reads`);
  assert.deepEqual(
    state.holders.map((entry) => entry.holderId),
    ["other/repo:888:perf-benchmarks:editmode", "owner/repo:123:perf-benchmarks:playmode"]
  );
});

test("release preserves schema 3 runner identities while removing only this run's slot", async () => {
  const myHolder = withRunner(semaphoreHolder("owner/repo", "123", "playmode"), "runner-a");
  const firstCoHolder = withRunner(semaphoreHolder("other/repo", "888", "editmode"), "runner-b");
  const secondCoHolder = withRunner(semaphoreHolder("other/repo", "999", "playmode"), "runner-c");
  let state = { ...semaphoreState([myHolder, firstCoHolder, secondCoHolder]), schemaVersion: 3 };

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            const body = JSON.parse(options.body);
            state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "state-after-release" } });
          }
          return base64Content(state, "state-sha");
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await release(semaphoreConfig({ runnerId: "runner-a" }));
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, releaseOutputNames);
    assert.equal(outputs.released, "true");
    assert.equal(outputs["cleanup-result"], "released");
    assert.equal(outputs["held-by"], "other/repo:888:perf-benchmarks:editmode");
    assert.equal(outputs["held-by-run-url"], "https://github.com/other/repo/actions/runs/888");
  });

  assert.deepEqual(
    state.holders.map((entry) => [entry.holderId, entry.runnerId]),
    [
      ["other/repo:888:perf-benchmarks:editmode", "runner-b"],
      ["other/repo:999:perf-benchmarks:playmode", "runner-c"]
    ]
  );
  assert.equal(state.schemaVersion, 3);
  assert.equal(state.holder.holderId, firstCoHolder.holderId, "legacy mirror must follow the first remaining holder");
});

test("release holder-id targets the original job from a fallback runner", async (t) => {
  const held = withRunner(semaphoreHolder("owner/repo", "123", "playmode"), "self-hosted-runner");
  const cases = [
    { name: "exact target", target: held.holderId, released: true },
    { name: "unknown target in the same run", target: "owner/repo:123:other-job:playmode", released: false },
    { name: "different workflow run", target: "owner/repo:456:perf-benchmarks:playmode", error: true },
    { name: "different repository", target: "other/repo:123:perf-benchmarks:playmode", error: true }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let state = { ...semaphoreState([held]), schemaVersion: 3 };
      let putCalls = 0;
      await withTempFile(async (outputFile) => {
        await withActionEnv(
          {
            ...semaphoreActionEnv,
            GITHUB_JOB: "cleanup-fallback",
            GITHUB_OUTPUT: outputFile
          },
          async () => {
            await withMockedFetch(async (url, options = {}) => {
              const parsed = new URL(url);
              if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
                return jsonResponse(200, { object: { sha: "branch-sha" } });
              }
              if (parsed.pathname === SEMAPHORE_STATE_PATH) {
                if (options.method === "PUT") {
                  putCalls++;
                  const body = JSON.parse(options.body);
                  state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
                  return jsonResponse(200, { content: { sha: "state-after-cleanup" } });
                }
                return base64Content(state, "state-sha");
              }
              return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
            }, async () => {
              const operation = () => release(semaphoreConfig({
                runnerId: "github-hosted-fallback",
                targetHolderId: testCase.target
              }));
              if (testCase.error) {
                await assert.rejects(operation, /holder-id must identify a job in the current repository and workflow run/);
              } else {
                await operation();
              }
            });
          }
        );

        if (!testCase.error) {
          const outputs = readEnvironmentFile(outputFile);
          assert.equal(outputs["holder-id"], testCase.target);
          assert.equal(outputs.released, String(testCase.released));
        }
      });

      assert.equal(putCalls, testCase.released ? 1 : 0);
      assert.equal(state.holders.length, testCase.released ? 0 : 1);
    });
  }
});

test("schema 3 cleanup uses exact holder id with a monotonic attempt fence", async (t) => {
  const cases = [];
  for (const location of ["active holder", "queued request"]) {
    for (const ownership of [
      {
        name: "older caller is fenced out",
        storedRunner: "runner-new",
        storedAttempt: "2",
        callerRunner: "runner-old",
        callerAttempt: "1",
        cleaned: false
      },
      {
        name: "same attempt can clean up from a different runner",
        storedRunner: "runner-dead",
        storedAttempt: "1",
        callerRunner: "github-hosted-fallback",
        callerAttempt: "1",
        cleaned: true
      },
      {
        name: "newer attempt can clean up an older attempt",
        storedRunner: "runner-old",
        storedAttempt: "1",
        callerRunner: "runner-new",
        callerAttempt: "2",
        cleaned: true
      },
      {
        name: "malformed stored attempt fails closed",
        storedRunner: "runner-old",
        storedAttempt: "invalid",
        callerRunner: "runner-new",
        callerAttempt: "2",
        cleaned: false,
        error: true
      },
      {
        name: "malformed caller attempt fails closed",
        storedRunner: "runner-old",
        storedAttempt: "1",
        callerRunner: "runner-new",
        callerAttempt: "0",
        cleaned: false,
        error: true
      }
    ]) {
      const storedIdentity = {
        ...withRunner(semaphoreQueueEntry("owner/repo", "123", "playmode"), ownership.storedRunner),
        runAttempt: ownership.storedAttempt
      };
      cases.push({
        name: `${location}: ${ownership.name}`,
        callerRunner: ownership.callerRunner,
        storedAttempt: ownership.storedAttempt,
        callerAttempt: ownership.callerAttempt,
        cleaned: ownership.cleaned,
        error: ownership.error || false,
        state: location === "active holder"
          ? {
              ...semaphoreState([{ ...storedIdentity, acquiredAt: storedIdentity.queuedAt, expiresAt: "2999-01-01T00:00:00.000Z" }]),
              schemaVersion: 3
            }
          : { ...semaphoreState([], [storedIdentity]), schemaVersion: 3 }
      });
    }
  }

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let putCalls = 0;
      let writtenState = null;
      await withActionEnv({ ...semaphoreActionEnv, GITHUB_RUN_ATTEMPT: testCase.callerAttempt }, async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              putCalls++;
              const body = JSON.parse(options.body);
              writtenState = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
              return jsonResponse(200, { content: { sha: "state-after-cleanup" } });
            }
            return base64Content(testCase.state, "state-sha");
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          const operation = () => release(semaphoreConfig({ runnerId: testCase.callerRunner }));
          if (testCase.error) {
            await assert.rejects(
              operation,
              {
                name: "Error",
                message:
                  "Build-lock cleanup owner/repo:123:perf-benchmarks:playmode has invalid run attempts " +
                  `(stored=${JSON.stringify(testCase.storedAttempt)}, ` +
                  `caller=${JSON.stringify(testCase.callerAttempt)}); expected positive decimal integers.`
              }
            );
          } else {
            await operation();
          }
        });
      });
      assert.equal(putCalls, testCase.cleaned ? 1 : 0);
      if (testCase.cleaned) {
        assert.deepEqual(writtenState.holders, []);
        assert.deepEqual(writtenState.queue, []);
      } else {
        assert.equal(writtenState, null);
      }
    });
  }
});

test("schema 3 cleanup fails closed without runner-id", async () => {
  const state = { ...semaphoreState([]), schemaVersion: 3 };
  await withActionEnv(semaphoreActionEnv, async () => {
    await withMockedFetch(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
        return jsonResponse(200, { object: { sha: "branch-sha" } });
      }
      if (parsed.pathname === SEMAPHORE_STATE_PATH) {
        return base64Content(state, "state-sha");
      }
      return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
    }, async () => {
      await assert.rejects(() => release(semaphoreConfig()), /runner-id is required to clean up schema 3/);
    });
  });
});

test("reap preserves schema 3 runner identity while dropping only stale holders", async () => {
  const staleHolder = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-a");
  const activeHolder = withRunner(semaphoreHolder("other/repo", "888", "playmode"), "runner-b");
  let state = { ...semaphoreState([staleHolder, activeHolder]), schemaVersion: 3 };

  await withTempFile(async (outputFile) => {
    await withActionEnv({ GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            const body = JSON.parse(options.body);
            state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "state-after-reap" } });
          }
          return base64Content(state, "state-sha");
        }
        if (parsed.pathname === "/repos/other/repo/actions/runs/999") {
          return jsonResponse(200, { status: "completed", conclusion: "success" });
        }
        if (parsed.pathname === "/repos/other/repo/actions/runs/888") {
          return jsonResponse(200, { status: "in_progress", conclusion: null });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await reap(semaphoreConfig());
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, reapOutputNames);
    assert.equal(outputs.reaped, "true");
    assert.equal(outputs["state-sha"], "state-after-reap");
  });

  assert.deepEqual(
    state.holders.map((entry) => [entry.holderId, entry.runnerId]),
    [["other/repo:888:perf-benchmarks:playmode", "runner-b"]]
  );
  assert.equal(state.schemaVersion, 3);
});

test("stale evaluation reclaims when the run-status poll returns 401 after lease expiry", async () => {
  const holder = {
    holderId: "owner/repo:123:perf-benchmarks:playmode",
    repository: "owner/repo",
    workflow: "Perf",
    job: "perf-benchmarks",
    runId: "123",
    runAttempt: "1",
    runUrl: "https://github.com/owner/repo/actions/runs/123",
    queuedAt: "2026-06-06T00:00:00.000Z",
    acquiredAt: "2026-06-06T00:00:00.000Z",
    expiresAt: "2026-06-06T01:00:00.000Z"
  };

  await withEnvironment({ BUILD_LOCK_API_MAX_ATTEMPTS: "1" }, async () => {
    await withMockedFetch(
      async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/owner/repo/actions/runs/123") {
          return jsonResponse(401, { message: "Bad credentials" });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      },
      async () => {
        // Once the lease has expired, an unknown (401) status means the holder is presumed dead
        // and the lock is reclaimable -- the lease, not the poll, is the liveness backstop.
        assert.deepEqual(await evaluateStale(holder, "token"), {
          stale: true,
          reason: "holder lease expired and run status is unavailable"
        });
      }
    );
  });
});

test("schema 4 reservations round-trip and malformed lifecycle state fails closed", async (t) => {
  const holder = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-a");
  const quarantine = lifecycleReservation(holder);
  const cooldown = lifecycleReservation(holder, {
    reservationId: "cooldown-a",
    state: "cooldown",
    availableAt: "2026-06-06T00:07:00.000Z"
  });

  for (const reservation of [quarantine, cooldown]) {
    await t.test(`${reservation.state} round-trip`, () => {
      const normalized = normalizeState(lifecycleState([], [], [reservation]), "wallstop-organization-builds");
      assert.deepEqual(normalized.reservations, [reservation]);
    });
  }

  const cases = [
    { name: "missing reservations", mutate: (state) => delete state.reservations, error: /reservations.*array/ },
    { name: "invalid state", mutate: (state) => { state.reservations[0].state = "free"; }, error: /invalid state/ },
    { name: "cooldown without availability", mutate: (state) => { state.reservations[0].state = "cooldown"; }, error: /availableAt/ },
    { name: "missing original metadata", mutate: (state) => { state.reservations[0].repository = ""; }, error: /original holder\/run metadata/ },
    { name: "duplicate reservation id", mutate: (state) => { state.reservations.push({ ...state.reservations[0] }); }, error: /duplicate reservationId/ },
    {
      name: "duplicate reserved runner",
      mutate: (state) => { state.reservations.push({ ...state.reservations[0], reservationId: "other-id", holderId: "other-holder" }); },
      error: /multiple reservations on one runnerId/
    },
    {
      name: "holder and reservation share runner",
      state: lifecycleState([holder], [], [quarantine]),
      error: /both holder and reservation/
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const state = testCase.state || lifecycleState([], [], [{ ...quarantine }]);
      if (testCase.mutate) testCase.mutate(state);
      assert.throws(() => normalizeState(state, "wallstop-organization-builds"), testCase.error);
    });
  }
});

test("schema 4 release transitions ownership to cooldown or quarantine", async (t) => {
  for (const testCase of [
    { resourceSafe: true, result: "cooldown-started", state: "cooldown", available: true },
    { resourceSafe: false, result: "quarantined", state: "quarantine", available: false }
  ]) {
    await t.test(testCase.result, async () => {
      const held = withRunner(semaphoreHolder("owner/repo", "123", "playmode"), "runner-a");
      let state = lifecycleState([held]);
      await withTempFile(async (outputFile) => {
        await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
          await withMockedFetch(async (url, options = {}) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
              return jsonResponse(200, { object: { sha: "branch-sha" } });
            }
            if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
              return base64Content({ maxHolders: 1, runnerSerialization: true, resourceLifecycle: true, releaseCooldownSeconds: 360 }, "cfg");
            }
            if (parsed.pathname === SEMAPHORE_STATE_PATH) {
              if (options.method === "PUT") {
                state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
                return jsonResponse(200, { content: { sha: "released-sha" } });
              }
              return base64Content(state, "state-sha");
            }
            return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
          }, async (logs) => {
            await release(semaphoreConfig({ runnerId: "runner-a", resourceSafe: testCase.resourceSafe }));
            const message = testCase.result === "cooldown-started"
              ? /Removed lock ownership.*resource capacity entered cooldown/
              : /Removed lock ownership.*resource capacity is quarantined/;
            assert.match(logs.join("\n"), message);
            assert.doesNotMatch(logs.join("\n"), /Released wallstop-organization-builds/);
          });
        });
        const outputs = readEnvironmentFile(outputFile);
        assert.equal(outputs.released, "true");
        assert.equal(outputs["cleanup-result"], testCase.result);
        assert.equal(outputs["reservation-state"], testCase.state);
        assert.ok(outputs["reservation-id"]);
        assert.equal(Boolean(outputs["available-at"]), testCase.available);
      });
      assert.equal(state.holders.length, 0);
      assert.equal(state.reservations.length, 1);
      assert.equal(state.reservations[0].runnerId, "runner-a");
      assert.equal(state.reservations[0].state, testCase.state);
    });
  }
});

test("ambiguous schema 4 release reports the reservation persisted by a concurrent cleanup", async () => {
  const held = withRunner(semaphoreHolder("owner/repo", "123", "playmode"), "runner-a");
  const concurrentReservation = lifecycleReservation(held, { reservationId: "concurrent-quarantine" });
  let state = lifecycleState([held]);
  let putCalls = 0;
  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withImmediateTimers(async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return base64Content(
              {
                maxHolders: 1,
                runnerSerialization: true,
                resourceLifecycle: true,
                releaseCooldownSeconds: 360
              },
              "cfg"
            );
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              putCalls++;
              if (putCalls === 1) {
                state = lifecycleState([], [], [concurrentReservation]);
                return jsonResponse(500, { message: "ambiguous mutation response" });
              }
              return jsonResponse(409, { message: "sha does not match" });
            }
            return base64Content(state, state.holders.length ? "before" : "after-concurrent-release");
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, () => release(semaphoreConfig({ runnerId: "runner-a", resourceSafe: true })));
      });
    });
    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs.released, "true");
    assert.equal(outputs["cleanup-result"], "quarantined");
    assert.equal(outputs["reservation-id"], "concurrent-quarantine");
    assert.equal(outputs["reservation-state"], "quarantine");
    assert.equal(outputs["available-at"], "");
  });
  assert.equal(putCalls, 2);
});

test("ambiguous schema 4 release remains released when its cooldown expires before reconciliation", async () => {
  const held = withRunner(semaphoreHolder("owner/repo", "123", "playmode"), "runner-a");
  const expiredCooldown = lifecycleReservation(held, {
    reservationId: "expired-concurrent-cooldown",
    state: "cooldown",
    availableAt: "2026-06-06T00:02:00.000Z"
  });
  let state = lifecycleState([held]);
  let putCalls = 0;
  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withImmediateTimers(async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return base64Content({ maxHolders: 1, runnerSerialization: true, resourceLifecycle: true }, "cfg");
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              putCalls++;
              if (putCalls === 1) {
                state = lifecycleState([], [], [expiredCooldown]);
                return jsonResponse(500, { message: "ambiguous mutation response" });
              }
              if (putCalls === 2 || putCalls === 4) return jsonResponse(409, { message: "sha does not match" });
              state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
              return jsonResponse(500, { message: "ambiguous prune response" });
            }
            return base64Content(state, state.holders.length ? "before" : "after-concurrent-release");
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, () => release(semaphoreConfig({ runnerId: "runner-a", resourceSafe: true })));
      });
    });
    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs.released, "true");
    assert.equal(outputs["cleanup-result"], "released");
    assert.equal(outputs["reservation-id"], "");
  });
  assert.equal(putCalls, 4);
  assert.deepEqual(state.reservations, []);
});

test("schema 4 quarantine can be reclaimed only on the same runner", async () => {
  const prior = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-a");
  let state = lifecycleState([], [], [lifecycleReservation(prior)]);

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
          return base64Content({ maxHolders: 1, runnerSerialization: true }, "cfg");
        }
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "acquired-sha" } });
          }
          return base64Content(state, "state-sha");
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, () => acquire(semaphoreConfig({ runnerId: "runner-a" })));
    });
    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs.acquired, "true");
    assert.equal(outputs["quarantine-recovered"], "true");
  });

  assert.equal(state.reservations.length, 0);
  assert.deepEqual(state.holders.map((holder) => holder.runnerId), ["runner-a"]);
});

test("same-runner quarantine recovery waits while a reduced limit leaves state over capacity", async () => {
  const originalNow = Date.now;
  let now = 0;
  const active = withRunner(semaphoreHolder("active/repo", "888", "active"), "runner-b");
  const prior = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-a");
  let state = lifecycleState([active], [], [lifecycleReservation(prior)]);
  Date.now = () => {
    now += 30000;
    return now;
  };
  try {
    await withActionEnv(semaphoreActionEnv, async () => {
      await withImmediateTimers(async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return base64Content({ maxHolders: 1, runnerSerialization: true }, "cfg");
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
              return jsonResponse(200, { content: { sha: "write-sha" } });
            }
            return base64Content(state, "state-sha");
          }
          if (parsed.pathname === "/repos/active/repo/actions/runs/888") {
            return jsonResponse(200, { status: "in_progress" });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await assert.rejects(
            () => acquire(semaphoreConfig({ runnerId: "runner-a", timeoutMinutes: 1 })),
            /capacity reserved by .*quarantine/
          );
        });
      });
    });
  } finally {
    Date.now = originalNow;
  }
  assert.deepEqual(state.holders.map((holder) => holder.runnerId), ["runner-b"]);
  assert.deepEqual(state.reservations.map((reservation) => reservation.runnerId), ["runner-a"]);
});

test("schema 4 quarantine never expires or admits a different runner during config outage", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-06-06T00:01:00.000Z");
  const prior = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-a");
  let state = lifecycleState([], [], [lifecycleReservation(prior)]);
  Date.now = () => {
    now += 30000;
    return now;
  };
  try {
    await withActionEnv(semaphoreActionEnv, async () => {
      await withImmediateTimers(async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) return jsonResponse(404, { message: "config unavailable" });
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
              return jsonResponse(200, { content: { sha: "write-sha" } });
            }
            return base64Content(state, "state-sha");
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await assert.rejects(
            () => acquire(semaphoreConfig({ runnerId: "runner-b", timeoutMinutes: 1 })),
            /capacity reserved by .*quarantine/
          );
        });
      });
    });
  } finally {
    Date.now = originalNow;
  }
  assert.equal(state.holders.length, 0);
  assert.equal(state.reservations.length, 1);
  assert.equal(state.reservations[0].state, "quarantine");
  assert.deepEqual(state.queue, []);
});

test("schema 4 cooldown blocks cross-runner admission until it expires", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-06-06T00:01:00.000Z");
  const prior = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-a");
  let state = lifecycleState([], [], [lifecycleReservation(prior, {
    state: "cooldown",
    availableAt: "2026-06-06T00:07:00.000Z"
  })]);
  Date.now = () => now;
  try {
    await withTempFile(async (outputFile) => {
      await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) return base64Content({ maxHolders: 1, runnerSerialization: true }, "cfg");
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
              now = Date.parse("2026-06-06T00:07:01.000Z");
              return jsonResponse(200, { content: { sha: "write-sha" } });
            }
            return base64Content(state, "state-sha");
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await withImmediateTimers(() => acquire(semaphoreConfig({ runnerId: "runner-b", pollSeconds: 1, timeoutMinutes: 10 })));
        });
      });
      assert.equal(readEnvironmentFile(outputFile).acquired, "true");
    });
  } finally {
    Date.now = originalNow;
  }
  assert.equal(state.reservations.length, 0);
  assert.deepEqual(state.holders.map((holder) => holder.runnerId), ["runner-b"]);
});

test("manual confirmed recovery moves an exact quarantine into cooldown", async () => {
  const prior = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-a");
  let state = lifecycleState([], [], [lifecycleReservation(prior)]);
  await withTempFile(async (outputFile) => {
    await withActionEnv({ GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
        if (parsed.pathname === SEMAPHORE_CONFIG_PATH) return base64Content({ releaseCooldownSeconds: 360 }, "cfg");
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "recovered-sha" } });
          }
          return base64Content(state, "state-sha");
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, () => reap(semaphoreConfig({ operation: "recover", reservationId: "reservation-runner-a", resourceSafe: true })));
    });
  });
  assert.equal(state.reservations[0].state, "cooldown");
  assert.ok(Date.parse(state.reservations[0].availableAt) > Date.now());
});

test("manual recovery accepts an ambiguous write when the reservation disappears", async () => {
  const prior = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-a");
  let state = lifecycleState([], [], [lifecycleReservation(prior)]);
  let putCalls = 0;
  await withTempFile(async (outputFile) => {
    await withActionEnv({ GITHUB_OUTPUT: outputFile }, async () => {
      await withImmediateTimers(async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) return base64Content({ releaseCooldownSeconds: 360 }, "cfg");
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              putCalls++;
              if (putCalls === 1) {
                state = lifecycleState();
                return jsonResponse(500, { message: "ambiguous recovery response" });
              }
              return jsonResponse(409, { message: "sha does not match" });
            }
            return base64Content(state, state.reservations.length ? "before" : "after-recovery");
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, () => reap(semaphoreConfig({
          operation: "recover",
          reservationId: "reservation-runner-a",
          resourceSafe: true
        })));
      });
    });
    assert.equal(readEnvironmentFile(outputFile).reaped, "true");
  });
  assert.equal(putCalls, 2);
});

test("manual recovery rejects missing proof and non-active reservation IDs", async (t) => {
  const prior = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-a");
  const cases = [
    { name: "missing proof", resourceSafe: false, reservationId: "reservation-runner-a", error: /resource-safe=true/ },
    { name: "wrong id", resourceSafe: true, reservationId: "wrong-id", error: /was not found/ },
    {
      name: "already in cooldown",
      resourceSafe: true,
      reservationId: "reservation-runner-a",
      cooldown: true,
      error: /was not found/
    }
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const reservation = lifecycleReservation(prior, testCase.cooldown ? {
        state: "cooldown",
        availableAt: "2999-01-01T00:00:00.000Z"
      } : {});
      const state = lifecycleState([], [], [reservation]);
      await withMockedFetch(async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
        if (parsed.pathname === SEMAPHORE_STATE_PATH) return base64Content(state, "state-sha");
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await assert.rejects(
          () => reap(semaphoreConfig({
            operation: "recover",
            reservationId: testCase.reservationId,
            resourceSafe: testCase.resourceSafe
          })),
          testCase.error
        );
      });
    });
  }
});

test("resource lifecycle activation upgrades only drained schema 3 state", async (t) => {
  const active = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-b");
  const queued = withRunner(semaphoreQueueEntry("other/repo", "888", "playmode"), "runner-b");
  for (const testCase of [
    { name: "drained state upgrades", state: { ...semaphoreState([]), schemaVersion: 3 }, error: null },
    { name: "schema 2 cannot skip migration stage", state: semaphoreState([]), error: /drain/ },
    { name: "active holder blocks upgrade", state: { ...semaphoreState([active]), schemaVersion: 3 }, error: /drain/ },
    { name: "queued request blocks upgrade", state: { ...semaphoreState([], [queued]), schemaVersion: 3 }, error: /drain/ }
  ]) {
    await t.test(testCase.name, async () => {
      let state = structuredClone(testCase.state);
      await withActionEnv(semaphoreActionEnv, async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return base64Content({ maxHolders: 1, runnerSerialization: true, resourceLifecycle: true }, "cfg");
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
              return jsonResponse(200, { content: { sha: "write-sha" } });
            }
            return base64Content(state, "state-sha");
          }
          if (parsed.pathname.includes("/actions/runs/")) return jsonResponse(200, { status: "in_progress" });
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          const operation = () =>
            acquire(
              semaphoreConfig({
                runnerId: "runner-a",
                requireResourceLifecycle: true,
                minimumReleaseCooldownSeconds: 360
              })
            );
          if (testCase.error) await assert.rejects(operation, testCase.error);
          else await operation();
        });
      });
      if (!testCase.error) {
        assert.equal(state.schemaVersion, 4);
        assert.deepEqual(state.reservations, []);
      }
    });
  }
});

test("schema 4 scheduled reaping quarantines stale holders", async () => {
  const stale = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-a");
  let state = lifecycleState([stale]);
  await withMockedFetch(async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
    if (parsed.pathname === SEMAPHORE_STATE_PATH) {
      if (options.method === "PUT") {
        state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
        return jsonResponse(200, { content: { sha: "reaped-sha" } });
      }
      return base64Content(state, "state-sha");
    }
    if (parsed.pathname === "/repos/other/repo/actions/runs/999") return jsonResponse(200, { status: "completed" });
    return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
  }, () => reap(semaphoreConfig()));
  assert.equal(state.holders.length, 0);
  assert.equal(state.reservations.length, 1);
  assert.equal(state.reservations[0].state, "quarantine");
  assert.equal(state.reservations[0].runnerId, "runner-a");
});

test("schema 4 post cleanup quarantines held ownership", async () => {
  const held = withRunner(semaphoreHolder("owner/repo", "123", "playmode"), "runner-a");
  let state = lifecycleState([held]);
  await withActionEnv({ ...semaphoreActionEnv, STATE_build_lock_cleanup: "enabled" }, async () => {
    await withMockedFetch(async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
      if (parsed.pathname === SEMAPHORE_STATE_PATH) {
        if (options.method === "PUT") {
          state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
          return jsonResponse(200, { content: { sha: "cleanup-sha" } });
        }
        return base64Content(state, "state-sha");
      }
      return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
    }, () => postCleanup(semaphoreConfig({ runnerId: "runner-a" })));
  });
  assert.equal(state.holders.length, 0);
  assert.equal(state.reservations[0].state, "quarantine");
  assert.match(state.reservations[0].reason, /post-action cleanup/);
});

function accountIncident(overrides = {}) {
  return {
    incidentId: "incident-0123456789abcdef01234567",
    repository: "owner/repo",
    workflow: "Perf",
    job: "perf-benchmarks",
    runId: "123",
    runAttempt: "1",
    runUrl: "https://github.com/owner/repo/actions/runs/123",
    runnerId: "runner-a",
    reportedAt: "2026-06-06T00:01:00.000Z",
    reason: "unity-account-limit-20111",
    evidenceDigest: "0123456789abcdef01234567" + "a".repeat(40),
    ...overrides
  };
}

function accountHealthState(holders = [], queue = [], reservations = [], activeIncident = null) {
  return { ...lifecycleState(holders, queue, reservations), schemaVersion: 5, activeIncident };
}

test("release report compatibility mapping rejects contradictory old and new inputs", () => {
  assert.deepEqual(parseReleaseReport({ resourceSafe: "true" }), {
    cleanupStatus: "confirmed",
    health: "healthy",
    reason: "cleanup-confirmed"
  });
  assert.deepEqual(parseReleaseReport({ resourceSafe: "false" }), {
    cleanupStatus: "unknown",
    health: "healthy",
    reason: "cleanup-evidence-unknown"
  });
  assert.throws(
    () => parseReleaseReport({
      resourceSafe: "true",
      cleanupStatus: "unknown",
      health: "healthy",
      reason: "return-timeout"
    }),
    /contradicts/
  );
  assert.throws(
    () => parseReleaseReport({ cleanupStatus: "unknown", health: "blocked", reason: "unity-20113-unclassified" }),
    /reserved for confirmed.*20111/
  );
});

test("schema 5 global incidents round-trip and require immutable evidence provenance", () => {
  const incident = accountIncident();
  const normalized = normalizeState(accountHealthState([], [], [], incident), "wallstop-organization-builds");
  assert.deepEqual(normalized.activeIncident, incident);
  assert.throws(
    () => normalizeState(accountHealthState([], [], [], { ...incident, evidenceDigest: "not-a-digest" }), "wallstop-organization-builds"),
    /SHA-256 evidence digest/
  );
});

test("schema 5 blocked release creates one immutable global incident", async () => {
  const held = withRunner(semaphoreHolder("owner/repo", "123", "playmode"), "runner-a");
  let state = accountHealthState([held]);
  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
        if (parsed.pathname === SEMAPHORE_CONFIG_PATH) return base64Content({ maxHolders: 1, runnerSerialization: true, resourceLifecycle: true, accountHealth: true }, "cfg");
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "incident-sha" } });
          }
          return base64Content(state, "before");
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, () => release(semaphoreConfig({
        runnerId: "runner-a",
        resourceReport: { cleanupStatus: "unknown", health: "blocked", reason: "unity-account-limit-20111" }
      })));
    });
    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs["cleanup-result"], "global-quarantined");
    assert.match(outputs["incident-id"], /^incident-[a-f0-9]{24}$/);
    assert.equal(outputs["resource-health"], "blocked");
  });
  assert.equal(state.holders.length, 0);
  assert.equal(state.reservations.length, 0);
  assert.equal(state.activeIncident.reason, "unity-account-limit-20111");
});

test("schema 5 uncertainty reasons remain runner-local and never create account incidents", async (t) => {
  for (const reason of [
    "unity-return-400006",
    "return-timeout",
    "return-log-truncated",
    "return-terminated",
    "return-missing-positive-evidence",
    "unity-20113-unclassified"
  ]) {
    await t.test(reason, async () => {
      const held = withRunner(semaphoreHolder("owner/repo", "123", "playmode"), "runner-a");
      let state = accountHealthState([held]);
      await withActionEnv(semaphoreActionEnv, async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) return base64Content({ maxHolders: 1, runnerSerialization: true, resourceLifecycle: true, accountHealth: true }, "cfg");
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
              return jsonResponse(200, { content: { sha: "local-quarantine" } });
            }
            return base64Content(state, "before");
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, () => release(semaphoreConfig({
          runnerId: "runner-a",
          resourceReport: { cleanupStatus: "unknown", health: "healthy", reason }
        })));
      });
      assert.equal(state.activeIncident, null);
      assert.equal(state.reservations.length, 1);
      assert.equal(state.reservations[0].state, "quarantine");
      assert.equal(state.reservations[0].reason, reason);
    });
  }
});

test("schema 5 global incident blocks acquire immediately without growing the queue", async () => {
  const incident = accountIncident();
  const state = accountHealthState([], [], [], incident);
  let writes = 0;
  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
        if (parsed.pathname === SEMAPHORE_CONFIG_PATH) return base64Content({ maxHolders: 1, runnerSerialization: true, resourceLifecycle: true, accountHealth: true }, "cfg");
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") writes++;
          return base64Content(state, "blocked-state");
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, () => acquire(semaphoreConfig({ runnerId: "runner-b" })));
    });
    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs.acquired, "false");
    assert.equal(outputs["admission-result"], "account-blocked");
    assert.equal(outputs["incident-id"], incident.incidentId);
  });
  assert.equal(writes, 0);
  assert.deepEqual(state.queue, []);
});

test("schema 5 incident recovery requires exact ID and portal proof then enters cooldown", async () => {
  const incident = accountIncident();
  let state = accountHealthState([], [], [], incident);
  await withMockedFetch(async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
    if (parsed.pathname === SEMAPHORE_CONFIG_PATH) return base64Content({ releaseCooldownSeconds: 360 }, "cfg");
    if (parsed.pathname === SEMAPHORE_STATE_PATH) {
      if (options.method === "PUT") {
        state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
        return jsonResponse(200, { content: { sha: "recovered" } });
      }
      return base64Content(state, "before");
    }
    return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
  }, () => reap(semaphoreConfig({
    operation: "recover-incident",
    incidentId: incident.incidentId,
    portalCleanupConfirmed: true
  })));
  assert.equal(state.activeIncident, null);
  assert.equal(state.reservations.length, 1);
  assert.equal(state.reservations[0].state, "cooldown");
  assert.match(state.reservations[0].reason, new RegExp(incident.incidentId));
});

test("schema 5 incident recovery rejects missing proof and mismatched incident IDs", async (t) => {
  const incident = accountIncident();
  for (const testCase of [
    { name: "missing portal proof", incidentId: incident.incidentId, proof: false, error: /portal-cleanup-confirmed=true/ },
    { name: "wrong incident id", incidentId: "incident-ffffffffffffffffffffffff", proof: true, error: /was not found/ }
  ]) {
    await t.test(testCase.name, async () => {
      let writes = 0;
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") writes++;
          return base64Content(accountHealthState([], [], [], incident), "before");
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await assert.rejects(
          () => reap(semaphoreConfig({
            operation: "recover-incident",
            incidentId: testCase.incidentId,
            portalCleanupConfirmed: testCase.proof
          })),
          testCase.error
        );
      });
      assert.equal(writes, 0);
    });
  }
});

test("account health activation is a drained one-way schema 5 migration", async (t) => {
  const active = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-b");
  const prior = withRunner(semaphoreHolder("other/repo", "998", "editmode"), "runner-c");
  for (const testCase of [
    { name: "drained schema 4 upgrades", state: lifecycleState(), error: null },
    { name: "schema 3 cannot skip schema 4", state: { ...semaphoreState([]), schemaVersion: 3 }, error: /drained/ },
    { name: "holder blocks migration", state: lifecycleState([active]), error: /drained/ },
    { name: "reservation blocks migration", state: lifecycleState([], [], [lifecycleReservation(prior)]), error: /drained/ }
  ]) {
    await t.test(testCase.name, async () => {
      let state = structuredClone(testCase.state);
      await withActionEnv(semaphoreActionEnv, async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) return base64Content({
            maxHolders: 1,
            runnerSerialization: true,
            resourceLifecycle: true,
            accountHealth: true
          }, "cfg");
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
              return jsonResponse(200, { content: { sha: "write" } });
            }
            return base64Content(state, "before");
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          const operation = () => acquire(semaphoreConfig({ runnerId: "runner-a" }));
          if (testCase.error) await assert.rejects(operation, testCase.error);
          else await operation();
        });
      });
      if (!testCase.error) {
        assert.equal(state.schemaVersion, 5);
        assert.equal(state.activeIncident, null);
      }
    });
  }
});
