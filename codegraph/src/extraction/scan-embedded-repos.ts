import { isCodeGraphDataDir } from '../directory';
import { logDebug } from '../errors';
import { loadIncludePatterns } from '../project-config';
import { normalizePath } from '../utils';
import {
  buildDefaultIgnore,
  defaultsOnlyIgnore,
  loadExcludeMatcher,
  loadIncludeIgnoredMatcher,
  loadIncludeMatcher,
} from './scan-ignore';
import { includeStaticRoots, isWholeCwdEntry } from './scan-includes';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { Ignore } from 'ignore';
import * as path from 'path';

/**
 * List the gitignored DIRECTORIES of a repo (collapsed, trailing-slash form),
 * relative to `repoDir`. These are invisible to every other `git ls-files` /
 * `git status` mode — and in a multi-repo workspace they are exactly where the
 * nested project repos live (a super-repo `.gitignore`s its child repos to keep
 * `git status` quiet; that does not make them third-party code). (#514)
 */
function listIgnoredDirs(repoDir: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory'],
      { cwd: repoDir, encoding: 'utf-8' as const, timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    return out.split('\0').filter((e) => e.endsWith('/') && !isWholeCwdEntry(e));
  } catch {
    return [];
  }
}

/** Max directory depth searched below an ignored dir for nested `.git` roots. */
const EMBEDDED_REPO_SEARCH_DEPTH = 4;

/** Max directories examined per search — a huge ignored data dir must never stall a scan/sync. */
const EMBEDDED_REPO_SEARCH_ENTRIES = 2000;

/**
 * Classify a directory's `.git` entry for embedded-repo discovery.
 *
 * - A `.git` **directory** is an embedded clone — distinct first-party code a
 *   super-repo merely hides from git; index it (#193, #514).
 * - A `.git` **file** is a pointer (`gitdir: …`). A git **worktree** points into
 *   the host repo's own `.git/worktrees/<name>`, so it is a second working view
 *   of a repo CodeGraph already indexes — indexing it just duplicates the whole
 *   graph N times; skip it (#848). A **submodule worktree** points into
 *   `.git/modules/<module>/worktrees/<name>` — same duplication, so skip it too
 *   (#945). A **submodule** checkout points into `.git/modules/<module>` (no
 *   `worktrees/` segment) and is distinct code, so index it as before.
 *
 * Returns `'none'` when there is no `.git` entry here.
 */
export function classifyGitDir(absDir: string): 'embedded' | 'worktree' | 'none' {
  let st: fs.Stats;
  try {
    st = fs.statSync(path.join(absDir, '.git'));
  } catch {
    return 'none';
  }
  if (st.isDirectory()) return 'embedded';
  if (!st.isFile()) return 'none';
  try {
    const gitdir = fs.readFileSync(path.join(absDir, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    // A worktree's gitdir lives under some repo's `.git/worktrees/<name>` —
    // either the top-level repo's (`.git/worktrees/`) or, for a worktree of a
    // submodule, that submodule's gitdir (`.git/modules/<module>/worktrees/`).
    // The optional `modules/<module>` segment covers the submodule case (#945).
    // Match both separators so a Windows-style pointer is recognized too.
    if (gitdir && /(^|[\\/])\.git[\\/](modules[\\/][^\\/]+[\\/])?worktrees[\\/]/.test(gitdir)) return 'worktree';
  } catch {
    // Unreadable `.git` pointer — fall back to the prior "index it" behavior.
  }
  return 'embedded';
}

/**
 * Find git repositories nested under `absDir` (inclusive), shallow bounded BFS.
 * Stops descending at each repo root found — contents belong to that repo's own
 * enumeration. Skips default-ignored dirs (`node_modules` can contain `.git`
 * from npm git-dependencies — that never makes it project code) and CodeGraph
 * data dirs. Depth- and entry-capped so a huge ignored tree can't stall the scan.
 */
export function findNestedGitRepos(absDir: string, relPrefix: string): string[] {
  const found: string[] = [];
  const defaults = defaultsOnlyIgnore();
  const queue: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: absDir, rel: relPrefix, depth: 0 },
  ];
  let examined = 0;
  while (queue.length > 0) {
    const { abs, rel, depth } = queue.shift()!;
    if (++examined > EMBEDDED_REPO_SEARCH_ENTRIES) {
      logDebug('Embedded-repo search entry cap hit — deeper repos (if any) not discovered', { under: relPrefix });
      break;
    }
    const cls = classifyGitDir(abs);
    if (cls === 'worktree') {
      continue; // a git worktree duplicates an already-indexed repo (#848) — skip
    }
    if (cls === 'embedded') {
      found.push(rel);
      continue; // its own git handles everything below
    }
    if (depth >= EMBEDDED_REPO_SEARCH_DEPTH) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || isCodeGraphDataDir(entry.name)) continue;
      const childRel = rel + entry.name + '/';
      if (defaults.ignores(childRel)) continue;
      queue.push({ abs: path.join(abs, entry.name), rel: childRel, depth: depth + 1 });
    }
  }
  return found;
}

