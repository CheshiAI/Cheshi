<p align="center">
  <img src="resources/icons/app-icon.png" alt="Cheshi" width="96" />
</p>

# Cheshi

A desktop workspace for AI-assisted development. Work with Codex, explore your
codebase with CodeGraph, and manage code, terminals, and Git in one place.

[Releases](https://github.com/CheshiAI/Cheshi/releases) ·
[English help](.docs/help/en/) · [한국어 도움말](.docs/help/ko/) ·
[CodeGraph guide](.docs/codegraph/guide.md)

Cheshi is in early development. Start with the source setup below; packaged
builds will be listed on the Releases page when published.

## Features

- **AI conversations:** work with Codex, attach files, revisit conversations,
  and use temporary chats for separate tasks.
- **Code exploration:** use local CodeGraph indexes to search symbols, inspect
  relationships, and follow callers and callees.
- **Editing:** edit project files with language support and inspect changes
  through local history.
- **Terminal:** use the embedded Ghostty terminal with split panes on macOS.
- **Git and projects:** open or clone repositories, review diffs, and manage
  branches and workspaces.

CodeGraph indexes are stored locally, outside your source repositories.
AI conversations use the configured provider and its authentication; local
indexing does not mean AI requests run offline.

## Run from source

The current native terminal integration targets macOS. Development requires:

- Bun **1.3.14 or newer** and Git.
- Node.js with native TypeScript stripping support for the desktop scripts.
- Full Xcode with its command-line tools selected, including Swift **6.0 or newer**,
  for the macOS terminal bridge.
- Codex CLI for AI conversations. The app guides you through its setup and login.
- GitHub CLI (`gh`) for GitHub account and repository features.

```sh
git clone https://github.com/CheshiAI/Cheshi.git
cd Cheshi
bun install
bun run desktop:dev
```

The first macOS run builds the native terminal bridge and downloads its pinned
Swift dependencies. Later runs reuse the build when its inputs are unchanged.
The development process reloads the renderer and restarts desktop services as
needed when source files change.

To open a particular project:

```sh
CHESHI_WORKSPACE=/absolute/path/to/your/project bun run desktop:dev
```

TypeScript/JavaScript, Python, and Rust language servers are detected by the app.
Packaged builds include the TypeScript server and Pyright; Rust support uses an
installed `rust-analyzer`. If a server is unavailable, parser-only support is used.

## CodeGraph CLI

Use the CLI from the checkout without a global installation:

```sh
bun run cheshi-cli --help
bun run cheshi-cli codegraph --help
bun run cheshi-cli codegraph status /absolute/path/to/your/project --json
```

For indexing, search, graph queries, and MCP setup, see the
[CodeGraph guide](.docs/codegraph/guide.md).

The optional native extraction kernel requires Rust and a C/C++ toolchain:

```sh
bun run --cwd codegraph build:kernel
```

Without this kernel, extraction uses the bundled WebAssembly grammars.

## Build and validate

Run commands from the repository root:

```sh
bun run typecheck
bun run test
bun run viewer:build
```

The full development check also validates the desktop entry points and preload:

```sh
bun run check
```

To package the desktop application or make a ZIP distribution for the host
platform and architecture:

```sh
bun run desktop:package
bun run desktop:make
```

Packaging outputs are written under `out/`. These commands build local artifacts;
publishing releases and signing distribution builds are separate steps.

## Configuration and local data

[`.env.product`](.env.product) contains public app branding and version metadata.
Keep credentials out of this file and out of Git. Local environment files and
build outputs are excluded by [`.gitignore`](.gitignore).

On macOS, workspace registrations, settings, and CodeGraph indexes use
`~/Library/Application Support/Cheshi/`. Opening a workspace without an index
starts its initial indexing. Existing indexes are reused.

## Project layout

| Path | Purpose |
| --- | --- |
| `cli/` | Public Cheshi CLI |
| `codegraph/` | Local indexing, extraction, graph queries, and MCP engine |
| `desktop/main.mts`, `desktop/lib/` | Electron lifecycle and desktop services |
| `desktop/preload.cts`, `desktop/shared/` | Desktop bridge and shared contracts |
| `desktop/frontend/` | React interface and shared controls |
| `desktop/backend/` | CodeGraph service and runtime host |
| `desktop/native/` | Native terminal integration |
| `config/`, `scripts/`, `forge.config.mts` | Product configuration and build tools |
| `.docs/` | User help and developer guides |

## Contributing

Bug reports and focused pull requests are welcome through
[GitHub Issues](https://github.com/CheshiAI/Cheshi/issues) and pull requests.
Include reproduction steps and the relevant platform and app version when
reporting a problem. Remove credentials and private project data from logs.

Read [AGENTS.md](AGENTS.md) for repository conventions and validation commands,
and [desktop/AGENTS.md](desktop/AGENTS.md) for desktop UI conventions.
Keep changes focused and run the checks for the affected area.

## License and acknowledgements

Cheshi's original code is available under the [MIT License](LICENSE).
Included third-party code retains its own copyright notices and license terms;
see [Third-party notices](THIRD_PARTY_NOTICES.md).

Cheshi builds on CodeGraph by Colby Mchenry, Electron, Ghostty, Tree-sitter,
CodeMirror, and other open-source projects.
