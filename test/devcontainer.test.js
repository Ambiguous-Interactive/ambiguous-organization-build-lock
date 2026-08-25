import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const assertAppearsBefore = (text, first, second, message) => {
  const firstIndex = text.indexOf(first);
  const secondIndex = text.indexOf(second);
  assert.notEqual(firstIndex, -1, `${message}: missing prerequisite`);
  assert.notEqual(secondIndex, -1, `${message}: missing dependent command`);
  assert.ok(firstIndex < secondIndex, message);
};

test("dev container is portable, pinned, and editor-neutral", async () => {
  const config = await readJson(".devcontainer/devcontainer.json");
  const lock = await readJson(".devcontainer/devcontainer-lock.json");

  assert.equal(config.name, "Ambiguous Organization Build Lock");
  assert.equal(config.remoteUser, "vscode");
  assert.equal(config.updateRemoteUserUID, true);
  assert.equal(config.overrideCommand, true);
  assert.equal(config.shutdownAction, "stopContainer");
  assert.equal(config.waitFor, "postCreateCommand");
  assert.equal(config.hostRequirements.cpus, 2);
  assert.equal(config.hostRequirements.memory, "4gb");

  assert.deepEqual(
    ["image", "build", "dockerComposeFile"].filter((source) =>
      Object.hasOwn(config, source)
    ),
    ["image"],
    "a devcontainer must select exactly one official container source mode"
  );
  assert.equal(
    config.image,
    "mcr.microsoft.com/devcontainers/go@sha256:" +
      "090a56c6c9c4e80a1573c18c1225eb851b8c86c199fc929b07ea2a67f7b4850f"
  );
  assert.equal(
    config.features["ghcr.io/devcontainers/features/github-cli:1.1.0"].version,
    "2.96.0"
  );
  assert.equal(config.features["ghcr.io/devcontainers/features/go:1.3.4"].version, "1.26.5");
  assert.equal(config.features["ghcr.io/devcontainers/features/node:2.1.0"].version, "24.18.0");

  for (const feature of Object.keys(config.features)) {
    assert.match(feature, /:\d+\.\d+\.\d+$/, `${feature} must use an exact Feature version`);
  }
  assert.deepEqual(Object.keys(lock.features).sort(), Object.keys(config.features).sort());
  const expectedFeatureDigests = {
    "ghcr.io/devcontainers/features/common-utils:2.5.9":
      "cb0c4d3c276f157eed17935747e364178d75fee17f55c4e129966f64633deb3a",
    "ghcr.io/devcontainers/features/github-cli:1.1.0":
      "d22f50b70ed75339b4eed1ba9ecde3a1791f90e88d37936517e3bace0bbad671",
    "ghcr.io/devcontainers/features/go:1.3.4":
      "d85e921f91b41340055bb12b325d9d551170ed04b3b832e33530bf42f167c032",
    "ghcr.io/devcontainers/features/node:2.1.0":
      "586c9a6f7dd40bd3ba2cd41e7f2f88dcc31fbe5d1442afcbf07ffbc66b686857"
  };
  for (const [feature, digest] of Object.entries(expectedFeatureDigests)) {
    const featureVersion = feature.slice(feature.lastIndexOf(":") + 1);
    assert.deepEqual(lock.features[feature], {
      version: featureVersion,
      resolved: `${feature.slice(0, feature.lastIndexOf(":"))}@sha256:${digest}`,
      integrity: `sha256:${digest}`
    });
  }

  assert.ok(config.mounts.some((mount) => mount.includes("go-mod-cache")));
  assert.ok(config.mounts.some((mount) => mount.includes("go-build-cache")));
  assert.ok(config.mounts.some((mount) => mount.includes("node-cache")));
  assert.ok(config.mounts.every((mount) => mount.includes("${devcontainerId}")));
  assert.equal(
    config.remoteEnv.PATH,
    "/home/vscode/.local/bin:${containerEnv:PATH}",
    "VS Code processes must see user-owned npm executables"
  );
  assert.match(config.postCreateCommand, /if \[ -f \.devcontainer\/scripts\/post-create\.sh \]/);
  assert.doesNotMatch(config.postCreateCommand, /apt-get install[^;]*\bgh\b/);
  assert.match(
    config.postCreateCommand,
    /go\.dev\/dl\/go1\.26\.5\.linux-\$\{go_arch\}\.tar\.gz/
  );
  assert.match(
    config.postCreateCommand,
    /amd64[\s\S]*go_sha=5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053/
  );
  assert.match(
    config.postCreateCommand,
    /arm64[\s\S]*go_sha=fe4789e92b1f33358680864bbe8704289e7bb5fc207d80623c308935bd696d49/
  );
  assert.match(
    config.postCreateCommand,
    /github\.com\/cli\/cli\/releases\/download\/v2\.96\.0\/gh_2\.96\.0_linux_\$\{gh_arch\}\.tar\.gz/
  );
  assert.match(
    config.postCreateCommand,
    /amd64[\s\S]*gh_sha=83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60/
  );
  assert.match(
    config.postCreateCommand,
    /arm64[\s\S]*gh_sha=06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909/
  );
  assert.match(config.postCreateCommand, /echo "\$\{gh_sha\}  \/tmp\/gh\.tar\.gz" \| sha256sum -c -/);
  assert.match(
    config.postCreateCommand,
    /install -m 0755 "\/tmp\/gh_2\.96\.0_linux_\$\{gh_arch\}\/bin\/gh" \/usr\/local\/bin\/gh/
  );
  assert.equal(config.postStartCommand, "bash .devcontainer/scripts/post-start.sh");

  const extensions = config.customizations.vscode.extensions;
  assert.ok(extensions.includes("golang.go"));
  assert.ok(extensions.includes("redhat.vscode-yaml"));
  assert.equal(new Set(extensions).size, extensions.length);
});

