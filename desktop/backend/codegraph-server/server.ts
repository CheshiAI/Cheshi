import { existsSync } from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';

import CodeGraph, {
  EDGE_KINDS,
  type Edge,
  type EdgeKind,
  type GraphStats,
  type Node,
} from '@cheshi/codegraph';
import {
  getWorkspaceFileVersion,
  listWorkspaceDirectory,
  readWorkspaceFile,
  WorkspaceRequestError,
  writeWorkspaceFile,
  type WorkspaceFileWriteRequest,
} from './workspace';
import { getWorkspaceDiff, type WorkspaceDiffMode } from './workspace-diff';

export type ViewerGroupBy = 'directory' | 'language' | 'kind';

export interface CodeGraphServerOptions {
  hostname?: string;
  port?: number;
  staticRoot?: string;
  /** Disable static assets when a development server provides the UI. */
  serveStatic?: boolean;
  /** Additional indexed projects exposed by the project selector. */
  projects?: string[];
}

export interface ViewerProject {
  id: string;
  name: string;
  projectRoot: string;
}

interface ViewerProjectEntry extends ViewerProject {
  graph: CodeGraph;
}

export interface ViewerNode {
  id: string;
  kind: Node['kind'];
  name: string;
  qualifiedName: string;
  filePath: string;
  language: Node['language'];
  startLine: number;
  endLine: number;
  group: string;
}

export interface ViewerEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  line?: number;
}

export interface ViewerGraphSlice {
  rootId: string;
  depth: number;
  truncated: boolean;
  nodes: ViewerNode[];
  edges: ViewerEdge[];
}

export interface ViewerSearchResult {
  id: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  kind: Node['kind'];
  language: Node['language'];
  startLine: number;
  score: number;
}

function assertWorkspaceRequest(condition: boolean, message: string, status: number): asserts condition {
  if (!condition) throw new WorkspaceRequestError(message, status);
}

export interface ViewerRelation {
  id: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  kind: Node['kind'];
  edge: EdgeKind;
}

export interface ViewerNodeDetails {
  node: ViewerNode;
  code: string | null;
  callers: ViewerRelation[];
  callees: ViewerRelation[];
}

export interface ViewerMeta {
  projectId: string;
  projectRoot: string;
  stats: GraphStats;
  lastIndexed: number | null;
  directories: string[];
  languages: string[];
  nodeKinds: string[];
  edgeKinds: EdgeKind[];
}

export interface CodeGraphServerHandle {
  url: string;
  close(): void;
}

const DEFAULT_DEPTH = 1;
const DEFAULT_LIMIT = 36;
const MAX_DEPTH = 4;
const MAX_LIMIT = 120;
const MAX_SEARCH_RESULTS = 40;
const MAX_RELATIONS = 40;

function clampInteger(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value === null || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeGroupBy(value: string | null): ViewerGroupBy {
  if (value === 'language' || value === 'kind') return value;
  return 'directory';
}

function normalizeEdgeKinds(value: string | null): Set<EdgeKind> | undefined {
  if (!value) return undefined;
  const allowed = new Set<EdgeKind>(EDGE_KINDS);
  const kinds = value
    .split(',')
    .map((kind) => kind.trim())
    .filter((kind): kind is EdgeKind => allowed.has(kind as EdgeKind));
  return kinds.length > 0 ? new Set(kinds) : undefined;
}

function groupForNode(node: Node, groupBy: ViewerGroupBy): string {
  if (groupBy === 'language') return node.language;
  if (groupBy === 'kind') return node.kind;

  const parts = node.filePath.split('/').filter(Boolean);
  if (parts.length <= 1) return '(root)';
  return parts.slice(0, -1).join('/');
}

function projectId(projectRoot: string): string {
  return createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
}

function projectName(projectRoot: string): string {
  return path.basename(projectRoot) || projectRoot;
}

function toViewerNode(node: Node, groupBy: ViewerGroupBy): ViewerNode {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    language: node.language,
    startLine: node.startLine,
    endLine: node.endLine,
    group: groupForNode(node, groupBy),
  };
}

function toRelation(node: Node, edge: Edge): ViewerRelation {
  return {
    id: node.id,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    kind: node.kind,
    edge: edge.kind,
  };
}

function edgeKey(edge: Edge): string {
  return `${edge.source}\u0000${edge.target}\u0000${edge.kind}\u0000${edge.line ?? ''}`;
}

/**
 * Build a bounded, bidirectional graph slice around a selected node. The
 * viewer deliberately works from the public CodeGraph facade so opening it in
 * read-only mode never needs to know about SQLite internals.
 */
