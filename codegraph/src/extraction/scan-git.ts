import { loadExtensionOverrides } from '../project-config';
import { Language } from '../types';
import { normalizePath } from '../utils';
import { isSourceFile } from './grammars';
import {
  buildScopeIgnore,
  classifyGitDir,
  findIgnoredEmbeddedRepos,
  findNestedGitRepos,
  gitlinkEmbeddedRepoSkipped,
} from './scan-embedded-repos';
import {
  buildDefaultIgnore,
  defaultsOnlyIgnore,
  loadExcludeMatcher,
  loadIncludeIgnoredMatcher,
} from './scan-ignore';
import { collectIncludedFilesForRoot } from './scan-includes';
import { execFileSync } from 'child_process';
import { Ignore } from 'ignore';
import * as path from 'path';

/**
 * Collect git-visible files (tracked + untracked, .gitignore-respected) from the
 * git repository rooted at `repoDir`, adding each to `files` with `prefix`
 * prepended so paths stay relative to the original scan root.
 *
 * Recurses into embedded git repositories — nested repos that are NOT submodules
 * (independent clones living inside the workspace, common in CMake "super-repo"
 * layouts). The parent repo's `git ls-files` cannot see into them: tracked output
 * skips them entirely, and untracked output reports them only as an opaque
 * "subdir/" entry (trailing slash) rather than expanding their files. Each
 * embedded repo is its own git boundary, so we re-run `git ls-files` inside it.
 * (See issue #193.) GITIGNORED embedded repos are invisible even to that; they
 * are discovered separately via `findIgnoredEmbeddedRepos` (#514) but ONLY for
 * directories the project opted in through `codegraph.json` `includeIgnored`
 * (`includeIgnored` here, threaded from the scan root) — by default `.gitignore`
 * is respected and they stay out (#970, #976). Every embedded repo root (however
 * found) is recorded in `embeddedRoots` so callers can exempt its files from the
 * parent's own gitignore rules.
 */
function collectGitFiles(repoDir: string, prefix: string, files: Set<string>, embeddedRoots?: Set<string>, includeIgnored: Ignore | null = null): void {
  const gitOpts = { cwd: repoDir, encoding: 'utf-8' as const, timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true };

  // Tracked files. --recurse-submodules pulls in files from active submodules,
  // which the index would otherwise represent only as a commit pointer.
  // Without this, monorepos using submodules index 0 files. (See issue #147.)
  // Note: --recurse-submodules only supports -c/--cached and --stage modes — it
  // can't be combined with -o, so untracked files are gathered separately below.
  //
  // We use --stage (-s) rather than -c so each entry carries its file mode. That
  // lets us spot gitlink entries (mode 160000) that --recurse-submodules did NOT
  // expand: a nested repo `git add`ed without a `.gitmodules` entry, or a
  // submodule that isn't active/initialized in this checkout. Such a gitlink
  // falls through every pass — it's tracked, so the untracked `-o` listing below
  // never reports it, and --recurse-submodules only expands ACTIVE submodules —
  // so its source would be silently skipped, leaving only the super-repo's own
  // files indexed. We collect those gitlinks here and recurse into them below.
  // (An active submodule is expanded inline by --recurse-submodules and so never
  // surfaces as a 160000 entry — only the unhandled gitlinks do.) (#1031, #1033)
  //
  // -z gives NUL-separated, unquoted output so non-ASCII (e.g. CJK) paths
  // survive verbatim. Without it git octal-escapes and double-quotes such paths
  // (the core.quotepath default), and the quoted form never matches a real file
  // on disk → those files are silently dropped from the index. (#541) With -s the
  // path follows a TAB after the `<mode> <object> <stage>` prefix.
  const gitlinkRels: string[] = [];
  const tracked = execFileSync('git', ['ls-files', '-z', '-s', '--recurse-submodules'], gitOpts);
  for (const entry of tracked.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab === -1) continue; // --stage always emits "<mode> <object> <stage>\t<path>"
    const rel = entry.slice(tab + 1);
    if (entry.slice(0, 6) === '160000') {
      gitlinkRels.push(rel); // an unexpanded gitlink — recursed into below, not a source file itself
      continue;
    }
    files.add(normalizePath(prefix + rel));
  }

  // Untracked files (submodules manage their own untracked state). Embedded git
  // repos surface here as a single "subdir/" entry that git refuses to descend
  // into — recurse into those as their own repos so their source gets indexed.
  const untracked = execFileSync('git', ['ls-files', '-z', '-o', '--exclude-standard'], gitOpts);
  for (const rel of untracked.split('\0')) {
    if (!rel) continue;
    if (rel.endsWith('/')) {
      // git only emits a trailing-slash directory entry for an embedded repo.
      // Guard with a .git check anyway, and skip anything else exactly as git
      // itself skips it (we never descend into a non-repo opaque dir). Never
      // descend into default-ignored locations — an embedded repo inside
      // node_modules is an npm git-dependency, not project code.
      const childDir = path.join(repoDir, rel);
      // A git worktree surfaces here as an opaque untracked dir too — skip it,
      // it's a duplicate working view of an already-indexed repo (#848).
      if (classifyGitDir(childDir) === 'embedded' && !defaultsOnlyIgnore().ignores(rel)) {
        embeddedRoots?.add(normalizePath(prefix + rel));
        collectGitFiles(childDir, prefix + rel, files, embeddedRoots, includeIgnored);
      }
      continue;
    }
    files.add(normalizePath(prefix + rel));
  }

  // Gitlink entries (mode 160000) that --recurse-submodules left unexpanded —
  // an embedded repo `git add`ed without `.gitmodules`, or a submodule not
  // active/initialized in this checkout. When such a gitlink has a real working
  // tree on disk it is distinct first-party code we must index as its own
  // embedded repo: the tracked pass skipped its contents and the untracked pass
  // never sees it (it's tracked, not "other"). A gitlink with no checkout on disk
  // (an uninitialized submodule — empty dir, no `.git`) has nothing to index and
  // is left alone, as is a submodule worktree (a duplicate view, #945). (#1031, #1033)
  if (gitlinkRels.length > 0) {
    const defaults = defaultsOnlyIgnore();
    const repoIgnore = buildDefaultIgnore(repoDir);
    for (const rel of gitlinkRels) {
      const relDir = rel.endsWith('/') ? rel : rel + '/';
      // A gitlink under a gitignored path is respected (not indexed) unless the
      // project opted it in via `includeIgnored` — keep tracked gitlinks under
      // the same scope rule as the untracked-ignored kind below (#1065).
      if (gitlinkEmbeddedRepoSkipped(relDir, prefix, defaults, repoIgnore, includeIgnored)) continue;
      const childDir = path.join(repoDir, rel);
      // 'embedded' = a real .git checkout on disk; 'worktree' and 'none' are skipped.
      if (classifyGitDir(childDir) !== 'embedded') continue;
      embeddedRoots?.add(normalizePath(prefix + relDir));
      collectGitFiles(childDir, prefix + relDir, files, embeddedRoots, includeIgnored);
    }
  }

  // Embedded repos hidden by THIS repo's ignore rules (`/packages/` in a
  // super-repo .gitignore) never appear in any listing above. By default they
  // stay hidden — `.gitignore` is respected (#970, #976). They are recursed into
  // only when the project opted the directory in via `codegraph.json`
  // `includeIgnored` (#622, #699), which `findIgnoredEmbeddedRepos` enforces.
  for (const rel of findIgnoredEmbeddedRepos(repoDir, includeIgnored, prefix)) {
    embeddedRoots?.add(normalizePath(prefix + rel));
    collectGitFiles(path.join(repoDir, rel), prefix + rel, files, embeddedRoots, includeIgnored);
  }
}

