#!/usr/bin/env node
"use strict";

const fs = require("fs");
const crypto = require("crypto");

const API_ROOT = process.env.GITHUB_API_URL || "https://api.github.com";
const MODE = process.env.BUILD_LOCK_MODE || process.argv[2] || "acquire";
// Schema 2 replaces the single `holder` with a `holders` array. Schema 3 adds a
// physical runner identity. Schema 4 adds capacity-consuming lifecycle reservations.
// Each upgrade is activated by reviewed configuration and remains one-way so a
// configuration outage cannot weaken protections already present in state.
const DEFAULT_SCHEMA_VERSION = 2;
const MAX_SCHEMA_VERSION = 4;
const DEFAULT_MAX_HOLDERS = 1;
const MAX_HOLDERS_CAP = 64;
const DEFAULT_CONFIG_TTL_MS = 5 * 60 * 1000;
const DEFAULT_API_MAX_ATTEMPTS = 5;
const DEFAULT_API_RETRY_BASE_MS = 1000;
const DEFAULT_API_RETRY_MAX_MS = 10000;
const DEFAULT_AUTH_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_RELEASE_COOLDOWN_SECONDS = 6 * 60;
const APP_TOKEN_REFRESH_MS = 5 * 60 * 1000;
const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "requested", "waiting", "pending"]);

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

function booleanInput(name, fallback = false) {
  const raw = input(name, String(fallback)).trim().toLowerCase();
  if (raw !== "true" && raw !== "false") {
    throw new Error(`Input ${name} must be true or false.`);
  }
  return raw === "true";
}

function holderIdSuffixInput() {
  const value = input("holder-id-suffix", "default");
  if (value !== value.trim() || /[\r\n]/.test(value)) {
    throw new Error("Input holder-id-suffix must not have leading/trailing whitespace or line breaks.");
  }
  return value;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function maskSecret(value) {
  if (!value) {
    return;
  }
  const escaped = String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(`::add-mask::${escaped}`);
}

function createAppJwt(appId, privateKey, now = Date.now()) {
  const nowSeconds = Math.floor(now / 1000);
  const encodedHeader = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64Url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: String(appId) })
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  const jwt = `${signingInput}.${signature}`;
  return jwt;
}

function createGitHubAppAuth({ appId, privateKey, owner, now = () => Date.now() }) {
  const normalizedPrivateKey = String(privateKey).includes("\n")
    ? String(privateKey).trim()
    : String(privateKey).replace(/\\n/g, "\n").trim();
  let keyObject;
  try {
    keyObject = crypto.createPrivateKey(normalizedPrivateKey);
  } catch (_error) {
    throw new Error("BUILD_LOCK_APP_PRIVATE_KEY is not a valid private key.");
  }
  let installationId = null;
  let cachedToken = null;
  let sharedRefresh = null;

  async function jwtApi(method, path, body, signal) {
    return api(method, path, body, createAppJwt(appId, keyObject, now()), { maxAttempts: 3, signal });
  }

  async function lookupInstallation(signal) {
    const installation = await jwtApi(
      "GET",
      `/orgs/${encodeURIComponent(owner)}/installation`,
      undefined,
      signal
    );
    installationId = installation && installation.id;
    if (!installationId) {
      throw new Error(`GitHub App installation for organization ${owner} did not return an installation id.`);
    }
  }

  async function mintToken(signal) {
    if (!installationId) {
      await lookupInstallation(signal);
    }
    let result;
    try {
      result = await jwtApi("POST", `/app/installations/${installationId}/access_tokens`, {}, signal);
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
      installationId = null;
      await lookupInstallation(signal);
      result = await jwtApi("POST", `/app/installations/${installationId}/access_tokens`, {}, signal);
    }
    const expiresAt = Date.parse(result && result.expires_at);
    if (!result || !result.token || !Number.isFinite(expiresAt) || expiresAt <= now()) {
      throw new Error("GitHub App installation token response was missing a valid token or expiry.");
    }
    maskSecret(result.token);
    cachedToken = { value: result.token, expiresAt };
    return cachedToken.value;
  }

  function waitForRefresh(refresh, signal) {
    throwIfAborted(signal);
    refresh.waiters++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value, aborted = false) => {
        if (settled) {
          return;
        }
        settled = true;
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        refresh.waiters--;
        if (aborted && refresh.waiters === 0 && !refresh.controller.signal.aborted) {
          refresh.controller.abort(value);
        }
        callback(value);
      };
      const onAbort = () => finish(reject, abortReason(signal), true);
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      refresh.promise.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      );
    });
  }

  return {
    renewable: true,
    async getToken(options = {}) {
      throwIfAborted(options.signal);
      if (cachedToken && now() + APP_TOKEN_REFRESH_MS < cachedToken.expiresAt) {
        return cachedToken.value;
      }
      if (!sharedRefresh) {
        const refresh = { controller: new AbortController(), promise: null, waiters: 0 };
        refresh.promise = mintToken(refresh.controller.signal).finally(() => {
          if (sharedRefresh === refresh) {
            sharedRefresh = null;
          }
        });
        sharedRefresh = refresh;
      }
      return waitForRefresh(sharedRefresh, options.signal);
    },
    invalidateToken(rejectedToken) {
      if (cachedToken && cachedToken.value === rejectedToken) {
        cachedToken = null;
      }
    }
  };
}

