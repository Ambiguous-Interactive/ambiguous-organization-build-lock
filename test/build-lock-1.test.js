"use strict";

const test = require("node:test");

const {
  assert,
  crypto,
  fs,
  path,
  acquire,
  api,
  authorizeCaller,
  config,
  createAppJwt,
  createGitHubAppAuth,
  credential,
  installAcquireSignalCleanup,
  isRetryableResponse,
  readerCredential,
  readerCredentialRequired,
  release,
  releaseRetryApiOptions,
  runCancellationCleanup,
  writeState,
  testAppKeys,
  testAppPrivateKey,
  emptyState,
  jsonResponse,
  htmlResponse,
  authorizedConsumerEnv,
  acquireOutputNames,
  releaseOutputNames,
  withActionEnv,
  withEnvironment,
  withImmediateTimers,
  withTempFile,
  readEnvironmentFile,
  assertOutputContract,
  withMockedFetch,
  SEMAPHORE_STATE_PATH,
  SEMAPHORE_CONFIG_PATH,
  semaphoreHolder,
  semaphoreState,
  semaphoreConfig,
  base64Content,
  semaphoreActionEnv,
} = require("./build-lock-support.js");


test("environment file parser rejects empty names", async () => {
  await withTempFile(async (file) => {
    fs.writeFileSync(file, "=value\n", "utf8");

    assert.throws(
      () => readEnvironmentFile(file),
      new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:1 must use a non-empty name`)
    );
  });
});


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


test("sole timed-out GitHub App waiter preserves structured auth retry diagnostics", async () => {
  const controller = new AbortController();
  let installationCalls = 0;
  const auth = createGitHubAppAuth({
    appId: "12345",
    privateKey: testAppPrivateKey,
    owner: "Ambiguous-Interactive",
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

  await withMockedFetch(
    async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/orgs/Ambiguous-Interactive/installation");
      installationCalls++;
      return jsonResponse(
        502,
        { message: "upstream auth unavailable" },
        { "x-github-request-id": "auth-deadline-request" }
      );
    },
    async () => {
      await assert.rejects(
        () => auth.getToken({ signal: controller.signal }),
        (error) => {
          assert.equal(error.code, "GITHUB_API_RETRY_EXHAUSTED");
          assert.equal(error.retryable, true);
          assert.equal(error.status, 502);
          assert.equal(error.requestId, "auth-deadline-request");
          assert.equal(error.path, "/orgs/Ambiguous-Interactive/installation");
          assert.equal(error.attempts, 1);
          assert.match(error.message, /runner inventory deadline elapsed/i);
          assert.match(error.message, /HTTP 502/i);
          return true;
        }
      );
    }
  );

  assert.equal(installationCalls, 1);
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
    firstController.abort(new DOMException("first waiter deadline elapsed", "TimeoutError"));
    finishInstallationLookup();

    await assert.rejects(first, /first waiter deadline elapsed/);
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


test("config parses PR head validation inputs", async () => {
  const expectedHeadSha = "a".repeat(40);
  await withEnvironment(
    {
      "INPUT_LOCK-NAME": "wallstop-organization-builds",
      "INPUT_LOCK-REPOSITORY": "Ambiguous-Interactive/ambiguous-organization-build-lock",
      "INPUT_GITHUB-TOKEN": "workflow-token",
      "INPUT_PULL-REQUEST-NUMBER": "123",
      "INPUT_EXPECTED-HEAD-SHA": expectedHeadSha,
      GITHUB_REPOSITORY: authorizedConsumerEnv.GITHUB_REPOSITORY,
      GITHUB_REPOSITORY_ID: authorizedConsumerEnv.GITHUB_REPOSITORY_ID,
      GITHUB_REPOSITORY_OWNER_ID: authorizedConsumerEnv.GITHUB_REPOSITORY_OWNER_ID,
      BUILD_LOCK_APP_ID: "12345",
      BUILD_LOCK_APP_PRIVATE_KEY: testAppPrivateKey
    },
    () => {
      const parsed = config();
      assert.deepEqual(
        [parsed.githubToken, parsed.pullRequestNumber, parsed.expectedHeadSha],
        ["workflow-token", "123", expectedHeadSha]
      );
    }
  );
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
    { name: "non-canonical repository id", env: { ...authorizedConsumerEnv, GITHUB_REPOSITORY_ID: "0737391131" } },
    { name: "wrong repository owner", env: { ...authorizedConsumerEnv, GITHUB_REPOSITORY: "Not-Ambiguous/unity-helpers" } },
    { name: "non-canonical repository name", env: { ...authorizedConsumerEnv, GITHUB_REPOSITORY: "ambiguous-interactive/unity-helpers" } },
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


test("authorization accepts canonical repositories owned by the organization", async (t) => {
  const repositories = [
    ["Ambiguous-Interactive/DxMessaging", "101020635"],
    ["Ambiguous-Interactive/unity-helpers", "737391131"],
    ["Ambiguous-Interactive/DoxReloaded", "825469040"],
    ["Ambiguous-Interactive/IshoBoy", "885525263"],
    ["Ambiguous-Interactive/DepartmentOfArrangements", "1079492096"],
    ["Ambiguous-Interactive/qora-redux", "1290240478"],
    ["Ambiguous-Interactive/future-unity-project", "9999999999"],
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
  await withActionEnv({
    GITHUB_REPOSITORY: "Ambiguous-Interactive/ambiguous-organization-build-lock",
    GITHUB_REPOSITORY_ID: "9999999999",
    GITHUB_REPOSITORY_OWNER_ID: "212056428"
  }, () => {
    assert.throws(
      () => authorizeCaller({
        lockName: "wallstop-organization-builds",
        lockRepository: "Ambiguous-Interactive/ambiguous-organization-build-lock",
        mode: "reap"
      }),
      /repository ID is not authorized/
    );
  });
});


// Minting runs on a small budget nested inside every call. Its exhaustion must be a
// failed attempt, not the end of the caller's budget: the credential subsystem is the
// one dependency every path shares, so it cannot also be the effective ceiling.
test("a nested credential outage spends the caller's own budget", async (t) => {
  const now = Date.parse("2026-07-11T12:00:00Z");

  const mintingOutage = (failedMints, resource) => {
    const counts = { installations: 0, mints: 0, resource: 0 };
    return {
      counts,
      handler: async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/orgs/Ambiguous-Interactive/installation") {
          counts.installations++;
          return jsonResponse(200, { id: 987 });
        }
        if (parsed.pathname === "/app/installations/987/access_tokens") {
          counts.mints++;
          return counts.mints <= failedMints
            ? jsonResponse(503, { message: "unavailable" })
            : jsonResponse(201, {
              token: "installation-token",
              expires_at: new Date(now + 60 * 60 * 1000).toISOString()
            });
        }
        counts.resource++;
        return resource(counts.resource, options);
      }
    };
  };

  const appAuth = () =>
    createGitHubAppAuth({
      appId: "12345",
      privateKey: testAppPrivateKey,
      owner: "Ambiguous-Interactive",
      now: () => now
    });

  await t.test("an attempt-bounded caller retries past the inner minting budget", async () => {
    const outage = mintingOutage(6, () => jsonResponse(200, { ok: true }));
    await withImmediateTimers(() => withMockedFetch(outage.handler, async () => {
      assert.deepEqual(
        await api("GET", "/repos/o/r/contents/lock.json", undefined, appAuth(), {
          now: () => now,
          sleep: async () => {}
        }),
        { ok: true }
      );
    }));

    assert.equal(outage.counts.mints, 7, "each caller attempt re-mints on its own budget");
    assert.equal(outage.counts.resource, 1);
  });

  await t.test("a time-bounded caller keeps minting until its deadline", async () => {
    const outage = mintingOutage(20, () => jsonResponse(200, { ok: true }));
    let clock = now;
    await withMockedFetch(outage.handler, async () => {
      await assert.rejects(
        () =>
          api("GET", "/repos/o/r/contents/lock.json", undefined, appAuth(), {
            deadlineAt: now + 60_000,
            now: () => clock,
            sleep: async (ms) => {
              clock += ms;
            }
          }),
        (error) => {
          assert.equal(error.code, "GITHUB_API_RETRY_EXHAUSTED");
          assert.equal(error.path, "/repos/o/r/contents/lock.json");
          assert.match(error.message, /credential unavailable: /);
          assert.match(error.message, /access_tokens exhausted its bounded GitHub API retry budget/);
          return true;
        }
      );
    });

    assert.ok(
      outage.counts.mints > 3,
      `the deadline, not the inner three-attempt budget, must bound minting; saw ${outage.counts.mints}`
    );
    assert.equal(outage.counts.resource, 0);
  });

  // The request never left the client, so a later conflict is an ordinary conflict.
  // Marking it ambiguous would report a write GitHub never saw as possibly applied.
  await t.test("a minting failure never makes a later conflict look like an accepted write", async () => {
    const outage = mintingOutage(3, () => jsonResponse(409, { message: "conflict" }));
    await withImmediateTimers(() => withMockedFetch(outage.handler, async () => {
      await assert.rejects(
        () =>
          api("PUT", "/repos/o/r/contents/lock.json", { a: 1 }, appAuth(), {
            now: () => now,
            sleep: async () => {}
          }),
        (error) => {
          assert.equal(error.status, 409);
          assert.notEqual(error.acceptedWriteAmbiguous, true);
          return true;
        }
      );
    }));
  });

  // Same invariant for a credential failure that is not an exhausted budget: a
  // malformed token response never sent the mutation either.
  await t.test("a malformed token response never makes a later conflict look accepted", async () => {
    let mints = 0;
    await withImmediateTimers(() => withMockedFetch(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/orgs/Ambiguous-Interactive/installation") {
        return jsonResponse(200, { id: 987 });
      }
      if (parsed.pathname === "/app/installations/987/access_tokens") {
        mints++;
        return mints === 1
          ? jsonResponse(201, { expires_at: new Date(now + 60 * 60 * 1000).toISOString() })
          : jsonResponse(201, {
            token: "installation-token",
            expires_at: new Date(now + 60 * 60 * 1000).toISOString()
          });
      }
      return jsonResponse(409, { message: "conflict" });
    }, async () => {
      await assert.rejects(
        () =>
          api("PUT", "/repos/o/r/contents/lock.json", { a: 1 }, appAuth(), {
            now: () => now,
            sleep: async () => {}
          }),
        (error) => {
          assert.equal(error.status, 409);
          assert.notEqual(error.acceptedWriteAmbiguous, true);
          return true;
        }
      );
    }));

    assert.equal(mints, 2);
  });

  // Acquire's auth grace window keys on a 401, and it must still see one through a
  // minting outage that outlasts the caller's budget.
  await t.test("a 401 minting outage still surfaces as a 401 to the caller", async () => {
    const counts = { mints: 0 };
    await withImmediateTimers(() => withMockedFetch(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/orgs/Ambiguous-Interactive/installation") {
        return jsonResponse(200, { id: 987 });
      }
      counts.mints++;
      return jsonResponse(401, { message: "Bad credentials" });
    }, async () => {
      await assert.rejects(
        () =>
          api("GET", "/repos/o/r/contents/lock.json", undefined, appAuth(), {
            now: () => now,
            sleep: async () => {}
          }),
        (error) => {
          assert.equal(error.code, "GITHUB_API_RETRY_EXHAUSTED");
          assert.equal(error.status, 401);
          return true;
        }
      );
    }));

    assert.ok(counts.mints > 3, `the caller's budget must re-mint; saw ${counts.mints}`);
  });

  // Retrying is pointless once the operation itself is over, and the nested error
  // carries the only description of why the credential could not be minted.
  await t.test("an aborted operation keeps the credential diagnosis", async () => {
    const controller = new AbortController();
    const apiOptions = {
      signal: controller.signal,
      now: () => now,
      sleep: async () => {
        controller.abort(new DOMException("bounded deadline elapsed", "TimeoutError"));
        throw controller.signal.reason;
      }
    };
    const auth = createGitHubAppAuth({
      appId: "12345",
      privateKey: testAppPrivateKey,
      owner: "Ambiguous-Interactive",
      now: () => now,
      apiOptions
    });

    await withMockedFetch(async (url) => {
      const parsed = new URL(url);
      return parsed.pathname === "/orgs/Ambiguous-Interactive/installation"
        ? jsonResponse(502, { message: "upstream auth unavailable" }, { "x-github-request-id": "mint-abort" })
        : jsonResponse(200, { ok: true });
    }, async () => {
      await assert.rejects(
        () => api("GET", "/repos/o/r/contents/lock.json", undefined, auth, apiOptions),
        (error) => {
          assert.equal(error.code, "GITHUB_API_RETRY_EXHAUSTED");
          assert.match(error.message, /\/orgs\/Ambiguous-Interactive\/installation exhausted/);
          assert.match(error.message, /upstream auth unavailable/);
          assert.equal(error.message.split("mint-abort").length - 1, 1);
          return true;
        }
      );
    });
  });

  // A caller that exhausts its own budget still ends there; only a nested exhaustion
  // becomes a retryable attempt.
  await t.test("the caller's own exhaustion still short-circuits", async () => {
    const outage = mintingOutage(0, () => jsonResponse(503, { message: "unavailable" }));
    await withImmediateTimers(() => withMockedFetch(outage.handler, async () => {
      await assert.rejects(
        () =>
          api("GET", "/repos/o/r/contents/lock.json", undefined, appAuth(), {
            now: () => now,
            sleep: async () => {}
          }),
        (error) => {
          assert.equal(error.path, "/repos/o/r/contents/lock.json");
          assert.match(error.message, /after 5 attempt\(s\)/);
          assert.match(error.message, /last failure: HTTP 503/);
          return true;
        }
      );
    }));

    assert.equal(outage.counts.resource, 5);
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
    permissions: { actions: "read", metadata: "read" }
  });
  assert.equal(Object.hasOwn(requests[1].body, "repositories"), false);
  assert.equal(Object.hasOwn(requests[1].body.permissions, "contents"), false);
});


test("reaper compatibility fallback mints a reader-scoped token from the writer App", async () => {
  const requests = [];
  await withEnvironment({
    BUILD_LOCK_APP_ID: "123",
    BUILD_LOCK_APP_PRIVATE_KEY: testAppPrivateKey,
    BUILD_LOCK_READER_APP_ID: undefined,
    BUILD_LOCK_READER_APP_PRIVATE_KEY: undefined
  }, async () => {
    await withMockedFetch(async (url, options = {}) => {
      const parsed = new URL(url);
      requests.push({ path: parsed.pathname, body: options.body && JSON.parse(options.body) });
      if (parsed.pathname.endsWith("/installation")) return jsonResponse(200, { id: 84 });
      return jsonResponse(201, { token: "compatibility-reader", expires_at: "2999-01-01T00:00:00Z" });
    }, async () => {
      assert.equal(await readerCredential("Ambiguous-Interactive").getToken(), "compatibility-reader");
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


test("only stale-state reaping requires the cross-repository reader credential", () => {
  assert.equal(readerCredentialRequired("reap", "reap"), true);
  assert.equal(readerCredentialRequired("reap", "recover"), false);
  assert.equal(readerCredentialRequired("reap", "recover-incident"), false);
  assert.equal(readerCredentialRequired("acquire", "reap"), false);
  assert.equal(readerCredentialRequired("release", "reap"), false);
});


test("writeState does not mark a 401-then-conflict sequence as an ambiguous write", async () => {
  // A 401 is rejected before GitHub processes the mutation, so a later CAS conflict
  // cannot mean "our write was silently accepted".
  let calls = 0;
  await withImmediateTimers(async () => {
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


test("api computes bounded retry delays from Retry-After or full jitter", async (t) => {
  const now = Date.parse("2026-07-20T00:00:00Z");
  const cases = [
    {
      name: "delta-seconds",
      status: 429,
      retryAfter: "2",
      maxDelayMs: 5000,
      expectedDelay: 2000
    },
    {
      name: "HTTP-date with injected clock",
      status: 503,
      retryAfter: "Mon, 20 Jul 2026 00:00:30 GMT",
      maxDelayMs: 60000,
      expectedDelay: 30000
    },
    {
      name: "Retry-After capped at the policy maximum",
      status: 503,
      retryAfter: "120",
      maxDelayMs: 60000,
      expectedDelay: 60000
    },
    {
      name: "suffixed delta-seconds falls back to deterministic full jitter",
      status: 503,
      retryAfter: "2seconds",
      maxDelayMs: 10000,
      expectedDelay: 500
    },
    {
      name: "negative delta-seconds falls back to deterministic full jitter",
      status: 503,
      retryAfter: "-1",
      maxDelayMs: 10000,
      expectedDelay: 500
    },
    {
      name: "fractional delta-seconds falls back to deterministic full jitter",
      status: 503,
      retryAfter: "1.5",
      maxDelayMs: 10000,
      expectedDelay: 500
    },
    {
      name: "non-IMF HTTP date falls back to deterministic full jitter",
      status: 503,
      retryAfter: "07/20/2026 00:00:30 GMT",
      maxDelayMs: 10000,
      expectedDelay: 500
    },
    {
      name: "IMF-fixdate with an incorrect weekday falls back to deterministic full jitter",
      status: 503,
      retryAfter: "Sun, 20 Jul 2026 00:00:30 GMT",
      maxDelayMs: 10000,
      expectedDelay: 500
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const delays = [];
      let calls = 0;
      await withMockedFetch(
        async () => {
          calls++;
          return calls === 1
            ? jsonResponse(
              testCase.status,
              { message: "retryable response" },
              { "retry-after": testCase.retryAfter }
            )
            : jsonResponse(200, { ok: true });
        },
        async () => {
          assert.deepEqual(
            await api("GET", "/repos/o/r", undefined, "token", {
              maxAttempts: 2,
              baseDelayMs: 1000,
              maxDelayMs: testCase.maxDelayMs,
              fullJitter: true,
              now: () => now,
              random: () => 0.5,
              sleep: async (delay) => delays.push(delay)
            }),
            { ok: true }
          );
        }
      );

      assert.deepEqual(delays, [testCase.expectedDelay]);
    });
  }
});


test("api preserves the last retryable response when its deadline expires", async () => {
  const controller = new AbortController();
  await withMockedFetch(
    async () => jsonResponse(502, { message: "bad gateway" }, { "x-github-request-id": "deadline-request" }),
    async () => {
      await assert.rejects(
        () => api("GET", "/repos/o/r", undefined, "token", {
          maxAttempts: 5,
          baseDelayMs: 1000,
          maxDelayMs: 1000,
          signal: controller.signal,
          sleep: async () => {
            controller.abort(new DOMException("bounded deadline elapsed", "TimeoutError"));
            throw controller.signal.reason;
          }
        }),
        (error) => {
          assert.equal(error.code, "GITHUB_API_RETRY_EXHAUSTED");
          assert.equal(error.retryable, true);
          assert.equal(error.status, 502);
          assert.equal(error.requestId, "deadline-request");
          assert.equal(error.attempts, 1);
          assert.match(error.message, /bounded deadline elapsed/i);
          assert.match(error.message, /HTTP 502/i);
          return true;
        }
      );
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


test("api retries GitHub's transient HTML bad-request interstitial", async () => {
  const interstitial =
    "<html><head><title>Bad request &middot; GitHub</title></head>" +
    "<body><h1>Whoa there!</h1><p>You have sent an invalid request.</p></body></html>";
  const response = htmlResponse(400, interstitial, {
    "x-github-request-id": "TRANSIENT400"
  });

  assert.equal(isRetryableResponse(response, { message: interstitial }), true);
  assert.equal(
    isRetryableResponse(jsonResponse(400, { message: "Invalid request parameters" }), {
      message: "Invalid request parameters"
    }),
    false
  );

  let calls = 0;
  await withMockedFetch(async () => {
    calls++;
    return calls === 1
      ? htmlResponse(400, interstitial, { "x-github-request-id": "TRANSIENT400" })
      : jsonResponse(200, { ok: true });
  }, async () => {
    const result = await api("GET", "/repos/o/r/contents/locks/x.json", undefined, "token", {
      maxAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
      sleep: async () => {}
    });
    assert.deepEqual(result, { ok: true });
  });

  assert.equal(calls, 2);
});


test("writeState marks CAS conflicts after a retryable mutation failure as ambiguous", async () => {
  let calls = 0;
  await withImmediateTimers(async () => {
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
  });
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
  await withImmediateTimers(async () => {
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
  });
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
    const summaryFile = path.join(path.dirname(outputFile), "step-summary");
    fs.writeFileSync(summaryFile, "", "utf8");
    await withActionEnv(
      {
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_WORKFLOW: "Perf",
        GITHUB_JOB: "perf-benchmarks",
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile
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
    // This caller never waited in the FIFO, so it publishes no queue position. Without
    // a github-token its runner wait cannot be proven, so it stays empty rather than 0.
    assert.equal(outputs["queue-position"], "0");
    assert.equal(outputs["runner-wait-ms"], "");
    const summary = fs.readFileSync(summaryFile, "utf8");
    assert.match(summary, /runner-wait-ms=unmeasured\./);
    assert.doesNotMatch(summary, /queue-position/);
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


test("acquire auth grace sleep stops at the acquire deadline and enters timeout cleanup", async () => {
  const originalNow = Date.now;
  const originalRandom = Math.random;
  const originalSetTimeout = global.setTimeout;
  let now = Date.parse("2026-06-06T00:00:00.000Z");
  let stateReads = 0;
  const observedDelays = [];
  Date.now = () => now;
  Math.random = () => 0.999;
  global.setTimeout = (handler, delay, ...args) => {
    observedDelays.push(delay);
    now += delay;
    return originalSetTimeout(handler, 0, ...args);
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
          await withEnvironment(
            { BUILD_LOCK_API_MAX_ATTEMPTS: "1", BUILD_LOCK_AUTH_GRACE_MS: "600000" },
            async () => {
              await withMockedFetch(async (url) => {
                const parsed = new URL(url);
                if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
                  return jsonResponse(200, { object: { sha: "branch-sha" } });
                }
                if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
                  stateReads++;
                  return jsonResponse(401, { message: "Bad credentials" });
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
                      pollSeconds: 120
                    }),
                  /Timed out waiting for build lock/
                );
                assert.match(logs.join("\n"), /Unable to clean up build-lock state after timeout.*Bad credentials/);
              });
            }
          );
        }
      );
      assert.equal(readEnvironmentFile(outputFile)["admission-result"], "timeout");
    });
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
    global.setTimeout = originalSetTimeout;
  }

  assert.deepEqual(observedDelays, [60000]);
  assert.equal(stateReads, 2, "timeout cleanup must make a final exact-state cleanup attempt");
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
                /holder=`other\/repo:999:perf-benchmarks:editmode`.*queue-position=1.*reason=`awaiting scheduled reaper/
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


// Issue #53 item 6: an operator must be able to tell a GitHub-runner wait from an
// organization FIFO wait, and a wait that was survived has to be explained on the
// success path too, not only on timeout.
test("acquire publishes both wait phases and explains the wait it survived", async () => {
  // Each clock read advances 30 s, and the lock-config read is charged a distinctive
  // extra SETUP_COST_MS. That lets the test prove wait-ms covers this action's own setup
  // reads, which the pre-change runtime excluded by resetting its clock after them.
  const CLOCK_STEP_MS = 30000;
  const SETUP_COST_MS = 120000;
  const originalNow = Date.now;
  let now = 0;
  let peerReleased = false;
  let releaseOnNextRead = false;
  let state = semaphoreState([semaphoreHolder("other/repo", "888", "editmode")]);

  Date.now = () => {
    now += CLOCK_STEP_MS;
    return now;
  };

  try {
    await withTempFile(async (outputFile) => {
      const summaryFile = path.join(path.dirname(outputFile), "step-summary");
      fs.writeFileSync(summaryFile, "", "utf8");
      await withActionEnv(
        { ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile },
        async () => {
          await withImmediateTimers(async () => {
            await withMockedFetch(async (url, options = {}) => {
              const parsed = new URL(url);
              if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
                return jsonResponse(200, { object: { sha: "branch-sha" } });
              }
              if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
                now += SETUP_COST_MS;
                return base64Content({ maxHolders: 1 }, "cfg");
              }
              if (parsed.pathname === SEMAPHORE_STATE_PATH) {
                if (options.method === "PUT") {
                  const body = JSON.parse(options.body);
                  state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
                  releaseOnNextRead = true;
                  return jsonResponse(200, { content: { sha: "state-after-write" } });
                }
                if (releaseOnNextRead && !peerReleased) {
                  // The peer releases its slot but leaves this caller's queue entry.
                  peerReleased = true;
                  state = { ...semaphoreState([]), queue: state.queue };
                }
                return base64Content(state, "state-sha");
              }
              if (parsed.pathname === "/repos/owner/repo/actions/runs/123/attempts/1/jobs") {
                return jsonResponse(200, {
                  total_count: 1,
                  jobs: [
                    {
                      id: 77,
                      runner_name: "runner-a",
                      status: "in_progress",
                      created_at: "2026-06-06T00:00:00.000Z",
                      started_at: "2026-06-06T00:04:30.000Z"
                    }
                  ]
                });
              }
              if (parsed.pathname === "/repos/other/repo/actions/runs/888") {
                return jsonResponse(200, { status: "in_progress", conclusion: null });
              }
              return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
            }, async (logs) => {
              await acquire(semaphoreConfig({
                githubToken: "gh-token",
                runnerId: "runner-a",
                timeoutMinutes: 30
              }));

              assert.match(logs.join("\n"), /GitHub runner wait before this step: 270000 ms/);
            });
          });
        }
      );

      const outputs = readEnvironmentFile(outputFile);
      assertOutputContract(outputs, acquireOutputNames);
      assert.equal(outputs.acquired, "true");
      assert.equal(outputs["runner-wait-ms"], "270000");
      assert.equal(outputs["queue-position"], "1");
      assert.equal(outputs.attempts, "2");
      assert.ok(
        Number(outputs["wait-ms"]) >= 270000 + SETUP_COST_MS,
        `wait-ms must cover this action's setup reads; the pre-change clock reset after them ` +
          `and reported ${Number(outputs["wait-ms"]) - SETUP_COST_MS}`
      );
      assert.notEqual(
        outputs["wait-ms"],
        outputs["runner-wait-ms"],
        "the two phases must not collapse into one number"
      );

      const summary = fs.readFileSync(summaryFile, "utf8");
      assert.match(summary, /runner-wait-ms=270000/);
      assert.match(summary, /holder=`other\/repo:888:perf-benchmarks:editmode`/);
      assert.match(summary, /queue-position=1/);
    });
  } finally {
    Date.now = originalNow;
  }
});


test("acquire base poll stops exactly at timeout and cleans its queued identity", async () => {
  const originalNow = Date.now;
  const originalRandom = Math.random;
  const originalSetTimeout = global.setTimeout;
  let now = Date.parse("2026-06-06T00:00:00.000Z");
  let state = semaphoreState([semaphoreHolder("other/repo", "999", "editmode")]);
  const observedDelays = [];
  Date.now = () => now;
  Math.random = () => 0.999;
  global.setTimeout = (handler, delay, ...args) => {
    observedDelays.push(delay);
    now += delay;
    return originalSetTimeout(handler, 0, ...args);
  };

  try {
    await withTempFile(async (outputFile) => {
      await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return base64Content({ maxHolders: 1 }, "cfg");
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
              return jsonResponse(200, { content: { sha: "state-after-write" } });
            }
            return base64Content(state, "state-before-read");
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async (logs) => {
          await assert.rejects(
            () => acquire(semaphoreConfig({ timeoutMinutes: 1, pollSeconds: 120 })),
            /Timed out waiting for build lock/
          );
          assert.match(logs.join("\n"), /Build-lock cleanup after timeout: queue-cleaned/);
        });
      });
      assert.equal(readEnvironmentFile(outputFile)["wait-ms"], "60000");
    });
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
    global.setTimeout = originalSetTimeout;
  }

  assert.deepEqual(observedDelays, [60000]);
  assert.deepEqual(state.queue, []);
  assert.equal(state.holders[0].holderId, "other/repo:999:perf-benchmarks:editmode");
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


// Issue #198: a 503 on the final release write cost a consumer its whole Unity
// matrix because five attempts of exponential backoff are over in ~15 seconds.
// A caller that supplies a deadline retries on wall clock instead.
// Retry knobs can arrive from an organization or repository variable, so the
// notice that rejects one must not let that value break out of the command it is
// reported in. A runner only interprets a command that starts a line.
test("a rejected retry knob cannot inject workflow commands", async () => {
  await withEnvironment(
    { BUILD_LOCK_API_MAX_ATTEMPTS: "3\n::error::spoofed\n%injected" },
    async () => {
      await withMockedFetch(async () => jsonResponse(200, { ok: true }), async (logs) => {
        await api("GET", "/repos/o/r/contents/locks/x.json", undefined, "token");

        const warnings = logs.filter((line) => line.includes("Ignoring invalid BUILD_LOCK_API_MAX_ATTEMPTS"));
        assert.equal(warnings.length, 1);
        assert.doesNotMatch(warnings[0], /\r|\n/);
        assert.doesNotMatch(warnings[0], /^::error::/m);
        assert.match(warnings[0], /%25injected/);
      });
    }
  );
});


test("a time-bounded API retry budget outlasts the attempt-bounded ceiling", async (t) => {
  const startedAt = 1_800_000_000_000;

  await t.test("keeps retrying past the attempt ceiling until the call succeeds", async () => {
    let now = startedAt;
    let calls = 0;
    const delays = [];

    await withMockedFetch(async () => {
      calls++;
      return calls <= 8
        ? jsonResponse(503, { message: "No server is currently available to service your request." })
        : jsonResponse(200, { ok: true });
    }, async (logs) => {
      const result = await api("PUT", "/repos/o/r/contents/locks/x.json", { a: 1 }, "token", {
        deadlineAt: startedAt + 600_000,
        now: () => now,
        sleep: async (ms) => {
          delays.push(ms);
          now += ms;
        }
      });

      assert.deepEqual(result, { ok: true });
      assert.equal(logs.length, 8);
      assert.match(logs[7], /attempt 9 before 2027-01-\d\dT/);
      assert.ok(
        logs.every((line) => !line.includes("Infinity")),
        "a time-bounded budget must not advertise an infinite attempt ceiling"
      );
    });

    assert.equal(calls, 9, "expected retries to continue well past the 5-attempt ceiling");
    assert.equal(delays.length, 8);
    assert.ok(delays.every((ms) => ms <= 10_000), `expected capped backoff, saw ${delays.join()}`);
    assert.ok(now <= startedAt + 600_000, "expected every attempt to start inside the deadline");
  });

  await t.test("stops on its deadline and names it in the exhausted error", async () => {
    let now = startedAt;
    let calls = 0;
    const deadlineAt = startedAt + 120_000;

    await withMockedFetch(async () => {
      calls++;
      return jsonResponse(503, { message: "No server is currently available." }, { "x-github-request-id": "REQ503" });
    }, async () => {
      await assert.rejects(
        () =>
          api("PUT", "/repos/o/r/contents/locks/x.json", { a: 1 }, "token", {
            deadlineAt,
            now: () => now,
            sleep: async (ms) => {
              now += ms;
            }
          }),
        (error) => {
          assert.equal(error.code, "GITHUB_API_RETRY_EXHAUSTED");
          assert.match(error.message, /because the bounded deadline elapsed \(deadline /);
          assert.match(error.message, /HTTP 503: .*request-id=REQ503/);
          return true;
        }
      );
    });

    assert.ok(calls > 5, `expected more than the 5-attempt ceiling, saw ${calls}`);
    assert.ok(now >= deadlineAt, "expected the budget to run to its deadline");
    assert.ok(now < deadlineAt + 10_000, "expected the last wait to be clamped to the deadline");
  });

  // There is deliberately no per-call floor under the deadline: one would let each
  // call spend a fresh attempt budget past it, so a multi-call phase would overrun
  // the wall-clock bound by a multiple of itself.
  await t.test("grants no fresh attempts to a call that starts after the deadline", async () => {
    let calls = 0;
    const startedAt = 1_800_000_000_000;

    await withMockedFetch(async () => {
      calls++;
      return jsonResponse(503, { message: "No server is currently available." });
    }, async () => {
      await assert.rejects(
        () =>
          api("PUT", "/repos/o/r/contents/locks/x.json", { a: 1 }, "token", {
            deadlineAt: startedAt - 1000,
            now: () => startedAt,
            sleep: async () => {
              assert.fail("a spent budget must not wait");
            }
          }),
        /exhausted its bounded GitHub API retry budget after 1 attempt\(s\) because the bounded deadline elapsed/
      );
    });

    assert.equal(calls, 1);
  });

  await t.test("leaves the attempt-bounded budget unchanged without a deadline", async () => {
    let calls = 0;

    await withImmediateTimers(async () => {
      await withMockedFetch(async () => {
        calls++;
        return jsonResponse(503, { message: "No server is currently available." });
      }, async () => {
        await assert.rejects(
          () => api("PUT", "/repos/o/r/contents/locks/x.json", { a: 1 }, "token"),
          /exhausted its bounded GitHub API retry budget after 5 attempt\(s\); last failure/
        );
      });
    });

    assert.equal(calls, 5);
  });
});


// A zero backoff under an active deadline would retry without pause for the whole
// budget, and a ten-minute ceiling would outlast the calling step. The environment
// channel therefore carries the same ranges as the action inputs.
test("the retry budget ranges apply to the environment channel too", async (t) => {
  const cases = [
    {
      name: "zero backoff ceiling",
      environment: { BUILD_LOCK_API_RETRY_MAX_MS: "0" },
      warning: /Ignoring invalid BUILD_LOCK_API_RETRY_MAX_MS=0; expected an integer between 1000 and 300000/
    },
    {
      name: "zero base backoff",
      environment: { BUILD_LOCK_API_RETRY_BASE_MS: "0" },
      warning: /Ignoring invalid BUILD_LOCK_API_RETRY_BASE_MS=0; expected an integer between 100 and 60000/
    },
    {
      // A ten-minute backoff on an attempt-bounded path would outlast the calling
      // step, so the environment carries the input ceilings as well as its floors.
      name: "oversized backoff ceiling",
      environment: { BUILD_LOCK_API_RETRY_MAX_MS: "600000" },
      warning: /Ignoring invalid BUILD_LOCK_API_RETRY_MAX_MS=600000; expected an integer between 1000 and 300000/
    },
    {
      name: "oversized attempt ceiling",
      environment: { BUILD_LOCK_API_MAX_ATTEMPTS: "101" },
      warning: /Ignoring invalid BUILD_LOCK_API_MAX_ATTEMPTS=101; expected an integer between 1 and 100/
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const startedAt = 1_800_000_000_000;
      let now = startedAt;
      const delays = [];

      await withEnvironment(testCase.environment, async () => {
        await withMockedFetch(async () => jsonResponse(503, { message: "unavailable" }), async (logs) => {
          await assert.rejects(
            () =>
              api("PUT", "/repos/o/r/contents/locks/x.json", { a: 1 }, "token", {
                deadlineAt: startedAt + 30_000,
                now: () => now,
                sleep: async (ms) => {
                  delays.push(ms);
                  now += ms;
                }
              }),
            /exhausted its bounded GitHub API retry budget/
          );
          assert.ok(logs.some((line) => testCase.warning.test(line)), "expected the rejected value to be reported");
        });
      });

      assert.ok(delays.length > 0);
      assert.ok(
        delays.slice(0, -1).every((ms) => ms >= 100),
        `expected a throttled retry loop, saw ${delays.join()}`
      );
    });
  }
});


// Truncating a server-directed wait retries back into the same secondary rate
// limit. maxDelayMs bounds our own backoff, not GitHub's instruction.
test("a Retry-After instruction is honored in full whenever a deadline bounds it", async (t) => {
  const startedAt = 1_800_000_000_000;

  const observeFirstDelay = async (options) => {
    let calls = 0;
    let delay = null;
    await withMockedFetch(async () => {
      calls++;
      return calls === 1
        ? jsonResponse(429, { message: "secondary rate limit" }, { "retry-after": "45" })
        : jsonResponse(200, { ok: true });
    }, async () => {
      await api("PUT", "/repos/o/r/contents/locks/x.json", { a: 1 }, "token", {
        now: () => startedAt,
        sleep: async (ms) => {
          delay = ms;
        },
        ...options
      });
    });
    return delay;
  };

  await t.test("a time-bounded budget waits the full instructed delay", async () => {
    assert.equal(await observeFirstDelay({ deadlineAt: startedAt + 120_000 }), 45_000);
  });

  await t.test("the deadline still clamps an instruction that overruns it", async () => {
    assert.equal(await observeFirstDelay({ deadlineAt: startedAt + 20_000 }), 20_000);
  });

  // maxDelayMs bounds our own backoff. An attempt-bounded path honors the server's
  // number too, up to its own ceiling, or it retries into the same rate limit.
  await t.test("an attempt-bounded budget honors the instruction, not the backoff cap", async () => {
    assert.equal(await observeFirstDelay({}), 45_000);
  });

  await t.test("an instruction beyond the Retry-After ceiling is capped there", async () => {
    assert.equal(await observeFirstDelay({ retryAfterMaxMs: 20_000 }), 20_000);
  });

  await t.test("a caller that wants no waiting is not given the shared ceiling", async () => {
    assert.equal(
      await observeFirstDelay({ baseDelayMs: 0, maxDelayMs: 0, retryAfterMaxMs: 0 }),
      0
    );
  });

  // GitHub sometimes sends 0 or an already-past HTTP date. Honoring that literally
  // under a deadline would retry with no pause at all for the whole budget.
  await t.test("an instruction shorter than the base backoff never shortens the wait", async (subtest) => {
    for (const [name, header] of [
      ["zero delta-seconds", "0"],
      ["already-past HTTP date", "Sat, 01 Jan 2000 00:00:00 GMT"]
    ]) {
      await subtest.test(name, async () => {
        let calls = 0;
        let delay = null;
        await withMockedFetch(async () => {
          calls++;
          return calls === 1
            ? jsonResponse(429, { message: "secondary rate limit" }, { "retry-after": header })
            : jsonResponse(200, { ok: true });
        }, async () => {
          await api("PUT", "/repos/o/r/contents/locks/x.json", { a: 1 }, "token", {
            deadlineAt: startedAt + 120_000,
            now: () => startedAt,
            sleep: async (ms) => {
              delay = ms;
            }
          });
        });

        assert.equal(delay, 1000, "expected the configured base backoff to hold");
      });
    }
  });

  // Widening the instruction ceiling must not widen our own exponential backoff.
  await t.test("self-generated backoff is still capped by maxDelayMs", async () => {
    let calls = 0;
    let now = startedAt;
    const delays = [];

    await withMockedFetch(async () => {
      calls++;
      return calls <= 4 ? jsonResponse(503, { message: "unavailable" }) : jsonResponse(200, { ok: true });
    }, async () => {
      await api("GET", "/repos/o/r", undefined, "token", {
        baseDelayMs: 4000,
        maxDelayMs: 10_000,
        now: () => now,
        sleep: async (ms) => {
          delays.push(ms);
          now += ms;
        }
      });
    });

    assert.equal(calls, 5);
    assert.ok(
      delays.every((ms) => ms <= 10_000),
      `exponential backoff must stay under the configured cap, saw ${delays.join()}`
    );
  });

  // The floor must not escape the cap: base and max are configured independently
  // and nothing requires base <= max.
  await t.test("the backoff cap still bounds the floor when base exceeds it", async () => {
    let calls = 0;
    let delay = null;

    await withEnvironment(
      { BUILD_LOCK_API_RETRY_BASE_MS: "60000", BUILD_LOCK_API_RETRY_MAX_MS: "1000" },
      async () => {
        await withMockedFetch(async () => {
          calls++;
          return calls === 1
            ? jsonResponse(429, { message: "secondary rate limit" }, { "retry-after": "1" })
            : jsonResponse(200, { ok: true });
        }, async () => {
          await api("PUT", "/repos/o/r/contents/locks/x.json", { a: 1 }, "token", {
            now: () => startedAt,
            sleep: async (ms) => {
              delay = ms;
            }
          });
        });
      }
    );

    assert.equal(delay, 1000, "an attempt-bounded wait must never exceed the configured cap");
  });

  // retryAfterMaxMs bounds the server's number; it must not cut short a backoff
  // floor the operator configured above it.
  await t.test("the instruction ceiling never shortens a configured floor", async () => {
    let calls = 0;
    let delay = null;

    await withEnvironment(
      { BUILD_LOCK_API_RETRY_BASE_MS: "60000", BUILD_LOCK_API_RETRY_MAX_MS: "120000" },
      async () => {
        await withMockedFetch(async () => {
          calls++;
          return calls === 1
            ? jsonResponse(429, { message: "secondary rate limit" }, { "retry-after": "1" })
            : jsonResponse(200, { ok: true });
        }, async () => {
          await api("PUT", "/repos/o/r/contents/locks/x.json", { a: 1 }, "token", {
            retryAfterMaxMs: 20_000,
            now: () => startedAt,
            sleep: async (ms) => {
              delay = ms;
            }
          });
        });
      }
    );

    assert.equal(delay, 60_000, "the configured floor must survive a lower instruction ceiling");
  });

  await t.test("a deadline lifts the cap for the server's number, not for our floor", async () => {
    let calls = 0;
    let delay = null;

    await withEnvironment(
      { BUILD_LOCK_API_RETRY_BASE_MS: "60000", BUILD_LOCK_API_RETRY_MAX_MS: "1000" },
      async () => {
        await withMockedFetch(async () => {
          calls++;
          return calls === 1
            ? jsonResponse(429, { message: "secondary rate limit" }, { "retry-after": "1" })
            : jsonResponse(200, { ok: true });
        }, async () => {
          await api("PUT", "/repos/o/r/contents/locks/x.json", { a: 1 }, "token", {
            deadlineAt: startedAt + 120_000,
            now: () => startedAt,
            sleep: async (ms) => {
              delay = ms;
            }
          });
        });
      }
    );

    assert.equal(delay, 1000, "our own floor stays capped even when the deadline lifts the cap");
  });

  // Any retryable response can carry an exhausted quota header. Only a rate-limit
  // rejection may be waited out; a 401 replica lag clears in about a second.
  await t.test("a non-rate-limit failure carrying quota headers keeps normal backoff", async () => {
    let calls = 0;
    let now = startedAt;
    const delays = [];

    await withMockedFetch(async () => {
      calls++;
      return calls <= 2
        ? jsonResponse(
            401,
            { message: "Bad credentials" },
            { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(startedAt / 1000) + 2700) }
          )
        : jsonResponse(200, { ok: true });
    }, async () => {
      await api("GET", "/repos/o/r/contents/locks/x.json", undefined, "token", {
        deadlineAt: startedAt + 120_000,
        now: () => now,
        sleep: async (ms) => {
          delays.push(ms);
          now += ms;
        }
      });
    });

    assert.equal(calls, 3);
    assert.ok(
      delays.every((ms) => ms <= 10_000),
      `a replica-lag 401 must keep exponential backoff, saw ${delays.join()}`
    );
  });

  // A primary rate limit sends no Retry-After, only the hourly reset. Without
  // reading it, a time-bounded budget spends itself on requests that cannot
  // succeed yet.
  await t.test("a primary rate limit waits for its reset instead of retrying blind", async () => {
    let calls = 0;
    let now = startedAt;
    const delays = [];

    await withMockedFetch(async () => {
      calls++;
      return jsonResponse(
        403,
        { message: "API rate limit exceeded" },
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(startedAt / 1000) + 2400) }
      );
    }, async () => {
      await assert.rejects(
        () =>
          api("GET", "/repos/o/r/contents/locks/x.json", undefined, "token", {
            deadlineAt: startedAt + 120_000,
            now: () => now,
            sleep: async (ms) => {
              delays.push(ms);
              now += ms;
            }
          }),
        /exhausted its bounded GitHub API retry budget/
      );
    });

    assert.deepEqual(delays, [120_000], "the reset is clamped to the deadline, not retried against");
    assert.equal(calls, 2, "a window that reopens after the budget is not worth retrying against");
  });

  // A reset already in the past carries no waiting information; taking it as a
  // zero-length instruction would replace backoff with a constant minimum wait.
  await t.test("an already-elapsed reset keeps exponential backoff", async () => {
    let calls = 0;
    let now = startedAt;
    const delays = [];

    await withMockedFetch(async () => {
      calls++;
      return calls <= 3
        ? jsonResponse(
            403,
            { message: "API rate limit exceeded" },
            { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(startedAt / 1000) - 60) }
          )
        : jsonResponse(200, { ok: true });
    }, async () => {
      await api("GET", "/repos/o/r/contents/locks/x.json", undefined, "token", {
        deadlineAt: startedAt + 120_000,
        now: () => now,
        sleep: async (ms) => {
          delays.push(ms);
          now += ms;
        }
      });
    });

    assert.equal(calls, 4);
    assert.ok(
      delays[1] > delays[0] && delays[2] > delays[1],
      `expected exponential growth, saw ${delays.join()}`
    );
  });
});


