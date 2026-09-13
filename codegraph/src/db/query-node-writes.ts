import { splitIdentifierSegments } from '../search/identifier-segments';
import {
  Edge,
  FileRecord,
  Node,
  UnresolvedReference
} from '../types';
import {
  type BatchInsertSpec,
  toNodeSqlParams
} from './query-rows';
import type { QueryState } from './query-state';
import { BATCH_SIZES, MAX_SEGMENTED_NAMES } from './query-state-constants';

/** Run rows through a generated multi-row INSERT, preserving row order. */
export function runBatched(this: QueryState, spec: BatchInsertSpec, rows: unknown[][]): void {
  if (rows.length === 0) return;
  const conflict = spec.conflict ? ` OR ${spec.conflict}` : '';
  const tuple = `(${spec.columns.map(() => '?').join(',')})`;
  const statementHead = `INSERT${conflict} INTO ${spec.table} (${spec.columns.join(', ')}) VALUES `;
  let i = 0;
  for (const size of BATCH_SIZES) {
    while (rows.length - i >= size) {
      const key = `${spec.key}:${size}`;
      let stmt = this.batchStmts.get(key);
      if (!stmt) {
        stmt = this.db.prepare(statementHead + new Array(size).fill(tuple).join(','));
        this.batchStmts.set(key, stmt);
      }
      if (size === 1) {
        stmt.run(...rows[i]!);
      } else {
        const params: unknown[] = [];
        for (let r = 0; r < size; r++) {
          const row = rows[i + r]!;
          for (let c = 0; c < row.length; c++) params.push(row[c]);
        }
        stmt.run(...params);
      }
      i += size;
    }
  }
}

// ===========================================================================
// Node Operations
// ===========================================================================

/**
 * Insert a new node
 */
export function insertNode(this: QueryState, node: Node): void {
  if (!this.stmts.insertNode) {
    this.stmts.insertNode = this.db.prepare(`
        INSERT OR REPLACE INTO nodes (
          id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column,
          docstring, signature, visibility,
          is_exported, is_async, is_static, is_abstract,
          decorators, type_parameters, return_type, updated_at
        ) VALUES (
          @id, @kind, @name, @qualifiedName, @filePath, @language,
          @startLine, @endLine, @startColumn, @endColumn,
          @docstring, @signature, @visibility,
          @isExported, @isAsync, @isStatic, @isAbstract,
          @decorators, @typeParameters, @returnType, @updatedAt
        )
      `);
  }

  // Validate required fields to prevent SQLite bind errors
  if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
    console.error('[CodeGraph] Skipping node with missing required fields:', {
      id: node.id,
      kind: node.kind,
      name: node.name,
      filePath: node.filePath,
      language: node.language,
    });
    return;
  }

  // INSERT OR REPLACE may overwrite a node we have cached. Drop the
  // stale entry so the next getNodeById sees the new row, not the old
  // one (matches the cache-invalidation pattern used by updateNode and
  // deleteNode below).
  this.nodeCache.delete(node.id);

  this.stmts.insertNode.run(toNodeSqlParams(node));

  // Segment vocabulary rides the same write path (and transaction) so it can
  // never drift ahead of the nodes it describes. Deletes intentionally leave
  // orphans behind — vocab rows are proposals re-verified against nodes
  // before use, and a full index clears the table at its start. File nodes
  // are excluded: a file's basename duplicates the symbols inside it
  // (state-machine.ts / OrderStateMachine), which double-counts every
  // concept and defeats the singleton-vs-cluster rarity statistics. Import
  // nodes are excluded too (#1144): they're named after module specifiers
  // ("external-unindexed-pkg", "./utils/helpers"), not symbols — an
  // import-only name can never be surfaced (getSegmentMatches requires a
  // real definition), so its rows would only inflate the rarity statistics.
  if (this.isSegmentableKind(node.kind)) this.insertNameSegments(node.name);
}

