import {
  Edge,
  EdgeKind,
  Language,
  NodeKind
} from '../types';
import {
  type EdgeRow,
  rowToEdge
} from './query-rows';
import type { QueryState } from './query-state';

// ===========================================================================
// Edge Operations
// ===========================================================================

/**
 * Insert a new edge
 */
//noinspection JSUnusedGlobalSymbols
export function insertEdge(this: QueryState, edge: Edge): void {
  if (!this.stmts.insertEdge) {
    this.stmts.insertEdge = this.db.prepare(`
        INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance)
        VALUES (@source, @target, @kind, @metadata, @line, @col, @provenance)
      `);
  }

  this.stmts.insertEdge.run({
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
    line: edge.line ?? null,
    col: edge.column ?? null,
    provenance: edge.provenance ?? null,
  });
}

/**
   * Insert multiple edges in a transaction
   */
export function insertEdges(this: QueryState, edges: Edge[]): void {
  if (edges.length === 0) return;

  this.db.transaction(() => {
    const endpointIds = new Set<string>();
    for (const edge of edges) {
      endpointIds.add(edge.source);
      endpointIds.add(edge.target);
    }
    const existingNodeIds = this.getExistingNodeIds([...endpointIds]);

    const rows: unknown[][] = [];
    for (const edge of edges) {
      if (!existingNodeIds.has(edge.source) || !existingNodeIds.has(edge.target)) {
        continue;
      }
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
  })();
}

/**
   * Delete all edges from a source node
   */
//noinspection JSUnusedGlobalSymbols
export function deleteEdgesBySource(this: QueryState, sourceId: string): void {
  if (!this.stmts.deleteEdgesBySource) {
    this.stmts.deleteEdgesBySource = this.db.prepare('DELETE FROM edges WHERE source = ?');
  }
  this.stmts.deleteEdgesBySource.run(sourceId);
}

/**
   * Get outgoing edges from a node
   */
export function getOutgoingEdges(this: QueryState, sourceId: string, kinds?: EdgeKind[], provenance?: string): Edge[] {
  if ((kinds && kinds.length > 0) || provenance) {
    let sql = 'SELECT * FROM edges WHERE source = ?';
    const params: (string | number)[] = [sourceId];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (provenance) {
      sql += ' AND provenance = ?';
      params.push(provenance);
    }

    const rows = this.db.prepare(sql).all(...params) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  if (!this.stmts.getEdgesBySource) {
    this.stmts.getEdgesBySource = this.db.prepare('SELECT * FROM edges WHERE source = ?');
  }
  const rows = this.stmts.getEdgesBySource.all(sourceId) as EdgeRow[];
  return rows.map(rowToEdge);
}

/**
   * Get incoming edges to a node
   */
export function getIncomingEdges(this: QueryState, targetId: string, kinds?: EdgeKind[]): Edge[] {
  if (kinds && kinds.length > 0) {
    const sql = `SELECT * FROM edges WHERE target = ? AND kind IN (${kinds.map(() => '?').join(',')})`;
    const rows = this.db.prepare(sql).all(targetId, ...kinds) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  if (!this.stmts.getEdgesByTarget) {
    this.stmts.getEdgesByTarget = this.db.prepare('SELECT * FROM edges WHERE target = ?');
  }
  const rows = this.stmts.getEdgesByTarget.all(targetId) as EdgeRow[];
  return rows.map(rowToEdge);
}

/**
   * Find all edges where both source and target are in the given node set.
   * Useful for recovering inter-node connectivity after BFS.
   */
export function findEdgesBetweenNodes(this: QueryState, nodeIds: string[], kinds?: EdgeKind[]): Edge[] {
  if (nodeIds.length === 0) return [];

  const idsJson = JSON.stringify(nodeIds);
  let sql = `SELECT * FROM edges WHERE source IN (SELECT value FROM json_each(?)) AND target IN (SELECT value FROM json_each(?))`;
  const params: string[] = [idsJson, idsJson];

  if (kinds && kinds.length > 0) {
    sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }

  const rows = this.db.prepare(sql).all(...params) as EdgeRow[];
  return rows.map(rowToEdge);
}

/**
   * Distinct file paths that DEPEND ON `filePath`: every file containing a
   * symbol with a cross-file edge (any kind except `contains`) into a symbol
   * of this file. This is the file-level projection of the symbol dependency
   * graph and the basis for blast-radius / `affected` test selection.
   *
   * It deliberately does NOT restrict to `imports` edges. In this graph an
   * `imports` edge connects a file to its own local import declarations
   * (it is always same-file), so an imports-only lookup returns zero
   * cross-file dependents for every file. The real cross-file dependency
   * signal is the resolved call/reference graph — calls, references,
   * instantiates, extends, implements, overrides, type_of, returns,
   * decorates — exactly what {@link GraphTraverser.getImpactRadius} traverses.
   * `contains` is excluded: a parent containing a symbol does not *depend* on
   * it. One indexed query (idx_nodes_file_path + idx_edges_target_kind).
   */
export function getDependentFilePaths(this: QueryState, filePath: string): string[] {
  const sql = `SELECT DISTINCT src.file_path AS fp
      FROM edges e
      JOIN nodes tgt ON tgt.id = e.target
      JOIN nodes src ON src.id = e.source
      WHERE tgt.file_path = ?
        AND e.kind != 'contains'
        AND src.file_path != ?`;
  const rows = this.db.prepare(sql).all(filePath, filePath) as Array<{ fp: string }>;
  return rows.map((r) => r.fp);
}

/**
   * Distinct file paths that `filePath` DEPENDS ON — the inverse of
   * {@link getDependentFilePaths}: every file containing a symbol that a
   * symbol of this file has a cross-file edge into. Same edge-kind rules
   * (all kinds except `contains`); same reason imports-only is insufficient.
   */
export function getDependencyFilePaths(this: QueryState, filePath: string): string[] {
  const sql = `SELECT DISTINCT tgt.file_path AS fp
      FROM edges e
      JOIN nodes src ON src.id = e.source
      JOIN nodes tgt ON tgt.id = e.target
      WHERE src.file_path = ?
        AND e.kind != 'contains'
        AND tgt.file_path != ?`;
  const rows = this.db.prepare(sql).all(filePath, filePath) as Array<{ fp: string }>;
  return rows.map((r) => r.fp);
}

/**
   * Cross-file edges whose TARGET is a node in `filePath` and whose SOURCE is a
   * node in a *different* file, paired with the target node's (name, kind) so a
   * caller can re-resolve the edge to the re-indexed target's new ID (node IDs
   * are `sha256(filePath:kind:name:line)`, so any line shift in the callee file
   * changes target IDs and a naive re-insert by old ID silently drops them).
   * Used by `storeExtractionResult` to preserve incoming edges across a file
   * re-index (issue #899). Same edge-kind rules as
   * {@link getDependentFilePaths}: all kinds except `contains`.
   */
export function getCrossFileIncomingEdgesWithTarget(this: QueryState, filePath: string): Array<Edge & { targetName: string; targetKind: NodeKind; sourceFilePath: string; sourceLanguage: Language }> {
  const sql = `SELECT e.*, tgt.name AS target_name, tgt.kind AS target_kind,
        src.file_path AS source_file_path, src.language AS source_language
      FROM edges e
      JOIN nodes tgt ON tgt.id = e.target
      JOIN nodes src ON src.id = e.source
      WHERE tgt.file_path = ?
        AND e.kind != 'contains'
        AND src.file_path != ?`;
  const rows = this.db.prepare(sql).all(filePath, filePath) as Array<
    EdgeRow & { target_name: string; target_kind: NodeKind; source_file_path: string; source_language: Language }
  >;
  return rows.map(row => ({
    ...rowToEdge(row),
    targetName: row.target_name,
    targetKind: row.target_kind,
    sourceFilePath: row.source_file_path,
    sourceLanguage: row.source_language,
  }));
}
