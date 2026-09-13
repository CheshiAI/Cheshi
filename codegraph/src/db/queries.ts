import { QueryState } from './query-state';
import {
  Edge,
  EdgeKind,
  FileRecord,
  GraphStats,
  Language,
  Node,
  NodeKind,
  SearchOptions,
  SearchResult,
  UnresolvedReference,
} from '../types';
import type { SqliteDatabase } from './sqlite-adapter';

/**
 * Query builder for the knowledge graph database
 */
export class QueryBuilder {
  private readonly state: QueryState;

  constructor(db: SqliteDatabase) {
    this.state = new QueryState(db, this);
  }

  rebind(db: SqliteDatabase): void {
    return this.state.rebind(db);
  }

  setProjectNameTokens(tokens: Set<string>): void {
    return this.state.setProjectNameTokens(tokens);
  }

  getProjectNameTokens(): Set<string> {
    return this.state.getProjectNameTokens();
  }

  insertNode(node: Node): void {
    return this.state.insertNode(node);
  }

  insertNodes(nodes: Node[]): void {
    return this.state.insertNodes(nodes);
  }

  storeFileBundle(bundle: {
    nodes: Node[];
    edges: Edge[];
    refs: UnresolvedReference[];
    file: FileRecord;
  }): void {
    return this.state.storeFileBundle(bundle);
  }

  updateNode(node: Node): void {
    return this.state.updateNode(node);
  }

  deleteNode(id: string): void {
    return this.state.deleteNode(id);
  }

  deleteNodesByFile(filePath: string): void {
    return this.state.deleteNodesByFile(filePath);
  }

  clearNameSegmentVocab(): void {
    return this.state.clearNameSegmentVocab();
  }

  isNameSegmentVocabEmpty(): boolean {
    return this.state.isNameSegmentVocabEmpty();
  }

  getDistinctNodeNames(limit: number, offset: number): string[] {
    return this.state.getDistinctNodeNames(limit, offset);
  }

  insertNameSegmentsBatch(names: string[]): void {
    return this.state.insertNameSegmentsBatch(names);
  }

  getSegmentCoOccurrence(variants: Array<{ segment: string; word: string }>, minWords: number, limit: number): Array<{ name: string; matches: number }> {
    return this.state.getSegmentCoOccurrence(variants, minWords, limit);
  }

  getSegmentNameCounts(segments: string[]): Map<string, number> {
    return this.state.getSegmentNameCounts(segments);
  }

  getNamesForSegment(segment: string, limit: number): string[] {
    return this.state.getNamesForSegment(segment, limit);
  }

  getNodeById(id: string): Node | null {
    return this.state.getNodeById(id);
  }

  getNodesByIds(ids: readonly string[]): Map<string, Node> {
    return this.state.getNodesByIds(ids);
  }

  clearCache(): void {
    return this.state.clearCache();
  }

  getNodesByFile(filePath: string): Node[] {
    return this.state.getNodesByFile(filePath);
  }

  getDominantFile(): { filePath: string; edgeCount: number; nextEdgeCount: number } | null {
    return this.state.getDominantFile();
  }

  getTopRouteFile(): { filePath: string; routeCount: number; totalRoutes: number } | null {
    return this.state.getTopRouteFile();
  }

  getRoutingManifest(limit: number = 40): {
    entries: Array<{ url: string; handler: string; handlerFile: string; handlerLine: number; handlerKind: string }>;
    topHandlerFile: string | null;
    topHandlerFileCount: number;
    totalRoutes: number;
  } | null {
    return this.state.getRoutingManifest(limit);
  }

  getNodesByKind(kind: NodeKind): Node[] {
    return this.state.getNodesByKind(kind);
  }

  iterateNodesByKind(kind: NodeKind): IterableIterator<Node> {
    return this.state.iterateNodesByKind(kind);
  }

  getAllNodes(): Node[] {
    return this.state.getAllNodes();
  }

  iterateNodesByLanguageWithDecorator(language: Language, decorator: string): IterableIterator<Node> {
    return this.state.iterateNodesByLanguageWithDecorator(language, decorator);
  }

  getDistinctFileLanguages(): Set<string> {
    return this.state.getDistinctFileLanguages();
  }

  getNodesByName(name: string): Node[] {
    return this.state.getNodesByName(name);
  }

  getNodesByNamePrefix(prefix: string, limit = 20): Node[] {
    return this.state.getNodesByNamePrefix(prefix, limit);
  }

  getNodesByQualifiedNameExact(qualifiedName: string): Node[] {
    return this.state.getNodesByQualifiedNameExact(qualifiedName);
  }

  getNodesByLowerName(lowerName: string): Node[] {
    return this.state.getNodesByLowerName(lowerName);
  }

  searchNodes(query: string, options: SearchOptions = {}): SearchResult[] {
    return this.state.searchNodes(query, options);
  }

  findNodesByExactName(names: string[], options: SearchOptions = {}): SearchResult[] {
    return this.state.findNodesByExactName(names, options);
  }

  findNodesByNameSubstring(substring: string, options: SearchOptions & { excludePrefix?: boolean } = {}): SearchResult[] {
    return this.state.findNodesByNameSubstring(substring, options);
  }

