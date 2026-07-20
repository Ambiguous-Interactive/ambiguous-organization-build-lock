const assert = require("node:assert/strict");
const test = require("node:test");

const {
  requireCurrentPrHead,
  retryDelay,
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
  await assert.rejects(
    requireCurrentPrHead({
      env: guardEnvironment(),
      fetchImpl: async (_url, options) => {
        await new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      },
      signal: caller.signal,
      timeoutMs: 1,
      log: () => {}
    }),
    /timeout|aborted/i
  );
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

test("current PR head guard honors HTTP-date Retry-After values within its bounded delay", () => {
  const now = Date.UTC(2026, 6, 16, 12, 0, 0);
  const retryAt = new Date(now + 7_000).toUTCString();
  assert.equal(retryDelay(response(503, {}, { "retry-after": retryAt }), 1, now), 7_000);
  assert.equal(retryDelay(response(503, {}, { "retry-after": new Date(now + 60_000).toUTCString() }), 1, now), 10_000);
});

test("current PR head guard backs off when Retry-After is absent or invalid", () => {
  for (const retryAfter of [undefined, "", "not-a-delay", "-1"]) {
    const headers = retryAfter === undefined ? {} : { "retry-after": retryAfter };
    assert.equal(retryDelay(response(503, {}, headers), 1), 250);
    assert.equal(retryDelay(response(503, {}, headers), 2), 500);
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