function credential(lockRepo) {
  const appId = String(process.env.BUILD_LOCK_APP_ID || "").trim();
  const privateKey = process.env.BUILD_LOCK_APP_PRIVATE_KEY || "";
  const legacyToken = process.env.BUILD_LOCK_TOKEN || input("token");
  if (Boolean(appId) !== Boolean(privateKey)) {
    throw new Error("BUILD_LOCK_APP_ID and BUILD_LOCK_APP_PRIVATE_KEY must be provided together.");
  }
  if (appId && privateKey) {
    return createGitHubAppAuth({ appId, privateKey, owner: lockRepo.owner });
  }
  if (legacyToken) {
    maskSecret(legacyToken);
    return legacyToken;
  }
  throw new Error(
    "Provide BUILD_LOCK_APP_ID with BUILD_LOCK_APP_PRIVATE_KEY, or temporarily provide BUILD_LOCK_TOKEN."
  );
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

function sleep(ms, options = {}) {
  const signal = options.signal;
  if (signal && signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function abortReason(signal) {
  if (signal && signal.reason) {
    const reason = signal.reason;
    if (typeof reason === "object" && typeof reason.message === "string") {
      return reason;
    }
    const error = new Error(String(reason));
    error.name = "AbortError";
    return error;
  }
  const error = new Error("Operation aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    throw abortReason(signal);
  }
}

function isAbortError(error, signal) {
  return Boolean(
    (signal && signal.aborted) ||
      (error && (error.name === "AbortError" || error.name === "TimeoutError" || error.code === "ABORT_ERR"))
  );
}

function integerEnvironment(name, fallback, minimum = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!/^[0-9]+$/.test(raw)) {
    console.log(`::warning::Ignoring invalid ${name}=${raw}; expected an integer >= ${minimum}.`);
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < minimum) {
    console.log(`::warning::Ignoring invalid ${name}=${raw}; expected an integer >= ${minimum}.`);
    return fallback;
  }
  return value;
}

function apiRetryOptions(overrides = {}) {
  const retrySleep = overrides.sleep || sleep;
  const signal = overrides.signal;
  return {
    maxAttempts: integerEnvironment("BUILD_LOCK_API_MAX_ATTEMPTS", DEFAULT_API_MAX_ATTEMPTS, 1),
    baseDelayMs: integerEnvironment("BUILD_LOCK_API_RETRY_BASE_MS", DEFAULT_API_RETRY_BASE_MS),
    maxDelayMs: integerEnvironment("BUILD_LOCK_API_RETRY_MAX_MS", DEFAULT_API_RETRY_MAX_MS),
    ...overrides,
    sleep: (ms) => retrySleep(ms, { signal })
  };
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

function writeActionState(name, value) {
  const statePath = process.env.GITHUB_STATE;
  if (!statePath) {
    return;
  }
  fs.appendFileSync(statePath, `${name}=${String(value)}\n`, "utf8");
}

function appendSummary(line) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  fs.appendFileSync(summaryPath, `${line}\n`, "utf8");
}

function header(response, name) {
  return response && response.headers && typeof response.headers.get === "function"
    ? response.headers.get(name)
    : null;
}

function oneLine(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function retryAfterMs(response) {
  const value = header(response, "retry-after");
  if (!value) {
    return null;
  }
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.ceil(seconds * 1000));
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function isRateLimitResponse(response, data) {
  const message = String((data && data.message) || "").toLowerCase();
  return (
    header(response, "retry-after") !== null ||
    header(response, "x-ratelimit-remaining") === "0" ||
    message.includes("rate limit") ||
    message.includes("secondary rate limit")
  );
}

function isRetryableResponse(response, data) {
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    return true;
  }
  // GitHub intermittently rejects valid tokens with 401 "Bad credentials" (auth replica
  // lag); GitHub's guidance is to retry after a short delay. A 401 is rejected before the
  // request is processed, so retrying is also safe for mutations and cannot double-write.
  if (response.status === 401) {
    return true;
  }
  return response.status === 403 && isRateLimitResponse(response, data);
}

function isUnknownOutcomeMutationResponse(response) {
  return response.status === 408 || response.status >= 500;
}

function retryDelayMs(response, attempt, options) {
  const retryAfter = retryAfterMs(response);
  if (retryAfter !== null) {
    return Math.min(retryAfter, options.maxDelayMs);
  }
  const exponential = options.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(jitter(exponential), options.maxDelayMs);
}

function responseDetails(response, data, fallbackText = "") {
  const details = [];
  const message = oneLine(data && data.message ? data.message : fallbackText);
  if (message) {
    details.push(message);
  }
  const requestId = oneLine(header(response, "x-github-request-id"));
  if (requestId) {
    details.push(`request-id=${requestId}`);
  }
  const retryAfter = oneLine(header(response, "retry-after"));
  if (retryAfter) {
    details.push(`retry-after=${retryAfter}`);
  }
  return details.length ? details.join("; ") : "empty response body";
}

function httpError(method, path, response, data, text) {
  const error = new Error(
    `${method} ${path} failed with HTTP ${response.status}: ${responseDetails(response, data, text)}`
  );
  error.status = response.status;
  error.data = data;
  error.requestId = header(response, "x-github-request-id") || "";
  return error;
}

async function fetchApi(method, path, body, authToken, options = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: options.signal
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

  return { response, data, text };
}

async function api(method, path, body, authToken, options = {}) {
  const retry = apiRetryOptions(options);
  const mutationMethod = method === "PUT";
  let unknownOutcomeMutationFailure = false;
  let renewableRefreshUsed = false;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    try {
      throwIfAborted(retry.signal);
      let requestToken =
        authToken && typeof authToken.getToken === "function"
          ? await authToken.getToken({ signal: retry.signal })
          : authToken;
      let result = await fetchApi(method, path, body, requestToken, retry);
      if (
        result.response.status === 401 &&
        authToken &&
        authToken.renewable &&
        !renewableRefreshUsed &&
        typeof authToken.invalidateToken === "function"
      ) {
        renewableRefreshUsed = true;
        authToken.invalidateToken(requestToken);
        requestToken = await authToken.getToken({ signal: retry.signal });
        result = await fetchApi(method, path, body, requestToken, retry);
      }
      const { response, data, text } = result;
      if (response.ok) {
        return data;
      }

      if (attempt < retry.maxAttempts && isRetryableResponse(response, data)) {
        if (mutationMethod && isUnknownOutcomeMutationResponse(response)) {
          unknownOutcomeMutationFailure = true;
        }
        const delay = retryDelayMs(response, attempt, retry);
        throwIfAborted(retry.signal);
        console.log(
          `::warning::${method} ${path} returned HTTP ${response.status}; retrying in ${delay} ms ` +
            `(attempt ${attempt + 1}/${retry.maxAttempts}; ${responseDetails(response, data, text)}).`
        );
        await retry.sleep(delay);
        continue;
      }

      const error = httpError(method, path, response, data, text);
      if (unknownOutcomeMutationFailure && (response.status === 409 || response.status === 422)) {
        error.acceptedWriteAmbiguous = true;
      }
      throw error;
    } catch (error) {
      if (isAbortError(error, retry.signal)) {
        throw retry.signal && retry.signal.aborted ? abortReason(retry.signal) : error;
      }
      if (error.status || attempt >= retry.maxAttempts) {
        throw error;
      }
      if (mutationMethod) {
        unknownOutcomeMutationFailure = true;
      }
      const delay = retryDelayMs(null, attempt, retry);
      throwIfAborted(retry.signal);
      console.log(
        `::warning::${method} ${path} failed before receiving a response; retrying in ${delay} ms ` +
          `(attempt ${attempt + 1}/${retry.maxAttempts}; ${oneLine(error.message)}).`
      );
      await retry.sleep(delay);
    }
  }

  throw new Error(`${method} ${path} failed after ${retry.maxAttempts} attempts.`);
}

async function ensureStateBranch(config, options = {}) {
  const { owner, repo } = config.lockRepo;
  try {
    await api("GET", `/repos/${owner}/${repo}/git/ref/heads/${config.stateBranch}`, undefined, config.token, options.apiOptions);
    return;
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
  }

  const repoInfo = await api("GET", `/repos/${owner}/${repo}`, undefined, config.token, options.apiOptions);
  const defaultBranch = repoInfo.default_branch || "main";
  const defaultRef = await api(
    "GET",
    `/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`,
    undefined,
    config.token,
    options.apiOptions
  );

  try {
    await api(
      "POST",
      `/repos/${owner}/${repo}/git/refs`,
      {
        ref: `refs/heads/${config.stateBranch}`,
        sha: defaultRef.object.sha
      },
      config.token,
      options.apiOptions
    );
  } catch (error) {
    if (error.status !== 422) {
      throw error;
    }
  }
}

function emptyState(lockName, schemaVersion = DEFAULT_SCHEMA_VERSION) {
  return {
    schemaVersion,
    lock: lockName,
    holder: null,
    holders: [],
    queue: [],
    ...(schemaVersion >= 4 ? { reservations: [] } : {}),
    updatedAt: nowIso()
  };
}

function normalizeReservation(reservation) {
  if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) {
    return null;
  }
  const state = String(reservation.state || "");
  if (state !== "cooldown" && state !== "quarantine") {
    throw new Error(`Reservation ${String(reservation.reservationId || "<unknown>")} has invalid state ${JSON.stringify(state)}.`);
  }
  const normalized = {
    reservationId: String(reservation.reservationId || "").trim(),
    holderId: String(reservation.holderId || ""),
    repository: String(reservation.repository || ""),
    workflow: String(reservation.workflow || ""),
    job: String(reservation.job || ""),
    runId: String(reservation.runId || ""),
    runAttempt: String(reservation.runAttempt || ""),
    runUrl: String(reservation.runUrl || ""),
    runnerId: String(reservation.runnerId || "").trim(),
    state,
    reason: String(reservation.reason || ""),
    createdAt: String(reservation.createdAt || "")
  };
  if (
    !normalized.reservationId ||
    !normalized.holderId ||
    !normalized.repository ||
    !normalized.workflow ||
    !normalized.job ||
    !normalized.runId ||
    !normalized.runAttempt ||
    !normalized.runUrl ||
    !normalized.runnerId ||
    !normalized.reason ||
    !parseTime(normalized.createdAt)
  ) {
    throw new Error(
      "Schema 4 reservations require an ID, original holder/run metadata, runnerId, reason, and a valid createdAt."
    );
  }
  if (state === "cooldown") {
    normalized.availableAt = String(reservation.availableAt || "");
    if (!parseTime(normalized.availableAt) || parseTime(normalized.availableAt) <= parseTime(normalized.createdAt)) {
      throw new Error(`Cooldown reservation ${normalized.reservationId} requires availableAt after createdAt.`);
    }
  } else if (Object.hasOwn(reservation, "availableAt")) {
    throw new Error(`Quarantine reservation ${normalized.reservationId} must not define availableAt.`);
  }
  return normalized;
}

function normalizeEntry(entry, schemaVersion = DEFAULT_SCHEMA_VERSION) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const normalized = {
    holderId: String(entry.holderId || ""),
    repository: String(entry.repository || ""),
    workflow: String(entry.workflow || ""),
    job: String(entry.job || ""),
    runId: String(entry.runId || ""),
    runAttempt: String(entry.runAttempt || ""),
    runUrl: String(entry.runUrl || ""),
    queuedAt: String(entry.queuedAt || entry.acquiredAt || nowIso())
  };
  if (schemaVersion >= 3) {
    normalized.runnerId = String(entry.runnerId || "").trim();
    if (!normalized.runnerId) {
      throw new Error(`Schema ${schemaVersion} entry ${normalized.holderId || "<unknown>"} is missing runnerId.`);
    }
  }
  return normalized;
}

