const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const {
  MAX_ATTEMPTS,
  requireCurrentPrHead,
  retryAfterDelay,
  workflowCommandData
} = require("../.github/dist/require-current-pr-head.js");

const expectedSha = "a".repeat(40);
const newerSha = "b".repeat(40);

test("current PR head errors escape percent sequences and collapse line breaks", () => {
  assert.equal(
    workflowCommandData("source%0Ainjected\r\n::error::second"),
    "source%250Ainjected ::error::second"
  );
});

function guardEnvironment(overrides = {}) {
  return {
    GITHUB_API_URL: "https://api.github.test",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_OUTPUT: "outputs.txt",
    GITHUB_REPOSITORY: "Ambiguous-Interactive/example",
    "INPUT_EXPECTED-HEAD-SHA": expectedSha,
    "INPUT_GITHUB-TOKEN": "test-token",
    "INPUT_PULL-REQUEST-NUMBER": "52",
    ...overrides
  };
}

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body
  };
}

test("current PR head guard accepts the exact event SHA without exposing its token", async () => {
  const writes = [];
  const requests = [];

  const result = await requireCurrentPrHead({
    env: guardEnvironment(),
    appendFile: (_path, value) => writes.push(value),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response(200, { state: "open", head: { sha: expectedSha } });
    },
    log: () => {}
  });

  assert.deepEqual(result, { isCurrent: true, currentHeadSha: expectedSha });
  assert.deepEqual(writes, [`is-current=true\n`, `current-head-sha=${expectedSha}\n`]);
  assert.equal(requests[0].url, "https://api.github.test/repos/Ambiguous-Interactive/example/pulls/52");
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");
  assert.doesNotMatch(JSON.stringify(result), /test-token/);
});

test("current PR head guard checks every PR-shaped trigger", async (t) => {
  for (const eventName of ["pull_request_target", "workflow_call"]) {
    await t.test(eventName, async () => {
      let fetched = false;
      const result = await requireCurrentPrHead({
        env: guardEnvironment({ GITHUB_EVENT_NAME: eventName }),
        appendFile: () => {},
        fetchImpl: async () => {
          fetched = true;
          return response(200, { state: "open", head: { sha: expectedSha } });
        },
        log: () => {}
      });

      assert.equal(fetched, true);
      assert.equal(result.isCurrent, true);
    });
  }
});

test("current PR head guard rejects a superseded run and reports the new SHA", async () => {
  const writes = [];

  await assert.rejects(
    requireCurrentPrHead({
      env: guardEnvironment(),
      appendFile: (_path, value) => writes.push(value),
      fetchImpl: async () => response(200, { state: "open", head: { sha: newerSha } }),
      log: () => {}
    }),
    new RegExp(`Stale pull request run for ${expectedSha}.*${newerSha}`)
  );
  assert.deepEqual(writes, [`is-current=false\n`, `current-head-sha=${newerSha}\n`]);
});

test("embedded current-head checks can return stale without writing another action's outputs", async () => {
  const writes = [];
  const result = await requireCurrentPrHead({
    env: guardEnvironment(),
    appendFile: (_path, value) => writes.push(value),
    fetchImpl: async () => response(200, { state: "open", head: { sha: newerSha } }),
    writeOutputs: false,
    throwOnStale: false,
    log: () => {}
  });

  assert.deepEqual(result, { isCurrent: false, currentHeadSha: newerSha });
  assert.deepEqual(writes, []);
});

test("a caller cancellation signal does not disable the bounded request timeout", async () => {
  const caller = new AbortController();
  const guard = requireCurrentPrHead({
    env: guardEnvironment(),
    fetchImpl: async (_url, options) => {
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    },
    signal: caller.signal,
    timeoutMs: 1,
    log: () => {}
  });
  let outcome = null;
  guard.then(
    () => {
      outcome = "resolved";
    },
    (error) => {
      outcome = error;
    }
  );
  // The bounded timeout signal does not keep the loop alive. This ref'd delay does.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(String(outcome), /timeout|aborted/i);
  assert.equal(caller.signal.aborted, false);
});

