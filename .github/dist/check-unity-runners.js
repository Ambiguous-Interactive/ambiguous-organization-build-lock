#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { api, createGitHubAppAuth } = require("./build-lock.js");

const AUTHORIZED_OWNER = "Ambiguous-Interactive";

function input(name) {
  return String(process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] || "").trim();
}

function requiredInput(name) {
  const value = input(name);
  if (!value) {
    throw new Error(`Missing required input: ${name}.`);
  }
  return value;
}

function maskSecret(value) {
  const escaped = String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(`::add-mask::${escaped}`);
}

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value)}\n`, "utf8");
  }
}

function appendSummary(line) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`, "utf8");
  }
}

function parseRequiredLabelSets(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_error) {
    throw new Error("required-label-sets must be a valid JSON array of non-empty label arrays.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("required-label-sets must contain at least one label array.");
  }

  return parsed.map((labels, index) => {
    if (!Array.isArray(labels) || labels.length === 0) {
      throw new Error(`required-label-sets[${index}] must be a non-empty label array.`);
    }
    const normalized = labels.map((label) => {
      if (typeof label !== "string" || !label.trim() || label !== label.trim()) {
        throw new Error(`required-label-sets[${index}] contains an invalid label.`);
      }
      return label.toLowerCase();
    });
    if (!normalized.includes("self-hosted")) {
      throw new Error(`required-label-sets[${index}] must include self-hosted.`);
    }
    if (new Set(normalized).size !== normalized.length) {
      throw new Error(`required-label-sets[${index}] must not contain duplicate labels.`);
    }
    return normalized;
  });
}

function validateRunnerInventoryPage(page) {
  if (
    !page ||
    !Number.isSafeInteger(page.total_count) ||
    page.total_count < 0 ||
    !Array.isArray(page.runners)
  ) {
    throw new Error("GitHub returned a malformed organization runner inventory response.");
  }
}

async function readAllOrganizationRunners(owner, getPage) {
  const runners = [];
  let pageNumber = 1;
  let expectedTotal = null;

  for (;;) {
    const path = `/orgs/${encodeURIComponent(owner)}/actions/runners?per_page=100&page=${pageNumber}`;
    const page = await getPage(path);
    validateRunnerInventoryPage(page);
    expectedTotal = page.total_count;
    runners.push(...page.runners);

    if (runners.length >= expectedTotal) {
      return runners;
    }
    if (page.runners.length === 0) {
      throw new Error("GitHub runner inventory pagination ended before total_count was satisfied.");
    }
    pageNumber += 1;
  }
}

function matchingOnlineRunners(runners, requiredLabels) {
  return runners.filter((runner) => {
    if (!runner || runner.status !== "online" || !Array.isArray(runner.labels)) {
      return false;
    }
    const labels = new Set(
      runner.labels
        .map((label) => (label && typeof label.name === "string" ? label.name.toLowerCase() : ""))
        .filter(Boolean)
    );
    return requiredLabels.every((label) => labels.has(label));
  });
}

async function execute() {
  const owner = input("owner") || AUTHORIZED_OWNER;
  if (owner !== AUTHORIZED_OWNER) {
    throw new Error(`owner is not authorized; expected ${AUTHORIZED_OWNER}.`);
  }
  const appId = requiredInput("reader-app-id");
  if (!/^[1-9][0-9]*$/.test(appId)) {
    throw new Error("reader-app-id must be a canonical positive decimal GitHub App ID.");
  }
  const privateKey = requiredInput("reader-app-private-key");
  maskSecret(privateKey);
  const requiredLabelSets = parseRequiredLabelSets(requiredInput("required-label-sets"));
  const auth = createGitHubAppAuth({
    appId,
    privateKey,
    owner,
    permissions: { organization_self_hosted_runners: "read" }
  });
  const runners = await readAllOrganizationRunners(owner, (path) => api("GET", path, undefined, auth));
  const onlineRunnerCount = runners.filter((runner) => runner && runner.status === "online").length;
  const matches = requiredLabelSets.map((labels) => ({
    labels,
    runners: matchingOnlineRunners(runners, labels).map((runner) => runner.name)
  }));
  const missing = matches.filter((match) => match.runners.length === 0);
  if (missing.length > 0) {
    throw new Error(
      `No online organization runner matches required label set(s): ${missing
        .map((match) => `[${match.labels.join(", ")}]`)
        .join("; ")}.`
    );
  }

  writeOutput("online-runner-count", onlineRunnerCount);
  writeOutput("matched-runners", JSON.stringify(matches));
  appendSummary(`Unity runner preflight passed: ${requiredLabelSets.length} required label set(s), ${onlineRunnerCount} online runner(s).`);
  console.log(`Unity runner preflight passed for ${requiredLabelSets.length} required label set(s).`);
  return { onlineRunnerCount, matches };
}

async function run() {
  try {
    await execute();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendSummary(`Unity runner preflight failed closed: ${message}`);
    console.error(`::error::Unity runner preflight failed closed: ${message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  execute,
  matchingOnlineRunners,
  parseRequiredLabelSets,
  readAllOrganizationRunners,
  run
};
