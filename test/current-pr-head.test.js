const assert = require("node:assert/strict");
const test = require("node:test");

const { requireCurrentPrHead } = require("../.github/dist/require-current-pr-head.js");

const expectedSha = "a".repeat(40);
const newerSha = "b".repeat(40);

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

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
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

test("current PR head guard skips API access for non-PR events", async () => {
  let fetched = false;
  const writes = [];

  const result = await requireCurrentPrHead({
    env: guardEnvironment({
      GITHUB_EVENT_NAME: "push",
      "INPUT_GITHUB-TOKEN": "",
      "INPUT_PULL-REQUEST-NUMBER": ""
    }),
    appendFile: (_path, value) => writes.push(value),
    fetchImpl: async () => {
      fetched = true;
      return response(500, {});
    },
    log: () => {}
  });

  assert.equal(fetched, false);
  assert.deepEqual(result, { isCurrent: true, currentHeadSha: expectedSha });
  assert.deepEqual(writes, [`is-current=true\n`, `current-head-sha=${expectedSha}\n`]);
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
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await assert.rejects(
        requireCurrentPrHead({
          env: guardEnvironment(testCase.env),
          appendFile: () => {},
          fetchImpl: testCase.fetchImpl,
          log: () => {}
        }),
        testCase.error
      );
    });
  }
});
