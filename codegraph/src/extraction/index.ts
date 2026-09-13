import { QueryBuilder } from '../db/queries';
import { ExtractionState } from './indexing-state';
import {
  ExtractionResult
} from '../types';
import {
  type IndexProgress,
  type IndexResult,
  type SyncResult
} from './indexing-contracts';
import * as fs from 'fs';




export { extractFromSource } from './tree-sitter';

export { detectLanguage, getSupportedLanguages, initGrammars, isGrammarLoaded, isLanguageSupported, isSourceFile, loadAllGrammars, loadGrammarsForLanguages } from './grammars';

export type { IndexProgress } from './indexing-contracts';

export type { IndexResult } from './indexing-contracts';

export type { SyncResult } from './indexing-contracts';

export { hashContent } from './indexing-contracts';

export { buildDefaultIgnore } from './scan-ignore';

export { ScopeIgnore } from './scan-embedded-repos';

export { buildScopeIgnore } from './scan-embedded-repos';

export { discoverEmbeddedRepoRoots } from './scan-embedded-repos';

export { findUnindexedIgnoredRepos } from './scan-embedded-repos';

export { scanDirectory } from './scan-directory';

export { scanDirectoryAsync } from './scan-directory';

/**
 * Extraction orchestrator
 */
export class ExtractionOrchestrator {
  private readonly state: ExtractionState;

  constructor(rootDir: string, queries: QueryBuilder) {
    this.state = new ExtractionState(rootDir, queries, this);
  }



  async indexAll(onProgress?: (progress: IndexProgress) => void, signal?: AbortSignal, verbose?: boolean, walBackpressure?: () => Promise<void> | null, storeWriterOpts?: { dbPath: string; fastInit: boolean } | null): Promise<IndexResult> {
    return this.state.indexAll(onProgress, signal, verbose, walBackpressure, storeWriterOpts);
  }

  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    return this.state.indexFiles(filePaths);
  }

  async indexFile(relativePath: string): Promise<ExtractionResult> {
    return this.state.indexFile(relativePath);
  }

  async indexFileWithContent(relativePath: string, content: string, stats: fs.Stats): Promise<ExtractionResult> {
    return this.state.indexFileWithContent(relativePath, content, stats);
  }

  async sync(onProgress?: (progress: IndexProgress) => void, scopedPaths?: string[]): Promise<SyncResult> {
    return this.state.sync(onProgress, scopedPaths);
  }

  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    return this.state.getChangedFiles();
  }
}
