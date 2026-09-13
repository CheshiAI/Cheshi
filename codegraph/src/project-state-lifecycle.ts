import { createContextBuilder } from './context';
import { DatabaseConnection } from './db';
import { QueryBuilder } from './db/queries';
import {
  ExtractionOrchestrator
} from './extraction';
import { GraphQueryManager, GraphTraverser } from './graph';
import type { CodeGraphState } from './project-state';
import { createResolver } from './resolution';
import { deriveProjectNameTokens } from './search/query-utils';

export function assertWritable(this: CodeGraphState, operation: string): void {
  if (this.db.isReadOnly()) {
    throw new Error(`Cannot ${operation}: CodeGraph was opened in read-only mode`);
  }
}

export function acquireFileLock(this: CodeGraphState): void {
  if (!this.fileLock.isHeld()) this.fileLock.acquire();
}

/**
   * (Re)build the query/extraction/graph layers over the current `this.queries`
   * (which wraps `this.db`). Factored out of the constructor so `reopenIfReplaced`
   * can rebuild them against a fresh connection without duplicating the wiring.
   * The path-based `fileLock` is independent of the DB handle, so it stays put.
   */
export function wireLayers(this: CodeGraphState): void {
  // Down-weight the project name as a query term in search ranking — it names
  // the whole repo, not a symbol, so it has no discriminative value (#720).
  try {
    this.queries.setProjectNameTokens(deriveProjectNameTokens(this.projectRoot));
  } catch {
    // Best-effort: ranking still works without it.
  }
  this.orchestrator = new ExtractionOrchestrator(this.projectRoot, this.queries);
  this.resolver = createResolver(this.projectRoot, this.queries);
  this.graphManager = new GraphQueryManager(this.queries);
  this.traverser = new GraphTraverser(this.queries);
  this.contextBuilder = createContextBuilder(
    this.projectRoot,
    this.queries,
    this.traverser
  );
}

/**
   * Heal a stale database handle in place. If `.codegraph/` was removed and
   * recreated at the SAME path while this instance held the DB open — a git
   * worktree removed and re-added, or `rm -rf .codegraph` + `codegraph init` —
   * our open fd points at the now-unlinked inode and can never see the new
   * index, so every query returns the pre-removal snapshot until the process
   * restarts (#925). When that's detected, open the live file at the same path,
   * rebuild the query layers, and swap them IN PLACE, so every holder of this
   * instance (the MCP daemon's default project, cached projectPath connections)
   * heals without a restart. Returns true iff it reopened.
   *
   * POSIX-only in practice: `isReplacedOnDisk` never fires on Windows (an open
   * file can't be unlinked there, and st_ino is unreliable).
   */
export function reopenIfReplaced(this: CodeGraphState): boolean {
  if (!this.db.isReplacedOnDisk()) return false;
  const dbPath = this.db.getPath();
  // Open the live file FIRST — if that throws (e.g. mid-recreate), the old
  // handle stays in place and the caller retries on the next query, rather
  // than leaving this instance with no connection at all.
  const fresh = DatabaseConnection.open(dbPath, { readOnly: this.db.isReadOnly() });
  const stale = this.db;
  this.db = fresh;
  this.queries = new QueryBuilder(fresh.getDb());
  this.wireLayers();
  // Releasing the dead handle also frees the leaked db/-wal/-shm fds that were
  // pinning the unlinked inode (#925).
  try { stale.close(); } catch { /* the old inode is gone; closing just frees fds */ }
  return true;
}

/**
   * Close the CodeGraph instance and release resources
   */
export function close(this: CodeGraphState): void {
  this.owner.unwatch();
  // Release file lock if held
  this.fileLock.release();
  this.db.close();
}

/**
   * Get the project root directory
   */
export function getProjectRoot(this: CodeGraphState): string {
  return this.projectRoot;
}
