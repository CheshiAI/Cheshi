# CodeGraph usage guide

Cheshi uses the Bun/TypeScript engine in `codegraph/` directly. CodeGraph analyzes
Workspace source files with Tree-sitter to build a local SQLite graph. Cheshi's
Viewer and Electron app open this database in read-only mode.

## Basic principles

- Use Bun to install packages and run commands.
- Store CodeGraph data in Cheshi's user data directory, outside source repositories.
  Do not create `.codegraph/` at the project root.
- Do not run `sync` or `index` against an index while its Viewer is open.
- When the app opens a Workspace without an index, it automatically runs initial
  indexing. Merely registering a Workspace in the list does not create an index,
  and existing indexes are reused. Incremental synchronization and full rebuilds
  require separate `sync` and `index` requests.
- Creating an index through the CLI or engine does not register a project in
  Workspaces. The list contains projects explicitly opened, added, or created in
  the app.
- Bun tests do not inherit the real app's storage directory. Engine tests use
  their temporary projects, and CLI tests use disposable app data for each run.
- Prefer `sync` over a full rebuild. `uninit` deletes the index; use it only when
  deletion is explicitly needed.

## Central storage layout

The default storage root on macOS has the following layout:

```text
~/Library/Application Support/Cheshi/
├── workspaces.json
└── workspaces/
    └── <workspace-name>-<path-hash>/
        ├── workspace.json
        └── codegraph/
            └── codegraph.db
```

`workspaces.json` manages Workspace source paths and their central storage paths.
The same real path always uses the same Workspace ID. Projects with the same name
at different paths do not collide because their path hashes differ.

To override the default location, use `CHESHI_USER_DATA_DIR` or
`CODEGRAPH_DATA_ROOT`, both of which require absolute paths. Normal development
and distribution use the default location calculated from the
`APP_DATA_DIRECTORY` value in `.env.product`.

## Installation and CLI

Install repository dependencies and check the CLI commands:

```sh
cd /absolute/path/to/cheshi
bun install
bun run cheshi-cli --help
bun run cheshi-cli codegraph --help
```

To use `cheshi-cli` directly outside Cheshi, register the repository root as a Bun
global link. The global CLI and the development entry point,
`bun run cheshi-cli ...`, both use Cheshi's central storage location.

```sh
bun link
cheshi-cli --version
cheshi-cli codegraph version
```

Remove the link:

```sh
bun unlink
```

## Initialization, status, and synchronization

Create the initial index for a new Workspace:

```sh
cheshi-cli codegraph init /absolute/path/to/workspace
```

The argument is the source Workspace to analyze, not the database storage
location. For example, passing `/absolute/path/to/your/project` creates the
database at `codegraph/codegraph.db` in the central layout above, rather than
inside the repository.

Check status:

```sh
cheshi-cli codegraph status /absolute/path/to/workspace --json
```

The key values for successful completion are `initialized: true`,
`index.state: "complete"`, and `index.pendingRefs: 0`. To apply only file changes,
use:

```sh
cheshi-cli codegraph sync --quiet /absolute/path/to/workspace
```

Use `index` only when the entire index needs to be rebuilt:

```sh
cheshi-cli codegraph index /absolute/path/to/workspace
```

If normal indexing fails after a previous operation terminated unexpectedly,
you can use a more conservative initialization path while preserving accuracy:

```sh
CODEGRAPH_NO_FAST_INIT=1 cheshi-cli codegraph index --quiet /absolute/path/to/workspace
```

For lock errors, first stop the running Viewer, MCP, and daemon, then check the
lock. Use the following command only after confirming it is a stale lock with no
active writer:

```sh
cheshi-cli codegraph unlock /absolute/path/to/workspace
```

## Queries and analysis

Search for symbols:

```sh
cheshi-cli codegraph query "CodeGraphService" \
  --path /absolute/path/to/workspace --limit 5 --json
```

Explore related source and call paths together:

```sh
cheshi-cli codegraph explore \
  "How does the Viewer service start?" \
  --path /absolute/path/to/workspace --max-files 5
```

Main query commands:

```sh
cheshi-cli codegraph node "CodeGraphService" --path /absolute/path/to/workspace
cheshi-cli codegraph files --path /absolute/path/to/workspace
cheshi-cli codegraph callers "CodeGraphService" --path /absolute/path/to/workspace
cheshi-cli codegraph callees "CodeGraphService" --path /absolute/path/to/workspace
cheshi-cli codegraph impact "CodeGraphService" --path /absolute/path/to/workspace
cheshi-cli codegraph affected --path /absolute/path/to/workspace path/to/changed-file.ts
```

Use `cheshi-cli codegraph help <command>` to check the exact options for each
command.

## CLI command scope

| Command | Purpose |
| --- | --- |
| `init [path]` | Initialize a Workspace and create its first index |
| `uninit [path]` | Delete the Workspace's CodeGraph index from central storage; `--force` skips confirmation |
| `index [path]` | Rebuild the entire index |
| `sync [path]` | Apply changes made since the last indexing operation |
| `status [path]` | Read status and statistics |
| `query <search>` | Search for symbols |
| `explore <query...>` | Explore related source and call paths together |
| `node [symbol\|file]` | Read symbol or file details |
| `files [path]` | Read the indexed file tree |
| `callers <symbol>` | Find callers |
| `callees <symbol>` | Find callees |
| `impact <symbol>` | Analyze the scope of change impact |
| `affected [files...]` | Find tests affected by changed files |
| `daemon` / `daemons` | Manage background daemons |
| `unlock [path]` | Remove a confirmed stale lock |
| `install` / `uninstall` | Connect or remove agent MCP configuration |
| `version` | Print the current engine version |