/**
 * Workspace-scope ignore matcher. Ordinary paths get the root's matcher
 * (built-in defaults + root `.gitignore`); paths inside an EMBEDDED repo get
 * that repo's own matcher (defaults + its root `.gitignore`) — the parent's
 * `.gitignore` hides a child repo from git, not from the index (#514). A
 * directory path (trailing slash) that is an ANCESTOR of an embedded root is
 * never ignored, so directory-pruning callers (the Linux per-directory
 * watcher) still descend to reach the embedded repos.
 *
 * Single source of truth for indexer and watcher scope — they must not diverge.
 */
export class ScopeIgnore {
  private readonly embedded: Array<{ root: string; matcher: Ignore }>;
  private defaults: Ignore = defaultsOnlyIgnore();
  constructor(
    private rootMatcher: Ignore,
    embedded: Array<{ root: string; matcher: Ignore }>,
    /**
     * Project `codegraph.json` `exclude` patterns (#999), matched against the
     * full root-relative path. Wins over everything else — an explicit user
     * exclude applies even to tracked files and even inside embedded repos.
     */
    private exclude: Ignore | null = null,
    /**
     * Project `codegraph.json` `include` patterns — first-party source forced
     * INTO the index despite `.gitignore`. When a path matches, it is NOT
     * ignored (so the watcher watches it), overriding `.gitignore`/`rootMatcher`
     * — but never `exclude` (checked first) and never a built-in default-ignored
     * dir. `includeRoots` are the static prefixes so a gitignored ANCESTOR
     * directory of an included subtree still isn't pruned by the directory
     * walker/watcher.
     */
    private include: Ignore | null = null,
    private includeRoots: string[] = [],
  ) {
    // Longest root first so paths in nested embedded repos hit the innermost matcher.
    this.embedded = [...embedded].sort((a, b) => b.root.length - a.root.length);
  }

  ignores(rel: string): boolean {
    // User `exclude` (#999) is checked first and against the full root-relative
    // path: it must drop git-TRACKED paths (which `.gitignore` can't) and apply
    // everywhere, including ancestors of embedded repos.
    if (this.exclude && this.exclude.ignores(rel)) return true;
    // User `include`: force first-party source in despite `.gitignore`. Never
    // resurfaces a built-in default-ignored dir (node_modules/dist/…), so an
    // include pattern can't accidentally pull in dependency/build trees.
    if (this.include && !this.defaults.ignores(rel)) {
      if (rel.endsWith('/')) {
        // A directory on (or leading to) an included subtree must stay walkable
        // so the watcher/walker descends to reach the forced-in files.
        if (this.includeRoots.some((r) => r.startsWith(rel) || rel.startsWith(r))) return false;
      } else if (this.include.ignores(rel)) {
        return false;
      }
    }
    for (const { root, matcher } of this.embedded) {
      if (rel.startsWith(root)) {
        const inner = rel.slice(root.length);
        if (inner === '') return false;
        // Built-in defaults apply to the FULL path uniformly (#407) — an
        // embedded repo inside node_modules (an npm git-dependency) must stay
        // excluded even though its own rules wouldn't ignore its files.
        return this.defaults.ignores(rel) || matcher.ignores(inner);
      }
    }
    // Never prune a directory that leads to an embedded repo.
    if (rel.endsWith('/') && this.embedded.some(({ root }) => root.startsWith(rel))) {
      return false;
    }
    return this.rootMatcher.ignores(rel);
  }
}

/**
 * Build the workspace-scope matcher. When the caller already knows the
 * embedded roots (the scanner discovers them during collection), pass them to
 * skip rediscovery; otherwise they're discovered here (the watcher path).
 */
export function buildScopeIgnore(rootDir: string, embeddedRoots?: Iterable<string>): ScopeIgnore {
  const roots = embeddedRoots ? [...embeddedRoots] : discoverEmbeddedRepoRoots(rootDir);
  const include = loadIncludeMatcher(rootDir);
  return new ScopeIgnore(
    buildDefaultIgnore(rootDir),
    roots.map((root) => ({ root, matcher: buildDefaultIgnore(path.join(rootDir, root)) })),
    loadExcludeMatcher(rootDir),
    include,
    include ? includeStaticRoots(loadIncludePatterns(rootDir)) : [],
  );
}

