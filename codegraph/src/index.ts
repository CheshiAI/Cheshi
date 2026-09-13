import { CodeGraphState } from './project-state';
import { DatabaseConnection, getDatabasePath, removeDatabaseFiles } from './db';
import { QueryBuilder } from './db/queries';
import { createDirectory, getCodeGraphDir, isInitialized } from './directory';
import {
  IndexResult,
  initGrammars,
  SyncResult
} from './extraction';
import {
  resolveValidatedProjectRoot,
  throwDatabaseRebuildFailure
} from './project-lifecycle';
import type { IndexOptions, InitOptions, OpenOptions } from './project-options';
import { ResolutionResult } from './resolution';
import { PendingFile, WatchOptions } from './sync';
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
  SegmentMatch,
  Subgraph,
  TaskContext,
  TaskInput,
  TraversalOptions,
} from './types';
import { FileLock } from './utils';
import * as path from 'path';

export * from './types';

export { DatabaseConnection, getDatabasePath } from './db';

export { QueryBuilder } from './db/queries';

export {
  CODEGRAPH_DIR, findNearestCodeGraphRoot, getCodeGraphDir,
  isInitialized
} from './directory';

export type { IndexProgress, IndexResult, SyncResult } from './extraction';

export { detectLanguage, getSupportedLanguages, initGrammars, isGrammarLoaded, isLanguageSupported, loadAllGrammars, loadGrammarsForLanguages } from './extraction';

export type { ResolutionResult } from './resolution';

export {
  CodeGraphError, ConfigError, DatabaseError, defaultLogger, FileError, getLogger, ParseError, SearchError, setLogger, silentLogger, VectorError
} from './errors';

export type { Logger } from './errors';

export { debounce, FileLock, MemoryMonitor, Mutex, processInBatches, throttle } from './utils';

export { FileWatcher, LockUnavailableError } from './sync';

export type { PendingFile, WatchOptions } from './sync';

export { MCPServer } from './mcp';

export type { InitOptions } from './project-options';

export type { OpenOptions } from './project-options';

export type { IndexOptions } from './project-options';

/**
 * Main CodeGraph class
 *
 * Provides the primary interface for interacting with the code knowledge graph.
 */
export class CodeGraph {
  private readonly state: CodeGraphState;

  private constructor(db: DatabaseConnection, queries: QueryBuilder, projectRoot: string, fileLock?: FileLock) {
    this.state = new CodeGraphState(db, queries, projectRoot, fileLock, this);
  }



  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Initialize a new CodeGraph project
   *
   * Creates the .CodeGraph directory, database, and configuration.
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Initialization options
   * @returns A new CodeGraph instance
   */
  static async init(projectRoot: string, options: InitOptions = {}): Promise<CodeGraph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new CodeGraph(db, queries, resolvedRoot);

    // Run initial indexing if requested
    if (options.index) {
      await instance.indexAll({ onProgress: options.onProgress });
    }

