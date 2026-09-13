import {
  Node
} from '../types';
import type { QueryBuilder } from './queries';
import {
  deleteEdgesBySource,
  findEdgesBetweenNodes,
  getCrossFileIncomingEdgesWithTarget,
  getDependencyFilePaths,
  getDependentFilePaths,
  getIncomingEdges,
  getOutgoingEdges,
  insertEdge,
  insertEdges,
} from './query-edges';
import {
  deleteFile,
  getAllFilePaths,
  getAllFiles,
  getAllNodeNames,
  getFileByPath,
  getLastIndexedAt,
  getNodeNamesByFiles,
  getStaleFiles,
  iterateNodeNames,
  upsertFile,
} from './query-files';
import {
  cacheNode,
  clear,
  clearCache,
  getAllMetadata,
  getMetadata,
  getNodeAndEdgeCount,
  getProjectNameTokens,
  getStats,
  rebind,
  setMetadata,
  setProjectNameTokens,
} from './query-lifecycle';
import {
  clearNameSegmentVocab,
  getDistinctNodeNames,
  getNamesForSegment,
  getSegmentCoOccurrence,
  getSegmentNameCounts,
  insertNameSegmentsBatch,
  isNameSegmentVocabEmpty,
} from './query-name-segments';
import {
  getAllNodes,
  getDistinctFileLanguages,
  getDominantFile,
  getExistingNodeIds,
  getNodeById,
  getNodesByFile,
  getNodesByIds,
  getNodesByKind,
  getNodesByLowerName,
  getNodesByName,
  getNodesByNamePrefix,
  getNodesByQualifiedNameExact,
  getRoutingManifest,
  getTopRouteFile,
  iterateNodesByKind,
  iterateNodesByLanguageWithDecorator,
} from './query-node-reads';
import {
  collectNameSegmentRows,
  deleteNode,
  deleteNodesByFile,
  insertNameSegments,
  insertNode,
  insertNodes,
  isSegmentableKind,
  runBatched,
  storeFileBundle,
  updateNode,
} from './query-node-writes';
import {
  clearUnresolvedReferences,
  deleteReferencesByRowIds,
  deleteResolvedReferences,
  deleteSpecificResolvedReferences,
  deleteUnresolvedByNode,
  getRetryableFailedReferences,
  getUnresolvedByName,
  getUnresolvedReferences,
  getUnresolvedReferencesBatch,
  getUnresolvedReferencesBatchAfter,
  getUnresolvedReferencesByFiles,
  getUnresolvedReferencesCount,
  insertUnresolvedRef,
  insertUnresolvedRefsBatch,
  markReferencesFailed,
  markReferencesFailedByRowIds,
} from './query-references';
import {
  findNodesByExactName,
  findNodesByNameSubstring,
  searchAllByFilters,
  searchNodes,
  searchNodesFTS,
  searchNodesFuzzy,
  searchNodesLike,
} from './query-search';
import type { SqliteDatabase, SqliteStatement } from './sqlite-adapter';

/** Internal state and method bindings for QueryBuilder. */
export class QueryState {
  db: SqliteDatabase;

  // Project-name tokens (go.mod / package.json / repo dir), normalized. A query
  // word matching one is dropped from path-relevance scoring — it names the
  // whole project, not a symbol, so it carries no discriminative signal (#720).
  // Set once by the CodeGraph instance; empty by default (no down-weighting).
  projectNameTokens: Set<string> = new Set();

  // Node cache for frequently accessed nodes (LRU-style, max 1000 entries)
  nodeCache: Map<string, Node> = new Map();

  readonly maxCacheSize = 1000;

  // Prepared statements (lazily initialized)
  stmts: {
    insertNode?: SqliteStatement;
    updateNode?: SqliteStatement;
    deleteNode?: SqliteStatement;
    deleteNodesByFile?: SqliteStatement;
    getNodeById?: SqliteStatement;
    getNodesByFile?: SqliteStatement;
    getNodesByKind?: SqliteStatement;
    insertEdge?: SqliteStatement;
    upsertFile?: SqliteStatement;
    deleteEdgesBySource?: SqliteStatement;
    deleteEdgesByTarget?: SqliteStatement;
    getEdgesBySource?: SqliteStatement;
    getEdgesByTarget?: SqliteStatement;
    insertFile?: SqliteStatement;
    updateFile?: SqliteStatement;
    deleteFile?: SqliteStatement;
    getFileByPath?: SqliteStatement;
    getAllFiles?: SqliteStatement;
    insertUnresolved?: SqliteStatement;
    deleteUnresolvedByNode?: SqliteStatement;
    getUnresolvedByName?: SqliteStatement;
    getNodesByName?: SqliteStatement;
    getNodesByNamePrefix?: SqliteStatement;
    getNodesByQualifiedNameExact?: SqliteStatement;
    getNodesByLowerName?: SqliteStatement;
    getUnresolvedCount?: SqliteStatement;
    getUnresolvedBatch?: SqliteStatement;
    getUnresolvedBatchAfter?: SqliteStatement;
    deleteRefsByRowIdsFull?: SqliteStatement;
    getAllFilePaths?: SqliteStatement;
    getAllNodeNames?: SqliteStatement;
    getDominantFile?: SqliteStatement;
    getTopRouteFile?: SqliteStatement;
    getRoutingManifest?: SqliteStatement;
    insertNameSegment?: SqliteStatement;
  } = {};

