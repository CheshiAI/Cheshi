# SESSION memory with Flash

Saved SESSION conversations use `memory_search` and `memory_read` through the
local Flash service. The tools are registered when a new Codex thread starts.
Restart the development app after updating its main process, then start a new
session. Resuming an older thread does not add dynamic tools to that thread.
The session list's existing lexical search is independent of these tools.

## Local setup

The development default executable is the sibling checkout's
`../cheshi-flash/.venv/bin/cheshi-flash`. Its installed package must advertise
`source.ingest.v1`, `sources.list.v1`, and `sessions.delete.v1` capabilities.
Install the Flash project and its pinned model dependencies using that project's
README. This integration does not install packages or download model files.

On macOS, the offline model cache defaults to
`~/Library/Caches/CheshiFlash/hub`; on Linux it defaults to
`~/.cache/CheshiFlash/hub`. The pinned model snapshot must already exist there.
Override paths before launching the app when using another installation:

```sh
CHESHI_FLASH_EXECUTABLE=/absolute/path/to/cheshi-flash \
CHESHI_FLASH_MODEL_CACHE=/absolute/path/to/huggingface/hub \
bun run desktop:dev
```

The app uses `<userData>/flash` for its independent database, socket and admin
credential. It shares one model process across workspace windows, starts it on
first synchronization and stops an owned process when its last window releases
it. A compatible external process is adopted without taking ownership of its
lifecycle. After a crash, the next request can start the process again.
Model loading has a 120-second deadline; socket calls have bounded deadlines.

## Synchronization and access

- Only saved parent conversations belonging to the current workspace and
  authenticated profile are ingested. Temporary chats, subagents, activity items
  and in-progress turns are excluded. Source text uses the existing visible
  history compiler, including its whitespace trimming and text-only user input.
- Flash applies the frozen original, whole-message, paragraph and atomic views.
  The host hashes message identity separately from its revision. Stable ordinals
  and authoritative paginated metadata preserve incremental updates across restarts.
  Unchanged sources reuse existing vectors; unchanged sync cursors do not write.
- Startup, completed turns, session changes and tool calls synchronize sources.
  File fingerprints avoid rereading unchanged histories. Every returned source
  is checked against freshly read history before being given to the model.
- The host fixes account/workspace scope and issues a short-lived grant for each
  call. Models cannot submit tokens, arbitrary scopes or administrative methods.
  Account changes, cancellation, pane disposal and turn completion retire pending
  results. Session deletion purges matching copies across account scopes in the
  workspace; deletion cleanup failures use the existing local-index warning.
- The SESSION heading shows Flash readiness; synchronization details show the
  number of processed messages once the total is known. Errors offer a retry.
  Status polling reads in-memory snapshots and does not start model work.
- Tool calls wait up to five minutes for shared synchronization, then continue
  automatically. Stop cancels the request while background synchronization continues.
  A wait deadline returns `sync_timeout` with retry guidance, never an empty search. Unsupported oversized sources or failed reads prevent a
  successful sync; data is not silently truncated or skipped. Service limits
  include 100,000 source characters, 512 representations, 8,192 model tokens per
  representation and 256 KiB per socket request.

This phase connects foreground SESSION panes. Homie tool packages, a packaged
Flash installer are separate work. The previously
agreed 1024 MB limit applies to the future tool container, not the native model
process. No rendered UI review is implied by the tests below.

## Validation

```sh
bun run desktop:typecheck
bun run codegraph:server:typecheck
bun run desktop:test:flash
# Opt in only with the installed, offline model available:
CHESHI_TEST_FLASH=1 bun run desktop:test:flash
node --test desktop/test/config-runtime.test.ts
```

The native test uses a temporary DB and synthetic conversations. It verifies
model startup, scoped search, paginated original reads, updates, idempotent sync,
external-service adoption, process shutdown/restart and cross-account deletion.
It never launches the desktop UI or calls a provider model.

On 2026-10-07, the existing 204-question frozen evaluation retained identical
Top 30 ordering with both cached vectors and live model queries. The independent
50-question subset retained 48/50 Top 10 and 49/50 Top 30. Live service socket
latency was 25.3 ms median and 32.0 ms p95; these timings exclude host source
synchronization and revalidation. The original evaluation DB was unchanged.
All 6,013 messages' original/whole/paragraph/atomic inputs were compared against
private frozen fixtures without copying private conversation text into this
repository. A fresh host index assigns initial ordinals by thread ID and entry,
then preserves them. Replaying this order retained the same 48/50 and 49/50
quality results; 182/204 queries retained identical Top 30 ordering. The frozen
DB's original ordinals are not a promise about newly created indexes.
