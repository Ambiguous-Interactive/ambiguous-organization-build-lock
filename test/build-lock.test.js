const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  acquire,
  api,
  emptyState,
  evaluateStale,
  installAcquireSignalCleanup,
  isRetryableResponse,
  postCleanup,
  release,
  reap,
  runCancellationCleanup,
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
  "GITHUB_STEP_SUMMARY",
  "GITHUB_STATE",
  "STATE_build_lock_cleanup"
];

const acquireOutputNames = [
  "acquired",
  "lock-name",
  "holder-id",
  "state-sha",
  "wait-ms",
  "attempts",
  "stale-recovered"
];

const releaseOutputNames = [
  "released",
  "queue-cleaned",
  "cleanup-result",
  "lock-name",
  "holder-id",
  "state-sha",
  "held-by",
  "held-by-run-url"
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
      "GET /repos/o/r/git/ref/heads/lock-state",
      "GET /repos/o/r/contents/locks/wallstop-organization-builds.json",
      "GET /repos/owner/repo/actions/runs/123"
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
      "GET /repos/o/r/git/ref/heads/lock-state",
      "GET /repos/o/r/contents/locks/wallstop-organization-builds.json",
      "PUT /repos/o/r/contents/locks/wallstop-organization-builds.json",
      "PUT /repos/o/r/contents/locks/wallstop-organization-builds.json",
      "GET /repos/o/r/contents/locks/wallstop-organization-builds.json",
      "GET /repos/owner/repo/actions/runs/123"
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

test("acquire preserves stale recovery when an accepted stale replacement is reported as a transient failure", async () => {
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
  let putCalls = 0;
  const calls = [];

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
            calls.push({ method: options.method || "GET", path: parsed.pathname });
            if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
              return jsonResponse(200, { object: { sha: "branch-sha" } });
            }
            if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
              if (options.method === "PUT") {
                putCalls++;
                const body = JSON.parse(options.body);
                const written = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
                if (putCalls === 1) {
                  state = written;
                  return jsonResponse(500, { message: "accepted but response failed" });
                }
                return jsonResponse(409, { message: "sha does not match" });
              }
              return jsonResponse(200, {
                content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
                sha: state.holder.holderId === "owner/repo:123:perf-benchmarks:playmode"
                  ? "state-sha-after-put"
                  : "state-sha-before-put"
              });
            }
            if (parsed.pathname === "/repos/other/repo/actions/runs/999") {
              return jsonResponse(200, { status: "completed", conclusion: "success" });
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
            assert.equal(state.holder.holderId, "owner/repo:123:perf-benchmarks:playmode");
            assert.match(logs.join("\n"), /Recovering stale holder: holder run is completed/);
            assert.match(logs.join("\n"), /HTTP 500; retrying/);
            assert.match(logs.join("\n"), /Already holds wallstop-organization-builds/);
          });
        });
      }
    );

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, acquireOutputNames);
    assert.equal(outputs.acquired, "true");
    assert.equal(outputs["lock-name"], "wallstop-organization-builds");
    assert.equal(outputs["holder-id"], "owner/repo:123:perf-benchmarks:playmode");
    assert.equal(outputs["state-sha"], "state-sha-after-put");
    assert.equal(outputs.attempts, "2");
    assert.equal(outputs["stale-recovered"], "true");
  });

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      "GET /repos/o/r/git/ref/heads/lock-state",
      "GET /repos/o/r/contents/locks/wallstop-organization-builds.json",
      "GET /repos/other/repo/actions/runs/999",
      "PUT /repos/o/r/contents/locks/wallstop-organization-builds.json",
      "PUT /repos/o/r/contents/locks/wallstop-organization-builds.json",
      "GET /repos/o/r/contents/locks/wallstop-organization-builds.json",
      "GET /repos/owner/repo/actions/runs/123"
    ]
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
                /holder=other\/repo:999:perf-benchmarks:editmode.*queue-position=1.*reason=holder run is in_progress/
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

test("acquire timeout preserves stale recovery output after a raced stale replacement", async () => {
  const originalNow = Date.now;
  let now = 0;
  let readCount = 0;
  let staleReplacementWrites = 0;
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
      expiresAt: "2026-06-06T01:00:00.000Z"
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
  const competingHolder = {
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
                  const written = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
                  if (written.holder && written.holder.holderId === "owner/repo:123:perf-benchmarks:playmode") {
                    staleReplacementWrites++;
                    state = {
                      ...written,
                      holder: competingHolder,
                      queue: []
                    };
                  } else {
                    state = written;
                  }
                  return jsonResponse(200, { content: { sha: `state-after-write-${staleReplacementWrites}` } });
                }
                readCount++;
                return jsonResponse(200, {
                  content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
                  sha: `state-read-${readCount}`
                });
              }
              if (parsed.pathname === "/repos/other/repo/actions/runs/999") {
                return jsonResponse(200, { status: "completed", conclusion: "success" });
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
                /Timed out waiting for build lock/
              );
            });
          });
        }
      );

      assert.equal(staleReplacementWrites, 1);
      const outputs = readEnvironmentFile(outputFile);
      assertOutputContract(outputs, acquireOutputNames);
      assert.equal(outputs.acquired, "false");
      assert.equal(outputs["stale-recovered"], "true");
    });
  } finally {
    Date.now = originalNow;
  }
});

