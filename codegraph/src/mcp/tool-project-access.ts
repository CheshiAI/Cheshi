import { existsSync } from 'fs';
import { findNearestCodeGraphRoot } from '../directory';
import type CodeGraph from '../index';
import {
  detectWorktreeIndexMismatch,
  type WorktreeIndexMismatch,
  worktreeMismatchNotice
} from '../sync/worktree';
import {
  validateProjectPath
} from '../utils';
import type { QueryPool } from './query-pool';
import {
  type ToolResult
} from './tool-definitions';
import type { ToolHandlerState } from './tool-handler-state';
import { loadCodeGraph, NotIndexedError, PathRefusalError } from './tool-project-loading';

/**
   * Engine-only: attach (or detach with null) the worker-thread query pool. The
   * shared daemon sets this once its default project is open; the workers each
   * hold their own WAL read connection and run {@link executeReadTool}. A
   * worker's own ToolHandler never has a pool, so there is no nested off-loading.
   */
export function setQueryPool(this: ToolHandlerState, pool: QueryPool | null): void {
  this.queryPool = pool;
}

/**
   * Update the default CodeGraph instance (e.g. after lazy initialization)
   */
export function setDefaultCodeGraph(this: ToolHandlerState, cg: CodeGraph): void {
  this.cg = cg;
}

/**
   * Engine-only: register the catch-up sync promise so the next `execute()`
   * call awaits it before serving. The handler swallows rejections (the
   * engine logs them) so a sync failure never propagates as a tool error;
   * we still want to serve a best-effort result over the same potentially-
   * stale data, which is what would have happened without the gate.
   */
export function setCatchUpGate(this: ToolHandlerState, p: Promise<void> | null): void {
  this.catchUpGate = p;
}

/**
   * Record the directory the server tried to resolve the default project from.
   * Used only to make the "no default project" error actionable.
   */
export function setDefaultProjectHint(this: ToolHandlerState, searchedPath: string): void {
  this.defaultProjectHint = searchedPath;
}

/**
   * Whether a default CodeGraph instance is available
   */
export function hasDefaultCodeGraph(this: ToolHandlerState): boolean {
  return this.cg !== null;
}

/**
   * Get CodeGraph instance for a project
   *
   * If projectPath is provided, opens that project's CodeGraph (cached).
   * Otherwise returns the default CodeGraph instance.
   *
   * Walks up parent directories to find the nearest .codegraph/ folder,
   * similar to how git finds .git/ directories.
   */
export function getCodeGraph(this: ToolHandlerState, projectPath?: string): CodeGraph {
  if (!projectPath) {
    if (!this.cg) {
      const searched = this.defaultProjectHint ?? process.cwd();
      throw new NotIndexedError(
        'No CodeGraph project is loaded for this session.\n' +
        `Searched for a .codegraph/ directory starting from: ${searched}\n` +
        'Either the server root has no index of its own (e.g. a monorepo where only ' +
        "sub-projects are indexed), or the MCP client launched the server outside your " +
        'project without reporting the workspace root. Either way, target the project ' +
        'explicitly:\n' +
        '  • Pass projectPath to the tool call, e.g. projectPath: "/absolute/path/to/your/project" ' +
        '(any project that has a .codegraph/ — including a sub-project of a monorepo)\n' +
        '  • Or add --path to the server\'s MCP config args: ["serve", "--mcp", "--path", "/absolute/path/to/your/project"]\n' +
        'If a project simply has no index, use your built-in tools (Read/Grep/Glob) for THAT ' +
        "project (the user can run 'codegraph init' there to enable it) — you can still query " +
        'other indexed projects by projectPath in the same session.'
      );
    }
    return this.freshen(this.cg);
  }

  // Reject sensitive system directories before opening. Only validate a
  // path that actually exists — a nested or not-yet-created sub-path of a
  // real project must still be allowed to resolve UP to its .codegraph/
  // root below (issue #238), so we don't run the existence-checking
  // validator on paths that are meant to walk up.
  if (existsSync(projectPath)) {
    const pathError = validateProjectPath(projectPath);
    if (pathError) {
      throw new PathRefusalError(pathError);
    }
  }

  // Always RE-RESOLVE the nearest .codegraph/ from the input path. The walk
  // is cheap (a few existsSync up the tree) and is the only thing that
  // notices a path whose index root CHANGED since it was first seen — most
  // importantly a git worktree that gained its own .codegraph/ after the
  // (long-lived) server first resolved it up to the parent checkout. We used
  // to short-circuit on a `projectCache[projectPath]` entry before resolving,
  // which pinned that first resolution for the server's whole lifetime, so a
  // worktree kept being served the parent checkout's index until restart
  // (#926). The DB connection itself is still cached (by resolved root,
  // below), so re-resolving costs only the stat walk, never a reopen.
  const resolvedRoot = findNearestCodeGraphRoot(projectPath);

  if (!resolvedRoot) {
    throw new NotIndexedError(
      `The project at ${projectPath} isn't indexed with codegraph (no .codegraph/ directory found ` +
      'walking up from it), so codegraph cannot query it. Use your built-in tools (Read/Grep/Glob) ' +
      "for that codebase instead, and don't call codegraph for it again this session. " +
      "Indexing is the user's decision — they can run 'codegraph init' in that project to enable it."
    );
  }

  // If the path resolves to the default project, reuse the already-open
  // default instance rather than opening a SECOND connection to the same DB.
  // A duplicate connection serializes reads against the watcher's auto-sync
  // writes; when WAL isn't in effect (e.g. a filesystem without shared-memory
  // support) that surfaces as intermittent
  // "database is locked" on concurrent tool calls. See issue #238. The
  // default instance is owned/closed by the server, so it's never cached.
  if (this.cg && this.cg.getProjectRoot() === resolvedRoot) {
    return this.freshen(this.cg);
  }

  // Cache the open DB connection by RESOLVED ROOT only — never by the input
  // path. One key per instance means closeAll() closes each exactly once, and
  // a changed resolution maps to a different entry instead of a stale hit.
  const cached = this.projectCache.get(resolvedRoot);
  if (cached) return this.freshen(cached);

  const cg = loadCodeGraph().openSync(resolvedRoot, { readOnly: this.readOnly });
  this.projectCache.set(resolvedRoot, cg);
  return cg;
}

