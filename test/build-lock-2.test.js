"use strict";

const test = require("node:test");

const {
  assert,
  childProcess,
  fs,
  path,
  acquire,
  acquirePollDelayMs,
  boundedRetryDelayMs,
  collectPeerTimeline,
  dedupeQueueEntries,
  evaluateStale,
  normalizeState,
  parseReleaseReport,
  peerTimelineEvents,
  postCleanup,
  queueEntryIsFinished,
  readLockConfig,
  readState,
  release,
  reap,
  reapDeadlineBudgets,
  resolveCurrentJob,
  resolveReleaseReport,
  selectEligibleQueueEntries,
  testAppPrivateKey,
  emptyState,
  jsonResponse,
  authorizedConsumerEnv,
  acquireOutputNames,
  releaseOutputNames,
  reapOutputNames,
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
  withRunner,
  semaphoreQueueEntry,
  semaphoreState,
  lifecycleReservation,
  lifecycleState,
  semaphoreConfig,
  base64Content,
  semaphoreActionEnv,
  accountIncident,
  assertIncidentRecoveryWorkflowContract,
  accountHealthState,
  accountHealthFetchStore,
  timelineHolder,
  timelineSnapshot,
} = require("./build-lock-support.js");


// Degrading the branch check must never become a false success: with the branch
// unverified, an unreadable lock-state file is indistinguishable from a missing
// branch, so "nothing to release" is not provable.
test("release refuses an unprovable noop when the state branch was never verified", async () => {
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
            await withMockedFetch(async (url) => {
              const parsed = new URL(url);
              if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
                return jsonResponse(503, { message: "No server is currently available." });
              }
              // A missing branch makes every content read a 404, which normalizes
              // to empty state and would otherwise read as "already free".
              return jsonResponse(404, { message: "Not Found" });
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
                    configPath: "locks/wallstop-organization-builds.config.json",
                    resourceReport: { cleanupStatus: "confirmed", health: "healthy", reason: "cleanup-confirmed" }
                  }),
                /Could not confirm the release of wallstop-organization-builds .*lock-state branch could not be verified/
              );
            });
          }
        );
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, releaseOutputNames);
    assert.equal(outputs["cleanup-result"], "lock-release-unreachable");
    assert.equal(outputs.released, "false");
  });
});


// Compare-and-swap exhaustion means reads and writes succeeded but lost a
// contention race, possibly after an ambiguous accepted write. It is the opposite
// of an unreachable file, so it must not claim the record is merely missing.
test("release does not report contention as an unreachable lock-state write", async () => {
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
            if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
              return jsonResponse(200, { object: { sha: "branch-sha" } });
            }
            if (parsed.pathname === "/repos/o/r/contents/locks/wallstop-organization-builds.json") {
              if (options.method === "PUT") {
                return jsonResponse(409, { message: "sha does not match" });
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
                  resourceReport: { cleanupStatus: "confirmed", health: "healthy", reason: "cleanup-confirmed" }
                }),
              /Failed to clean up wallstop-organization-builds after repeated CAS conflicts\./
            );
          });
        }
      );
    });

    assert.deepEqual(readEnvironmentFile(outputFile), {});
  });
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


test("scheduled reap checkpoints stale-holder recovery before inspecting queued runs", async () => {
  const staleHolder = withRunner(semaphoreHolder("holder/repo", "123", "editmode"), "runner-a");
  const queued = withRunner(semaphoreQueueEntry("queue/repo", "888", "playmode"), "runner-b");
  let state = lifecycleState([staleHolder], [queued]);
  const operations = [];

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            operations.push("write");
            state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "state-after-holder-reap" } });
          }
          return base64Content(state, "state-before-holder-reap");
        }
        if (parsed.pathname === "/repos/holder/repo/actions/runs/123") {
          operations.push("holder-status");
          return jsonResponse(200, { status: "completed", conclusion: "success", run_attempt: 1 });
        }
        if (parsed.pathname === "/repos/queue/repo/actions/runs/888") {
          operations.push("queue-status");
          return jsonResponse(200, { status: "completed", conclusion: "cancelled", run_attempt: 1 });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await reap(semaphoreConfig());
      });
    });
  });

  assert.deepEqual(
    operations,
    ["holder-status", "write"],
    "capacity-critical stale ownership must be persisted before routine queue traversal"
  );
  assert.deepEqual(state.holders, []);
  assert.equal(state.reservations.length, 1);
  assert.equal(state.reservations[0].state, "quarantine");
  assert.deepEqual(state.queue, [queued], "unscanned queue entries remain in their original FIFO order");
});


test("scheduled reap reserves bounded checkpoint time before the workflow timeout", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "../.github/workflows/reap-stale-locks.yml"),
    "utf8"
  );
  const timeoutMatch = workflow.match(/^\s+timeout-minutes:\s+([0-9]+)\s*$/m);
  assert.ok(timeoutMatch, "the scheduled reaper must declare a numeric job timeout");
  const workflowBudgetMs = Number(timeoutMatch[1]) * 60 * 1000;
  const budgets = reapDeadlineBudgets();

  assert.deepEqual(budgets, { scanMs: 8 * 60 * 1000, totalMs: 9 * 60 * 1000 });
  assert.ok(budgets.scanMs < budgets.totalMs, "status scanning must stop before checkpoint writes");
  assert.ok(budgets.totalMs < workflowBudgetMs, "the action must stop before GitHub kills the job");
});


test("scheduled reap checkpoints a proven stale holder before later holder scans", async () => {
  const completed = withRunner(semaphoreHolder("holder/repo", "201", "completed"), "runner-a");
  const ambiguous = withRunner(semaphoreHolder("holder/repo", "202", "ambiguous"), "runner-b");
  const queued = withRunner(semaphoreQueueEntry("queue/repo", "203", "queued"), "runner-c");
  let state = lifecycleState([completed, ambiguous], [queued]);
  const operations = [];
  const scanController = new AbortController();

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            operations.push("write");
            state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "state-after-holder-checkpoint" } });
          }
          return base64Content(state, "state-before-holder-checkpoint");
        }
        if (parsed.pathname === "/repos/holder/repo/actions/runs/201") {
          operations.push("completed-holder");
          return jsonResponse(200, { status: "completed", conclusion: "success", run_attempt: 1 });
        }
        if (parsed.pathname === "/repos/holder/repo/actions/runs/202") {
          operations.push("ambiguous-holder");
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
            scanController.abort(new DOMException("reaper holder budget elapsed", "TimeoutError"));
          });
        }
        if (parsed.pathname === "/repos/queue/repo/actions/runs/203") {
          operations.push("queue-status");
          return jsonResponse(200, { status: "completed", conclusion: "success", run_attempt: 1 });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await reap(semaphoreConfig(), {
          scanSignal: scanController.signal,
          writeSignal: AbortSignal.timeout(1_000)
        });
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs.reaped, "true");
    assert.equal(outputs["state-sha"], "state-after-holder-checkpoint");
  });

  assert.deepEqual(operations, ["completed-holder", "write"]);
  assert.deepEqual(state.holders, [ambiguous]);
  assert.equal(state.reservations.length, 1);
  assert.equal(state.reservations[0].holderId, completed.holderId);
  assert.deepEqual(state.queue, [queued]);
});


test("scheduled reap checkpoints proven queue entries before reporting an incomplete scan", async () => {
  const completed = withRunner(semaphoreQueueEntry("queue/repo", "101", "completed"), "runner-a");
  const ambiguous = withRunner(semaphoreQueueEntry("queue/repo", "102", "ambiguous"), "runner-b");
  const unscanned = withRunner(semaphoreQueueEntry("queue/repo", "103", "unscanned"), "runner-c");
  let state = lifecycleState([], [completed, ambiguous, unscanned]);
  const operations = [];
  const scanController = new AbortController();

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            operations.push("write");
            assert.notEqual(options.signal, scanController.signal, "checkpoint writes retain a separate deadline budget");
            state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "state-after-queue-checkpoint" } });
          }
          return base64Content(state, "state-before-queue-checkpoint");
        }
        if (parsed.pathname === "/repos/queue/repo/actions/runs/101") {
          operations.push("completed-status");
          assert.equal(options.signal, scanController.signal);
          return jsonResponse(200, { status: "completed", conclusion: "success", run_attempt: 1 });
        }
        if (parsed.pathname === "/repos/queue/repo/actions/runs/102") {
          operations.push("ambiguous-status");
          assert.equal(options.signal, scanController.signal);
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
            scanController.abort(new DOMException("reaper scan budget elapsed", "TimeoutError"));
          });
        }
        if (parsed.pathname === "/repos/queue/repo/actions/runs/103") {
          operations.push("unscanned-status");
          return jsonResponse(200, { status: "completed", conclusion: "success", run_attempt: 1 });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await assert.rejects(
          () => reap(semaphoreConfig(), {
            scanSignal: scanController.signal,
            writeSignal: AbortSignal.timeout(1_000)
          }),
          /queue scan after checkpoint deadline elapsed/
        );
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs.reaped, "true");
    assert.equal(outputs["state-sha"], "state-after-queue-checkpoint");
  });

  assert.deepEqual(operations, ["completed-status", "ambiguous-status", "write"]);
  assert.deepEqual(
    state.queue,
    [ambiguous, unscanned],
    "the timed-out identity and every unscanned identity remain in original FIFO order"
  );
});


test("scheduled reap batches multiple completed queue entries before a live FIFO tail", async () => {
  const completedFirst = withRunner(semaphoreQueueEntry("queue/repo", "111", "first"), "runner-a");
  const completedSecond = withRunner(semaphoreQueueEntry("queue/repo", "112", "second"), "runner-b");
  const liveTail = withRunner(semaphoreQueueEntry("queue/repo", "113", "live"), "runner-c");
  let state = lifecycleState([], [completedFirst, completedSecond, liveTail]);
  const operations = [];

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            operations.push("write");
            state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "state-after-batch" } });
          }
          return base64Content(state, "state-before-batch");
        }
        const statusByPath = new Map([
          ["/repos/queue/repo/actions/runs/111", ["first-status", "completed"]],
          ["/repos/queue/repo/actions/runs/112", ["second-status", "completed"]],
          ["/repos/queue/repo/actions/runs/113", ["tail-status", "in_progress"]]
        ]);
        if (statusByPath.has(parsed.pathname)) {
          const [operation, status] = statusByPath.get(parsed.pathname);
          operations.push(operation);
          return jsonResponse(200, {
            status,
            conclusion: status === "completed" ? "success" : null,
            run_attempt: 1
          });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, () => reap(semaphoreConfig()));
    });

    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs.reaped, "true");
    assert.equal(outputs["state-sha"], "state-after-batch");
  });

  assert.deepEqual(operations, ["first-status", "second-status", "tail-status", "write"]);
  assert.deepEqual(state.queue, [liveTail]);
});


test("scheduled reap refreshes a conflicted deadline checkpoint under the live write budget", async () => {
  const completed = withRunner(semaphoreQueueEntry("queue/repo", "301", "completed"), "runner-a");
  const waiting = withRunner(semaphoreQueueEntry("queue/repo", "302", "waiting"), "runner-b");
  const refreshedWaiting = { ...waiting, runAttempt: "2" };
  const concurrent = withRunner(semaphoreQueueEntry("queue/repo", "303", "concurrent"), "runner-c");
  let state = lifecycleState([], [completed, waiting]);
  let stateSha = "state-before-conflict";
  let stateReads = 0;
  let stateWrites = 0;
  const scanController = new AbortController();
  const writeController = new AbortController();
  const operations = [];

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withImmediateTimers(async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method !== "PUT") {
              stateReads++;
              operations.push(`get-${stateReads}`);
              assert.equal(
                options.signal,
                stateReads === 1 ? scanController.signal : writeController.signal,
                "the conflict refresh must stop using the elapsed scan budget"
              );
              return base64Content(state, stateSha);
            }
            stateWrites++;
            operations.push(`put-${stateWrites}`);
            assert.equal(options.signal, writeController.signal);
            const body = JSON.parse(options.body);
            if (stateWrites === 1) {
              assert.equal(body.sha, "state-before-conflict");
              state = lifecycleState([], [completed, refreshedWaiting, concurrent]);
              stateSha = "state-after-concurrent-change";
              return jsonResponse(409, { message: "sha does not match" });
            }
            assert.equal(body.sha, "state-after-concurrent-change");
            state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
            stateSha = "state-after-checkpoint";
            return jsonResponse(200, { content: { sha: stateSha } });
          }
          if (parsed.pathname === "/repos/queue/repo/actions/runs/301") {
            operations.push("completed-status");
            assert.equal(options.signal, scanController.signal);
            scanController.abort(new DOMException("reaper scan budget elapsed", "TimeoutError"));
            return jsonResponse(200, { status: "completed", conclusion: "success", run_attempt: 1 });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await assert.rejects(
            () => reap(semaphoreConfig(), {
              scanSignal: scanController.signal,
              writeSignal: writeController.signal
            }),
            /queue scan after checkpoint deadline elapsed/
          );
        });
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs.reaped, "true");
    assert.equal(outputs["state-sha"], "state-after-checkpoint");
  });

  assert.deepEqual(operations, ["get-1", "completed-status", "put-1", "get-2", "put-2"]);
  assert.deepEqual(
    state.queue,
    [refreshedWaiting, concurrent],
    "the retry removes only the proven exact attempt while preserving concurrent FIFO state"
  );
});


