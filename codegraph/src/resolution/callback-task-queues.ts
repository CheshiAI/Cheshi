import type { Edge, Node } from '../types';
import { enclosingFn } from './callback-source';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import type { ResolutionContext } from './types';

// ── Celery task dispatch (Python) ─────────────────────────────────────────────
// Celery decouples a task's call site from its body through async dispatch:
//   # tasks.py
//   @shared_task                       # also @app.task / @celery_app.task / @<app>.task / @task
//   def process(account_ids): ...
//   # views.py — a DIFFERENT module
//   process.apply_async(kwargs={...})  # or process.delay(...) — dynamic, no static edge
// Bridge it: link the enclosing function/method at each `.delay(`/`.apply_async(` site → the
// task function body. Precision rests on the DECORATOR gate — the dispatched name must resolve
// to a Python function carrying a celery task decorator (read from the source lines above its
// `def`, since the def's own startLine excludes the decorator). A `.delay()` on a non-task
// object resolves to no task node → no edge, so a Celery-free repo yields 0. Same-file /
// unique-candidate disambiguation like vuex. (Canvas forms — `group(t).delay()`, `t.s()`/`.si()`
// — have no single identifier before `.delay`/`.apply_async`, so they're skipped, not mis-bridged.)
const CELERY_DISPATCH_RE = /\b([A-Za-z_]\w*)\s*\.\s*(?:delay|apply_async)\s*\(/g;

// A task decorator: bare `@shared_task`/`@task` or attribute `@app.task`/`@celery_app.task`,
// each optionally called with args. `\b`-bounded and `@`-anchored so `@mytask`, or a symbol
// merely named `task`, can't match. No `/g`, so `.test()` is stateless across reuse.
const CELERY_TASK_DECORATOR_RE = /@\s*(?:[A-Za-z_][\w.]*\.)?(?:shared_task|task)\b/;

const CELERY_PY_EXT = /\.py$/;

const CELERY_FANOUT_CAP = 80;

const CELERY_DECORATOR_LOOKBACK = 12;

// max lines above a `def` to scan for its decorators

export async function celeryDispatchEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scannedFiles = 0;
  // Memoize the decorator check per task-candidate node: it reads the file and scans a few
  // lines above the def. Only called on names that are actually `.delay`/`.apply_async`
  // receivers, so the candidate set stays small.
  const taskCache = new Map<string, boolean>();
  const isCeleryTask = (node: Node): boolean => {
    let v = taskCache.get(node.id);
    if (v !== undefined) return v;
    v = false;
    if (node.kind === 'function' && CELERY_PY_EXT.test(node.filePath)) {
      const content = ctx.readFile(node.filePath);
      if (content) {
        const lines = content.split('\n');
        // startLine is the `def` line (decorators sit ABOVE it). Walk upward, stopping at the
        // previous declaration so a non-task def can never inherit the prior def's decorator.
        const stop = Math.max(0, node.startLine - 1 - CELERY_DECORATOR_LOOKBACK);
        for (let i = node.startLine - 2; i >= stop; i--) {
          const t = (lines[i] ?? '').trim();
          if (/^(?:async\s+def|def|class)\b/.test(t)) break; // previous decl → stop
          if (CELERY_TASK_DECORATOR_RE.test(t)) { v = true; break; }
        }
      }
    }
    taskCache.set(node.id, v);
    return v;
  };

  const resolve = (name: string, dispatchFile: string): Node | null => {
    const cands = ctx.getNodesByName(name).filter((n) => n.kind === 'function' && isCeleryTask(n));
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0]!;
    // Cross-module name collision: prefer a task defined in the dispatching file, else bail
    // (ambiguous — precision over recall, like vuex's root-key resolution).
    return cands.find((c) => c.filePath === dispatchFile) ?? null;
  };

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if (!CELERY_PY_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || (!content.includes('.delay(') && !content.includes('.apply_async('))) continue;
    const safe = stripCommentsForRegex(content, 'python');
    const nodesInFile = ctx.getNodesInFile(file);
    CELERY_DISPATCH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let added = 0;
    while ((m = CELERY_DISPATCH_RE.exec(safe)) && added < CELERY_FANOUT_CAP) {
      const name = m[1]!;
      const line = safe.slice(0, m.index).split('\n').length;
      const disp = enclosingFn(nodesInFile, line);
      if (!disp) continue; // module-level dispatch — no source symbol to attribute
      const target = resolve(name, file);
      if (!target || target.id === disp.id) continue;
      const key = `${disp.id}>${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: disp.id,
        target: target.id,
        kind: 'calls',
        line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'celery-dispatch', via: name, registeredAt: `${file}:${line}` },
      });
      added++;
    }
  }
  return edges;
}

// ── Sidekiq job dispatch (Ruby) ───────────────────────────────────────────────
// Sidekiq decouples a job's enqueue site from the worker's `perform`, linked by the WORKER
// CLASS NAME:
//   # app/workers/destroy_user_worker.rb
//   class DestroyUserWorker
//     include Sidekiq::Worker          # or Sidekiq::Job (the modern alias)
//     def perform(user_id) … end
//   # app/services/… — a DIFFERENT file
//   DestroyUserWorker.perform_async(user.id)   # also .perform_in(t, …) / .perform_at(t, …)
// Bridge it: link the enclosing method at each `Worker.perform_async/_in/_at(…)` site → that
// worker's instance `perform`. Name-keyed (like Celery): the receiver class must be a Sidekiq
// worker — gated by reading `include Sidekiq::Job|Worker` from the class body, since that mixin
// is an external gem module that forms no resolvable edge. ActiveJob's `perform_later`/`_now` is
// a different shape and deliberately not matched, so an ActiveJob-only app yields 0.
const SIDEKIQ_DISPATCH_RE = /([A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*)\s*\.\s*perform_(?:async|in|at)\b/g;

const SIDEKIQ_WORKER_RE = /\binclude\s+Sidekiq::(?:Job|Worker)\b/;

const SIDEKIQ_RB_EXT = /\.rb$/;

const SIDEKIQ_FANOUT_CAP = 80;

export async function sidekiqDispatchEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scannedFiles = 0;
  // class node id → its instance `perform` method (null if the class isn't a Sidekiq worker),
  // memoized. Reads the class body for the mixin; only consulted for actual dispatch receivers.
  const performCache = new Map<string, Node | null>();
  const performOf = (cls: Node): Node | null => {
    let v = performCache.get(cls.id);
    if (v !== undefined) return v;
    v = null;
    const content = ctx.readFile(cls.filePath);
    if (content) {
      const end = cls.endLine ?? cls.startLine;
      const body = content.split('\n').slice(cls.startLine - 1, end).join('\n');
      if (SIDEKIQ_WORKER_RE.test(body)) {
        v = ctx.getNodesInFile(cls.filePath).find(
          (n) => n.kind === 'method' && n.name === 'perform' && n.startLine >= cls.startLine && n.startLine <= end
        ) ?? null;
      }
    }
    performCache.set(cls.id, v);
    return v;
  };

  // Resolve a (possibly namespaced) worker reference to its `perform`. A namespaced ref is
  // matched by EXACT qualified name first, so same-named workers in different namespaces
  // (forem has four `SendEmailNotificationWorker`s) resolve to the right one; an unqualified
  // ref falls back to the simple name and links only when a single worker bears it — an
  // ambiguous collision bails (precision over recall).
  const resolve = (ref: string): Node | null => {
    if (ref.includes('::')) {
      const q = ctx.getNodesByQualifiedName(ref).find((n) => n.kind === 'class' && performOf(n));
      if (q) return performOf(q);
    }
    const workers = ctx.getNodesByName(ref.split('::').pop()!).filter((n) => n.kind === 'class' && performOf(n));
    return workers.length === 1 ? performOf(workers[0]!) : null;
  };

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if (!SIDEKIQ_RB_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || !/\.perform_(?:async|in|at)\b/.test(content)) continue;
    const safe = stripCommentsForRegex(content, 'ruby');
    const nodesInFile = ctx.getNodesInFile(file);
    SIDEKIQ_DISPATCH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let added = 0;
    while ((m = SIDEKIQ_DISPATCH_RE.exec(safe)) && added < SIDEKIQ_FANOUT_CAP) {
      const line = safe.slice(0, m.index).split('\n').length;
      const disp = enclosingFn(nodesInFile, line);
      if (!disp) continue;
      const target = resolve(m[1]!);
      if (!target || target.id === disp.id) continue;
      const key = `${disp.id}>${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: disp.id,
        target: target.id,
        kind: 'calls',
        line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'sidekiq-dispatch', via: m[1]!, registeredAt: `${file}:${line}` },
      });
      added++;
    }
  }
  return edges;
}