/**
 * Get all files visible to git (tracked + untracked but not ignored).
 * Respects .gitignore at all levels (root, subdirectories) and descends into
 * embedded (nested, non-submodule) git repos. Returns null on failure
 * (non-git project) so callers can fall back to a filesystem walk.
 */
export function getGitVisibleFiles(rootDir: string): Set<string> | null {
  try {
    // Check if the project directory is gitignored by a parent repo.
    // When rootDir lives inside a parent git repo that ignores it,
    // `git ls-files` returns nothing — fall back to filesystem walk.
    const gitRoot = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    ).trim();

    if (path.resolve(gitRoot) !== path.resolve(rootDir)) {
      try {
        // git check-ignore exits 0 if the path IS ignored, 1 if not
        execFileSync(
          'git',
          ['check-ignore', '-q', path.resolve(rootDir)],
          { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
        );
        // Directory is gitignored by parent repo — fall back to filesystem walk
        return null;
      } catch {
        // Not ignored — safe to use git ls-files
      }
    }

    const files = new Set<string>();
    const embeddedRoots = new Set<string>();
    collectGitFiles(rootDir, '', files, embeddedRoots, loadIncludeIgnoredMatcher(rootDir));
    // Apply built-in default ignores uniformly — to tracked files too, since
    // committing a dependency/build dir doesn't make it project code. A
    // `.gitignore` negation (e.g. `!vendor/`) is the explicit opt-in. (issue #407)
    // Files inside an EMBEDDED repo are matched against that repo's own rules,
    // not the parent's: the parent's .gitignore hides the child repo from git,
    // not from the index. (#514)
    const ig = buildScopeIgnore(rootDir, embeddedRoots);
    const visible = new Set([...files].filter((f) => !ig.ignores(f)));
    // Force-include first-party source the project whitelisted in
    // `codegraph.json` `include`. These are gitignored, so `git ls-files` never
    // listed them above — discover them directly off disk and add them. (The
    // common SVN+Git dual-VCS case: source committed to SVN, gitignored out of
    // Git, but still wanted in the graph.)
    for (const f of collectIncludedFilesForRoot(rootDir)) visible.add(f);
    return visible;
  } catch {
    return null;
  }
}

/**
 * Result of git-based change detection.
 * Returns null when git is unavailable (non-git project or command failure),
 * signaling the caller to fall back to full filesystem scan.
 */