  // Names whose segments were already written this session — skips re-splitting
  // and re-inserting for the same-named nodes that repeat across files ("get",
  // "render", …). Purely a write-path fast path; INSERT OR IGNORE is the
  // correctness backstop. Bounded so a pathological repo can't grow it forever.
  segmentedNames: Set<string> = new Set();

  // Multi-row INSERT statements, cached per (statement kind × row count). The
  // bulk write path decomposes N rows into a few fixed batch sizes so each
  // size's statement is prepared once and reused — one .run() binds a whole
  // chunk instead of one row, which is where the per-call overhead lives.
  // Row order within and across chunks is the input order, so rowid assignment
  // (and therefore resolution's insertion-order disambiguation) is identical
  // to the one-row-per-run path.
  batchStmts: Map<string, SqliteStatement> = new Map();

  constructor(db: SqliteDatabase, readonly owner: Pick<QueryBuilder, keyof QueryBuilder> = this) {
    this.db = db;
  }
}

export interface QueryState {
  runBatched: typeof runBatched;
  rebind: typeof rebind;
  setProjectNameTokens: typeof setProjectNameTokens;
  getProjectNameTokens: typeof getProjectNameTokens;
  insertNode: typeof insertNode;
  isSegmentableKind: typeof isSegmentableKind;
  insertNameSegments: typeof insertNameSegments;
  insertNodes: typeof insertNodes;
  storeFileBundle: typeof storeFileBundle;
  collectNameSegmentRows: typeof collectNameSegmentRows;
  updateNode: typeof updateNode;
  deleteNode: typeof deleteNode;
  deleteNodesByFile: typeof deleteNodesByFile;
  clearNameSegmentVocab: typeof clearNameSegmentVocab;
  isNameSegmentVocabEmpty: typeof isNameSegmentVocabEmpty;
  getDistinctNodeNames: typeof getDistinctNodeNames;
  insertNameSegmentsBatch: typeof insertNameSegmentsBatch;
  getSegmentCoOccurrence: typeof getSegmentCoOccurrence;
  getSegmentNameCounts: typeof getSegmentNameCounts;
  getNamesForSegment: typeof getNamesForSegment;
  getNodeById: typeof getNodeById;
  getNodesByIds: typeof getNodesByIds;
  getExistingNodeIds: typeof getExistingNodeIds;
  cacheNode: typeof cacheNode;
  clearCache: typeof clearCache;
  getNodesByFile: typeof getNodesByFile;
  getDominantFile: typeof getDominantFile;
  getTopRouteFile: typeof getTopRouteFile;
  getRoutingManifest: typeof getRoutingManifest;
  getNodesByKind: typeof getNodesByKind;
  iterateNodesByKind: typeof iterateNodesByKind;
  getAllNodes: typeof getAllNodes;
  iterateNodesByLanguageWithDecorator: typeof iterateNodesByLanguageWithDecorator;
  getDistinctFileLanguages: typeof getDistinctFileLanguages;
  getNodesByName: typeof getNodesByName;
  getNodesByNamePrefix: typeof getNodesByNamePrefix;
  getNodesByQualifiedNameExact: typeof getNodesByQualifiedNameExact;
  getNodesByLowerName: typeof getNodesByLowerName;
  searchNodes: typeof searchNodes;
  searchAllByFilters: typeof searchAllByFilters;
  searchNodesFuzzy: typeof searchNodesFuzzy;
  searchNodesFTS: typeof searchNodesFTS;
  searchNodesLike: typeof searchNodesLike;
  findNodesByExactName: typeof findNodesByExactName;
  findNodesByNameSubstring: typeof findNodesByNameSubstring;
  insertEdge: typeof insertEdge;
  insertEdges: typeof insertEdges;
  deleteEdgesBySource: typeof deleteEdgesBySource;
  getOutgoingEdges: typeof getOutgoingEdges;
  getIncomingEdges: typeof getIncomingEdges;
  findEdgesBetweenNodes: typeof findEdgesBetweenNodes;
  getDependentFilePaths: typeof getDependentFilePaths;
  getDependencyFilePaths: typeof getDependencyFilePaths;
  getCrossFileIncomingEdgesWithTarget: typeof getCrossFileIncomingEdgesWithTarget;
  upsertFile: typeof upsertFile;
  deleteFile: typeof deleteFile;
  getFileByPath: typeof getFileByPath;
  getAllFiles: typeof getAllFiles;
  getLastIndexedAt: typeof getLastIndexedAt;
  getStaleFiles: typeof getStaleFiles;
  insertUnresolvedRef: typeof insertUnresolvedRef;
  insertUnresolvedRefsBatch: typeof insertUnresolvedRefsBatch;
  deleteUnresolvedByNode: typeof deleteUnresolvedByNode;
  getUnresolvedByName: typeof getUnresolvedByName;
  getUnresolvedReferences: typeof getUnresolvedReferences;
  getUnresolvedReferencesCount: typeof getUnresolvedReferencesCount;
  getUnresolvedReferencesBatch: typeof getUnresolvedReferencesBatch;
  getUnresolvedReferencesBatchAfter: typeof getUnresolvedReferencesBatchAfter;
  getAllFilePaths: typeof getAllFilePaths;
  getAllNodeNames: typeof getAllNodeNames;
  iterateNodeNames: typeof iterateNodeNames;
  getUnresolvedReferencesByFiles: typeof getUnresolvedReferencesByFiles;
  clearUnresolvedReferences: typeof clearUnresolvedReferences;
  deleteResolvedReferences: typeof deleteResolvedReferences;
  deleteSpecificResolvedReferences: typeof deleteSpecificResolvedReferences;
  deleteReferencesByRowIds: typeof deleteReferencesByRowIds;
  markReferencesFailed: typeof markReferencesFailed;
  markReferencesFailedByRowIds: typeof markReferencesFailedByRowIds;
  getRetryableFailedReferences: typeof getRetryableFailedReferences;
  getNodeNamesByFiles: typeof getNodeNamesByFiles;
  getNodeAndEdgeCount: typeof getNodeAndEdgeCount;
  getStats: typeof getStats;
  getMetadata: typeof getMetadata;
  setMetadata: typeof setMetadata;
  getAllMetadata: typeof getAllMetadata;
  clear: typeof clear;
}