test("current PR head guard retries a transient lookup without a fixed long sleep", async () => {
  const sleeps = [];
  let discarded = 0;
  let attempts = 0;
  const result = await requireCurrentPrHead({
    env: guardEnvironment(),
    appendFile: () => {},
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? { ...response(503, {}, { "retry-after": "0" }), body: { cancel: async () => { discarded += 1; } } }
        : response(200, { state: "open", head: { sha: expectedSha } });
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    log: () => {}
  });

  assert.equal(result.isCurrent, true);
  assert.equal(attempts, 2);
  assert.equal(discarded, 1);
  assert.deepEqual(sleeps, [0]);
});

test("current PR head guard paces transient lookups across its whole budget (issue #349)", async () => {
  const logs = [];
  const sleeps = [];
  let attempts = 0;
  const result = await requireCurrentPrHead({
    env: guardEnvironment(),
    appendFile: () => {},
    fetchImpl: async () => {
      attempts += 1;
      return attempts <= 3 ? response(503, {}) : response(200, { state: "open", head: { sha: expectedSha } });
    },
    monotonicNow: () => 0,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    log: (line) => logs.push(line)
  });

  assert.equal(result.isCurrent, true);
  // Three rapid 503s ended the old three-attempt loop in about five seconds and
  // aborted admission inside a longer-than-40 s upstream window. The paced
  // budget keeps sampling the window instead of giving up early.
  assert.equal(attempts, 4);
  assert.deepEqual(sleeps, [250, 500, 1000]);
  // The attempt ceiling is a backstop, not the ordinary bound: a paced run
  // reaches the deadline long before it.
  assert.equal(MAX_ATTEMPTS, 20);
  assert.equal(logs.filter((line) => /::warning::GitHub pull request lookup returned HTTP 503/.test(line)).length, 3);
  assert.match(logs.at(-1), /#52 still points to this run's head SHA/);
});

test("current PR head guard exhausts to a named diagnosis when the deadline passes", async () => {
  const monotonicValues = [];
  let monotonicStep = 0;
  const monotonicNow = () => {
    const value = monotonicStep * 10_000;
    monotonicStep += 1;
    monotonicValues.push(value);
    return value;
  };
  const writes = [];
  const sleeps = [];
  let attempts = 0;
  let discarded = 0;

  const error = await requireCurrentPrHead({
    env: guardEnvironment(),
    appendFile: (_path, value) => writes.push(value),
    fetchImpl: async () => {
      attempts += 1;
      return {
        ...response(503, {}, { "x-github-request-id": "req-9", }),
        body: { cancel: async () => { discarded += 1; } }
      };
    },
    monotonicNow,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    timeoutMs: 30_000,
    log: () => {}
  }).then(
    () => { throw new Error("expected exhaustion"); },
    (failure) => failure
  );

  // monotonicNow calls: budget setup, one top-of-loop check per attempt after
  // the first, and one remaining read per handled failure.
  assert.deepEqual(monotonicValues, [0, 10_000, 20_000, 30_000, 40_000]);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [250, 0]);
  assert.equal(discarded, 2);
  assert.deepEqual(writes, []);
  assert.equal(error.code, "GITHUB_API_RETRY_EXHAUSTED");
  assert.equal(error.attempts, 2);
  assert.equal(error.status, 503);
  assert.match(
    String(error.message),
    /exhausted its bounded retry budget after 2 attempt\(s\) because the bounded deadline elapsed; last failure: HTTP 503 \(request-id=req-9\)/
  );
});

test("current PR head guard names the deadline when its last in-flight request is killed by the budget", async () => {
  const outcome = await requireCurrentPrHead({
    env: guardEnvironment(),
    appendFile: () => {},
    fetchImpl: (url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      }),
    timeoutMs: 5,
    log: () => {}
  }).then(
    () => { throw new Error("expected exhaustion"); },
    (failure) => failure
  );

  assert.match(
    String(outcome.message),
    /exhausted its bounded retry budget after 1 attempt\(s\) because the bounded deadline elapsed/
  );
  assert.match(String(outcome.message), /no response was received before the deadline/);
});