interface GitChanges {
  modified: string[];  // M, MM, AM — files to re-hash + re-index
  added: string[];     // ?? — new untracked files to index
  deleted: string[];   // D — files to remove from DB
}

/**
 * Use `git status` to detect changed files instead of scanning every file.
 * Returns null on failure so callers fall back to full scan.
 *
 * Recurses into embedded repos — the untracked kind (#193: the parent's status
 * collapses them to an opaque `?? subdir/` entry) always, and the gitignored
 * kind (#514: they never appear in the parent's status at all) only for
 * directories opted in via `codegraph.json` `includeIgnored` (#622, #699) —
 * running `git status` inside each, so changes in a multi-repo workspace sync
 * without a full rescan. By default a gitignored dir is left alone, matching the
 * full-index scan (#970, #976). Deleting an ENTIRE embedded repo dir is the one
 * case this cannot see (the child status that would report the deletions is gone
 * with it); a full `codegraph index` reconciles that.
 */
export function getGitChangedFiles(rootDir: string): GitChanges | null {
  try {
    const changes: GitChanges = { modified: [], added: [], deleted: [] };
    // Custom extension → language overrides from the project's codegraph.json,
    // so change detection sees the same custom-extension files the full index does.
    const overrides = loadExtensionOverrides(rootDir);
    collectGitStatus(rootDir, '', changes, overrides, loadIncludeIgnoredMatcher(rootDir), loadExcludeMatcher(rootDir));
    return changes;
  } catch {
    return null;
  }
}

function collectGitStatus(repoDir: string, prefix: string, out: GitChanges, overrides?: Record<string, Language>, includeIgnored: Ignore | null = null, exclude: Ignore | null = null): void {
  const output = execFileSync(
    'git',
    ['status', '--porcelain', '--no-renames'],
    { cwd: repoDir, encoding: 'utf-8', timeout: 10000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );

  // This repo's own ignore rules — built-in defaults (#407) plus its .gitignore.
  // Change detection must exclude the SAME files the full index does, but git
  // status hides neither: it ignores nothing for *tracked* paths, and the
  // built-in defaults aren't gitignore at all. Without this filter a committed
  // vendor/ dir, or a tracked file under a .gitignored dir, surfaces here as a
  // change — so `codegraph status` (which reads getChangedFiles) reports a
  // pending edit the full index never tracks and `sync` never clears. Matching
  // repo-relative `rel` at each recursion level mirrors getGitVisibleFiles'
  // ScopeIgnore: every embedded repo is judged by ITS OWN rules, never the
  // parent's. (#766)
  const ig = buildDefaultIgnore(repoDir);

  const untrackedDirs: string[] = [];
  for (const line of output.split('\n')) {
    if (line.length < 4) continue; // Minimum: "XY file"

    const statusCode = line.substring(0, 2);
    const rel = normalizePath(line.substring(3));

    // Untracked directory entries (trailing slash) may hide an embedded repo —
    // collect for the recursion below instead of treating as a file.
    if (statusCode === '??' && rel.endsWith('/')) {
      untrackedDirs.push(rel);
      continue;
    }

    const filePath = normalizePath(prefix + rel);
    if (!isSourceFile(filePath, overrides)) continue;

    if (statusCode.includes('D')) {
      // Deletions stay unfiltered: getChangedFiles acts on one only when the
      // path is already tracked in the DB, where removal is always correct — and
      // that lets a newly-excluded dir's stale rows clean themselves up. (#766)
      out.deleted.push(filePath);
      continue;
    }

    // Added (`??`) / modified files inside an excluded dir must not enter the
    // index — match against the repo-relative path, same as the full scan. (#766)
    if (ig.ignores(rel)) continue;
    // User `codegraph.json` `exclude` (#999) is project-root-relative, so it's
    // matched against the full path — sync must not re-add a tracked file the
    // full index now keeps out. Deletions above stay unfiltered so a file that
    // WAS indexed before an exclude was added still cleans itself out.
    if (exclude && exclude.ignores(filePath)) continue;

    if (statusCode === '??') {
      out.added.push(filePath);
    } else {
      // M, MM, AM, A (staged), etc. — treat as modified
      out.modified.push(filePath);
    }
  }

  // Recurse embedded repos found under untracked dirs (at the dir itself or
  // nested deeper). Gitignored dirs are walked only for the directories the
  // project opted in via `includeIgnored`; by default `.gitignore` is respected
  // and they are left alone (#970, #976), mirroring the full-index scan.
  for (const rel of untrackedDirs) {
    for (const repoRel of findNestedGitRepos(path.join(repoDir, rel), rel)) {
      collectGitStatus(path.join(repoDir, repoRel), prefix + repoRel, out, overrides, includeIgnored, exclude);
    }
  }
  for (const rel of findIgnoredEmbeddedRepos(repoDir, includeIgnored, prefix)) {
    collectGitStatus(path.join(repoDir, rel), prefix + rel, out, overrides, includeIgnored, exclude);
  }
}
