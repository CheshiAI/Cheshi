import {
  FileRecord
} from '../types';
import {
  type FileRow,
  rowToFileRecord,
  SQLITE_PARAM_CHUNK_SIZE
} from './query-rows';
import type { QueryState } from './query-state';

// ===========================================================================
// File Operations
// ===========================================================================

/**
 * Insert or update a file record
 */
export function upsertFile(this: QueryState, file: FileRecord): void {
  if (!this.stmts.upsertFile) {
    this.stmts.upsertFile = this.db.prepare(`
        INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
        VALUES (@path, @contentHash, @language, @size, @modifiedAt, @indexedAt, @nodeCount, @errors)
        ON CONFLICT(path) DO UPDATE SET
          content_hash = @contentHash,
          language = @language,
          size = @size,
          modified_at = @modifiedAt,
          indexed_at = @indexedAt,
          node_count = @nodeCount,
          errors = @errors
      `);
  }

  this.stmts.upsertFile.run({
    path: file.path,
    contentHash: file.contentHash,
    language: file.language,
    size: file.size,
    modifiedAt: file.modifiedAt,
    indexedAt: file.indexedAt,
    nodeCount: file.nodeCount,
    errors: file.errors ? JSON.stringify(file.errors) : null,
  });
}

/**
   * Delete a file record and its nodes
   */
export function deleteFile(this: QueryState, filePath: string): void {
  this.db.transaction(() => {
    this.owner.deleteNodesByFile(filePath);
    if (!this.stmts.deleteFile) {
      this.stmts.deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?');
    }
    this.stmts.deleteFile.run(filePath);
  })();
}

/**
   * Get a file record by path
   */
export function getFileByPath(this: QueryState, filePath: string): FileRecord | null {
  if (!this.stmts.getFileByPath) {
    this.stmts.getFileByPath = this.db.prepare('SELECT * FROM files WHERE path = ?');
  }
  const row = this.stmts.getFileByPath.get(filePath) as FileRow | undefined;
  return row ? rowToFileRecord(row) : null;
}

/**
   * Get all tracked files
   */
export function getAllFiles(this: QueryState): FileRecord[] {
  if (!this.stmts.getAllFiles) {
    this.stmts.getAllFiles = this.db.prepare('SELECT * FROM files ORDER BY path');
  }
  const rows = this.stmts.getAllFiles.all() as FileRow[];
  return rows.map(rowToFileRecord);
}

/**
   * Most recent index timestamp (ms since epoch) across all tracked files, or
   * null when nothing is indexed yet. One indexed aggregate, no per-row scan. (#329)
   */
export function getLastIndexedAt(this: QueryState): number | null {
  const row = this.db
    .prepare('SELECT MAX(indexed_at) AS last FROM files')
    .get() as { last: number | null } | undefined;
  return row?.last ?? null;
}

/**
   * Get files that need re-indexing (hash changed)
   */
//noinspection JSUnusedGlobalSymbols
export function getStaleFiles(this: QueryState, currentHashes: Map<string, string>): FileRecord[] {
  const files = this.owner.getAllFiles();
  return files.filter((f) => {
    const currentHash = currentHashes.get(f.path);
    return currentHash && currentHash !== f.contentHash;
  });
}

/**
   * Get all tracked file paths (lightweight — no full FileRecord objects)
   */
export function getAllFilePaths(this: QueryState): string[] {
  if (!this.stmts.getAllFilePaths) {
    this.stmts.getAllFilePaths = this.db.prepare('SELECT path FROM files ORDER BY path');
  }
  const rows = this.stmts.getAllFilePaths.all() as Array<{ path: string }>;
  return rows.map((r) => r.path);
}

/**
   * Get all distinct node names (lightweight — just name strings for pre-filtering)
   */
export function getAllNodeNames(this: QueryState): string[] {
  if (!this.stmts.getAllNodeNames) {
    this.stmts.getAllNodeNames = this.db.prepare('SELECT DISTINCT name FROM nodes');
  }
  const rows = this.stmts.getAllNodeNames.all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
   * Stream the distinct node names one row at a time — the incremental
   * counterpart to {@link getAllNodeNames} for callers that need to yield
   * to the event loop mid-scan (resolver cache warm-up on multi-million-node
   * indexes). Fresh statement per call: the iterator holds an open cursor.
   */
export function* iterateNodeNames(this: QueryState): IterableIterator<string> {
  const stmt = this.db.prepare('SELECT DISTINCT name FROM nodes');
  for (const row of stmt.iterate()) {
    yield (row as { name: string }).name;
  }
}

/**
   * Distinct node names present in the given files — the symbol names a sync
   * pass uses to look up retryable failed refs after those files changed.
   */
export function getNodeNamesByFiles(this: QueryState, filePaths: string[]): string[] {
  if (filePaths.length === 0) return [];
  const names = new Set<string>();
  for (let i = 0; i < filePaths.length; i += SQLITE_PARAM_CHUNK_SIZE) {
    const chunk = filePaths.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT DISTINCT name FROM nodes WHERE file_path IN (${placeholders})`)
      .all(...chunk) as Array<{ name: string }>;
    for (const row of rows) names.add(row.name);
  }
  return [...names];
}
