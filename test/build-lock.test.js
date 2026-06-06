const assert = require("node:assert/strict");
const test = require("node:test");

const {
  acquire,
  api,
  emptyState,
  evaluateStale,
  isRetryableResponse,
  release,
  writeState
} = require("../.github/dist/build-lock.js");

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
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_WORKFLOW",
  "GITHUB_JOB",
  "GITHUB_OUTPUT",
  "GITHUB_STEP_SUMMARY"
];

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

async function withImmediateTimers(callback) {
  const previousSetTimeout = global.setTimeout;
  global.setTimeout = (handler, _timeout, ...args) => previousSetTimeout(handler, 0, ...args);
  try {
    return await callback();
  } finally {
    global.setTimeout = previousSetTimeout;
  }
}

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
    { status: 401, message: "bad credentials" },
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

test("writeState preserves CAS conflict handling after a transient retry", async () => {
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

    assert.deepEqual(result, { conflict: true, sha: "" });
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

  await withActionEnv(
    {
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_WORKFLOW: "Perf",
      GITHUB_JOB: "perf-benchmarks"
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

    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.path}`),
      [
        "GET /repos/o/r/git/ref/heads/lock-state",
        "GET /repos/o/r/contents/locks/wallstop-organization-builds.json",
        "GET /repos/owner/repo/actions/runs/123"
      ]
    );
      assert.match(logs.join("\n"), /Already holds wallstop-organization-builds/);
    });
    }
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
      "GET /repos/o/r/git/ref/heads/lock-state",
      "GET /repos/o/r/contents/locks/wallstop-organization-builds.json",
      "PUT /repos/o/r/contents/locks/wallstop-organization-builds.json",
      "PUT /repos/o/r/contents/locks/wallstop-organization-builds.json",
      "GET /repos/o/r/contents/locks/wallstop-organization-builds.json",
      "GET /repos/owner/repo/actions/runs/123"
    ]
  );
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
      /Ensure BUILD_LOCK_TOKEN has actions: read access/
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
      /Ensure BUILD_LOCK_TOKEN can read this repository and has actions: read access/
    );
  });
});