test("current PR head guard fails closed on a permanent authorization failure without retrying", async () => {
  const sleeps = [];
  const writes = [];
  let discarded = 0;
  let attempts = 0;

  await assert.rejects(
    requireCurrentPrHead({
      env: guardEnvironment(),
      appendFile: (_path, value) => writes.push(value),
      fetchImpl: async (_url, _options) => {
        attempts += 1;
        return {
          ...response(401, { message: "Bad credentials" }),
          body: { cancel: async () => { discarded += 1; } }
        };
      },
      monotonicNow: () => 0,
      sleep: async (milliseconds) => sleeps.push(milliseconds),
      timeoutMs: 30_000,
      log: () => {}
    }),
    /GitHub pull request lookup failed with HTTP 401/
  );

  // A bad token never succeeds with backoff, so the guard fails closed on the
  // first response and keeps the HTTP status as the cause downstream. Its body
  // is still disposed before the failure.
  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(discarded, 1);
  assert.deepEqual(writes, []);
});

test("current PR head guard rejects a head that changed during recovery without admission", async () => {
  const writes = [];
  let discarded = 0;
  let attempts = 0;

  await assert.rejects(
    requireCurrentPrHead({
      env: guardEnvironment(),
      appendFile: (_path, value) => writes.push(value),
      fetchImpl: async () => {
        attempts += 1;
        return attempts === 1
          ? { ...response(503, {}), body: { cancel: async () => { discarded += 1; } } }
          : response(200, { state: "open", head: { sha: newerSha } });
      },
      monotonicNow: () => 0,
      sleep: async () => {},
      timeoutMs: 30_000,
      log: () => {}
    }),
    new RegExp(`Stale pull request run for ${expectedSha}.*${newerSha}`)
  );

  assert.equal(attempts, 2);
  assert.equal(discarded, 1);
  assert.deepEqual(writes, [`is-current=false\n`, `current-head-sha=${newerSha}\n`]);
});

test("current PR head guard names the exhausted diagnosis when the budget kills a paced wait", async () => {
  let attempts = 0;

  // The default sleep is the thread discipline the paced run uses in
  // production, so this contract runs on real timers: the 100 ms budget kills
  // the first 250 ms wait, and the rejection must not escape as a bare
  // AbortError (timers/promises rejects aborts without the signal's reason).
  const outcome = await requireCurrentPrHead({
    env: guardEnvironment(),
    appendFile: () => {},
    fetchImpl: async () => {
      attempts += 1;
      return response(503, {}, { "x-github-request-id": "req-1" });
    },
    timeoutMs: 100,
    log: () => {}
  }).then(
    () => { throw new Error("expected exhaustion"); },
    (failure) => failure
  );

  assert.equal(attempts, 1);
  assert.equal(outcome.code, "GITHUB_API_RETRY_EXHAUSTED");
  assert.equal(outcome.status, 503);
  assert.match(
    String(outcome.message),
    /exhausted its bounded retry budget after 1 attempt\(s\) because the bounded deadline elapsed.*last failure: HTTP 503 \(request-id=req-1\)\./
  );
});

test("current PR head guard keeps the caller's typed cancellation reason from a paced wait", async () => {
  const caller = new AbortController();
  const typedReason = new Error("Build lock acquire cancelled by SIGINT");
  let attempts = 0;

  const outcome = await requireCurrentPrHead({
    env: guardEnvironment(),
    appendFile: () => {},
    signal: caller.signal,
    fetchImpl: async () => {
      attempts += 1;
      return response(503, {});
    },
    sleep: async () => {
      caller.abort(typedReason);
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      throw abortError;
    },
    log: () => {}
  }).then(
    () => { throw new Error("expected cancellation"); },
    (failure) => failure
  );

  // A cancellation landing inside the wait no longer discards acquire's typed
  // reason behind timers' generic AbortError rejection.
  assert.equal(attempts, 1);
  assert.equal(outcome, typedReason);
});

test("current PR head guard names the attempt ceiling when a fitting instruction repeats it away", async () => {
  const writes = [];
  const sleeps = [];
  let attempts = 0;

  const error = await requireCurrentPrHead({
    env: guardEnvironment(),
    appendFile: (_path, value) => writes.push(value),
    fetchImpl: async () => {
      attempts += 1;
      return response(503, {}, { "retry-after": "1" });
    },
    monotonicNow: () => 0,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    timeoutMs: 120_000,
    log: () => {}
  }).then(
    () => { throw new Error("expected exhaustion"); },
    (failure) => failure
  );

  // Honoring a short fitting instruction in full keeps every attempt inside
  // its window, so the ceiling can end the lookup with budget left. The
  // ending still names the attempt count and the last HTTP status.
  assert.equal(attempts, MAX_ATTEMPTS);
  assert.deepEqual(sleeps, Array.from({ length: MAX_ATTEMPTS - 1 }, () => 1_000));
  assert.deepEqual(writes, []);
  assert.equal(error.attempts, MAX_ATTEMPTS);
  assert.equal(error.status, 503);
  assert.match(
    String(error.message),
    /exhausted its bounded retry budget after 20 attempt\(s\) because the attempt ceiling was reached; last failure: HTTP 503\./
  );
});