test("scheduled reap preserves ambiguous evidence from an accepted retry checkpoint", async () => {
  const completed = withRunner(semaphoreQueueEntry("queue/repo", "305", "completed"), "runner-a");
  const concurrent = withRunner(semaphoreQueueEntry("queue/repo", "306", "concurrent"), "runner-b");
  let state = lifecycleState([], [completed]);
  let stateSha = "state-before-conflict";
  let stateReads = 0;
  let putRequests = 0;
  const operations = [];

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withImmediateTimers(async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method !== "PUT") {
              stateReads++;
              operations.push(`get-${stateReads}`);
              return base64Content(state, stateSha);
            }
            putRequests++;
            operations.push(`put-${putRequests}`);
            if (putRequests === 1) {
              return jsonResponse(409, { message: "initial sha does not match" });
            }
            if (putRequests === 2) {
              state = lifecycleState([], [concurrent]);
              stateSha = "state-after-accepted-retry";
              return jsonResponse(500, { message: "accepted but response failed" });
            }
            return jsonResponse(409, { message: "retry sha does not match" });
          }
          if (parsed.pathname === "/repos/queue/repo/actions/runs/305") {
            operations.push("completed-status");
            return jsonResponse(200, { status: "completed", conclusion: "success", run_attempt: 1 });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, () => reap(semaphoreConfig()));
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs.reaped, "true", "accepted retry evidence must survive the helper conflict");
    assert.equal(outputs["state-sha"], "state-after-accepted-retry");
  });

  assert.deepEqual(
    operations,
    ["get-1", "completed-status", "put-1", "get-2", "put-2", "put-3", "get-3"]
  );
  assert.deepEqual(state.queue, [concurrent]);
});


test("scheduled reap does not delete a queue entry whose proven version changed after conflict", async () => {
  const completed = withRunner(semaphoreQueueEntry("queue/repo", "304", "completed"), "runner-a");
  const refreshed = { ...completed, queuedAt: "2026-06-06T00:02:00.000Z" };
  let state = lifecycleState([], [completed]);
  let stateSha = "state-before-conflict";
  let puts = 0;
  const operations = [];

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withImmediateTimers(async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              puts++;
              operations.push("put");
              state = lifecycleState([], [refreshed]);
              stateSha = "state-after-refresh";
              return jsonResponse(409, { message: "sha does not match" });
            }
            operations.push("get");
            return base64Content(state, stateSha);
          }
          if (parsed.pathname === "/repos/queue/repo/actions/runs/304") {
            operations.push("completed-status");
            return jsonResponse(200, { status: "completed", conclusion: "success", run_attempt: 1 });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, () => reap(semaphoreConfig()));
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs.reaped, "false");
    assert.equal(outputs["state-sha"], "state-after-refresh");
  });

  assert.equal(puts, 1, "changed proof provenance must prevent a second mutation attempt");
  assert.deepEqual(operations, ["get", "completed-status", "put", "get"]);
  assert.deepEqual(state.queue, [refreshed]);
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


test("scheduled reap auto-recovers a stale quarantine (schema 5, terminal run) to a cooldown", async () => {
  // A quarantine tied to an ephemeral GitHub-hosted runner can never be
  // same-runner-reclaimed (issue #61). At schema 5 -- where a leaked seat's 20111
  // latches a global incident as the backstop -- the reaper converts a terminal-run,
  // lease-aged quarantine to a cooldown so capacity is not pinned indefinitely.
  const owner = withRunner(
    semaphoreHolder("owner/repo", "999", "unitypackage-smoke"),
    "GitHub Actions 1000111524"
  );
  const quarantine = lifecycleReservation(owner, {
    reservationId: "stuck-quarantine",
    state: "quarantine",
    reason: "return-missing-positive-evidence",
    createdAt: "2026-06-06T00:01:00.000Z"
  });
  let state = accountHealthState([], [], [quarantine]);

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
          return base64Content(
            { maxHolders: 2, runnerSerialization: true, resourceLifecycle: true, accountHealth: true, releaseCooldownSeconds: 1 },
            "cfg"
          );
        }
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "reaped-sha" } });
          }
          return base64Content(state, "state-before-reap");
        }
        if (parsed.pathname === "/repos/owner/repo/actions/runs/999") {
          return jsonResponse(200, { status: "completed", conclusion: "success" });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await reap(semaphoreConfig());
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, reapOutputNames);
    assert.equal(outputs.reaped, "true");
    assert.equal(outputs["state-sha"], "reaped-sha");
  });

  assert.equal(state.reservations.length, 1);
  assert.equal(state.reservations[0].state, "cooldown");
  assert.ok(state.reservations[0].availableAt);
  assert.match(state.reservations[0].reason, /auto-recovered stale quarantine/);
});


test("scheduled reap keeps quarantine when an incident appears during checkpoint conflict", async () => {
  const owner = withRunner(
    semaphoreHolder("owner/repo", "998", "unitypackage-smoke"),
    "GitHub Actions 1000111524"
  );
  const quarantine = lifecycleReservation(owner, {
    reservationId: "incident-race-quarantine",
    state: "quarantine",
    reason: "return-missing-positive-evidence",
    createdAt: "2026-06-06T00:01:00.000Z"
  });
  const concurrentIncident = accountIncident({
    runId: "777",
    runUrl: "https://github.com/owner/repo/actions/runs/777",
    runnerId: "runner-incident"
  });
  let state = accountHealthState([], [], [quarantine]);
  let stateSha = "state-before-conflict";
  let puts = 0;

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withImmediateTimers(async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return base64Content(
              {
                maxHolders: 2,
                runnerSerialization: true,
                resourceLifecycle: true,
                accountHealth: true,
                releaseCooldownSeconds: 1
              },
              "cfg"
            );
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              puts++;
              state = accountHealthState([], [], [quarantine], concurrentIncident);
              stateSha = "state-with-incident";
              return jsonResponse(409, { message: "sha does not match" });
            }
            return base64Content(state, stateSha);
          }
          if (parsed.pathname === "/repos/owner/repo/actions/runs/998") {
            return jsonResponse(200, { status: "completed", conclusion: "success", run_attempt: 1 });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, () => reap(semaphoreConfig()));
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs.reaped, "false");
    assert.equal(outputs["state-sha"], "state-with-incident");
  });

  assert.equal(puts, 1, "the fresh incident must veto quarantine recovery before a second PUT");
  assert.deepEqual(state.activeIncident, concurrentIncident);
  assert.equal(state.reservations[0].state, "quarantine");
  assert.equal(state.reservations[0].reason, "return-missing-positive-evidence");
});


test("scheduled reap releases a stale quarantine immediately when the cooldown is 0", async () => {
  const owner = withRunner(
    semaphoreHolder("owner/repo", "999", "unitypackage-smoke"),
    "GitHub Actions 1000111524"
  );
  const quarantine = lifecycleReservation(owner, {
    reservationId: "stuck-quarantine",
    state: "quarantine",
    reason: "return-missing-positive-evidence",
    createdAt: "2026-06-06T00:01:00.000Z"
  });
  let state = accountHealthState([], [], [quarantine]);

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
          return base64Content(
            { maxHolders: 2, runnerSerialization: true, resourceLifecycle: true, accountHealth: true, releaseCooldownSeconds: 0 },
            "cfg"
          );
        }
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "reaped-sha" } });
          }
          return base64Content(state, "state-before-reap");
        }
        if (parsed.pathname === "/repos/owner/repo/actions/runs/999") {
          return jsonResponse(200, { status: "completed", conclusion: "success" });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await reap(semaphoreConfig());
      });
    });

    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs.reaped, "true");
  });

  // A zero cooldown mirrors the release path: the reservation is dropped, not left as
  // a zero-length cooldown -- the slot is free immediately.
  assert.equal(state.reservations.length, 0);
});


// The reaper must NOT auto-recover a quarantine outside the narrow safe window.
for (const testCase of [
  { name: "the lock is only schema 4 (no 20111 incident backstop)", schema: 4, createdAt: "2026-06-06T00:01:00.000Z", run: { status: "completed", conclusion: "success" } },
  { name: "the owning run is still active", schema: 5, createdAt: "2026-06-06T00:01:00.000Z", run: { status: "in_progress", conclusion: null } },
  { name: "the reservation has not aged past the lease", schema: 5, createdAt: "recent", run: { status: "completed", conclusion: "success" } },
  { name: "the owning run cannot be confirmed terminal (fail closed)", schema: 5, createdAt: "2026-06-06T00:01:00.000Z", run: null }
]) {
  test(`scheduled reap keeps a quarantine when ${testCase.name}`, async () => {
    const owner = withRunner(semaphoreHolder("owner/repo", "999", "playmode"), "GitHub Actions 555");
    const createdAt = testCase.createdAt === "recent" ? new Date(Date.now() - 60 * 1000).toISOString() : testCase.createdAt;
    const quarantine = lifecycleReservation(owner, {
      reservationId: "kept-quarantine",
      state: "quarantine",
      reason: "return-missing-positive-evidence",
      createdAt
    });
    let state = testCase.schema === 5
      ? accountHealthState([], [], [quarantine])
      : lifecycleState([], [], [quarantine]);

    await withTempFile(async (outputFile) => {
      await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return base64Content(
              { maxHolders: 2, runnerSerialization: true, resourceLifecycle: true, accountHealth: testCase.schema === 5, releaseCooldownSeconds: 1 },
              "cfg"
            );
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
              return jsonResponse(200, { content: { sha: "reaped-sha" } });
            }
            return base64Content(state, "state-before-reap");
          }
          if (parsed.pathname === "/repos/owner/repo/actions/runs/999") {
            return testCase.run ? jsonResponse(200, testCase.run) : jsonResponse(404, { message: "no run" });
          }
          // Reached only in the "cannot be confirmed" case: a missing run with an
          // accessible repo -> getRunStatus returns known:false (not a hard error).
          if (parsed.pathname === "/repos/owner/repo") {
            return jsonResponse(200, { full_name: "owner/repo" });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await reap(semaphoreConfig());
        });
      });
      const outputs = readEnvironmentFile(outputFile);
      assert.equal(outputs.reaped, "false");
    });

    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0].state, "quarantine");
  });
}


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


test("stale evaluation reclaims a completed holder job while sibling matrix jobs keep the run active", async () => {
  const holder = {
    holderId: "owner/repo:123:unity-tests:playmode",
    repository: "owner/repo",
    workflow: "Unity Tests",
    job: "unity-tests",
    runId: "123",
    runAttempt: "1",
    runUrl: "https://github.com/owner/repo/actions/runs/123",
    runnerId: "runner-a",
    jobId: "11",
    queuedAt: "2026-06-06T00:00:30.000Z",
    acquiredAt: "2026-06-06T00:01:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z"
  };

  await withMockedFetch(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/repos/owner/repo/actions/runs/123") {
      return jsonResponse(200, { status: "in_progress", run_attempt: 1 });
    }
    if (parsed.pathname === "/repos/owner/repo/actions/runs/123/attempts/1/jobs") {
      return jsonResponse(200, {
        total_count: 2,
        jobs: [
          {
            id: 11,
            runner_name: "runner-a",
            status: "completed",
            conclusion: "success",
            started_at: "2026-06-06T00:00:00.000Z",
            completed_at: "2026-06-06T00:02:00.000Z"
          },
          {
            id: 12,
            runner_name: "runner-b",
            status: "in_progress",
            conclusion: null,
            started_at: "2026-06-06T00:00:00.000Z",
            completed_at: null
          }
        ]
      });
    }
    return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
  }, async () => {
    assert.deepEqual(await evaluateStale(holder, "reader"), {
      stale: true,
      reason: "holder job 11 is completed"
    });
  });
});


test("stale evaluation does not resolve a live sequential matrix holder to its completed predecessor", async () => {
  const holder = {
    holderId: "owner/repo:30645211053:unity-tests:2021.3.45f1-playmode",
    repository: "owner/repo",
    workflow: "Unity Tests",
    job: "unity-tests",
    runId: "30645211053",
    runAttempt: "1",
    runUrl: "https://github.com/owner/repo/actions/runs/30645211053",
    runnerId: "runner-a",
    queuedAt: "2026-07-31T16:00:55.276Z",
    acquiredAt: "2026-07-31T16:00:58.333Z",
    expiresAt: "2999-01-01T00:00:00.000Z"
  };

  await withMockedFetch(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/repos/owner/repo/actions/runs/30645211053") {
      return jsonResponse(200, { status: "in_progress", run_attempt: 1 });
    }
    if (parsed.pathname === "/repos/owner/repo/actions/runs/30645211053/attempts/1/jobs") {
      return jsonResponse(200, {
        total_count: 2,
        jobs: [
          {
            id: 91204876077,
            name: "Unity 2021.3.45f1 editmode",
            runner_name: "runner-a",
            status: "completed",
            conclusion: "success",
            started_at: "2026-07-31T15:59:30.000Z",
            completed_at: "2026-07-31T16:01:02.000Z"
          },
          {
            id: 91204876143,
            name: "Unity 2021.3.45f1 playmode",
            runner_name: "runner-a",
            status: "in_progress",
            conclusion: null,
            started_at: "2026-07-31T16:01:03.000Z",
            completed_at: null
          }
        ]
      });
    }
    return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
  }, async () => {
    assert.deepEqual(await evaluateStale(holder, "reader"), {
      stale: false,
      reason: "holder run is in_progress"
    });
  });
});


