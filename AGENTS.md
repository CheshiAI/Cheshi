# Repository Instructions

These instructions apply to the entire repository. Reviewed for GPT-6 Astra on
2026-09-06. Model selection and reasoning effort belong to the active runtime;
this file defines the repository's working agreements.

## Working agreements

- Complete the requested work, including relevant validation, within the agreed
  scope. Use conversation context to resolve routine implementation choices.
- Decide file organization, naming, internal design, work order, and validation
  methods autonomously within the requested scope and repository conventions.
  Ask about choices that materially change the intended result or scope.
- Fix adjacent issues when necessary to complete or validate the requested work,
  and report those changes. Propose independent features or large structural
  changes separately before expanding the scope.
- Respect current user directions over repository defaults and skill guidance,
  within the runtime's instruction hierarchy. Keep unrelated changes intact.
- When actual work shows that a repository rule or user direction limits a
  better solution, proactively explain the specific constraint and a concrete
  example, then propose an alternative and a focused adjustment with its
  benefits and tradeoffs. Continue authorized work where possible and follow
  the current instruction until the user approves changing it.
- Ask a focused question only when missing information materially changes the
  scope or blocks correct execution. Continue independent, authorized work while
  waiting. Do not request the same authorization twice.
- If a rule or tool approval blocks work, identify the exact instruction or
  rejection and its source. Prepare the reviewable result as far as authorized.
- Treat corrections and status questions as part of the ongoing task. Preserve
  decisions, completed checks, and remaining work across context compaction.
- Before saving project information, learned findings, or other content to
  persistent memory, tell the user what will be saved and where, ask for
  permission, and wait for explicit approval. Apply this to both new memory
  entries and updates to existing memories.
- Use judgment to decide when and how often to propose memory updates based on
  lasting usefulness, novelty, and relevance to future work. Group related
  findings into one proposal when practical to avoid unnecessary interruptions;
  this discretion does not authorize saving without the user's approval.
- Use parallel tool calls for independent reads and checks. Keep dependent
  operations and edits sequential. Autonomously delegate independent tasks to
  subagents when this can save time or improve quality. Assign bounded tasks
  with clear file ownership, coordinate shared dependencies, and personally
  review the combined result and relevant validation. Delegation follows the
  same scope and approval requirements as work performed directly.
- Communicate in Korean unless asked otherwise. Lead with the result, give brief
  progress updates during sustained work, and report concrete changes, checks,
  and unresolved issues without repeating the work log.

## Repository boundaries and tooling

- `cli/cheshi-cli.ts`: public CLI entry point.
- `codegraph/`: indexing, extraction, search, graph, and MCP engine.
- `desktop/main.mts`, `desktop/preload.cts`, `desktop/lib/`: Electron lifecycle,
  IPC bridge, and desktop services. Keep orchestration separate from service logic.
- `desktop/backend/codegraph-server/`: CodeGraph HTTP API.
- `desktop/frontend/src/features/`: feature UI and state; shared controls belong
  in `desktop/frontend/src/shared/ui/`.
- `desktop/native/`, `config/`, `scripts/`, `forge.config.mts`: native integration,
  configuration, development tooling, and packaging.
- Prefer feature and service boundaries compatible with an MSA monorepo. Split
  modules by responsibility, make dependency direction explicit, and preserve
  public contracts and behavior. Introduce independently deployed services or
  new communication layers only when included in the requested scope.
- Author JavaScript-family code in `.ts`, `.mts`, `.tsx`, or `.cts` as appropriate.
  Edit source files rather than generated `.js`, `.mjs`, or `.cjs` artifacts.
- Use Bun for dependency management and routine scripts. Check `package.json`
  for current command names; do not substitute npm or pnpm without a task reason.
- Use `cheshi-cli codegraph ...` publicly, or `bun run cheshi-cli codegraph ...`
  from an unlinked checkout. Use `bun run desktop:dev` for local development.

## CodeGraph workflow

Cheshi stores CodeGraph indexes outside source repositories under its user-data
directory. Do not use a repository-local `.codegraph/` directory as the index
status signal. Check the current Workspace with
`cheshi-cli codegraph status /absolute/path/to/workspace --json`; when it reports
`initialized: true`, use CodeGraph before `rg`, `find`, or manually reading
implementation files. Prefer the `codegraph_explore` MCP tool when available;
otherwise use the repository CLI path documented in the guide.

Before using CodeGraph or the desktop app, read
[`.docs/codegraph/guide.md`](.docs/codegraph/guide.md) once for the current task.
Check command options against CLI help and script names against `package.json`
when a documented command is unavailable.

