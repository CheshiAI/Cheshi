import type { CodeGraphState } from './project-state';
import { FileWatcher, PendingFile, WatchOptions } from './sync';

// ===========================================================================
// File Watching
// ===========================================================================

/**
 * Start watching for file changes and auto-syncing.
 *
 * Uses native OS file events (FSEvents on macOS, inotify on Linux 19+,
 * ReadDirectoryChangesW on Windows) with debouncing to avoid thrashing.
 *
 * @param options - Watch options (debounce delay, callbacks)
 * @returns true if watching started successfully
 */
export function watch(this: CodeGraphState, options: WatchOptions = {}): boolean {
  this.assertWritable('start automatic sync');
  if (this.watcher?.isActive()) return true;

  this.watcher = new FileWatcher(
    this.projectRoot,
    async (paths?: string[]) => {
      const result = await this.owner.sync({ paths });
      const filesChanged = result.filesAdded + result.filesModified + result.filesRemoved;
      return { filesChanged, durationMs: result.durationMs };
    },
    options
  );

  return this.watcher.start();
}

/**
   * Stop watching for file changes.
   */
export function unwatch(this: CodeGraphState): void {
  if (this.watcher) {
    this.watcher.stop();
    this.watcher = null;
  }
}

/**
   * Check if the file watcher is active.
   */
export function isWatching(this: CodeGraphState): boolean {
  return this.watcher?.isActive() ?? false;
}

/**
   * True once live watching has permanently degraded (OS watch-resource
   * exhaustion, or a write lock held past the retry budget) and auto-sync is
   * disabled until the next {@link watch} call. Distinct from `!isWatching()`:
   * a stopped/never-started watcher is inactive but NOT degraded. MCP tools use
   * this to surface a whole-index "results may be stale" notice, since
   * `getPendingFiles()` goes empty once watching stops (#876).
   */
export function isWatcherDegraded(this: CodeGraphState): boolean {
  return this.watcher?.isDegraded() ?? false;
}

/** The reason live watching degraded, or null if it is healthy (#876). */
export function getWatcherDegradedReason(this: CodeGraphState): string | null {
  return this.watcher?.getDegradedReason() ?? null;
}

/**
   * Files seen by the file watcher since the last successful sync —
   * the per-file "stale" signal MCP tools attach to responses so an agent
   * can fall back to the MCP Read tool for just the affected file without
   * waiting for a debounced sync to complete (issue #403).
   *
   * Returns an empty list when the watcher isn't active, or no events have
   * arrived. Each entry includes `firstSeenMs` and `lastSeenMs` (wall-clock
   * `Date.now()` values) so callers can render "edited Nms ago", plus an
   * `indexing` flag indicating whether the in-flight sync (if any) will
   * absorb that file.
   */
export function getPendingFiles(this: CodeGraphState): PendingFile[] {
  return this.watcher?.getPendingFiles() ?? [];
}

/**
   * Resolves once the file watcher has installed its watch set. Useful for
   * tests that need a deterministic boundary before asserting on
   * `getPendingFiles()`. Resolves immediately when no watcher is active.
   */
export function waitUntilWatcherReady(this: CodeGraphState, timeoutMs?: number): Promise<void> {
  return this.watcher ? this.watcher.waitUntilReady(timeoutMs) : Promise.resolve();
}

/**
   * Get files that have changed since last index
   */
export function getChangedFiles(this: CodeGraphState): { added: string[]; modified: string[]; removed: string[] } {
  return this.orchestrator.getChangedFiles();
}
