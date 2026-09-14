# Changelog

## 0.0.3-preview

Build 0004 · 2026-09-14

### Chat and agents

- Added an instruction queue: press `Tab` during an active task to queue the next
  instruction for delivery in order after the current task finishes. `Enter`
  sends an instruction to the current task immediately.
- Show queued instruction text, attachments, and status, with individual
  cancellation and resumption after pausing. Instructions with unconfirmed
  delivery are not resent automatically.
- Applied `backdrop-filter: blur(24px) saturate(88%)` to the queue panel.
  The right-hand `Waiting` label changes to `Cancel` on hover or keyboard focus;
  clicking cancels that instruction. The control keeps its width when labels change.
- Display asynchronous questions as interactive cards with selectable options
  and custom answers. Added collapsible custom-answer fields and 11px typography.
- Restore submitted answers and disable completed question cards when reopening
  a conversation or returning from a subagent.
- Finish Stop when the current turn has ended and its running-command list is
  empty, even if an individual command completion notification was missed.
  Keep retry available while command termination remains unconfirmed.
- Separated the current selection from thread runtime status in `/agent`.
  Clarified that `Thread: Not loaded` describes runtime loading, not task completion.
- Added 4px spacing between agent list entries.
- Added a button before the subagent session ID to return to the main agent.
  Hide the agent logo when this back button is shown.
- Aligned send-failure notices with the composer and enabled wrapping for long errors.
- Moved chat search between the `CHATS` heading and date groups, matching the
  list's horizontal spacing. Hide the search field and its space when history is empty.
- Added 4px horizontal spacing between inline code and surrounding chat text.

### File search and editor

- Added a file search dialog opened with `Shift+F`, supporting file names and paths.
  Use arrow keys to select a result and `Enter` to open it. Avoid shortcut conflicts
  during Korean text composition or while another dialog is open.
- Show the editor on the left alongside chat, terminal, or another workspace page
  on the right. Preserve the right-hand page and sidebar state when switching files.
- Preserve mounted content and the split ratio when collapsing or expanding the
  file pane, with animated transitions.
- Restore saved file editor sessions after a normal app shutdown and restart.
- Restore the editor/page split ratio across restarts. Temporarily constrain it
  to pane size limits in smaller windows without replacing the saved preference.
- Removed the right-sidebar toggle from the file editor header.
- Removed the transient file-loading spinner from the header to prevent controls
  from shifting when opening files.
- Keep split separators colored with `--divider` during hover and dragging.
- Mark files with Git changes in Explorer using `--codegraph-disabled`.
- Use `--divider` for diagnostic popover backgrounds and borders, remove the red
  left-hand accent, and apply rounded corners with 4px vertical and 8px horizontal padding.
- Run detected Node-based language servers with the app's bundled runtime when
  launching from Finder without Node on PATH.

### App behavior and connection reliability

- Automatically copy text selected by mouse dragging in chat, input fields,
  the code editor, and the Ghostty terminal to the clipboard.
- Added a display and idle sleep prevention toggle to the left of Help.
  Enabling it runs `caffeinate -d -i`; disabling it or quitting the app stops the
  process started by the app. Show `CircleStop` when enabled and `CirclePlay` when disabled.
- Request reconnection when a CodeGraph MCP connection closes. Check connection
  status before sending messages and when opening `/mcp`, with duplicate requests
  coalesced and repeated attempts throttled. Preserve connection settings and indexes,
  and do not automatically replay failed instructions.
- Use shared loading indicators for app update progress.
- Include the new IPC and runtime modules in app packages and add regression
  coverage for queues, question responses, agent navigation, file search,
  session restoration, sleep prevention, and MCP recovery.

## 0.0.2-preview

Build 0003 · Pending release

- Added workspace conversation guidance to prefer CodeGraph for code structure,
  symbols, and call relationships, report query failures before falling back to
  file search, and require user authorization before creating or modifying indexes.
  Explicit user requests and project instructions take precedence over this default.
- Added bug report and feature request forms, a pull request template, and
  contribution guidelines.
- Documented Homebrew installation, updates, dependencies, and automatic CodeGraph
  configuration. Updated the README logo.
- Added this changelog and separated local agent preferences from shared
  repository instructions.

## 0.0.1-preview

[Release notes and downloads](https://github.com/CheshiAI/Cheshi/releases/tag/v0.0.1-preview)
· Build 0002

- Released the first signed and notarized macOS preview for Apple Silicon Macs
  running macOS Tahoe 26 or later.
- Added installation through the Cheshi Homebrew Tap, with GitHub CLI and Codex CLI
  declared as dependencies.
- Added Codex conversations with file attachments, conversation history, temporary
  chats, and connected conversations in Review, Debate, and Consensus modes.
- Added workspace CodeGraph indexing, symbol search, and caller/callee exploration.
  The app supplies its bundled MCP executable and workspace index path without
  requiring a separate CodeGraph installation or manual MCP configuration.
- Added project editing with local history, an embedded Ghostty terminal with
  split panes, and Git repository and workspace management.
- Added app update notifications and workspace recovery.
- Fixed account usage loading when no project is open, ensured the startup screen
  remains visible for at least two seconds, and delayed workspace loading feedback
  until a folder is selected.
- Redesigned the About window with separate version and build values, displayed
  build numbers with four digits, and normalized connected conversation titles.
