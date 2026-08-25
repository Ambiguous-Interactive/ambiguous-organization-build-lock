# Development container

This repository includes the same development environment for VS Code and
VSCodium on Linux, macOS, and Windows. It provides Go 1.26, Node.js 24,
GitHub CLI, zsh, Go editor/debug tools, `actionlint` through the repository's
tool module, the latest stable OpenAI Codex and OpenCode CLIs from npm, and a
focused set of shell, JSON, search, and benchmarking tools.

## Start

1. Install Docker Desktop (macOS/Windows) or Docker Engine (Linux).
2. Install the Dev Containers extension in VS Code or VSCodium.
3. Open this repository and run **Dev Containers: Reopen in Container**.

The first build downloads the toolchains. Reopens and rebuilds reuse Docker
layers and named Go/npm caches. Run the complete local CI contract with:

```bash
.devcontainer/scripts/verify.sh
```

The lifecycle scripts download module dependencies, preserve command history,
and leave repository files owned by the host-compatible non-root `vscode`
user. On every container start, npm updates `@openai/codex@latest` and
`opencode-ai@latest` under the user-owned `~/.local` prefix. This installation
does not use `sudo`; `codex` and `opencode` are available on `PATH` in VS Code
terminals after startup completes.

### VSCodium launcher compatibility

There are two different VSCodium container workflows:

- A standards-compatible Dev Containers client uses the pinned image, Features,
  named caches, environment, and editor customizations in this repository.
- `DDorch.codium-devcontainer` is a deliberately smaller SSH-based launcher.
  It ignores `build`, Features, mounts, environment, and editor customizations.
  For that launcher, this configuration exposes a pinned Go 1.26 fallback
  `image`; its build-time lifecycle command installs checksum-verified Node.js
  24 and GitHub CLI releases. The remaining convenience utilities intentionally
  track the current packages in the image's Debian repositories and are not
  byte-pinned. The workspace-dependent bootstrap then runs through
  `postStartCommand` after the source bind mount exists.

Both paths run the complete repository verification suite. The first path has
the richer editor experience and persistent dependency caches. With the
DDorch launcher, use **Devcontainer: Rebuild & Open** after changing
`devcontainer.json`; a failed first build naturally has no container for
`docker inspect` to find.

The DDorch SSH workflow also requires the open-source Remote SSH extension on
the host VSCodium installation:

```bash
codium --install-extension jeanp413.open-remote-ssh
```

Do not substitute `ms-vscode-remote.remote-ssh`: that proprietary Microsoft
extension is not published to Open VSX. Reload VSCodium after installing the
open-source extension, then run **Devcontainer: Open Folder in Devcontainer
(SSH)** again.

## Performance notes

- The image is pinned by a multi-platform manifest digest and supports native
  `linux/amd64` and `linux/arm64`.
- Linux, Windows, Intel/Apple Silicon macOS hosts all run one of those native
  Linux container architectures. npm selects the matching CLI binary package
  inside the container rather than installing a host operating-system binary.
- Go modules, Go build artifacts, npm downloads, and shell history use named
  volumes. Rebuilding the container does not throw these caches away.
- Source remains a bind mount so host git tools and editors see changes
  immediately. On Windows, clone into the WSL 2 filesystem for materially
  better bind-mount performance.
- For the fastest macOS/Windows filesystem performance, use **Dev Containers:
  Clone Repository in Container Volume**. That places source inside Docker's
  Linux filesystem at the cost of not exposing it directly to host tools.
- The default configuration does not mount the Docker socket. It is not needed
  by this repository and would grant container processes control over the host
  daemon.

The declared minimum is 2 CPUs, 4 GB RAM, and 8 GB free storage. Four CPUs and
8 GB RAM make language-server indexing and cold Go compilation more pleasant.

## Editor compatibility

Editor customizations use the standard `customizations.vscode` Dev Container
field understood by standards-compatible clients in both editors. Every
recommended extension is available from Open VSX for VSCodium and from the
Visual Studio Marketplace for VS Code.
Catppuccin Mocha, Material Icons, Error Lens, bracket guides, and true-color zsh
provide the visual polish without requiring a patched font.

If an organization-managed VSCodium build disables extension installation,
the container and all terminal checks still work; only editor enhancements are
omitted. The DDorch launcher also intentionally ignores this customization
field, so install the recommended extensions in its SSH target when desired.

## Maintenance

Feature references, Feature tool selectors, the image, and fallback
Node.js/GitHub CLI artifacts are intentionally pinned. The fallback Debian
convenience packages are the scoped exception described above. When updating
the pinned inputs, run:

```bash
node --test test/devcontainer.test.js
npx --yes @devcontainers/cli@0.88.0 build --workspace-folder .
```

Then open or start the container and run the full verification script. Treat a
successful JSON parse as necessary but insufficient: Feature installers can
still reject schema-valid option combinations.
