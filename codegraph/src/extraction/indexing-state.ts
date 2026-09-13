import { QueryBuilder } from '../db/queries';
import type { ExtractionOrchestrator } from './index';
import { indexFile, indexFiles, indexFileWithContent } from './indexing-files';
import { buildDetectionContext, ensureDetectedFrameworks } from './indexing-frameworks';
import { indexAll } from './indexing-full';
import {
  buildFileRecord,
  buildFreshStoreBundle,
  reattachCrossFileEdges,
  storeExtractionResult,
} from './indexing-storage';
import { getChangedFiles, sync } from './indexing-sync';

/** Internal state and method bindings for ExtractionOrchestrator. */
export class ExtractionState {
  readonly rootDir: string;

  queries: QueryBuilder;

  /**
   * Names of frameworks detected for this project, populated by indexAll().
   * Passed to extractFromSource so framework-specific extractors (route nodes,
   * middleware, etc.) run after the tree-sitter pass. Cleared if detection
   * hasn't run yet so single-file re-index paths can detect on the spot.
   */
  detectedFrameworkNames: string[] | null = null;

  constructor(rootDir: string, queries: QueryBuilder, readonly owner: Pick<ExtractionOrchestrator, keyof ExtractionOrchestrator> = this) {
    this.rootDir = rootDir;
    this.queries = queries;
  }
}

export interface ExtractionState {
  buildDetectionContext: typeof buildDetectionContext;
  ensureDetectedFrameworks: typeof ensureDetectedFrameworks;
  indexAll: typeof indexAll;
  indexFiles: typeof indexFiles;
  indexFile: typeof indexFile;
  indexFileWithContent: typeof indexFileWithContent;
  storeExtractionResult: typeof storeExtractionResult;
  buildFileRecord: typeof buildFileRecord;
  buildFreshStoreBundle: typeof buildFreshStoreBundle;
  reattachCrossFileEdges: typeof reattachCrossFileEdges;
  sync: typeof sync;
  getChangedFiles: typeof getChangedFiles;
}

Object.assign(ExtractionState.prototype, {
  buildDetectionContext,
  ensureDetectedFrameworks,
  indexAll,
  indexFiles,
  indexFile,
  indexFileWithContent,
  storeExtractionResult,
  buildFileRecord,
  buildFreshStoreBundle,
  reattachCrossFileEdges,
  sync,
  getChangedFiles,
});
