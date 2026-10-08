# SESSION memory with Flash

Saved SESSION conversations use `memory_search` and `memory_read` through the
local Flash service. The tools are registered when a new Codex thread starts.
Restart the development app after updating its main process, then start a new
session. Resuming an older thread does not add dynamic tools to that thread.
The session list's existing lexical search is independent of these tools.

## Local setup

The development default executable is the sibling checkout's
`../cheshi-flash/.venv/bin/cheshi-flash`. Its installed package must advertise
`source.ingest.v1`, `sources.list.v1`, `sessions.delete.v1`, `search.ranges.v1`, and `memory.turns.v1`
capabilities. Restart both the app and an independently managed Flash service
after updating this contract.
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

- Saved parent conversations belonging to the current workspace across all
  connected authenticated profiles are ingested. Temporary chats, subagents, activity items
  and in-progress turns are excluded. Source text uses the existing visible
  history compiler, including its whitespace trimming and text-only user input.
  The embedding title is limited to 2,000 Unicode code points to match Flash's
  metadata contract. Original session titles and message text remain unchanged.
- Flash applies original, whole-message, paragraph and atomic views.
  Views use complete visible messages, without LLM selection. Paragraph and
  sentence boundaries are preserved; only a sentence exceeding the model input
  budget is split internally. The title prefix counts toward that budget.
  The host hashes message identity separately from its revision. Stable ordinals
  and authoritative paginated metadata preserve incremental updates across restarts.
  Unchanged sources reuse existing vectors; unchanged sync cursors do not write.
- Startup, completed turns, session changes and tool calls synchronize sources.
  File fingerprints avoid rereading unchanged histories. Every returned source
  is checked against freshly read history before being given to the model.
- The host collects each conversation through its owning profile and places the
  complete set in one workspace memory scope. A search ranks that complete set
  once; the active account can read evidence from other connected accounts.
  The host issues a short-lived grant for each call. Models cannot submit tokens,
  arbitrary scopes or administrative methods. Returned sources are revalidated
  through their current owning profile. Account membership changes, cancellation,
  pane disposal and turn completion retire pending
  results. Session deletion purges matching copies across account scopes in the
  workspace; deletion cleanup failures use the existing local-index warning.
- The SESSION heading shows Flash readiness; synchronization details show the
  combined message count across eligible profiles once the total is known.
  Every profile must be read successfully before reconciling the shared index;
  a failed read cannot publish a partially collected account set as ready.
  Profile additions, disconnections and authentication changes resynchronize
  membership even when the active profile remains unchanged. Errors offer a retry.
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

## Storage policy and reindexing

Storage does not call Luna or enqueue LLM preprocessing. Completed turns trigger
ordinary source synchronization. Only visible user/assistant text is ingested;
compaction snapshots and execution logs remain in the original history.
Typing, streamed output, session creation and catalog refresh notifications do
not schedule indexing. Ready searches and reads reuse the last synchronized
snapshot without starting another reconciliation. Initial loading, account
changes, deletion and explicit retry retain their synchronization paths; tools
wait if that synchronization is still pending. Source verification still checks
returned evidence against current originals. A completed turn triggers the
existing revision comparison, which ingests only added or changed messages.

The `visible-session-sentence-v2` source revision policy replaces previous
embedding inputs on the next synchronization, including previously selected
spans. Messages previously omitted by selection are recovered from the original
session, not from the Flash DB. Source IDs and existing ordinals remain stable.
Legacy files under `<userData>/flash/preprocessing` are no longer read or written.
An interrupted synchronization resumes by comparing source revisions.

Restart the app and Flash service after updating both checkouts. Reindexing uses
all connected authenticated profiles in the current workspace. The shared scope
uses the `session-workspace-memory-v1` namespace; legacy account-only scopes are
not queried. Existing vectors with identical inputs are reusable across scopes.
Disconnected or signed-out profiles are removed from the shared source set at
the next successful synchronization, which tool calls wait for when pending.
Selecting another active profile does not change the source set or reembed it.
## Retrieval and evidence summaries

`memory_search(query, limit?, session_id?)` keeps the existing vector and lexical
ranking, then deduplicates `(session_id, turn_id)` before applying the limit.
The strongest ranked representative retains its excerpt and source ID.

`memory_read(question, turns)` accepts 1–10 `{session_id, turn_id}` references.
The scoped Flash service reads every visible user/assistant message in each
selected turn in original order. The host verifies completeness and current
source revisions, then asks **Codex GPT-6 Luna, low effort** for a question-specific
summary, exact evidence quotes and an `insufficient_evidence` flag. The final
conversation model uses this evidence to answer the user. Search and storage
never call Luna.

Luna uses the active Codex subscription through a temporary, minimal-context,
tool-free session. Only the question and selected turns are supplied. Its wait
occurs outside Flash's administrative transaction. Source IDs and exact quote
membership are validated, and originals/access are checked again after inference.
If an exact quote fails only because paired `**bold**` or `__bold__` prose markers
were removed or added, a unique contiguous match can restore the original raw
quotation before returning it. This conservative fallback does not normalize
wording, case, whitespace, numbers, negation, code, math, or strikethrough. Ambiguous
matches and unsupported formatting differences remain errors. Returned evidence
always contains a literal substring of its identified original message.
This validates provenance, not every semantic inference in the summary.
Cancellation, account changes, edited/deleted originals and invalid citations
prevent a successful result. Model/provider failures remain errors, not empty
memory or a silently substituted model.

A request exceeding the existing 128,000-character temporary-session input budget
or Flash's 800,000-byte turn response budget fails explicitly; choose fewer turns.
No turn is silently truncated. `memory_read` no longer uses source offsets or
neighbor-message parameters in new SESSION threads. The Python service retains
its legacy raw-source endpoint for existing external clients. Restart the app and
Flash service and start a new session to receive the changed dynamic-tool schema.
No reembedding or DB migration is required for this retrieval-only update.

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
model startup, workspace search across accounts, full-turn original reads with a deterministic summary stub, updates, idempotent sync,
external-service adoption, process shutdown/restart and cross-account deletion.
It never launches the desktop UI or calls a provider model.

The following figures predate turn-deduplicated results and do not validate the new summary layer.
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