## Connecting Codex MCP

Cheshi desktop configures its own `cheshi_codegraph` MCP server for every chat
account. It uses the app's bundled CLI (or the current checkout's CLI during
development), the selected Workspace, and the same data root as the Viewer.
This includes custom `--user-data-dir` locations. The MCP connection opens the
index read-only; indexing remains under the app's control.

The desktop app reads the selected account's effective MCP configuration and
disables an existing legacy `codegraph` server only for its own app-server
process, avoiding duplicate connections. Other MCP servers and account
configuration files remain unchanged. No global CodeGraph installation is
required for desktop chats.

For standalone Codex CLI use outside Cheshi, configure MCP as follows.

After registering the `cheshi-cli` executable through a global link, install the
MCP configuration in Codex. This command changes Codex configuration in the user's
home directory, so run it only after an explicit user request.

```sh
cheshi-cli codegraph install --target codex --location global --yes
```

The installed `[mcp_servers.codegraph]` configuration also includes the
`CODEGRAPH_DATA_ROOT` environment variable pointing to the same central storage
root. The CLI, Cheshi Viewer, and Codex MCP therefore open the same Workspace
index. The MCP command is recorded as `cheshi-cli codegraph serve --mcp`.

Restart Codex after installation. The main MCP tools are `codegraph_explore`,
which returns the actual source of related symbols along with their call paths,
and `codegraph_node`, which reads symbol and file details.

## Read-only Viewer

Build the renderer and run a standalone Viewer:

```sh
bun run viewer:build
bun run codegraph:server:cli /absolute/path/to/indexed/workspace
```

The default address is `http://127.0.0.1:4317`. To set a port or add a project:

```sh
bun run codegraph:server:cli /absolute/path/to/workspace --port 48733
bun run codegraph:server:cli /absolute/path/to/workspace \
  --project /absolute/path/to/another-indexed-workspace
```

The Viewer supports project selection, symbol search, grouping by directory,
language, or kind, exploration depth and node limits, edge filters, Mermaid
relationship graphs, pan/zoom/fit, node selection, callers and callees, source
details, and opening files.

## Electron app

In development, the app restores the current repository's Workspace if it has a
completed index. If there is no index to restore, it shows only the Workspaces
list after the startup screen.

```sh
bun run desktop:dev
```

Launch with a different Workspace that has a completed index:

```sh
CHESHI_WORKSPACE=/absolute/path/to/indexed/workspace bun run desktop:dev
```

Development mode uses Vite HMR together with file watching that restarts Electron
and the Viewer. For distribution, the build creates the renderer, a Viewer host
for the current platform, `cheshi-cli`, the indexing worker, and Tree-sitter
resources before packaging with Forge. On macOS, the packaged CLI is included at
`Cheshi.app/Contents/Resources/runtime/<platform>-<architecture>/cheshi-cli`.
A future CLI installation button in the app can link this executable into the
user's PATH.

```sh
bun run desktop:package
```

The distributed app does not use its current working directory as the Workspace.
It restores a recent Workspace from the central list when the actual folder and
a completed index exist. Otherwise, it opens a dedicated Workspaces window.
The filesystem root (`/`) is excluded from automatic restoration. Even if a
project can be restored, the app first checks CLI installation and Codex sign-in
status. If either requirement is missing, it opens the Workspaces setup screen.
While only the Workspaces list is open, the app does not start project
registration, indexing, file watching, terminals, or Codex conversation services.
These start after the user opens or clones a folder.

The dedicated Workspaces window stays hidden while checking CLI installation
and Codex sign-in status. Once the checks finish and the installation guide,
sign-in screen, or project list has rendered, the app closes the startup screen
and shows the prepared window. It starts the account-checking app server only
after CLI installation is confirmed. The sign-in button starts browser
authentication. Closing the list window also stops that sign-in server.

Electron starts the Viewer child process only when the current Workspace's
`codegraph/codegraph.db` exists in central storage. It waits for the
`{ "type": "ready", "url": "..." }` readiness message on stdout. The Viewer also
stops when the app exits. If no index exists, the app registers the Workspace and
finishes initial indexing before connecting the Viewer and opening the window.
Initial indexing runs only once even when the same Workspace is opened in
multiple windows.

During initial indexing, the app keeps a `codegraph.db.initializing` marker in
central storage. If indexing fails, it opens only the Workspace and reports the
error without querying an incomplete database. Reopening retries unfinished
initial indexing. Existing completed indexes are not rebuilt automatically.

## Development diagnostics

CodeGraph's internal diagnostic tools are TypeScript sources in
`codegraph/src/devtools/` and are included in `codegraph:typecheck`. Use the
Workspace commands instead of executing file paths directly.

```sh
bun run --cwd codegraph dump:graph -- /absolute/path/to/indexed/workspace
bun run --cwd codegraph extraction:verify -- /absolute/path/to/indexed/workspace typescript
bun run --cwd codegraph grammar:check -- typescript /absolute/path/to/valid-sample.ts
bun run --cwd codegraph grammar:dump-ast -- typescript /absolute/path/to/sample.ts --depth=4
```

To compare native kernel and WASM extraction results against a real repository,
build the kernel first, then run the parity tool:

```sh
bun run --cwd codegraph build:kernel
bun run --cwd codegraph kernel:parity -- /absolute/path/to/workspace --lang typescript,tsx
```

`dump:graph` and `extraction:verify` read the existing index in Cheshi's central
storage location. They do not create `.codegraph/` inside the repository.

## Validation

```sh
bun run typecheck
bun run codegraph:server:test
bun run codegraph:test
bun run desktop:package
```

Qodana is not part of this validation workflow. The user downloads and runs large
analysis tools separately.
