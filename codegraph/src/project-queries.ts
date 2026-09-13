import { removeDirectory } from './directory';
import {
  extractFromSource as extractSource
} from './extraction';
import { EXTRACTION_VERSION } from './extraction/extraction-version';
import type { CodeGraphState } from './project-state';
import {
  BuildContextOptions,
  Context,
  Edge,
  ExtractionResult,
  FileRecord,
  FindRelevantContextOptions,
  GraphStats,
  Node,
  NodeKind,
  SearchOptions,
  SearchResult,
  Subgraph,
  TaskContext,
  TaskInput,
  TraversalOptions
} from './types';

/**
   * Check if an indexing operation is currently in progress
   */
//noinspection JSUnusedGlobalSymbols
export function isIndexing(this: CodeGraphState): boolean {
  return this.indexMutex.isLocked();
}

/**
   * Most recent index timestamp (ms since epoch) across all tracked files, or
   * null when nothing is indexed yet. Lets library consumers check index
   * freshness without shelling out to `codegraph status --json`. (#329)
   */
export function getLastIndexedAt(this: CodeGraphState): number | null {
  return this.queries.getLastIndexedAt();
}

/**
   * Completeness of the last full index run. `'complete'` is the only good
   * state. `'indexing'` after the fact means a run was killed mid-index (OOM,
   * SIGKILL, liveness watchdog) and the on-disk index is truncated;
   * `'partial'` means the run finished but silently dropped files
   * (discovered > indexed+skipped+errored); `'failed'` means it reported
   * failure. `null` = index predates this marker. Surfaced by
   * `codegraph status`.
   */
export function getIndexState(this: CodeGraphState): 'indexing' | 'complete' | 'partial' | 'failed' | null {
  const raw = this.queries.getMetadata('index_state');
  return raw === 'indexing' || raw === 'complete' || raw === 'partial' || raw === 'failed'
    ? raw
    : null;
}

/**
   * Which engine built the current index: the package version + extraction
   * version stamped at the last full `indexAll`. Either field is null for an
   * index built before stamping existed (treated as stale). See
   * `extraction-version.ts` and `isIndexStale()`.
   */
export function getIndexBuildInfo(this: CodeGraphState): { version: string | null; extractionVersion: number | null } {
  const version = this.queries.getMetadata('indexed_with_version');
  const ev = this.queries.getMetadata('indexed_with_extraction_version');
  const parsed = ev != null ? parseInt(ev, 10) : NaN;
  return { version, extractionVersion: Number.isFinite(parsed) ? parsed : null };
}

/**
   * True when the on-disk index was built by an engine whose extraction is
   * older than the one now running — i.e. a re-index would add data a migration
   * can't backfill. False when there's no index yet (nothing to refresh) or the
   * stamp is current. This is the signal behind `codegraph status`'s re-index
   * hint.
   */
export function isIndexStale(this: CodeGraphState): boolean {
  if (this.queries.getLastIndexedAt() == null) return false;
  const { extractionVersion } = this.owner.getIndexBuildInfo();
  return extractionVersion == null || extractionVersion < EXTRACTION_VERSION;
}

/**
   * Extract nodes and edges from source code (without storing)
   */
export function extractFromSource(this: CodeGraphState, filePath: string, source: string): ExtractionResult {
  return extractSource(filePath, source);
}

// ===========================================================================
// Graph Statistics
// ===========================================================================

/**
 * Get statistics about the knowledge graph
 */
export function getStats(this: CodeGraphState): GraphStats {
  const stats = this.queries.getStats();
  stats.dbSizeBytes = this.db.getSize();
  stats.walSizeBytes = this.db.getWalSizeBytes();
  return stats;
}

/**
   * Active SQLite backend for this project's connection (`bun-sqlite` — Bun's
   * built-in real-SQLite module). Surfaced via `codegraph status` and the
   * `codegraph_status` MCP tool alongside the effective journal mode.
   */
export function getBackend(this: CodeGraphState): import('./db').SqliteBackend {
  return this.db.getBackend();
}