test("release records a holder removal that needs more than the attempt-bounded budget", async () => {
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
  let writeAttempts = 0;

  await withTempFile(async (outputFile) => {
    await withImmediateTimers(
      async () => {
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
                  writeAttempts++;
                  return writeAttempts <= 8
                    ? jsonResponse(503, { message: "No server is currently available." })
                    : jsonResponse(200, { content: { sha: "state-after-release" } });
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
                statePath: "locks/wallstop-organization-builds.json",
                resourceReport: { cleanupStatus: "confirmed", health: "healthy", reason: "cleanup-confirmed" }
              });
            });
          }
        );
      }
    );

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, releaseOutputNames);
    assert.equal(outputs["cleanup-result"], "released");
    assert.equal(outputs.released, "true");
    assert.equal(outputs["state-sha"], "state-after-release");
  });

  assert.equal(writeAttempts, 9);
});


test("release separates an unreachable lock-state write from an unknown lock state", async (t) => {
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
  const cases = [
    {
      name: "confirmed cleanup reports lock-release-unreachable",
      report: { cleanupStatus: "confirmed", health: "healthy", reason: "cleanup-confirmed" },
      // GitHub may apply a mutation it never acknowledges, so the wording must stay
      // conditional and never assert that a stale holder entry exists.
      error: /Could not confirm the release of wallstop-organization-builds .*lock-release-unreachable.*If the removal did not land/,
      expected: {
        "cleanup-result": "lock-release-unreachable",
        released: "false",
        "queue-cleaned": "false",
        "resource-health": "healthy",
        "resource-reason": "cleanup-confirmed",
        "state-sha": "",
        "reservation-id": "",
        "reservation-state": "",
        "incident-id": ""
      }
    },
    {
      name: "unproven cleanup keeps the raw unreachable failure",
      report: { cleanupStatus: "unknown", health: "healthy", reason: "cleanup-evidence-unknown" },
      error: /exhausted its bounded GitHub API retry budget/,
      expected: null
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await withTempFile(async (outputFile) => {
        await withEnvironment({ BUILD_LOCK_API_MAX_ATTEMPTS: "3" }, async () => {
          await withImmediateTimers(async () => {
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
                      return jsonResponse(503, { message: "No server is currently available." });
                    }
                    return jsonResponse(200, {
                      content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
                      sha: "state-before-release"
                    });
                  }
                  return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
                }, async () => {
                  await assert.rejects(
                    () =>
                      release({
                        token: "token",
                        lockName: "wallstop-organization-builds",
                        holderIdSuffix: "playmode",
                        lockRepository: "o/r",
                        lockRepo: { owner: "o", repo: "r" },
                        stateBranch: "lock-state",
                        statePath: "locks/wallstop-organization-builds.json",
                        resourceReport: testCase.report
                      }),
                    testCase.error
                  );
                });
              }
            );
          });
        });

        const outputs = readEnvironmentFile(outputFile);
        if (!testCase.expected) {
          assert.deepEqual(outputs, {});
          return;
        }
        assertOutputContract(outputs, releaseOutputNames);
        for (const [name, value] of Object.entries(testCase.expected)) {
          assert.equal(outputs[name], value, `output ${name}`);
        }
        assert.equal(outputs["holder-id"], "owner/repo:123:perf-benchmarks:playmode");
        assert.equal(outputs["lock-name"], "wallstop-organization-builds");
      });
    });
  }
});


