import * as fs from 'fs';
import * as path from 'path';
import { logDebug } from '../errors';
import { loadExtensionOverrides } from '../project-config';
import {
  FileRecord,
  UnresolvedReference
} from '../types';
import {
  detectLanguage,
  initGrammars,
  loadGrammarsForLanguages
} from './grammars';
import {
  hashContent,
  type IndexProgress,
  SYNC_RECONCILE_YIELD_INTERVAL,
  type SyncResult
} from './indexing-contracts';
import type { ExtractionState } from './indexing-state';
import { resurrectRefFromDroppedEdge } from './indexing-storage-helpers';
import { scanDirectory, scanDirectoryAsync } from './scan-directory';
import { getGitChangedFiles } from './scan-git';


/**
   * Sync the index with the current file state.
   *
   * Change detection is filesystem-based, never git: a (size, mtime) stat
   * pre-filter skips unchanged files, then a content-hash compare confirms real
   * changes. This works in non-git projects and catches committed changes from
   * `git pull`/`checkout`/`merge`/`rebase` that `git status` cannot see.
   */
export async function sync(this: ExtractionState, onProgress?: (progress: IndexProgress) => void, scopedPaths?: string[]): Promise<SyncResult> {
  await initGrammars(); // Initialize WASM runtime (grammars loaded lazily below)
  const startTime = Date.now();
  let filesChecked: number;
  let filesAdded = 0;
  let filesModified = 0;
  let filesRemoved = 0;
  let nodesUpdated = 0;
  const changedFilePaths: string[] = [];

  onProgress?.({
    phase: 'scanning',
    current: 0,
    total: 0,
  });

  const filesToIndex: string[] = [];
  // === Filesystem reconcile (git-independent) ===
  // The source of truth for "what changed" is the filesystem vs the indexed
  // state — never git. We enumerate the current source files and reconcile
  // each against the DB. A cheap (size, mtime) stat pre-filter skips unchanged
  // files without reading or hashing them, so the expensive read+hash+parse
  // only runs for files that actually changed. This catches edits/adds/deletes
  // whether or not the project uses git, and crucially also catches committed
  // changes from `git pull`/`checkout`/`merge`/`rebase` — which `git status`
  // cannot see, because the working tree is clean afterward.
  const tSyncScan = Date.now();
  let currentFiles: string[];
  let trackedFiles: FileRecord[];
  if (scopedPaths && scopedPaths.length > 0) {
    // Scoped reconcile: stat only the reported paths. filesChecked counts
    // the PATHS examined (not the files found) — it must stay non-zero even
    // when every scoped path was a deletion, so result/progress reporting
    // still reflects the work the sync performed.
    const unique = [...new Set(scopedPaths)];
    currentFiles = unique.filter((p) => fs.existsSync(path.join(this.rootDir, p)));
    trackedFiles = [];
    for (const p of unique) {
      const rec = this.queries.getFileByPath(p);
      if (rec) trackedFiles.push(rec);
    }
    filesChecked = unique.length;
    if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] sync-scoped: ${Date.now() - tSyncScan}ms (${unique.length} paths, ${trackedFiles.length} tracked)`);
  } else {
    currentFiles = await scanDirectoryAsync(this.rootDir);
    if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] sync-scan: ${Date.now() - tSyncScan}ms (${currentFiles.length} files)`);
    filesChecked = currentFiles.length;

    const tTracked = Date.now();
    trackedFiles = this.queries.getAllFiles();
    if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] sync-tracked-load: ${Date.now() - tTracked}ms (${trackedFiles.length} tracked)`);
  }
  const currentSet = new Set(currentFiles);
  const trackedMap = new Map<string, FileRecord>();
  for (const f of trackedFiles) {
    trackedMap.set(f.path, f);
  }

  // Removals: tracked in the DB but no longer a present source file. Check the
  // filesystem directly — `scanDirectory` (via `git ls-files`) still lists a
  // file deleted from disk but not yet staged, so set membership alone misses it.
  // `reconcileChecks` drives the cooperative yield shared with the adds/mods loop
  // below (see SYNC_RECONCILE_YIELD_INTERVAL / issue #905).
  let reconcileChecks = 0;
  for (const tracked of trackedFiles) {
    if (!currentSet.has(tracked.path) || !fs.existsSync(path.join(this.rootDir, tracked.path))) {
      // Before the cascade deletes them, resurrect incoming cross-file
      // resolution edges as their original refs (#1240 removal case): the
      // callers live in files this sync will NOT revisit, so this is their
      // only chance to rebind to an alternative definition — or to park as
      // failed until the symbol reappears somewhere. (A deleted file whose
      // CALLERS are also being deleted is fine: their nodes cascade later
      // in this loop and take the resurrected rows with them.)
      const incoming = this.queries.getCrossFileIncomingEdgesWithTarget(tracked.path);
      if (incoming.length > 0) {
        const resurrected = incoming
          .map((e) => resurrectRefFromDroppedEdge(e))
          .filter((r): r is UnresolvedReference => r !== null);
        if (resurrected.length > 0) {
          this.queries.insertUnresolvedRefsBatch(resurrected);
        }
      }
      this.queries.deleteFile(tracked.path);
      filesRemoved++;
    }
    if (++reconcileChecks % SYNC_RECONCILE_YIELD_INTERVAL === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  // Adds / modifications.
  for (const filePath of currentFiles) {
    // Same cooperative yield as the removals loop — this is the other O(files)
    // synchronous-stat loop that wedges the main thread on a large repo (#905).
    // Yield at the top of the body so the `continue` fast-paths below still hit it.
    if (++reconcileChecks % SYNC_RECONCILE_YIELD_INTERVAL === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const fullPath = path.join(this.rootDir, filePath);
    const tracked = trackedMap.get(filePath);

    // Cheap pre-filter: an already-indexed file whose size AND mtime both match
    // the DB is unchanged — skip it without reading or hashing. (A content
    // change that preserves both exactly is the blind spot every mtime-based
    // incremental tool accepts; `index --force` is the escape hatch. Git bumps
    // mtime on every file it writes during checkout/merge, so pulls are caught.)
    if (tracked) {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size === tracked.size && Math.floor(stat.mtimeMs) === Math.floor(tracked.modifiedAt)) {
          continue;
        }
      } catch (error) {
        logDebug('Skipping unstattable file during sync', { filePath, error: String(error) });
        continue;
      }
    }

    // New, or size/mtime changed — read + hash to confirm a real content change.
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch (error) {
      logDebug('Skipping unreadable file during sync', { filePath, error: String(error) });
      continue;
    }
    const contentHash = hashContent(content);

    if (!tracked) {
      filesToIndex.push(filePath);
      changedFilePaths.push(filePath);
      filesAdded++;
    } else if (tracked.contentHash !== contentHash) {
      filesToIndex.push(filePath);
      changedFilePaths.push(filePath);
      filesModified++;
    }
  }

  // Load only grammars needed for changed files
  if (filesToIndex.length > 0) {
    const overrides = loadExtensionOverrides(this.rootDir);
    const neededLanguages = [...new Set(filesToIndex.map((f) => detectLanguage(f, undefined, overrides)))];
    // .h files default to 'c' but may be C++ — ensure cpp grammar is loaded
    if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
      neededLanguages.push('cpp');
    }
    await loadGrammarsForLanguages(neededLanguages);
  }

  // Index changed files
  const total = filesToIndex.length;
  for (let i = 0; i < filesToIndex.length; i++) {
    const filePath = filesToIndex[i]!;
    onProgress?.({
      phase: 'parsing',
      current: i + 1,
      total,
      currentFile: filePath,
    });

    const result = await this.owner.indexFile(filePath);
    nodesUpdated += result.nodes.length;
  }

  return {
    filesChecked,
    filesAdded,
    filesModified,
    filesRemoved,
    nodesUpdated,
    durationMs: Date.now() - startTime,
    changedFilePaths: changedFilePaths.length > 0 ? changedFilePaths : undefined,
  };
}

/**
   * Get files that have changed since last index.
   * Uses git status as a fast path when available, falling back to full scan.
   */
export function getChangedFiles(this: ExtractionState): { added: string[]; modified: string[]; removed: string[] } {
  const gitChanges = getGitChangedFiles(this.rootDir);

  if (gitChanges) {
    // === Git fast path ===
    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];

    // Deleted files — only report if tracked in DB
    for (const filePath of gitChanges.deleted) {
      const tracked = this.queries.getFileByPath(filePath);
      if (tracked) {
        removed.push(filePath);
      }
    }

    // Modified + added files — read + hash, compare with DB. Untracked (`??`)
    // files stay untracked in git even after indexing, so they must be
    // hash-compared like modified files instead of always counting as added —
    // otherwise status reports them as pending forever. (See issue #206.)
    for (const filePath of [...gitChanges.modified, ...gitChanges.added]) {
      const fullPath = path.join(this.rootDir, filePath);
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (error) {
        logDebug('Skipping unreadable file while detecting changes', { filePath, error: String(error) });
        continue;
      }

      const contentHash = hashContent(content);
      const tracked = this.queries.getFileByPath(filePath);

      if (!tracked) {
        added.push(filePath);
      } else if (tracked.contentHash !== contentHash) {
        modified.push(filePath);
      }
    }

    return { added, modified, removed };
  }

  // === Fallback: full scan (non-git project or git failure) ===
  const currentFiles = new Set(scanDirectory(this.rootDir));
  const trackedFiles = this.queries.getAllFiles();

  // Build Map for O(1) lookups
  const trackedMap = new Map<string, FileRecord>();
  for (const f of trackedFiles) {
    trackedMap.set(f.path, f);
  }

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  // Find removed files
  for (const tracked of trackedFiles) {
    if (!currentFiles.has(tracked.path)) {
      removed.push(tracked.path);
    }
  }

  // Find added and modified files
  for (const filePath of currentFiles) {
    const fullPath = path.join(this.rootDir, filePath);
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch (error) {
      logDebug('Skipping unreadable file while detecting changes', { filePath, error: String(error) });
      continue;
    }

    const contentHash = hashContent(content);
    const tracked = trackedMap.get(filePath);

    if (!tracked) {
      added.push(filePath);
    } else if (tracked.contentHash !== contentHash) {
      modified.push(filePath);
    }
  }

  return { added, modified, removed };
}