function normalizeHolder(holder, schemaVersion = DEFAULT_SCHEMA_VERSION) {
  const entry = normalizeEntry(holder, schemaVersion);
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
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`State file for ${lockName} must contain a JSON object.`);
  }
  const state = raw;
  if (state.lock !== lockName) {
    throw new Error(`State file lock mismatch: expected ${lockName}, found ${state.lock}`);
  }
  const parsedSchemaVersion = state.schemaVersion === undefined ? 1 : Number(state.schemaVersion);
  if (!Number.isInteger(parsedSchemaVersion) || parsedSchemaVersion < 1 || parsedSchemaVersion > MAX_SCHEMA_VERSION) {
    throw new Error(
      `State file schema ${String(state.schemaVersion)} for ${lockName} is unsupported; ` +
        `expected an integer from 1 through ${MAX_SCHEMA_VERSION}.`
    );
  }
  const schemaVersion = parsedSchemaVersion >= 3 ? parsedSchemaVersion : DEFAULT_SCHEMA_VERSION;
  if (state.queue !== undefined && !Array.isArray(state.queue)) {
    throw new Error(`State file queue for ${lockName} must be an array.`);
  }
  if (parsedSchemaVersion >= 2 && !Array.isArray(state.holders)) {
    throw new Error(`State file holders for schema ${parsedSchemaVersion} must be an array.`);
  }
  if (parsedSchemaVersion >= 2 && !Object.hasOwn(state, "holder")) {
    throw new Error(`State file for schema ${parsedSchemaVersion} must contain the legacy holder mirror.`);
  }
  if (parsedSchemaVersion >= 4 && !Array.isArray(state.reservations)) {
    throw new Error(`State file reservations for schema ${parsedSchemaVersion} must be an array.`);
  }
  if (
    parsedSchemaVersion >= 4 &&
    state.reservations.some(
      (reservation) =>
        !reservation ||
        typeof reservation !== "object" ||
        Array.isArray(reservation) ||
        !String(reservation.reservationId || "").trim()
    )
  ) {
    throw new Error(`Schema 4 reservations for ${lockName} must be objects with a non-empty reservationId.`);
  }
  if (parsedSchemaVersion === 1 && !Object.hasOwn(state, "holder")) {
    throw new Error(`Schema 1 state for ${lockName} must contain a holder field.`);
  }
  const rawHolders = Array.isArray(state.holders) ? state.holders : [];
  const rawQueue = Array.isArray(state.queue) ? state.queue : [];
  for (const [kind, entries] of [["holder", rawHolders], ["queue", rawQueue]]) {
    if (entries.some((entry) => !entry || typeof entry !== "object" || !String(entry.holderId || "").trim())) {
      throw new Error(`${kind} entries for ${lockName} must be objects with a non-empty holderId.`);
    }
  }
  if (
    state.holder !== undefined &&
    state.holder !== null &&
    (typeof state.holder !== "object" || !String(state.holder.holderId || "").trim())
  ) {
    throw new Error(`Legacy holder for ${lockName} must be null or an object with a non-empty holderId.`);
  }
  if (parsedSchemaVersion >= 2) {
    const mirrorFields = [
      "holderId", "repository", "workflow", "job", "runId", "runAttempt", "runUrl",
      "queuedAt", "acquiredAt", "expiresAt", ...(schemaVersion >= 3 ? ["runnerId"] : [])
    ];
    const mirrorMatches = rawHolders.length
      ? state.holder && mirrorFields.every((field) => String(state.holder[field] || "") === String(rawHolders[0][field] || ""))
      : state.holder === null;
    if (!mirrorMatches) {
      throw new Error(`Legacy holder mirror for ${lockName} must match the first holder or be null when empty.`);
    }
  }
  const rawHolderIds = rawHolders.map((holder) => String((holder && holder.holderId) || "")).filter(Boolean);
  if (new Set(rawHolderIds).size !== rawHolderIds.length) {
    throw new Error(`State file holders for ${lockName} contain duplicate holderId values.`);
  }
  const queue = Array.isArray(state.queue)
    ? state.queue.map((entry) => normalizeEntry(entry, schemaVersion)).filter((entry) => entry && entry.holderId)
    : [];
  const reservations = schemaVersion >= 4
    ? state.reservations.map(normalizeReservation)
    : [];
  // Merge the schema-2 holders array with the legacy/mirrored single holder and dedupe;
  // schema-1 files carry only `holder`, schema-2 files mirror holders[0] into `holder`.
  const seenHolderIds = new Set();
  const holders = [...(Array.isArray(state.holders) ? state.holders : []), state.holder]
    .map((holder) => normalizeHolder(holder, schemaVersion))
    .filter((holder) => holder && holder.holderId)
    .filter((holder) => {
      if (seenHolderIds.has(holder.holderId)) {
        return false;
      }
      seenHolderIds.add(holder.holderId);
      return true;
    });
  if (schemaVersion >= 3) {
    const activeRunnerIds = holders.map((holder) => holder.runnerId);
    if (new Set(activeRunnerIds).size !== activeRunnerIds.length) {
      throw new Error(`Schema 3 state for ${lockName} contains multiple active holders on one runnerId.`);
    }
    const queueHolderIds = queue.map((entry) => entry.holderId);
    if (new Set(queueHolderIds).size !== queueHolderIds.length) {
      throw new Error(`Schema 3 queue for ${lockName} contains duplicate holderId values.`);
    }
  }
  if (schemaVersion >= 4) {
    const reservationIds = reservations.map((reservation) => reservation.reservationId);
    if (new Set(reservationIds).size !== reservationIds.length) {
      throw new Error(`Schema 4 reservations for ${lockName} contain duplicate reservationId values.`);
    }
    const reservedRunnerIds = reservations.map((reservation) => reservation.runnerId);
    if (new Set(reservedRunnerIds).size !== reservedRunnerIds.length) {
      throw new Error(`Schema 4 state for ${lockName} contains multiple reservations on one runnerId.`);
    }
    const holderRunnerIds = new Set(holders.map((holder) => holder.runnerId));
    if (reservations.some((reservation) => holderRunnerIds.has(reservation.runnerId))) {
      throw new Error(`Schema 4 state for ${lockName} contains a runnerId as both holder and reservation.`);
    }
  }
  return {
    schemaVersion,
    lock: lockName,
    holders,
    queue,
    ...(schemaVersion >= 4 ? { reservations } : {}),
    updatedAt: String(state.updatedAt || nowIso())
  };
}

function stableState(state) {
  const schemaVersion = state.schemaVersion >= 3 ? state.schemaVersion : DEFAULT_SCHEMA_VERSION;
  const holders = state.holders.map((holder) => ({
    holderId: holder.holderId,
    repository: holder.repository,
    workflow: holder.workflow,
    job: holder.job,
    runId: holder.runId,
    runAttempt: holder.runAttempt,
    runUrl: holder.runUrl,
    queuedAt: holder.queuedAt,
    acquiredAt: holder.acquiredAt,
    expiresAt: holder.expiresAt,
    ...(schemaVersion >= 3 ? { runnerId: holder.runnerId } : {})
  }));
  return {
    schemaVersion,
    lock: state.lock,
    // Legacy mirror: pre-semaphore clients read `holder` and wait while it is set. They
    // can only under-admit, never over-admit; see the max-holders rollout note in README.
    holder: holders[0] || null,
    holders,
    queue: state.queue.map((entry) => ({
      holderId: entry.holderId,
      repository: entry.repository,
      workflow: entry.workflow,
      job: entry.job,
      runId: entry.runId,
      runAttempt: entry.runAttempt,
      runUrl: entry.runUrl,
      queuedAt: entry.queuedAt,
      ...(schemaVersion >= 3 ? { runnerId: entry.runnerId } : {})
    })),
    ...(schemaVersion >= 4 ? { reservations: state.reservations.map((reservation) => ({ ...reservation })) } : {}),
    updatedAt: state.updatedAt
  };
}

function stringifyState(state) {
  return `${JSON.stringify(stableState(state), null, 2)}\n`;
}

async function readState(config, options = {}) {
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
      config.token,
      options.apiOptions
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

async function writeState(config, previousSha, state, message, options = {}) {
  const { owner, repo } = config.lockRepo;
  const encodedPath = config.statePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const nextState = { ...state, updatedAt: nowIso() };
  const body = {
    message,
    content: base64Encode(stringifyState(nextState)),
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
      config.token,
      options.apiOptions
    );
    return { conflict: false, sha: data.content && data.content.sha ? data.content.sha : "" };
  } catch (error) {
    if (error.status === 409 || error.status === 422) {
      return { conflict: true, sha: "", ambiguous: Boolean(error.acceptedWriteAmbiguous) };
    }
    throw error;
  }
}

function normalizeMaxHolders(raw, sourcePath) {
  if (raw === undefined || raw === null) {
    return DEFAULT_MAX_HOLDERS;
  }
  const value =
    typeof raw === "string" && /^[0-9]+$/.test(raw.trim()) ? Number.parseInt(raw.trim(), 10) : raw;
  if (!Number.isInteger(value) || value < 1 || value > MAX_HOLDERS_CAP) {
    console.log(
      `::warning::Ignoring invalid maxHolders=${JSON.stringify(raw)} in ${sourcePath}; ` +
        `expected an integer between 1 and ${MAX_HOLDERS_CAP}. Using max-holders=${DEFAULT_MAX_HOLDERS}.`
    );
    return DEFAULT_MAX_HOLDERS;
  }
  return value;
}

function normalizeBooleanConfig(raw, name, sourcePath) {
  if (raw === undefined || raw === null) {
    return false;
  }
  if (typeof raw !== "boolean") {
    console.log(
      `::warning::Ignoring invalid ${name}=${JSON.stringify(raw)} in ${sourcePath}; expected a boolean; ` +
        `using safe defaults (${defaultLockConfigSummary()}).`
    );
    return null;
  }
  return raw;
}

function normalizeReleaseCooldownSeconds(raw, sourcePath) {
  if (raw === undefined || raw === null) {
    return DEFAULT_RELEASE_COOLDOWN_SECONDS;
  }
  if (!Number.isInteger(raw) || raw < 1 || raw > 86400) {
    console.log(
      `::warning::Ignoring invalid releaseCooldownSeconds=${JSON.stringify(raw)} in ${sourcePath}; ` +
        `expected an integer between 1 and 86400. Using ${DEFAULT_RELEASE_COOLDOWN_SECONDS}.`
    );
    return DEFAULT_RELEASE_COOLDOWN_SECONDS;
  }
  return raw;
}

function defaultLockConfig() {
  return {
    maxHolders: DEFAULT_MAX_HOLDERS,
    runnerSerialization: false,
    resourceLifecycle: false,
    releaseCooldownSeconds: DEFAULT_RELEASE_COOLDOWN_SECONDS
  };
}

function defaultLockConfigSummary() {
  return (
    `max-holders=${DEFAULT_MAX_HOLDERS}, runner-serialization=false, ` +
    `resource-lifecycle=false, release-cooldown-seconds=${DEFAULT_RELEASE_COOLDOWN_SECONDS}`
  );
}

function configReadCanFailClosed(error, options = {}) {
  if (isAbortError(error, options.apiOptions && options.apiOptions.signal)) {
    return false;
  }
  return (
    !error.status ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 408 ||
    error.status === 429 ||
    error.status >= 500
  );
}