test("queue cleanup drops a completed waiting job while sibling matrix jobs keep the run active", async () => {
  const entry = {
    holderId: "owner/repo:123:unity-tests:editmode",
    repository: "owner/repo",
    workflow: "Unity Tests",
    job: "unity-tests",
    runId: "123",
    runAttempt: "1",
    runUrl: "https://github.com/owner/repo/actions/runs/123",
    runnerId: "runner-a",
    jobId: "21",
    queuedAt: "2026-06-06T00:01:00.000Z"
  };

  await withMockedFetch(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/repos/owner/repo/actions/runs/123") {
      return jsonResponse(200, { status: "in_progress", run_attempt: 1 });
    }
    if (parsed.pathname === "/repos/owner/repo/actions/runs/123/attempts/1/jobs") {
      return jsonResponse(200, {
        total_count: 2,
        jobs: [
          {
            id: 21,
            runner_name: "runner-a",
            status: "completed",
            conclusion: "cancelled",
            started_at: "2026-06-06T00:00:00.000Z",
            completed_at: "2026-06-06T00:02:00.000Z"
          },
          {
            id: 22,
            runner_name: "runner-b",
            status: "in_progress",
            conclusion: null,
            started_at: "2026-06-06T00:00:00.000Z",
            completed_at: null
          }
        ]
      });
    }
    return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
  }, async () => {
    assert.equal(await queueEntryIsFinished(entry, "reader"), true);
  });
});


test("legacy holder-job lookup fails closed without a recorded numeric job ID", async () => {
  const holder = {
    holderId: "owner/repo:123:unity-tests:playmode",
    repository: "owner/repo",
    workflow: "Unity Tests",
    job: "unity-tests",
    runId: "123",
    runAttempt: "1",
    runUrl: "https://github.com/owner/repo/actions/runs/123",
    runnerId: "runner-a",
    queuedAt: "2026-06-06T00:00:30.000Z",
    acquiredAt: "2026-06-06T00:01:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z"
  };

  await withMockedFetch(
    async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/owner/repo/actions/runs/123") {
        return jsonResponse(200, { status: "in_progress", run_attempt: 1 });
      }
      return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
    },
    async (logs) => {
      assert.deepEqual(await evaluateStale(holder, "reader"), {
        stale: false,
        reason: "holder run is in_progress"
      });
      assert.match(logs.join("\n"), /has no recorded numeric job ID/);
    }
  );
});


test("exact holder-job lookup retains holders and queue entries with missing or unknown statuses", async (t) => {
  const holder = {
    holderId: "owner/repo:123:unity-tests:playmode",
    repository: "owner/repo",
    workflow: "Unity Tests",
    job: "unity-tests",
    runId: "123",
    runAttempt: "1",
    runUrl: "https://github.com/owner/repo/actions/runs/123",
    runnerId: "runner-a",
    jobId: "31",
    queuedAt: "2026-06-06T00:00:30.000Z",
    acquiredAt: "2026-06-06T00:01:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z"
  };
  const { acquiredAt: _acquiredAt, expiresAt: _expiresAt, ...queueEntry } = holder;
  const cases = [
    { name: "missing status", job: { id: 31, runner_name: "runner-a" }, warning: /missing status/ },
    {
      name: "unknown status",
      job: { id: 31, runner_name: "runner-a", status: "mystery" },
      warning: /unrecognized status mystery/
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await withMockedFetch(async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/owner/repo/actions/runs/123") {
          return jsonResponse(200, { status: "in_progress", run_attempt: 1 });
        }
        if (parsed.pathname === "/repos/owner/repo/actions/runs/123/attempts/1/jobs") {
          return jsonResponse(200, { total_count: 1, jobs: [testCase.job] });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async (logs) => {
        assert.deepEqual(await evaluateStale(holder, "reader"), {
          stale: false,
          reason: "holder run is in_progress"
        });
        assert.equal(await queueEntryIsFinished(queueEntry, "reader"), false);
        assert.match(logs.join("\n"), testCase.warning);
      });
    });
  }
});


// Issue #53 item 6: the acquire step must be able to tell an operator whether the
// job spent its time waiting for a GitHub runner or waiting in the organization
// FIFO. The runner wait is the exact job's own Actions timeline, so it is measured
// from the job record the caller lookup already reads. An unprovable wait stays
// empty; it is never reported as zero.
const currentJobTimingCases = [
  {
    name: "measures the wait between job creation and job start",
    job: {
      id: 41,
      runner_name: "runner-a",
      status: "in_progress",
      created_at: "2026-06-06T00:00:00.000Z",
      started_at: "2026-06-06T00:04:30.000Z"
    },
    runnerWaitMs: "270000"
  },
  {
    name: "measures a zero wait when the runner started the job as soon as it was created",
    job: {
      id: 41,
      runner_name: "runner-a",
      status: "in_progress",
      created_at: "2026-06-06T00:00:00.000Z",
      started_at: "2026-06-06T00:00:00.000Z"
    },
    runnerWaitMs: "0"
  },
  {
    name: "leaves the wait unmeasured when GitHub records no job start time",
    job: {
      id: 41,
      runner_name: "runner-a",
      status: "in_progress",
      created_at: "2026-06-06T00:00:00.000Z",
      started_at: null
    },
    runnerWaitMs: ""
  },
  {
    name: "leaves the wait unmeasured when the job payload carries no timeline at all",
    job: { id: 41, runner_name: "runner-a", status: "in_progress" },
    runnerWaitMs: ""
  },
  {
    name: "leaves the wait unmeasured when the start time precedes creation",
    job: {
      id: 41,
      runner_name: "runner-a",
      status: "in_progress",
      created_at: "2026-06-06T00:04:30.000Z",
      started_at: "2026-06-06T00:00:00.000Z"
    },
    runnerWaitMs: ""
  }
];

for (const timingCase of currentJobTimingCases) {
  test(`current job lookup ${timingCase.name}`, async () => {
    const identity = {
      repository: "owner/repo",
      runId: "123",
      runAttempt: "2",
      runnerId: "runner-a"
    };

    await withMockedFetch(async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/repos/owner/repo/actions/runs/123/attempts/2/jobs");
      return jsonResponse(200, {
        total_count: 3,
        jobs: [
          { id: 40, runner_name: "runner-a", status: "completed" },
          timingCase.job,
          { id: 42, runner_name: "runner-b", status: "in_progress" }
        ]
      });
    }, async () => {
      const resolved = await resolveCurrentJob(identity, "github-token");
      assert.equal(resolved.jobId, "41");
      assert.equal(resolved.runnerWaitMs, timingCase.runnerWaitMs);
    });
  });
}


test("current job lookup records no job and no runner wait without a unique active job", async () => {
  const identity = {
    repository: "owner/repo",
    runId: "123",
    runAttempt: "1",
    runnerId: "runner-a"
  };

  await withMockedFetch(async () => jsonResponse(200, {
    total_count: 2,
    jobs: [
      { id: 51, runner_name: "runner-a", status: "in_progress" },
      { id: 52, runner_name: "runner-a", status: "in_progress" }
    ]
  }), async (logs) => {
    const resolved = await resolveCurrentJob(identity, "github-token");
    assert.deepEqual(resolved, { jobId: "", runnerWaitMs: "" });
    assert.match(logs.join("\n"), /found 2 active jobs/);
  });
});


test("exact holder-job lookup rejects missing Actions read permission", async () => {
  const holder = {
    holderId: "owner/repo:123:unity-tests:playmode",
    repository: "owner/repo",
    workflow: "Unity Tests",
    job: "unity-tests",
    runId: "123",
    runAttempt: "1",
    runUrl: "https://github.com/owner/repo/actions/runs/123",
    runnerId: "runner-a",
    jobId: "31",
    queuedAt: "2026-06-06T00:00:30.000Z",
    acquiredAt: "2026-06-06T00:01:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z"
  };

  await withMockedFetch(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/repos/owner/repo/actions/runs/123") {
      return jsonResponse(200, { status: "in_progress", run_attempt: 1 });
    }
    if (parsed.pathname === "/repos/owner/repo/actions/runs/123/attempts/1/jobs") {
      return jsonResponse(403, { message: "Resource not accessible by integration" });
    }
    return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
  }, async () => {
    await assert.rejects(
      () => evaluateStale(holder, "reader"),
      /Ensure the reaper reader credentials have actions: read access/
    );
  });
});


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
          parsed.releaseCooldownSeconds >= 0 &&
          parsed.releaseCooldownSeconds <= 86400,
        `${file} releaseCooldownSeconds must be an integer between 0 and 86400`
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


test("dedupeQueueEntries preserves FIFO order in linear queue cleanup", () => {
  const first = { holderId: "first" };
  const second = { holderId: "second" };
  const duplicate = { holderId: "first", runAttempt: "2" };

  assert.deepEqual(dedupeQueueEntries([{}, first, duplicate, second, { holderId: "" }]), [first, second]);
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
  const holder = { ...withRunner(semaphoreHolder("other/repo", "999", "editmode"), "unity-runner-a"), jobId: "71" };
  const queued = { ...withRunner(semaphoreQueueEntry("other/repo", "888", "playmode"), "unity-runner-b"), jobId: "72" };

  const normalized = normalizeState(
    { ...semaphoreState([holder], [queued]), schemaVersion: 3 },
    "wallstop-organization-builds"
  );

  assert.equal(normalized.schemaVersion, 3);
  assert.equal(normalized.holders[0].runnerId, "unity-runner-a");
  assert.equal(normalized.queue[0].runnerId, "unity-runner-b");
  assert.equal(normalized.holders[0].jobId, "71");
  assert.equal(normalized.queue[0].jobId, "72");
});


test("state normalization rejects malformed optional numeric Actions job IDs", () => {
  const holder = { ...semaphoreHolder("other/repo", "999", "editmode"), jobId: "01" };
  assert.throws(
    () => normalizeState(semaphoreState([holder]), "wallstop-organization-builds"),
    /invalid numeric Actions job ID/
  );
});


test("idempotent acquire backfills an exact job ID into the holder and legacy mirror", async () => {
  const holder = withRunner(semaphoreHolder("owner/repo", "123", "playmode"), "runner-a");
  let state = { ...semaphoreState([holder]), schemaVersion: 3 };
  let putCalls = 0;

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/repos/owner/repo/actions/runs/123/attempts/1/jobs") {
          return jsonResponse(200, {
            total_count: 1,
            jobs: [{ id: 81, runner_name: "runner-a", status: "in_progress" }]
          });
        }
        if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
          return jsonResponse(200, { object: { sha: "branch-sha" } });
        }
        if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
          return base64Content({ maxHolders: 1, runnerSerialization: true }, "cfg");
        }
        if (parsed.pathname === SEMAPHORE_STATE_PATH) {
          if (options.method === "PUT") {
            putCalls++;
            const body = JSON.parse(options.body);
            state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
            return jsonResponse(200, { content: { sha: "backfilled" } });
          }
          return base64Content(state, putCalls ? "backfilled" : "state-sha");
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async () => {
        await acquire(semaphoreConfig({ githubToken: "github-token", runnerId: "runner-a" }));
      });
    });
    assert.equal(readEnvironmentFile(outputFile).acquired, "true");
  });

  assert.equal(putCalls, 1);
  assert.equal(state.holders[0].jobId, "81");
  assert.equal(state.holder.jobId, "81");
});


test("idempotent acquire fails closed on a conflicting exact holder job ID", async () => {
  const holder = {
    ...withRunner(semaphoreHolder("owner/repo", "123", "playmode"), "runner-a"),
    jobId: "80"
  };
  const state = { ...semaphoreState([holder]), schemaVersion: 3 };
  let putCalls = 0;

  await withActionEnv(semaphoreActionEnv, async () => {
    await withMockedFetch(async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/owner/repo/actions/runs/123/attempts/1/jobs") {
        return jsonResponse(200, {
          total_count: 1,
          jobs: [{ id: 81, runner_name: "runner-a", status: "in_progress" }]
        });
      }
      if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
        return jsonResponse(200, { object: { sha: "branch-sha" } });
      }
      if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
        return base64Content({ maxHolders: 1, runnerSerialization: true }, "cfg");
      }
      if (parsed.pathname === SEMAPHORE_STATE_PATH) {
        if (options.method === "PUT") putCalls++;
        return base64Content(state, "state-sha");
      }
      return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
    }, async () => {
      await assert.rejects(
        () => acquire(semaphoreConfig({ githubToken: "github-token", runnerId: "runner-a" })),
        /refusing conflicting exact job 81/
      );
    });
  });

  assert.equal(putCalls, 0);
});