test("release retry knobs are configurable through action inputs", async (t) => {
  const baseEnvironment = {
    "INPUT_LOCK-NAME": "wallstop-organization-builds",
    "INPUT_LOCK-REPOSITORY": "Ambiguous-Interactive/ambiguous-organization-build-lock",
    "INPUT_RELEASE-RETRY-DEADLINE-SECONDS": undefined,
    "INPUT_API-MAX-ATTEMPTS": undefined,
    "INPUT_API-RETRY-BASE-MS": undefined,
    "INPUT_API-RETRY-MAX-MS": undefined,
    BUILD_LOCK_API_MAX_ATTEMPTS: undefined,
    BUILD_LOCK_API_RETRY_BASE_MS: undefined,
    BUILD_LOCK_API_RETRY_MAX_MS: undefined,
    GITHUB_REPOSITORY: authorizedConsumerEnv.GITHUB_REPOSITORY,
    GITHUB_REPOSITORY_ID: authorizedConsumerEnv.GITHUB_REPOSITORY_ID,
    GITHUB_REPOSITORY_OWNER_ID: authorizedConsumerEnv.GITHUB_REPOSITORY_OWNER_ID,
    BUILD_LOCK_APP_ID: "12345",
    BUILD_LOCK_APP_PRIVATE_KEY: testAppPrivateKey
  };

  await t.test("an explicit input wins over an inherited environment value", async () => {
    await withEnvironment(
      {
        ...baseEnvironment,
        "INPUT_RELEASE-RETRY-DEADLINE-SECONDS": "300",
        "INPUT_API-MAX-ATTEMPTS": "9",
        "INPUT_API-RETRY-BASE-MS": "250",
        "INPUT_API-RETRY-MAX-MS": "5000",
        BUILD_LOCK_API_RETRY_MAX_MS: "60000"
      },
      () => {
        assert.equal(config().releaseRetryDeadlineSeconds, 300);
        assert.deepEqual(
          [
            process.env.BUILD_LOCK_API_MAX_ATTEMPTS,
            process.env.BUILD_LOCK_API_RETRY_BASE_MS,
            process.env.BUILD_LOCK_API_RETRY_MAX_MS
          ],
          ["9", "250", "5000"]
        );
      }
    );
  });

  // These knobs only change how long a retry waits. Refusing to run over one would
  // abandon the holder cleanup the release exists to perform and pin a licensed
  // seat, so an out-of-range value is reported and ignored rather than fatal - the
  // same way invalid cleanup evidence degrades instead of aborting.
  const ignored = [
    ["zero backoff ceiling", "INPUT_API-RETRY-MAX-MS", "0", /api-retry-max-ms=0; expected an integer between 1000 and 300000/],
    ["zero base backoff", "INPUT_API-RETRY-BASE-MS", "0", /api-retry-base-ms=0; expected an integer between 100 and 60000/],
    ["zero attempt ceiling", "INPUT_API-MAX-ATTEMPTS", "0", /api-max-attempts=0; expected an integer between 1 and 100/],
    ["oversized attempt ceiling", "INPUT_API-MAX-ATTEMPTS", "101", /api-max-attempts=101; expected an integer between 1 and 100/],
    ["non-numeric backoff", "INPUT_API-RETRY-BASE-MS", "1e3", /api-retry-base-ms=1e3; expected an integer between 100 and 60000/],
    ["oversized release deadline", "INPUT_RELEASE-RETRY-DEADLINE-SECONDS", "3601", /release-retry-deadline-seconds=3601; expected an integer between 0 and 3600/],
    // A budget this small leaves its narrowest phase too little time to mint a
    // token and make one call, so it performs worse than no deadline at all.
    ["unworkably small release deadline", "INPUT_RELEASE-RETRY-DEADLINE-SECONDS", "5", /Ignoring release-retry-deadline-seconds=5; a budget below 30 seconds/]
  ];

  for (const [name, inputName, value, expected] of ignored) {
    await t.test(`reports and ignores ${name}`, async () => {
      await withEnvironment({ ...baseEnvironment, [inputName]: value }, () => {
        const logs = [];
        const previousLog = console.log;
        console.log = (line) => logs.push(String(line));
        let parsed;
        try {
          parsed = config();
        } finally {
          console.log = previousLog;
        }

        assert.equal(parsed.releaseRetryDeadlineSeconds, 120, "the release must still run its default budget");
        assert.ok(
          logs.some((line) => expected.test(line)),
          `expected the ignored value to be reported, saw ${logs.join(" | ")}`
        );
        assert.deepEqual(
          [
            process.env.BUILD_LOCK_API_MAX_ATTEMPTS,
            process.env.BUILD_LOCK_API_RETRY_BASE_MS,
            process.env.BUILD_LOCK_API_RETRY_MAX_MS
          ],
          [undefined, undefined, undefined],
          "an ignored input must not reach the retry environment"
        );
      });
    });
  }
});


