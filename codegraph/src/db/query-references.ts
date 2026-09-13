import {
  EdgeKind,
  Language,
  UnresolvedReference
} from '../types';
import { safeJsonParse } from '../utils';
import {
  fullTableDelete,
  referenceNameTail,
  SQLITE_PARAM_CHUNK_SIZE,
  type UnresolvedRefRow
} from './query-rows';
import type { QueryState } from './query-state';

// ===========================================================================
// Unresolved References
// ===========================================================================

/**
 * Insert an unresolved reference
 */
//noinspection JSUnusedGlobalSymbols
export function insertUnresolvedRef(this: QueryState, ref: UnresolvedReference): void {
  if (!this.stmts.insertUnresolved) {
    this.stmts.insertUnresolved = this.db.prepare(`
        INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language)
        VALUES (@fromNodeId, @referenceName, @referenceKind, @line, @col, @candidates, @filePath, @language)
      `);
  }

  this.stmts.insertUnresolved.run({
    fromNodeId: ref.fromNodeId,
    referenceName: ref.referenceName,
    referenceKind: ref.referenceKind,
    line: ref.line,
    col: ref.column,
    candidates: ref.candidates ? JSON.stringify(ref.candidates) : null,
    filePath: ref.filePath ?? '',
    language: ref.language ?? 'unknown',
  });
}

/**
   * Insert multiple unresolved references in a transaction
   */
export function insertUnresolvedRefsBatch(this: QueryState, refs: UnresolvedReference[]): void {
  if (refs.length === 0) return;
  const insert = this.db.transaction(() => {
    const rows: unknown[][] = [];
    for (const ref of refs) {
      rows.push([
        ref.fromNodeId,
        ref.referenceName,
        ref.referenceKind,
        ref.line,
        ref.column,
        ref.candidates ? JSON.stringify(ref.candidates) : null,
        ref.filePath ?? '',
        ref.language ?? 'unknown',
      ]);
    }
    this.runBatched(
      {
        key: 'insertUnresolvedRefs',
        table: 'unresolved_refs',
        columns: ['from_node_id', 'reference_name', 'reference_kind', 'line', 'col', 'candidates', 'file_path', 'language'],
      },
      rows,
    );
  });
  insert();
}

/**
   * Delete unresolved references from a node
   */
//noinspection JSUnusedGlobalSymbols
export function deleteUnresolvedByNode(this: QueryState, nodeId: string): void {
  if (!this.stmts.deleteUnresolvedByNode) {
    this.stmts.deleteUnresolvedByNode = this.db.prepare(
      'DELETE FROM unresolved_refs WHERE from_node_id = ?'
    );
  }
  this.stmts.deleteUnresolvedByNode.run(nodeId);
}

/**
   * Get unresolved references by name (for resolution)
   */
//noinspection JSUnusedGlobalSymbols
export function getUnresolvedByName(this: QueryState, name: string): UnresolvedReference[] {
  if (!this.stmts.getUnresolvedByName) {
    this.stmts.getUnresolvedByName = this.db.prepare(
      'SELECT * FROM unresolved_refs WHERE reference_name = ?'
    );
  }
  const rows = this.stmts.getUnresolvedByName.all(name) as UnresolvedRefRow[];
  return rows.map((row) => ({
    fromNodeId: row.from_node_id,
    referenceName: row.reference_name,
    referenceKind: row.reference_kind as EdgeKind,
    line: row.line,
    column: row.col,
    candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
    filePath: row.file_path,
    language: row.language as Language,
    rowId: row.id,
  }));
}

/**
   * Get all unresolved references
   */
export function getUnresolvedReferences(this: QueryState): UnresolvedReference[] {
  const rows = this.db.prepare('SELECT * FROM unresolved_refs').all() as UnresolvedRefRow[];
  return rows.map((row) => ({
    fromNodeId: row.from_node_id,
    referenceName: row.reference_name,
    referenceKind: row.reference_kind as EdgeKind,
    line: row.line,
    column: row.col,
    candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
    filePath: row.file_path,
    language: row.language as Language,
    rowId: row.id,
  }));
}

