import {
  EdgeKind,
  GraphStats,
  Language,
  Node,
  NodeKind
} from '../types';
import {
  fullTableDelete
} from './query-rows';
import type { QueryState } from './query-state';
import type { SqliteDatabase } from './sqlite-adapter';

/**
   * Swap the underlying connection in place. Used by pool workers'
   * connection recycling (plan §7a.6, writes-under-readers): a long-lived
   * read connection pins WAL checkpoint progress, and the deep WAL that
   * accumulates behind it taxes every main-thread B-tree page operation
   * (deletes measured 42.6s → 118.8s from 0 to 4 attached readers on
   * identical hardware). Workers therefore close and reopen their read-only
   * connection at the pool-idle boundary; everything above the connection —
   * this QueryBuilder, the resolver and its warm caches — survives, and only
   * connection-derived state (prepared statements) resets, re-preparing
   * lazily on next use.
   */
export function rebind(this: QueryState, db: SqliteDatabase): void {
  this.db = db;
  this.stmts = {};
  this.batchStmts.clear();
}

/** Set the normalized project-name tokens used to down-weight non-discriminative
   * query words in path scoring (#720). Called once when the project opens. */
export function setProjectNameTokens(this: QueryState, tokens: Set<string>): void {
  this.projectNameTokens = tokens;
}

/** The normalized project-name tokens (#720); empty if none were derived. */
export function getProjectNameTokens(this: QueryState): Set<string> {
  return this.projectNameTokens;
}

/**
   * Add a node to the cache, evicting oldest if needed
   */
export function cacheNode(this: QueryState, node: Node): void {
  if (this.nodeCache.size >= this.maxCacheSize) {
    // Evict oldest (first) entry
    const firstKey = this.nodeCache.keys().next().value;
    if (firstKey) {
      this.nodeCache.delete(firstKey);
    }
  }
  this.nodeCache.set(node.id, node);
}

/**
   * Clear the node cache
   */
//noinspection JSUnusedGlobalSymbols
export function clearCache(this: QueryState): void {
  this.nodeCache.clear();
}

// ===========================================================================
// Statistics
// ===========================================================================

/**
 * Lightweight (nodes, edges) count snapshot. Used around an index/sync
 * run to compute true additions across extraction + resolution +
 * synthesis — the per-phase counter in the orchestrator only sees
 * extraction's contribution, which is why the CLI summary under-reported
 * the edge count (resolution + synthesizer edges were invisible).
 */
export function getNodeAndEdgeCount(this: QueryState): { nodes: number; edges: number } {
  return this.db
    .prepare('SELECT (SELECT COUNT(*) FROM nodes) AS nodes, (SELECT COUNT(*) FROM edges) AS edges')
    .get() as { nodes: number; edges: number };
}

/**
   * Get graph statistics
   */
export function getStats(this: QueryState): GraphStats {
  // Single query for all three aggregate counts
  const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS node_count,
        (SELECT COUNT(*) FROM edges) AS edge_count,
        (SELECT COUNT(*) FROM files) AS file_count
    `).get() as { node_count: number; edge_count: number; file_count: number };

  const nodesByKind = {} as Record<NodeKind, number>;
  const nodeKindRows = this.db
    .prepare('SELECT kind, COUNT(*) as count FROM nodes GROUP BY kind')
    .all() as Array<{ kind: string; count: number }>;
  for (const row of nodeKindRows) {
    nodesByKind[row.kind as NodeKind] = row.count;
  }

  const edgesByKind = {} as Record<EdgeKind, number>;
  const edgeKindRows = this.db
    .prepare('SELECT kind, COUNT(*) as count FROM edges GROUP BY kind')
    .all() as Array<{ kind: string; count: number }>;
  for (const row of edgeKindRows) {
    edgesByKind[row.kind as EdgeKind] = row.count;
  }

  const filesByLanguage = {} as Record<Language, number>;
  const languageRows = this.db
    .prepare('SELECT language, COUNT(*) as count FROM files GROUP BY language')
    .all() as Array<{ language: string; count: number }>;
  for (const row of languageRows) {
    filesByLanguage[row.language as Language] = row.count;
  }

  return {
    nodeCount: counts.node_count,
    edgeCount: counts.edge_count,
    fileCount: counts.file_count,
    nodesByKind,
    edgesByKind,
    filesByLanguage,
    dbSizeBytes: 0, // Set by caller using DatabaseConnection.getSize()
    walSizeBytes: 0, // Set by caller using DatabaseConnection.getWalSizeBytes()
    lastUpdated: Date.now(),
  };
}

// ===========================================================================
// Project Metadata
// ===========================================================================

/**
 * Get a metadata value by key
 */
export function getMetadata(this: QueryState, key: string): string | null {
  const row = this.db.prepare('SELECT value FROM project_metadata WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
   * Set a metadata key-value pair (upsert)
   */
export function setMetadata(this: QueryState, key: string, value: string): void {
  this.db.prepare(
    'INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(key, value, Date.now());
}

/**
   * Get all metadata as a key-value record
   */
//noinspection JSUnusedGlobalSymbols
export function getAllMetadata(this: QueryState): Record<string, string> {
  const rows = this.db.prepare('SELECT key, value FROM project_metadata').all() as { key: string; value: string }[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

/**
   * Clear all data from the database
   */
export function clear(this: QueryState): void {
  this.nodeCache.clear();
  this.db.transaction(() => {
    this.db.exec(fullTableDelete('unresolved_refs'));
    this.db.exec(fullTableDelete('edges'));
    this.db.exec(fullTableDelete('nodes'));
    this.db.exec(fullTableDelete('files'));
  })();
}