- If status reports `initialized: false`, use ordinary source inspection.
  Creating an index is the user's decision.
- Query specific symbols or files and use the returned source and call paths.
  Read only uncovered or explicitly stale ranges directly; avoid repeating
  complete source reads merely to verify the tool's output.
- Git metadata, documentation, configuration, and the explicit file-length check
  below can be inspected directly without a CodeGraph query.
- Keep viewer inspection read-only. Do not initiate index creation, sync,
  rebuild, unlock, or removal without authorization; do not run a writer against
  an index being viewed. CLI, MCP, and app storage must resolve to the same
  workspace index. Never co-index it with a different engine implementation.
- An explore response truncated by its output budget does not prove an indexing
  failure. Narrow the query or inspect the remaining source range.

## Code conventions

### Electron and Node TypeScript runtime compatibility

- Author TypeScript for the runtime that executes each file. Electron loads the
  main process and its imported `.mts` services directly using Node's strip-only
  TypeScript support; renderer and bundled preload transforms do not apply there.
- In directly loaded modules, use erasable TypeScript syntax. Do not use
  constructor parameter properties such as
  `constructor(private readonly options: Options)`. Declare
  `private readonly options: Options` as a class field and assign
  `this.options = options` in the constructor instead. Avoid other constructs
  requiring TypeScript code generation, including enums and runtime namespaces.
- Bun tests and `tsc --noEmit` passing do not establish native runtime
  compatibility. When adding or changing a directly loaded module, verify its
  imports with native Node in strip-only mode, without a transpiling loader or
  transform-types flag. For an import-safe service, use a command such as
  `node --input-type=module -e "await import('./desktop/lib/codex-chat-contexts.mts')"`.
- Keep import checks free of app startup, provider requests, and other external
  side effects. For entrypoints that require Electron, validate through an
  appropriate runtime test. Add a native Node loading regression test when fixing
  a runtime syntax failure; checking only the entrypoint's syntax misses imported
  modules.

### Asynchronous test assertions

- In Bun test files, do not use
  `await expect(promise).resolves...` or
  `await expect(promise).rejects...`.
  Bun's assertion typings can make the final matcher appear synchronous,
  causing TypeScript and JetBrains to report `TS80007`.
- For successful promises, await the promise itself and then assert its value:
  `expect(await operation).toEqual(expected)`.
- For expected failures, use a small asynchronous helper that awaits the
  operation, fails if it resolves, and validates the rejected error.
  Reuse a local helper when a test file contains more than one such assertion.
- Do not suppress these warnings with inspection comments when the asynchronous
  control flow can be expressed clearly in code.

### Clear platform API names

- Alias generic filesystem APIs when their bare names are ambiguous to an IDE
  or reader. In particular, import `link` as `createHardLink` and `symlink` as
  `createSymbolicLink`.
- Extract repeated deferred-Promise or asynchronous gate setup into a named
  helper such as `createDeferred` instead of duplicating the setup in tests.

### Boundary validation and maintainability

- When interpreting an external value as true, require the actual literal
  `true`; do not simplify these checks to general truthiness. Preserve the
  existing contract for `false` and invalid values.
- When validation inside a recovery `try`/`catch` must fail by throwing, move
  the throw into a named assertion helper while preserving the original call
  position, recovery flow, and `catch`/`finally` behavior. This extraction rule
  applies to validation failures inside recovery blocks, not to every `throw`.
- Do not leave unused imports, types, functions, or methods in the codebase.
- Let TypeScript infer straightforward React component return types; do not add
  `JSX.Element` annotations unless an explicit public type boundary requires
  one.
- Do not silence Qodana, IDE, linter, compiler, or static-analysis findings
  with suppression comments. Fix the underlying code or make the usage
  statically discoverable instead.
- Extract repeated validation or comparison logic into a shared helper or an
  explicit field-name constant.
- When a test double intentionally returns malformed data, explicitly type its
  parameters and keep any unsafe cast confined to the injected boundary.

## Verification

- For code changes, run the directly affected regression tests and relevant
  typechecks. Add tests for meaningful behavior or boundary cases, not assertions
  that merely copy a reversible style or implementation change.
- Choose commands from the current root scripts:

  | Changed area | Relevant typecheck |
  | --- | --- |
  | Renderer TypeScript / React | `bun run viewer:typecheck` |
  | Electron, desktop services, configuration, scripts | `bun run desktop:typecheck` |
  | CodeGraph HTTP API (`desktop/backend/codegraph-server/`) | `bun run desktop:typecheck` |
  | Desktop tests and their imported modules | `bun run codegraph:server:typecheck` |
  | Public CLI | `bun run cli:typecheck` |
  | CodeGraph engine and its tests | `bun run codegraph:typecheck` |

