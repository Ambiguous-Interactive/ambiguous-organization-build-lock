"use strict";

const fs = require("node:fs");

function oneLine(value) {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

function input(env, name) {
  return String(env[`INPUT_${name.toUpperCase()}`] || "").trim();
}

function writeOutput(env, name, value, appendFile = fs.appendFileSync) {
  if (!env.GITHUB_OUTPUT) {
    return;
  }
  appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
}

async function requireCurrentPrHead(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const appendFile = options.appendFile || fs.appendFileSync;
  const log = options.log || console.log;
  const eventName = String(env.GITHUB_EVENT_NAME || "").trim();
  const expectedHeadSha = input(env, "EXPECTED-HEAD-SHA");

  if (eventName !== "pull_request") {
    writeOutput(env, "is-current", "true", appendFile);
    writeOutput(env, "current-head-sha", expectedHeadSha, appendFile);
    log(`::notice::Current-head guard skipped for ${oneLine(eventName || "unknown")} event.`);
    return { isCurrent: true, currentHeadSha: expectedHeadSha };
  }

  const token = input(env, "GITHUB-TOKEN");
  const pullRequestNumber = input(env, "PULL-REQUEST-NUMBER");
  const repository = String(env.GITHUB_REPOSITORY || "").trim();
  const apiUrl = String(env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");

  if (!token) {
    throw new Error("github-token is required for pull request events");
  }
  if (!/^[1-9][0-9]*$/.test(pullRequestNumber)) {
    throw new Error("pull-request-number must be a positive integer for pull request events");
  }
  if (!/^[0-9a-f]{40}$/i.test(expectedHeadSha)) {
    throw new Error("expected-head-sha must be a full commit SHA for pull request events");
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  }

  const response = await fetchImpl(`${apiUrl}/repos/${repository}/pulls/${pullRequestNumber}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ambiguous-organization-build-lock-current-pr-head",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    signal: options.signal || AbortSignal.timeout(30_000)
  });
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
  writeOutput(env, "is-current", String(isCurrent), appendFile);
  writeOutput(env, "current-head-sha", currentHeadSha, appendFile);
  if (!isCurrent) {
    throw new Error(
      `Stale pull request run for ${expectedHeadSha}; pull request #${pullRequestNumber} now points to ${currentHeadSha}`
    );
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

module.exports = { oneLine, requireCurrentPrHead };