  insertEdge(edge: Edge): void {
    return this.state.insertEdge(edge);
  }

  insertEdges(edges: Edge[]): void {
    return this.state.insertEdges(edges);
  }

  deleteEdgesBySource(sourceId: string): void {
    return this.state.deleteEdgesBySource(sourceId);
  }

  getOutgoingEdges(sourceId: string, kinds?: EdgeKind[], provenance?: string): Edge[] {
    return this.state.getOutgoingEdges(sourceId, kinds, provenance);
  }

  getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Edge[] {
    return this.state.getIncomingEdges(targetId, kinds);
  }

  findEdgesBetweenNodes(nodeIds: string[], kinds?: EdgeKind[]): Edge[] {
    return this.state.findEdgesBetweenNodes(nodeIds, kinds);
  }

  getDependentFilePaths(filePath: string): string[] {
    return this.state.getDependentFilePaths(filePath);
  }

  getDependencyFilePaths(filePath: string): string[] {
    return this.state.getDependencyFilePaths(filePath);
  }

  getCrossFileIncomingEdgesWithTarget(filePath: string): Array<Edge & { targetName: string; targetKind: NodeKind; sourceFilePath: string; sourceLanguage: Language }> {
    return this.state.getCrossFileIncomingEdgesWithTarget(filePath);
  }

  upsertFile(file: FileRecord): void {
    return this.state.upsertFile(file);
  }

  deleteFile(filePath: string): void {
    return this.state.deleteFile(filePath);
  }

  getFileByPath(filePath: string): FileRecord | null {
    return this.state.getFileByPath(filePath);
  }

  getAllFiles(): FileRecord[] {
    return this.state.getAllFiles();
  }

  getLastIndexedAt(): number | null {
    return this.state.getLastIndexedAt();
  }

  getStaleFiles(currentHashes: Map<string, string>): FileRecord[] {
    return this.state.getStaleFiles(currentHashes);
  }

  insertUnresolvedRef(ref: UnresolvedReference): void {
    return this.state.insertUnresolvedRef(ref);
  }

  insertUnresolvedRefsBatch(refs: UnresolvedReference[]): void {
    return this.state.insertUnresolvedRefsBatch(refs);
  }

  deleteUnresolvedByNode(nodeId: string): void {
    return this.state.deleteUnresolvedByNode(nodeId);
  }

  getUnresolvedByName(name: string): UnresolvedReference[] {
    return this.state.getUnresolvedByName(name);
  }

  getUnresolvedReferences(): UnresolvedReference[] {
    return this.state.getUnresolvedReferences();
  }

  getUnresolvedReferencesCount(): number {
    return this.state.getUnresolvedReferencesCount();
  }

  getUnresolvedReferencesBatch(offset: number, limit: number): UnresolvedReference[] {
    return this.state.getUnresolvedReferencesBatch(offset, limit);
  }

  getUnresolvedReferencesBatchAfter(afterRowId: number, limit: number): UnresolvedReference[] {
    return this.state.getUnresolvedReferencesBatchAfter(afterRowId, limit);
  }

  getAllFilePaths(): string[] {
    return this.state.getAllFilePaths();
  }

  getAllNodeNames(): string[] {
    return this.state.getAllNodeNames();
  }

  iterateNodeNames(): IterableIterator<string> {
    return this.state.iterateNodeNames();
  }

  getUnresolvedReferencesByFiles(filePaths: string[]): UnresolvedReference[] {
    return this.state.getUnresolvedReferencesByFiles(filePaths);
  }

  clearUnresolvedReferences(): void {
    return this.state.clearUnresolvedReferences();
  }

  deleteResolvedReferences(fromNodeIds: string[]): void {
    return this.state.deleteResolvedReferences(fromNodeIds);
  }

  deleteSpecificResolvedReferences(refs: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>): number {
    return this.state.deleteSpecificResolvedReferences(refs);
  }

  deleteReferencesByRowIds(rowIds: number[]): number {
    return this.state.deleteReferencesByRowIds(rowIds);
  }

  markReferencesFailed(refs: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>): number {
    return this.state.markReferencesFailed(refs);
  }

  markReferencesFailedByRowIds(refs: Array<{ rowId: number; referenceName: string }>): number {
    return this.state.markReferencesFailedByRowIds(refs);
  }

  getRetryableFailedReferences(names: string[], perNameCeiling: number = 500): UnresolvedReference[] {
    return this.state.getRetryableFailedReferences(names, perNameCeiling);
  }

  getNodeNamesByFiles(filePaths: string[]): string[] {
    return this.state.getNodeNamesByFiles(filePaths);
  }

  getNodeAndEdgeCount(): { nodes: number; edges: number } {
    return this.state.getNodeAndEdgeCount();
  }

  getStats(): GraphStats {
    return this.state.getStats();
  }

  getMetadata(key: string): string | null {
    return this.state.getMetadata(key);
  }

  setMetadata(key: string, value: string): void {
    return this.state.setMetadata(key, value);
  }

  getAllMetadata(): Record<string, string> {
    return this.state.getAllMetadata();
  }

  clear(): void {
    return this.state.clear();
  }
}