    return instance;
  }


  /**
   * Initialize synchronously (without indexing)
   */
  static initSync(projectRoot: string): CodeGraph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new CodeGraph(db, queries, resolvedRoot);
  }


  /**
   * Open an existing CodeGraph project
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Open options
   * @returns A CodeGraph instance
   */
  static async open(projectRoot: string, options: OpenOptions = {}): Promise<CodeGraph> {
    await initGrammars();

    if (options.readOnly === true && options.sync === true) {
      throw new Error('Cannot sync while opening CodeGraph in read-only mode');
    }

    const readOnly = options.readOnly === true;
    const resolvedRoot = resolveValidatedProjectRoot(projectRoot, readOnly);

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath, { readOnly });
    const queries = new QueryBuilder(db.getDb());

    const instance = new CodeGraph(db, queries, resolvedRoot);

    // Sync if requested
    if (options.sync === true) {
      try {
        await instance.sync();
      } catch (error) {
        instance.close();
        throw error;
      }
    }

    return instance;
  }


  /**
   * Rebuild the project's database from scratch and return a fresh, empty
   * instance — the "same result as a fresh init" semantics that `codegraph
   * index` documents.
   *
   * Unlike `open()` followed by `clear()`, this DISCARDS the existing
   * `.codegraph/codegraph.db` (and its `-wal`/`-shm` sidecars) before
   * re-initializing, instead of opening the old database and DELETE-ing every
   * row. On a large or pre-fix poisoned index — e.g. an old graph that scanned
   * an ignored gitlink corpus (#1065) into ~1.6M nodes with a multi-GB WAL —
   * the per-row `nodes_fts` delete-trigger churn blocks the main thread long
   * enough to trip the #850 liveness watchdog before indexing even starts, so a
   * full re-index could never recover the bad state (#1067). Discarding the
   * files is O(1) regardless of size, reclaims the disk, and sidesteps opening
   * (and running migrations against) the poisoned database entirely. The
   * project write lock is acquired BEFORE removal and retained by the returned
   * instance until its next lock-managed indexing operation completes (or
   * close()), so no writer can enter between recreation and the full index.
   */
  static async recreate(projectRoot: string): Promise<CodeGraph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized — recreate REBUILDS an existing project; it is not a
    // first-time `init`.
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    const dbPath = getDatabasePath(resolvedRoot);
    const fileLock = new FileLock(path.join(getCodeGraphDir(resolvedRoot), 'codegraph.lock'));
    fileLock.acquire();
    let db: DatabaseConnection | null = null;
    try {
      try {
        removeDatabaseFiles(dbPath);
      } catch (err) {
        // POSIX unlinks an open file fine; this fires mainly on Windows when a
        // live daemon/MCP server still holds the database. Turn the raw EBUSY into
        // an actionable instruction instead of a generic failure.
        throwDatabaseRebuildFailure(err, resolvedRoot);
      }

      // Re-create an empty, freshly-schema'd database at the same path. Pass the
      // already-held lock into the instance so indexAll owns one uninterrupted
      // critical section spanning deletion, initialization, and population.
      db = DatabaseConnection.initialize(dbPath);
      const queries = new QueryBuilder(db.getDb());
      return new CodeGraph(db, queries, resolvedRoot, fileLock);
    } catch (error) {
      try { db?.close(); } catch { /* preserve the recreation error */ }
      fileLock.release();
      throw error;
    }
  }


  /**
   * Open synchronously (without sync)
   */
  static openSync(projectRoot: string, options: Pick<OpenOptions, 'readOnly'> = {}): CodeGraph {
    const readOnly = options.readOnly === true;
    const resolvedRoot = resolveValidatedProjectRoot(projectRoot, readOnly);

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath, { readOnly });
    const queries = new QueryBuilder(db.getDb());

    return new CodeGraph(db, queries, resolvedRoot);
  }


  /**
   * Check if a directory has been initialized as a CodeGraph project
   */
  static isInitialized(projectRoot: string): boolean {
    return isInitialized(path.resolve(projectRoot));
  }

  reopenIfReplaced(): boolean {
    return this.state.reopenIfReplaced();
  }

  close(): void {
    return this.state.close();
  }

  getProjectRoot(): string {
    return this.state.getProjectRoot();
  }

  async indexAll(options: IndexOptions = {}): Promise<IndexResult> {
    return this.state.indexAll(options);
  }

  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    return this.state.indexFiles(filePaths);
  }

  async sync(options: IndexOptions = {}): Promise<SyncResult> {
    return this.state.sync(options);
  }

  isIndexing(): boolean {
    return this.state.isIndexing();
  }

  watch(options: WatchOptions = {}): boolean {
    return this.state.watch(options);
  }

  unwatch(): void {
    return this.state.unwatch();
  }

  isWatching(): boolean {
    return this.state.isWatching();
  }

  isWatcherDegraded(): boolean {
    return this.state.isWatcherDegraded();
  }

  getWatcherDegradedReason(): string | null {
    return this.state.getWatcherDegradedReason();
  }

  getPendingFiles(): PendingFile[] {
    return this.state.getPendingFiles();
  }

  waitUntilWatcherReady(timeoutMs?: number): Promise<void> {
    return this.state.waitUntilWatcherReady(timeoutMs);
  }

  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    return this.state.getChangedFiles();
  }

  getLastIndexedAt(): number | null {
    return this.state.getLastIndexedAt();
  }

  getIndexState(): 'indexing' | 'complete' | 'partial' | 'failed' | null {
    return this.state.getIndexState();
  }

  getIndexBuildInfo(): { version: string | null; extractionVersion: number | null } {
    return this.state.getIndexBuildInfo();
  }

  isIndexStale(): boolean {
    return this.state.isIndexStale();
  }

  extractFromSource(filePath: string, source: string): ExtractionResult {
    return this.state.extractFromSource(filePath, source);
  }

  resolveReferences(onProgress?: (current: number, total: number) => void): ResolutionResult {
    return this.state.resolveReferences(onProgress);
  }

  async resolveReferencesBatched(onProgress?: (current: number, total: number) => void, onSynthesisProgress?: (done: number, total: number) => void, backpressure?: () => Promise<void> | null): Promise<ResolutionResult> {
    return this.state.resolveReferencesBatched(onProgress, onSynthesisProgress, backpressure);
  }

  getPendingReferenceCount(): number {
    return this.state.getPendingReferenceCount();
  }

  getDetectedFrameworks(): string[] {
    return this.state.getDetectedFrameworks();
  }

  reinitializeResolver(): void {
    return this.state.reinitializeResolver();
  }

  getStats(): GraphStats {
    return this.state.getStats();
  }

  getBackend(): import('./db').SqliteBackend {
    return this.state.getBackend();
  }

  getJournalMode(): string {
    return this.state.getJournalMode();
  }

  getNode(id: string): Node | null {
    return this.state.getNode(id);
  }

  getNodesInFile(filePath: string): Node[] {
    return this.state.getNodesInFile(filePath);
  }

  getNodesByKind(kind: Node['kind']): Node[] {
    return this.state.getNodesByKind(kind);
  }

  getNodesByName(name: string): Node[] {
    return this.state.getNodesByName(name);
  }

  getNodesByNamePrefix(prefix: string, limit = 20): Node[] {
    return this.state.getNodesByNamePrefix(prefix, limit);
  }

  getNodesByNameSubstring(substring: string, options: { kinds?: NodeKind[]; limit?: number; excludePrefix?: boolean } = {}): Node[] {
    return this.state.getNodesByNameSubstring(substring, options);
  }

  searchNodes(query: string, options?: SearchOptions): SearchResult[] {
    return this.state.searchNodes(query, options);
  }

  getSegmentMatches(words: string[], limit: number = 6): SegmentMatch[] {
    return this.state.getSegmentMatches(words, limit);
  }

  async healSegmentVocabIfEmpty(): Promise<boolean> {
    return this.state.healSegmentVocabIfEmpty();
  }

  getProjectNameTokens(): Set<string> {
    return this.state.getProjectNameTokens();
  }

  getTopRouteFile(): { filePath: string; routeCount: number; totalRoutes: number } | null {
    return this.state.getTopRouteFile();
  }

  getRoutingManifest(limit?: number): {
    entries: Array<{ url: string; handler: string; handlerFile: string; handlerLine: number; handlerKind: string }>;
    topHandlerFile: string | null;
    topHandlerFileCount: number;
    totalRoutes: number;
  } | null {
    return this.state.getRoutingManifest(limit);
  }

  getOutgoingEdges(nodeId: string): Edge[] {
    return this.state.getOutgoingEdges(nodeId);
  }

  getIncomingEdges(nodeId: string): Edge[] {
    return this.state.getIncomingEdges(nodeId);
  }

  getFile(filePath: string): FileRecord | null {
    return this.state.getFile(filePath);
  }

  getFiles(): FileRecord[] {
    return this.state.getFiles();
  }

  getContext(nodeId: string): Context {
    return this.state.getContext(nodeId);
  }

  traverse(startId: string, options?: TraversalOptions): Subgraph {
    return this.state.traverse(startId, options);
  }

  getCallGraph(nodeId: string, depth: number = 2): Subgraph {
    return this.state.getCallGraph(nodeId, depth);
  }

  getTypeHierarchy(nodeId: string): Subgraph {
    return this.state.getTypeHierarchy(nodeId);
  }

  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> {
    return this.state.findUsages(nodeId);
  }

  getCallers(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.state.getCallers(nodeId, maxDepth);
  }

  getCallees(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.state.getCallees(nodeId, maxDepth);
  }

  getImpactRadius(nodeId: string, maxDepth: number = 3): Subgraph {
    return this.state.getImpactRadius(nodeId, maxDepth);
  }

  findPath(fromId: string, toId: string, edgeKinds?: Edge['kind'][]): Array<{ node: Node; edge: Edge | null }> | null {
    return this.state.findPath(fromId, toId, edgeKinds);
  }

  getAncestors(nodeId: string): Node[] {
    return this.state.getAncestors(nodeId);
  }

  getChildren(nodeId: string): Node[] {
    return this.state.getChildren(nodeId);
  }

  getFileDependencies(filePath: string): string[] {
    return this.state.getFileDependencies(filePath);
  }

  getFileDependents(filePath: string): string[] {
    return this.state.getFileDependents(filePath);
  }

  findCircularDependencies(): string[][] {
    return this.state.findCircularDependencies();
  }

  findDeadCode(kinds?: Node['kind'][]): Node[] {
    return this.state.findDeadCode(kinds);
  }

  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    return this.state.getNodeMetrics(nodeId);
  }

  async getCode(nodeId: string): Promise<string | null> {
    return this.state.getCode(nodeId);
  }

  async findRelevantContext(query: string, options?: FindRelevantContextOptions): Promise<Subgraph> {
    return this.state.findRelevantContext(query, options);
  }

  async buildContext(input: TaskInput, options?: BuildContextOptions): Promise<TaskContext | string> {
    return this.state.buildContext(input, options);
  }

  optimize(): void {
    return this.state.optimize();
  }

  clear(): void {
    return this.state.clear();
  }

  uninitialize(): void {
    return this.state.uninitialize();
  }
}

// Default export
export default CodeGraph;
