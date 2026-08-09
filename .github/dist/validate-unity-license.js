"use strict";

const fs = require("node:fs");

function present(value) {
  return typeof value === "string" && value.trim() !== "";
}

function writeOutput(env, name, value, appendFile = fs.appendFileSync) {
  if (env.GITHUB_OUTPUT) {
    appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
  }
}

function validateUnityLicense(options = {}) {
  const env = options.env || process.env;
  const appendFile = options.appendFile || fs.appendFileSync;
  const activationMode = String(env["INPUT_ACTIVATION-MODE"] || "serial").trim();
  const serialPresent = present(env.UNITY_SERIAL);
  const emailPresent = present(env.UNITY_EMAIL);
  const passwordPresent = present(env.UNITY_PASSWORD);
  const licensingServerPresent = present(env.UNITY_LICENSING_SERVER);

  if (options.writeOutputs !== false) {
    writeOutput(env, "serial-present", String(serialPresent), appendFile);
    writeOutput(env, "email-present", String(emailPresent), appendFile);
    writeOutput(env, "password-present", String(passwordPresent), appendFile);
  }

  if (activationMode !== "serial") {
    throw new Error("activation-mode must be serial; other Unity licensing modes are unsupported.");
  }
  if (licensingServerPresent) {
    throw new Error("UNITY_LICENSING_SERVER is set but unsupported; remove the retired credential.");
  }
  const missing = [];
  if (!serialPresent) missing.push("UNITY_SERIAL");
  if (!emailPresent) missing.push("UNITY_EMAIL");
  if (!passwordPresent) missing.push("UNITY_PASSWORD");
  if (missing.length > 0) {
    throw new Error(`Serial Unity activation is missing or empty: ${missing.join(", ")}.`);
  }

  return { serialPresent, emailPresent, passwordPresent };
}

function run() {
  try {
    const result = validateUnityLicense();
    console.log(`::notice::Unity serial-activation preflight passed (serial=${result.serialPresent}, email=${result.emailPresent}, password=${result.passwordPresent}).`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { present, validateUnityLicense };