export function buildGraphSlice(
  cg: CodeGraph,
  rootId: string,
  options: {
    depth?: number;
    limit?: number;
    groupBy?: ViewerGroupBy;
    edgeKinds?: Set<EdgeKind>;
  } = {},
): ViewerGraphSlice {
  const root = cg.getNode(rootId);
  if (!root) throw new Error(`Node not found: ${rootId}`);

  const depth = Math.min(MAX_DEPTH, Math.max(0, options.depth ?? DEFAULT_DEPTH));
  const limit = Math.min(MAX_LIMIT, Math.max(2, options.limit ?? DEFAULT_LIMIT));
  const groupBy = options.groupBy ?? 'directory';
  const nodes = new Map<string, ViewerNode>();
  const edges = new Map<string, ViewerEdge>();
  const queue: Array<{ id: string; depth: number }> = [{ id: root.id, depth: 0 }];
  const visited = new Set<string>();
  let truncated = false;

  nodes.set(root.id, toViewerNode(root, groupBy));

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.id)) continue;
    visited.add(current.id);
    if (current.depth >= depth) continue;

    const adjacent = [...cg.getOutgoingEdges(current.id), ...cg.getIncomingEdges(current.id)];
    for (const edge of adjacent) {
      if (options.edgeKinds && !options.edgeKinds.has(edge.kind)) continue;

      const otherId = edge.source === current.id ? edge.target : edge.source;
      const alreadyIncluded = nodes.has(otherId);
      if (!alreadyIncluded && nodes.size >= limit) {
        truncated = true;
        continue;
      }

      const other = alreadyIncluded ? null : cg.getNode(otherId);
      if (!alreadyIncluded && !other) continue;

      if (!alreadyIncluded && other) {
        if (nodes.size >= limit) {
          truncated = true;
          continue;
        }
        nodes.set(other.id, toViewerNode(other, groupBy));
      }

      if (nodes.has(edge.source) && nodes.has(edge.target)) {
        edges.set(edgeKey(edge), {
          source: edge.source,
          target: edge.target,
          kind: edge.kind,
          ...(edge.line === undefined ? {} : { line: edge.line }),
        });
      }

      if (!visited.has(otherId)) {
        queue.push({ id: otherId, depth: current.depth + 1 });
      }
    }
  }

  return {
    rootId: root.id,
    depth,
    truncated,
    nodes: [...nodes.values()].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name)),
    edges: [...edges.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.source.localeCompare(b.source)),
  };
}

function createMeta(cg: CodeGraph, id: string): ViewerMeta {
  const stats = cg.getStats();
  const directories = new Set<string>();
  for (const file of cg.getFiles()) {
    const parts = file.path.split('/').filter(Boolean);
    directories.add(parts.length <= 1 ? '(root)' : parts.slice(0, -1).join('/'));
  }

  return {
    projectId: id,
    projectRoot: cg.getProjectRoot(),
    stats,
    lastIndexed: cg.getLastIndexedAt(),
    directories: [...directories].sort(),
    languages: Object.entries(stats.filesByLanguage)
      .filter(([, count]) => count > 0)
      .map(([language]) => language)
      .sort(),
    nodeKinds: Object.entries(stats.nodesByKind)
      .filter(([, count]) => count > 0)
      .map(([kind]) => kind)
      .sort(),
    edgeKinds: EDGE_KINDS.filter((kind) => stats.edgesByKind[kind] > 0),
  };
}

function toSearchResult(result: { node: Node; score: number }): ViewerSearchResult {
  return {
    id: result.node.id,
    name: result.node.name,
    qualifiedName: result.node.qualifiedName,
    filePath: result.node.filePath,
    kind: result.node.kind,
    language: result.node.language,
    startLine: result.node.startLine,
    score: result.score,
  };
}

async function createNodeDetails(cg: CodeGraph, nodeId: string): Promise<ViewerNodeDetails> {
  const node = cg.getNode(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);

  const callers = cg
    .getCallers(nodeId, 1)
    .slice(0, MAX_RELATIONS)
    .map(({ node: related, edge }) => toRelation(related, edge));
  const callees = cg
    .getCallees(nodeId, 1)
    .slice(0, MAX_RELATIONS)
    .map(({ node: related, edge }) => toRelation(related, edge));

  return {
    node: toViewerNode(node, 'directory'),
    code: await cg.getCode(nodeId),
    callers,
    callees,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function errorResponse(error: unknown, status = 500): Response {
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ error: message }, status);
}

