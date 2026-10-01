"use strict";

const test = require("node:test");

const {
  assert,
  fs,
  acquire,
  workflowCommandData,
  jsonResponse,
  withActionEnv,
  withImmediateTimers,
  withTempFile,
  readEnvironmentFile,
  withMockedFetch,
  SEMAPHORE_STATE_PATH,
  SEMAPHORE_CONFIG_PATH,
  semaphoreHolder,
  withRunner,
  semaphoreState,
  lifecycleReservation,
  lifecycleState,
  semaphoreConfig,
  base64Content,
  semaphoreActionEnv,
} = require("./build-lock-support.js");

test("workflow error commands escape percent sequences and collapse line breaks", () => {
  assert.equal(
    workflowCommandData("source%0Ainjected\r\n::error::second"),
    "source%250Ainjected ::error::second"
  );
});

test("environment file parser fails closed on malformed output lines", async () => {
  await withTempFile(async (file) => {
    fs.writeFileSync(file, "valid=value\nmissing-equals\n", "utf8");

    assert.throws(
      () => readEnvironmentFile(file),
      new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:2 must be NAME=VALUE`)
    );
  });
});

test("acquire removes its queued request when the PR is superseded during the FIFO wait", async () => {
  const expectedHead = "a".repeat(40);
  const newerHead = "b".repeat(40);
  const waitingHolder = semaphoreHolder("other/repo", "999", "editmode");
  let state = semaphoreState([waitingHolder]);
  let stateReads = 0;
  let prReads = 0;
  let stateWrites = 0;

  await withTempFile(async (outputFile) => {
    await withActionEnv(
      { ...semaphoreActionEnv, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: outputFile },
      async () => {
        await withImmediateTimers(async () => {
          await withMockedFetch(async (url, options = {}) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/repos/owner/repo/pulls/77") {
              prReads++;
              return jsonResponse(200, {
                state: "open",
                head: { sha: prReads === 1 ? expectedHead : newerHead }
              });
            }
            if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
              return jsonResponse(200, { object: { sha: "branch" } });
            }
            if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
              return base64Content({ maxHolders: 1 }, "cfg");
            }
            if (parsed.pathname === SEMAPHORE_STATE_PATH) {
              if (options.method === "PUT") {
                state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
                stateWrites++;
                return jsonResponse(200, { content: { sha: `state-${stateWrites}` } });
              }
              stateReads++;
              if (stateReads === 2) {
                state = semaphoreState([], state.queue);
              }
              return base64Content(state, `state-read-${stateReads}`);
            }
            return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
          }, async () => {
            await assert.rejects(
              () => acquire(semaphoreConfig({
                githubToken: "github-token",
                pullRequestNumber: "77",
                expectedHeadSha: expectedHead
              })),
              new RegExp(`Stale pull request run for ${expectedHead}.*${newerHead}`)
            );
          });
        });
      }
    );

    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs.acquired, "false");
    assert.equal(outputs["admission-result"], "superseded");
  });

  assert.equal(prReads, 2, "PR identity must be checked at entry and again before admission");
  assert.ok(stateWrites >= 2, "the queued request and its cleanup must both be persisted");
  assert.deepEqual(state.holders, []);
  assert.deepEqual(state.queue, []);
});

test("acquire periodically removes a superseded PR while capacity remains occupied", async () => {
  const originalNow = Date.now;
  const expectedHead = "1".repeat(40);
  const newerHead = "2".repeat(40);
  const waitingHolder = semaphoreHolder("other/repo", "999", "editmode");
  let state = semaphoreState([waitingHolder]);
  let fakeNow = 1_000;
  let prReads = 0;
  let stateWrites = 0;
  Date.now = () => fakeNow;

  try {
    await withTempFile(async (outputFile) => {
      await withActionEnv(
        { ...semaphoreActionEnv, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: outputFile },
        async () => {
          await withImmediateTimers(async () => {
            await withMockedFetch(async (url, options = {}) => {
              const parsed = new URL(url);
              if (parsed.pathname === "/repos/owner/repo/pulls/78") {
                prReads++;
                return jsonResponse(200, {
                  state: "open",
                  head: { sha: prReads === 1 ? expectedHead : newerHead }
                });
              }
              if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
                return jsonResponse(200, { object: { sha: "branch" } });
              }
              if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
                return base64Content({ maxHolders: 1 }, "cfg");
              }
              if (parsed.pathname === SEMAPHORE_STATE_PATH) {
                if (options.method === "PUT") {
                  state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
                  stateWrites++;
                  if (stateWrites === 1) fakeNow += 61_000;
                  return jsonResponse(200, { content: { sha: `state-${stateWrites}` } });
                }
                return base64Content(state, `state-read-${stateWrites}`);
              }
              return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
            }, async () => {
              await assert.rejects(
                () => acquire(semaphoreConfig({
                  githubToken: "github-token",
                  pullRequestNumber: "78",
                  expectedHeadSha: expectedHead,
                  timeoutMinutes: 10
                })),
                new RegExp(`Stale pull request run for ${expectedHead}.*${newerHead}`)
              );
            });
          });
        }
      );
      assert.equal(readEnvironmentFile(outputFile)["admission-result"], "superseded");
    });
  } finally {
    Date.now = originalNow;
  }

  assert.equal(prReads, 2);
  assert.equal(stateWrites, 2);
  assert.equal(state.holders[0].holderId, waitingHolder.holderId);
  assert.deepEqual(state.queue, []);
});

test("periodic PR authorization failure is terminal and cleans FIFO without lock-auth grace", async () => {
  const originalNow = Date.now;
  const expectedHead = "7".repeat(40);
  let fakeNow = 1_000;
  let prReads = 0;
  let stateWrites = 0;
  let state = semaphoreState([semaphoreHolder("other/repo", "999", "editmode")]);
  Date.now = () => fakeNow;
  try {
    await withTempFile(async (outputFile) => {
      await withActionEnv(
        { ...semaphoreActionEnv, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: outputFile },
        async () => {
          await withImmediateTimers(async () => {
            await withMockedFetch(async (url, options = {}) => {
              const parsed = new URL(url);
              if (parsed.pathname === "/repos/owner/repo/pulls/102") {
                prReads++;
                return prReads === 1
                  ? jsonResponse(200, { state: "open", head: { sha: expectedHead } })
                  : jsonResponse(401, { message: "Bad credentials" });
              }
              if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
                return jsonResponse(200, { object: { sha: "branch" } });
              }
              if (parsed.pathname === SEMAPHORE_CONFIG_PATH) return base64Content({ maxHolders: 1 }, "cfg");
              if (parsed.pathname === SEMAPHORE_STATE_PATH) {
                if (options.method === "PUT") {
                  state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
                  stateWrites++;
                  if (stateWrites === 1) fakeNow += 61_000;
                  return jsonResponse(200, { content: { sha: `write-${stateWrites}` } });
                }
                return base64Content(state, `read-${stateWrites}`);
              }
              return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
            }, () => assert.rejects(
              () => acquire(semaphoreConfig({
                githubToken: "github-token",
                pullRequestNumber: "102",
                expectedHeadSha: expectedHead,
                timeoutMinutes: 10
              })),
              /Pull request head validation failed.*HTTP 401/i
            ));
          });
        }
      );
      assert.equal(readEnvironmentFile(outputFile)["admission-result"], "pr-head-check-failed");
    });
  } finally {
    Date.now = originalNow;
  }
  assert.equal(prReads, 2, "the lock credential's 401 grace loop must not retry a PR authorization failure");
  assert.equal(stateWrites, 2);
  assert.deepEqual(state.queue, []);
});

test("acquire reports a distinct terminal failure when supersession cleanup cannot be confirmed", async () => {
  const originalNow = Date.now;
  const expectedHead = "3".repeat(40);
  const newerHead = "4".repeat(40);
  let state = semaphoreState([semaphoreHolder("other/repo", "999", "editmode")]);
  let fakeNow = 1_000;
  let prReads = 0;
  let acceptedWrites = 0;
  let rejectedCleanupWrites = 0;
  Date.now = () => fakeNow;

  try {
    await withTempFile(async (outputFile) => {
      await withActionEnv(
        { ...semaphoreActionEnv, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: outputFile },
        async () => {
          await withImmediateTimers(async () => {
            await withMockedFetch(async (url, options = {}) => {
              const parsed = new URL(url);
              if (parsed.pathname === "/repos/owner/repo/pulls/79") {
                prReads++;
                return jsonResponse(200, {
                  state: "open",
                  head: { sha: prReads === 1 ? expectedHead : newerHead }
                });
              }
              if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
                return jsonResponse(200, { object: { sha: "branch" } });
              }
              if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
                return base64Content({ maxHolders: 1 }, "cfg");
              }
              if (parsed.pathname === SEMAPHORE_STATE_PATH) {
                if (options.method === "PUT") {
                  if (acceptedWrites === 0) {
                    const body = JSON.parse(options.body);
                    state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
                    acceptedWrites++;
                    fakeNow += 61_000;
                    return jsonResponse(200, { content: { sha: "queued" } });
                  }
                  rejectedCleanupWrites++;
                  return jsonResponse(409, { message: "cleanup CAS conflict" });
                }
                return base64Content(state, `state-${rejectedCleanupWrites}`);
              }
              return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
            }, async () => {
              await assert.rejects(
                () => acquire(semaphoreConfig({
                  githubToken: "github-token",
                  pullRequestNumber: "79",
                  expectedHeadSha: expectedHead,
                  timeoutMinutes: 10
                })),
                /superseded.*cleanup could not be confirmed/i
              );
            });
          });
        }
      );

      const outputs = readEnvironmentFile(outputFile);
      assert.equal(outputs.acquired, "false");
      assert.equal(outputs["admission-result"], "pr-head-cleanup-failed");
      assert.equal(outputs["state-sha"], "");
    });
  } finally {
    Date.now = originalNow;
  }

  assert.equal(rejectedCleanupWrites, 3);
  assert.equal(state.queue.length, 1, "unconfirmed cleanup must not be reported as queue removal");
});

test("acquire retracts a just-admitted stale PR without creating a lifecycle reservation", async () => {
  const expectedHead = "c".repeat(40);
  const newerHead = "d".repeat(40);
  let state = lifecycleState();
  let prReads = 0;
  let stateWrites = 0;

  await withTempFile(async (outputFile) => {
    await withActionEnv(
      { ...semaphoreActionEnv, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: outputFile },
      async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/owner/repo/pulls/88") {
            prReads++;
            return jsonResponse(200, {
              state: "open",
              head: { sha: prReads < 3 ? expectedHead : newerHead }
            });
          }
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch" } });
          }
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return base64Content({
              maxHolders: 1,
              runnerSerialization: true,
              resourceLifecycle: true,
              releaseCooldownSeconds: 360
            }, "cfg");
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
              stateWrites++;
              return jsonResponse(200, { content: { sha: `state-${stateWrites}` } });
            }
            return base64Content(state, `state-read-${stateWrites}`);
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await assert.rejects(
            () => acquire(semaphoreConfig({
              runnerId: "runner-a",
              githubToken: "github-token",
              pullRequestNumber: "88",
              expectedHeadSha: expectedHead
            })),
            new RegExp(`Stale pull request run for ${expectedHead}.*${newerHead}`)
          );
        });
      }
    );

    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs.acquired, "false");
    assert.equal(outputs["admission-result"], "superseded");
    assert.equal(outputs["state-sha"], "state-2");
  });

  assert.equal(prReads, 3, "entry, pre-CAS, and post-verification checks must all run");
  assert.equal(stateWrites, 2, "admission and exact retraction must each use one CAS write");
  assert.deepEqual(state.holders, []);
  assert.deepEqual(state.queue, []);
  assert.deepEqual(state.reservations, [], "known pre-activation retraction must not reduce capacity");
});

test("PR identity lookup failure happens before lock-state access", async () => {
  let lockStateAccesses = 0;
  await withTempFile(async (outputFile) => {
    await withActionEnv(
      { ...semaphoreActionEnv, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: outputFile },
      async () => {
        await withMockedFetch(async (url) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/owner/repo/pulls/99") {
            return jsonResponse(403, { message: "Resource not accessible by integration" });
          }
          if (parsed.pathname.includes("/repos/o/r/")) lockStateAccesses++;
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await assert.rejects(
            () => acquire(semaphoreConfig({
              githubToken: "github-token",
              pullRequestNumber: "99",
              expectedHeadSha: "e".repeat(40)
            })),
            /pull request lookup failed with HTTP 403/i
          );
        });
      }
    );

    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs.acquired, "false");
    assert.equal(outputs["admission-result"], "pr-head-check-failed");
  });
  assert.equal(lockStateAccesses, 0);
});

test("PR lookup timeout is terminal validation failure, not acquire cancellation", async () => {
  let lockStateAccesses = 0;
  const originalExit = process.exit;
  process.exit = (code) => {
    throw new Error(`unexpected process.exit(${code})`);
  };
  try {
    await withTempFile(async (outputFile) => {
      await withActionEnv(
        { ...semaphoreActionEnv, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: outputFile },
        async () => {
          await withMockedFetch(async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/repos/owner/repo/pulls/100") {
              const error = new Error("pull request lookup timed out");
              error.name = "TimeoutError";
              throw error;
            }
            lockStateAccesses++;
            return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
          }, () => assert.rejects(
            () => acquire(semaphoreConfig({
              githubToken: "github-token",
              pullRequestNumber: "100",
              expectedHeadSha: "f".repeat(40)
            })),
            /Pull request head validation failed.*timed out/i
          ));
        }
      );
      assert.equal(readEnvironmentFile(outputFile)["admission-result"], "pr-head-check-failed");
    });
  } finally {
    process.exit = originalExit;
  }
  assert.equal(lockStateAccesses, 0);
});

test("stale PR cleanup preserves admission provenance", async (t) => {
  const expectedHead = "5".repeat(40);
  const newerHead = "6".repeat(40);
  const currentHolder = withRunner(semaphoreHolder("owner/repo", "123", "playmode"), "runner-a");
  const priorHolder = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-a");
  const priorQuarantine = lifecycleReservation(priorHolder);
  const cases = [
    {
      name: "pre-existing holder remains conservatively quarantined",
      state: lifecycleState([currentHolder]),
      staleAfter: 1,
      expectedReservation: { holderId: currentHolder.holderId, state: "quarantine" }
    },
    {
      name: "same-runner recovery restores the original quarantine",
      state: lifecycleState([], [], [priorQuarantine]),
      staleAfter: 2,
      expectedReservation: priorQuarantine
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let state = structuredClone(testCase.state);
      let prReads = 0;
      await withTempFile(async (outputFile) => {
        await withActionEnv(
          { ...semaphoreActionEnv, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: outputFile },
          async () => {
            await withMockedFetch(async (url, options = {}) => {
              const parsed = new URL(url);
              if (parsed.pathname === "/repos/owner/repo/pulls/101") {
                prReads++;
                return jsonResponse(200, {
                  state: "open",
                  head: { sha: prReads <= testCase.staleAfter ? expectedHead : newerHead }
                });
              }
              if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
                return jsonResponse(200, { object: { sha: "branch" } });
              }
              if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
                return base64Content({
                  maxHolders: 1,
                  runnerSerialization: true,
                  resourceLifecycle: true,
                  releaseCooldownSeconds: 360
                }, "cfg");
              }
              if (parsed.pathname === SEMAPHORE_STATE_PATH) {
                if (options.method === "PUT") {
                  state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
                  return jsonResponse(200, { content: { sha: `write-${prReads}` } });
                }
                return base64Content(state, `read-${prReads}`);
              }
              return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
            }, () => assert.rejects(
              () => acquire(semaphoreConfig({
                runnerId: "runner-a",
                githubToken: "github-token",
                pullRequestNumber: "101",
                expectedHeadSha: expectedHead
              })),
              /Stale pull request run/
            ));
          }
        );
        assert.equal(readEnvironmentFile(outputFile)["admission-result"], "superseded");
      });
      assert.deepEqual(state.holders, []);
      assert.deepEqual(state.queue, []);
      assert.equal(state.reservations.length, 1);
      if (testCase.expectedReservation === priorQuarantine) {
        assert.deepEqual(state.reservations[0], priorQuarantine);
      } else {
        assert.equal(state.reservations[0].holderId, testCase.expectedReservation.holderId);
        assert.equal(state.reservations[0].state, testCase.expectedReservation.state);
      }
    });
  }
});

test("clean recovery CAS conflict cannot leak quarantine provenance into a later admission", async () => {
  const expectedHead = "8".repeat(40);
  const newerHead = "9".repeat(40);
  const prior = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-a");
  let state = lifecycleState([], [], [lifecycleReservation(prior)]);
  let prReads = 0;
  let stateReads = 0;
  let puts = 0;
  await withActionEnv({ ...semaphoreActionEnv, GITHUB_EVENT_NAME: "pull_request" }, async () => {
    await withImmediateTimers(async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/owner/repo/pulls/103") {
          prReads++;
          return jsonResponse(200, {
            state: "open",
            head: { sha: prReads <= 3 ? expectedHead : newerHead }
          });
        }
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch" } });
        }
        if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
          return base64Content({
            maxHolders: 1,
            runnerSerialization: true,
            resourceLifecycle: true,
            releaseCooldownSeconds: 360
          }, "cfg");
        }
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            puts++;
            if (puts === 1) return jsonResponse(409, { message: "clean recovery conflict" });
            state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: `write-${puts}` } });
          }
          stateReads++;
          if (stateReads === 2) state = lifecycleState();
          return base64Content(state, `read-${stateReads}`);
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, () => assert.rejects(
        () => acquire(semaphoreConfig({
          runnerId: "runner-a",
          githubToken: "github-token",
          pullRequestNumber: "103",
          expectedHeadSha: expectedHead
        })),
        /Stale pull request run/
      ));
    });
  });
  assert.equal(puts, 3, "clean conflict, later admission, and retraction must be distinct CAS attempts");
  assert.deepEqual(state.holders, []);
  assert.deepEqual(state.queue, []);
  assert.deepEqual(state.reservations, [], "the unrelated conflicted quarantine must not be resurrected");
});

test("PR lookup cancellation uses normal acquire cleanup without PR-failure outputs", async () => {
  const originalExit = process.exit;
  let exitCode = null;
  let state = semaphoreState([]);
  let stateReads = 0;
  process.exit = (code) => {
    exitCode = code;
  };

  try {
    await withTempFile(async (outputFile) => {
      await withActionEnv(
        { ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile },
        async () => {
          await withMockedFetch(async (url, options = {}) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/repos/owner/repo/pulls/104") {
              process.emit("SIGINT", "SIGINT");
              throw options.signal.reason;
            }
            if (parsed.pathname === SEMAPHORE_STATE_PATH) {
              stateReads++;
              if (options.method === "PUT") {
                state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
                return jsonResponse(200, { content: { sha: "cleanup" } });
              }
              return base64Content(state, `cleanup-read-${stateReads}`);
            }
            return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
          }, async (logs) => {
            await assert.rejects(
              () => acquire(semaphoreConfig({
                githubToken: "github-token",
                pullRequestNumber: "104",
                expectedHeadSha: "a".repeat(40)
              })),
              /Build lock acquire cancelled by SIGINT/
            );
            assert.doesNotMatch(logs.join("\n"), /Pull request head validation failed|pr-head-(?:check|cleanup)-failed/i);
          });
        }
      );

      assert.deepEqual(readEnvironmentFile(outputFile), {});
    });
  } finally {
    process.exit = originalExit;
  }

  assert.equal(exitCode, 130);
  assert.ok(stateReads >= 2, "normal cancellation cleanup must use its fresh cleanup signal");
  assert.deepEqual(state.queue, []);
});

test("PR cleanup cancellation uses normal acquire cleanup without PR-failure outputs", async (t) => {
  for (const testCase of [
    { name: "validation failure cleanup", response: () => jsonResponse(403, { message: "Forbidden" }) },
    { name: "stale-head cleanup", response: () => jsonResponse(200, { state: "open", head: { sha: "b".repeat(40) } }) }
  ]) {
    await t.test(testCase.name, async () => {
      const originalExit = process.exit;
      const originalNow = Date.now;
      const waitingHolder = semaphoreHolder("other/repo", "999", "editmode");
      let exitCode = null;
      let fakeNow = 1_000;
      let prReads = 0;
      let stateWrites = 0;
      let cancellationInjected = false;
      let state = semaphoreState([waitingHolder]);
      process.exit = (code) => {
        exitCode = code;
      };
      Date.now = () => fakeNow;

      try {
        await withTempFile(async (outputFile) => {
          await withActionEnv(
            { ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile },
            async () => {
              await withMockedFetch(async (url, options = {}) => {
                const parsed = new URL(url);
                if (parsed.pathname === "/repos/owner/repo/pulls/105") {
                  prReads++;
                  return prReads === 1
                    ? jsonResponse(200, { state: "open", head: { sha: "a".repeat(40) } })
                    : testCase.response();
                }
                if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
                  return jsonResponse(200, { object: { sha: "branch" } });
                }
                if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
                  return base64Content({ maxHolders: 1 }, "cfg");
                }
                if (parsed.pathname === SEMAPHORE_STATE_PATH) {
                  if (options.method === "PUT") {
                    state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
                    stateWrites++;
                    if (stateWrites === 1) fakeNow += 61_000;
                    return jsonResponse(200, { content: { sha: `write-${stateWrites}` } });
                  }
                  if (prReads >= 2 && !cancellationInjected) {
                    cancellationInjected = true;
                    process.emit("SIGINT", "SIGINT");
                    throw options.signal.reason;
                  }
                  return base64Content(state, `read-${stateWrites}`);
                }
                return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
              }, async (logs) => {
                await assert.rejects(
                  () => acquire(semaphoreConfig({
                    githubToken: "github-token",
                    pullRequestNumber: "105",
                    expectedHeadSha: "a".repeat(40),
                    pollSeconds: 0,
                    timeoutMinutes: 10
                  })),
                  /Build lock acquire cancelled by SIGINT/
                );
                assert.doesNotMatch(
                  logs.join("\n"),
                  /Pull request head validation failed|superseded.*cleanup could not be confirmed|pr-head-(?:check|cleanup)-failed/i
                );
              });
            }
          );

          assert.deepEqual(readEnvironmentFile(outputFile), {});
        });
      } finally {
        Date.now = originalNow;
        process.exit = originalExit;
      }

      assert.equal(exitCode, 130);
      assert.equal(cancellationInjected, true);
      assert.equal(stateWrites, 2, "queue insertion and normal signal cleanup must be the only persisted writes");
      assert.equal(state.holders[0].holderId, waitingHolder.holderId);
      assert.deepEqual(state.queue, []);
    });
  }
});