// The preparatory calls need their own retry budget, because a broad outage hits
// them first and would otherwise fail the release before the write is attempted.
// They must not spend the budget that exists to protect the write itself.
test("release splits its retry budget between preparation and the lock-state write", async () => {
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
  let branchChecks = 0;
  let configReads = 0;
  let writeAttempts = 0;

  await withTempFile(async (outputFile) => {
    await withImmediateTimers(
      async () => {
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
                branchChecks++;
                return branchChecks <= 7
                  ? jsonResponse(503, { message: "No server is currently available." })
                  : jsonResponse(200, { object: { sha: "branch-sha" } });
              }
              if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.config.json") {
                configReads++;
                return configReads <= 7
                  ? jsonResponse(503, { message: "No server is currently available." })
                  : jsonResponse(404, { message: "Not Found" });
              }
              if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
                if (options.method === "PUT") {
                  writeAttempts++;
                  return writeAttempts <= 8
                    ? jsonResponse(503, { message: "No server is currently available." })
                    : jsonResponse(200, { content: { sha: "state-after-release" } });
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
                statePath: "locks/wallstop-organization-builds.json",
                configPath: "locks/wallstop-organization-builds.config.json",
                resourceReport: { cleanupStatus: "confirmed", health: "healthy", reason: "cleanup-confirmed" }
              });
            });
          }
        );
      }
    );

    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs["cleanup-result"], "released");
  });

  assert.equal(branchChecks, 8, "the state-branch check outlasts the 5-attempt ceiling");
  assert.equal(configReads, 8, "the lock-config read outlasts the 5-attempt ceiling");
  assert.equal(writeAttempts, 9, "the write still gets its own time-bounded budget");
});


