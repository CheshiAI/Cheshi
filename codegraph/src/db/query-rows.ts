import { isGeneratedFile } from '../extraction/generated-detection';
import { Edge, EdgeKind, FileRecord, Language, Node, NodeKind } from '../types';
import { safeJsonParse } from '../utils';

/**
 * Path-only heuristic for files that should not be candidates for
 * "dominant file" detection: test/spec files and tool-generated files.
 * Generated files (`*.pb.go`, `*.pulsar.go`, mock outputs, …) often
 * have huge in-file edge counts that dwarf the real source — etcd's
 * `rpc.pb.go` has 4× the in-file edges of `server.go`.
 */
export function isLowValueFile(filePath: string): boolean {
  const lp = filePath.toLowerCase();
  return (
    /(?:^|\/)(tests?|__tests?__|spec)\//.test(lp) ||
    /_test\.go$/.test(lp) ||
    /(?:^|\/)test_[^/]+\.py$/.test(lp) ||
    /_test\.py$/.test(lp) ||
    /_spec\.rb$/.test(lp) ||
    /_test\.rb$/.test(lp) ||
    /\.(test|spec)\.[jt]sx?$/.test(lp) ||
    /(test|spec|tests)\.(java|kt|scala)$/.test(lp) ||
    /(tests?|spec)\.cs$/.test(lp) ||
    /tests?\.swift$/.test(lp) ||
    /_test\.dart$/.test(lp) ||
    isGeneratedFile(filePath)
  );
}

export const SQLITE_PARAM_CHUNK_SIZE = 500;

type NodeSqlParams = Record<string, string | number | null>;

export function toNodeSqlParams(node: Node): NodeSqlParams {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName ?? node.name,
    filePath: node.filePath,
    language: node.language,
    startLine: node.startLine ?? 0,
    endLine: node.endLine ?? 0,
    startColumn: node.startColumn ?? 0,
    endColumn: node.endColumn ?? 0,
    docstring: node.docstring ?? null,
    signature: node.signature ?? null,
    visibility: node.visibility ?? null,
    isExported: node.isExported ? 1 : 0,
    isAsync: node.isAsync ? 1 : 0,
    isStatic: node.isStatic ? 1 : 0,
    isAbstract: node.isAbstract ? 1 : 0,
    decorators: node.decorators ? JSON.stringify(node.decorators) : null,
    typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
    returnType: node.returnType ?? null,
    updatedAt: node.updatedAt ?? Date.now(),
  };
}

export function appendNodeFilters(
  sql: string,
  params: Array<string | number>,
  kinds?: NodeKind[],
  languages?: Language[],
  columnPrefix = '',
): string {
  if (kinds && kinds.length > 0) {
    sql += ` AND ${columnPrefix}kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }
  if (languages && languages.length > 0) {
    sql += ` AND ${columnPrefix}language IN (${languages.map(() => '?').join(',')})`;
    params.push(...languages);
  }
  return sql;
}

/**
 * Database row types (snake_case from SQLite)
 */
export interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  docstring: string | null;
  signature: string | null;
  visibility: string | null;
  is_exported: number;
  is_async: number;
  is_static: number;
  is_abstract: number;
  decorators: string | null;
  type_parameters: string | null;
  return_type: string | null;
  updated_at: number;
}

export interface BatchInsertSpec {
  key: string;
  table: 'nodes' | 'name_segment_vocab' | 'edges' | 'unresolved_refs';
  columns: readonly string[];
  conflict?: 'IGNORE' | 'REPLACE';
}

type ClearableTable = 'name_segment_vocab' | 'unresolved_refs' | 'edges' | 'nodes' | 'files';

export function fullTableDelete(table: ClearableTable): string {
  return ['DELETE FROM', table].join(' ');
}

export interface EdgeRow {
  id: number;
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
  line: number | null;
  col: number | null;
  provenance: string | null;
}

export interface FileRow {
  path: string;
  content_hash: string;
  language: string;
  size: number;
  modified_at: number;
  indexed_at: number;
  node_count: number;
  errors: string | null;
}

export interface UnresolvedRefRow {
  id: number;
  from_node_id: string;
  reference_name: string;
  reference_kind: string;
  line: number;
  col: number;
  candidates: string | null;
  file_path: string;
  language: string;
  status: string;
  name_tail: string;
}

/**
 * Last segment of a (possibly dotted/qualified) reference name — the part a
 * new symbol's plain node name could match: 'util.greet' → 'greet',
 * 'mod::fn' → 'fn', 'greet' → 'greet'. Written to unresolved_refs.name_tail
 * when a ref is marked failed, so the #1240 retry lookup can match dotted
 * refs against newly-added node names.
 */
export function referenceNameTail(referenceName: string): string {
  const idx = Math.max(referenceName.lastIndexOf('.'), referenceName.lastIndexOf(':'));
  return idx >= 0 ? referenceName.slice(idx + 1) : referenceName;
}

/**
 * Convert database row to Node object
 */
export function rowToNode(row: NodeRow): Node {
  return {
    id: row.id,
    kind: row.kind as NodeKind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    language: row.language as Language,
    startLine: row.start_line,
    endLine: row.end_line,
    startColumn: row.start_column,
    endColumn: row.end_column,
    docstring: row.docstring ?? undefined,
    signature: row.signature ?? undefined,
    visibility: row.visibility as Node['visibility'],
    isExported: row.is_exported === 1,
    isAsync: row.is_async === 1,
    isStatic: row.is_static === 1,
    isAbstract: row.is_abstract === 1,
    decorators: row.decorators ? safeJsonParse(row.decorators, undefined) : undefined,
    typeParameters: row.type_parameters ? safeJsonParse(row.type_parameters, undefined) : undefined,
    returnType: row.return_type ?? undefined,
    updatedAt: row.updated_at,
  };
}

/**
 * Convert database row to Edge object
 */
export function rowToEdge(row: EdgeRow): Edge {
  return {
    source: row.source,
    target: row.target,
    kind: row.kind as EdgeKind,
    metadata: row.metadata ? safeJsonParse(row.metadata, undefined) : undefined,
    line: row.line ?? undefined,
    column: row.col ?? undefined,
    provenance: row.provenance as Edge['provenance'],
  };
}

/**
 * Convert database row to FileRecord object
 */
export function rowToFileRecord(row: FileRow): FileRecord {
  return {
    path: row.path,
    contentHash: row.content_hash,
    language: row.language as Language,
    size: row.size,
    modifiedAt: row.modified_at,
    indexedAt: row.indexed_at,
    nodeCount: row.node_count,
    errors: row.errors ? safeJsonParse(row.errors, undefined) : undefined,
  };
}
