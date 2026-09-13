import { isCodeGraphDataDir } from '../directory';
import { logDebug } from '../errors';
import { loadExtensionOverrides } from '../project-config';
import { normalizePath } from '../utils';
import { isSourceFile } from './grammars';
import { getGitVisibleFiles } from './scan-git';
import { buildDefaultIgnore, loadExcludeMatcher, readGitignorePatterns } from './scan-ignore';
import { collectIncludedFilesForRoot } from './scan-includes';
import * as fs from 'fs';
import ignore from 'ignore';
import { Ignore } from 'ignore';
import * as path from 'path';

/**
 * Recursively scan a directory for source files.
 *
 * In git repos, uses `git ls-files` (inherently respects .gitignore at all
 * levels), then keeps files with a supported source extension. For non-git
 * projects, falls back to a filesystem walk that parses .gitignore itself.
 */
export function scanDirectory(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): string[] {
  // Custom extension → language overrides from the project's codegraph.json.
  const overrides = loadExtensionOverrides(rootDir);

  // Fast path: use git to get all visible files (respects .gitignore everywhere)
  const gitFiles = getGitVisibleFiles(rootDir);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    for (const filePath of gitFiles) {
      if (isSourceFile(filePath, overrides)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
      }
    }
    return files;
  }

  // Fallback: walk filesystem for non-git projects
  return scanDirectoryWalk(rootDir, onProgress);
}

/**
 * Async variant of scanDirectory that yields to the event loop periodically,
 * allowing worker threads to receive and render progress messages.
 */
export async function scanDirectoryAsync(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): Promise<string[]> {
  // Custom extension → language overrides from the project's codegraph.json.
  const overrides = loadExtensionOverrides(rootDir);

  const gitFiles = getGitVisibleFiles(rootDir);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    for (const filePath of gitFiles) {
      if (isSourceFile(filePath, overrides)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
        // Yield every 100 files so worker threads can render progress
        if (count % 100 === 0) {
          await new Promise<void>(r => setImmediate(r));
        }
      }
    }
    return files;
  }

  return scanDirectoryWalk(rootDir, onProgress);
}

/**
 * Filesystem walk fallback for non-git projects.
 */
function scanDirectoryWalk(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): string[] {
  const files: string[] = [];
  let count = 0;
  const visitedDirs = new Set<string>();
  // Custom extension → language overrides from the project's codegraph.json.
  const overrides = loadExtensionOverrides(rootDir);

  // A .gitignore matcher scoped to the directory that declared it. Patterns in
  // a nested .gitignore are relative to that directory, so we keep the dir
  // alongside the matcher and test paths relative to it — mirroring how git
  // applies .gitignore files at every level.
  interface ScopedIgnore {
    dir: string;
    ig: Ignore;
  }

  const loadIgnore = (dir: string): ScopedIgnore | null => {
    const giPath = path.join(dir, '.gitignore');
    if (!fs.existsSync(giPath)) return null;
    // readGitignorePatterns is defensive: a non-UTF-8 (DLP-encrypted) or
    // uncompilable .gitignore is skipped/filtered with a warning, never thrown
    // (issue #682) — so the per-file `.ignores()` calls below can't crash.
    const patterns = readGitignorePatterns(giPath);
    return patterns ? { dir, ig: ignore().add(patterns) } : null;
  };

  const isIgnored = (fullPath: string, isDir: boolean, matchers: ScopedIgnore[]): boolean => {
    for (const { dir, ig } of matchers) {
      let rel = normalizePath(path.relative(dir, fullPath));
      if (!rel || rel.startsWith('..')) continue; // not under this matcher's dir
      if (isDir) rel += '/'; // dir-only rules (e.g. `build/`) only match with the slash
      if (ig.ignores(rel)) return true;
    }
    return false;
  };

  function walk(dir: string, matchers: ScopedIgnore[]): void {
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      logDebug('Skipping unresolvable directory', { dir });
      return;
    }

    if (visitedDirs.has(realDir)) {
      logDebug('Skipping already-visited directory (symlink cycle)', { dir, realDir });
      return;
    }
    visitedDirs.add(realDir);

    // This directory's own .gitignore (if present) applies to everything below it.
    // The root's .gitignore is already merged into the seeded base matcher (so a
    // negation there can override a built-in default), so skip it here.
    const own = dir === rootDir ? null : loadIgnore(dir);
    const active = own ? [...matchers, own] : matchers;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      logDebug('Skipping unreadable directory', { dir, error: String(error) });
      return;
    }

    for (const entry of entries) {
      // Never descend into git internals or any CodeGraph data directory
      // (the active one or a sibling another environment created — #636).
      if (entry.name === '.git' || isCodeGraphDataDir(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = normalizePath(path.relative(rootDir, fullPath));

      if (entry.isSymbolicLink()) {
        try {
          const realTarget = fs.realpathSync(fullPath);
          const stat = fs.statSync(realTarget);
          if (stat.isDirectory()) {
            if (!isIgnored(fullPath, true, active)) {
              walk(fullPath, active);
            }
          } else if (stat.isFile()) {
            if (!isIgnored(fullPath, false, active) && isSourceFile(relativePath, overrides)) {
              files.push(relativePath);
              count++;
              onProgress?.(count, relativePath);
            }
          }
        } catch {
          logDebug('Skipping broken symlink', { path: fullPath });
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (!isIgnored(fullPath, true, active)) {
          walk(fullPath, active);
        }
      } else if (entry.isFile()) {
        if (!isIgnored(fullPath, false, active) && isSourceFile(relativePath, overrides)) {
          files.push(relativePath);
          count++;
          onProgress?.(count, relativePath);
        }
      }
    }
  }

  // Seed a base matcher with the built-in default ignores (merged with the root
  // .gitignore so a negation can override). Nested .gitignores still layer per-dir.
  const baseMatchers: ScopedIgnore[] = [{ dir: rootDir, ig: buildDefaultIgnore(rootDir) }];
  // Project `codegraph.json` `exclude` patterns (#999), rooted at the project so
  // `isIgnored` matches them against root-relative paths — same coverage the
  // git path gets via ScopeIgnore, for non-git projects.
  const exclude = loadExcludeMatcher(rootDir);
  if (exclude) baseMatchers.push({ dir: rootDir, ig: exclude });
  walk(rootDir, baseMatchers);

  // Force-include first-party source whitelisted in `codegraph.json` `include`
  // — the walk above honours `.gitignore`, so anything gitignored was dropped;
  // add it back here (deduped). Mirrors the git path's union.
  const included = collectIncludedFilesForRoot(rootDir);
  if (included.size > 0) {
    const seen = new Set(files);
    for (const f of included) {
      if (!seen.has(f)) {
        files.push(f);
        seen.add(f);
      }
    }
  }
  return files;
}
