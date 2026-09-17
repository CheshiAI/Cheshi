# Changelog

## 0.0.5-preview

Pending release

- Added expandable agent activity cards with agent details, work history,
  cumulative token usage, and cache reuse information.
- Added response statistics above the response actions, including the agent,
  model, reasoning effort, token usage, duration, and average output TPS.
- Fixed structured asynchronous questions to appear as inline question cards.
  Answered and skipped states persist after reopening conversations and
  restarting the app.
- Fixed line breaks in sent user messages to match the chat input.
- Fixed conversations failing to open when App Server responses contain Unicode
  line or paragraph separators.
- Replaced active chat indicators with shared loading icons.
- Improved Apple Notes loading to show a single centered indicator while
  opening a note.
- Unified agent and file-change card typography, spacing, and header heights
  with command cards.
- Matched the note-saving icon style to the other response actions.
- Fixed type errors in temporary-chat drag-and-drop tests.

## 0.0.4-preview

Pending release

- Added an Apple Notes workspace for browsing accounts and folders, searching
  loaded notes by title, and creating, editing, and deleting notes.
- Added a unified memo editor that uses the first line as the title, with
  formatting controls, Markdown paste support, and saving to Apple Notes.
- Added folder selection before opening a new memo in the editor.
- Added note attachments to Codex conversations and saving chat responses
  to Apple Notes. Attachments use the saved note's text.
- Added folder and note-list caching to retain loaded content during navigation
  and reduce repeated loading.
- Improved memo line breaks, heading layout, timestamps, and header actions.
  Added draft protection and conflict handling when the original note changes.
- Added a chat input history panel above the composer. Press Arrow Up in an
  empty input to browse previous prompts, then select one with Enter or a click
  to edit it before sending.
- Added shared status toasts and English keep-awake notifications that
  automatically dismiss after 10 seconds.
- Added update download progress and animated indicators for verification,
  installation, and restart stages.
- Fixed file drag-and-drop attachments in temporary chats.
- Unified shared modal title styling and moved Relationship Graph to the top
  of the app navigation.

## 0.0.3-preview

Pending release

- Added a resizable split view with files on the left and the current app on the
  right. Closing the last file tab restores the app to full width.
- Added workspace file session restoration after restarting the app, including
  open tabs, tab order, and the selected file. Files are reopened from disk;
  unsaved edits are not stored in the session.
- Added workspace file search with Shift+F and keyboard navigation. The shortcut
  preserves normal typing in inputs, editors, and terminals.
- Added automatic clipboard copying when dragging to select text across the app,
  including the embedded terminal. Improved terminal selection colors and fixed
  Command+C and Command+V with Korean input enabled.
- Added Git status colors to changed filenames in the Explorer and the current
  Git branch to the workspace status bar.
- Added a commit graph that shows actual parent relationships with colored
  branch and merge lines.
- Added a chat message queue with sequential sending after the current response,
  pause controls, editing, deletion, steering, and opening messages in a side chat.
- Added selectable chat question cards with free-text answers. Answered and
  skipped cards stay dismissed after reopening a conversation or restarting the
  app, while new turns can show their own questions. Improved card positioning
  and made answer fields start at one line.
- Added a back button in subagent conversations and fixed returning to the parent
  conversation when the selected agent is no longer in the available agent list.
- Moved conversation search above the chat session groups in the CHATS sidebar.
  The search field is hidden when there are no sessions.
- Added a keep-awake toggle and simplified account usage tray colors.
- Removed the editor header loading spinner to prevent flickering during file
  refreshes.
- Fixed automatically detected Node-based language servers to use the bundled
  runtime when an external Node executable is unavailable, while retaining the
  detected language server installation.
- Improved CodeGraph call resolution for local store actions and typed property
  receivers, reduced incorrect matches between same-named methods, and corrected
  caller/callee messages when narrowing results to a file.

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
