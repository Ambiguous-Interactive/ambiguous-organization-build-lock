"use strict";

const fs = require("node:fs");
const { setTimeout: wait } = require("node:timers/promises");

const MAX_ATTEMPTS = 3;

function oneLine(value) {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

function input(env, name) {
  return String(env[`INPUT_${name.toUpperCase()}`] || "").trim();
}

function validRepository(value) {
  const [owner, repository, extra] = value.split("/");
  return extra === undefined &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner || "") &&
    !owner.includes("--") &&
    /^[A-Za-z0-9._-]{1,100}$/.test(repository || "");
}

function writeOutput(env, name, value, appendFile = fs.appendFileSync) {
  if (!env.GITHUB_OUTPUT) {
    return;
  }
  appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
}

function retryableResponse(response) {
  if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
    return true;
  }
  return response.status === 403 &&
    (response.headers?.get?.("retry-after") || response.headers?.get?.("x-ratelimit-remaining") === "0");
}

function retryDelay(response, attempt, now = Date.now()) {
  const retryAfterValue = response?.headers?.get?.("retry-after");
  if (typeof retryAfterValue === "string" && retryAfterValue.trim() !== "") {
    const normalized = retryAfterValue.trim();
    if (/^[0-9]+$/.test(normalized)) {
      return Math.min(10_000, Number(normalized) * 1_000);
    }
    if (/^[A-Za-z]/.test(normalized)) {
      const retryAfterDate = Date.parse(normalized);
      if (Number.isFinite(retryAfterDate)) {
        return Math.min(10_000, Math.max(0, retryAfterDate - now));
      }
    }
  }
  return 250 * 2 ** (attempt - 1);
}

async function discardResponse(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The response is already known to be retryable; body cleanup must not
    // replace the bounded fail-closed retry decision with a cleanup error.
  }
}

async function requireCurrentPrHead(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const appendFile = options.appendFile || fs.appendFileSync;
  const log = options.log || console.log;
  const eventName = String(env.GITHUB_EVENT_NAME || "").trim();
  const expectedHeadSha = input(env, "EXPECTED-HEAD-SHA");
  const pullRequestNumber = input(env, "PULL-REQUEST-NUMBER");
  const hasPullRequestInputs = Boolean(pullRequestNumber || expectedHeadSha);
  const isPullRequestEvent = eventName === "pull_request" || eventName === "pull_request_target";
  const shouldWriteOutputs = options.writeOutputs !== false;
  const shouldThrowOnStale = options.throwOnStale !== false;

  if (!isPullRequestEvent && !hasPullRequestInputs) {
    if (shouldWriteOutputs) {
      writeOutput(env, "is-current", "true", appendFile);
      writeOutput(env, "current-head-sha", expectedHeadSha, appendFile);
    }
    log(`::notice::Current-head guard skipped for ${oneLine(eventName || "unknown")} event.`);
    return { isCurrent: true, currentHeadSha: expectedHeadSha };
  }

  const token = input(env, "GITHUB-TOKEN");
  const repository = String(env.GITHUB_REPOSITORY || "").trim();
  const apiUrl = String(env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs === undefined ? 30_000 : options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const sleep = options.sleep || ((milliseconds) => wait(milliseconds, undefined, { signal }));

  if (!token) {
    throw new Error("github-token is required for pull request events");
  }
  if (!/^[1-9][0-9]*$/.test(pullRequestNumber)) {
    throw new Error("pull-request-number must be a positive integer for pull request events");
  }
  if (!/^[0-9a-f]{40}$/i.test(expectedHeadSha)) {
    throw new Error("expected-head-sha must be a full commit SHA for pull request events");
  }
  if (!validRepository(repository)) {
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  }

  let response;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      response = await fetchImpl(`${apiUrl}/repos/${repository}/pulls/${pullRequestNumber}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "ambiguous-organization-build-lock-current-pr-head",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        signal
      });
    } catch (error) {
      if (attempt === MAX_ATTEMPTS || signal.aborted || error?.name === "AbortError") {
        throw error;
      }
      await sleep(250 * 2 ** (attempt - 1));
      continue;
    }
    if (response.ok || !retryableResponse(response) || attempt === MAX_ATTEMPTS) {
      break;
    }
    await discardResponse(response);
    await sleep(retryDelay(response, attempt));
  }
  if (!response.ok) {
    throw new Error(`GitHub pull request lookup failed with HTTP ${response.status}`);
  }

  const pullRequest = await response.json();
  if (pullRequest?.state !== "open") {
    throw new Error(`Pull request #${pullRequestNumber} is not open`);
  }
  const currentHeadSha = String(pullRequest?.head?.sha || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(currentHeadSha)) {
    throw new Error("GitHub pull request response did not contain a full head SHA");
  }

  const isCurrent = currentHeadSha.toLowerCase() === expectedHeadSha.toLowerCase();
  if (shouldWriteOutputs) {
    writeOutput(env, "is-current", String(isCurrent), appendFile);
    writeOutput(env, "current-head-sha", currentHeadSha, appendFile);
  }
  if (!isCurrent && shouldThrowOnStale) {
    throw new Error(
      `Stale pull request run for ${expectedHeadSha}; pull request #${pullRequestNumber} now points to ${currentHeadSha}`
    );
  }

  if (!isCurrent) {
    return { isCurrent: false, currentHeadSha };
  }

  log(`::notice::Pull request #${pullRequestNumber} still points to this run's head SHA.`);
  return { isCurrent: true, currentHeadSha };
}

async function run() {
  try {
    await requireCurrentPrHead();
  } catch (error) {
    console.error(`::error::${oneLine(error instanceof Error ? error.message : error)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run();
}

module.exports = { oneLine, requireCurrentPrHead, retryDelay };
