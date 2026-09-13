import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { logWarn } from '../errors';
import { loadExtensionOverrides } from '../project-config';
import { createYielder } from '../resolution/cooperative-yield';
import {
  ExtractionError,
  ExtractionResult
} from '../types';
import { validatePathWithinRoot } from '../utils';
import {
  detectLanguage,
  isFileLevelOnlyLanguage,
  isLanguageSupported
} from './grammars';
import {
  type IndexResult,
  MAX_FILE_SIZE
} from './indexing-contracts';
import type { ExtractionState } from './indexing-state';
import { extractFromSource } from './tree-sitter';


/**
   * Index specific files
   */
export async function indexFiles(this: ExtractionState, filePaths: string[]): Promise<IndexResult> {
  const startTime = Date.now();
  const errors: ExtractionError[] = [];
  let filesIndexed = 0;
  let filesSkipped = 0;
  let filesErrored = 0;
  let totalNodes = 0;
  let totalEdges = 0;

  for (const filePath of filePaths) {
    const result = await this.owner.indexFile(filePath);

    if (result.errors.length > 0) {
      errors.push(...result.errors);
    }

    if (result.nodes.length > 0) {
      filesIndexed++;
      totalNodes += result.nodes.length;
      totalEdges += result.edges.length;
    } else if (result.errors.some((e) => e.severity === 'error')) {
      filesErrored++;
    } else {
      const tracked = this.queries.getFileByPath(filePath);
      if (tracked && isFileLevelOnlyLanguage(tracked.language)) {
        filesIndexed++;
      } else {
        filesSkipped++;
      }
    }
  }

  return {
    success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
    filesIndexed,
    filesSkipped,
    filesErrored,
    nodesCreated: totalNodes,
    edgesCreated: totalEdges,
    errors,
    durationMs: Date.now() - startTime,
  };
}

/**
   * Index a single file
   */
export async function indexFile(this: ExtractionState, relativePath: string): Promise<ExtractionResult> {
  // Indexing read: follow in-root symlinks (the `../` guard still applies), #935.
  const fullPath = validatePathWithinRoot(this.rootDir, relativePath, { allowSymlinkEscape: true });

  if (!fullPath) {
    return {
      nodes: [],
      edges: [],
      unresolvedReferences: [],
      errors: [{ message: `Path traversal blocked: ${relativePath}`, filePath: relativePath, severity: 'error', code: 'path_traversal' }],
      durationMs: 0,
    };
  }

  // Read file content and stats
  let content: string;
  let stats: fs.Stats;
  try {
    stats = await fsp.stat(fullPath);
    content = await fsp.readFile(fullPath, 'utf-8');
  } catch (error) {
    return {
      nodes: [],
      edges: [],
      unresolvedReferences: [],
      errors: [
        {
          message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
          filePath: relativePath,
          severity: 'error',
          code: 'read_error',
        },
      ],
      durationMs: 0,
    };
  }

  return this.owner.indexFileWithContent(relativePath, content, stats);
}

/**
   * Index a single file with pre-read content and stats.
   * Used by the parallel batch reader to avoid redundant file I/O.
   */
export async function indexFileWithContent(this: ExtractionState, relativePath: string, content: string, stats: fs.Stats): Promise<ExtractionResult> {
  // Prevent `../` traversal; follow in-root symlinks like the directory walk (#935).
  const fullPath = validatePathWithinRoot(this.rootDir, relativePath, { allowSymlinkEscape: true });
  if (!fullPath) {
    logWarn('Path traversal blocked in indexFileWithContent', { relativePath });
    return {
      nodes: [],
      edges: [],
      unresolvedReferences: [],
      errors: [{ message: 'Path traversal blocked', filePath: relativePath, severity: 'error', code: 'path_traversal' }],
      durationMs: 0,
    };
  }

  // Check file size
  if (stats.size > MAX_FILE_SIZE) {
    return {
      nodes: [],
      edges: [],
      unresolvedReferences: [],
      errors: [
        {
          message: `File exceeds max size (${stats.size} > ${MAX_FILE_SIZE})`,
          filePath: relativePath,
          severity: 'warning',
          code: 'size_exceeded',
        },
      ],
      durationMs: 0,
    };
  }

  // Detect language (honoring the project's codegraph.json extension overrides)
  const language = detectLanguage(relativePath, content, loadExtensionOverrides(this.rootDir));
  if (!isLanguageSupported(language)) {
    return {
      nodes: [],
      edges: [],
      unresolvedReferences: [],
      errors: [],
      durationMs: 0,
    };
  }

  // Extract from source. Use cached framework names if indexAll has run,
  // otherwise detect on the spot so single-file re-index paths still emit
  // route nodes / middleware / etc.
  const frameworkNames = this.ensureDetectedFrameworks();
  const result = extractFromSource(relativePath, content, language, frameworkNames);

  // Store in database
  if (result.nodes.length > 0 || result.errors.length === 0) {
    await this.storeExtractionResult(relativePath, content, language, stats, result, createYielder());
  }

  return result;
}