test("same-attempt queue refresh serializes a missing exact job ID", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-06-06T01:00:00.000Z");
  const queued = withRunner(semaphoreQueueEntry("owner/repo", "123", "playmode"), "runner-a");
  let state = {
    ...semaphoreState([withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-b")], [queued]),
    schemaVersion: 3
  };
  const writtenStates = [];
  Date.now = () => (now += 30000);

  try {
    await withActionEnv(semaphoreActionEnv, async () => {
      await withImmediateTimers(async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/owner/repo/actions/runs/123/attempts/1/jobs") {
            return jsonResponse(200, {
              total_count: 1,
              jobs: [{ id: 82, runner_name: "runner-a", status: "in_progress" }]
            });
          }
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return base64Content({ maxHolders: 1, runnerSerialization: true }, "cfg");
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              const body = JSON.parse(options.body);
              state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
              writtenStates.push(structuredClone(state));
              return jsonResponse(200, { content: { sha: `state-${writtenStates.length}` } });
            }
            return base64Content(state, "state-sha");
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await assert.rejects(
            () => acquire(semaphoreConfig({ githubToken: "github-token", runnerId: "runner-a" })),
            /Timed out waiting for build lock/
          );
        });
      });
    });
  } finally {
    Date.now = originalNow;
  }

  assert.ok(writtenStates.some((candidate) => candidate.queue.some((entry) => entry.jobId === "82")));
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
        assert.notEqual(state.holders[0].queuedAt, queued.queuedAt);
        assert.ok(Date.parse(state.holders[0].queuedAt) > Date.parse(queued.queuedAt));
      }
    });
  }
});


test("rerun queue refresh records the new attempt timestamp", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-06-06T01:00:00.000Z");
  const queued = {
    ...withRunner(semaphoreQueueEntry("owner/repo", "123", "playmode"), "runner-old"),
    runAttempt: "1",
    queuedAt: "2026-06-06T00:00:00.000Z"
  };
  let state = {
    ...semaphoreState([
      withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-holder")
    ], [queued]),
    schemaVersion: 3
  };
  const writtenStates = [];

  Date.now = () => {
    now += 30000;
    return now;
  };

  try {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_RUN_ATTEMPT: "2" }, async () => {
      await withImmediateTimers(async () => {
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
              const body = JSON.parse(options.body);
              state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
              writtenStates.push(structuredClone(state));
              return jsonResponse(200, { content: { sha: `state-${writtenStates.length}` } });
            }
            return base64Content(state, "state-sha");
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await assert.rejects(
            () => acquire(semaphoreConfig({ runnerId: "runner-new", timeoutMinutes: 1 })),
            /Timed out waiting for build lock/
          );
        });
      });
    });
  } finally {
    Date.now = originalNow;
  }

  const refreshed = writtenStates.find((candidate) => candidate.queue.some((entry) => entry.runAttempt === "2"));
  assert.ok(refreshed, "expected the rerun queue identity to be persisted");
  const refreshedEntry = refreshed.queue.find((entry) => entry.runAttempt === "2");
  assert.equal(refreshedEntry.runnerId, "runner-new");
  assert.notEqual(refreshedEntry.queuedAt, queued.queuedAt);
  assert.ok(Date.parse(refreshedEntry.queuedAt) > Date.parse(queued.queuedAt));
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


test("fresh admission does not succeed when post-write state loses its proven exact job ID", async (t) => {
  for (const testCase of [
    { name: "missing job ID", verificationJobId: "" },
    { name: "conflicting job ID", verificationJobId: "92" }
  ]) {
    await t.test(testCase.name, async () => {
      const empty = { ...semaphoreState([]), schemaVersion: 3 };
      let writtenState = null;
      let stateReads = 0;
      let putCalls = 0;

      const observedState = (jobId) => {
        const observed = structuredClone(writtenState);
        if (jobId) {
          observed.holders[0].jobId = jobId;
          observed.holder.jobId = jobId;
        } else {
          delete observed.holders[0].jobId;
          delete observed.holder.jobId;
        }
        return observed;
      };

      await withActionEnv(semaphoreActionEnv, async () => {
        await withImmediateTimers(async () => {
          await withMockedFetch(async (url, options = {}) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/repos/owner/repo/actions/runs/123/attempts/1/jobs") {
              return jsonResponse(200, {
                total_count: 1,
                jobs: [{ id: 91, runner_name: "runner-a", status: "in_progress" }]
              });
            }
            if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
              return jsonResponse(200, { object: { sha: "branch-sha" } });
            }
            if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
              return base64Content({ maxHolders: 1, runnerSerialization: true }, "cfg");
            }
            if (parsed.pathname === SEMAPHORE_STATE_PATH) {
              if (options.method === "PUT") {
                putCalls++;
                const body = JSON.parse(options.body);
                writtenState = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
                return jsonResponse(200, { content: { sha: "written" } });
              }
              stateReads++;
              if (stateReads === 1) return base64Content(empty, "empty");
              if (stateReads === 2) {
                return base64Content(observedState(testCase.verificationJobId), "unverified");
              }
              return base64Content(observedState("92"), "conflicting");
            }
            return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
          }, async () => {
            await assert.rejects(
              () => acquire(semaphoreConfig({ githubToken: "github-token", runnerId: "runner-a" })),
              /refusing conflicting exact job 91/
            );
          });
        });
      });

      assert.equal(putCalls, 1, "the unverified write must not be reported as acquired");
      assert.equal(stateReads, 3, "acquire must retry from a fresh snapshot after failed verification");
    });
  }
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
        if (parsed.pathname === "/repos/owner/repo/actions/runs/123/attempts/1/jobs") {
          return jsonResponse(200, {
            total_count: 1,
            jobs: [{ id: 73, runner_name: "runner-a", status: "in_progress" }]
          });
        }
        if (parsed.pathname === "/repos/other/repo/actions/runs/888") {
          return jsonResponse(200, { status: "in_progress", conclusion: null });
        }
        return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
      }, async (logs) => {
        await acquire(semaphoreConfig({ githubToken: "github-token", runnerId: "runner-a" }));

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
  assert.equal(state.holders[1].jobId, "73");
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


test("acquire polling wakes promptly only for a known earlier cooldown expiry", async (t) => {
  const now = Date.parse("2026-06-06T00:01:00.000Z");
  const prior = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-a");
  const cooldown = lifecycleReservation(prior, {
    state: "cooldown",
    availableAt: "2026-06-06T00:01:01.000Z"
  });
  const laterCooldown = lifecycleReservation(
    withRunner(semaphoreHolder("third/repo", "888", "playmode"), "runner-c"),
    {
      state: "cooldown",
      availableAt: "2026-06-06T00:01:12.000Z"
    }
  );
  const distantCooldown = {
    ...laterCooldown,
    availableAt: "2026-06-06T00:01:20.000Z"
  };
  const expiredCooldown = {
    ...cooldown,
    availableAt: "2026-06-06T00:00:59.000Z"
  };
  const quarantine = lifecycleReservation(
    withRunner(semaphoreHolder("fourth/repo", "777", "playmode"), "runner-d")
  );

  for (const testCase of [
    { name: "no reservations", reservations: [], random: 0, expected: 15000 },
    { name: "quarantine", reservations: [quarantine], random: 0, expected: 15000 },
    { name: "cooldown after base delay", reservations: [distantCooldown], random: 0, expected: 15000 },
    { name: "already expired cooldown", reservations: [expiredCooldown], random: 0, expected: 15000 },
    { name: "earliest future cooldown", reservations: [laterCooldown, cooldown], random: 0, expected: 1000 },
    { name: "bounded cooldown jitter", reservations: [laterCooldown, cooldown], random: 0.999, expected: 1249 }
  ]) {
    await t.test(testCase.name, () => {
      assert.equal(
        acquirePollDelayMs(15000, testCase.reservations, now, () => testCase.random),
        testCase.expected
      );
    });
  }
});


test("acquire retry delays never exceed their governing deadline", async (t) => {
  const now = Date.parse("2026-06-06T00:01:00.000Z");
  const cooldown = lifecycleReservation(
    withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-a"),
    {
      state: "cooldown",
      availableAt: "2026-06-06T00:01:05.000Z"
    }
  );

  for (const testCase of [
    {
      name: "base poll is capped by acquire deadline",
      proposed: acquirePollDelayMs(15000, [], now, () => 0),
      deadline: now + 10000,
      expected: 10000
    },
    {
      name: "earlier cooldown remains the governing wake-up",
      proposed: acquirePollDelayMs(15000, [cooldown], now, () => 0),
      deadline: now + 10000,
      expected: 5000
    },
    {
      name: "auth grace deadline caps a longer poll",
      proposed: 15000,
      deadline: now + 2000,
      expected: 2000
    },
    {
      name: "CAS retry is capped near timeout",
      proposed: 1249,
      deadline: now + 500,
      expected: 500
    },
    {
      name: "elapsed deadline never produces a negative delay",
      proposed: 15000,
      deadline: now - 1,
      expected: 0
    }
  ]) {
    await t.test(testCase.name, () => {
      assert.equal(boundedRetryDelayMs(testCase.proposed, testCase.deadline, now), testCase.expected);
    });
  }
});


test("schema 4 release transitions ownership to cooldown or quarantine", async (t) => {
  for (const testCase of [
    { resourceSafe: true, cooldownSeconds: 360, result: "cooldown-started", state: "cooldown", available: true, reservations: 1 },
    { resourceSafe: false, cooldownSeconds: 360, result: "quarantined", state: "quarantine", available: false, reservations: 1 },
    // A zero cooldown means "no cooldown" (issue #57): a confirmed resource-safe
    // release frees its slot immediately with no reservation, so the next job can
    // acquire at once and absorb any residual Unity handoff via activation retry.
    // A quarantine is unaffected because unproven cleanup never entered this path.
    { resourceSafe: true, cooldownSeconds: 0, result: "released", state: "", available: false, reservations: 0 }
  ]) {
    await t.test(`${testCase.result} (cooldown=${testCase.cooldownSeconds})`, async () => {
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
              return base64Content({ maxHolders: 1, runnerSerialization: true, resourceLifecycle: true, releaseCooldownSeconds: testCase.cooldownSeconds }, "cfg");
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
              : testCase.result === "quarantined"
                ? /Removed lock ownership.*resource capacity is quarantined/
                : /Released wallstop-organization-builds/;
            assert.match(logs.join("\n"), message);
            if (testCase.result !== "released") {
              assert.doesNotMatch(logs.join("\n"), /Released wallstop-organization-builds/);
            }
          });
        });
        const outputs = readEnvironmentFile(outputFile);
        assert.equal(outputs.released, "true");
        assert.equal(outputs["cleanup-result"], testCase.result);
        assert.equal(outputs["reservation-state"], testCase.state);
        if (testCase.reservations > 0) {
          assert.ok(outputs["reservation-id"]);
        } else {
          assert.equal(outputs["reservation-id"], "");
        }
        assert.equal(Boolean(outputs["available-at"]), testCase.available);
      });
      assert.equal(state.holders.length, 0);
      assert.equal(state.reservations.length, testCase.reservations);
      if (testCase.reservations > 0) {
        assert.equal(state.reservations[0].runnerId, "runner-a");
        assert.equal(state.reservations[0].state, testCase.state);
      }
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
  const originalRandom = Math.random;
  const originalSetTimeout = global.setTimeout;
  let now = Date.parse("2026-06-06T00:01:00.000Z");
  const observedDelays = [];
  const prior = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-a");
  let state = lifecycleState([], [], [lifecycleReservation(prior, {
    state: "cooldown",
    availableAt: "2026-06-06T00:01:01.000Z"
  })]);
  Date.now = () => now;
  Math.random = () => 0;
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
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) return base64Content({ maxHolders: 1, runnerSerialization: true }, "cfg");
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
              return jsonResponse(200, { content: { sha: "write-sha" } });
            }
            return base64Content(state, "state-sha");
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, () => acquire(semaphoreConfig({ runnerId: "runner-b", pollSeconds: 15, timeoutMinutes: 10 })));
      });
      assert.equal(readEnvironmentFile(outputFile).acquired, "true");
    });
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
    global.setTimeout = originalSetTimeout;
  }
  assert.deepEqual(observedDelays, [1000]);
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