test("current PR head guard warns before retrying a transport failure", async () => {
  const logs = [];
  const sleeps = [];
  let attempts = 0;

  const result = await requireCurrentPrHead({
    env: guardEnvironment(),
    appendFile: () => {},
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("ECONNRESET");
      }
      return response(200, { state: "open", head: { sha: expectedSha } });
    },
    monotonicNow: () => 0,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    log: (line) => logs.push(line)
  });

  assert.equal(result.isCurrent, true);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [250]);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /::warning::GitHub pull request lookup failed before receiving a response; retrying in 250 ms \(attempt 1; transport error: ECONNRESET\)/);
  assert.match(logs[1], /#52 still points to this run's head SHA/);
});

test("current PR head guard fails closed without retrying past its rate-limit budget", async () => {
  const sleeps = [];
  const writes = [];
  let attempts = 0;
  let discarded = 0;

  await assert.rejects(
    requireCurrentPrHead({
      env: guardEnvironment(),
      appendFile: (_path, value) => writes.push(value),
      fetchImpl: async () => {
        attempts += 1;
        return {
          ...response(403, {}, { "retry-after": "60" }),
          body: { cancel: async () => { discarded += 1; } }
        };
      },
      monotonicNow: () => 0,
      sleep: async (milliseconds) => sleeps.push(milliseconds),
      timeoutMs: 30_000,
      log: () => {}
    }),
    /rate limited for longer than this guard's remaining retry budget/i
  );

  assert.equal(attempts, 1);
  assert.equal(discarded, 1);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(writes, []);
});

test("current PR head guard honors a fitting rate-limit instruction in full", async () => {
  const sleeps = [];
  let attempts = 0;

  const result = await requireCurrentPrHead({
    env: guardEnvironment(),
    appendFile: () => {},
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? response(403, {}, { "retry-after": "15" })
        : response(200, { state: "open", head: { sha: expectedSha } });
    },
    monotonicNow: () => 0,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    timeoutMs: 30_000,
    log: () => {}
  });

  assert.equal(result.isCurrent, true);
  assert.equal(attempts, 2);
  // The active deadline already bounds the total wait, so the instructed 15 s
  // window is honored instead of producing the old capped 10 s retry that would
  // re-enter the window GitHub asked us to wait out.
  assert.deepEqual(sleeps, [15_000]);
});

test("current PR head action exits nonzero without writing outputs when the rate-limit budget is exhausted", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(403, { "Retry-After": "150" });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const directory = mkdtempSync(join(tmpdir(), "current-pr-head-"));
  const outputPath = join(directory, "outputs");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const address = server.address();
  await assert.rejects(
    execFileAsync(process.execPath, [require.resolve("../.github/dist/require-current-pr-head.js")], {
      env: {
        ...process.env,
        GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "Ambiguous-Interactive/example",
        "INPUT_EXPECTED-HEAD-SHA": expectedSha,
        "INPUT_GITHUB-TOKEN": "test-token",
        "INPUT_PULL-REQUEST-NUMBER": "52"
      }
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /rate limited for longer than this guard's remaining retry budget/i);
      return true;
    }
  );

  assert.equal(requests, 1);
  assert.equal(existsSync(outputPath), false);
});

test("current PR head guard rejects an instruction that cannot fit its remaining budget on the first response", () => {
  const now = Date.UTC(2026, 6, 16, 12, 0, 0);
  const retryAt = new Date(now + 7_000).toUTCString();
  assert.equal(retryAfterDelay(response(503, {}, { "retry-after": retryAt }), now), 7_000);
  assert.equal(retryAfterDelay(response(503, {}, { "retry-after": new Date(now + 60_000).toUTCString() }), now), 60_000);
});