/** Which node kinds contribute their name to the segment vocabulary — the
   *  single gate shared by insertNode, updateNode, and the rebuild page query
   *  (getDistinctNodeNames), so the write paths can't drift apart. */
export function isSegmentableKind(this: QueryState, kind: string): boolean {
  return kind !== 'file' && kind !== 'import';
}

/** Write `name`'s segments into name_segment_vocab (idempotent). */
export function insertNameSegments(this: QueryState, name: string): void {
  const rows: unknown[][] = [];
  this.collectNameSegmentRows(name, rows);
  this.runBatched(
    {
      key: 'insertNameSegments',
      table: 'name_segment_vocab',
      columns: ['segment', 'name'],
      conflict: 'IGNORE',
    },
    rows,
  );
}

/**
   * Insert multiple nodes in a transaction
   */
export function insertNodes(this: QueryState, nodes: Node[]): void {
  this.db.transaction(() => {
    // Bulk path: same semantics as insertNode() per row (validation, cache
    // invalidation, segment vocab), but bound as multi-row INSERTs — the
    // per-.run() call overhead dominates the store phase on full indexes.
    const rows: unknown[][] = [];
    const segmentRows: unknown[][] = [];
    for (const node of nodes) {
      if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
        console.error('[CodeGraph] Skipping node with missing required fields:', {
          id: node.id,
          kind: node.kind,
          name: node.name,
          filePath: node.filePath,
          language: node.language,
        });
        continue;
      }
      this.nodeCache.delete(node.id);
      rows.push([
        node.id,
        node.kind,
        node.name,
        node.qualifiedName ?? node.name,
        node.filePath,
        node.language,
        node.startLine ?? 0,
        node.endLine ?? 0,
        node.startColumn ?? 0,
        node.endColumn ?? 0,
        node.docstring ?? null,
        node.signature ?? null,
        node.visibility ?? null,
        node.isExported ? 1 : 0,
        node.isAsync ? 1 : 0,
        node.isStatic ? 1 : 0,
        node.isAbstract ? 1 : 0,
        node.decorators ? JSON.stringify(node.decorators) : null,
        node.typeParameters ? JSON.stringify(node.typeParameters) : null,
        node.returnType ?? null,
        node.updatedAt ?? Date.now(),
      ]);
      if (this.isSegmentableKind(node.kind)) this.collectNameSegmentRows(node.name, segmentRows);
    }
    this.runBatched(
      {
        key: 'insertNodes',
        table: 'nodes',
        columns: [
          'id', 'kind', 'name', 'qualified_name', 'file_path', 'language',
          'start_line', 'end_line', 'start_column', 'end_column',
          'docstring', 'signature', 'visibility',
          'is_exported', 'is_async', 'is_static', 'is_abstract',
          'decorators', 'type_parameters', 'return_type', 'updated_at',
        ],
        conflict: 'REPLACE',
      },
      rows,
    );
    this.runBatched(
      {
        key: 'insertNameSegments',
        table: 'name_segment_vocab',
        columns: ['segment', 'name'],
        conflict: 'IGNORE',
      },
      segmentRows,
    );
  })();
}

/**
   * Store one file's whole extraction bundle — nodes, edges, unresolved refs,
   * and the file record — in a SINGLE transaction. The bulk-index path calls
   * this once per file instead of opening one transaction per table (#1015
   * file-order commit discipline is unchanged: callers still invoke it in file
   * order, and row order within is input order).
   *
   * Edges MUST already be endpoint-filtered by the caller (the store path
   * filters to the file's own inserted node ids), so the per-file existence
   * SELECT that insertEdges() pays is skipped here.
   */
