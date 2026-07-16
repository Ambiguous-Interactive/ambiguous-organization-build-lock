#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { api, createGitHubAppAuth } = require("./build-lock.js");

const AUTHORIZED_OWNER = "Ambiguous-Interactive";
const MAX_RUNNER_INVENTORY_PAGES = 10;

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
      if (
        typeof label !== "string" ||
        !label.trim() ||
        label !== label.trim() ||
        /[\u0000-\u001f\u007f]/.test(label)
      ) {
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

function parseRepository(value, owner) {
  const parts = String(value || "").split("/");
  if (parts.length !== 2 || parts[0] !== owner) {
    throw new Error(`repository owner is not authorized; expected ${owner}.`);
  }
  const repositoryName = parts[1];
  if (
    !repositoryName ||
    repositoryName === "." ||
    repositoryName === ".." ||
    !/^[A-Za-z0-9_.-]+$/.test(repositoryName)
  ) {
    throw new Error("repository must be a canonical owner/name GitHub repository identifier.");
  }
  return `${owner}/${repositoryName}`;
}

function validateRunnerGroupInventoryPage(page) {
  if (
    !page ||
    !Number.isSafeInteger(page.total_count) ||
    page.total_count < 0 ||
    !Array.isArray(page.runner_groups)
  ) {
    throw new Error("GitHub returned a malformed accessible runner-group inventory response.");
  }
}

function validateRunnerInventoryPage(page) {
  if (
    !page ||
    !Number.isSafeInteger(page.total_count) ||
    page.total_count < 0 ||
    !Array.isArray(page.runners)
  ) {
    throw new Error("GitHub returned a malformed runner-group runner inventory response.");
  }
}

async function readAllRunnerGroups(owner, repository, getPage, maxPages = MAX_RUNNER_INVENTORY_PAGES) {
  const runnerGroups = [];
  let pageNumber = 1;
  let expectedTotal = null;

  for (;;) {
    const path =
      `/orgs/${encodeURIComponent(owner)}/actions/runner-groups` +
      `?visible_to_repository=${encodeURIComponent(repository)}&per_page=100&page=${pageNumber}`;
    const page = await getPage(path);
    validateRunnerGroupInventoryPage(page);
    expectedTotal = page.total_count;
    runnerGroups.push(...page.runner_groups);

    if (runnerGroups.length >= expectedTotal) {
      return runnerGroups;
    }
    if (page.runner_groups.length === 0) {
      throw new Error("GitHub runner-group inventory pagination ended before total_count was satisfied.");
    }
    if (pageNumber >= maxPages) {
      throw new Error(`GitHub runner-group inventory pagination exceeded the ${maxPages}-page safety limit.`);
    }
    pageNumber += 1;
  }
}

async function readAllGroupRunners(owner, runnerGroupId, getPage, maxPages = MAX_RUNNER_INVENTORY_PAGES) {
  if (!Number.isSafeInteger(runnerGroupId) || runnerGroupId <= 0) {
    throw new Error("GitHub returned a malformed accessible runner-group identifier.");
  }
  const runners = [];
  let pageNumber = 1;
  let expectedTotal = null;

  for (;;) {
    const path =
      `/orgs/${encodeURIComponent(owner)}/actions/runner-groups/${runnerGroupId}/runners` +
      `?per_page=100&page=${pageNumber}`;
    const page = await getPage(path);
    validateRunnerInventoryPage(page);
    expectedTotal = page.total_count;
    runners.push(...page.runners);

    if (runners.length >= expectedTotal) {
      return runners;
    }
    if (page.runners.length === 0) {
      throw new Error("GitHub runner-group inventory pagination ended before total_count was satisfied.");
    }
    if (pageNumber >= maxPages) {
      throw new Error(`GitHub runner-group inventory pagination exceeded the ${maxPages}-page safety limit.`);
    }
    pageNumber += 1;
  }
}

async function readAccessibleOrganizationRunners(owner, repository, getPage) {
  const runnerGroups = await readAllRunnerGroups(owner, repository, getPage);
  if (runnerGroups.length === 0) {
    throw new Error(`GitHub returned no runner groups visible to ${repository}.`);
  }

  const runnersById = new Map();
  for (const group of runnerGroups) {
    if (!group || !Number.isSafeInteger(group.id) || group.id <= 0) {
      throw new Error("GitHub returned a malformed accessible runner-group identifier.");
    }
    const groupRunners = await readAllGroupRunners(owner, group.id, getPage);
    for (const runner of groupRunners) {
      if (!runner || !Number.isSafeInteger(runner.id) || runner.id <= 0) {
        throw new Error("GitHub returned a malformed runner in an accessible runner group.");
      }
      runnersById.set(runner.id, runner);
    }
  }
  return [...runnersById.values()];
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
  const repository = parseRepository(process.env.GITHUB_REPOSITORY, owner);
  const repositoryName = repository.slice(owner.length + 1);
  const requiredLabelSets = parseRequiredLabelSets(requiredInput("required-label-sets"));
  const appId = requiredInput("reader-app-id");
  if (!/^[1-9][0-9]*$/.test(appId)) {
    throw new Error("reader-app-id must be a canonical positive decimal GitHub App ID.");
  }
  const privateKey = requiredInput("reader-app-private-key");
  maskSecret(privateKey);
  const auth = createGitHubAppAuth({
    appId,
    privateKey,
    owner,
    permissions: { organization_self_hosted_runners: "read" }
  });
  const runners = await readAccessibleOrganizationRunners(owner, repositoryName, (path) =>
    api("GET", path, undefined, auth)
  );
  const onlineRunnerCount = runners.filter((runner) => runner && runner.status === "online").length;
  const matches = requiredLabelSets.map((labels) => ({
    labels,
    runners: matchingOnlineRunners(runners, labels).map((runner) => runner.name)
  }));
  const missing = matches.filter((match) => match.runners.length === 0);
  if (missing.length > 0) {
    throw new Error(
      `No accessible online organization runner matches required label set(s): ${missing
        .map((match) => `[${match.labels.join(", ")}]`)
        .join("; ")}.`
    );
  }

  writeOutput("online-runner-count", onlineRunnerCount);
  writeOutput("matched-runners", JSON.stringify(matches));
  appendSummary(
    `Unity runner preflight passed for ${repository}: ${requiredLabelSets.length} required label set(s), ${onlineRunnerCount} accessible online runner(s).`
  );
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
  parseRepository,
  readAccessibleOrganizationRunners,
  readAllGroupRunners,
  readAllRunnerGroups,
  run
};