// Neither preparatory call may red a release before the lock-state write is
// attempted: an outage broad enough to matter reaches them first.
test("release degrades unreachable preparatory calls instead of failing on them", async () => {
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
  let wrote = false;
  let warned = [];

  await withTempFile(async (outputFile) => {
    await withEnvironment({ BUILD_LOCK_API_MAX_ATTEMPTS: "2" }, async () => {
      await withImmediateTimers(async () => {
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
              if (
                parsed.pathname === "/repos/o/r/git/ref/heads/lock-state" ||
                parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.config.json"
              ) {
                return jsonResponse(503, { message: "No server is currently available." });
              }
              if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
                if (options.method === "PUT") {
                  wrote = true;
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
                statePath: "locks/wallstop-organization-builds.json",
                configPath: "locks/wallstop-organization-builds.config.json",
                resourceReport: { cleanupStatus: "confirmed", health: "healthy", reason: "cleanup-confirmed" }
              });
              warned = logs.filter((line) => line.startsWith("::warning::"));
            });
          }
        );
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs["cleanup-result"], "released");
    assert.equal(outputs.released, "true");
  });

  assert.ok(
    warned.some((line) => /An attempt ceiling of 2 bounds the 120s release retry deadline/.test(line)),
    `expected an inherited attempt ceiling to be reported, saw ${warned.join(" | ")}`
  );
  assert.equal(
    warned.filter((line) => /attempt ceiling of/.test(line)).length,
    1,
    "the ceiling notice belongs on the release, not on every API call"
  );
  assert.equal(wrote, true, "the lock-state write must still be attempted");
  assert.ok(
    warned.some((line) => /Could not verify the lock-state branch/.test(line)),
    `expected a degraded state-branch warning, saw ${warned.join(" | ")}`
  );
  assert.ok(
    warned.some((line) => /Unable to read lock config/.test(line)),
    `expected a degraded lock-config warning, saw ${warned.join(" | ")}`
  );
});


