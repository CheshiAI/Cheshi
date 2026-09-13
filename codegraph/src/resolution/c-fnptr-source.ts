import * as path from 'node:path';
import { LRUCache } from './lru-cache';
import { memoryBudgetBytes } from './memory-budget';
import { stripCommentsForRegex } from './strip-comments';
import type { ResolutionContext } from './types';

interface SourceProfile { readMs: number; readN: number; stripMs: number; stripN: number }

export function createFnPointerSource(files: string[], ctx: ResolutionContext, prof: SourceProfile | null) {


  // Cache raw + stripped source per file, LRU-BOUNDED. The old unbounded Maps
  // retained every C/C++ file's raw AND stripped text for the whole pass —
  // multiple GB on the Linux kernel, one of the two OOM culprits in #1212.
  // The extraction sweep reads sequentially; the linking stages re-request
  // only surviving files (plus include units), so access is near-sequential
  // and a small LRU hits; a miss just re-reads + re-strips.
  // Cache sizing is memory-budget-aware AND all-or-nothing (§7a.3 cFnPtr
  // round): a partial LRU is WORSE than useless for cyclic sweeps (a first
  // attempt sized ~61k against 63.8k files thrashed to a ~0% cross-sweep hit
  // rate). Hold every stripped file (~24KB each measured on the Linux tree)
  // only when 40% of the live memory budget covers it; otherwise keep the
  // within-stage-locality 128. When the big cache declines (the kernel), the
  // survival filters keep the linking stages' re-strips to a fraction of a
  // sweep. Slack over files.length: non-indexed includes (.def/.inc, generated
  // headers) join the working set mid-pass. Pass-scoped transient, freed on
  // return.
  const fullCacheCap = Math.ceil(files.length * 1.05) + 512;
  const cacheCap = memoryBudgetBytes() * 0.5 >= fullCacheCap * 24_576 ? fullCacheCap : 128;
  const rawCache = new LRUCache<string, string | null>(Math.min(cacheCap, 4096));
  const raw = (file: string): string | null => {
    if (rawCache.has(file)) return rawCache.get(file)!;
    const t0 = prof ? Date.now() : 0;
    const r = ctx.readFile(file);
    if (prof) { prof.readMs += Date.now() - t0; prof.readN++; }
    rawCache.set(file, r);
    return r;
  };
  const srcCache = new LRUCache<string, string>(cacheCap);
  const src = (file: string): string | null => {
    // A cached '' (empty or unreadable file) returns '' where the miss path
    // returns null for unreadable — every caller falsy-checks, so the two are
    // interchangeable.
    const hit = srcCache.get(file);
    if (hit !== undefined) return hit;
    const r = raw(file);
    const t0 = prof ? Date.now() : 0;
    const s = r == null ? '' : stripCommentsForRegex(r, 'c');
    if (prof) { prof.stripMs += Date.now() - t0; prof.stripN++; }
    srcCache.set(file, s);
    return r == null ? null : s;
  };

  // Resolve a quoted include relative to the includer's directory, then the
  // project root. Returns a project-root-relative path that exists on disk
  // (even if it was never indexed — e.g. redis' generated `commands.def`).
  const resolveInclude = (includer: string, inc: string): string | null => {
    const dir = path.posix.dirname(includer.replace(/\\/g, '/'));
    const cand = path.posix.normalize(path.posix.join(dir, inc));
    if (ctx.fileExists(cand)) return cand;
    if (ctx.fileExists(inc)) return inc;
    return null;
  };

  // Retained strings are interned through here. Regex captures off a big file
  // string are V8 sliced strings — retaining one pins the whole parent file
  // text, and the facts tables retain captures from EVERY file for the whole
  // pass. The Buffer round-trip forces a flat copy on first sight; repeats
  // (field names recur heavily) then share the one flat instance.
  const interned = new Map<string, string>();
  const intern = (x: string): string => {
    let f = interned.get(x);
    if (f === undefined) {
      f = Buffer.from(x, 'utf8').toString('utf8');
      interned.set(f, f);
    }
    return f;
  };
  return { raw, src, resolveInclude, intern };
}