test("acquire timeout preserves stale recovery after an ambiguous stale replacement sees another holder", async () => {
  const originalNow = Date.now;
  let now = 0;
  let readCount = 0;
  let acquirePutCalls = 0;
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
  const competingHolder = {
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

  Date.now = () => {
    now += 10000;
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
                  const written = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
                  if (body.message === "Acquire wallstop-organization-builds") {
                    acquirePutCalls++;
                    if (acquirePutCalls === 1) {
                      state = {
                        ...written,
                        holder: competingHolder,
                        queue: [written.holder]
                      };
                      return jsonResponse(500, { message: "accepted but response failed" });
                    }
                    return jsonResponse(409, { message: "sha does not match" });
                  }
                  state = written;
                  return jsonResponse(200, { content: { sha: "state-after-cleanup" } });
                }
                readCount++;
                return jsonResponse(200, {
                  content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
                  sha: `state-read-${readCount}`
                });
              }
              if (parsed.pathname === "/repos/other/repo/actions/runs/999") {
                return jsonResponse(200, { status: "completed", conclusion: "success" });
              }
              if (parsed.pathname === "/repos/other/repo/actions/runs/456") {
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
                    pollSeconds: 1
                  }),
                /holder=other\/repo:456:perf-benchmarks:editmode.*queue-position=1.*reason=holder run is in_progress/
              );
            });
          });
        }
      );

      assert.equal(acquirePutCalls, 2);
      const outputs = readEnvironmentFile(outputFile);
      assertOutputContract(outputs, acquireOutputNames);
      assert.equal(outputs.acquired, "false");
      assert.equal(outputs["stale-recovered"], "true");
    });
  } finally {
    Date.now = originalNow;
  }

  assert.equal(state.holder.holderId, "other/repo:456:perf-benchmarks:editmode");
  assert.deepEqual(state.queue, []);
});

test("opt-in acquire records post cleanup after an ambiguous stale recovery write", async () => {
  const originalNow = Date.now;
  let now = 0;
  let acquirePutCalls = 0;
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
      expiresAt: "2026-06-06T01:00:00.000Z"
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
                  const body = JSON.parse(options.body);
                  const written = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
                  if (body.message === "Acquire wallstop-organization-builds") {
                    acquirePutCalls++;
                    if (acquirePutCalls === 1) {
                      state = written;
                      return jsonResponse(500, { message: "accepted but response failed" });
                    }
                    return jsonResponse(409, { message: "sha does not match" });
                  }
                  state = written;
                  return jsonResponse(200, { content: { sha: "state-after-cleanup" } });
                }
                return jsonResponse(200, {
                  content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
                  sha: state.holder && state.holder.holderId === "owner/repo:123:perf-benchmarks:playmode"
                    ? "state-after-ambiguous-acquire"
                    : "state-before-acquire"
                });
              }
              if (parsed.pathname === "/repos/other/repo/actions/runs/999") {
                return jsonResponse(200, { status: "completed", conclusion: "success" });
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

      assert.equal(acquirePutCalls, 2);
      assert.equal(readEnvironmentFile(stateFile).build_lock_cleanup, "enabled");
    });
  } finally {
    Date.now = originalNow;
  }
});

test("acquire timeout does not mark stale recovery after an unrecovered stale CAS conflict", async () => {
  const originalNow = Date.now;
  let now = 0;
  let staleRecoveryConflicts = 0;
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
      expiresAt: "2026-06-06T01:00:00.000Z"
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
                  if (body.message === "Acquire wallstop-organization-builds") {
                    staleRecoveryConflicts++;
                  }
                  return jsonResponse(409, { message: "sha does not match" });
                }
                return jsonResponse(200, {
                  content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
                  sha: "state-before-read"
                });
              }
              if (parsed.pathname === "/repos/other/repo/actions/runs/999") {
                return jsonResponse(200, { status: "completed", conclusion: "success" });
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
                /Timed out waiting for build lock/
              );
            });
          });
        }
      );

      assert.equal(staleRecoveryConflicts, 1);
      const outputs = readEnvironmentFile(outputFile);
      assertOutputContract(outputs, acquireOutputNames);
      assert.equal(outputs.acquired, "false");
      assert.equal(outputs["stale-recovered"], "false");
    });
  } finally {
    Date.now = originalNow;
  }
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
                  state = { ...state, holder: nextHolder };
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
      "INPUT_LOCK-NAME": "wallstop-organization-builds",
      STATE_build_lock_cleanup: "enabled"
    }
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /::warning::Build lock post cleanup could not start: BUILD_LOCK_TOKEN is required\./);
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
