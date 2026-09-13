import { logDebug } from '../errors';
import { UnresolvedReference } from '../types';
import { synthesizeCallbackEdges } from './callback-synthesizer';
import { createYielder } from './cooperative-yield';
import { partitionFailedCleanup, partitionResolvedCleanup } from './resolver-persistence';
import { minRefsForPool, ResolverPool } from './resolver-pool';
import type { ResolverState } from './resolver-state';
import {
  ResolutionResult,
  ResolvedRef,
  UnresolvedRef
} from './types';


export function resolveListForAdmission(this: ResolverState, refs: UnresolvedReference[]): {
  resolved: ResolvedRef[];
  unresolved: UnresolvedRef[];
  deferredChain: UnresolvedRef[];
  deferredThisMember: UnresolvedRef[];
  byMethod: Record<string, number>;
} {
  this.owner.warmCaches();
  this.advanceSupertypeGeneration();
  const resolved: ResolvedRef[] = [];
  const unresolved: UnresolvedRef[] = [];
  const byMethod: Record<string, number> = {};
  for (const raw of refs) {
    const ref: UnresolvedRef = {
      fromNodeId: raw.fromNodeId,
      referenceName: raw.referenceName,
      referenceKind: raw.referenceKind,
      line: raw.line,
      column: raw.column,
      filePath: raw.filePath || this.getFilePathFromNodeId(raw.fromNodeId),
      language: raw.language || this.getLanguageFromNodeId(raw.fromNodeId),
      rowId: raw.rowId,
    };
    const result = this.resolveOneTimed(ref);
    if (result) {
      resolved.push(result);
      byMethod[result.resolvedBy] = (byMethod[result.resolvedBy] || 0) + 1;
    } else {
      unresolved.push(ref);
    }
  }
  return {
    resolved,
    unresolved,
    deferredChain: this.deferredChainRefs.splice(0),
    deferredThisMember: this.deferredThisMemberRefs.splice(0),
    byMethod,
  };
}

/**
   * Re-queue deferred post-pass refs produced by resolver workers, preserving
   * their admission order so resolveChainedCallsViaConformance /
   * resolveDeferredThisMemberRefs process them exactly as the sequential path
   * would have.
   */
export function appendDeferredFromWorkers(this: ResolverState, deferredChain: UnresolvedRef[], deferredThisMember: UnresolvedRef[]): void {
  this.deferredChainRefs.push(...deferredChain);
  this.deferredThisMemberRefs.push(...deferredThisMember);
}

/**
   * Resolve and persist in batches to keep memory bounded.
   * Processes unresolved references in chunks, persisting edges and cleaning
   * up resolved refs after each batch to avoid accumulating large arrays.
   */