/**
 * Whether an embedded repo found as a tracked gitlink (mode 160000, #1031/#1033)
 * must be SKIPPED rather than indexed. A gitlink is tracked, so `.gitignore`
 * can't untrack it — but the discovery passes for it must still honor the same
 * scope rules as every other path, or a gitignored reference/data dir full of
 * `git add`ed clones gets pulled into the index against the user's stated intent
 * (#1065). Two reasons to skip:
 *   1. It sits in a built-in default-ignored location — an npm git-dependency
 *      under `node_modules` is never project code; not even an explicit opt-in
 *      revives it (matches `findIgnoredEmbeddedRepos`).
 *   2. The parent repo's own `.gitignore` covers its path and the project did
 *      NOT opt that path in via `codegraph.json` `includeIgnored`. The gitignore
 *      rule is the user's stated intent to keep that path out of scope, exactly
 *      as for an UNtracked embedded repo — respect it by default, opt back in
 *      with `includeIgnored` (#514, #970, #976).
 * `relDir` is repoDir-relative (trailing-slashed); `prefix` is repoDir's
 * scan-root-relative path so the `includeIgnored` pattern is matched on the full
 * scan-root-relative path. `defaults` is `defaultsOnlyIgnore()` and `repoIgnore`
 * is `buildDefaultIgnore(repoDir)` (defaults + the repo's own `.gitignore`),
 * both passed in so they're built once per repo level rather than per gitlink.
 */
export function gitlinkEmbeddedRepoSkipped(
  relDir: string,
  prefix: string,
  defaults: Ignore,
  repoIgnore: Ignore,
  includeIgnored: Ignore | null,
): boolean {
  if (defaults.ignores(relDir)) return true;        // default-ignored — never index, opt-in can't revive
  if (!repoIgnore.ignores(relDir)) return false;    // not ignored at all — index as before (#1031/#1033)
  // Gitignored by the repo's own rules — skip unless the project opted it in.
  return !includeIgnored?.ignores(normalizePath(prefix + relDir));
}

/**
 * Standalone discovery of every embedded repo root under `rootDir` (relative,
 * trailing-slashed) — the untracked kind (#193) always, and the gitignored kind
 * (#514) only for directories the project opted in via `codegraph.json`
 * `includeIgnored` (#622, #699); otherwise `.gitignore` is respected and they
 * are not discovered (#970, #976). Recursive (an embedded repo can embed further
 * repos). Returns [] for non-git roots: the filesystem walk handles nested repos
 * there already.
 */