// Every phase here degrades on failure, so a shared deadline lets whichever runs
// first consume the others' budget. The shares are wall-clock arithmetic that no
// mocked-timer test can observe, so assert them directly.
test("the release budget gives every phase a share strictly inside the total", async (t) => {
  const now = 1_800_000_000_000;

  await t.test("the default budget splits as documented", () => {
    const budget = releaseRetryApiOptions({ releaseRetryDeadlineSeconds: 120 }, now);
    assert.equal(budget.seconds, 120);
    assert.equal(budget.stateBranch.deadlineAt - now, 15_000);
    assert.equal(budget.lockConfig.deadlineAt - now, 30_000);
    assert.equal(budget.cleanup.deadlineAt - now, 120_000);
    // A deadline consulted only between attempts cannot bound a stalled request.
    for (const phase of [budget.stateBranch, budget.lockConfig, budget.cleanup]) {
      assert.ok(phase.signal instanceof AbortSignal, "every phase deadline needs a matching abort signal");
      assert.equal(phase.signal.aborted, false);
    }
  });

  await t.test("a phase deadline that fires mid-request reports an unrecorded release", async () => {
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
            // Never answers. Only the abort signal can end this request.
            return new Promise((_resolve, reject) => {
              options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
            });
          }, async () => {
            let outcome = null;
            release({
              token: "token",
              lockName: "wallstop-organization-builds",
              holderIdSuffix: "playmode",
              lockRepository: "o/r",
              lockRepo: { owner: "o", repo: "r" },
              stateBranch: "lock-state",
              statePath: "locks/wallstop-organization-builds.json",
              configPath: "locks/wallstop-organization-builds.config.json",
              releaseRetryDeadlineSeconds: 1,
              resourceReport: { cleanupStatus: "confirmed", health: "healthy", reason: "cleanup-confirmed" }
            }).then(
              () => {
                outcome = "resolved";
              },
              (error) => {
                outcome = error;
              }
            );
            // The phase deadline timers do not keep the loop alive. This ref'd floor
            // outlives the one second total budget this test configures. Await the
            // floor only; awaiting the attempt too could drain the loop before the
            // assertion records a missing deadline as a loud failure.
            await new Promise((resolve) => setTimeout(resolve, 1_200));
            assert.match(
              String(outcome),
              /Could not confirm the release of wallstop-organization-builds/
            );
          });
        }
      );

      const outputs = readEnvironmentFile(outputFile);
      assertOutputContract(outputs, releaseOutputNames);
      assert.equal(outputs["cleanup-result"], "lock-release-unreachable");
      assert.equal(outputs.released, "false");
    });
  });

  await t.test("a disabled budget hands every phase the attempt-bounded default", () => {
    assert.deepEqual(releaseRetryApiOptions({ releaseRetryDeadlineSeconds: 0 }, now), {
      seconds: 0,
      stateBranch: undefined,
      lockConfig: undefined,
      cleanup: undefined
    });
  });

  await t.test("no legal deadline lets preparation reach the write's share", () => {
    for (const seconds of [1, 2, 3, 4, 5, 17, 120, 3600]) {
      const budget = releaseRetryApiOptions({ releaseRetryDeadlineSeconds: seconds }, now);
      const stateBranch = budget.stateBranch.deadlineAt - now;
      const lockConfig = budget.lockConfig.deadlineAt - now;
      const cleanup = budget.cleanup.deadlineAt - now;
      assert.ok(
        0 < stateBranch && stateBranch < lockConfig && lockConfig < cleanup,
        `expected strictly increasing shares at ${seconds}s, saw ${stateBranch}/${lockConfig}/${cleanup}`
      );
      assert.equal(cleanup, seconds * 1000);
    }
  });
});