export async function resolveAndPersistBatched(this: ResolverState, onProgress?: (current: number, total: number) => void, batchSize: number = 5000, onSynthesisProgress?: (done: number, total: number) => void, parallel?: {
  dbPath: string;
  bulkEdgeLoad?: { begin: () => void; end: () => void | Promise<void> };
  /** unresolved_refs index window for the batched loop — the loop only
   *  reads the status index + PK; dropping the sync-path ref indexes cuts
   *  each per-batch DELETE's B-tree work (DatabaseConnection.beginBulkRefLoad). */
  refIndexLoad?: { begin: () => void; end: () => void | Promise<void> };
  backpressure?: () => Promise<void> | null;
}): Promise<ResolutionResult> {
  // Resolution runs on the indexer's MAIN thread, and the #850 liveness
  // watchdog SIGKILLs a process whose event loop stalls past its window (60s
  // by default). A single dense batch's resolveAll — or the synthesis pass
  // below — can exceed that on a large repo, killing a VALID in-progress index
  // (#1091). A shared yielder lets both give the watchdog heartbeat a regular
  // window to fire; see ./cooperative-yield.
  const maybeYield = createYielder();

  if (process.env.CODEGRAPH_SYNTH_TIMINGS) {
    console.error(`[pool-timing] backpressure hook: ${parallel?.backpressure ? 'present' : 'absent'}`);
  }

  // CODEGRAPH_RESOLVE_PROFILE loop-stage attribution: the §7a.2 kernel-scale
  // histogram showed resolveOne owns only ~93s of the ~436s batch loop —
  // these counters name where the other ~340s goes (reads, edge build+insert,
  // deletes/marks, the per-batch count guard).
  const loopProf: Record<string, number> | null = process.env.CODEGRAPH_RESOLVE_PROFILE
    ? { read: 0, settle: 0, backpressure: 0, recycle: 0, createEdges: 0, insertEdges: 0, deletes: 0, marks: 0, countGuard: 0 }
    : null;
  const lp = (k: string, t0: number): void => { if (loopProf) loopProf[k] = (loopProf[k] ?? 0) + (Date.now() - t0); };
  let tLp = 0;

  await this.owner.warmCachesYielding(maybeYield);

  const total = this.queries.getUnresolvedReferencesCount();
  let processed = 0;
  const aggregateStats = {
    total: 0,
    resolved: 0,
    unresolved: 0,
    byMethod: {} as Record<string, number>,
  };

  // Parallel pool, started immediately but never awaited up front: early
  // batches run sequentially while the workers boot (module load + readonly
  // DB open + framework detect + cache warm ≈ hundreds of ms), and the loop
  // switches to fan-out the moment the pool reports ready — so pool boot
  // costs zero wall-clock. Any failure downgrades to sequential permanently.
  let pool: ResolverPool | null = null;
  let poolReady = false;
  // True once pool creation has been attempted by EITHER engage site (the
  // up-front ref-count gate or the adaptive projection below) — a pool that
  // failed or was destroyed must stay down (downgrade is permanent), and
  // tryCreate's sizing probes shouldn't re-run every batch on hosts that
  // declined.
  let poolEngageTried = false;
  const createPool = (t0: number, why: string): ResolverPool | null => {
    poolEngageTried = true;
    if (!parallel) return null;
    const p = ResolverPool.tryCreate(parallel.dbPath, this.projectRoot);
    p?.ready().then(
      () => {
        poolReady = true;
        if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[pool-timing] pool ready after ${Date.now() - t0}ms (${why})`);
      },
      () => {
        void p.destroy().catch(() => undefined);
        if (pool === p) pool = null;
      }
    );
    return p;
  };
  if (parallel && total >= minRefsForPool()) {
    pool = createPool(Date.now(), 'ref-count');
  }
  // Adaptive engagement bar (see the batch-loop hook): projected remaining
  // sequential settle above this boots the pool mid-loop. Boot is async and
  // fan-out waits for ready, so a marginal engage costs background boot
  // only; the bar just needs to clear the fan-out's own overhead class.
  const ADAPTIVE_ENGAGE_SETTLE_MS = 400;
  let adaptiveSeqMs = 0;
  let adaptiveSeqRefs = 0;

  // Process in PIPELINED batches (double-buffer). The enumeration is the
  // head of the pending set in rowid order; every ref a persisted batch
  // processed leaves the pending set (resolved rows are deleted,
  // unresolvable ones flip to status='failed'), shifting the remaining
  // pending rows forward.
  let prevRemaining = Number.POSITIVE_INFINITY;

  // Cadence for the worker connection recycling below — ~8 batches
  // ≈ 40k refs between recycles keeps the WAL shallow at kernel scale
  // while a small sync never recycles at all. (25 recovered only half
  // the write tax — the WAL re-deepened between recycles; reopens are
  // sub-millisecond so the shorter cadence is ~free.)
  const RECYCLE_EVERY_BATCHES = 8;
  let batchesSinceRecycle = 0;

  // Fan-out result of ResolverPool.resolveBatch, settled (never rejecting)
  // so a fan-out begun before the previous batch's persist can't produce an
  // unhandled rejection while it waits to be awaited.
  type PoolSettled =
    | { ok: true; out: Awaited<ReturnType<ResolverPool['resolveBatch']>> }
    | { ok: false; err: unknown };
  type InFlight = { mode: 'pool'; settled: Promise<PoolSettled> } | { mode: 'seq' };

  // Begin one batch: fan out to the pool when it's ready and the batch is
  // big enough — workers then resolve batch k+1 WHILE the main thread
  // persists batch k (persist measured at ~58% of resolution wall on a
  // 255k-ref repo, all of it previously spent with the pool idle).
  // Sequential batches stay lazy: they run on the main thread at settle
  // time, where an early start would only contend with the persist.
  const beginBatch = (batch: UnresolvedReference[]): InFlight => {
    if (pool && poolReady && ResolverPool.worthParallel(batch.length)) {
      return {
        mode: 'pool',
        settled: pool.resolveBatch(batch).then(
          (out) => ({ ok: true as const, out }),
          (err: unknown) => ({ ok: false as const, err })
        ),
      };
    }
    return { mode: 'seq' };
  };

  // Settle an in-flight batch to a ResolutionResult. Deferred post-pass refs
  // are appended HERE, in loop order — never inside the fan-out promise — so
  // admission order stays exactly the sequential order even while a later
  // batch resolves concurrently. A pool failure downgrades to sequential
  // permanently and re-resolves this batch on the main thread.
  const settleBatch = async (
    inFlight: InFlight,
    batch: UnresolvedReference[]
  ): Promise<ResolutionResult> => {
    if (inFlight.mode === 'pool') {
      const settled = await inFlight.settled;
      if (settled.ok) {
        this.owner.appendDeferredFromWorkers(settled.out.deferredChain, settled.out.deferredThisMember);
        return {
          resolved: settled.out.resolved,
          unresolved: settled.out.unresolved,
          stats: {
            total: batch.length,
            resolved: settled.out.resolved.length,
            unresolved: settled.out.unresolved.length,
            byMethod: settled.out.byMethod,
          },
        };
      }
      logDebug('Parallel resolution failed; falling back to sequential', {
        error: settled.err instanceof Error ? settled.err.message : String(settled.err),
      });
      if (pool) await pool.destroy().catch(() => undefined);
      pool = null;
    }
    return this.resolveBatchYielding(batch, maybeYield);
  };

  // Bulk edge load: on big runs, drop the non-unique edge indexes for the
  // duration of the batch loop (the identity index stays — OR IGNORE dedup
  // and the source-keyed supertype-walk reads both live on it). Recreated in
  // the inner finally BEFORE synthesis, whose passes read kind-keyed.
  // Measured on a 224k-edge resolution set: insert 2.8s → 1.1s + 0.3s
  // recreate. Same ref-count gate as the pool so small syncs never pay the
  // recreate cost.
  let bulkEdgesActive = false;
  if (parallel?.bulkEdgeLoad && total >= minRefsForPool()) {
    try {
      parallel.bulkEdgeLoad.begin();
      bulkEdgesActive = true;
    } catch { /* keep the indexes; inserts just pay the per-row maintenance */ }
  }
  // Same gate for the ref-index window: the loop's deletes stop maintaining
  // the five sync-path unresolved_refs indexes, and the end-of-loop rebuild
  // is near-free (only failed refs survive the loop).
  let bulkRefsActive = false;
  if (parallel?.refIndexLoad && total >= minRefsForPool()) {
    try {
      parallel.refIndexLoad.begin();
      bulkRefsActive = true;
    } catch { /* keep the indexes; deletes just pay the per-row maintenance */ }
  }

  try {
    try {
      tLp = Date.now();
      let batch = this.queries.getUnresolvedReferencesBatchAfter(0, batchSize);
      lp('read', tLp);
      let inFlight: InFlight | null = batch.length > 0 ? beginBatch(batch) : null;
      while (batch.length > 0 && inFlight) {
        // Prefetch the NEXT batch before this one persists: this batch's rows
        // are still pending (nothing has mutated the table since they were
        // read), so seeking past this batch's last row id in the same rowid
        // enumeration yields the following batch (keyset — OFFSET re-walked the
        // accumulated failed prefix every read, 54.6s at kernel scale, §7a.2).
        tLp = Date.now();
        const nextBatch = this.queries.getUnresolvedReferencesBatchAfter(batch[batch.length - 1]!.rowId!, batchSize);
        lp('read', tLp);

        const tBatch = Date.now();
        const result = await settleBatch(inFlight, batch);
        if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[pool-timing] batch ${inFlight.mode}: ${batch.length} refs in ${Date.now() - tBatch}ms`);
        lp('settle', tBatch);

        // Adaptive pool engagement: the fixed ref-count gate can't see PER-REF
        // cost, and settle rates differ ~9× by language (56k Rust refs cost
        // more sequential settle than 154k Go refs — 36µs vs 4µs measured on
        // tokio/prometheus). After each sequential batch, project the remaining
        // settle from the observed rate and boot the pool mid-loop when it
        // clears the bar. The loop already switches to fan-out only when the
        // async boot reports ready, admission order is mode-independent, and
        // 2-core/low-memory hosts still decline inside tryCreate's sizing —
        // so the switch changes wall-clock, never the graph.
        if (inFlight.mode === 'seq' && parallel && pool === null && !poolEngageTried) {
          adaptiveSeqMs += Date.now() - tBatch;
          adaptiveSeqRefs += batch.length;
          const remaining = total - processed - batch.length;
          const projectedMs = (adaptiveSeqMs / Math.max(1, adaptiveSeqRefs)) * Math.max(0, remaining);
          if (projectedMs >= ADAPTIVE_ENGAGE_SETTLE_MS) {
            if (process.env.CODEGRAPH_SYNTH_TIMINGS) {
              console.error(`[pool-timing] adaptive engage: projected ${Math.round(projectedMs)}ms sequential settle over ${remaining} remaining refs`);
            }
            pool = createPool(Date.now(), 'adaptive');
          }
        }

        // WAL-valve backstop at the ONE pool-idle boundary of the double-buffer
        // (this batch settled, the next not yet fanned out): past the hard cap
        // the writer parks for a full backfill here, where the pool's readers
        // are all between statements — so the backfill completes, readers
        // re-enter at SQLite's backfilled mark, and the next persist commit
        // WRAPS the WAL instead of growing it. No-op (one fstat) under the cap.
        tLp = Date.now();
        const bp = parallel?.backpressure?.();
        if (bp) await bp;
        lp('backpressure', tLp);

        // Recycle the workers' read connections periodically at this same
        // worker-idle boundary (batch k settled, batch k+1 not yet fanned
        // out): a long-lived reader pins WAL checkpoint progress, and the
        // deep WAL that accumulates behind it taxes the writer's OWN page
        // operations — the §7a.6 writes-under-readers finding (deletes
        // 42.6s → 118.8s from 0 to 4 attached readers; an aggressive valve
        // recovered the writes but paid +129s in full-park folds). Releasing
        // the read marks every ~25 batches lets the existing checkpoints
        // advance instead, at ~milliseconds of reopen cost. A failed recycle
        // downgrades to sequential permanently, same as a failed fan-out.
        if (pool && poolReady && ++batchesSinceRecycle >= RECYCLE_EVERY_BATCHES) {
          batchesSinceRecycle = 0;
          tLp = Date.now();
          try {
            await pool.recycleWorkers();
          } catch (err) {
            logDebug('Worker connection recycle failed; falling back to sequential', {
              error: err instanceof Error ? err.message : String(err),
            });
            await pool.destroy().catch(() => undefined);
            pool = null;
          }
          lp('recycle', tLp);
        }

        // Persist in bounded sub-transactions with yields between: a whole
        // batch's edge insert / keyed deletes are otherwise one solid
        // synchronous span each on a multi-GB index, sitting BETWEEN the
        // per-ref yields — the last unyielded stretch of the resolution loop.
        // Crash semantics are unchanged (already several transactions): edges
        // land before their refs are deleted, so a kill mid-way re-resolves
        // the remainder idempotently on the next run/sweep (#1187).
        const PERSIST_CHUNK = 1000;
        const tPersist = Date.now();

        // Persist edges BEFORE fanning out the next batch: later batches read
        // this batch's edges — resolveMethodOnType walks supertype chains over
        // `extends`/`implements` edges that earlier batches resolved, so a
        // receiver typed as a subclass only reaches a method declared on its
        // base class if those edges are visible. (Validated on dubbo: fanning
        // out first downgraded exactly those supertype-method resolutions from
        // the 0.9 typed-receiver path to the 0.65 word-overlap fallback.)
        tLp = Date.now();
        const edges = this.owner.createEdges(result.resolved);
        lp('createEdges', tLp);
        tLp = Date.now();
        for (let i = 0; i < edges.length; i += PERSIST_CHUNK) {
          this.queries.insertEdges(edges.slice(i, i + PERSIST_CHUNK));
          await maybeYield();
        }
        lp('insertEdges', tLp);

        // NOW fan the next batch out — workers see exactly the edge state the
        // sequential baseline would (every batch ≤ this one committed), while
        // the main thread spends the REST of the persist (ref deletes + failed
        // parking below) overlapped with their resolution — the double-buffer.
        const nextInFlight = nextBatch.length > 0 ? beginBatch(nextBatch) : null;

        // Clean up resolved refs so they don't appear in the next batch —
        // by row id, so a same-key sibling ref in a LATER batch (same caller
        // calling the same callee at another line) is left pending for its own
        // attempt instead of being swept out with this batch's rows (#1269).
        tLp = Date.now();
        let removedThisBatch = 0;
        const resolvedCleanup = partitionResolvedCleanup(result.resolved);
        for (let i = 0; i < resolvedCleanup.rowIds.length; i += PERSIST_CHUNK) {
          removedThisBatch += this.queries.deleteReferencesByRowIds(resolvedCleanup.rowIds.slice(i, i + PERSIST_CHUNK));
          await maybeYield();
        }
        for (let i = 0; i < resolvedCleanup.legacyKeys.length; i += PERSIST_CHUNK) {
          removedThisBatch += this.queries.deleteSpecificResolvedReferences(resolvedCleanup.legacyKeys.slice(i, i + PERSIST_CHUNK));
          await maybeYield();
        }
        lp('deletes', tLp);

        // Park unresolvable refs from this batch as status='failed' so they
        // leave the pending set (the batch reader and non-progress guard below
        // only see pending rows) but stay retryable when a later sync adds a
        // symbol that could satisfy them (#1240).
        tLp = Date.now();
        const failedCleanup = partitionFailedCleanup(result.unresolved);
        for (let i = 0; i < failedCleanup.byRowId.length; i += PERSIST_CHUNK) {
          removedThisBatch += this.queries.markReferencesFailedByRowIds(failedCleanup.byRowId.slice(i, i + PERSIST_CHUNK));
          await maybeYield();
        }
        for (let i = 0; i < failedCleanup.legacyKeys.length; i += PERSIST_CHUNK) {
          removedThisBatch += this.queries.markReferencesFailed(failedCleanup.legacyKeys.slice(i, i + PERSIST_CHUNK));
          await maybeYield();
        }
        lp('marks', tLp);

        if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[pool-timing] batch persist: ${Date.now() - tPersist}ms`);

        // Aggregate stats
        aggregateStats.total += result.stats.total;
        aggregateStats.resolved += result.stats.resolved;
        aggregateStats.unresolved += result.stats.unresolved;
        for (const [method, count] of Object.entries(result.stats.byMethod)) {
          aggregateStats.byMethod[method] = (aggregateStats.byMethod[method] || 0) + count;
        }

        processed += batch.length;
        onProgress?.(processed, total);

        // Yield so progress UI can render between batches
        await new Promise(resolve => setImmediate(resolve));

        // NOTE: there used to be an extra early break here when a batch resolved
        // nothing (`result.unresolved.length === batch.length`). That was wrong:
        // an all-unresolvable batch still DELETES its rows (progress), yet the
        // break abandoned every batch after it in the same run — on a repo whose
        // first 5000 refs are all external/stdlib calls, resolution stopped at
        // batch one and left the rest of the table as permanent orphans (#1187).
        // The count-based guard below catches the true no-progress case.

        // Non-progress guard (defense-in-depth). Each iteration enumerates from
        // the head of the pending set, so the PENDING population MUST shrink
        // every iteration — resolved refs are deleted and unresolvable ones are
        // marked failed above, and both leave the pending set the batch reader
        // sees. If it didn't shrink, a resolver returned a match whose
        // `original.referenceName` differs from the stored row, so the keyed
        // delete/update no-ops, and we'd re-read + re-resolve + re-insert the
        // same rows forever (the runaway that grew a 99-file repo to 5M edges /
        // 1.4 GB before the Go-fallback fix). Stop rather than grow the graph
        // without bound. (An in-flight prefetched batch is abandoned unsettled —
        // fan-out has no side effects until settleBatch appends its results.)
        // Non-progress signal, now O(1): `changes` summed across this batch's
        // deletes + failed-parks is the DIRECT evidence the guard's old count
        // diff inferred — a resolver returning a mismatched name makes the keyed
        // cleanup no-op, which shows up here as zero removals. The per-batch
        // COUNT(*) it replaces walked every remaining pending row — O(N²/batch)
        // over a run, 93.9s of the kernel-scale batch loop (§7a.2). A REAL count
        // runs only on the suspicious path (claimed-work batch removed nothing —
        // e.g. every row was a sibling a legacy-key sweep already consumed),
        // where it arbitrates stop-vs-continue exactly as before.
        if (removedThisBatch <= 0 && batch.length > 0) {
          tLp = Date.now();
          const remaining = this.queries.getUnresolvedReferencesCount();
          lp('countGuard', tLp);
          if (remaining >= prevRemaining) break;
          prevRemaining = remaining;
        }

        // Advance the pipeline: the prefetched batch (already fanned out when
        // the pool is on) becomes the current one.
        batch = nextBatch;
        inFlight = nextInFlight;
      }
    } finally {
      // Recreate the edge indexes BEFORE synthesis (kind-keyed reads) and on
      // any error path. A crash before this line is healed by the next
      // DatabaseConnection open (schema.sql re-applies IF NOT EXISTS).
      if (bulkRefsActive) {
        const tRef = Date.now();
        await parallel!.refIndexLoad!.end();
        if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] ref-index-recreate: ${Date.now() - tRef}ms`);
      }
      if (bulkEdgesActive) {
        const tIdx = Date.now();
        await parallel!.bulkEdgeLoad!.end();
        if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] edge-index-recreate: ${Date.now() - tIdx}ms`);
        // The recreate just wrote every non-unique edge index into the WAL
        // (multi-GB at kernel scale) with the pool idle — fold before the
        // synthesis passes pin readers against it for minutes.
        const bp = parallel?.backpressure?.();
        if (bp) await bp;
      }
    }

    // Dynamic-edge synthesis: now that all base `calls` edges are persisted,
    // synthesize observer/callback dispatch edges (dispatcher → registered
    // callbacks) that static parsing leaves out. Best-effort — never fail the
    // index on it. The pool (when it survived resolution) is REUSED to fan the
    // independent passes across its read-only workers — that's why its destroy
    // lives in the finally below, after synthesis, not at the end of the batch
    // loop.
    const tSynth = Date.now();
    try {
      aggregateStats.byMethod['callback-synthesis'] = await synthesizeCallbackEdges(
        this.queries,
        this.context,
        onSynthesisProgress,
        pool,
        parallel?.backpressure
      );
    } catch {
      // synthesis is additive and optional; ignore failures
    }
    if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] callback-synthesis: ${Date.now() - tSynth}ms`);
  } finally {
    if (pool) await pool.destroy().catch(() => undefined);
  }

  if (loopProf) {
    const parts = Object.entries(loopProf).map(([k, v]) => `${k}=${(v / 1000).toFixed(1)}s`).join(' ');
    console.error(`[resolve-profile] loop-stages ${parts}`);
  }
  this.owner.dumpResolveProfile('main');

  return {
    resolved: [],
    unresolved: [],
    stats: aggregateStats,
  };
}