test("dev container lifecycle scripts are committed", async () => {
  await access(".devcontainer/scripts/post-create.sh");
  await access(".devcontainer/scripts/install-agent-clis.sh");
  await access(".devcontainer/scripts/post-start.sh");
  await access(".devcontainer/scripts/verify.sh");

  const postCreate = await readFile(".devcontainer/scripts/post-create.sh", "utf8");
  const installAgents = await readFile(
    ".devcontainer/scripts/install-agent-clis.sh",
    "utf8"
  );
  const postStart = await readFile(".devcontainer/scripts/post-start.sh", "utf8");
  const safeDirectory = 'git config --global --replace-all safe.directory "${PWD}"';
  assertAppearsBefore(
    postCreate,
    safeDirectory,
    "go mod download",
    "post-create must trust the bind mount before any repository command"
  );
  assertAppearsBefore(
    postStart,
    safeDirectory,
    "bash .devcontainer/scripts/post-create.sh",
    "post-start must trust the bind mount before invoking the fallback bootstrap"
  );
  assert.throws(
    () =>
      assertAppearsBefore(
        postCreate.replace(safeDirectory, ""),
        safeDirectory,
        "go mod download",
        "mutated post-create"
      ),
    /missing prerequisite/
  );

  assert.doesNotMatch(installAgents, /\bsudo\b/, "agent installation must not need sudo");
  assert.match(installAgents, /npm_prefix="\$\{HOME\}\/\.local"/);
  assert.match(
    installAgents,
    /npm install --global --prefix "\$\{npm_prefix\}"[\s\\]*[\s\S]*@openai\/codex@latest[\s\\]*[\s\S]*opencode-ai@latest/
  );
  assert.match(installAgents, /command -v codex/);
  assert.match(installAgents, /command -v opencode/);
  assert.match(
    installAgents,
    /path_line='export PATH="\$\{HOME\}\/\.local\/bin:\$\{PATH\}"'/
  );
  assertAppearsBefore(
    postStart,
    "bash .devcontainer/scripts/post-create.sh",
    "bash .devcontainer/scripts/install-agent-clis.sh",
    "fallback Node installation must finish before npm installs agent CLIs"
  );
});

test("provisioning tolerates transient registry failures with retries", async () => {
  await access(".devcontainer/scripts/lib.sh");
  const lib = await readFile(".devcontainer/scripts/lib.sh", "utf8");
  assert.match(lib, /^retry\(\)\s*\{/m, "lib.sh must define a retry helper");

  const postCreate = await readFile(".devcontainer/scripts/post-create.sh", "utf8");
  assert.match(postCreate, /^source .+lib\.sh/m, "post-create must load lib.sh");
  for (const networkStep of [
    "retry \\d+ sudo apt-get update",
    "retry \\d+ go mod download",
    "retry \\d+ go -C tools/actionlint mod download"
  ]) {
    assert.match(postCreate, new RegExp(networkStep), `post-create must retry: ${networkStep}`);
  }

  const installAgents = await readFile(".devcontainer/scripts/install-agent-clis.sh", "utf8");
  assert.match(
    installAgents,
    /retry \d+ npm install --global --prefix "\$\{npm_prefix\}"/,
    "agent CLI installation must retry transient npm registry failures"
  );
});

test("named-volume mount points are owned by the remote user on every start", async () => {
  const ownershipLine =
    /sudo install -d -o vscode -g vscode [\s\\]*[\s\S]*?\/home\/vscode\/\.cache\b/;

  const postCreate = await readFile(".devcontainer/scripts/post-create.sh", "utf8");
  assert.match(
    postCreate,
    ownershipLine,
    "post-create must create ~/.cache itself, not only its subdirectories"
  );

  const postStart = await readFile(".devcontainer/scripts/post-start.sh", "utf8");
  assertAppearsBefore(
    postStart,
    "install -d -o vscode -g vscode",
    "if [[ ! -f /home/vscode/.ambiguous-build-lock-post-create.complete ]]; then",
    "post-start must normalize volume mount-point ownership before any fallback bootstrap"
  );

  const config = await readJson(".devcontainer/devcontainer.json");
  for (const homeMount of ["/home/vscode/.cache/go-build", "/home/vscode/.npm"]) {
    assert.ok(
      config.mounts.some((mount) => mount.includes(`target=${homeMount}`)),
      `${homeMount} must stay a named volume`
    );
  }
});

test("hosted CI builds and verifies both native architectures", async () => {
  const workflow = await readFile(".github/workflows/devcontainer.yml", "utf8");

  assert.match(
    workflow,
    /uses: devcontainers\/ci@[a-f0-9]{40} # v0\.3\.1900000450/
  );
  assert.match(workflow, /platform: linux\/amd64/);
  assert.match(workflow, /runner: ubuntu-24\.04-arm[\s\S]*platform: linux\/arm64/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /runCmd: \.devcontainer\/scripts\/verify\.sh/);
  assert.match(workflow, /push: never/);
  assert.doesNotMatch(workflow, /\bself-hosted\b/);
});
