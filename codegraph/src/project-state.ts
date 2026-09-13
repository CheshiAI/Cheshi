import * as path from 'path';
import { ContextBuilder } from './context';
import { DatabaseConnection } from './db';
import { QueryBuilder } from './db/queries';
import { getCodeGraphDir } from './directory';
import {
  extractFromSource,
  ExtractionOrchestrator
} from './extraction';
import { GraphQueryManager, GraphTraverser } from './graph';
import type { CodeGraph } from './index';
import { indexAll, indexFiles } from './project-indexing';
import {
  buildContext,
  clear,
  findCircularDependencies,
  findDeadCode,
  findPath,
  findRelevantContext,
  findUsages,
  getAncestors,
  getBackend,
  getCallees,
  getCallers,
  getCallGraph,
  getChildren,
  getCode,
  getContext,
  getFile,
  getFileDependencies,
  getFileDependents,
  getFiles,
  getImpactRadius,
  getIncomingEdges,
  getIndexBuildInfo,
  getIndexState,
  getJournalMode,
  getLastIndexedAt,
  getNode,
  getNodeMetrics,
  getNodesByKind,
  getNodesByName,
  getNodesByNamePrefix,
  getNodesByNameSubstring,
  getNodesInFile,
  getOutgoingEdges,
  getProjectNameTokens,
  getRoutingManifest,
  getStats,
  getTopRouteFile,
  getTypeHierarchy,
  isIndexing,
  isIndexStale,
  optimize,
  searchNodes,
  traverse,
  uninitialize
} from './project-queries';
import {
  getDetectedFrameworks,
  getPendingReferenceCount,
  reinitializeResolver,
  resolveReferences,
  resolveReferencesBatched,
} from './project-resolution';
import {
  getSegmentMatches,
  healSegmentVocabIfEmpty,
  rebuildNameSegmentVocab,
  wordsMatchingName,
} from './project-search';
import {
  acquireFileLock,
  assertWritable,
  close,
  getProjectRoot,
  reopenIfReplaced,
  wireLayers,
} from './project-state-lifecycle';
import { sync } from './project-sync';
import {
  getChangedFiles,
  getPendingFiles,
  getWatcherDegradedReason,
  isWatcherDegraded,
  isWatching,
  unwatch,
  waitUntilWatcherReady,
  watch,
} from './project-watching';
import { ReferenceResolver } from './resolution';
import { FileWatcher } from './sync';
import { FileLock, Mutex } from './utils';

/** Internal state and method bindings for CodeGraph. */
export class CodeGraphState {
  db: DatabaseConnection;

  queries: QueryBuilder;

  readonly projectRoot: string;

  // Assigned via wireLayers() from the constructor (and again on reopen) — the
  // `!` tells TS these are definitely set even though the assignment is one
  // method call away from the constructor body.
  orchestrator!: ExtractionOrchestrator;

  resolver!: ReferenceResolver;

  graphManager!: GraphQueryManager;

  traverser!: GraphTraverser;

  contextBuilder!: ContextBuilder;

  // Mutex for preventing concurrent indexing operations (in-process)
  indexMutex = new Mutex();

  // File lock for preventing concurrent writes across processes (CLI, MCP, git hooks)
  fileLock: FileLock;

  // File watcher for auto-sync on file changes
  watcher: FileWatcher | null = null;

  constructor(db: DatabaseConnection, queries: QueryBuilder, projectRoot: string, fileLock?: FileLock, readonly owner: Pick<CodeGraph, keyof CodeGraph> = this) {
    this.db = db;
    this.queries = queries;
    this.projectRoot = projectRoot;
    this.fileLock = fileLock ?? new FileLock(
      path.join(getCodeGraphDir(projectRoot), 'codegraph.lock')
    );
    this.wireLayers();
  }
}