/**
   * The journal mode actually in effect ('wal', 'delete', …). 'wal' means
   * readers never block on a concurrent writer; anything else means they can,
   * which is the precondition for the "database is locked" failures in issue
   * #238. Surfaced via `codegraph status` and the `codegraph_status` MCP tool.
   */
export function getJournalMode(this: CodeGraphState): string {
  return this.db.getJournalMode();
}

// ===========================================================================
// Node Operations
// ===========================================================================

/**
 * Get a node by ID
 */
export function getNode(this: CodeGraphState, id: string): Node | null {
  return this.queries.getNodeById(id);
}

/**
   * Get all nodes in a file
   */
export function getNodesInFile(this: CodeGraphState, filePath: string): Node[] {
  return this.queries.getNodesByFile(filePath);
}

/**
   * Get all nodes of a specific kind
   */
export function getNodesByKind(this: CodeGraphState, kind: Node['kind']): Node[] {
  return this.queries.getNodesByKind(kind);
}

/**
   * Get ALL nodes with an exact name (direct index lookup, not FTS-ranked/capped).
   * Used to enumerate every overload of a heavily-overloaded name so the specific
   * definition the caller wants is never dropped below a search cut.
   */
export function getNodesByName(this: CodeGraphState, name: string): Node[] {
  return this.queries.getNodesByName(name);
}

/** Nodes whose name starts with `prefix` (index range scan, capped). */
export function getNodesByNamePrefix(this: CodeGraphState, prefix: string, limit = 20): Node[] {
  return this.queries.getNodesByNamePrefix(prefix, limit);
}

/**
   * Nodes whose name CONTAINS `substring` (LIKE scan, ASCII-case-insensitive,
   * shortest-first). The camel-infix lookup FTS can't do — `profileInfo`
   * inside `getProfileInfoV2` is one FTS token (#1196).
   */
export function getNodesByNameSubstring(this: CodeGraphState, substring: string, options: { kinds?: NodeKind[]; limit?: number; excludePrefix?: boolean } = {}): Node[] {
  return this.queries
    .findNodesByNameSubstring(substring, options)
    .map((r) => r.node);
}

/**
   * Search nodes by text
   */
export function searchNodes(this: CodeGraphState, query: string, options?: SearchOptions): SearchResult[] {
  return this.queries.searchNodes(query, options);
}

/**
   * Normalized project-name tokens (go.mod / package.json / repo dir) used to
   * down-weight the non-discriminative project name in search ranking (#720).
   * Exposed so explore can exclude it from the PascalCase type-disambiguation
   * bias, which would otherwise pull overloaded tokens toward whichever stack
   * embeds the project name.
   */
export function getProjectNameTokens(this: CodeGraphState): Set<string> {
  return this.queries.getProjectNameTokens();
}

/**
   * Find the project's "primary route file" — the file with the densest
   * concentration of framework-emitted `route` nodes (≥3 routes, ≥30%
   * of all non-test routes). Used to inline the routing config in
   * `codegraph_explore` responses on small realworld template repos
   * (rails-realworld, laravel-realworld, drupal-admintoolbar, …) where
   * Glob+Read of `routes.rb`/`urls.py`/etc. otherwise beats codegraph.
   */
//noinspection JSUnusedGlobalSymbols
export function getTopRouteFile(this: CodeGraphState): { filePath: string; routeCount: number; totalRoutes: number } | null {
  return this.queries.getTopRouteFile();
}

/**
   * Build a URL → handler routing manifest from the index. Each entry
   * pairs a route node (URL + method) with its handler function/method
   * via the `references` edge that framework resolvers emit. Returns
   * null when fewer than 3 valid (non-test) routes exist.
   */
//noinspection JSUnusedGlobalSymbols
export function getRoutingManifest(this: CodeGraphState, limit?: number): {
  entries: Array<{ url: string; handler: string; handlerFile: string; handlerLine: number; handlerKind: string }>;
  topHandlerFile: string | null;
  topHandlerFileCount: number;
  totalRoutes: number;
} | null {
  return this.queries.getRoutingManifest(limit);
}

// ===========================================================================
// Edge Operations
// ===========================================================================

/**
 * Get outgoing edges from a node
 */
