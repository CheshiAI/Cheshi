# Local file history

Cheshi automatically records changes to workspace text files independently of Git commits.
Choose **Local history** from a file's Explorer menu or click the history icon in the editor
to open that file's history page in the workspace. Closing the page returns to the previous view.

## Recording and restoring

- Opening a file in the editor stores its current contents as the initial snapshot.
- Saving records the original contents and the saved result, without duplicating identical contents.
- External changes detected by the app's file watcher are also recorded. Contents overwritten before
  the first observation, intermediate changes while the app is closed, and every intermediate state
  during rapid changes are not guaranteed. The app does not read the entire project on first launch.
- Selecting a time in the history list compares that snapshot with the current file on disk, side by side.
  Large changes may be simplified or the displayed rows limited; the page indicates when this happens.
- The current contents are stored before restoration. If the file on disk has changed since the comparison,
  restoration stops and a new comparison is displayed. Save any unsaved editor changes first.

## Retention and scope

History is stored under `workspaces/<workspace-id>/local-history/` in Cheshi's user data.
The default limits are 30 days, 100 MiB of contents and metadata combined per workspace,
and 10,000 entries. Reading or recording history removes older entries that exceed these limits.
Contents are deduplicated by hash, and metadata is replaced atomically.

History supports the UTF-8 text files supported by the existing editor. Images, binary files,
files exceeding the editor's size limit, and Git internal files are not recorded. External change
watching excludes dependencies and common build output directories. Supported text files in those
directories can still be recorded when explicitly opened or saved in the editor.

History is tracked by file path. Earlier history remains under the previous path after a rename.
Recreating deleted files and restoring an entire project are not currently supported.
This feature is for recovering work on this computer; it does not provide separate backups or remote storage.

## Validation

Run these commands from the repository root:

```sh
bun test desktop/test/local-history-service.test.ts desktop/test/local-history-store.test.ts desktop/test/local-history-runtime.test.ts desktop/test/local-history-ui-model.test.ts
bun run desktop:preload
node --test desktop/test/workspace-ipc.test.ts desktop/test/workspace-preload.test.ts
bun test desktop/test/workspace-status-bar.test.tsx
bun run viewer:typecheck
bun run desktop:typecheck
bun run codegraph:server:typecheck
bun run viewer:build
```