function workspaceErrorResponse(error: unknown, fallbackStatus = 500): Response {
  return errorResponse(error, error instanceof WorkspaceRequestError ? error.status : fallbackStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function parseWorkspaceWriteRequest(request: Request): Promise<WorkspaceFileWriteRequest> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new WorkspaceRequestError('The file write body must be valid JSON.', 400);
  }
  if (!isRecord(body) || typeof body.path !== 'string' || typeof body.content !== 'string' || typeof body.expectedRevision !== 'string') {
    throw new WorkspaceRequestError('path, content, and expectedRevision are required.', 400);
  }
  if (body.hasBom !== undefined && typeof body.hasBom !== 'boolean') {
    throw new WorkspaceRequestError('hasBom must be a boolean.', 400);
  }
  if (body.lineEnding !== undefined && body.lineEnding !== 'lf' && body.lineEnding !== 'crlf' && body.lineEnding !== 'cr') {
    throw new WorkspaceRequestError('lineEnding must be lf, crlf, or cr.', 400);
  }
  return {
    path: body.path,
    content: body.content,
    expectedRevision: body.expectedRevision,
    ...(body.hasBom === undefined ? {} : { hasBom: body.hasBom }),
    ...(body.lineEnding === undefined ? {} : { lineEnding: body.lineEnding }),
  };
}

function resolveStaticFile(staticRoot: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relative = decoded.replace(/^\/+/, '') || 'index.html';
  const root = path.resolve(staticRoot);
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  if (existsSync(candidate)) return candidate;

  // The viewer is an SPA. Let direct navigation to a client-side route fall
  // back to the entry point, while missing assets remain a real 404.
  if (!path.extname(relative)) {
    const indexFile = path.join(root, 'index.html');
    if (existsSync(indexFile)) return indexFile;
  }
  return null;
}

