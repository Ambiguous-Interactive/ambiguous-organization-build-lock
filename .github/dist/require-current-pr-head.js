"use strict";

const fs = require("node:fs");
const { performance } = require("node:perf_hooks");
const { setTimeout: wait } = require("node:timers/promises");

// The wall-clock budget is the real ceiling for transient upstream failures.
// The 2026-10-24 incident (issue #349) returned HTTP 503 for at least 40 seconds
// at two consumer checkpoints, while this action gave up after three rapid
// attempts in about five seconds. Pacing keeps re-reading the live head to the
// end of the budget instead of abandoning admission inside the outage window.
// MAX_ATTEMPTS is a backstop for injection callers whose sleep never advances
// real time; it can also end a run early while a fitting Retry-After shorter
// than about six seconds keeps repeating (nineteen waits of that length are
// still inside the budget), and that ending still names its attempt count and
// last failure like a deadline ending does.
const MAX_ATTEMPTS = 20;
const BACKOFF_BASE_MS = 250;
const MAX_BACKOFF_MS = 10_000;
const DEFAULT_RETRY_BUDGET_MS = 120_000;

function oneLine(value) {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

function workflowCommandData(value) {
  return oneLine(value).replace(/%/g, "%25");
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

function retryAfterDelay(response, now = Date.now()) {
  const retryAfterValue = response?.headers?.get?.("retry-after");
  if (typeof retryAfterValue === "string" && retryAfterValue.trim() !== "") {
    const normalized = retryAfterValue.trim();
    if (/^[0-9]+$/.test(normalized)) {
      return Number(normalized) * 1_000;
    }
    if (/^[A-Za-z]/.test(normalized)) {
      const retryAfterDate = Date.parse(normalized);
      if (Number.isFinite(retryAfterDate)) {
        return Math.max(0, retryAfterDate - now);
      }
    }
  }
  return null;
}

function generatedBackoffMs(attempt) {
  return Math.min(MAX_BACKOFF_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
}

function requestIdOf(response) {
  const id = oneLine(response?.headers?.get?.("x-github-request-id") || "");
  return id ? ` (request-id=${id})` : "";
}

function responseFailureDescription(response) {
  return `HTTP ${response.status}${requestIdOf(response)}`;
}

function retryBudgetExhaustedError(attempts, lastFailure, reasonParts) {
  const reason = reasonParts.length ? ` because ${reasonParts.join("; ")}` : "";
  const lastDescription = lastFailure?.description || "no response was received before the deadline";
  const error = new Error(
    `GitHub pull request lookup exhausted its bounded retry budget after ${attempts} attempt(s)` +
    `${reason}; last failure: ${lastDescription}.`
  );
  error.code = "GITHUB_API_RETRY_EXHAUSTED";
  error.retryable = true;
  error.attempts = attempts;
  error.status = lastFailure?.status;
  error.requestId = lastFailure?.requestId || "";
  return error;
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
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_RETRY_BUDGET_MS : options.timeoutMs;
  const monotonicNow = options.monotonicNow || (() => performance.now());
  const retryDeadline = monotonicNow() + timeoutMs;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
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
  let lastFailure = null;
  // A paced wait can be killed by the same budget that bounds the whole guard.
  // timers/promises rejects such a wait with a generic AbortError, so the
  // rejection is converted here: the budget kill becomes the named exhausted
  // diagnosis and a caller's cancellation keeps its own typed reason. The
  // guard's own timeout signal is read first, so a caller carrying a timeout
  // of its own is not misattributed to the guard's budget; if the caller and
  // the guard budget end in the same instant, the named budget diagnosis
  // deliberately wins over the caller's bare cancellation reason.
  const throwAfterFailedWait = (waitError, attempt) => {
    if (timeoutSignal.aborted) {
      throw retryBudgetExhaustedError(
        attempt,
        lastFailure,
        [`the bounded deadline elapsed (${oneLine(timeoutSignal.reason?.message || "timeout")})`]
      );
    }
    if (signal.aborted) {
      throw signal.reason ?? waitError;
    }
    throw waitError;
  };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1 && monotonicNow() >= retryDeadline) {
      throw retryBudgetExhaustedError(attempt - 1, lastFailure, ["the bounded deadline elapsed"]);
    }
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
      // The named attempt is the last completed one; a fetch killed by the
      // budget before its own response is described by the elapsed reason.
      if (timeoutSignal.aborted) {
        throw retryBudgetExhaustedError(
          attempt,
          lastFailure,
          [`the bounded deadline elapsed (${oneLine(timeoutSignal.reason?.message || "timeout")})`]
        );
      }
      if (signal.aborted) {
        throw signal.reason ?? error;
      }
      lastFailure = {
        status: undefined,
        requestId: "",
        description: `transport error: ${oneLine(error?.message || error)}`
      };
      // Caller-declared abort classes and a timeout named by the caller's own
      // fetch glue stay terminal on the current error. Acquire treats a PR
      // lookup timeout as a terminal validation failure, not cancellation.
      if (error?.name === "AbortError" || error?.name === "TimeoutError" || error?.code === "ABORT_ERR") {
        throw error;
      }
      if (attempt === MAX_ATTEMPTS) {
        throw retryBudgetExhaustedError(attempt, lastFailure, ["the attempt ceiling was reached"]);
      }
      const delay = Math.max(0, Math.min(generatedBackoffMs(attempt), retryDeadline - monotonicNow()));
      log(
        `::warning::GitHub pull request lookup failed before receiving a response; ` +
        `retrying in ${delay} ms (attempt ${attempt}; ${lastFailure.description}).`
      );
      try {
        await sleep(delay);
      } catch (waitError) {
        throwAfterFailedWait(waitError, attempt);
      }
      continue;
    }
    if (response.ok) {
      break;
    }
    lastFailure = {
      status: response.status,
      requestId: oneLine(response.headers?.get?.("x-github-request-id") || ""),
      description: responseFailureDescription(response)
    };
    if (attempt === MAX_ATTEMPTS) {
      await discardResponse(response);
      throw retryBudgetExhaustedError(attempt, lastFailure, ["the attempt ceiling was reached"]);
    }
    if (!retryableResponse(response)) {
      await discardResponse(response);
      throw new Error(`GitHub pull request lookup failed with HTTP ${response.status}`);
    }
    const remaining = retryDeadline - monotonicNow();
    const rawDelayMs = retryAfterDelay(response, Date.now());
    await discardResponse(response);
    if (rawDelayMs !== null && rawDelayMs >= remaining) {
      if (response.status === 403 || response.status === 429) {
        throw new Error(
          "GitHub pull request lookup was rate limited for longer than this guard's remaining retry budget"
        );
      }
      throw new Error(
        `GitHub pull request lookup received Retry-After longer than this guard's remaining retry budget ` +
        `(HTTP ${response.status})`
      );
    }
    const delay = Math.max(0, Math.min(rawDelayMs ?? generatedBackoffMs(attempt), remaining));
    log(
      `::warning::GitHub pull request lookup returned HTTP ${response.status}; ` +
      `retrying in ${delay} ms (attempt ${attempt}${requestIdOf(response)}).`
    );
    try {
      await sleep(delay);
    } catch (waitError) {
      throwAfterFailedWait(waitError, attempt);
    }
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
    console.error(`::error::${workflowCommandData(error instanceof Error ? error.message : error)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  MAX_ATTEMPTS,
  oneLine,
  requireCurrentPrHead,
  retryAfterDelay,
  workflowCommandData
};
