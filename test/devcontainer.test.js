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
      "adc326255c019241228f9da4a1cb5d6a89abaaa0eb8d926a355b00af7daafd00"
  );
  assert.equal(
    config.features["ghcr.io/devcontainers/features/github-cli:1.1.3"].version,
    "2.101.0"
  );
  assert.equal(config.features["ghcr.io/devcontainers/features/go:1.4.0"].version, "1.27.1");
  assert.equal(config.features["ghcr.io/devcontainers/features/go:1.4.0"].golangciLintVersion, "2.14.0");
  assert.equal(config.features["ghcr.io/devcontainers/features/node:2.1.0"].version, "24.21.0");

  for (const feature of Object.keys(config.features)) {
    assert.match(feature, /:\d+\.\d+\.\d+$/, `${feature} must use an exact Feature version`);
  }
  assert.deepEqual(Object.keys(lock.features).sort(), Object.keys(config.features).sort());
  const expectedFeatureDigests = {
    "ghcr.io/devcontainers/features/common-utils:2.7.0":
      "3f63bbee7418dc940d9e5e7ab93ef3049acfe4dba3085b17ee45fe307fdba4e5",
    "ghcr.io/devcontainers/features/github-cli:1.1.3":
      "bd7ab48a832228f633239277552c30b353867fef2e5b037e064b4e64f0b843f2",
    "ghcr.io/devcontainers/features/go:1.4.0":
      "3b2c7acfdb24de88292283d10eb7517ccc45f60ae22a97030f1cf4fbd03634f3",
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
    /go\.dev\/dl\/go1\.27\.1\.linux-\$\{go_arch\}\.tar\.gz/
  );
  assert.match(
    config.postCreateCommand,
    /amd64[\s\S]*go_sha=63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445/
  );
  assert.match(
    config.postCreateCommand,
    /arm64[\s\S]*go_sha=3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec/
  );
  assert.match(
    config.postCreateCommand,
    /nodejs\.org\/dist\/v24\.21\.0\/node-v24\.21\.0-linux-\$\{node_arch\}\.tar\.xz/
  );
  assert.match(
    config.postCreateCommand,
    /amd64[\s\S]*node_sha=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6/
  );
  assert.match(
    config.postCreateCommand,
    /arm64[\s\S]*node_sha=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2/
  );
  assert.match(
    config.postCreateCommand,
    /github\.com\/cli\/cli\/releases\/download\/v2\.101\.0\/gh_2\.101\.0_linux_\$\{gh_arch\}\.tar\.gz/
  );
  assert.match(
    config.postCreateCommand,
    /amd64[\s\S]*gh_sha=9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8/
  );
  assert.match(
    config.postCreateCommand,
    /arm64[\s\S]*gh_sha=b57e8063f18862647c9d22727c32e9da1b963f8bf9db648fe123a6975695640f/
  );
  assert.match(config.postCreateCommand, /echo "\$\{gh_sha\}  \/tmp\/gh\.tar\.gz" \| sha256sum -c -/);
  assert.match(
    config.postCreateCommand,
    /install -m 0755 "\/tmp\/gh_2\.101\.0_linux_\$\{gh_arch\}\/bin\/gh" \/usr\/local\/bin\/gh/
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
