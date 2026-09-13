import { isCodeGraphDataDir } from '../directory';
import { loadExtensionOverrides, loadIncludePatterns } from '../project-config';
import { Language } from '../types';
import { normalizePath } from '../utils';
import { isSourceFile } from './grammars';
import { defaultsOnlyIgnore, GLOB_META, loadExcludeMatcher, loadIncludeMatcher } from './scan-ignore';
import * as fs from 'fs';
import { Ignore } from 'ignore';
import * as path from 'path';

/**
 * The static directory prefix of each `include` pattern — the literal leading
 * path up to the first glob segment — trailing-slashed, used to (a) walk only
 * the opted-in subtrees in `collectIncludedFiles` and (b) let `ScopeIgnore` keep
 * the watcher descending toward them. `Tools/` stays `Tools/`; a recursive
 * `Tools/**` glob yields `Tools/`; `src/local/file.ts` yields `src/local/` (the
 * file's dir); a pattern that starts with a glob (like a leading `**`) yields
 * `''`, meaning "no static root — walk the whole tree". Duplicates and roots
 * nested under a broader root are collapsed so each subtree is walked once.
 */
export function includeStaticRoots(patterns: string[]): string[] {
  const roots = new Set<string>();
  for (const pattern of patterns) {
    let p = pattern.replace(/^\/+/, '');
    const trailingSlash = p.endsWith('/');
    if (trailingSlash) p = p.slice(0, -1);
    const segs = p.split('/').filter(Boolean);
    const lead: string[] = [];
    for (const s of segs) {
      if (GLOB_META.test(s)) break;
      lead.push(s);
    }
    const hadWildcard = lead.length < segs.length;
    // A wholly-literal pattern with no trailing slash names a file (or a dir we
    // can't tell apart) — drop its last segment so we walk the containing dir
    // and let the matcher pick the file. A trailing slash or a glob means the
    // remaining `lead` is already the directory to walk.
    if (!hadWildcard && !trailingSlash && lead.length > 0) lead.pop();
    if (lead.length === 0) {
      roots.clear();
      roots.add('');
      return ['']; // a top-level glob forces a whole-tree walk; nothing narrower matters
    }
    roots.add(lead.join('/') + '/');
  }
  // Collapse roots nested under a broader one (e.g. drop `a/b/` if `a/` is present).
  const all = [...roots];
  return all.filter((r) => !all.some((other) => other !== r && r.startsWith(other)));
}

/**
 * Actively discover the source files an `include` whitelist forces in. `git
 * ls-files` never lists gitignored files, so a filtered filesystem walk of just
 * the opted-in subtrees (`includeStaticRoots`) is the only way to find them.
 * Returns project-root-relative, normalized source-file paths.
 *
 * A file is collected when it MATCHES `include`, is NOT hit by `exclude` (an
 * explicit exclude always wins), is a recognized source file, and does not live
 * under a built-in default-ignored dir (`node_modules`, `dist`, …), `.git`, or
 * CodeGraph's data dir — those are never resurfaced, mirroring `ScopeIgnore`.
 * `.gitignore` is deliberately NOT consulted: overriding it is the whole point.
 */
function collectIncludedFiles(
  rootDir: string,
  include: Ignore,
  exclude: Ignore | null,
  roots: string[],
  overrides: Record<string, Language>,
): Set<string> {
  const out = new Set<string>();
  const defaults = defaultsOnlyIgnore();
  const visited = new Set<string>();

  const consider = (abs: string, rel: string, isDir: boolean): void => {
    if (isDir) {
      if (defaults.ignores(rel + '/')) return; // never node_modules/dist/… via include
      // An explicit `exclude` always wins over `include`; prune the whole subtree
      // here so a large excluded dir (a committed frontend's own vendored deps,
      // build output, …) is never walked — the per-file guard below still catches
      // anything a directory pattern doesn't, so this is a pure efficiency win.
      if (exclude && exclude.ignores(rel + '/')) return;
      walk(abs);
    } else {
      if (defaults.ignores(rel)) return;
      if (!include.ignores(rel)) return;
      if (exclude && exclude.ignores(rel)) return;
      if (!isSourceFile(rel, overrides)) return;
      out.add(rel);
    }
  };

  function walk(absDir: string): void {
    let realDir: string;
    try {
      realDir = fs.realpathSync(absDir);
    } catch {
      return;
    }
    if (visited.has(realDir)) return; // symlink-cycle guard
    visited.add(realDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || isCodeGraphDataDir(entry.name)) continue;
      const abs = path.join(absDir, entry.name);
      const rel = normalizePath(path.relative(rootDir, abs));
      if (!rel || rel.startsWith('..')) continue;
      if (entry.isSymbolicLink()) {
        try {
          const st = fs.statSync(fs.realpathSync(abs));
          consider(abs, rel, st.isDirectory());
        } catch {
          // broken symlink — skip
        }
        continue;
      }
      consider(abs, rel, entry.isDirectory());
    }
  }

  for (const root of roots) {
    walk(root === '' ? rootDir : path.join(rootDir, root));
  }
  return out;
}

/**
 * The included source files (`codegraph.json` `include`) for a scan root, or an
 * empty set when nothing is force-included. Centralizes loading the matcher,
 * roots, exclude, and overrides so both enumeration paths (git and filesystem
 * walk) add the same files.
 */
export function collectIncludedFilesForRoot(rootDir: string): Set<string> {
  const include = loadIncludeMatcher(rootDir);
  if (!include) return new Set();
  const roots = includeStaticRoots(loadIncludePatterns(rootDir));
  return collectIncludedFiles(rootDir, include, loadExcludeMatcher(rootDir), roots, loadExtensionOverrides(rootDir));
}

/**
 * `git ls-files --directory` collapses a wholly-untracked/ignored directory into
 * one entry — and when the command's own cwd is such a directory (the indexed
 * root is itself a git-ignored subdir of an enclosing repo), git emits the
 * literal `./` meaning "this entire directory". That sentinel is not a real
 * nested path: feeding it to the `ignore` matcher throws ("path should be a
 * `path.relative()`d string, but got "./""), which used to abort `buildScopeIgnore`
 * and so break the MCP daemon's watcher/auto-sync on connect; and joining it back
 * onto `repoDir` would just re-point at the cwd. Drop it wherever we consume
 * `--directory` output. (#936)
 */
export function isWholeCwdEntry(entry: string): boolean {
  return entry === './' || entry === '.' || entry === '';
}