export function getOutgoingEdges(this: CodeGraphState, nodeId: string): Edge[] {
  return this.queries.getOutgoingEdges(nodeId);
}

/**
   * Get incoming edges to a node
   */
export function getIncomingEdges(this: CodeGraphState, nodeId: string): Edge[] {
  return this.queries.getIncomingEdges(nodeId);
}

// ===========================================================================
// File Operations
// ===========================================================================

/**
 * Get a file record by path
 */
export function getFile(this: CodeGraphState, filePath: string): FileRecord | null {
  return this.queries.getFileByPath(filePath);
}

/**
   * Get all tracked files
   */
export function getFiles(this: CodeGraphState): FileRecord[] {
  return this.queries.getAllFiles();
}

// ===========================================================================
// Graph Query Methods
// ===========================================================================

/**
 * Get the context for a node (ancestors, children, references)
 *
 * Returns comprehensive context about a node including its containment
 * hierarchy, children, incoming/outgoing references, type information,
 * and relevant imports.
 *
 * @param nodeId - ID of the focal node
 * @returns Context object with all related information
 */
export function getContext(this: CodeGraphState, nodeId: string): Context {
  return this.graphManager.getContext(nodeId);
}

/**
   * Traverse the graph from a starting node
   *
   * Uses breadth-first search by default. Supports filtering by edge types,
   * node types, and traversal direction.
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
export function traverse(this: CodeGraphState, startId: string, options?: TraversalOptions): Subgraph {
  return this.traverser.traverseBFS(startId, options);
}

/**
   * Get the call graph for a function
   *
   * Returns both callers (functions that call this function) and
   * callees (functions called by this function) up to the specified depth.
   *
   * @param nodeId - ID of the function/method node
   * @param depth - Maximum depth in each direction (default: 2)
   * @returns Subgraph containing the call graph
   */
export function getCallGraph(this: CodeGraphState, nodeId: string, depth: number = 2): Subgraph {
  return this.traverser.getCallGraph(nodeId, depth);
}

/**
   * Get the type hierarchy for a class/interface
   *
   * Returns both ancestors (types this extends/implements) and
   * descendants (types that extend/implement this).
   *
   * @param nodeId - ID of the class/interface node
   * @returns Subgraph containing the type hierarchy
   */
export function getTypeHierarchy(this: CodeGraphState, nodeId: string): Subgraph {
  return this.traverser.getTypeHierarchy(nodeId);
}

/**
   * Find all usages of a symbol
   *
   * Returns all nodes that reference the specified symbol through
   * any edge type (calls, references, type_of, etc.).
   *
   * @param nodeId - ID of the symbol node
   * @returns Array of nodes and edges that reference this symbol
   */
export function findUsages(this: CodeGraphState, nodeId: string): Array<{ node: Node; edge: Edge }> {
  return this.traverser.findUsages(nodeId);
}

/**
   * Get callers of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes that call this function
   */
export function getCallers(this: CodeGraphState, nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
  return this.traverser.getCallers(nodeId, maxDepth);
}

/**
   * Get callees of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes called by this function
   */
export function getCallees(this: CodeGraphState, nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
  return this.traverser.getCallees(nodeId, maxDepth);
}

/**
   * Calculate the impact radius of a node
   *
   * Returns all nodes that could be affected by changes to this node.
   *
   * @param nodeId - ID of the node
   * @param maxDepth - Maximum depth to traverse (default: 3)
   * @returns Subgraph containing potentially impacted nodes
   */
export function getImpactRadius(this: CodeGraphState, nodeId: string, maxDepth: number = 3): Subgraph {
  return this.traverser.getImpactRadius(nodeId, maxDepth);
}

/**
   * Find the shortest path between two nodes
   *
   * @param fromId - Starting node ID
   * @param toId - Target node ID
   * @param edgeKinds - Edge types to consider (all if empty)
   * @returns Array of nodes and edges forming the path, or null if no path exists
   */
export function findPath(this: CodeGraphState, fromId: string, toId: string, edgeKinds?: Edge['kind'][]): Array<{ node: Node; edge: Edge | null }> | null {
  return this.traverser.findPath(fromId, toId, edgeKinds);
}