export interface CodeGraphState {
  assertWritable: typeof assertWritable;
  acquireFileLock: typeof acquireFileLock;
  wireLayers: typeof wireLayers;
  reopenIfReplaced: typeof reopenIfReplaced;
  close: typeof close;
  getProjectRoot: typeof getProjectRoot;
  indexAll: typeof indexAll;
  indexFiles: typeof indexFiles;
  sync: typeof sync;
  isIndexing: typeof isIndexing;
  watch: typeof watch;
  unwatch: typeof unwatch;
  isWatching: typeof isWatching;
  isWatcherDegraded: typeof isWatcherDegraded;
  getWatcherDegradedReason: typeof getWatcherDegradedReason;
  getPendingFiles: typeof getPendingFiles;
  waitUntilWatcherReady: typeof waitUntilWatcherReady;
  getChangedFiles: typeof getChangedFiles;
  getLastIndexedAt: typeof getLastIndexedAt;
  getIndexState: typeof getIndexState;
  getIndexBuildInfo: typeof getIndexBuildInfo;
  isIndexStale: typeof isIndexStale;
  extractFromSource: typeof extractFromSource;
  resolveReferences: typeof resolveReferences;
  resolveReferencesBatched: typeof resolveReferencesBatched;
  getPendingReferenceCount: typeof getPendingReferenceCount;
  getDetectedFrameworks: typeof getDetectedFrameworks;
  reinitializeResolver: typeof reinitializeResolver;
  getStats: typeof getStats;
  getBackend: typeof getBackend;
  getJournalMode: typeof getJournalMode;
  getNode: typeof getNode;
  getNodesInFile: typeof getNodesInFile;
  getNodesByKind: typeof getNodesByKind;
  getNodesByName: typeof getNodesByName;
  getNodesByNamePrefix: typeof getNodesByNamePrefix;
  getNodesByNameSubstring: typeof getNodesByNameSubstring;
  searchNodes: typeof searchNodes;
  getSegmentMatches: typeof getSegmentMatches;
  wordsMatchingName: typeof wordsMatchingName;
  healSegmentVocabIfEmpty: typeof healSegmentVocabIfEmpty;
  rebuildNameSegmentVocab: typeof rebuildNameSegmentVocab;
  getProjectNameTokens: typeof getProjectNameTokens;
  getTopRouteFile: typeof getTopRouteFile;
  getRoutingManifest: typeof getRoutingManifest;
  getOutgoingEdges: typeof getOutgoingEdges;
  getIncomingEdges: typeof getIncomingEdges;
  getFile: typeof getFile;
  getFiles: typeof getFiles;
  getContext: typeof getContext;
  traverse: typeof traverse;
  getCallGraph: typeof getCallGraph;
  getTypeHierarchy: typeof getTypeHierarchy;
  findUsages: typeof findUsages;
  getCallers: typeof getCallers;
  getCallees: typeof getCallees;
  getImpactRadius: typeof getImpactRadius;
  findPath: typeof findPath;
  getAncestors: typeof getAncestors;
  getChildren: typeof getChildren;
  getFileDependencies: typeof getFileDependencies;
  getFileDependents: typeof getFileDependents;
  findCircularDependencies: typeof findCircularDependencies;
  findDeadCode: typeof findDeadCode;
  getNodeMetrics: typeof getNodeMetrics;
  getCode: typeof getCode;
  findRelevantContext: typeof findRelevantContext;
  buildContext: typeof buildContext;
  optimize: typeof optimize;
  clear: typeof clear;
  uninitialize: typeof uninitialize;
}

Object.assign(CodeGraphState.prototype, {
  assertWritable,
  acquireFileLock,
  wireLayers,
  reopenIfReplaced,
  close,
  getProjectRoot,
  indexAll,
  indexFiles,
  sync,
  isIndexing,
  watch,
  unwatch,
  isWatching,
  isWatcherDegraded,
  getWatcherDegradedReason,
  getPendingFiles,
  waitUntilWatcherReady,
  getChangedFiles,
  getLastIndexedAt,
  getIndexState,
  getIndexBuildInfo,
  isIndexStale,
  extractFromSource,
  resolveReferences,
  resolveReferencesBatched,
  getPendingReferenceCount,
  getDetectedFrameworks,
  reinitializeResolver,
  getStats,
  getBackend,
  getJournalMode,
  getNode,
  getNodesInFile,
  getNodesByKind,
  getNodesByName,
  getNodesByNamePrefix,
  getNodesByNameSubstring,
  searchNodes,
  getSegmentMatches,
  wordsMatchingName,
  healSegmentVocabIfEmpty,
  rebuildNameSegmentVocab,
  getProjectNameTokens,
  getTopRouteFile,
  getRoutingManifest,
  getOutgoingEdges,
  getIncomingEdges,
  getFile,
  getFiles,
  getContext,
  traverse,
  getCallGraph,
  getTypeHierarchy,
  findUsages,
  getCallers,
  getCallees,
  getImpactRadius,
  findPath,
  getAncestors,
  getChildren,
  getFileDependencies,
  getFileDependents,
  findCircularDependencies,
  findDeadCode,
  getNodeMetrics,
  getCode,
  findRelevantContext,
  buildContext,
  optimize,
  clear,
  uninitialize,
});
