import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve as resolvePath } from 'path';
import type CodeGraph from '../index';
import type { PendingFile } from '../sync';
import {
  validatePathWithinRoot
} from '../utils';
import {
  type ToolResult
} from './tool-definitions';
import type { ToolHandlerState } from './tool-handler-state';
import {
  DRIFT_TTL_MS
} from './tool-handler-state-constants';
import {
  formatDegradedBanner,
  formatStaleBanner,
  formatStaleFooter
} from './tool-messages';

/**
   * On-disk drift check for a single indexed file (issue #1474). The code
   * renderers slice CURRENT bytes at INDEXED line ranges; when the file
   * changed after its last index sync those ranges can point at a DIFFERENT
   * symbol's code — served under the requested name with `isError: false`.
   * The watcher-based pending/degraded banners can't cover this for a
   * project reached via `projectPath` (cross-project instances have no
   * watcher, by construction), so freshness is verified here, at the point
   * of emission, from data the index already stores.
   *
   * Cheap and precise: one stat() per file (size + mtime, the same
   * comparison the sync fast path uses); only on a stat mismatch is the
   * content hashed (sha256, matching extraction's `hashContent`) so a
   * touch/checkout that rewrote identical bytes never false-positives.
   * Results are memoized briefly so one response rendering the same file in
   * several sections pays for the check once.
   *
   * Returns true when the on-disk file differs from what was indexed —
   * i.e. indexed line ranges for it are NOT trustworthy. Any failure
   * (missing files-table row, stat/read error) reports false: those cases
   * are handled by the existing not-found paths, and a wrong "stale" flag
   * would needlessly push the agent back to Read.
   */
export function isFileStaleOnDisk(this: ToolHandlerState, cg: CodeGraph, relPath: string, content?: string): boolean {
  let root: string;
  try {
    root = cg.getProjectRoot();
  } catch {
    return false;
  }
  const key = `${root}\0${relPath}`;
  const now = Date.now();
  const hit = this.driftCache.get(key);
  if (hit && now - hit.at < DRIFT_TTL_MS) return hit.stale;
  let stale = false;
  try {
    const rec = cg.getFile(relPath);
    const absPath = rec ? validatePathWithinRoot(root, relPath) : null;
    if (rec && absPath && existsSync(absPath)) {
      const st = statSync(absPath);
      // Same freshness test as the sync fast path (extraction/index.ts):
      // equal size + equal floored mtime ⇒ unchanged, no read needed.
      if (st.size !== rec.size || Math.floor(st.mtimeMs) !== Math.floor(rec.modifiedAt)) {
        const data = content ?? readFileSync(absPath, 'utf-8');
        // Must stay byte-identical to extraction's `hashContent` (sha256 over
        // the utf-8 string) — the identical-rewrite test in
        // mcp-stale-slice.test.ts pins the parity. Inlined (not imported)
        // to keep the extraction module off the MCP startup path.
        stale = createHash('sha256').update(data).digest('hex') !== rec.contentHash;
      }
    }
  } catch {
    stale = false;
  }
  this.driftCache.set(key, { at: now, stale });
  return stale;
}

export function withStalenessNotice(this: ToolHandlerState, result: ToolResult, projectPath?: string): ToolResult {
  if (result.isError) return result;

  let cg: CodeGraph;
  try {
    cg = this.getCodeGraph(projectPath);
  } catch {
    return result; // no default project — leave as is
  }

  // Cross-project `projectPath` calls open a cached CodeGraph WITHOUT a
  // watcher (watchers are only attached to the default session project).
  // When the cross-project path happens to be the same project as the
  // default cg, the cached instance is the wrong one — its pendingFiles is
  // permanently empty. Detect the equal-path case and prefer the default
  // cg so the staleness signal still fires when an agent passes the
  // explicit projectPath form of its own project.
  if (this.cg && cg !== this.cg) {
    try {
      const sameProject =
        resolvePath(this.cg.getProjectRoot()) === resolvePath(cg.getProjectRoot());
      if (sameProject) cg = this.cg;
    } catch {
      /* getProjectRoot may throw on a closed instance — leave cg as is */
    }
  }

  // Whole-index degradation (#876): once live watching has permanently
  // stopped, getPendingFiles() is empty so the per-file banner below can't
  // fire — but the index is now FROZEN and silently drifting stale. Surface
  // one global notice instead, so the agent Reads for current content rather
  // than trusting a response off a no-longer-updating index. (Cross-project
  // calls open a watcher-less CodeGraph, so this is false there — correct: we
  // only know degraded state for the default session project.)
  let degraded: boolean;
  try {
    degraded = cg.isWatcherDegraded?.() ?? false;
  } catch {
    degraded = false;
  }
  if (degraded) {
    const [head, ...tail] = result.content;
    if (!head || head.type !== 'text') return result;
    let reason: string | null = null;
    try {
      reason = cg.getWatcherDegradedReason?.() ?? null;
    } catch {
      reason = null;
    }
    const composed = `${formatDegradedBanner(reason)}\n\n${head.text}`;
    return { ...result, content: [{ type: 'text', text: composed }, ...tail] };
  }

  // Defensive: some test fakes inject a partial CodeGraph stub without the
  // newer pending-files API. Treat missing/throwing as "no pending files."
  let pending: PendingFile[] = [];
  try {
    pending = cg.getPendingFiles?.() ?? [];
  } catch {
    return result;
  }
  if (pending.length === 0) return result;

  const [first, ...rest] = result.content;
  if (!first || first.type !== 'text') return result;

  const text = first.text;
  const inResponse: PendingFile[] = [];
  const elsewhere: PendingFile[] = [];
  for (const p of pending) {
    // Substring match against the project-relative POSIX path — that's
    // exactly the format both the watcher and every codegraph response
    // emit, so a plain includes() is sufficient and avoids regex pitfalls.
    if (text.includes(p.path)) inResponse.push(p);
    else elsewhere.push(p);
  }

  let banner = '';
  if (inResponse.length > 0) {
    banner = formatStaleBanner(inResponse);
  }
  let footer = '';
  if (elsewhere.length > 0) {
    footer = formatStaleFooter(elsewhere);
  }
  if (!banner && !footer) return result;

  const composed = [banner, text, footer].filter(Boolean).join('\n\n');
  return { ...result, content: [{ type: 'text', text: composed }, ...rest] };
}
