# Changelog

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
