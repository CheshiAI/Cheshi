import { lstat, readFile } from 'node:fs/promises';
import { decodeText, fileKind, MAX_EDITABLE_FILE_BYTES, requireWorkspaceBuffer } from './workspace-file-metadata.mts';
import { openWorkspaceRoot, resolveWorkspaceTarget, WorkspaceRequestError } from './workspace-file-paths.mts';
import { listWorkspacePaths } from './workspace-file-search.mts';
import { workspaceTextSearchMatchLimit, workspaceTextSearchRequest,
  type WorkspaceTextSearchMatch, type WorkspaceTextSearchResult } from '../shared/workspace-text-search.ts';

const readBatch = 32;
const maxLineLength = 1_000;
// Dependency and build output folders are skipped even when a workspace is not a Git repository.
const skippedDirectories = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.output',
  '.cache', '.turbo', '.venv', 'venv', '__pycache__', 'target']);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileRequest(value: unknown): { pattern: RegExp; limit: number } {
  let request;
  try { request = workspaceTextSearchRequest(value); } catch (error) {
    throw new WorkspaceRequestError(error instanceof Error ? error.message : 'Invalid text search request.', 400);
  }
  try {
    const source = request.regex ? request.query : escapeRegExp(request.query);
    return { pattern: new RegExp(source, request.caseSensitive ? 'g' : 'gi'), limit: request.limit ?? workspaceTextSearchMatchLimit };
  } catch (error) {
    throw new WorkspaceRequestError(`Text search pattern is invalid: ${error instanceof Error ? error.message : String(error)}`, 400);
  }
}

async function readSearchableText(target: string): Promise<string | null> {
  const stats = await lstat(target).catch(() => null);
  if (!stats?.isFile() || stats.size > MAX_EDITABLE_FILE_BYTES) return null;
  const bytes = requireWorkspaceBuffer(await readFile(target));
  if (fileKind(target, stats.size, bytes) !== 'text') return null;
  const decoded = decodeText(bytes);
  return decoded ? decoded.text.replace(/^﻿/, '') : null;
}

function collectMatches(filePath: string, text: string, pattern: RegExp, matches: WorkspaceTextSearchMatch[], limit: number): boolean {
  const lines = text.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    pattern.lastIndex = 0;
    for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
      if (matches.length >= limit) return false;
      matches.push({ path: filePath, line: index + 1, column: match.index + 1, length: Math.max(match[0].length, 1),
        text: line.slice(0, maxLineLength) });
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return true;
}

export async function searchWorkspaceText(projectRoot: string, value: unknown): Promise<WorkspaceTextSearchResult> {
  const { pattern, limit } = compileRequest(value);
  const root = await openWorkspaceRoot(projectRoot);
  const listing = await listWorkspacePaths(root);
  const paths = listing.paths.filter(filePath => !filePath.split('/').some(segment => skippedDirectories.has(segment)));
  const matches: WorkspaceTextSearchMatch[] = [];
  let searchedFiles = 0;
  for (let start = 0; start < paths.length; start += readBatch) {
    const batch = paths.slice(start, start + readBatch);
    const contents = await Promise.all(batch.map(async relativePath => {
      try { return await readSearchableText(await resolveWorkspaceTarget(root, relativePath)); } catch { return null; }
    }));
    for (let index = 0; index < batch.length; index++) {
      const text = contents[index];
      const relativePath = batch[index];
      if (text === null || text === undefined || relativePath === undefined) continue;
      searchedFiles++;
      if (!collectMatches(relativePath, text, pattern, matches, limit)) return { matches, searchedFiles, truncated: true };
    }
  }
  return { matches, searchedFiles, truncated: listing.truncated };
}