export async function handleCodeGraphRequest(
  request: Request,
  cg: CodeGraph,
  staticRoot?: string,
  projectEntries?: ReadonlyMap<string, ViewerProjectEntry>,
  defaultProjectId?: string,
): Promise<Response> {
  const url = new URL(request.url);
  const isFileWrite = request.method === 'PUT' && url.pathname === '/api/workspace/file';
  if (request.method !== 'GET' && !isFileWrite) return errorResponse('Method not allowed', 405);

  const fallbackId = defaultProjectId ?? projectId(cg.getProjectRoot());
  const fallback: ViewerProjectEntry = {
    id: fallbackId,
    name: projectName(cg.getProjectRoot()),
    projectRoot: cg.getProjectRoot(),
    graph: cg,
  };
  const entries = projectEntries && projectEntries.size > 0
    ? projectEntries
    : new Map([[fallback.id, fallback]]);

  if (url.pathname === '/api/projects') {
    return jsonResponse([...entries.values()].map(({ graph: _graph, ...project }) => project));
  }

  const requestedProject = url.searchParams.get('project')?.trim();
  const selected = requestedProject
    ? entries.get(requestedProject)
    : entries.get(fallbackId) ?? fallback;
  if (!selected) return errorResponse(`Unknown project: ${requestedProject}`, 404);
  const selectedGraph = selected.graph;

  if (url.pathname === '/api/meta') {
    try {
      return jsonResponse(createMeta(selectedGraph, selected.id));
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (url.pathname === '/api/search') {
    const query = url.searchParams.get('q')?.trim() ?? '';
    if (!query) return jsonResponse([]);
    try {
      const limit = clampInteger(url.searchParams.get('limit'), 20, 1, MAX_SEARCH_RESULTS);
      return jsonResponse(selectedGraph.searchNodes(query, { limit }).map(toSearchResult));
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (url.pathname === '/api/graph') {
    const rootId = url.searchParams.get('root')?.trim();
    if (!rootId) return errorResponse('The root query parameter is required', 400);
    try {
      return jsonResponse(buildGraphSlice(selectedGraph, rootId, {
        depth: clampInteger(url.searchParams.get('depth'), DEFAULT_DEPTH, 0, MAX_DEPTH),
        limit: clampInteger(url.searchParams.get('limit'), DEFAULT_LIMIT, 2, MAX_LIMIT),
        groupBy: normalizeGroupBy(url.searchParams.get('groupBy')),
        edgeKinds: normalizeEdgeKinds(url.searchParams.get('edgeKinds')),
      }));
    } catch (error) {
      return errorResponse(error, 404);
    }
  }

  if (url.pathname === '/api/node') {
    const nodeId = url.searchParams.get('id')?.trim();
    if (!nodeId) return errorResponse('The id query parameter is required', 400);
    try {
      return jsonResponse(await createNodeDetails(selectedGraph, nodeId));
    } catch (error) {
      return errorResponse(error, 404);
    }
  }

  if (url.pathname === '/api/workspace/files') {
    try {
      return jsonResponse(await listWorkspaceDirectory(
        selected.projectRoot,
        url.searchParams.get('path') ?? '.',
        url.searchParams.get('hidden') === '1',
      ));
    } catch (error) {
      return workspaceErrorResponse(error);
    }
  }

  if (url.pathname === '/api/workspace/file') {
    const relativePath = url.searchParams.get('path')?.trim();
    if (!relativePath) return errorResponse('The path query parameter is required', 400);
    if (request.method === 'PUT') {
      try {
        const writeRequest = await parseWorkspaceWriteRequest(request);
        assertWorkspaceRequest(writeRequest.path === relativePath, 'The path query parameter must match the request body.', 400);
        const result = await writeWorkspaceFile(selected.projectRoot, writeRequest);
        return jsonResponse(result, result.status === 'conflict' ? 409 : 200);
      } catch (error) {
        return workspaceErrorResponse(error);
      }
    }
    try {
      return jsonResponse(await readWorkspaceFile(selected.projectRoot, relativePath));
    } catch (error) {
      return workspaceErrorResponse(error);
    }
  }

  if (url.pathname === '/api/workspace/file-version') {
    const relativePath = url.searchParams.get('path')?.trim();
    if (!relativePath) return errorResponse('The path query parameter is required', 400);
    try {
      return jsonResponse(await getWorkspaceFileVersion(selected.projectRoot, relativePath));
    } catch (error) {
      return workspaceErrorResponse(error);
    }
  }

  if (url.pathname === '/api/workspace/diff') {
    const modeValue = url.searchParams.get('mode') ?? 'uncommitted';
    if (modeValue !== 'uncommitted' && modeValue !== 'base') {
      return errorResponse('mode must be uncommitted or base', 400);
    }
    try {
      return jsonResponse(await getWorkspaceDiff(
        selected.projectRoot,
        modeValue as WorkspaceDiffMode,
        url.searchParams.get('baseRef'),
        url.searchParams.get('ignoreWhitespace') === '1',
      ));
    } catch (error) {
      return workspaceErrorResponse(error, 400);
    }
  }

  if (!staticRoot) return new Response('Not found', { status: 404 });
  const filePath = resolveStaticFile(staticRoot, url.pathname);
  if (!filePath) return new Response('Not found', { status: 404 });
  const response = new Response(Bun.file(filePath));
  // The native WKWebView can retain a failed module response in its memory
  // cache. Avoid reusing a poisoned viewer asset after a rebuild or retry.
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function startCodeGraphServer(
  projectRoot: string,
  options: CodeGraphServerOptions = {},
): Promise<CodeGraphServerHandle> {
  const resolvedRoot = path.resolve(projectRoot);
  const serveStatic = options.serveStatic !== false;
  const staticRoot = options.staticRoot ?? path.resolve(import.meta.dir, '../../frontend/dist');
  const indexFile = path.join(staticRoot, 'index.html');
  if (serveStatic && !existsSync(indexFile)) {
    throw new Error(
      `CodeGraph viewer assets are missing at ${staticRoot}. Run "bun run viewer:build" before starting the viewer.`,
    );
  }

  const projectRoots = [resolvedRoot, ...(options.projects ?? [])]
    .map((root) => path.resolve(root))
    .filter((root, index, roots) => roots.indexOf(root) === index);
  const opened: CodeGraph[] = [];
  const entries = new Map<string, ViewerProjectEntry>();
  try {
    for (const root of projectRoots) {
      const graph = await CodeGraph.open(root, { readOnly: true });
      opened.push(graph);
      const id = projectId(root);
      entries.set(id, {
        id,
        name: projectName(root),
        projectRoot: root,
        graph,
      });
    }

    const defaultId = projectId(resolvedRoot);
    const server = Bun.serve({
      hostname: options.hostname ?? '127.0.0.1',
      port: options.port ?? 4317,
      fetch: (request) => handleCodeGraphRequest(
        request,
        entries.get(defaultId)!.graph,
        serveStatic ? staticRoot : undefined,
        entries,
        defaultId,
      ),
    });
    const url = `${server.url.protocol}//${server.url.host}`;
    return {
      url,
      close: () => {
        server.stop(true);
        for (const graph of opened) graph.close();
      },
    };
  } catch (error) {
    for (const graph of opened) graph.close();
    throw error;
  }
}