/**
   * Get ancestors of a node in the containment hierarchy
   *
   * @param nodeId - ID of the node
   * @returns Array of ancestor nodes from immediate parent to root
   */
export function getAncestors(this: CodeGraphState, nodeId: string): Node[] {
  return this.traverser.getAncestors(nodeId);
}

/**
   * Get immediate children of a node
   *
   * @param nodeId - ID of the node
   * @returns Array of child nodes
   */
export function getChildren(this: CodeGraphState, nodeId: string): Node[] {
  return this.traverser.getChildren(nodeId);
}

/**
   * Get dependencies of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths this file depends on
   */
export function getFileDependencies(this: CodeGraphState, filePath: string): string[] {
  return this.graphManager.getFileDependencies(filePath);
}

/**
   * Get dependents of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths that depend on this file
   */
export function getFileDependents(this: CodeGraphState, filePath: string): string[] {
  return this.graphManager.getFileDependents(filePath);
}

/**
   * Find circular dependencies in the codebase
   *
   * @returns Array of cycles, each cycle is an array of file paths
   */
export function findCircularDependencies(this: CodeGraphState): string[][] {
  return this.graphManager.findCircularDependencies();
}

/**
   * Find dead code (unreferenced symbols)
   *
   * @param kinds - Node kinds to check (default: functions, methods, classes)
   * @returns Array of unreferenced nodes
   */
export function findDeadCode(this: CodeGraphState, kinds?: Node['kind'][]): Node[] {
  return this.graphManager.findDeadCode(kinds);
}

/**
   * Get complexity metrics for a node
   *
   * @param nodeId - ID of the node
   * @returns Object containing various complexity metrics
   */
export function getNodeMetrics(this: CodeGraphState, nodeId: string): {
  incomingEdgeCount: number;
  outgoingEdgeCount: number;
  callCount: number;
  callerCount: number;
  childCount: number;
  depth: number;
} {
  return this.graphManager.getNodeMetrics(nodeId);
}

// ===========================================================================
// Context Building
// ===========================================================================

/**
 * Get the source code for a node
 *
 * Reads the file and extracts the code between startLine and endLine.
 *
 * @param nodeId - ID of the node
 * @returns Code string or null if not found
 */
export async function getCode(this: CodeGraphState, nodeId: string): Promise<string | null> {
  return this.contextBuilder.getCode(nodeId);
}

/**
   * Find relevant subgraph for a query
   *
   * Combines semantic search with graph traversal to find the most
   * relevant nodes and their relationships for a given query.
   *
   * @param query - Natural language query describing the task
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
export async function findRelevantContext(this: CodeGraphState, query: string, options?: FindRelevantContextOptions): Promise<Subgraph> {
  return this.contextBuilder.findRelevantContext(query, options);
}

/**
   * Build context for a task
   *
   * Creates comprehensive context by:
   * 1. Running FTS search to find entry points
   * 2. Expanding the graph around entry points
   * 3. Extracting code blocks for key nodes
   * 4. Formatting output for Claude
   *
   * @param input - Task description (string or {title, description})
   * @param options - Build options (maxNodes, includeCode, format, etc.)
   * @returns TaskContext object or formatted string (markdown/JSON)
   */
export async function buildContext(this: CodeGraphState, input: TaskInput, options?: BuildContextOptions): Promise<TaskContext | string> {
  return this.contextBuilder.buildContext(input, options);
}

// ===========================================================================
// Database Management
// ===========================================================================

/**
 * Optimize the database (vacuum and analyze)
 */
export function optimize(this: CodeGraphState): void {
  this.assertWritable('optimize the database');
  this.db.optimize();
}

/**
   * Clear all data from the graph
   */
export function clear(this: CodeGraphState): void {
  this.assertWritable('clear the graph');
  this.queries.clear();
}

/**
   * Completely remove CodeGraph from the project.
   * This closes the database and deletes the .CodeGraph directory.
   *
   * WARNING: This permanently deletes all CodeGraph data for the project.
   */
export function uninitialize(this: CodeGraphState): void {
  this.assertWritable('uninitialize the project');
  this.owner.close();
  removeDirectory(this.projectRoot);
}