export function storeFileBundle(this: QueryState, bundle: {
  nodes: Node[];
  edges: Edge[];
  refs: UnresolvedReference[];
  file: FileRecord;
}): void {
  this.db.transaction(() => {
    this.owner.insertNodes(bundle.nodes);
    if (bundle.edges.length > 0) {
      const rows: unknown[][] = [];
      for (const edge of bundle.edges) {
        rows.push([
          edge.source,
          edge.target,
          edge.kind,
          edge.metadata ? JSON.stringify(edge.metadata) : null,
          edge.line ?? null,
          edge.column ?? null,
          edge.provenance ?? null,
        ]);
      }
      this.runBatched(
        {
          key: 'insertEdges',
          table: 'edges',
          columns: ['source', 'target', 'kind', 'metadata', 'line', 'col', 'provenance'],
          conflict: 'IGNORE',
        },
        rows,
      );
    }
    if (bundle.refs.length > 0) this.owner.insertUnresolvedRefsBatch(bundle.refs);
    this.owner.upsertFile(bundle.file);
  })();
}

/**
   * Collect (segment, name) rows for a name, honouring the same session-dedupe
   * semantics as insertNameSegments(). Shared by the bulk write paths.
   */
export function collectNameSegmentRows(this: QueryState, name: string, out: unknown[][]): void {
  if (this.segmentedNames.has(name)) return;
  if (this.segmentedNames.size >= MAX_SEGMENTED_NAMES) this.segmentedNames.clear();
  this.segmentedNames.add(name);
  for (const segment of splitIdentifierSegments(name)) out.push([segment, name]);
}

/**
   * Update an existing node
   */
export function updateNode(this: QueryState, node: Node): void {
  if (!this.stmts.updateNode) {
    this.stmts.updateNode = this.db.prepare(`
        UPDATE nodes SET
          kind = @kind,
          name = @name,
          qualified_name = @qualifiedName,
          file_path = @filePath,
          language = @language,
          start_line = @startLine,
          end_line = @endLine,
          start_column = @startColumn,
          end_column = @endColumn,
          docstring = @docstring,
          signature = @signature,
          visibility = @visibility,
          is_exported = @isExported,
          is_async = @isAsync,
          is_static = @isStatic,
          is_abstract = @isAbstract,
          decorators = @decorators,
          type_parameters = @typeParameters,
          return_type = @returnType,
          updated_at = @updatedAt
        WHERE id = @id
      `);
  }

  // Invalidate cache before update
  this.nodeCache.delete(node.id);

  // Validate required fields
  if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
    console.error('[CodeGraph] Skipping node update with missing required fields:', node.id);
    return;
  }

  this.stmts.updateNode.run(toNodeSqlParams(node));

  // updateNode is a second real write path to `nodes` — framework
  // post-extract passes rewrite names through it (NestJS route prefixing),
  // and a renamed node's new name must reach the segment vocabulary just
  // like an inserted one's (#1141). Without this the rename left the new
  // name permanently unsearchable: the old name's rows became honest-gate
  // orphans and the only backfill is gated on the vocab being EMPTY.
  // insertNameSegments is idempotent (in-memory set + INSERT OR IGNORE),
  // so no name-changed check is needed.
  if (this.isSegmentableKind(node.kind)) this.insertNameSegments(node.name);
}

/**
   * Delete a node by ID
   */
//noinspection JSUnusedGlobalSymbols
export function deleteNode(this: QueryState, id: string): void {
  if (!this.stmts.deleteNode) {
    this.stmts.deleteNode = this.db.prepare('DELETE FROM nodes WHERE id = ?');
  }
  // Invalidate cache
  this.nodeCache.delete(id);
  this.stmts.deleteNode.run(id);
}

/**
   * Delete all nodes for a file
   */
export function deleteNodesByFile(this: QueryState, filePath: string): void {
  if (!this.stmts.deleteNodesByFile) {
    this.stmts.deleteNodesByFile = this.db.prepare('DELETE FROM nodes WHERE file_path = ?');
  }
  // Invalidate cache for nodes in this file
  for (const [id, node] of this.nodeCache) {
    if (node.filePath === filePath) {
      this.nodeCache.delete(id);
    }
  }
  this.stmts.deleteNodesByFile.run(filePath);
}