Object.assign(QueryState.prototype, {
  runBatched,
  rebind,
  setProjectNameTokens,
  getProjectNameTokens,
  insertNode,
  isSegmentableKind,
  insertNameSegments,
  insertNodes,
  storeFileBundle,
  collectNameSegmentRows,
  updateNode,
  deleteNode,
  deleteNodesByFile,
  clearNameSegmentVocab,
  isNameSegmentVocabEmpty,
  getDistinctNodeNames,
  insertNameSegmentsBatch,
  getSegmentCoOccurrence,
  getSegmentNameCounts,
  getNamesForSegment,
  getNodeById,
  getNodesByIds,
  getExistingNodeIds,
  cacheNode,
  clearCache,
  getNodesByFile,
  getDominantFile,
  getTopRouteFile,
  getRoutingManifest,
  getNodesByKind,
  iterateNodesByKind,
  getAllNodes,
  iterateNodesByLanguageWithDecorator,
  getDistinctFileLanguages,
  getNodesByName,
  getNodesByNamePrefix,
  getNodesByQualifiedNameExact,
  getNodesByLowerName,
  searchNodes,
  searchAllByFilters,
  searchNodesFuzzy,
  searchNodesFTS,
  searchNodesLike,
  findNodesByExactName,
  findNodesByNameSubstring,
  insertEdge,
  insertEdges,
  deleteEdgesBySource,
  getOutgoingEdges,
  getIncomingEdges,
  findEdgesBetweenNodes,
  getDependentFilePaths,
  getDependencyFilePaths,
  getCrossFileIncomingEdgesWithTarget,
  upsertFile,
  deleteFile,
  getFileByPath,
  getAllFiles,
  getLastIndexedAt,
  getStaleFiles,
  insertUnresolvedRef,
  insertUnresolvedRefsBatch,
  deleteUnresolvedByNode,
  getUnresolvedByName,
  getUnresolvedReferences,
  getUnresolvedReferencesCount,
  getUnresolvedReferencesBatch,
  getUnresolvedReferencesBatchAfter,
  getAllFilePaths,
  getAllNodeNames,
  iterateNodeNames,
  getUnresolvedReferencesByFiles,
  clearUnresolvedReferences,
  deleteResolvedReferences,
  deleteSpecificResolvedReferences,
  deleteReferencesByRowIds,
  markReferencesFailed,
  markReferencesFailedByRowIds,
  getRetryableFailedReferences,
  getNodeNamesByFiles,
  getNodeAndEdgeCount,
  getStats,
  getMetadata,
  setMetadata,
  getAllMetadata,
  clear,
});
