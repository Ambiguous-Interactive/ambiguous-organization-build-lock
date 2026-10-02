// Shared fixtures for the build lock contract.
//
// `node --test` runs each file in its own process and those processes at the
// same time, but it runs the tests inside one file one after another. The 216
// top-level statements here used to sit in one file, which took about six
// seconds and made it the slowest file in the suite once the workflow shell
// contract was split.
//
// Nothing in this file is a test. The bindings, the helpers, and the fixture
// tables live here so the split moves no assertion and no rationale comment.
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  acquire,
  acquirePollDelayMs,
  api,
  authorizeCaller,
  boundedRetryDelayMs,
  collectPeerTimeline,
  config,
  createAppJwt,
  createGitHubAppAuth,
  credential,
  dedupeQueueEntries,
  emptyState: productionEmptyState,
  evaluateStale,
  installAcquireSignalCleanup,
  isRetryableResponse,
  normalizeState,
  parseReleaseReport,
  peerTimelineEvents,
  postCleanup,
  queueEntryIsFinished,
  readLockConfig,
  readState,
  readerCredential,
  readerCredentialRequired,
  release,
  releaseRetryApiOptions,
  reap,
  reapDeadlineBudgets,
  resolveCurrentJob,
  resolveReleaseReport,
  runCancellationCleanup,
  selectEligibleQueueEntries,
  workflowCommandData,
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

function htmlResponse(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
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
  "GITHUB_EVENT_NAME",
  "GITHUB_SERVER_URL",
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
  "runner-wait-ms",
  "queue-position",
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
  "resource-reason",
  "report-degraded",
  "report-validation-error",
  "peer-timeline"
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

const semaphoreActionEnv = {
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_REPOSITORY_ID: "101020635",
  GITHUB_REPOSITORY_OWNER_ID: "212056428",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_WORKFLOW: "Perf",
  GITHUB_JOB: "perf-benchmarks"
};

function accountIncident(overrides = {}) {
  const incident = {
    repository: "owner/repo",
    workflow: "Perf",
    job: "perf-benchmarks",
    runId: "123",
    runAttempt: "1",
    runUrl: "https://github.com/owner/repo/actions/runs/123",
    runnerId: "runner-a",
    reportedAt: "2026-06-06T00:01:00.000Z",
    reason: "unity-account-limit-20111",
    ...overrides
  };
  const evidenceDigest = crypto.createHash("sha256").update(JSON.stringify({
    repository: incident.repository,
    workflow: incident.workflow,
    job: incident.job,
    runId: incident.runId,
    runAttempt: incident.runAttempt,
    runnerId: incident.runnerId,
    reason: incident.reason
  })).digest("hex");
  return {
    ...incident,
    incidentId: `incident-${evidenceDigest.slice(0, 24)}`,
    evidenceDigest
  };
}

function assertIncidentRecoveryWorkflowContract(message) {
  const recoveryTarget =
    /dispatch ([^(]+?) \((\.github\/workflows\/[^)]+\.ya?ml)\) with operation=recover-incident/.exec(message);
  assert.ok(recoveryTarget, "incident denial must identify the proof-bearing recovery workflow and path");

  const [, workflowName, workflowPath] = recoveryTarget;
  const workflow = fs.readFileSync(path.join(__dirname, "..", workflowPath), "utf8");
  assert.match(workflow, new RegExp(`^name: ${workflowName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(workflow, /^\s{6}operation:\s*$/m);
  assert.match(workflow, /^\s{10}- recover-incident\s*$/m);
  assert.match(workflow, /^\s{6}incident-id:\s*$/m);
  assert.match(workflow, /^\s{6}portal-cleanup-confirmed:\s*$/m);
}

function accountHealthState(holders = [], queue = [], reservations = [], activeIncident = null) {
  return { ...lifecycleState(holders, queue, reservations), schemaVersion: 5, activeIncident };
}

function accountHealthFetchStore(initialState, options = {}) {
  let state = structuredClone(initialState);
  let writes = 0;
  const maxHolders = options.maxHolders || 1;

  return {
    fetch: async (url, request = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/o/r/git/ref/heads/lock-state") {
        return jsonResponse(200, { object: { sha: "branch" } });
      }
      if (parsed.pathname === SEMAPHORE_CONFIG_PATH) {
        return base64Content({
          maxHolders,
          runnerSerialization: true,
          resourceLifecycle: true,
          accountHealth: true,
          ...(options.releaseCooldownSeconds === undefined
            ? {}
            : { releaseCooldownSeconds: options.releaseCooldownSeconds })
        }, "cfg");
      }
      if (parsed.pathname === SEMAPHORE_STATE_PATH) {
        if (request.method === "PUT") {
          writes++;
          const proposed = JSON.parse(Buffer.from(JSON.parse(request.body).content, "base64").toString("utf8"));
          if (typeof options.rejectWrites === "function"
            ? options.rejectWrites(proposed, writes)
            : options.rejectWrites) {
            return jsonResponse(409, { message: "simulated cleanup conflict" });
          }
          state = options.afterWrite ? options.afterWrite(proposed, writes) : proposed;
          return jsonResponse(200, { content: { sha: `write-${writes}` } });
        }
        return base64Content(state, `read-${writes}`);
      }
      return jsonResponse(404, { message: `unexpected path ${parsed.pathname}` });
    },
    state: () => state,
    writes: () => writes
  };
}

// ---------------------------------------------------------------------------
// Peer timeline (issue #269): the release publishes redacted lock activity for
// the held session window so a consumer can correlate a session-phase casualty
// with peer holder activity without reading any raw log.
// ---------------------------------------------------------------------------

function timelineHolder(repository, runId, acquiredAt) {
  return {
    holderId: `${repository}:${runId}:perf-benchmarks:editmode`,
    repository,
    workflow: "Perf",
    job: "perf-benchmarks",
    runId,
    runAttempt: "1",
    runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
    queuedAt: acquiredAt,
    acquiredAt,
    expiresAt: "2999-01-01T00:00:00.000Z",
    runnerId: `${repository}-runner`
  };
}

function timelineSnapshot(time, { holders = [], reservations = [], incident = null } = {}) {
  return { time, holders, reservations, incident };
}

module.exports = {
  assert,
  childProcess,
  crypto,
  fs,
  path,
  acquire,
  acquirePollDelayMs,
  api,
  authorizeCaller,
  boundedRetryDelayMs,
  collectPeerTimeline,
  config,
  createAppJwt,
  createGitHubAppAuth,
  credential,
  dedupeQueueEntries,
  evaluateStale,
  installAcquireSignalCleanup,
  isRetryableResponse,
  normalizeState,
  parseReleaseReport,
  peerTimelineEvents,
  postCleanup,
  queueEntryIsFinished,
  readLockConfig,
  readState,
  readerCredential,
  readerCredentialRequired,
  release,
  releaseRetryApiOptions,
  reap,
  reapDeadlineBudgets,
  resolveCurrentJob,
  resolveReleaseReport,
  runCancellationCleanup,
  selectEligibleQueueEntries,
  workflowCommandData,
  writeState,
  testAppKeys,
  testAppPrivateKey,
  emptyState,
  jsonResponse,
  htmlResponse,
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
};