test("invalid release reports degrade to one safe quarantine report with stable error codes", async (t) => {
  const cases = [
    {
      name: "invalid compatibility boolean",
      values: { resourceSafe: "maybe" },
      error: "invalid-resource-safe"
    },
    {
      name: "invalid cleanup status",
      values: { cleanupStatus: "clean", health: "healthy", reason: "cleanup-confirmed" },
      error: "invalid-resource-cleanup-status"
    },
    {
      name: "invalid health",
      values: { cleanupStatus: "unknown", health: "uncertain", reason: "cleanup-evidence-unknown" },
      error: "invalid-resource-health"
    },
    {
      name: "unrecognized reason",
      values: { cleanupStatus: "unknown", health: "healthy", reason: "sentinel-invalid-reason" },
      error: "invalid-resource-reason"
    },
    {
      name: "blocked without account-limit evidence",
      values: { cleanupStatus: "unknown", health: "blocked", reason: "return-missing-positive-evidence" },
      error: "blocked-health-reason-mismatch"
    },
    {
      name: "account-limit evidence marked healthy",
      values: { cleanupStatus: "unknown", health: "healthy", reason: "unity-account-limit-20111" },
      error: "account-limit-health-mismatch"
    },
    {
      name: "account-limit evidence marked cleanup confirmed",
      values: { cleanupStatus: "confirmed", health: "blocked", reason: "unity-account-limit-20111" },
      error: "account-limit-cleanup-status-mismatch"
    },
    {
      name: "confirmed healthy cleanup without confirmed reason",
      values: { cleanupStatus: "confirmed", health: "healthy", reason: "return-timeout" },
      error: "confirmed-cleanup-reason-mismatch"
    },
    {
      name: "confirmed reason with unknown cleanup",
      values: { cleanupStatus: "unknown", health: "healthy", reason: "cleanup-confirmed" },
      error: "cleanup-confirmed-status-mismatch"
    },
    {
      name: "legacy and typed evidence contradict",
      values: {
        resourceSafe: "true",
        cleanupStatus: "unknown",
        health: "healthy",
        reason: "return-timeout"
      },
      error: "resource-safe-contradiction"
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      assert.deepEqual(resolveReleaseReport(testCase.values), {
        report: {
          cleanupStatus: "unknown",
          health: "healthy",
          reason: "cleanup-evidence-unknown"
        },
        degraded: true,
        validationError: testCase.error
      });
    });
  }
});


test("the committed release entrypoint resolves an invalid report before state cleanup", () => {
  const runtimePath = path.join(__dirname, "..", ".github", "dist", "build-lock.js");
  const script = `
    const { config } = require(${JSON.stringify(runtimePath)});
    const parsed = config();
    process.stdout.write(JSON.stringify({
      report: parsed.resourceReport,
      degraded: parsed.resourceReportDegraded,
      validationError: parsed.resourceReportValidationError
    }));
  `;
  const result = childProcess.spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      BUILD_LOCK_MODE: "release",
      "INPUT_LOCK-NAME": "wallstop-organization-builds",
      "INPUT_LOCK-REPOSITORY": "Ambiguous-Interactive/ambiguous-organization-build-lock",
      "INPUT_RESOURCE-CLEANUP-STATUS": "unknown",
      "INPUT_RESOURCE-HEALTH": "healthy",
      "INPUT_RESOURCE-REASON": "sentinel-invalid-reason",
      GITHUB_REPOSITORY: authorizedConsumerEnv.GITHUB_REPOSITORY,
      GITHUB_REPOSITORY_ID: authorizedConsumerEnv.GITHUB_REPOSITORY_ID,
      GITHUB_REPOSITORY_OWNER_ID: authorizedConsumerEnv.GITHUB_REPOSITORY_OWNER_ID,
      BUILD_LOCK_APP_ID: "12345",
      BUILD_LOCK_APP_PRIVATE_KEY: testAppPrivateKey
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    report: {
      cleanupStatus: "unknown",
      health: "healthy",
      reason: "cleanup-evidence-unknown"
    },
    degraded: true,
    validationError: "invalid-resource-reason"
  });
  assert.equal(result.stderr.includes("sentinel-invalid-reason"), false);
});


test("a contradictory confirmed 20111 report quarantines only exact schema 5 ownership before release fails", async () => {
  const held = withRunner(semaphoreHolder("owner/repo", "123", "playmode"), "runner-a");
  const other = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-b");
  let state = accountHealthState([held, other]);
  const resolution = resolveReleaseReport({
    cleanupStatus: "confirmed",
    health: "blocked",
    reason: "unity-account-limit-20111"
  });

  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await assert.rejects(
        () => withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch" } });
          }
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return base64Content({
              maxHolders: 1,
              runnerSerialization: true,
              resourceLifecycle: true,
              accountHealth: true
            }, "cfg");
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
              return jsonResponse(200, { content: { sha: "degraded-release" } });
            }
            return base64Content(state, "before");
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, (logs) => release(semaphoreConfig({
          runnerId: "runner-a",
          resourceReport: resolution.report,
          resourceReportDegraded: resolution.degraded,
          resourceReportValidationError: resolution.validationError
        })).then(
          () => logs,
          (error) => {
            const warning = logs.find((line) => line.includes("Cleanup report validation failed"));
            assert.match(warning, /exact holder and queue cleanup will be attempted/);
            assert.match(warning, /when lifecycle state supports it/);
            throw error;
          }
        )),
        /cleanup-result=quarantined.*account-limit-cleanup-status-mismatch/
      );
    });

    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, releaseOutputNames);
    assert.equal(outputs.released, "true");
    assert.equal(outputs["cleanup-result"], "quarantined");
    assert.equal(outputs["reservation-state"], "quarantine");
    assert.equal(outputs["resource-health"], "healthy");
    assert.equal(outputs["resource-reason"], "cleanup-evidence-unknown");
    assert.equal(outputs["report-degraded"], "true");
    assert.equal(outputs["report-validation-error"], "account-limit-cleanup-status-mismatch");
    assert.equal(outputs["incident-id"], "");
  });

  assert.deepEqual(state.holders.map((holder) => holder.holderId), [other.holderId]);
  assert.equal(state.reservations.length, 1);
  assert.equal(state.reservations[0].state, "quarantine");
  assert.equal(state.reservations[0].runnerId, "runner-a");
  assert.equal(state.reservations[0].holderId, held.holderId);
  assert.equal(state.reservations[0].reason, "cleanup-evidence-unknown");
  assert.equal(state.activeIncident, null);
});


test("degraded queue-only and noop releases report exact outcomes without claiming quarantine", async (t) => {
  const resolution = resolveReleaseReport({
    cleanupStatus: "unknown",
    health: "healthy",
    reason: "sentinel-invalid-reason"
  });
  const ownQueue = withRunner(semaphoreQueueEntry("owner/repo", "123", "playmode"), "runner-a");
  const other = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-b");
  const cases = [
    {
      name: "queue-only",
      initialState: accountHealthState([], [ownQueue]),
      cleanupResult: "queue-cleaned",
      queueCleaned: "true"
    },
    {
      name: "noop",
      initialState: accountHealthState([other]),
      cleanupResult: "noop",
      queueCleaned: "false"
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const store = accountHealthFetchStore(testCase.initialState);
      await withTempFile(async (outputFile) => {
        await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
          await withMockedFetch(store.fetch, async (logs) => {
            await assert.rejects(
              () => release(semaphoreConfig({
                runnerId: "runner-a",
                resourceReport: resolution.report,
                resourceReportDegraded: resolution.degraded,
                resourceReportValidationError: resolution.validationError
              })),
              new RegExp(`cleanup-result=${testCase.cleanupResult}.*invalid-resource-reason`)
            );
            assert.equal(
              logs.some((line) => line.includes("capacity is quarantined")),
              false,
              "degraded diagnostics must not claim a quarantine that was not created"
            );
            assert.equal(
              logs.some((line) => line.includes("sentinel-invalid-reason")),
              false,
              "the rejected caller-controlled value must not be logged"
            );
          });
        });

        const outputs = readEnvironmentFile(outputFile);
        assertOutputContract(outputs, releaseOutputNames);
        assert.equal(outputs.released, "false");
        assert.equal(outputs["queue-cleaned"], testCase.queueCleaned);
        assert.equal(outputs["cleanup-result"], testCase.cleanupResult);
        assert.equal(outputs["reservation-id"], "");
        assert.equal(outputs["reservation-state"], "");
        assert.equal(outputs["incident-id"], "");
        assert.equal(outputs["resource-health"], "healthy");
        assert.equal(outputs["resource-reason"], "cleanup-evidence-unknown");
        assert.equal(outputs["report-degraded"], "true");
        assert.equal(outputs["report-validation-error"], "invalid-resource-reason");
      });
    });
  }
});


test("schema 5 global incidents round-trip and require immutable evidence provenance", () => {
  const incident = accountIncident();
  const normalized = normalizeState(accountHealthState([], [], [], incident), "wallstop-organization-builds");
  assert.deepEqual(normalized.activeIncident, incident);
  assert.throws(
    () => normalizeState(accountHealthState([], [], [], { ...incident, evidenceDigest: "not-a-digest" }), "wallstop-organization-builds"),
    /SHA-256 evidence digest/
  );
  assert.throws(
    () => normalizeState(
      accountHealthState([], [], [], { ...incident, runUrl: "https://example.invalid/forged" }),
      "wallstop-organization-builds"
    ),
    /immutable run\/runner provenance/
  );
  assert.throws(
    () => normalizeState(
      accountHealthState([], [], [], { ...incident, workflow: "Forged workflow" }),
      "wallstop-organization-builds"
    ),
    /immutable run\/runner provenance/
  );
  for (const repository of ["../repo", "owner/..", "./repo", "owner/."]) {
    assert.throws(
      () => normalizeState(
        accountHealthState([], [], [], accountIncident({ repository })),
        "wallstop-organization-builds"
      ),
      /immutable run\/runner provenance/
    );
  }
});


test("schema 5 blocked release creates one immutable global incident", async () => {
  const held = withRunner(semaphoreHolder("owner/repo", "123", "playmode"), "runner-a");
  let state = accountHealthState([held]);
  await withTempFile(async (outputFile) => {
    await withActionEnv({
      ...semaphoreActionEnv,
      GITHUB_OUTPUT: outputFile,
      GITHUB_SERVER_URL: "https://github.enterprise.example/"
    }, async () => {
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
      assert.equal(
        state.activeIncident.runUrl,
        "https://github.enterprise.example/owner/repo/actions/runs/123"
      );
      assert.deepEqual(
        normalizeState(state, "wallstop-organization-builds").activeIncident,
        state.activeIncident,
        "an enterprise incident must remain readable after its creation write"
      );
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


test("schema 5 clean releases preserve local evidence while reporting a pre-existing incident", async (t) => {
  const incident = accountIncident({
    repository: "other/repo",
    runId: "999",
    runUrl: "https://github.com/other/repo/actions/runs/999",
    runnerId: "runner-a"
  });
  const cases = [
    {
      name: "typed report with cooldown",
      releaseConfig: {
        resourceReport: {
          cleanupStatus: "confirmed",
          health: "healthy",
          reason: "cleanup-confirmed"
        }
      },
      expectedReservationState: "cooldown"
    },
    {
      name: "legacy report with cooldown",
      releaseConfig: { resourceSafe: true },
      expectedReservationState: "cooldown"
    },
    {
      name: "typed report with zero cooldown",
      releaseConfig: {
        resourceReport: {
          cleanupStatus: "confirmed",
          health: "healthy",
          reason: "cleanup-confirmed"
        }
      },
      releaseCooldownSeconds: 0,
      expectedReservationState: ""
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const held = withRunner(semaphoreHolder("owner/repo", "123", "playmode"), "runner-b");
      const store = accountHealthFetchStore(
        accountHealthState([held], [], [], incident),
        { releaseCooldownSeconds: testCase.releaseCooldownSeconds }
      );

      await withTempFile(async (outputFile) => {
        await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
          await withMockedFetch(store.fetch, () => release(semaphoreConfig({
            runnerId: "runner-b",
            ...testCase.releaseConfig
          })));
        });

        const outputs = readEnvironmentFile(outputFile);
        assertOutputContract(outputs, releaseOutputNames);
        assert.equal(outputs.released, "true");
        assert.equal(outputs["cleanup-result"], "global-quarantined");
        assert.equal(outputs["reservation-state"], testCase.expectedReservationState);
        assert.equal(outputs["reservation-id"] === "", testCase.expectedReservationState === "");
        assert.equal(outputs["incident-id"], incident.incidentId);
        assert.equal(outputs["resource-health"], "healthy");
        assert.equal(outputs["resource-reason"], "cleanup-confirmed");
      });

      assert.equal(store.state().holders.length, 0);
      assert.equal(store.state().reservations.length, testCase.expectedReservationState ? 1 : 0);
      if (testCase.expectedReservationState) {
        assert.equal(store.state().reservations[0].state, "cooldown");
        assert.equal(store.state().reservations[0].runnerId, "runner-b");
      }
      assert.deepEqual(store.state().activeIncident, incident);
    });
  }
});


test("schema 5 uncertainty reasons remain runner-local and never create account incidents", async (t) => {
  for (const reason of [
    "unity-return-400006",
    "return-timeout",
    "return-log-truncated",
    "return-terminated",
    "return-command-failed",
    "return-missing-positive-evidence",
    "return-ulf-skipped",
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
  const store = accountHealthFetchStore(accountHealthState([], [], [], incident));
  let rejection;
  await withTempFile(async (outputFile) => {
    await assert.rejects(
      () => withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
        await withMockedFetch(store.fetch, () => acquire(semaphoreConfig({ runnerId: "runner-b" })));
      }),
      (error) => {
        rejection = error;
        return true;
      }
    );
    const outputs = readEnvironmentFile(outputFile);
    assertOutputContract(outputs, acquireOutputNames);
    assert.equal(outputs.acquired, "false");
    assert.equal(outputs["admission-result"], "account-blocked");
    assert.equal(outputs["incident-id"], incident.incidentId);
  });
  for (const value of [
    incident.incidentId,
    incident.repository,
    incident.workflow,
    incident.job,
    incident.runUrl,
    incident.runnerId,
    incident.reportedAt,
    incident.reason,
    "Recover build lock",
    "operation=recover-incident",
    `incident-id=${incident.incidentId}`,
    "portal-cleanup-confirmed=true"
  ]) {
    assert.match(rejection.message, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assertIncidentRecoveryWorkflowContract(rejection.message);
  assert.doesNotMatch(rejection.message, /[\r\n]/);
  assert.doesNotMatch(rejection.message, new RegExp(incident.evidenceDigest));
  assert.equal(store.writes(), 0);
  assert.deepEqual(store.state().queue, []);
});


test("schema 5 immediate incident cleans only the caller's exact queued identity", async () => {
  const incident = accountIncident({ runnerId: "runner-c" });
  const unrelatedHolder = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-b");
  const unrelatedQueue = withRunner(semaphoreQueueEntry("other/repo", "998", "playmode"), "runner-d");
  const callerQueue = withRunner(semaphoreQueueEntry("owner/repo", "123", "playmode"), "runner-a");
  const store = accountHealthFetchStore(
    accountHealthState([unrelatedHolder], [unrelatedQueue, callerQueue], [], incident),
    { maxHolders: 2 }
  );
  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(store.fetch, () => assert.rejects(
        () => acquire(semaphoreConfig({ runnerId: "runner-a" })),
        /Global account incident .* blocks new .* admission/
      ));
    });
    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs["admission-result"], "account-blocked");
    assert.equal(outputs["state-sha"], "write-1");
  });
  assert.equal(store.writes(), 1);
  assert.deepEqual(store.state().queue, [unrelatedQueue]);
  assert.deepEqual(store.state().holders, [unrelatedHolder]);
  assert.deepEqual(store.state().reservations, []);
  assert.equal(store.state().activeIncident.incidentId, incident.incidentId);
});


