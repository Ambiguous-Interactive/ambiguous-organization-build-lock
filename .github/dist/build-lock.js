#!/usr/bin/env node
"use strict";

const fs = require("fs");

const API_ROOT = process.env.GITHUB_API_URL || "https://api.github.com";
const MODE = process.env.BUILD_LOCK_MODE || process.argv[2] || "acquire";
const SCHEMA_VERSION = 1;

function input(name, fallback = "") {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const value = process.env[key];
  return value === undefined || value === "" ? fallback : value;
}

function requireInput(name) {
  const value = input(name);
  if (!value) {
    throw new Error(`Missing required input: ${name}`);
  }
  return value;
}

function integerInput(name, fallback, minimum = 1) {
  const raw = input(name, String(fallback));
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`Input ${name} must be a positive integer.`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`Input ${name} must be >= ${minimum}.`);
  }
  return value;
}

function token() {
  const value = process.env.BUILD_LOCK_TOKEN || input("token");
  if (!value) {
    throw new Error("BUILD_LOCK_TOKEN is required.");
  }
  console.log(`::add-mask::${value}`);
  return value;
}

function validateLockName(lockName) {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(lockName)) {
    throw new Error(
      "lock-name must be 1-80 characters and contain only letters, digits, dot, underscore, or hyphen."
    );
  }
}

function parseRepository(fullName) {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(fullName);
  if (!match) {
    throw new Error(`Invalid repository name: ${fullName}`);
  }
  return { owner: match[1], repo: match[2] };
}

function nowIso() {
  return new Date().toISOString();
}

function parseTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms) {
  return ms + Math.floor(Math.random() * Math.max(250, Math.floor(ms / 3)));
}

function base64Encode(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function base64Decode(text) {
  return Buffer.from(text || "", "base64").toString("utf8");
}

function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  fs.appendFileSync(outputPath, `${name}=${String(value)}\n`, "utf8");
}

function appendSummary(line) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  fs.appendFileSync(summaryPath, `${line}\n`, "utf8");
}