- Use `bun test <test-file>` for Bun suites. Retain `node --test <test-file>` for
  suites that the existing `desktop:test` script runs under Node.
- Validate renderer or CSS bundling with `bun run viewer:build` when affected.
  For packaging changes, verify the runtime includes new modules and their
  transitive imports. Run packaging checks when that boundary changes.
- For documentation-only changes, verify referenced paths, commands, links, and
  `git diff --check`; application tests and builds are unnecessary.
- After checks pass, repeat or expand them only for a new edit, failure, unresolved
  concern, or explicit user request. Record sandbox limitations separately from
  product failures and use authorized escalation when needed for a valid check.
- A build or typecheck does not establish rendered UI correctness. State which
  checks actually ran; use Computer Use only as described below.

## Before ending a turn: changed-file length check

This is a coding-agent check performed before the final response. It does not
install an application event handler or a runtime Stop hook.

1. At the start of editing, note the existing worktree changes. Maintain an
   explicit set of files created, edited, or renamed during this turn, including
   changes made through shell commands and any authorized delegated work.
2. After the final edit, formatter, and relevant checks, inspect only those paths
   in their current on-disk state. Include new untracked files and previously
   dirty files if this turn also edited them. A whole-worktree `git diff` or
   `git status` list alone is not evidence of this turn's ownership.
3. Count physical lines in each remaining authored text file, including source,
   tests, styles, configuration, and documentation. Treat LF, CRLF, and CR as
   line endings; a final line ending does not add an extra empty line. Empty
   files have zero lines. Flag files with **more than 1,000 lines**.
4. Skip deleted files, binaries, generated output, dependencies, lockfiles, and
   generated parser/vendor sources. Identify any relevant exclusion or read
   failure rather than counting an unread file as passing.
5. Report the number of checked files and any exceeding paths with exact line
   counts. If this turn changed no files, omit the check. Do not scan the entire
   repository unless the user requests a repository-wide audit.
6. Keep authored modules within 1,000 lines when implementing or refactoring
   within the authorized scope. Recommend a focused split for remaining large
   files; report exceptions without silently expanding the task. Preserve
   behavior, imports, and tests. Do not compress formatting or remove useful
   documentation just to reduce the count.

The 1,000-line guideline is a maintainability target, not a CodeGraph indexing
or response-size limit. Preserve the turn's path set through context compaction.

## UI design defaults

For desktop UI work, also read [desktop/AGENTS.md](desktop/AGENTS.md) for the
circular icon button sizing exception.

- Use `12px` as the default UI font size. Set larger or smaller sizes explicitly
  for titles, headers, and other intentional typography.
- Use `16px` as the default spacing value for `gap`, `padding`, `margin`, and
  related layout spacing. Prefer the `--space-default` token for generic
  spacing, while preserving intentional structural offsets and reset values.
- Use `15px × 15px` as the default SVG icon size through
  `--icon-size-default`. Override it only for intentional brand or decorative
  icon treatments.
- Use `--icon-default` for adjacent icon-only controls; its current value in
  `desktop/frontend/src/styles.css` is `8px`. Use `--sidebar-width` for shared
  side panels; its current value is `320px`. Reuse tokens rather than duplicating
  feature-specific widths or gaps.