test("schema 5 incident appearing during a wait removes the caller's exact queue identity", async () => {
  const unrelatedHolder = withRunner(semaphoreHolder("other/repo", "999", "editmode"), "runner-b");
  const incident = accountIncident({ runnerId: unrelatedHolder.runnerId });
  const store = accountHealthFetchStore(accountHealthState([unrelatedHolder]), {
    afterWrite: (state, writes) => ({ ...state, activeIncident: writes === 1 ? incident : state.activeIncident })
  });
  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withImmediateTimers(async () => {
        await withMockedFetch(store.fetch, () => assert.rejects(
          () => acquire(semaphoreConfig({ runnerId: "runner-a", timeoutMinutes: 10 })),
          /Global account incident .* blocks new .* admission/
        ));
      });
    });
    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs["admission-result"], "account-blocked");
    assert.equal(outputs["state-sha"], "write-2");
  });
  assert.equal(store.writes(), 2, "queue insertion and exact queue cleanup must each use one CAS write");
  assert.deepEqual(store.state().queue, []);
  assert.deepEqual(store.state().holders, [unrelatedHolder]);
  assert.deepEqual(store.state().reservations, []);
  assert.equal(store.state().activeIncident.incidentId, incident.incidentId);
});


test("schema 5 incident published after admission is retracted before activation", async () => {
  const incident = accountIncident({ runnerId: "runner-b" });
  const store = accountHealthFetchStore(accountHealthState(), {
    afterWrite: (state, writes) => ({ ...state, activeIncident: writes === 1 ? incident : state.activeIncident })
  });
  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withMockedFetch(store.fetch, () => assert.rejects(
        () => acquire(semaphoreConfig({ runnerId: "runner-a" })),
        /Global account incident .* blocks new .* admission/
      ));
    });
    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs.acquired, "false");
    assert.equal(outputs["admission-result"], "account-blocked");
    assert.equal(outputs["state-sha"], "write-2");
  });
  assert.equal(store.writes(), 2, "admission and pre-activation retraction must each use one CAS write");
  assert.deepEqual(store.state().holders, []);
  assert.deepEqual(store.state().queue, []);
  assert.deepEqual(store.state().reservations, []);
  assert.equal(store.state().activeIncident.incidentId, incident.incidentId);
});


test("schema 5 incident after quarantine admission restores the exact quarantine", async () => {
  const incident = accountIncident({ runnerId: "runner-b" });
  const caller = withRunner(semaphoreHolder("owner/repo", "123", "playmode"), "runner-a");
  const quarantine = lifecycleReservation(caller, { reservationId: "caller-quarantine" });
  const store = accountHealthFetchStore(accountHealthState([], [], [quarantine]), {
    afterWrite: (state, writes) => ({ ...state, activeIncident: writes === 1 ? incident : state.activeIncident })
  });
  await withActionEnv(semaphoreActionEnv, async () => {
    await withMockedFetch(store.fetch, () => assert.rejects(
      () => acquire(semaphoreConfig({ runnerId: "runner-a" })),
      /Global account incident .* blocks new .* admission/
    ));
  });
  assert.equal(store.writes(), 2);
  assert.deepEqual(store.state().holders, []);
  assert.deepEqual(store.state().queue, []);
  assert.deepEqual(store.state().reservations, [quarantine]);
  assert.equal(store.state().activeIncident.incidentId, incident.incidentId);
});


test("schema 5 incident cleanup failure reports a typed fail-closed result", async () => {
  const incident = accountIncident({ runnerId: "runner-c" });
  const callerQueue = withRunner(semaphoreQueueEntry("owner/repo", "123", "playmode"), "runner-a");
  const store = accountHealthFetchStore(accountHealthState([], [callerQueue], [], incident), {
    rejectWrites: true
  });
  let rejection;
  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withImmediateTimers(async () => {
        await withMockedFetch(store.fetch, () => assert.rejects(
          () => acquire(semaphoreConfig({ runnerId: "runner-a" })),
          (error) => {
            rejection = error;
            return true;
          }
        ));
      });
    });
    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs.acquired, "false");
    assert.equal(outputs["admission-result"], "account-blocked-cleanup-failed");
    assert.equal(outputs["incident-id"], incident.incidentId);
    assert.equal(outputs["resource-health"], "blocked");
    assert.equal(outputs["resource-reason"], incident.reason);
  });
  assert.match(rejection.message, /Exact build-lock cleanup could not be confirmed/);
  assert.match(rejection.message, /First, use supported release, post-action, or fallback cleanup/);
  assert.match(rejection.message, /confirm that removal with a fresh lock-state read/);
  assert.match(rejection.message, /reconcile every Unity Portal activation/);
  assert.match(rejection.message, /Recover build lock/);
  assert.match(rejection.message, /operation=recover-incident/);
  assert.match(rejection.message, new RegExp(`incident-id=${incident.incidentId}`));
  assert.match(rejection.message, /portal-cleanup-confirmed=true/);
  assert.match(rejection.message, /Only then rerun the consumer/);
  assertIncidentRecoveryWorkflowContract(rejection.message);
  assert.equal(store.writes(), 3);
  assert.deepEqual(store.state().queue, [callerQueue]);
  assert.deepEqual(store.state().holders, []);
  assert.deepEqual(store.state().reservations, []);
  assert.equal(store.state().activeIncident.incidentId, incident.incidentId);
});


test("schema 5 post-admission cleanup failure forbids incident recovery until caller removal", async () => {
  const incident = accountIncident({ runnerId: "runner-b" });
  const store = accountHealthFetchStore(accountHealthState(), {
    afterWrite: (state, writes) => ({ ...state, activeIncident: writes === 1 ? incident : state.activeIncident }),
    rejectWrites: (_state, writes) => writes > 1
  });
  let rejection;
  await withTempFile(async (outputFile) => {
    await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
      await withImmediateTimers(async () => {
        await withMockedFetch(store.fetch, () => assert.rejects(
          () => acquire(semaphoreConfig({ runnerId: "runner-a" })),
          (error) => {
            rejection = error;
            return true;
          }
        ));
      });
    });
    const outputs = readEnvironmentFile(outputFile);
    assert.equal(outputs["admission-result"], "account-blocked-cleanup-failed");
    assert.equal(outputs["incident-id"], incident.incidentId);
  });
  const cleanupPosition = rejection.message.indexOf("First, use supported release");
  const portalPosition = rejection.message.indexOf("reconcile every Unity Portal activation");
  const recoveryPosition = rejection.message.indexOf("operation=recover-incident");
  const rerunPosition = rejection.message.indexOf("Only then rerun the consumer");
  assert.ok(cleanupPosition >= 0 && cleanupPosition < portalPosition);
  assert.ok(portalPosition < recoveryPosition);
  assert.ok(recoveryPosition < rerunPosition);
  assert.match(rejection.message, /remove caller owner\/repo:123:perf-benchmarks:playmode from both holders and queue/);
  assert.match(rejection.message, /confirm that removal with a fresh lock-state read/);
  assert.match(rejection.message, new RegExp(`incident-id=${incident.incidentId}`));
  assert.match(rejection.message, /portal-cleanup-confirmed=true/);
  assert.equal(store.writes(), 4, "one admission and three bounded cleanup attempts are expected");
  assert.equal(store.state().holders.length, 1, "failed cleanup must remain visible and fail closed");
  assert.equal(store.state().holders[0].holderId, "owner/repo:123:perf-benchmarks:playmode");
  assert.equal(store.state().activeIncident.incidentId, incident.incidentId);
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


test("schema 5 incident recovery binds an omitted ID to the single active incident", async () => {
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
    portalCleanupConfirmed: true
  })));
  assert.equal(state.activeIncident, null);
  assert.equal(state.reservations.length, 1);
  assert.match(state.reservations[0].reason, new RegExp(incident.incidentId));
});


test("schema 5 incident recovery rejects an omitted ID without an active incident", async () => {
  let writes = 0;
  await withMockedFetch(async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: "branch" } });
    if (parsed.pathname === SEMAPHORE_STATE_PATH) {
      if (options.method === "PUT") writes++;
      return base64Content(accountHealthState(), "before");
    }
    return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
  }, async () => {
    await assert.rejects(
      () => reap(semaphoreConfig({ operation: "recover-incident", portalCleanupConfirmed: true })),
      /active incident to bind as the exact incident-id/
    );
  });
  assert.equal(writes, 0);
});