export function discoverEmbeddedRepoRoots(rootDir: string): string[] {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  const defaults = defaultsOnlyIgnore();
  const includeIgnored = loadIncludeIgnoredMatcher(rootDir);
  const visit = (repoAbs: string, prefix: string): void => {
    const candidates: string[] = [];
    try {
      const o = execFileSync(
        'git',
        ['ls-files', '-z', '-o', '--exclude-standard', '--directory'],
        { cwd: repoAbs, encoding: 'utf-8', timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
      for (const e of o.split('\0')) {
        if (e.endsWith('/') && !isWholeCwdEntry(e) && !defaults.ignores(e)) {
          candidates.push(...findNestedGitRepos(path.join(repoAbs, e), e));
        }
      }
    } catch { /* untracked listing failed — ignored-side discovery still runs */ }
    // Unexpanded gitlinks (mode 160000) with a real checkout on disk — embedded
    // repos `git add`ed without `.gitmodules`, or submodules not active here. The
    // untracked listing above can't see them (they're tracked), so find them the
    // same way collectGitFiles does, keeping watcher scope == indexer scope.
    // (#1031, #1033)
    try {
      const staged = execFileSync(
        'git',
        ['ls-files', '-z', '-s', '--recurse-submodules'],
        { cwd: repoAbs, encoding: 'utf-8', timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
      const repoIgnore = buildDefaultIgnore(repoAbs);
      for (const entry of staged.split('\0')) {
        if (!entry || entry.slice(0, 6) !== '160000') continue;
        const tab = entry.indexOf('\t');
        if (tab === -1) continue;
        const rel = entry.slice(tab + 1);
        const relDir = rel.endsWith('/') ? rel : rel + '/';
        // A gitlink under a gitignored path is respected (not indexed) unless the
        // project opted it in — same rule as the untracked-ignored kind (#1065).
        if (gitlinkEmbeddedRepoSkipped(relDir, prefix, defaults, repoIgnore, includeIgnored)) continue;
        if (classifyGitDir(path.join(repoAbs, rel)) === 'embedded') candidates.push(relDir);
      }
    } catch { /* staged listing failed — other discovery still runs */ }
    candidates.push(...findIgnoredEmbeddedRepos(repoAbs, includeIgnored, prefix));
    for (const rel of candidates) {
      const full = normalizePath(prefix + rel);
      out.push(full);
      visit(path.join(repoAbs, rel), full);
    }
  };
  visit(rootDir, '');
  return out;
}

/**
 * Cap on how many skipped gitignored repos the CLI hint enumerates — a huge
 * gitignored data dir full of clones must never turn the hint scan into a long
 * walk. Enough to make the point; the caller says "+N more" past this.
 */
const UNINDEXED_IGNORED_REPO_HINT_CAP = 100;

/**
 * The INVERSE of the gitignored side of {@link discoverEmbeddedRepoRoots}:
 * nested git repositories under a gitignored directory that the project has NOT
 * opted into via `codegraph.json` `includeIgnored`. These are real repos the
 * default `init`/`index` deliberately skips because `.gitignore` excludes them
 * (#970, #976) — most visibly the "super-repo `.gitignore`s its child repos"
 * layout (#1156), where `init` at the parent correctly indexes ~nothing while
 * `init` inside each child works. The CLI uses this to turn that silent empty
 * index into an actionable hint: it names the skipped repos and offers to opt
 * them in. Paths are `rootDir`-relative and trailing-slashed (valid
 * `includeIgnored` patterns as-is). Returns `[]` for a non-git root (a
 * filesystem walk already descends into nested repos there), skips built-in
 * default-ignored dirs (`node_modules`, …), and is bounded so it never stalls
 * on a giant ignored tree.
 */
export function findUnindexedIgnoredRepos(rootDir: string): string[] {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch {
    return [];
  }
  const defaults = defaultsOnlyIgnore();
  const includeIgnored = loadIncludeIgnoredMatcher(rootDir);
  const repos: string[] = [];
  for (const dir of listIgnoredDirs(rootDir)) {
    if (defaults.ignores(dir)) continue; // node_modules etc. — never project code
    if (includeIgnored?.ignores(normalizePath(dir))) continue; // already opted in — nothing to nag about
    for (const repo of findNestedGitRepos(path.join(rootDir, dir), dir)) {
      // Per-repo opt-in check, mirroring findIgnoredEmbeddedRepos: a child
      // pattern (`repos/a/`) doesn't match the parent dir above but DOES
      // cover this repo — it's indexed, so don't nag about it (#1295).
      if (includeIgnored?.ignores(normalizePath(repo))) continue;
      repos.push(repo);
      if (repos.length >= UNINDEXED_IGNORED_REPO_HINT_CAP) return repos;
    }
  }
  return repos;
}

/**
 * Discover embedded repos hidden by `repoDir`'s OWN gitignore rules: for each
 * gitignored directory, search for nested `.git` roots. Returns repo paths
 * relative to `repoDir`, trailing-slashed.
 *
 * OPT-IN ONLY. Walking into a gitignored directory contradicts what every other
 * tool (and CodeGraph's own `git ls-files` foundation) does — `.gitignore`
 * excludes. So this returns `[]` unless the project opted the directory in via
 * `codegraph.json` `includeIgnored`; without that, a gitignored dir — including
 * a huge reference/data dir full of nested clones — is left untouched (#970,
 * #976). When opted in, it restores the super-repo-of-clones behavior (#622,
 * #699). `prefix` is the scan-root-relative path of `repoDir`, so a pattern like
 * `services/` opts that whole subtree in at any recursion depth. Built-in
 * default excludes (`node_modules`, …) are always skipped.
 */
export function findIgnoredEmbeddedRepos(repoDir: string, includeIgnored: Ignore | null, prefix: string): string[] {
  if (!includeIgnored) return [];
  const defaults = defaultsOnlyIgnore();
  const repos: string[] = [];
  for (const dir of listIgnoredDirs(repoDir)) {
    if (defaults.ignores(dir)) continue;
    const nested = findNestedGitRepos(path.join(repoDir, dir), dir);
    if (includeIgnored.ignores(normalizePath(prefix + dir))) {
      // The whole ignored dir is opted in — every nested repo under it counts.
      repos.push(...nested);
    } else {
      // A single gitignore rule often covers the PARENT of the opted-in
      // repos: `.gitignore: /repos/` lists `repos/` as ONE ignored entry,
      // while `includeIgnored: ["repos/a/"]` (the CLI hint's own suggested
      // spelling) names the child — which never matches the parent path, so
      // the opt-in silently did nothing (#1295). Match each nested repo
      // root individually so both spellings work. The walk is bounded
      // (depth/entry caps in findNestedGitRepos) and only runs when
      // includeIgnored is configured at all.
      repos.push(...nested.filter((r) => includeIgnored.ignores(normalizePath(prefix + r))));
    }
  }
  return repos;
}