// Production releases always mint an App token first, and minting runs inside the
// call whose budget it should inherit. Every other release test passes a plain
// string token, so this is the only one that exercises the real credential path.
test("release mints its App token under the same budget as the call it serves", async () => {
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
  let installationLookups = 0;
  let wrote = false;

  await withTempFile(async (outputFile) => {
    await withImmediateTimers(async () => {
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
            if (parsed.pathname === "/repos/o/r/installation") {
              installationLookups++;
              return installationLookups <= 5
                ? jsonResponse(503, { message: "No server is currently available." })
                : jsonResponse(200, { id: 42 });
            }
            if (parsed.pathname === "/app/installations/42/access_tokens") {
              return jsonResponse(201, {
                token: "ghs-installation-token",
                expires_at: "2999-01-01T00:00:00.000Z"
              });
            }
            if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
              return jsonResponse(200, { object: { sha: "branch-sha" } });
            }
            if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
              if (options.method === "PUT") {
                wrote = true;
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
              token: createGitHubAppAuth({
                appId: "12345",
                privateKey: testAppPrivateKey,
                owner: "o",
                repository: "r",
                repositories: ["r"],
                permissions: { contents: "write" }
              }),
              lockName: "wallstop-organization-builds",
              holderIdSuffix: "playmode",
              lockRepository: "o/r",
              lockRepo: { owner: "o", repo: "r" },
              stateBranch: "lock-state",
              statePath: "locks/wallstop-organization-builds.json",
              resourceReport: { cleanupStatus: "confirmed", health: "healthy", reason: "cleanup-confirmed" }
            });
          });
        }
      );
    });

    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs["cleanup-result"], "released");
    assert.equal(outputs.released, "true");
  });

  assert.equal(wrote, true);
  assert.equal(
    installationLookups,
    6,
    "minting must inherit the release deadline instead of stopping at its own 3-attempt budget"
  );
});