test("schema 5 incident recovery freezes an omitted ID across CAS retries", async () => {
  const firstIncident = accountIncident({ runnerId: "runner-a" });
  const laterIncident = accountIncident({ runnerId: "runner-b" });
  let stateReads = 0;
  let writes = 0;
  await withMockedFetch(async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") return jsonResponse(200, { object: { sha: `branch-${stateReads}` } });
    if (parsed.pathname === SEMAPHORE_STATE_PATH) {
      if (options.method === "PUT") {
        writes++;
        return jsonResponse(409, { message: "state changed" });
      }
      stateReads++;
      return base64Content(accountHealthState([], [], [], stateReads === 1 ? firstIncident : laterIncident), `state-${stateReads}`);
    }
    return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
  }, async () => {
    await assert.rejects(
      () => reap(semaphoreConfig({ operation: "recover-incident", portalCleanupConfirmed: true })),
      new RegExp(`Active global incident ${firstIncident.incidentId} was not found`)
    );
  });
  assert.equal(writes, 1);
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


test("peer timeline reducer derives peer, reservation, and incident events from state snapshots", () => {
  const self = timelineHolder("owner/repo", "123", "2026-06-06T00:00:00.000Z");
  const cases = [
    {
      name: "a peer holding at window start and returning mid-window yields present then returned",
      snapshots: [
        timelineSnapshot("2026-06-06T00:00:00.000Z", { holders: [self, timelineHolder("peer/repo", "555", "2026-06-05T23:58:00.000Z")] }),
        timelineSnapshot("2026-06-06T00:10:00.000Z", { holders: [self] })
      ],
      expected: [
        { kind: "peer-present", holderId: "peer/repo:555:perf-benchmarks:editmode", time: "2026-06-05T23:58:00.000Z" },
        { kind: "peer-returned", holderId: "peer/repo:555:perf-benchmarks:editmode", time: "2026-06-06T00:10:00.000Z" }
      ]
    },
    {
      name: "a peer that acquires mid-window and holds through the release is not reported as returned",
      snapshots: [
        timelineSnapshot("2026-06-06T00:00:00.000Z", { holders: [self] }),
        timelineSnapshot("2026-06-06T00:10:00.000Z", { holders: [self, timelineHolder("peer/repo", "555", "2026-06-06T00:05:00.000Z")] })
      ],
      expected: [
        { kind: "peer-acquired", holderId: "peer/repo:555:perf-benchmarks:editmode", time: "2026-06-06T00:05:00.000Z" }
      ]
    },
    {
      name: "a peer that acquires and returns entirely inside the window yields both events",
      snapshots: [
        timelineSnapshot("2026-06-06T00:00:00.000Z", { holders: [self] }),
        timelineSnapshot("2026-06-06T00:10:00.000Z", { holders: [self, timelineHolder("peer/repo", "555", "2026-06-06T00:05:00.000Z")] }),
        timelineSnapshot("2026-06-06T00:20:00.000Z", { holders: [self] })
      ],
      expected: [
        { kind: "peer-acquired", holderId: "peer/repo:555:perf-benchmarks:editmode", time: "2026-06-06T00:05:00.000Z" },
        { kind: "peer-returned", holderId: "peer/repo:555:perf-benchmarks:editmode", time: "2026-06-06T00:20:00.000Z" }
      ]
    },
    {
      name: "this run's own holder rows never become peer events",
      snapshots: [timelineSnapshot("2026-06-06T00:00:00.000Z", { holders: [self] })],
      expected: []
    },
    {
      name: "the release snapshot that removes this run is not reported as a peer return",
      snapshots: [
        timelineSnapshot("2026-06-06T00:00:00.000Z", { holders: [self, timelineHolder("peer/repo", "555", "2026-06-05T23:58:00.000Z")] }),
        timelineSnapshot("2026-06-06T00:10:00.000Z", { holders: [timelineHolder("peer/repo", "555", "2026-06-05T23:58:00.000Z")] })
      ],
      expected: [{ kind: "peer-present", holderId: "peer/repo:555:perf-benchmarks:editmode" }]
    },
    {
      name: "this run's own release reservation never becomes a peer reservation event",
      snapshots: [
        timelineSnapshot("2026-06-06T00:00:00.000Z", { holders: [self] }),
        timelineSnapshot("2026-06-06T00:10:00.000Z", {
          holders: [],
          reservations: [lifecycleReservation(self)]
        })
      ],
      expected: []
    },
    {
      name: "a reservation created mid-window is published with its redacted lifecycle fields",
      snapshots: [
        timelineSnapshot("2026-06-06T00:00:00.000Z", { holders: [self] }),
        timelineSnapshot("2026-06-06T00:10:00.000Z", {
          holders: [self],
          reservations: [lifecycleReservation(timelineHolder("peer/repo", "555", "2026-06-06T00:05:00.000Z"))]
        })
      ],
      expected: [
        {
          kind: "reservation-created",
          reservationState: "quarantine",
          runnerId: "peer/repo-runner",
          holderId: "peer/repo:555:perf-benchmarks:editmode",
          reason: "cleanup outcome unknown"
        }
      ]
    },
    {
      name: "a reservation present at window start is reported as present, and its removal as removed",
      snapshots: [
        timelineSnapshot("2026-06-06T00:00:00.000Z", {
          holders: [self],
          reservations: [lifecycleReservation(timelineHolder("peer/repo", "555", "2026-06-05T23:00:00.000Z"), { createdAt: "2026-06-05T23:00:00.000Z" })]
        }),
        timelineSnapshot("2026-06-06T00:10:00.000Z", { holders: [self] })
      ],
      expected: [
        { kind: "reservation-present", reservationState: "quarantine" },
        { kind: "reservation-removed", runnerId: "peer/repo-runner", time: "2026-06-06T00:10:00.000Z" }
      ]
    },
    {
      name: "a global incident created mid-window is published with its reviewed reason",
      snapshots: [
        timelineSnapshot("2026-06-06T00:00:00.000Z", { holders: [self] }),
        timelineSnapshot("2026-06-06T00:10:00.000Z", {
          holders: [self],
          incident: { incidentId: "incident-abc", reason: "unity-account-limit-20111", reportedAt: "2026-06-06T00:08:00.000Z" }
        })
      ],
      expected: [
        { kind: "incident-created", incidentId: "incident-abc", reason: "unity-account-limit-20111", time: "2026-06-06T00:08:00.000Z" }
      ]
    },
    {
      name: "an incident without a readable reportedAt is never misread as present at the window opening",
      sessionStart: "2026-06-06T00:00:00.000Z",
      snapshots: [
        timelineSnapshot("2026-06-06T00:05:00.000Z", {
          holders: [self],
          incident: { incidentId: "incident-abc", reason: "unity-account-limit-20111" }
        })
      ],
      expected: [
        { kind: "incident-created", incidentId: "incident-abc", reason: "unity-account-limit-20111", time: "2026-06-06T00:05:00.000Z" }
      ]
    },
    {
      name: "rows omit fields the evidence does not carry instead of publishing empty strings",
      snapshots: [
        timelineSnapshot("2026-06-06T00:00:00.000Z", {
          holders: [{ ...timelineHolder("peer/repo", "555", "2026-06-05T23:58:00.000Z"), runnerId: undefined }]
        })
      ],
      expected: [{ kind: "peer-present", runnerId: undefined }]
    },
    {
      name: "a peer that acquires and returns inside the clock-skew buffer is never reported",
      sessionStart: "2026-06-06T00:00:00.000Z",
      snapshots: [
        timelineSnapshot("2026-06-05T23:57:00.000Z", { holders: [self, timelineHolder("peer/repo", "555", "2026-06-05T23:56:30.000Z")] }),
        timelineSnapshot("2026-06-05T23:58:00.000Z", { holders: [self] }),
        timelineSnapshot("2026-06-06T00:05:00.000Z", { holders: [self] })
      ],
      expected: []
    },
    {
      name: "a peer admitted before the session that holds into it is reported present once",
      sessionStart: "2026-06-06T00:00:00.000Z",
      snapshots: [
        timelineSnapshot("2026-06-05T23:57:00.000Z", { holders: [self, timelineHolder("peer/repo", "555", "2026-06-05T23:56:30.000Z")] }),
        timelineSnapshot("2026-06-06T00:05:00.000Z", { holders: [self, timelineHolder("peer/repo", "555", "2026-06-05T23:56:30.000Z")] }),
        timelineSnapshot("2026-06-06T00:10:00.000Z", { holders: [self] })
      ],
      expected: [
        { kind: "peer-present", holderId: "peer/repo:555:perf-benchmarks:editmode", time: "2026-06-05T23:56:30.000Z" },
        { kind: "peer-returned", holderId: "peer/repo:555:perf-benchmarks:editmode", time: "2026-06-06T00:10:00.000Z" }
      ]
    },
    {
      name: "a peer that returns inside the buffer and never overlaps the session is never reported",
      sessionStart: "2026-06-06T00:00:00.000Z",
      snapshots: [
        timelineSnapshot("2026-06-05T23:57:00.000Z", { holders: [self, timelineHolder("peer/repo", "555", "2026-06-05T23:50:00.000Z")] }),
        timelineSnapshot("2026-06-06T00:05:00.000Z", { holders: [self] })
      ],
      expected: []
    }
  ];

  for (const testCase of cases) {
    const startMs = Date.parse(testCase.sessionStart || testCase.snapshots[0].time);
    const { events, truncated } = peerTimelineEvents(testCase.snapshots, self.holderId, startMs);
    assert.equal(truncated, false, testCase.name);
    assert.equal(events.length, testCase.expected.length, testCase.name);
    for (const [index, expected] of testCase.expected.entries()) {
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(events[index][key], value, `${testCase.name}: event ${index} field ${key}`);
      }
      // Redaction contract: no event carries log-shaped or URL fields.
      for (const forbidden of ["workflow", "job", "runUrl", "runAttempt", "queuedAt", "expiresAt", "reservationId"]) {
        assert.equal(forbidden in events[index], false, `${testCase.name}: event ${index} must omit ${forbidden}`);
      }
    }
  }
});


test("peer timeline reducer truncates at its event ceiling and reports it", () => {
  const self = timelineHolder("owner/repo", "123", "2026-06-06T00:00:00.000Z");
  const holders = [self];
  for (let index = 0; index < 150; index++) {
    holders.push(timelineHolder("peer/repo", String(1000 + index), "2026-06-06T00:00:00.000Z"));
  }
  const { events, truncated } = peerTimelineEvents(
    [timelineSnapshot("2026-06-06T00:00:00.000Z", { holders })],
    self.holderId,
    Date.parse("2026-06-06T00:00:00.000Z")
  );
  assert.equal(events.length, 100);
  assert.equal(truncated, true);
});


test("release publishes a redacted peer timeline for its session window", async () => {
  const self = timelineHolder("owner/repo", "123", "2026-06-06T00:00:00.000Z");
  const peer = timelineHolder("peer/repo", "555", "2026-06-06T00:05:00.000Z");
  const before = { ...lifecycleState([self]), updatedAt: "2026-06-06T00:05:00.000Z" };
  const overlapping = { ...lifecycleState([self, peer]), updatedAt: "2026-06-06T00:05:30.000Z" };
  const afterPeerReturned = { ...lifecycleState([self]), updatedAt: "2026-06-06T00:09:00.000Z" };
  // A peer that acquires and returns entirely inside the clock-skew buffer,
  // before the session opened: real lock history, never session activity.
  const preSessionCycler = timelineHolder("ghost/repo", "777", "2026-06-05T23:56:00.000Z");
  const insideBuffer = { ...lifecycleState([self, preSessionCycler]), updatedAt: "2026-06-05T23:57:00.000Z" };
  const snapshotsByRef = {
    "commit-0": insideBuffer,
    "commit-1": before,
    "commit-2": overlapping,
    "commit-3": afterPeerReturned
  };
  let state = before;

  await withTempFile(async (summaryFile) => {
    await withTempFile(async (outputFile) => {
      await withActionEnv({ ...semaphoreActionEnv, GITHUB_STEP_SUMMARY: summaryFile, GITHUB_OUTPUT: outputFile }, async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return base64Content({ maxHolders: 2, runnerSerialization: true, resourceLifecycle: true, releaseCooldownSeconds: 1 }, "cfg");
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
              snapshotsByRef["commit-4"] = state;
              return jsonResponse(200, { content: { sha: "state-after-release" } });
            }
            if (parsed.searchParams.has("ref") && parsed.searchParams.get("ref") !== "lock-state") {
              const snapshot = snapshotsByRef[parsed.searchParams.get("ref")];
              return snapshot ? base64Content(snapshot, parsed.searchParams.get("ref")) : jsonResponse(404, { message: "unknown ref" });
            }
            return base64Content(state, "state-before-read");
          }
          if (parsed.pathname === "/repos/o/r/commits") {
            assert.equal(parsed.searchParams.get("path"), "locks/wallstop-organization-builds.json");
            assert.equal(parsed.searchParams.get("sha"), "lock-state");
            // The session started at 00:00:00; the listing must reach back
            // past it by the clock-skew buffer to a 23:55:00 `since`.
            assert.equal(parsed.searchParams.get("since"), "2026-06-05T23:55:00.000Z");
            // commit-4 is the release write itself: self removed, self
            // cooldown reservation created. Neither may become an event.
            // commit-0 is inside the skew buffer: the ghost peer cycled
            // before the session opened and must not be reported either.
            return jsonResponse(200, [
              { sha: "commit-4", commit: { author: { date: "2026-06-06T00:10:00.000Z" } } },
              { sha: "commit-3", commit: { author: { date: "2026-06-06T00:09:00.000Z" } } },
              { sha: "commit-2", commit: { author: { date: "2026-06-06T00:05:30.000Z" } } },
              { sha: "commit-1", commit: { author: { date: "2026-06-06T00:00:00.000Z" } } },
              { sha: "commit-0", commit: { author: { date: "2026-06-05T23:57:00.000Z" } } }
            ]);
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await release(semaphoreConfig({
            runnerId: self.runnerId,
            holderIdSuffix: "editmode",
            resourceSafe: true,
            resourceReason: "cleanup-confirmed"
          }));
        });
        const outputs = readEnvironmentFile(outputFile);
        assertOutputContract(outputs, releaseOutputNames);
        assert.equal(outputs.released, "true");
        assert.equal(outputs["cleanup-result"], "cooldown-started");
        const timeline = JSON.parse(outputs["peer-timeline"]);
        assert.equal(timeline.status, "ok");
        assert.equal(timeline.windowFrom, "2026-06-06T00:00:00.000Z");
        assert.deepEqual(
          timeline.events.map((event) => `${event.kind}:${event.holderId}`),
          [
            "peer-acquired:peer/repo:555:perf-benchmarks:editmode",
            "peer-returned:peer/repo:555:perf-benchmarks:editmode"
          ]
        );
        assert.equal(timeline.events[0].time, "2026-06-06T00:05:00.000Z");
        assert.equal(timeline.events[1].time, "2026-06-06T00:09:00.000Z");
      });
    });
    const summary = fs.readFileSync(summaryFile, "utf8");
    assert.match(summary, /### Peer lock activity for `owner\/repo:123:perf-benchmarks:editmode`/);
    assert.match(summary, /\| `peer-acquired` \| `peer\/repo:555:perf-benchmarks:editmode` \|/);
  });
  assert.deepEqual(state.holders, []);
});