/**
   * Heal a long-lived connection whose `.codegraph/` was removed and recreated
   * at the same path (a worktree recreated, or `rm -rf .codegraph` + re-init)
   * before handing it to a tool. Otherwise the daemon keeps serving the
   * pre-removal snapshot from its now-unlinked file handle until restart — and
   * because the daemon registry is keyed by path, a same-path recreate routes
   * new clients straight back to this same stale daemon (#925). The check is one
   * stat() and a no-op unless the inode actually changed; it never throws into a
   * tool call.
   */
export function freshen(this: ToolHandlerState, cg: CodeGraph): CodeGraph {
  try {
    if (cg.reopenIfReplaced()) {
      process.stderr.write(
        '[CodeGraph MCP] The index was replaced on disk (e.g. a git worktree ' +
        'recreated at the same path); reopened the live database in place.\n'
      );
    }
  } catch {
    // Best-effort self-heal — a failed reopen must never break the tool call;
    // the (still stale) handle keeps serving and the next call retries.
  }
  return cg;
}

/**
   * Close all cached project connections
   */
export function closeAll(this: ToolHandlerState): void {
  for (const cg of this.projectCache.values()) {
    cg.close();
  }
  this.projectCache.clear();
  this.worktreeMismatchCache.clear();
}

/**
   * Cached git worktree/index mismatch for a tool call's effective project.
   *
   * The "effective project" is what the request targets: an explicit
   * `projectPath` arg, else the directory the server resolved its default
   * project from (`defaultProjectHint`), else cwd. Memoized per start path —
   * see `worktreeMismatchCache`. Best-effort: if the project can't be resolved
   * (e.g. nothing initialized yet), it reports "no mismatch" so a tool is never
   * broken by this check.
   */
export function worktreeMismatchFor(this: ToolHandlerState, projectPath?: string): WorktreeIndexMismatch | null {
  const startPath = projectPath ?? this.defaultProjectHint ?? process.cwd();

  // The verdict depends on BOTH the start path AND the index root it resolves
  // to, so the cache must be keyed on the pair. Resolve the index root first
  // (cheap — getCodeGraph re-walks to the nearest .codegraph/, no git), then
  // key on `(startPath, indexRoot)`. The moment that root changes — most
  // importantly when a git worktree gains its own index and the walk-up stops
  // there instead of at the parent checkout — the key changes and the verdict
  // is recomputed, instead of serving the stale "borrowed the parent's index"
  // warning for the server's whole lifetime. Keying on startPath alone pinned
  // that first verdict until restart (#926).
  let indexRoot: string;
  try {
    indexRoot = this.getCodeGraph(projectPath).getProjectRoot();
  } catch {
    // No resolvable project (or any other resolution error) → nothing to warn.
    return null;
  }

  const cacheKey = `${startPath}\u0000${indexRoot}`;
  const cached = this.worktreeMismatchCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const mismatch = detectWorktreeIndexMismatch(startPath, indexRoot);
  this.worktreeMismatchCache.set(cacheKey, mismatch);
  return mismatch;
}

/**
   * Prefix a successful read-tool result with a compact worktree-mismatch
   * notice when the resolved index belongs to a different git working tree than
   * the caller's (issue #155). Without this, an agent in a nested worktree
   * silently trusts main-branch results. No-op on error results and when there
   * is no mismatch. `codegraph_status` is excluded — it embeds its own verbose
   * warning — so it stays out of this path.
   */
export function withWorktreeNotice(this: ToolHandlerState, result: ToolResult, projectPath?: string): ToolResult {
  if (result.isError) return result;
  const mismatch = this.worktreeMismatchFor(projectPath);
  if (!mismatch) return result;

  const notice = worktreeMismatchNotice(mismatch);
  const [first, ...rest] = result.content;
  if (first && first.type === 'text') {
    return { ...result, content: [{ type: 'text', text: `${notice}\n\n${first.text}` }, ...rest] };
  }
  return result;
}