async function api(method, path, body, authToken) {
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_error) {
      data = { message: text };
    }
  }

  if (!response.ok) {
    const error = new Error(
      `${method} ${path} failed with HTTP ${response.status}: ${data && data.message ? data.message : text}`
    );
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function ensureStateBranch(config) {
  const { owner, repo } = config.lockRepo;
  try {
    await api("GET", `/repos/${owner}/${repo}/git/ref/heads/${config.stateBranch}`, undefined, config.token);
    return;
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
  }

  const repoInfo = await api("GET", `/repos/${owner}/${repo}`, undefined, config.token);
  const defaultBranch = repoInfo.default_branch || "main";
  const defaultRef = await api(
    "GET",
    `/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`,
    undefined,
    config.token
  );

  try {
    await api(
      "POST",
      `/repos/${owner}/${repo}/git/refs`,
      {
        ref: `refs/heads/${config.stateBranch}`,
        sha: defaultRef.object.sha
      },
      config.token
    );
  } catch (error) {
    if (error.status !== 422) {
      throw error;
    }
  }
}

function emptyState(lockName) {
  return {
    schemaVersion: SCHEMA_VERSION,
    lock: lockName,
    holder: null,
    queue: [],
    updatedAt: nowIso()
  };
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  return {
    holderId: String(entry.holderId || ""),
    repository: String(entry.repository || ""),
    workflow: String(entry.workflow || ""),
    job: String(entry.job || ""),
    runId: String(entry.runId || ""),
    runAttempt: String(entry.runAttempt || ""),
    runUrl: String(entry.runUrl || ""),
    queuedAt: String(entry.queuedAt || entry.acquiredAt || nowIso())
  };
}

function normalizeHolder(holder) {
  const entry = normalizeEntry(holder);
  if (!entry) {
    return null;
  }
  return {
    ...entry,
    acquiredAt: String(holder.acquiredAt || nowIso()),
    expiresAt: String(holder.expiresAt || "")
  };
}

function normalizeState(raw, lockName) {
  const state = raw && typeof raw === "object" ? raw : emptyState(lockName);
  if (state.lock && state.lock !== lockName) {
    throw new Error(`State file lock mismatch: expected ${lockName}, found ${state.lock}`);
  }
  const queue = Array.isArray(state.queue)
    ? state.queue.map(normalizeEntry).filter((entry) => entry && entry.holderId)
    : [];
  const holder = normalizeHolder(state.holder);
  return {
    schemaVersion: SCHEMA_VERSION,
    lock: lockName,
    holder: holder && holder.holderId ? holder : null,
    queue,
    updatedAt: String(state.updatedAt || nowIso())
  };
}

function stableState(state) {
  return {
    schemaVersion: SCHEMA_VERSION,
    lock: state.lock,
    holder: state.holder
      ? {
          holderId: state.holder.holderId,
          repository: state.holder.repository,
          workflow: state.holder.workflow,
          job: state.holder.job,
          runId: state.holder.runId,
          runAttempt: state.holder.runAttempt,
          runUrl: state.holder.runUrl,
          queuedAt: state.holder.queuedAt,
          acquiredAt: state.holder.acquiredAt,
          expiresAt: state.holder.expiresAt
        }
      : null,
    queue: state.queue.map((entry) => ({
      holderId: entry.holderId,
      repository: entry.repository,
      workflow: entry.workflow,
      job: entry.job,
      runId: entry.runId,
      runAttempt: entry.runAttempt,
      runUrl: entry.runUrl,
      queuedAt: entry.queuedAt
    })),
    updatedAt: state.updatedAt
  };
}

function stringifyState(state) {
  return `${JSON.stringify(stableState(state), null, 2)}\n`;
}

async function readState(config) {
  const { owner, repo } = config.lockRepo;
  const encodedPath = config.statePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  try {
    const data = await api(
      "GET",
      `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(config.stateBranch)}`,
      undefined,
      config.token
    );
    const text = base64Decode(data.content);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Lock state JSON is malformed at ${config.statePath}: ${error.message}`);
    }
    return { state: normalizeState(parsed, config.lockName), sha: data.sha || null };
  } catch (error) {
    if (error.status === 404) {
      return { state: emptyState(config.lockName), sha: null };
    }
    throw error;
  }
}

async function writeState(config, previousSha, state, message) {
  const { owner, repo } = config.lockRepo;
  const encodedPath = config.statePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const body = {
    message,
    content: base64Encode(stringifyState({ ...state, updatedAt: nowIso() })),
    branch: config.stateBranch
  };
  if (previousSha) {
    body.sha = previousSha;
  }

  try {
    const data = await api(
      "PUT",
      `/repos/${owner}/${repo}/contents/${encodedPath}`,
      body,
      config.token
    );
    return { conflict: false, sha: data.content && data.content.sha ? data.content.sha : "" };
  } catch (error) {
    if (error.status === 409 || error.status === 422) {
      return { conflict: true, sha: "" };
    }
    throw error;
  }
}

function currentIdentity(config) {
  const repository = process.env.GITHUB_REPOSITORY || "unknown/unknown";
  const runId = process.env.GITHUB_RUN_ID || "0";
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT || "0";
  const workflow = process.env.GITHUB_WORKFLOW || "unknown";
  const job = process.env.GITHUB_JOB || "unknown";
  // Exclude runAttempt so a rerun of the same workflow run can release a lock
  // left by the previous attempt instead of queueing behind itself.
  const holderId = [repository, runId, job, config.holderIdSuffix].join(":");
  return {
    holderId,
    repository,
    workflow,
    job,
    runId,
    runAttempt,
    runUrl: `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${repository}/actions/runs/${runId}`,
    queuedAt: nowIso()
  };
}

function holderFromIdentity(identity, leaseMinutes) {
  const acquiredAt = nowIso();
  return {
    ...identity,
    acquiredAt,
    expiresAt: new Date(Date.parse(acquiredAt) + leaseMinutes * 60 * 1000).toISOString()
  };
}

async function getRunStatus(repository, runId, authToken) {
  const parsed = parseRepository(repository);
  try {
    const run = await api(
      "GET",
      `/repos/${parsed.owner}/${parsed.repo}/actions/runs/${encodeURIComponent(runId)}`,
      undefined,
      authToken
    );
    return {
      known: true,
      status: run.status || "",
      conclusion: run.conclusion || ""
    };
  } catch (error) {
    if (error.status === 403 || error.status === 404) {
      return { known: false, status: "", conclusion: "" };
    }
    throw error;
  }
}

async function evaluateStale(holder, authToken) {
  if (!holder) {
    return { stale: true, reason: "no holder" };
  }
  const status = await getRunStatus(holder.repository, holder.runId, authToken);
  if (status.known) {
    if (
      status.status === "queued" ||
      status.status === "in_progress" ||
      status.status === "requested" ||
      status.status === "waiting" ||
      status.status === "pending"
    ) {
      return { stale: false, reason: `holder run is ${status.status}` };
    }
    return { stale: true, reason: `holder run is ${status.status || "unknown"}` };
  }
  if (parseTime(holder.expiresAt) > 0 && parseTime(holder.expiresAt) < Date.now()) {
    return { stale: true, reason: "holder lease expired and run status is unavailable" };
  }
  return { stale: false, reason: "holder status unavailable before lease expiry" };
}

async function queueEntryIsFinished(entry, authToken) {
  const status = await getRunStatus(entry.repository, entry.runId, authToken);
  if (!status.known) {
    return false;
  }
  return !(
    status.status === "queued" ||
    status.status === "in_progress" ||
    status.status === "requested" ||
    status.status === "waiting" ||
    status.status === "pending"
  );
}

function queuePosition(state, holderId) {
  const index = state.queue.findIndex((entry) => entry.holderId === holderId);
  return index === -1 ? 0 : index + 1;
}

async function acquire(config) {
  validateLockName(config.lockName);
  await ensureStateBranch(config);
  const identity = currentIdentity(config);
  const started = Date.now();
  const deadline = started + config.timeoutMinutes * 60 * 1000;
  let attempts = 0;
  let staleRecovered = false;

  console.log(`::group::Acquire build lock ${config.lockName}`);
  console.log(`Lock repository: ${config.lockRepository}`);
  console.log(`Holder: ${identity.holderId}`);

  while (Date.now() < deadline) {
    attempts++;
    const { state, sha } = await readState(config);
    const stale = await evaluateStale(state.holder, config.token);
    let changed = false;

    const dedupedQueue = state.queue.filter((entry, index, queue) => {
      return entry.holderId && queue.findIndex((candidate) => candidate.holderId === entry.holderId) === index;
    });
    state.queue = [];
    for (const entry of dedupedQueue) {
      if (entry.holderId !== identity.holderId && (await queueEntryIsFinished(entry, config.token))) {
        console.log(`Dropping completed queue entry ${entry.holderId}.`);
        changed = true;
      } else {
        state.queue.push(entry);
      }
    }

    if (!state.queue.some((entry) => entry.holderId === identity.holderId)) {
      state.queue.push(identity);
      changed = true;
    }

    const position = queuePosition(state, identity.holderId);
    if (state.holder) {
      console.log(
        `Attempt ${attempts}: holder=${state.holder.holderId} run=${state.holder.runUrl} queue-position=${position} reason=${stale.reason}`
      );
    } else {
      console.log(`Attempt ${attempts}: lock is free queue-position=${position}`);
    }

    if ((!state.holder || stale.stale) && state.queue[0] && state.queue[0].holderId === identity.holderId) {
      if (state.holder && stale.stale) {
        staleRecovered = true;
        console.log(`Recovering stale holder: ${stale.reason}`);
      }
      state.holder = holderFromIdentity(identity, config.leaseMinutes);
      state.queue = state.queue.filter((entry) => entry.holderId !== identity.holderId);
      changed = true;
    }

    if (state.holder && state.holder.holderId === identity.holderId) {
      if (changed) {
        const write = await writeState(config, sha, state, `Acquire ${config.lockName}`);
        if (write.conflict) {
          await sleep(jitter(1000));
          continue;
        }
        const verified = await readState(config);
        if (!verified.state.holder || verified.state.holder.holderId !== identity.holderId) {
          await sleep(jitter(1000));
          continue;
        }
        const waitMs = Date.now() - started;
        writeOutput("acquired", "true");
        writeOutput("lock-name", config.lockName);
        writeOutput("holder-id", identity.holderId);
        writeOutput("state-sha", write.sha);
        writeOutput("wait-ms", String(waitMs));
        writeOutput("attempts", String(attempts));
        writeOutput("stale-recovered", String(staleRecovered));
        appendSummary(`Acquired ${config.lockName} after ${waitMs} ms and ${attempts} attempts.`);
        console.log(`Acquired ${config.lockName}.`);
        console.log("::endgroup::");
        return;
      }
    }

    if (changed) {
      const write = await writeState(config, sha, state, `Queue for ${config.lockName}`);
      if (write.conflict) {
        await sleep(jitter(1000));
        continue;
      }
    }

    await sleep(jitter(config.pollSeconds * 1000));
  }

  appendSummary(`Timed out waiting for ${config.lockName}.`);
  throw new Error(`Timed out waiting for build lock ${config.lockName}.`);
}

async function release(config) {
  validateLockName(config.lockName);
  await ensureStateBranch(config);
  const identity = currentIdentity(config);
  console.log(`::group::Release build lock ${config.lockName}`);

  for (let attempts = 1; attempts <= 10; attempts++) {
    const { state, sha } = await readState(config);
    const originalQueueLength = state.queue.length;
    state.queue = state.queue.filter((entry) => entry.holderId !== identity.holderId);
    let released = false;

    if (state.holder && state.holder.holderId === identity.holderId) {
      state.holder = null;
      released = true;
    } else if (state.holder) {
      console.log(`Lock is held by ${state.holder.holderId}; this run is ${identity.holderId}.`);
    } else {
      console.log("Lock is already free.");
    }

    const changed = released || state.queue.length !== originalQueueLength;
    if (!changed) {
      writeOutput("released", "false");
      writeOutput("lock-name", config.lockName);
      writeOutput("holder-id", identity.holderId);
      appendSummary(`No release needed for ${config.lockName}.`);
      console.log("::endgroup::");
      return;
    }

    const write = await writeState(config, sha, state, `Release ${config.lockName}`);
    if (write.conflict) {
      await sleep(jitter(1000));
      continue;
    }

    writeOutput("released", String(released));
    writeOutput("lock-name", config.lockName);
    writeOutput("holder-id", identity.holderId);
    writeOutput("state-sha", write.sha);
    appendSummary(`${released ? "Released" : "Cleaned queue entry for"} ${config.lockName}.`);
    console.log(`${released ? "Released" : "Cleaned queue entry for"} ${config.lockName}.`);
    console.log("::endgroup::");
    return;
  }

  throw new Error(`Failed to release ${config.lockName} after repeated CAS conflicts.`);
}

async function reap(config) {
  validateLockName(config.lockName);
  await ensureStateBranch(config);
  console.log(`::group::Reap stale build lock ${config.lockName}`);

  for (let attempts = 1; attempts <= 10; attempts++) {
    const { state, sha } = await readState(config);
    const beforeQueue = state.queue.length;
    const keptQueue = [];
    for (const entry of state.queue) {
      if (await queueEntryIsFinished(entry, config.token)) {
        console.log(`Dropping completed queue entry ${entry.holderId}.`);
      } else {
        keptQueue.push(entry);
      }
    }
    state.queue = keptQueue;

    let reaped = false;
    if (state.holder) {
      const stale = await evaluateStale(state.holder, config.token);
      if (stale.stale) {
        console.log(`Reaping holder ${state.holder.holderId}: ${stale.reason}.`);
        state.holder = null;
        reaped = true;
      } else {
        console.log(`Keeping holder ${state.holder.holderId}: ${stale.reason}.`);
      }
    }

    const changed = reaped || beforeQueue !== state.queue.length;
    if (!changed) {
      writeOutput("reaped", "false");
      appendSummary(`No stale state found for ${config.lockName}.`);
      console.log("::endgroup::");
      return;
    }

    const write = await writeState(config, sha, state, `Reap stale ${config.lockName}`);
    if (write.conflict) {
      await sleep(jitter(1000));
      continue;
    }

    writeOutput("reaped", String(reaped));
    writeOutput("state-sha", write.sha);
    appendSummary(`Reaped stale state for ${config.lockName}.`);
    console.log("::endgroup::");
    return;
  }

  throw new Error(`Failed to reap ${config.lockName} after repeated CAS conflicts.`);
}

function config() {
  const lockName = requireInput("lock-name");
  const lockRepository = input(
    "lock-repository",
    "Ambiguous-Interactive/ambiguous-organization-build-lock"
  );
  validateLockName(lockName);
  return {
    token: token(),
    lockName,
    holderIdSuffix: input("holder-id-suffix", "default"),
    lockRepository,
    lockRepo: parseRepository(lockRepository),
    stateBranch: input("state-branch", "lock-state"),
    statePath: `locks/${lockName}.json`,
    timeoutMinutes: integerInput("timeout-minutes", 180),
    leaseMinutes: integerInput("lease-minutes", 240),
    pollSeconds: integerInput("poll-seconds", 15)
  };
}

(async () => {
  try {
    const cfg = config();
    if (MODE === "acquire") {
      await acquire(cfg);
    } else if (MODE === "release") {
      await release(cfg);
    } else if (MODE === "reap") {
      await reap(cfg);
    } else {
      throw new Error(`Unknown BUILD_LOCK_MODE: ${MODE}`);
    }
  } catch (error) {
    console.log("::endgroup::");
    console.error(`::error::${error.message}`);
    appendSummary(`Build lock action failed: ${error.message}`);
    process.exit(1);
  }
})();