// An unreachable lock config must degrade for every last status, not only the ones
// configReadCanFailClosed enumerates. The transient GitHub HTML 400 interstitial is
// retryable but not in that list, so an exhausted budget on it used to red the
// release before the lock-state write was attempted.
test("release degrades an unreachable lock config whatever its last status was", async () => {
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
  let wrote = false;
  let warned = [];

  await withTempFile(async (outputFile) => {
    await withEnvironment({ BUILD_LOCK_API_MAX_ATTEMPTS: "2" }, async () => {
      await withImmediateTimers(async () => {
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
              if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.config.json") {
                return htmlResponse(
                  400,
                  "<html><head><title>Bad Request</title></head><body>Whoa there! " +
                    "GitHub could not process this invalid request.</body></html>"
                );
              }
              if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
                if (options.method === "PUT") {
                  wrote = true;
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
                statePath: "locks/wallstop-organization-builds.json",
                configPath: "locks/wallstop-organization-builds.config.json",
                resourceReport: { cleanupStatus: "confirmed", health: "healthy", reason: "cleanup-confirmed" }
              });
              warned = logs.filter((line) => line.startsWith("::warning::"));
            });
          }
        );
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs["cleanup-result"], "released");
  });

  assert.equal(wrote, true, "the lock-state write must still be attempted");
  assert.ok(
    warned.some((line) => /Unable to read lock config.*using safe defaults/.test(line)),
    `expected a degraded lock-config warning, saw ${warned.join(" | ")}`
  );
});


// An out-of-range ceiling is already reported and ignored by the retry budget, so
// release must not also announce it as a bound that took effect.
test("release does not report an attempt ceiling the retry budget ignores", async () => {
  const state = emptyState("wallstop-organization-builds");
  let warned = [];

  await withTempFile(async (outputFile) => {
    await withEnvironment({ BUILD_LOCK_API_MAX_ATTEMPTS: "500" }, async () => {
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
          await withMockedFetch(async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
              return jsonResponse(200, { object: { sha: "branch-sha" } });
            }
            if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
              return jsonResponse(200, {
                content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
                sha: "state-sha"
              });
            }
            return jsonResponse(404, { message: "Not Found" });
          }, async (logs) => {
            await release({
              token: "token",
              lockName: "wallstop-organization-builds",
              holderIdSuffix: "playmode",
              lockRepository: "o/r",
              lockRepo: { owner: "o", repo: "r" },
              stateBranch: "lock-state",
              statePath: "locks/wallstop-organization-builds.json",
              resourceReport: { cleanupStatus: "confirmed", health: "healthy", reason: "cleanup-confirmed" }
            });
            warned = logs.filter((line) => line.startsWith("::warning::"));
          });
        }
      );
    });
  });

  assert.ok(
    !warned.some((line) => /attempt ceiling of/.test(line)),
    `an ignored ceiling must not be reported as effective, saw ${warned.join(" | ")}`
  );
});