/**
   * Get the count of PENDING (never-attempted) references without loading
   * them into memory. Rows marked status='failed' — attempted by a completed
   * pass, no match — are excluded: they are not outstanding work, only retry
   * candidates for the #1240 sweep, so they must not trip the #1187 orphan
   * sweep or the `status` pending-refs warning.
   */
export function getUnresolvedReferencesCount(this: QueryState): number {
  if (!this.stmts.getUnresolvedCount) {
    this.stmts.getUnresolvedCount = this.db.prepare(
      "SELECT COUNT(*) as count FROM unresolved_refs WHERE status = 'pending'"
    );
  }
  const row = this.stmts.getUnresolvedCount.get() as { count: number };
  return row.count;
}

/**
   * Get a batch of PENDING unresolved references using LIMIT/OFFSET
   * pagination. Used to process references in bounded memory chunks; failed
   * rows are excluded so the batched drain loop terminates once every row
   * has been attempted.
   */
export function getUnresolvedReferencesBatch(this: QueryState, offset: number, limit: number): UnresolvedReference[] {
  if (!this.stmts.getUnresolvedBatch) {
    // ORDER BY rowid is load-bearing for the pipelined resolution loop: it
    // prefetches batch k+1 at OFFSET batch_k.length while batch k's rows are
    // still pending, which is only exact under a stable enumeration. (A plain
    // scan and the status index both return rowid order anyway — this pins
    // it.)
    this.stmts.getUnresolvedBatch = this.db.prepare(
      "SELECT * FROM unresolved_refs WHERE status = 'pending' ORDER BY rowid LIMIT ? OFFSET ?"
    );
  }
  const rows = this.stmts.getUnresolvedBatch.all(limit, offset) as UnresolvedRefRow[];
  return rows.map((row) => ({
    fromNodeId: row.from_node_id,
    referenceName: row.reference_name,
    referenceKind: row.reference_kind as EdgeKind,
    line: row.line,
    column: row.col,
    candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
    filePath: row.file_path,
    language: row.language as Language,
    rowId: row.id,
  }));
}

/**
   * Keyset variant of {@link getUnresolvedReferencesBatch} for the batched
   * resolution loop: seek past the last-seen row id instead of OFFSET-walking.
   * OFFSET reads re-scan the accumulated failed-row prefix on every batch —
   * O(failed rows) per read, measured at 54.6s of the kernel-scale batch loop
   * (§7a.2) — while the seek is O(batch) forever. `id` is the rowid alias, so
   * the enumeration order is identical to the OFFSET reader's.
   */
export function getUnresolvedReferencesBatchAfter(this: QueryState, afterRowId: number, limit: number): UnresolvedReference[] {
  if (!this.stmts.getUnresolvedBatchAfter) {
    this.stmts.getUnresolvedBatchAfter = this.db.prepare(
      "SELECT * FROM unresolved_refs WHERE status = 'pending' AND id > ? ORDER BY id LIMIT ?"
    );
  }
  const rows = this.stmts.getUnresolvedBatchAfter.all(afterRowId, limit) as UnresolvedRefRow[];
  return rows.map((row) => ({
    fromNodeId: row.from_node_id,
    referenceName: row.reference_name,
    referenceKind: row.reference_kind as EdgeKind,
    line: row.line,
    column: row.col,
    candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
    filePath: row.file_path,
    language: row.language as Language,
    rowId: row.id,
  }));
}

/**
   * Get unresolved references scoped to specific file paths.
   * Uses the idx_unresolved_file_path index for efficient lookup.
   */
export function getUnresolvedReferencesByFiles(this: QueryState, filePaths: string[]): UnresolvedReference[] {
  if (filePaths.length === 0) return [];

  // Chunk under SQLite's parameter limit: the first sync of a very large repo
  // passes every changed file here, which an unbounded `IN (...)` would bind
  // as one parameter each — exceeding MAX_VARIABLE_NUMBER and aborting with
  // "too many SQL variables". (#540)
  const rows: UnresolvedRefRow[] = [];
  for (let i = 0; i < filePaths.length; i += SQLITE_PARAM_CHUNK_SIZE) {
    const chunk = filePaths.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const chunkRows = this.db
      .prepare(`SELECT * FROM unresolved_refs WHERE status = 'pending' AND file_path IN (${placeholders})`)
      .all(...chunk) as UnresolvedRefRow[];
    rows.push(...chunkRows);
  }

  return rows.map((row) => ({
    fromNodeId: row.from_node_id,
    referenceName: row.reference_name,
    referenceKind: row.reference_kind as EdgeKind,
    line: row.line,
    column: row.col,
    candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
    filePath: row.file_path,
    language: row.language as Language,
    rowId: row.id,
  }));
}