test("current PR head guard reports the raw instruction, not a capped one", () => {
  // #349 widened the guard's budget and removed its 10 s eventual-sleep cap, so
  // a fitting instruction is honored in full. The parser itself must stay
  // uncapped: a downstream budget decision may always see the GitHub value.
  assert.equal(
    retryAfterDelay(response(429, {}, { "retry-after": "600" }), Date.UTC(2026, 6, 16, 12, 0, 0)),
    600_000
  );
});

test("current PR head guard treats an absent or invalid instruction as no instruction", () => {
  for (const retryAfter of [undefined, "", "not-a-delay", "-1"]) {
    const headers = retryAfter === undefined ? {} : { "retry-after": retryAfter };
    assert.equal(retryAfterDelay(response(503, {}, headers), Date.UTC(2026, 6, 16, 12, 0, 0)), null);
  }
});

test("current PR head guard skips API access for non-PR events", async () => {
  let fetched = false;
  const writes = [];

  const result = await requireCurrentPrHead({
    env: guardEnvironment({
      GITHUB_EVENT_NAME: "push",
      "INPUT_GITHUB-TOKEN": "",
      "INPUT_PULL-REQUEST-NUMBER": "",
      "INPUT_EXPECTED-HEAD-SHA": ""
    }),
    appendFile: (_path, value) => writes.push(value),
    fetchImpl: async () => {
      fetched = true;
      return response(500, {});
    },
    log: () => {}
  });

  assert.equal(fetched, false);
  assert.deepEqual(result, { isCurrent: true, currentHeadSha: "" });
  assert.deepEqual(writes, [`is-current=true\n`, `current-head-sha=\n`]);
});

test("current PR head guard fails closed for invalid inputs and API responses", async (t) => {
  const cases = [
    {
      name: "missing token",
      env: { "INPUT_GITHUB-TOKEN": "" },
      fetchImpl: async () => response(200, { state: "open", head: { sha: expectedSha } }),
      error: /github-token is required/
    },
    {
      name: "invalid PR number",
      env: { "INPUT_PULL-REQUEST-NUMBER": "0" },
      fetchImpl: async () => response(200, { state: "open", head: { sha: expectedSha } }),
      error: /positive integer/
    },
    {
      name: "short event SHA",
      env: { "INPUT_EXPECTED-HEAD-SHA": "abc" },
      fetchImpl: async () => response(200, { state: "open", head: { sha: expectedSha } }),
      error: /full commit SHA/
    },
    {
      name: "partial PR inputs",
      env: { "INPUT_EXPECTED-HEAD-SHA": "" },
      fetchImpl: async () => response(200, { state: "open", head: { sha: expectedSha } }),
      error: /full commit SHA/
    },
    {
      name: "invalid repository",
      env: { GITHUB_REPOSITORY: "owner/repository/extra" },
      fetchImpl: async () => response(200, { state: "open", head: { sha: expectedSha } }),
      error: /owner\/name/
    },
    {
      name: "invalid repository character",
      env: { GITHUB_REPOSITORY: "owner/repository?ref=main" },
      fetchImpl: async () => response(200, { state: "open", head: { sha: expectedSha } }),
      error: /owner\/name/
    },
    {
      name: "invalid owner double hyphen",
      env: { GITHUB_REPOSITORY: "own--er/repository" },
      fetchImpl: async () => response(200, { state: "open", head: { sha: expectedSha } }),
      error: /owner\/name/
    },
    {
      name: "API failure",
      env: {},
      fetchImpl: async () => response(503, {}),
      error: /HTTP 503/
    },
    {
      name: "closed pull request",
      env: {},
      fetchImpl: async () => response(200, { state: "closed", head: { sha: expectedSha } }),
      error: /is not open/
    },
    {
      name: "malformed response",
      env: {},
      fetchImpl: async () => response(200, { state: "open", head: {} }),
      error: /did not contain a full head SHA/
    },
    {
      name: "invalid JSON response",
      env: {},
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("invalid JSON"); } }),
      error: /invalid JSON/
    },
    {
      name: "aborted request",
      env: {},
      fetchImpl: async () => { throw new DOMException("aborted", "AbortError"); },
      error: /aborted/
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await assert.rejects(
        requireCurrentPrHead({
          env: guardEnvironment(testCase.env),
          appendFile: () => {},
          fetchImpl: testCase.fetchImpl,
          sleep: async () => {},
          log: () => {}
        }),
        testCase.error
      );
    });
  }
});