- Use icons from the official [Lucide icon set](https://lucide.dev/icons/).
  In the frontend, prefer the corresponding `lucide-react` component when it
  is available.

### Shared controls and panels

- Use the shared `LiquidGlassPanel` exported from
  `desktop/frontend/src/shared/ui` for reusable panel wrappers.
  Select the semantic wrapper with its `as` prop and keep feature-specific
  sizing and layout in the consumer's class.
- Read `LiquidGlassPanel.module.css` and the relevant shared control styles
  before changing their appearance. Use properties those components actually
  implement. Do not infer an alpha, shadow, gradient, or surface color from a
  component's historical name or reintroduce obsolete visual effects.
- Keep shared borders, radii, and backdrop effects in the shared component.
  For a flush sidebar wrapper, use its existing `--liquid-glass-radius: 0`.
- Match existing inputs and controls across normal, hover, focus, and disabled
  states. Enabled buttons and clickable cards use a pointer cursor; editable
  fields retain a text cursor. Match surrounding row height, typography, and
  icon treatment when adding a diagnostic or message.
- Apply visual changes only within the requested scope; preserve intentional
  theme differences and existing exceptions to the default typography.

## Computer Use with Electron

- The user owns rendered UI review. Do not launch, screenshot, or control the
  app for visual verification unless the user explicitly delegates it. Supplied
  screenshots may be inspected without opening the app.
- When controlling Cheshi through Computer Use, never target the app with the
  generic name `Electron` or the shared bundle identifier
  `com.github.Electron`. Multiple project checkouts can use that identity, and
  Computer Use may launch the wrong checkout's default Electron window.
- Treat app-selection and state-reading APIs as potentially launching a target.
  Do not probe candidate Electron application paths with them merely to discover
  which one is Cheshi.
- First inspect the already-running processes and resolve the exact
  `Electron.app` path belonging to the current Cheshi checkout. Pass only that
  exact path to Computer Use. If Cheshi is not running, start it with
  `bun run desktop:dev` before resolving the path.
- Do not open or control an Electron binary from another project unless the user
  explicitly places that project in scope. Keep one Cheshi application window
  open during verification.
- Open DevTools only when it is needed for diagnosis, and close it afterward.
  Preserve unsaved editor content and leave unrelated applications alone.

## Git commits and pushes

- Create a Git commit only when the user explicitly requests a commit.
- Push to a remote only when the user explicitly requests a push.
- Editing, building, testing, or completing a task does not implicitly authorize a commit or push.
- Use the requested/current branch and its configured remote; do not assume
  `main`. A completed commit/push request does not authorize future changes.
- Commit messages must use a lowercase flag in square brackets followed by a concise imperative summary.
- Except for the required square brackets and spaces, commit messages must contain only lowercase English letters (`a-z`).
  Do not use uppercase letters, Korean, numbers, or other punctuation.
- Use the format: `[flag] summary`.
- Appropriate flags include `[init]`, `[feature]`, `[fix]`, `[refactor]`, `[docs]`, `[test]`, `[build]`, and `[chore]`.

Example:

```sh
git commit -m "[init] set up project"
```

## Git worktree workflow

- Worktree directories must be created as siblings of the main repository.
- Use the path format `../<project>-<branch-slug>`.
- Worktree branch names must use one of these prefixes:
  `worktree/feature/<name>`, `worktree/fix/<name>`, or `worktree/experiment/<name>`.
- Create a new worktree from `main` with:
  `git worktree add -b worktree/<type>/<name> ../<project>-<branch-slug> main`
- Check existing worktrees with `git worktree list` before creating one.
- Never remove a worktree with uncommitted changes without explicit approval.
- Remove completed worktrees with:
  `git worktree remove ../<project>-<branch-slug>`
- Run `git worktree prune` only to clean stale worktree metadata.

## GitHub authentication checks

- Direct pushes use Git's authentication. Do not run `gh auth status` as a
  prerequisite for an ordinary commit/push to an existing remote.
- Use `gh auth status` only for GitHub CLI/API work or to diagnose its failure.
  On this macOS machine, request approved escalation first so it can access the
  keyring; sandboxed failures do not establish invalid or expired credentials.
- If a sandboxed check ran accidentally, verify with approved escalation before
  diagnosing authentication. Use `gh api user --jq .login` when stronger evidence
  is needed. If verification is unavailable, report that limitation.
- Git and `gh` success or failure do not establish each other's authentication
  state. Never run `gh auth token` or print a plaintext credential.

## Safety

- Resolve exact targets before deleting or overwriting files.
- Prefer recoverable operations where practical.
- Do not use broad recursive destructive commands against the project root, the home directory, or unresolved paths.

### Pre-commit and pre-push checks

- Before every commit, inspect the staged file list and staged diff to confirm that only files belonging to the requested change are included.
- Before committing, scan the staged changes for API keys, tokens, passwords,
  private keys, credentials, and authentication files. Before pushing, verify
  the outgoing commits contain only the reviewed and scanned changes; an empty
  staging area alone is not a pre-push scan.
- Check that generated build outputs, logs, temporary files, local databases, credential stores, and machine-specific files are not included unless the user explicitly requested them.
- If an unnecessary file or possible secret is found, stop the commit or push until it has been removed or the user has explicitly confirmed that it is safe and intended.
- Never print a complete secret while scanning or reporting findings. Report only the affected file, location, and secret category, with the value redacted.
- After pushing, confirm the upstream is synchronized and report any remaining
  worktree changes. Do not remove unrelated changes to obtain a clean status.

## Maintaining these instructions

Keep repository-specific commands and constraints here; link detailed workflows
instead of copying them. Verify current code before updating a rule that embeds
a path, design token, or runtime assumption.

Reviewed against [Astra prompting guidance](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices)
and [Codex instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
These links are maintenance references, not required reading for every task.