// Per-lock parallelism lives in locks/<lock-name>.config.json on the lock repository's
// DEFAULT branch (not the state branch): one PR-reviewable source of truth for every
// consumer repo. Missing or invalid config fails closed to a single holder, which can
// never over-run a license.
async function readLockConfig(config, options = {}) {
  const { owner, repo } = config.lockRepo;
  const configPath = config.configPath || `locks/${config.lockName}.config.json`;
  const encodedPath = configPath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  let data;
  try {
    data = await api("GET", `/repos/${owner}/${repo}/contents/${encodedPath}`, undefined, config.token, options.apiOptions);
  } catch (error) {
    if (error.status === 404) {
      return defaultLockConfig();
    }
    if (configReadCanFailClosed(error, options)) {
      console.log(
        `::warning::Unable to read lock config at ${configPath}: ${oneLine(error.message)}; ` +
          `using safe defaults (${defaultLockConfigSummary()}).`
      );
      return defaultLockConfig();
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(base64Decode(data.content));
  } catch (error) {
    console.log(
      `::warning::Lock config at ${configPath} is not valid JSON (${oneLine(error.message)}); ` +
        `using safe defaults (${defaultLockConfigSummary()}).`
    );
    return defaultLockConfig();
  }
  const runnerSerialization = normalizeBooleanConfig(
    parsed && parsed.runnerSerialization,
    "runnerSerialization",
    configPath
  );
  if (runnerSerialization === null) {
    return defaultLockConfig();
  }
  const resourceLifecycle = normalizeBooleanConfig(parsed && parsed.resourceLifecycle, "resourceLifecycle", configPath);
  if (resourceLifecycle === null) {
    return defaultLockConfig();
  }
  if (resourceLifecycle && !runnerSerialization) {
    console.log(
      `::warning::Ignoring resourceLifecycle=true in ${configPath}; runnerSerialization must also be true; ` +
        `using safe defaults (${defaultLockConfigSummary()}).`
    );
    return defaultLockConfig();
  }
  return {
    maxHolders: normalizeMaxHolders(parsed && parsed.maxHolders, configPath),
    runnerSerialization,
    resourceLifecycle,
    releaseCooldownSeconds: normalizeReleaseCooldownSeconds(parsed && parsed.releaseCooldownSeconds, configPath)
  };
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
    runnerId: String(config.runnerId || "").trim(),
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

function selectEligibleQueueEntries(holders, queue, freeSlots) {
  if (freeSlots <= 0) {
    return [];
  }
  const occupiedRunnerIds = new Set(holders.map((holder) => holder.runnerId));
  const selected = [];
  for (const entry of queue) {
    if (selected.length >= freeSlots) {
      break;
    }
    if (!occupiedRunnerIds.has(entry.runnerId)) {
      selected.push(entry);
      occupiedRunnerIds.add(entry.runnerId);
    }
  }
  return selected;
}

function identityIsNewer(existing, incoming, context) {
  if (!/^[1-9][0-9]*$/.test(existing.runAttempt) || !/^[1-9][0-9]*$/.test(incoming.runAttempt)) {
    throw new Error(
      `${context} ${incoming.holderId} has invalid run attempts ` +
        `(stored=${JSON.stringify(existing.runAttempt)}, incoming=${JSON.stringify(incoming.runAttempt)}); ` +
        "expected positive decimal integers."
    );
  }
  const storedAttempt = BigInt(existing.runAttempt);
  const incomingAttempt = BigInt(incoming.runAttempt);
  if (incomingAttempt < storedAttempt) {
    return {
      compatible: false,
      newer: false,
      reason:
        `${context} ${incoming.holderId} is already owned by newer run attempt ${existing.runAttempt}; ` +
        `refusing stale attempt ${incoming.runAttempt}.`
    };
  }
  if (incomingAttempt === storedAttempt && existing.runnerId !== incoming.runnerId) {
    return {
      compatible: false,
      newer: false,
      reason:
        `${context} ${incoming.holderId} is already assigned to runner ${existing.runnerId} for this run attempt; ` +
        `refusing conflicting identity from ${incoming.runnerId}.`
    };
  }
  return { compatible: true, newer: incomingAttempt > storedAttempt, reason: "" };
}

function identityIsNewerOrThrow(existing, incoming, context) {
  const comparison = identityIsNewer(existing, incoming, context);
  if (!comparison.compatible) {
    throw new Error(comparison.reason);
  }
  return comparison.newer;
}

function isActiveRunStatus(status) {
  return ACTIVE_RUN_STATUSES.has(status || "");
}

async function getRunStatus(repository, runId, authToken, options = {}) {
  const parsed = parseRepository(repository);
  try {
    const run = await api(
      "GET",
      `/repos/${parsed.owner}/${parsed.repo}/actions/runs/${encodeURIComponent(runId)}`,
      undefined,
      authToken,
      options.apiOptions
    );
    return {
      known: true,
      status: run.status || "",
      conclusion: run.conclusion || ""
    };
  } catch (error) {
    if (error.status === 404) {
      try {
        await api("GET", `/repos/${parsed.owner}/${parsed.repo}`, undefined, authToken, options.apiOptions);
      } catch (repoError) {
        if (repoError.status === 403 || repoError.status === 404) {
          throw new Error(
            `Unable to verify repository access for ${repository}. Ensure the build-lock credentials can read this repository and have actions: read access. ${repoError.message}`
          );
        }
        throw repoError;
      }
      return { known: false, status: "", conclusion: "" };
    }
    if (error.status === 403) {
      throw new Error(
        `Unable to read workflow run ${repository}/${runId}. Ensure the build-lock credentials have actions: read access. ${error.message}`
      );
    }
    // A 401 on this READ-ONLY holder-status poll is almost always transient: a brief GitHub
    // auth blip, or the polling token reaching its TTL during a long wait (the central lock
    // serializes every build, so a queued run can poll for longer than an installation token
    // lives). Aborting here nukes an otherwise-healthy wait and drops the queue slot. Report
    // the status as UNKNOWN so evaluateStale's lease-governed path keeps waiting and only
    // reclaims once the holder's lease actually expires; a genuinely dead token still fails
    // fast on the next CAS write (acquire/reclaim), where it cannot be worked around.
    if (error.status === 401) {
      console.log(
        `::warning::Holder-status poll for ${repository}/${runId} returned HTTP 401 ` +
          `(${oneLine(error.message)}); treating holder status as unknown and continuing to wait ` +
          `under the existing lease. Verify the build-lock credential permissions if this persists.`
      );
      return { known: false, status: "", conclusion: "" };
    }
    throw error;
  }
}

async function evaluateStale(holder, authToken, options = {}) {
  if (!holder) {
    return { stale: true, reason: "no holder" };
  }
  const status = await getRunStatus(holder.repository, holder.runId, authToken, options);
  if (status.known) {
    if (isActiveRunStatus(status.status)) {
      return { stale: false, reason: `holder run is ${status.status}` };
    }
    return { stale: true, reason: `holder run is ${status.status || "unknown"}` };
  }
  if (parseTime(holder.expiresAt) > 0 && parseTime(holder.expiresAt) < Date.now()) {
    return { stale: true, reason: "holder lease expired and run status is unavailable" };
  }
  return { stale: false, reason: "holder status unavailable before lease expiry" };
}

async function queueEntryIsFinished(entry, authToken, options = {}) {
  const status = await getRunStatus(entry.repository, entry.runId, authToken, options);
  if (!status.known) {
    return false;
  }
  return !isActiveRunStatus(status.status);
}

function queuePosition(state, holderId) {
  const index = state.queue.findIndex((entry) => entry.holderId === holderId);
  return index === -1 ? 0 : index + 1;
}

function pruneExpiredCooldowns(state, now = Date.now()) {
  if (state.schemaVersion < 4) {
    return [];
  }
  const expired = state.reservations.filter(
    (reservation) => reservation.state === "cooldown" && parseTime(reservation.availableAt) <= now
  );
  if (expired.length) {
    const expiredIds = new Set(expired.map((reservation) => reservation.reservationId));
    state.reservations = state.reservations.filter((reservation) => !expiredIds.has(reservation.reservationId));
  }
  return expired;
}

function reservationFromHolder(holder, state, reason, releaseCooldownSeconds = DEFAULT_RELEASE_COOLDOWN_SECONDS) {
  const createdAt = nowIso();
  return {
    reservationId: crypto.randomUUID(),
    holderId: holder.holderId,
    repository: holder.repository,
    workflow: holder.workflow,
    job: holder.job,
    runId: holder.runId,
    runAttempt: holder.runAttempt,
    runUrl: holder.runUrl,
    runnerId: holder.runnerId,
    state,
    reason,
    createdAt,
    ...(state === "cooldown"
      ? { availableAt: new Date(Date.parse(createdAt) + releaseCooldownSeconds * 1000).toISOString() }
      : {})
  };
}

function cleanupResultName(result) {
  if (result.reservationState === "cooldown") {
    return "cooldown-started";
  }
  if (result.reservationState === "quarantine") {
    return "quarantined";
  }
  if (result.released) {
    return "released";
  }
  if (result.queueCleaned) {
    return "queue-cleaned";
  }
  return "noop";
}

function explicitReleaseMessage(cleanupResult, lockName) {
  if (cleanupResult === "cooldown-started") {
    return `Removed lock ownership for ${lockName}; resource capacity entered cooldown.`;
  }
  if (cleanupResult === "quarantined") {
    return `Removed lock ownership for ${lockName}; resource capacity is quarantined.`;
  }
  if (cleanupResult === "released") {
    return `Released ${lockName}.`;
  }
  if (cleanupResult === "queue-cleaned") {
    return `Cleaned queued request for ${lockName}.`;
  }
  return `No release needed for ${lockName}.`;
}

function writeReleaseOutputs(config, identity, result) {
  writeOutput("released", String(result.released));
  writeOutput("queue-cleaned", String(result.queueCleaned));
  writeOutput("cleanup-result", cleanupResultName(result));
  writeOutput("lock-name", config.lockName);
  writeOutput("holder-id", identity.holderId);
  writeOutput("state-sha", result.sha || "");
  writeOutput("held-by", result.heldBy || "");
  writeOutput("held-by-run-url", result.heldByRunUrl || "");
  writeOutput("reservation-id", result.reservationId || "");
  writeOutput("reservation-state", result.reservationState || "");
  writeOutput("available-at", result.availableAt || "");
}

function firstHolderContext(holders) {
  const holder = holders[0];
  return {
    heldBy: holder ? holder.holderId : "",
    heldByRunUrl: holder ? holder.runUrl : ""
  };
}

async function cleanupIdentity(config, identity, options = {}) {
  const maxAttempts = options.maxAttempts || 10;
  const conflictDelayMs = options.conflictDelayMs === undefined ? 1000 : options.conflictDelayMs;
  let ambiguousCleanup = null;

  const reconcileAmbiguousCleanup = (current, state, sha, heldBy, heldByRunUrl) => {
    if (!ambiguousCleanup || current.reservationId) {
      return current;
    }
    const reconciled = {
      ...current,
      released: current.released || ambiguousCleanup.released,
      queueCleaned: current.queueCleaned || ambiguousCleanup.queueCleaned,
      sha,
      heldBy,
      heldByRunUrl
    };
    if (state.schemaVersion >= 4 && ambiguousCleanup.reservationId) {
      const persistedReservation = state.reservations.find(
        (candidate) => candidate.reservationId === ambiguousCleanup.reservationId
      ) || state.reservations.find(
        (candidate) => candidate.holderId === identity.holderId && candidate.runnerId === ambiguousCleanup.runnerId
      );
      reconciled.reservationId = persistedReservation ? persistedReservation.reservationId : "";
      reconciled.reservationState = persistedReservation ? persistedReservation.state : "";
      reconciled.availableAt = persistedReservation ? persistedReservation.availableAt || "" : "";
    } else {
      reconciled.reservationId = ambiguousCleanup.reservationId;
      reconciled.reservationState = ambiguousCleanup.reservationState;
      reconciled.availableAt = ambiguousCleanup.availableAt;
    }
    return reconciled;
  };

  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    const { state, sha } = await readState(config, options);
    if (state.schemaVersion >= 3 && !identity.runnerId) {
      throw new Error("runner-id is required to clean up schema 3 lock ownership.");
    }
    const ownsEntry = (entry) => {
      if (entry.holderId !== identity.holderId) {
        return false;
      }
      if (state.schemaVersion < 3) {
        return true;
      }
      if (!/^[1-9][0-9]*$/.test(entry.runAttempt) || !/^[1-9][0-9]*$/.test(identity.runAttempt)) {
        throw new Error(
          `Build-lock cleanup ${identity.holderId} has invalid run attempts ` +
            `(stored=${JSON.stringify(entry.runAttempt)}, caller=${JSON.stringify(identity.runAttempt)}); ` +
            "expected positive decimal integers."
        );
      }
      // runnerId controls admission, not cleanup ownership. A dead self-hosted
      // runner can be cleaned up by a same-attempt fallback job on another runner.
      // The attempt fence still prevents a late cleanup from deleting a newer rerun.
      return BigInt(identity.runAttempt) >= BigInt(entry.runAttempt);
    };
    const expiredCooldowns = pruneExpiredCooldowns(state);
    for (const reservation of expiredCooldowns) {
      console.log(`Expired cooldown reservation ${reservation.reservationId} for runner ${reservation.runnerId}.`);
    }
    const queueCleaned = state.queue.some(ownsEntry);
    state.queue = state.queue.filter((entry) => !ownsEntry(entry));
    const removedHolders = state.holders.filter(ownsEntry);
    const remainingHolders = state.holders.filter((holder) => !ownsEntry(holder));
    const released = remainingHolders.length !== state.holders.length;
    state.holders = remainingHolders;
    let reservation = null;
    if (state.schemaVersion >= 4 && removedHolders.length) {
      const reservationState = options.resourceSafe === true ? "cooldown" : "quarantine";
      const reason = options.reason ||
        (reservationState === "cooldown" ? "release cleanup confirmed resource-safe" : "release cleanup was not proven resource-safe");
      reservation = reservationFromHolder(
        removedHolders[0],
        reservationState,
        reason,
        options.releaseCooldownSeconds || DEFAULT_RELEASE_COOLDOWN_SECONDS
      );
      state.reservations.push(reservation);
    }
    // Public release outputs are singular; report the same first holder that legacy
    // clients see through the mirrored `holder` field.
    const { heldBy, heldByRunUrl } = firstHolderContext(state.holders);

    const changed = released || queueCleaned || expiredCooldowns.length > 0;
    if (!changed) {
      if (ambiguousCleanup) {
        return reconcileAmbiguousCleanup(
          { released: false, queueCleaned: false },
          state,
          sha || "",
          heldBy,
          heldByRunUrl
        );
      }
      return {
        released: false,
        queueCleaned: false,
        sha: sha || "",
        heldBy,
        heldByRunUrl
      };
    }

    const write = await writeState(config, sha, state, `Release ${config.lockName}`, options);
    if (write.conflict) {
      if (write.ambiguous) {
        const nextAmbiguousCleanup = {
          released,
          queueCleaned,
          sha: "",
          heldBy,
          heldByRunUrl,
          reservationId: reservation && reservation.reservationId,
          reservationState: reservation && reservation.state,
          availableAt: reservation && reservation.availableAt,
          runnerId: reservation && reservation.runnerId
        };
        ambiguousCleanup = ambiguousCleanup
          ? {
              ...nextAmbiguousCleanup,
              released: ambiguousCleanup.released || nextAmbiguousCleanup.released,
              queueCleaned: ambiguousCleanup.queueCleaned || nextAmbiguousCleanup.queueCleaned,
              reservationId: nextAmbiguousCleanup.reservationId || ambiguousCleanup.reservationId,
              reservationState: nextAmbiguousCleanup.reservationState || ambiguousCleanup.reservationState,
              availableAt: nextAmbiguousCleanup.availableAt || ambiguousCleanup.availableAt,
              runnerId: nextAmbiguousCleanup.runnerId || ambiguousCleanup.runnerId
            }
          : nextAmbiguousCleanup;
      }
      await sleep(jitter(conflictDelayMs), { signal: options.apiOptions && options.apiOptions.signal });
      continue;
    }

    return reconcileAmbiguousCleanup({
      released,
      queueCleaned,
      sha: write.sha,
      heldBy,
      heldByRunUrl,
      reservationId: reservation && reservation.reservationId,
      reservationState: reservation && reservation.state,
      availableAt: reservation && reservation.availableAt
    }, state, write.sha, heldBy, heldByRunUrl);
  }

  throw new Error(`Failed to clean up ${config.lockName} after repeated CAS conflicts.`);
}

function observationText(config, observation, attempts, elapsedMs) {
  const details = [`attempts=${attempts}`, `elapsed-ms=${elapsedMs}`];
  if (observation && observation.holderId) {
    details.push(`holder=${observation.holderId}`);
    if (observation.holderRunUrl) {
      details.push(`holder-run=${observation.holderRunUrl}`);
    }
    details.push(`queue-position=${observation.queuePosition}`);
    details.push(`reason=${observation.reason}`);
  } else if (observation) {
    details.push(`holder=<none>`);
    details.push(`queue-position=${observation.queuePosition}`);
    if (observation.reason) {
      details.push(`reason=${observation.reason}`);
    }
  }
  return `${config.lockName} wait state: ${details.join("; ")}.`;
}

async function cleanupAfterAcquireFailure(config, identity, reason, options = {}) {
  try {
    const result = await cleanupIdentity(config, identity, options);
    const name = cleanupResultName(result);
    if (name === "noop") {
      console.log(`::notice::No build-lock cleanup needed after ${reason}.`);
    } else {
      console.log(`::notice::Build-lock cleanup after ${reason}: ${name}.`);
    }
  } catch (error) {
    console.log(`::warning::Unable to clean up build-lock state after ${reason}: ${oneLine(error.message)}.`);
  }
}

function installAcquireSignalCleanup(cancellation) {
  const handler = (signal) => {
    const exitCode = signal === "SIGINT" ? 130 : 143;
    cancellation.signalName = signal;
    cancellation.exitCode = exitCode;

    if (cancellation.cleanupAbortController) {
      cancellation.cleanupAbortController.abort(new Error(`Build lock cleanup interrupted by ${signal}`));
      process.exit(exitCode);
      return;
    }

    if (cancellation.requested) {
      return;
    }

    cancellation.requested = true;
    cancellation.abortController.abort(new Error(`Build lock acquire cancelled by ${signal}`));
    console.log(`::warning::Received ${signal}; stopping acquire before build-lock cleanup.`);
  };

  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

function createPostCleanupRecorder(config) {
  let recorded = false;
  return () => {
    if (recorded || !config.registerPostCleanup) {
      return;
    }
    writeActionState("build_lock_cleanup", "enabled");
    recorded = true;
  };
}

function cancellationApiOptions(cancellation) {
  return { signal: cancellation.abortController.signal };
}

function isCancellationError(error, cancellation) {
  return cancellation.requested || isAbortError(error, cancellation.abortController.signal);
}

function throwIfCancellation(cancellation) {
  if (!cancellation.requested) {
    return;
  }
  const error = new Error(`Build lock acquire cancelled by ${cancellation.signalName || "signal"}.`);
  error.cancelled = true;
  throw error;
}

async function runCancellationCleanup(config, identity, cancellation) {
  const cleanupBudgetMs = cancellation.signalName === "SIGTERM" ? 1500 : 5000;
  const cleanupAbortController = new AbortController();
  cancellation.cleanupAbortController = cleanupAbortController;
  const timeout = setTimeout(() => {
    cleanupAbortController.abort(new Error("Build lock cancellation cleanup timed out."));
  }, cleanupBudgetMs);
  const cleanupOptions = {
    maxAttempts: 2,
    conflictDelayMs: 250,
    apiOptions: {
      maxAttempts: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      signal: cleanupAbortController.signal
    }
  };

  try {
    await cleanupAfterAcquireFailure(config, identity, `signal ${cancellation.signalName}`, cleanupOptions);
    await sleep(250, { signal: cleanupAbortController.signal });
    await cleanupAfterAcquireFailure(config, identity, `signal ${cancellation.signalName} second pass`, cleanupOptions);
  } catch (error) {
    console.log(`::warning::Build-lock cancellation cleanup stopped: ${oneLine(error.message)}.`);
  } finally {
    clearTimeout(timeout);
    cancellation.cleanupAbortController = null;
  }
}

function writeAcquireOutputs({
  acquired,
  lockName,
  holderId,
  stateSha = "",
  waitMs,
  attempts,
  staleRecovered = false,
  quarantineRecovered = false
}) {
  writeOutput("acquired", acquired ? "true" : "false");
  writeOutput("lock-name", lockName);
  writeOutput("holder-id", holderId);
  writeOutput("state-sha", stateSha);
  writeOutput("wait-ms", String(waitMs));
  writeOutput("attempts", String(attempts));
  writeOutput("stale-recovered", String(staleRecovered));
  writeOutput("quarantine-recovered", String(quarantineRecovered));
}

function writeReapOutputs({ reaped, stateSha = "" }) {
  writeOutput("reaped", String(reaped));
  writeOutput("state-sha", stateSha);
}

async function acquire(config) {
  validateLockName(config.lockName);
  const identity = currentIdentity(config);
  const cancellation = {
    requested: false,
    signalName: "",
    exitCode: 0,
    abortController: new AbortController(),
    cleanupAbortController: null
  };
  const apiOptions = cancellationApiOptions(cancellation);
  const removeSignalCleanup = installAcquireSignalCleanup(cancellation);
  const recordPostCleanupNeeded = createPostCleanupRecorder(config);

  try {
    await ensureStateBranch(config, { apiOptions });
    let lockConfig = await readLockConfig(config, { apiOptions });
    let lockConfigReadAt = Date.now();
    const started = Date.now();
    const deadline = started + config.timeoutMinutes * 60 * 1000;
    let attempts = 0;
    let staleRecovered = false;
    let quarantineRecovered = false;
    let lastObservation = null;
    let authFailureSince = null;

    console.log(`::group::Acquire build lock ${config.lockName}`);
    console.log(`Lock repository: ${config.lockRepository}`);
    console.log(`Holder: ${identity.holderId}`);
    console.log(`Max concurrent holders: ${lockConfig.maxHolders}`);

    while (Date.now() < deadline) {
      throwIfCancellation(cancellation);
      attempts++;
      let recoveringStaleHolder = false;
      try {
        // Re-read the parallelism config on a TTL so long waits pick up limit changes
        // without adding a contents read to every poll.
        const configTtlMs = integerEnvironment("BUILD_LOCK_CONFIG_TTL_MS", DEFAULT_CONFIG_TTL_MS);
        if (Date.now() - lockConfigReadAt >= configTtlMs) {
          const refreshed = await readLockConfig(config, { apiOptions });
          if (refreshed.maxHolders !== lockConfig.maxHolders) {
            console.log(`Max concurrent holders changed from ${lockConfig.maxHolders} to ${refreshed.maxHolders}.`);
          }
          if (refreshed.runnerSerialization !== lockConfig.runnerSerialization) {
            console.log(
              `Runner serialization changed from ${lockConfig.runnerSerialization} to ${refreshed.runnerSerialization}.`
            );
          }
          if (refreshed.resourceLifecycle !== lockConfig.resourceLifecycle) {
            console.log(`Resource lifecycle changed from ${lockConfig.resourceLifecycle} to ${refreshed.resourceLifecycle}.`);
          }
          lockConfig = refreshed;
          lockConfigReadAt = Date.now();
        }
        const { state, sha } = await readState(config, { apiOptions });
        const observedSchemaVersion = state.schemaVersion;
        authFailureSince = null;
        throwIfCancellation(cancellation);
        const runnerSerialization = lockConfig.runnerSerialization || state.schemaVersion >= 3;
        if (runnerSerialization && !identity.runnerId) {
          throw new Error(
            "runner-id is required after runner serialization is activated; pass the same physical runner identity to acquire and release."
          );
        }
        let changed = false;
        if (lockConfig.runnerSerialization && state.schemaVersion < 3) {
          if (state.holders.length || state.queue.length) {
            throw new Error(
              "Cannot activate runner serialization while schema 2 has holders or queued requests; drain the lock before enabling it."
            );
          }
          state.schemaVersion = 3;
          changed = true;
        }
        if (lockConfig.resourceLifecycle && state.schemaVersion < 4) {
          if (observedSchemaVersion !== 3 || state.holders.length || state.queue.length) {
            throw new Error(
              "Cannot activate resource lifecycle until the lock is drained on schema 3; drain or complete migration before enabling it."
            );
          }
          state.schemaVersion = 4;
          state.reservations = [];
          changed = true;
        }
        const resourceLifecycle = state.schemaVersion >= 4;
        const expiredCooldowns = pruneExpiredCooldowns(state);
        if (expiredCooldowns.length) {
          changed = true;
          for (const reservation of expiredCooldowns) {
            console.log(`Expired cooldown reservation ${reservation.reservationId} for runner ${reservation.runnerId}.`);
          }
        }
        const staleness = new Map();
        for (const holder of state.holders) {
          staleness.set(holder.holderId, await evaluateStale(holder, config.token, { apiOptions }));
          throwIfCancellation(cancellation);
        }
        const myHolder = state.holders.find((holder) => holder.holderId === identity.holderId);
        let rerunReplacement = false;
        if (runnerSerialization && myHolder) {
          rerunReplacement = identityIsNewerOrThrow(myHolder, identity, "Holder");
        }
        if (myHolder && !rerunReplacement && !staleness.get(identity.holderId).stale) {
          recordPostCleanupNeeded();
          const waitMs = Date.now() - started;
          const position = queuePosition(state, identity.holderId);
          console.log(
            `Attempt ${attempts}: already holds ${config.lockName} queue-position=${position} reason=${staleness.get(identity.holderId).reason}`
          );
          writeAcquireOutputs({
            acquired: true,
            lockName: config.lockName,
            holderId: identity.holderId,
            stateSha: sha || "",
            waitMs,
            attempts,
            staleRecovered,
            quarantineRecovered
          });
          appendSummary(`Acquired ${config.lockName} after ${waitMs} ms and ${attempts} attempts.`);
          console.log(`Already holds ${config.lockName}; treating acquire as successful.`);
          console.log("::endgroup::");
          return;
        }

        const dedupedQueue = state.queue.filter((entry, index, queue) => {
          return entry.holderId && queue.findIndex((candidate) => candidate.holderId === entry.holderId) === index;
        });
        state.queue = [];
        for (const entry of dedupedQueue) {
          if (entry.holderId !== identity.holderId && (await queueEntryIsFinished(entry, config.token, { apiOptions }))) {
            throwIfCancellation(cancellation);
            console.log(`Dropping completed queue entry ${entry.holderId}.`);
            changed = true;
          } else if (entry.holderId === identity.holderId) {
            if (runnerSerialization) {
              identityIsNewerOrThrow(entry, identity, "Queued request");
            }
            const refreshedEntry = { ...identity, queuedAt: entry.queuedAt };
            if (entry.runnerId !== refreshedEntry.runnerId || entry.runAttempt !== refreshedEntry.runAttempt) {
              changed = true;
            }
            state.queue.push(refreshedEntry);
          } else {
            state.queue.push(entry);
          }
        }

        if (!state.queue.some((entry) => entry.holderId === identity.holderId)) {
          state.queue.push(identity);
          changed = true;
        } else {
          recordPostCleanupNeeded();
        }

        const freshHolders = state.holders.filter(
          (holder) => !staleness.get(holder.holderId).stale && holder.holderId !== (rerunReplacement ? identity.holderId : "")
        );
        const staleHolders = state.holders.filter((holder) => staleness.get(holder.holderId).stale);
        if (rerunReplacement) {
          console.log(
            `Moving rerun ${identity.holderId} from attempt ${myHolder.runAttempt}/${myHolder.runnerId} ` +
              `to ${identity.runAttempt}/${identity.runnerId}; re-evaluating admission.`
          );
          state.holders = freshHolders;
          changed = true;
        }
        if (resourceLifecycle) {
          const uncertainHolders = [...staleHolders, ...(rerunReplacement ? [myHolder] : [])]
            .filter((holder, index, holders) => holders.findIndex((candidate) => candidate.holderId === holder.holderId) === index);
          for (const holder of uncertainHolders) {
            const reason = rerunReplacement && holder.holderId === myHolder.holderId
              ? "holder ownership moved to a newer run attempt without cleanup proof"
              : `stale holder recovery: ${staleness.get(holder.holderId).reason}`;
            const reservation = reservationFromHolder(holder, "quarantine", reason);
            state.reservations.push(reservation);
            console.log(`Quarantining holder ${holder.holderId} as reservation ${reservation.reservationId}: ${reason}.`);
          }
          if (uncertainHolders.length) {
            state.holders = freshHolders;
            changed = true;
            recoveringStaleHolder = staleHolders.length > 0;
          }
        }

        const reservations = resourceLifecycle ? state.reservations : [];
        const reservationDetails = reservations.map((reservation) => {
          const availability = reservation.availableAt ? ` available-at=${reservation.availableAt}` : "";
          return `${reservation.reservationId}:${reservation.state}:runner=${reservation.runnerId}${availability}`;
        }).join(",");
        const position = queuePosition(state, identity.holderId);
        if (state.holders.length) {
          const holderIds = state.holders.map((holder) => holder.holderId).join(",");
          const holderRuns = state.holders.map((holder) => holder.runUrl).join(",");
          const holderReasons = state.holders.map((holder) => staleness.get(holder.holderId).reason).join(",");
          const reasons = reservationDetails
            ? `${holderReasons}; capacity reserved by ${reservationDetails}`
            : holderReasons;
          lastObservation = {
            holderId: holderIds,
            holderRunUrl: holderRuns,
            queuePosition: position,
            reason: reasons
          };
          console.log(
            `Attempt ${attempts}: holders=${freshHolders.length}/${lockConfig.maxHolders} holder=${holderIds} ` +
              `run=${holderRuns} reservations=${reservationDetails || "<none>"} ` +
              `queue-position=${position} reason=${reasons}`
          );
        } else if (reservations.length) {
          lastObservation = {
            holderId: "",
            holderRunUrl: "",
            queuePosition: position,
            reason: `capacity reserved by ${reservationDetails}`
          };
          console.log(
            `Attempt ${attempts}: holders=0/${lockConfig.maxHolders} reservations=${reservationDetails} ` +
              `queue-position=${position}`
          );
        } else {
          lastObservation = {
            holderId: "",
            holderRunUrl: "",
            queuePosition: position,
            reason: "lock is free"
          };
          console.log(
            `Attempt ${attempts}: lock is free queue-position=${position} max-holders=${lockConfig.maxHolders}`
          );
        }

        // Slot admission: after ignoring stale holders, the first `freeSlots` queue
        // entries may each take a slot. Every waiter only ever admits itself; the CAS
        // write plus the verification read keep concurrent admissions consistent.
        const matchingQuarantine = reservations.find(
          (reservation) => reservation.state === "quarantine" && reservation.runnerId === identity.runnerId
        );
        const firstForRunner = state.queue.find((entry) => entry.runnerId === identity.runnerId);
        const freeSlots = lockConfig.maxHolders - freshHolders.length - reservations.length;
        // A quarantine belongs to the physical runner, not one logical job. The first
        // queued job on that runner may swap it for a holder, but never while a reviewed
        // maxHolders reduction has left the state over capacity.
        const canRecoverQuarantine = Boolean(
          matchingQuarantine &&
          firstForRunner &&
          firstForRunner.holderId === identity.holderId &&
          freeSlots >= 0
        );
        const occupiedCapacity = [...freshHolders, ...reservations.map((reservation) => ({ runnerId: reservation.runnerId }))];
        const eligibleEntries = runnerSerialization
          ? selectEligibleQueueEntries(occupiedCapacity, state.queue, freeSlots)
          : state.queue.slice(0, Math.max(0, freeSlots));
        const eligible = canRecoverQuarantine || eligibleEntries.some((entry) => entry.holderId === identity.holderId);
        if ((freeSlots > 0 || canRecoverQuarantine) && eligible) {
          if (staleHolders.length) {
            recoveringStaleHolder = true;
            for (const holder of staleHolders) {
              console.log(`Recovering stale holder ${holder.holderId}: ${staleness.get(holder.holderId).reason}`);
            }
          }
          if (canRecoverQuarantine) {
            console.log(
              `Recovering quarantine ${matchingQuarantine.reservationId} on original runner ${identity.runnerId}.`
            );
            state.reservations = state.reservations.filter(
              (reservation) => reservation.reservationId !== matchingQuarantine.reservationId
            );
          }
          state.holders = [...freshHolders, holderFromIdentity(identity, config.leaseMinutes)];
          state.queue = state.queue.filter((entry) => entry.holderId !== identity.holderId);
          changed = true;

          throwIfCancellation(cancellation);
          const write = await writeState(config, sha, state, `Acquire ${config.lockName}`, { apiOptions });
          if (write.conflict) {
            if (recoveringStaleHolder && write.ambiguous) {
              staleRecovered = true;
              recordPostCleanupNeeded();
            }
            if (canRecoverQuarantine && write.ambiguous) {
              quarantineRecovered = true;
              recordPostCleanupNeeded();
            }
            await sleep(jitter(1000), { signal: apiOptions.signal });
            continue;
          }
          if (recoveringStaleHolder) {
            staleRecovered = true;
          }
          if (canRecoverQuarantine) {
            quarantineRecovered = true;
          }
          recordPostCleanupNeeded();
          throwIfCancellation(cancellation);
          const verified = await readState(config, { apiOptions });
          const verifiedHolder = verified.state.holders.find((holder) => holder.holderId === identity.holderId);
          if (
            !verifiedHolder ||
            (runnerSerialization &&
              (verified.state.schemaVersion !== state.schemaVersion ||
                verifiedHolder.runnerId !== identity.runnerId ||
                verifiedHolder.runAttempt !== identity.runAttempt))
          ) {
            await sleep(jitter(1000), { signal: apiOptions.signal });
            continue;
          }
          const waitMs = Date.now() - started;
          writeAcquireOutputs({
            acquired: true,
            lockName: config.lockName,
            holderId: identity.holderId,
            stateSha: write.sha,
            waitMs,
            attempts,
            staleRecovered,
            quarantineRecovered
          });
          appendSummary(`Acquired ${config.lockName} after ${waitMs} ms and ${attempts} attempts.`);
          console.log(`Acquired ${config.lockName}.`);
          console.log("::endgroup::");
          return;
        }

        if (changed) {
          throwIfCancellation(cancellation);
          const write = await writeState(config, sha, state, `Queue for ${config.lockName}`, { apiOptions });
          if (write.conflict) {
            if (recoveringStaleHolder && write.ambiguous) {
              staleRecovered = true;
              recordPostCleanupNeeded();
            }
            await sleep(jitter(1000), { signal: apiOptions.signal });
            continue;
          }
          if (recoveringStaleHolder) {
            staleRecovered = true;
          }
          recordPostCleanupNeeded();
        }

        await sleep(jitter(config.pollSeconds * 1000), { signal: apiOptions.signal });
      } catch (error) {
        if (isCancellationError(error, cancellation)) {
          throw error;
        }
        // A transient 401 that survived api()'s own retries usually means a longer GitHub
        // auth incident (see issue #12; the same token had just authenticated successfully).
        // The whole point of this loop is to wait, so keep polling under a bounded grace
        // window instead of failing the build; genuinely bad credentials still fail once
        // the grace window is exhausted.
        if (error.status === 401) {
          const authGraceMs = integerEnvironment("BUILD_LOCK_AUTH_GRACE_MS", DEFAULT_AUTH_GRACE_MS);
          const now = Date.now();
          if (authFailureSince === null) {
            authFailureSince = now;
          }
          const authFailureMs = now - authFailureSince;
          if (authFailureMs < authGraceMs && now < deadline) {
            console.log(
              `::warning::Lock-state access for ${config.lockName} failed with HTTP 401 ` +
                `(${oneLine(error.message)}); treating it as transient and continuing to wait ` +
                `(${Math.max(0, authGraceMs - authFailureMs)} ms of auth grace remaining). ` +
                `Verify build-lock credential permissions if this persists.`
            );
            await sleep(jitter(config.pollSeconds * 1000), { signal: apiOptions.signal });
            continue;
          }
        }
        throw error;
      }
    }

    const waitMs = Date.now() - started;
    const details = observationText(config, lastObservation, attempts, waitMs);
    writeAcquireOutputs({
      acquired: false,
      lockName: config.lockName,
      holderId: identity.holderId,
      waitMs,
      attempts,
      staleRecovered,
      quarantineRecovered
    });
    appendSummary(`Timed out waiting for ${config.lockName}. ${details}`);
    await cleanupAfterAcquireFailure(config, identity, "timeout", {
      maxAttempts: 3,
      conflictDelayMs: 500,
      apiOptions: { signal: apiOptions.signal }
    });
    throw new Error(`Timed out waiting for build lock ${config.lockName}. ${details}`);
  } catch (error) {
    if (isCancellationError(error, cancellation)) {
      await runCancellationCleanup(config, identity, cancellation);
      process.exit(cancellation.exitCode || 143);
    }
    throw error;
  } finally {
    removeSignalCleanup();
  }
}

async function release(config) {
  validateLockName(config.lockName);
  await ensureStateBranch(config);
  const identity = currentIdentity(config);
  if (config.targetHolderId) {
    const targetHolderId = String(config.targetHolderId).trim();
    const expectedPrefix = `${identity.repository}:${identity.runId}:`;
    const targetSuffix = targetHolderId.slice(expectedPrefix.length);
    const jobSeparator = targetSuffix.indexOf(":");
    if (
      !targetHolderId.startsWith(expectedPrefix) ||
      /[\r\n]/.test(targetHolderId) ||
      jobSeparator <= 0 ||
      jobSeparator === targetSuffix.length - 1
    ) {
      throw new Error(
        `holder-id must identify a job in the current repository and workflow run (${expectedPrefix}<job>:<suffix>).`
      );
    }
    identity.holderId = targetHolderId;
  }
  console.log(`::group::Release build lock ${config.lockName}`);

  const lockConfig = await readLockConfig(config);
  const result = await cleanupIdentity(config, identity, {
    resourceSafe: config.resourceSafe,
    releaseCooldownSeconds: lockConfig.releaseCooldownSeconds,
    reason: config.resourceSafe
      ? "explicit release reported resource cleanup safe"
      : "explicit release could not prove resource cleanup safe"
  });
  writeReleaseOutputs(config, identity, result);
  const cleanupResult = cleanupResultName(result);
  if (result.heldBy) {
    console.log(`Lock is held by ${result.heldBy}; this run is ${identity.holderId}.`);
  } else if (cleanupResult === "noop") {
    console.log("Lock is already free.");
  }

  if (cleanupResult === "queue-cleaned") {
    console.log(
      `::notice::Removed queued request for ${config.lockName}; this run did not hold the lock. ` +
        "Guard licensed work with the acquire action's acquired output."
    );
  }

  const releaseMessage = explicitReleaseMessage(cleanupResult, config.lockName);
  appendSummary(releaseMessage);
  console.log(releaseMessage);
  console.log("::endgroup::");
}

async function postCleanup(config) {
  if (process.env.STATE_build_lock_cleanup !== "enabled") {
    console.log("No build-lock post cleanup state recorded; nothing to do.");
    return;
  }

  validateLockName(config.lockName);
  const identity = currentIdentity(config);
  console.log(`::group::Post cleanup build lock ${config.lockName}`);
  try {
    await ensureStateBranch(config);
    const result = await cleanupIdentity(config, identity, {
      maxAttempts: 3,
      conflictDelayMs: 500,
      resourceSafe: false,
      reason: "post-action cleanup cannot prove external resource cleanup"
    });
    const cleanupResult = cleanupResultName(result);
    if (cleanupResult === "noop") {
      console.log(`No post cleanup needed for ${config.lockName}.`);
      appendSummary(`No post cleanup needed for ${config.lockName}.`);
    } else {
      console.log(`::notice::Post cleanup for ${config.lockName}: ${cleanupResult}.`);
      appendSummary(`Post cleanup for ${config.lockName}: ${cleanupResult}.`);
    }
  } catch (error) {
    console.log(`::warning::Post cleanup for ${config.lockName} failed: ${oneLine(error.message)}.`);
    appendSummary(`Build lock post cleanup failed: ${oneLine(error.message)}`);
  }
  console.log("::endgroup::");
}

async function runPostCleanup() {
  if (process.env.STATE_build_lock_cleanup !== "enabled") {
    console.log("No build-lock post cleanup state recorded; nothing to do.");
    return;
  }

  try {
    await postCleanup(config());
  } catch (error) {
    console.log(`::warning::Build lock post cleanup could not start: ${oneLine(error.message)}.`);
    appendSummary(`Build lock post cleanup could not start: ${oneLine(error.message)}`);
  }
}

async function reap(config) {
  validateLockName(config.lockName);
  config.operation = config.operation || "reap";
  if (config.operation !== "reap" && config.operation !== "recover") {
    throw new Error("operation must be reap or recover.");
  }
  await ensureStateBranch(config);
  console.log(`::group::Reap stale build lock ${config.lockName}`);
  let ambiguousReap = false;

  for (let attempts = 1; attempts <= 10; attempts++) {
    const { state, sha } = await readState(config);
    const expiredCooldowns = pruneExpiredCooldowns(state);
    for (const reservation of expiredCooldowns) {
      console.log(`Expired cooldown reservation ${reservation.reservationId} for runner ${reservation.runnerId}.`);
    }
    if (config.operation === "recover") {
      if (state.schemaVersion < 4) {
        throw new Error("Manual reservation recovery requires schema 4 state.");
      }
      if (!config.resourceSafe) {
        throw new Error("Manual reservation recovery requires resource-safe=true confirmation.");
      }
      if (!config.reservationId) {
        throw new Error("Manual reservation recovery requires the exact reservation-id.");
      }
      const reservation = state.reservations.find((entry) => entry.reservationId === config.reservationId);
      if (ambiguousReap && (!reservation || reservation.state === "cooldown")) {
        if (expiredCooldowns.length) {
          const write = await writeState(config, sha, state, `Prune recovered reservation ${config.reservationId}`);
          if (write.conflict) {
            await sleep(jitter(1000));
            continue;
          }
          writeReapOutputs({ reaped: true, stateSha: write.sha });
        } else {
          writeReapOutputs({ reaped: true, stateSha: sha || "" });
        }
        appendSummary(`Moved quarantine ${config.reservationId} to cooldown for ${config.lockName}.`);
        console.log("::endgroup::");
        return;
      }
      if (!reservation || reservation.state !== "quarantine") {
        throw new Error(`Active quarantine reservation ${config.reservationId} was not found.`);
      }
      const lockConfig = await readLockConfig(config);
      reservation.state = "cooldown";
      reservation.reason = "operator confirmed external resource cleanup";
      reservation.availableAt = new Date(Date.now() + lockConfig.releaseCooldownSeconds * 1000).toISOString();
      const write = await writeState(config, sha, state, `Recover reservation ${config.reservationId}`);
      if (write.conflict) {
        if (write.ambiguous) {
          ambiguousReap = true;
        }
        await sleep(jitter(1000));
        continue;
      }
      writeReapOutputs({ reaped: true, stateSha: write.sha });
      appendSummary(`Moved quarantine ${config.reservationId} to cooldown for ${config.lockName}.`);
      console.log("::endgroup::");
      return;
    }
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

    let holderReaped = false;
    const keptHolders = [];
    for (const holder of state.holders) {
      const stale = await evaluateStale(holder, config.token);
      if (stale.stale) {
        console.log(`${state.schemaVersion >= 4 ? "Quarantining" : "Reaping"} holder ${holder.holderId}: ${stale.reason}.`);
        holderReaped = true;
        if (state.schemaVersion >= 4) {
          state.reservations.push(
            reservationFromHolder(holder, "quarantine", `scheduled stale reaping: ${stale.reason}`)
          );
        }
      } else {
        console.log(`Keeping holder ${holder.holderId}: ${stale.reason}.`);
        keptHolders.push(holder);
      }
    }
    state.holders = keptHolders;

    const changed = holderReaped || beforeQueue !== state.queue.length || expiredCooldowns.length > 0;
    if (!changed) {
      writeReapOutputs({ reaped: ambiguousReap, stateSha: sha || "" });
      appendSummary(
        ambiguousReap ? `Reaped stale state for ${config.lockName}.` : `No stale state found for ${config.lockName}.`
      );
      console.log("::endgroup::");
      return;
    }

    const write = await writeState(config, sha, state, `Reap stale ${config.lockName}`);
    if (write.conflict) {
      if (write.ambiguous) {
        ambiguousReap = true;
      }
      await sleep(jitter(1000));
      continue;
    }

    writeReapOutputs({ reaped: true, stateSha: write.sha });
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
  const lockRepo = parseRepository(lockRepository);
  const holderIdSuffix = holderIdSuffixInput();
  return {
    token: credential(lockRepo),
    lockName,
    holderIdSuffix,
    targetHolderId: MODE === "release" ? input("holder-id") : "",
    runnerId: input("runner-id"),
    resourceSafe: booleanInput("resource-safe", false),
    operation: input("operation", "reap"),
    reservationId: input("reservation-id"),
    lockRepository,
    lockRepo,
    stateBranch: input("state-branch", "lock-state"),
    statePath: `locks/${lockName}.json`,
    configPath: `locks/${lockName}.config.json`,
    timeoutMinutes: integerInput("timeout-minutes", 180),
    leaseMinutes: integerInput("lease-minutes", 240),
    pollSeconds: integerInput("poll-seconds", 15),
    registerPostCleanup: process.env.BUILD_LOCK_REGISTER_POST_CLEANUP === "1"
  };
}

async function run() {
  try {
    if (MODE === "post-cleanup") {
      await runPostCleanup();
      return;
    }

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
}

if (require.main === module) {
  run();
}

module.exports = {
  acquire,
  api,
  cleanupIdentity,
  config,
  createAppJwt,
  createGitHubAppAuth,
  credential,
  emptyState,
  evaluateStale,
  installAcquireSignalCleanup,
  isRetryableResponse,
  normalizeState,
  postCleanup,
  readLockConfig,
  readState,
  release,
  reap,
  run,
  runCancellationCleanup,
  runPostCleanup,
  selectEligibleQueueEntries,
  writeState
};