/**
   * Delete all unresolved references (after resolution)
   */
//noinspection JSUnusedGlobalSymbols
export function clearUnresolvedReferences(this: QueryState): void {
  this.db.exec(fullTableDelete('unresolved_refs'));
}

/**
   * Delete resolved references by their IDs
   */
export function deleteResolvedReferences(this: QueryState, fromNodeIds: string[]): void {
  if (fromNodeIds.length === 0) return;
  // Chunk under SQLite's parameter limit, matching every other IN-list in
  // this file. The internal resolution path uses deleteSpecificResolvedReferences
  // instead, but QueryBuilder is part of the public API, so a library consumer
  // passing more ids than SQLITE_MAX_VARIABLE_NUMBER (32766 on the bundled
  // bun:sqlite) would otherwise hit "too many SQL variables". (#540, #1001)
  for (let i = 0; i < fromNodeIds.length; i += SQLITE_PARAM_CHUNK_SIZE) {
    const chunk = fromNodeIds.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM unresolved_refs WHERE from_node_id IN (${placeholders})`).run(...chunk);
  }
}

/**
   * Delete specific resolved references by (fromNodeId, referenceName, referenceKind) tuples.
   * More precise than deleteResolvedReferences — only removes refs that were actually resolved.
   */
export function deleteSpecificResolvedReferences(this: QueryState, refs: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>): number {
  if (refs.length === 0) return 0;
  const stmt = this.db.prepare(
    'DELETE FROM unresolved_refs WHERE from_node_id = ? AND reference_name = ? AND reference_kind = ?'
  );
  // Returns rows actually removed (SQLite `changes`, summed): the batched
  // resolution loop's non-progress guard keys on this — zero removals from
  // a batch that claimed work is the direct runaway signal (§7a.2).
  let changed = 0;
  const deleteMany = this.db.transaction((items: typeof refs) => {
    for (const ref of items) {
      changed += stmt.run(ref.fromNodeId, ref.referenceName, ref.referenceKind).changes;
    }
  });
  deleteMany(refs);
  return changed;
}

/**
   * Delete unresolved-ref rows by row id — the precise cleanup for refs a
   * resolution pass actually processed. The key-tuple variant above also
   * deletes SIBLING rows (same caller calling the same callee at other lines)
   * that a later batch hasn't attempted yet, so when a batch boundary split a
   * caller's same-named call sites, the later sites' edges were silently never
   * created (#1269).
   */
export function deleteReferencesByRowIds(this: QueryState, rowIds: number[]): number {
  if (rowIds.length === 0) return 0;
  // One transaction for all chunks (each chunk was previously its own
  // implicit transaction = its own WAL commit — measurable on 100k+-ref
  // resolution persists), and the full-size chunk statement is cached so
  // repeat calls skip the re-prepare; only the final partial chunk (if any)
  // prepares ad hoc. Returns rows actually removed (summed `changes`) for
  // the batched loop's non-progress guard (§7a.2).
  let changed = 0;
  this.db.transaction(() => {
    for (let i = 0; i < rowIds.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = rowIds.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      if (chunk.length === SQLITE_PARAM_CHUNK_SIZE) {
        if (!this.stmts.deleteRefsByRowIdsFull) {
          const placeholders = new Array(SQLITE_PARAM_CHUNK_SIZE).fill('?').join(',');
          this.stmts.deleteRefsByRowIdsFull = this.db.prepare(
            `DELETE FROM unresolved_refs WHERE id IN (${placeholders})`
          );
        }
        changed += this.stmts.deleteRefsByRowIdsFull.run(...chunk).changes;
      } else {
        const placeholders = chunk.map(() => '?').join(',');
        changed += this.db.prepare(`DELETE FROM unresolved_refs WHERE id IN (${placeholders})`).run(...chunk).changes;
      }
    }
  })();
  return changed;
}

/**
   * Mark refs a completed resolution pass could not resolve as status='failed'
   * instead of deleting them (#1240). Failed rows are invisible to the pending
   * count/batch readers (so drain loops and the #1187 orphan sweep still
   * terminate) but stay queryable by name_tail so a later sync can retry them
   * when a changed file introduces a symbol that could satisfy them. name_tail
   * is (re)written here so rows inserted before the v8 migration get their
   * tail the first time they're attempted.
   */
export function markReferencesFailed(this: QueryState, refs: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>): number {
  if (refs.length === 0) return 0;
  const stmt = this.db.prepare(
    "UPDATE unresolved_refs SET status = 'failed', name_tail = ? WHERE from_node_id = ? AND reference_name = ? AND reference_kind = ?"
  );
  let changed = 0;
  const markMany = this.db.transaction((items: typeof refs) => {
    for (const ref of items) {
      changed += stmt.run(referenceNameTail(ref.referenceName), ref.fromNodeId, ref.referenceName, ref.referenceKind).changes;
    }
  });
  markMany(refs);
  return changed;
}

/**
   * Park refs as status='failed' by row id — the precise counterpart of
   * markReferencesFailed, for the same reason as deleteReferencesByRowIds:
   * the key-tuple variant also flips same-key sibling rows in later batches
   * to 'failed' before they were ever attempted (#1269). Resolution outcome
   * can differ per call site (receiver-type inference reads the ref's line),
   * so a sibling must not inherit this row's failure.
   */
export function markReferencesFailedByRowIds(this: QueryState, refs: Array<{ rowId: number; referenceName: string }>): number {
  if (refs.length === 0) return 0;
  const stmt = this.db.prepare(
    "UPDATE unresolved_refs SET status = 'failed', name_tail = ? WHERE id = ?"
  );
  let changed = 0;
  const markMany = this.db.transaction((items: typeof refs) => {
    for (const ref of items) {
      changed += stmt.run(referenceNameTail(ref.referenceName), ref.rowId).changes;
    }
  });
  markMany(refs);
  return changed;
}

/**
   * Failed refs whose name tail matches one of the given symbol names — the
   * candidates a sync should retry after files carrying those names changed
   * (#1240). Names matching more than `perNameCeiling` failed refs are
   * skipped entirely: at that population a name is external/builtin noise
   * (`get`, `map`, …) that one new definition won't resolve — the same
   * rationale as resolution's AMBIGUOUS_NAME_CEILING (#999) — and retrying an
   * arbitrary subset would be both wasted work and incoherent coverage.
   */
export function getRetryableFailedReferences(this: QueryState, names: string[], perNameCeiling: number = 500): UnresolvedReference[] {
  if (names.length === 0) return [];

  // Pass 1: per-tail counts, chunked under the SQLite parameter limit.
  const retryNames: string[] = [];
  for (let i = 0; i < names.length; i += SQLITE_PARAM_CHUNK_SIZE) {
    const chunk = names.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const counts = this.db
      .prepare(
        `SELECT name_tail, COUNT(*) as count FROM unresolved_refs WHERE status = 'failed' AND name_tail IN (${placeholders}) GROUP BY name_tail`
      )
      .all(...chunk) as Array<{ name_tail: string; count: number }>;
    for (const row of counts) {
      if (row.count <= perNameCeiling) retryNames.push(row.name_tail);
    }
  }
  if (retryNames.length === 0) return [];

  // Pass 2: load the surviving rows.
  const rows: UnresolvedRefRow[] = [];
  for (let i = 0; i < retryNames.length; i += SQLITE_PARAM_CHUNK_SIZE) {
    const chunk = retryNames.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const chunkRows = this.db
      .prepare(`SELECT * FROM unresolved_refs WHERE status = 'failed' AND name_tail IN (${placeholders})`)
      .all(...chunk) as UnresolvedRefRow[];
    rows.push(...chunkRows);
  }

  return rows.map((row) => ({
    fromNodeId: row.from_node_id,
    referenceName: row.reference_name,
    referenceKind: row.reference_kind as EdgeKind,
    line: row.line,
    column: row.col,
    candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
    filePath: row.file_path,
    language: row.language as Language,
    rowId: row.id,
  }));
}
