const assert = require("node:assert/strict");
const test = require("node:test");

const { validateUnityLicense } = require("../.github/dist/validate-unity-license.js");

function outputs() {
  const lines = [];
  return { lines, appendFile: (_path, value) => lines.push(value.trim()) };
}

test("central Unity license preflight accepts serial credentials without logging values", () => {
  const capture = outputs();
  const result = validateUnityLicense({
    env: {
      UNITY_SERIAL: "serial-secret",
      UNITY_EMAIL: "email-secret",
      UNITY_PASSWORD: "password-secret",
      GITHUB_OUTPUT: "outputs"
    },
    writeOutputs: true,
    appendFile: capture.appendFile
  });

  assert.deepEqual(result, { serialPresent: true, emailPresent: true, passwordPresent: true });
  assert.deepEqual(capture.lines, ["serial-present=true", "email-present=true", "password-present=true"]);
});

test("central Unity license preflight rejects missing credentials and emits only booleans", () => {
  const env = { UNITY_SERIAL: "serial-secret", GITHUB_OUTPUT: "outputs" };
  const capture = outputs();
  assert.throws(
    () => validateUnityLicense({ ...capture, env, appendFile: capture.appendFile }),
    /UNITY_EMAIL, UNITY_PASSWORD/
  );
});

test("central Unity license preflight rejects the retired licensing server", () => {
  assert.throws(
    () => validateUnityLicense({
      env: {
        UNITY_SERIAL: "serial-secret",
        UNITY_EMAIL: "email-secret",
        UNITY_PASSWORD: "password-secret",
        UNITY_LICENSING_SERVER: "retired-secret"
      },
      writeOutputs: false
    }),
    /UNITY_LICENSING_SERVER/
  );
});