test("release keeps its outcome when peer timeline history cannot be read", async () => {
  const self = timelineHolder("owner/repo", "123", "2026-06-06T00:00:00.000Z");
  const state = lifecycleState([self]);

  await withActionEnv(semaphoreActionEnv, async () => {
    await withTempFile(async (outputFile) => {
      await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return base64Content({ maxHolders: 2, runnerSerialization: true, resourceLifecycle: true, releaseCooldownSeconds: 1 }, "cfg");
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              return jsonResponse(200, { content: { sha: "state-after-release" } });
            }
            return base64Content(state, "state-before-read");
          }
          if (parsed.pathname === "/repos/o/r/commits") {
            return jsonResponse(500, { message: "history is unavailable" });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async (logs) => {
          await release(semaphoreConfig({ runnerId: self.runnerId, holderIdSuffix: "editmode" }));
          const outputs = readEnvironmentFile(outputFile);
          assert.equal(outputs.released, "true");
          const timeline = JSON.parse(outputs["peer-timeline"]);
          assert.equal(timeline.status, "unavailable");
          assert.match(timeline.reason, /history is unavailable|500/);
          assert.deepEqual(timeline.events, []);
          assert.match(logs.join("\n"), /Peer timeline: status=unavailable/);
        });
      });
    });
  });
});


test("release reports a not-applicable peer timeline when it never held a session", async () => {
  const other = timelineHolder("other/repo", "999", "2026-06-06T00:00:00.000Z");
  const state = lifecycleState([other]);

  await withActionEnv(semaphoreActionEnv, async () => {
    await withTempFile(async (outputFile) => {
      await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return base64Content({ maxHolders: 2, runnerSerialization: true, resourceLifecycle: true, releaseCooldownSeconds: 1 }, "cfg");
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              return jsonResponse(200, { content: { sha: "state-after-write" } });
            }
            return base64Content(state, "state-before-read");
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await release(semaphoreConfig({ runnerId: "owner/repo-runner" }));
          const outputs = readEnvironmentFile(outputFile);
          assert.equal(outputs.released, "false");
          const timeline = JSON.parse(outputs["peer-timeline"]);
          assert.equal(timeline.status, "not-applicable");
          assert.deepEqual(timeline.events, []);
        });
      });
    });
  });
});


test("release marks the peer timeline partial when a history snapshot cannot be parsed", async () => {
  const self = timelineHolder("owner/repo", "123", "2026-06-06T00:00:00.000Z");
  const peer = timelineHolder("peer/repo", "555", "2026-06-06T00:06:00.000Z");
  const before = { ...lifecycleState([self]), updatedAt: "2026-06-06T00:00:00.000Z" };
  const afterPeerAcquired = { ...lifecycleState([self, peer]), updatedAt: "2026-06-06T00:09:00.000Z" };
  const state = before;

  await withActionEnv(semaphoreActionEnv, async () => {
    await withTempFile(async (outputFile) => {
      await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return base64Content({ maxHolders: 2, runnerSerialization: true, resourceLifecycle: true, releaseCooldownSeconds: 1 }, "cfg");
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              return jsonResponse(200, { content: { sha: "state-after-release" } });
            }
            if (parsed.searchParams.has("ref") && parsed.searchParams.get("ref") !== "lock-state") {
              const ref = parsed.searchParams.get("ref");
              if (ref === "commit-2") {
                return jsonResponse(200, { content: Buffer.from("not json", "utf8").toString("base64"), sha: ref });
              }
              const snapshot = ref === "commit-1" ? before : afterPeerAcquired;
              return base64Content(snapshot, ref);
            }
            return base64Content(state, "state-before-read");
          }
          if (parsed.pathname === "/repos/o/r/commits") {
            return jsonResponse(200, [
              { sha: "commit-3", commit: { author: { date: "2026-06-06T00:09:00.000Z" } } },
              { sha: "commit-2", commit: { author: { date: "2026-06-06T00:05:30.000Z" } } },
              { sha: "commit-1", commit: { author: { date: "2026-06-06T00:00:00.000Z" } } }
            ]);
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await release(semaphoreConfig({ runnerId: self.runnerId, holderIdSuffix: "editmode" }));
          const outputs = readEnvironmentFile(outputFile);
          assert.equal(outputs.released, "true");
          const timeline = JSON.parse(outputs["peer-timeline"]);
          assert.equal(timeline.status, "partial");
          assert.equal(timeline.truncated, true);
          // The parseable snapshots on both sides of the gap still yield the
          // peer event; only the gap snapshot's information is lost.
          assert.deepEqual(
            timeline.events.map((event) => event.kind),
            ["peer-acquired"]
          );
          assert.equal(timeline.events[0].time, "2026-06-06T00:06:00.000Z");
        });
      });
    });
  });
});


test("release spends its peer-timeline snapshot budget inside the session window", async () => {
  const self = timelineHolder("owner/repo", "123", "2026-06-06T00:00:00.000Z");
  const peer = timelineHolder("peer/repo", "555", "2026-06-06T00:05:00.000Z");
  const cycler = timelineHolder("ghost/repo", "777", "2026-06-05T23:20:00.000Z");
  const bufferState = { ...lifecycleState([self, cycler]), updatedAt: "2026-06-05T23:30:00.000Z" };
  const windowOpen = { ...lifecycleState([self]), updatedAt: "2026-06-06T00:00:00.000Z" };
  const overlapping = { ...lifecycleState([self, peer]), updatedAt: "2026-06-06T00:05:30.000Z" };
  const afterPeerReturned = { ...lifecycleState([self]), updatedAt: "2026-06-06T00:09:00.000Z" };
  const snapshotByRef = (ref) => {
    if (ref.startsWith("buffer-")) {
      return { ...bufferState, updatedAt: `2026-06-05T23:${String(30 + Number(ref.slice(7))).padStart(2, "0")}:00.000Z` };
    }
    if (ref === "window-1") return windowOpen;
    if (ref === "window-2") return overlapping;
    if (ref === "window-3") return afterPeerReturned;
    return null;
  };
  const fetched = [];
  // A busy lock: 30 lock-state writes inside the clock-skew buffer, then the
  // session's own history. The listing is newest-first, as the API returns.
  // The buffer must not consume the snapshot budget.
  const bufferCommits = [];
  for (let index = 0; index < 30; index++) {
    bufferCommits.push({
      sha: `buffer-${index}`,
      commit: { author: { date: `2026-06-05T23:${String(30 - index).padStart(2, "0")}:00.000Z` } }
    });
  }

  await withActionEnv(semaphoreActionEnv, async () => {
    await withTempFile(async (outputFile) => {
      await withActionEnv({ ...semaphoreActionEnv, GITHUB_OUTPUT: outputFile }, async () => {
        await withMockedFetch(async (url, options = {}) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
            return jsonResponse(200, { object: { sha: "branch-sha" } });
          }
          if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
            return base64Content({ maxHolders: 2, runnerSerialization: true, resourceLifecycle: true, releaseCooldownSeconds: 1 }, "cfg");
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            if (options.method === "PUT") {
              return jsonResponse(200, { content: { sha: "state-after-release" } });
            }
            if (parsed.searchParams.has("ref") && parsed.searchParams.get("ref") !== "lock-state") {
              const ref = parsed.searchParams.get("ref");
              fetched.push(ref);
              const snapshot = snapshotByRef(ref);
              return snapshot ? base64Content(snapshot, ref) : jsonResponse(404, { message: "unknown ref" });
            }
            return base64Content(windowOpen, "state-before-read");
          }
          if (parsed.pathname === "/repos/o/r/commits") {
            return jsonResponse(200, [
              { sha: "window-3", commit: { author: { date: "2026-06-06T00:09:00.000Z" } } },
              { sha: "window-2", commit: { author: { date: "2026-06-06T00:05:30.000Z" } } },
              { sha: "window-1", commit: { author: { date: "2026-06-06T00:00:00.000Z" } } },
              ...bufferCommits
            ]);
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        }, async () => {
          await release(semaphoreConfig({ runnerId: self.runnerId, holderIdSuffix: "editmode" }));
          const outputs = readEnvironmentFile(outputFile);
          assert.equal(outputs.released, "true");
          const bufferFetches = fetched.filter((ref) => ref.startsWith("buffer-"));
          assert.equal(bufferFetches.length, 2);
          assert.deepEqual(bufferFetches, ["buffer-1", "buffer-0"]);
          const timeline = JSON.parse(outputs["peer-timeline"]);
          assert.equal(timeline.status, "ok");
          assert.deepEqual(
            timeline.events.map((event) => `${event.kind}:${event.holderId}`),
            [
              "peer-acquired:peer/repo:555:perf-benchmarks:editmode",
              "peer-returned:peer/repo:555:perf-benchmarks:editmode"
            ]
          );
        });
      });
    });
  });
});


// The lock state is decoded, reshaped, and encoded again on the next write, so
// a lossy decode does not report a problem: it repairs a byte it cannot read
// into U+FFFD and commits that. Nothing this runtime writes can produce such
// a byte, so one means something else changed the state and admission fails
// closed on evidence it cannot read exactly.
test("readState fails closed on a lock state it cannot read as UTF-8", async (t) => {
  const state = (extra) => `{"lock":"wallstop-organization-builds","schemaVersion":5,"holders":[],"queue":[],"reservations":[],"activeIncident":null,"holder":null${extra}`;
  const cases = [
    {
      name: "a lone Latin-1 byte",
      bytes: Buffer.concat([
        Buffer.from(state(',"runUrl":"https://example/')),
        Buffer.from([0x89]),
        Buffer.from('"}')
      ]),
      expected: /is not valid UTF-8/
    },
    {
      name: "an overlong encoding",
      bytes: Buffer.concat([
        Buffer.from(state(',"runUrl":"')),
        Buffer.from([0xc0, 0x80]),
        Buffer.from('"}')
      ]),
      expected: /is not valid UTF-8/
    },
    {
      // The readable half: a state whose non-ASCII text a strict decoder
      // accepts must still load, or the refusal above would be a
      // fail-closed path that also refuses valid state.
      name: "a multi-byte character in a readable state",
      bytes: Buffer.from(state(',"runUrl":"https://example/caf\u00e9"}'), "utf8"),
      expected: null
    }
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await withMockedFetch(
        async (url) => {
          const parsed = new URL(url);
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            return jsonResponse(200, {
              content: testCase.bytes.toString("base64"),
              sha: "state-sha"
            });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        },
        async () => {
          const options = { apiOptions: { maxAttempts: 1 } };
          if (testCase.expected === null) {
            const { state, sha } = await readState(semaphoreConfig(), options);
            assert.equal(sha, "state-sha");
            assert.equal(state.lock, "wallstop-organization-builds");
            return;
          }
          await assert.rejects(
            readState(semaphoreConfig(), options),
            testCase.expected
          );
        }
      );
    });
  }
});


// The peer timeline reads historical commits of the same lock state file. A
// lossy decode there turns one undecodable byte in a holder id into U+FFFD and
// reports a peer that does not exist, with no error and no gap. A commit the
// runtime cannot read exactly is evidence it does not have, so it is a gap.
test("the peer timeline reports a gap for a state commit it cannot read", async (t) => {
  // No `holders` array: `peerTimelineSnapshot` prefers that array when it is
  // present, so an empty one would hide the `holder` object this test writes.
  const state = (extra) =>
    `{"lock":"wallstop-organization-builds","queue":[]${extra}`;
  const sessionStart = new Date("2026-09-30T10:00:00Z").toISOString();
  const commit = {
    sha: "state-commit",
    commit: { author: { date: "2026-09-30T10:05:00Z" } }
  };
  const cases = [
    {
      name: "an undecodable byte in a holder id",
      bytes: Buffer.concat([
        Buffer.from(state(',"holder":{"holderId":"win-')),
        Buffer.from([0x89]),
        Buffer.from('"}}')
      ]),
      expected: "partial"
    },
    {
      name: "an overlong encoding in a holder id",
      bytes: Buffer.concat([
        Buffer.from(state(',"holder":{"holderId":"win-')),
        Buffer.from([0xc0, 0x80]),
        Buffer.from('"}}')
      ]),
      expected: "partial"
    },
    {
      // The readable half: a commit the strict decoder accepts must still be
      // observed, or the guard would turn every historical window into a gap.
      name: "a multi-byte character in a readable holder id",
      bytes: Buffer.from(state(',"holder":{"holderId":"win-café"}}'), "utf8"),
      expected: "ok"
    }
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await withMockedFetch(
        async (url) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/repos/o/r/commits") {
            return jsonResponse(200, [commit]);
          }
          if (parsed.pathname === SEMAPHORE_STATE_PATH) {
            return jsonResponse(200, {
              content: testCase.bytes.toString("base64"),
              sha: "blob-sha"
            });
          }
          return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
        },
        async () => {
          const timeline = await collectPeerTimeline(
            semaphoreConfig(),
            { holderId: "self-holder" },
            sessionStart
          );
          assert.equal(timeline.status, testCase.expected);
          assert.equal(Boolean(timeline.truncated), testCase.expected === "partial");
        }
      );
    });
  }
});
