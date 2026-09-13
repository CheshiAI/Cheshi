import { WalCheckpointValve } from './db/wal-valve';
import {
  IndexResult
} from './extraction';
import { EXTRACTION_VERSION } from './extraction/extraction-version';
import { CodeGraphPackageVersion } from './mcp/version';
import {
  startWalCheckpointValve,
  stopWalCheckpointValve
} from './project-lifecycle';
import type { IndexOptions } from './project-options';
import type { CodeGraphState } from './project-state';
import { minRefsForPool } from './resolution/resolver-pool';

// ===========================================================================
// Indexing
// ===========================================================================

/**
 * Index all files in the project
 *
 * Uses a mutex to prevent concurrent indexing operations.
 */
export async function indexAll(this: CodeGraphState, options: IndexOptions = {}): Promise<IndexResult> {
  this.assertWritable('index all files');
  return this.indexMutex.withLock(async () => {
    try {
      this.acquireFileLock();
    } catch {
      return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
    }
    // Defer WAL auto-checkpointing for the whole bulk run (#1231): the
    // default 1000-page interval re-writes hot pages into the main DB file
    // over and over — ~95% of all disk I/O during a bulk index, and a
    // 19+min → 45s difference on HDD-class storage. The valve bounds WAL
    // growth by backfilling PASSIVEly on a worker thread (never blocking
    // the writer or the #850 watchdog heartbeat); runMaintenance below does
    // the final fold-up before the interval is restored in the finally.
    // Kill switch: CODEGRAPH_NO_WAL_DEFER=1. Non-WAL journal modes (some
    // network filesystems) have no WAL to defer — skip.
    // Fast-init: on a COMPLETELY fresh DB, trade crash-durability for speed
    // during the bulk build (no fsync). WAL remains enabled so the dedicated
    // store writer and the resolver share a durable journal mode across the
    // fresh-build hand-off. Safe because the DB is disposable until the
    // index completes — index_state stays 'indexing' and a crashed init is
    // re-run from scratch; existing DBs (re-index/sync) never take this
    // path. Kill switch:
    // CODEGRAPH_NO_FAST_INIT=1 (same pattern as CODEGRAPH_NO_WAL_DEFER).
    const freshDb = this.queries.getNodeAndEdgeCount().nodes === 0;
    const fastInit = process.env.CODEGRAPH_NO_FAST_INIT !== '1' && freshDb;
    if (fastInit) {
      try {
        // Keep WAL enabled while disabling fsync for the disposable bulk
        // build. MEMORY journal mode is unsafe when the fresh-index store
        // writer and the resolver later reopen the same database: the
        // journal is connection-local and can surface as a disk I/O error
        // once the resolver starts deleting references.
        this.db.getDb().pragma('synchronous = OFF');
      } catch { /* keep WAL */ }
    }
    const deferWal = !fastInit && process.env.CODEGRAPH_NO_WAL_DEFER !== '1' && this.db.getJournalMode() === 'wal';
    let walValve: WalCheckpointValve | null = null;
    let priorAutocheckpoint = 1000;
    // Set when the fastInit+pool path below defers autocheckpointing, so the
    // finally knows to restore the interval on that path too.
    let restoreAutocheckpoint = false;
    if (deferWal) {
      const state = startWalCheckpointValve(this.db, options.verbose);
      walValve = state.walValve;
      priorAutocheckpoint = state.priorAutocheckpoint;
    }
    try {
      const before = this.queries.getNodeAndEdgeCount();
      // Mark the index as in-flight BEFORE any writes: a run killed
      // mid-index (OOM, SIGKILL, the #850 liveness watchdog) leaves this
      // marker behind, so `codegraph status` can tell a truncated index
      // from a completed one instead of silently serving partial results.
      try { this.queries.setMetadata('index_state', 'indexing'); } catch { /* metadata is advisory */ }
      // Segment vocabulary starts empty and is repopulated by the node write
      // path as every file (re-)indexes below — so a full index is also the
      // orphan-cleanup pass for names deleted since the last one.
      try { this.queries.clearNameSegmentVocab(); } catch { /* vocab is advisory — never fail an index over it */ }
      // Bulk FTS mode for the mass-insert phase: drop the per-row FTS sync
      // triggers, rebuild nodes_fts once from the nodes table afterwards.
      // Crash inside the window is healed on the next DatabaseConnection.open.
      this.db.beginBulkNodeLoad();
      // Fresh-init only: also drop the parse-lane secondary indexes for the
      // mass insert (the store-writer's B-tree-maintenance floor, plan §4d)
      // and rebuild each in one scan afterwards. Incremental runs keep them
      // — they delete per-file rows mid-phase through the file_path indexes.
      if (freshDb) this.db.beginBulkParseLoad();
      let result: IndexResult;
      try {
        result = await this.orchestrator.indexAll(
          options.onProgress,
          options.signal,
          options.verbose,
          walValve ? () => walValve!.backpressure() : undefined,
          // Store-writer offload is fresh-DB-only: with any pre-existing
          // data the store path must read (existing-file checks, cross-file
          // edge snapshots) and delete, which belongs on one thread.
          freshDb ? { dbPath: this.db.getPath(), fastInit } : null
        );
      } finally {
        if (freshDb) {
          const tIdx = Date.now();
          await this.db.endBulkParseLoad();
          if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] parse-index-rebuild: ${Date.now() - tIdx}ms`);
        }
        const tFts = Date.now();
        this.db.endBulkNodeLoad();
        if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] fts-rebuild: ${Date.now() - tFts}ms`);
      }

      // Fold the parse phase's WAL BEFORE the first post-parse reads
      // (resolver re-init and resolution both read on the main thread):
      // paging a bulk-write-sized WAL there is what blew the #850
      // watchdog's 60s window in the #1231 repro. Off-thread + awaited,
      // so the event loop keeps turning.
      if (walValve) await walValve.foldNow();

      // Re-detect frameworks now that the index is populated. The resolver
      // is constructed with createResolver() before any files exist, so
      // framework resolvers whose detect() consults the indexed file list
      // (e.g. UIKit/SwiftUI scanning for imports, swift-objc-bridge looking
      // for both Swift and ObjC files) all return false on that initial pass
      // and silently drop themselves. Re-initializing here gives them a
      // chance to see the actual project before resolution runs.
      if (result.success && result.filesIndexed > 0) {
        const tReinit = Date.now();
        this.resolver.initialize();
        // Cross-file finalization (e.g. NestJS RouterModule prefixes). Runs
        // before resolution so updated names show up in subsequent reads.
        this.resolver.runPostExtract();
        if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] resolver-reinit: ${Date.now() - tReinit}ms`);
      }

      // Resolve references to create call/import/extends edges
      if (result.success && result.filesIndexed > 0) {
        // Get count without loading all refs into memory
        const unresolvedCount = this.queries.getUnresolvedReferencesCount();

        // Fast-init leaves the DB in memory-journal (rollback) mode, where
        // the parallel resolver pool's read connections would contend with
        // the main writer's exclusive commits. When the pool will actually
        // run (enough pending refs), restore WAL BEFORE resolution so
        // readers never block the writer; otherwise stay in the fast mode
        // until the finally — sequential resolution has no readers.
        if (fastInit && unresolvedCount >= minRefsForPool()) {
          try {
            this.db.getDb().pragma('synchronous = NORMAL');
            this.db.getDb().pragma('journal_mode = WAL');
            // Defer auto-checkpointing for the resolution phase, same
            // rationale as the deferWal path above: at the default 1000-page
            // interval, the persist loop's edge inserts + ref deletes make
            // SQLite re-write hot B-tree pages into the main DB file inline
            // on the writer over and over (#1231's pathology — measured as
            // ~58% of the resolution phase on a 255k-ref repo). The valve
            // bounds WAL growth off-thread; runMaintenance does the final
            // fold and the finally restores the interval.
            priorAutocheckpoint = this.db.getWalAutocheckpoint();
            this.db.setWalAutocheckpoint(0);
            restoreAutocheckpoint = true;
            walValve = new WalCheckpointValve(
              this.db,
              undefined,
              undefined,
              options.verbose ? (m) => console.log(`[wal-valve] ${m}`) : undefined
            );
            walValve.start();
          } catch { /* keep current mode; resolution still works sequentially */ }
        }

        options.onProgress?.({
          phase: 'resolving',
          current: 0,
          total: unresolvedCount,
        });

        const tResolve = Date.now();
        await this.owner.resolveReferencesBatched(
          (current, total) => {
            options.onProgress?.({
              phase: 'resolving',
              current,
              total,
            });
          },
          (done, totalPasses) => {
            options.onProgress?.({
              phase: 'linking',
              current: done,
              total: totalPasses,
            });
          },
          walValve ? () => walValve!.backpressure() : undefined
        );
        if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] resolution: ${Date.now() - tResolve}ms`);

        // Second pass: chained calls whose method lives on a supertype the
        // receiver conforms to (protocol-extension / inherited / default-
        // interface). Needs the implements/extends edges the main pass just
        // built, so it runs after resolution (#750).
        const tChained = Date.now();
        await this.resolver.resolveChainedCallsViaConformance();
        if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[synth-timing] chainedConformance: ${Date.now() - tChained}ms`);
        // Same lifecycle for `this.<member>` callback registrations whose
        // member is inherited from a supertype (#808).
        const tDeferred = Date.now();
        await this.resolver.resolveDeferredThisMemberRefs();
        if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[synth-timing] deferredThisMember: ${Date.now() - tDeferred}ms`);
      }

      // Refresh planner stats + checkpoint the WAL after bulk writes.
      // Off-thread (worker connection): on a multi-GB index this is minutes
      // of IO, and inline it starved the #850 watchdog AFTER a fully
      // successful index. Never load-bearing for correctness.
      if (result.success && result.filesIndexed > 0) {
        const tMaint = Date.now();
        // Quiesce the valve first so its in-flight checkpoint and the
        // maintenance checkpoint don't contend for the checkpointer lock
        // (the loser would silently no-op and leave the WAL unfolded).
        await stopWalCheckpointValve(walValve);
        await this.db.runMaintenance();
        if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] maintenance: ${Date.now() - tMaint}ms`);
      }

      // The orchestrator only sees extraction-phase counts; resolution and
      // synthesizer edges (often >50% of the graph on JVM repos) come later.
      // Recompute against the DB so the CLI summary reports the true totals.
      if (result.success && result.filesIndexed > 0) {
        const tCount = Date.now();
        const after = this.queries.getNodeAndEdgeCount();
        if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] count-recompute: ${Date.now() - tCount}ms`);
        result.nodesCreated = after.nodes - before.nodes;
        result.edgesCreated = after.edges - before.edges;
      }

      // Stamp the index with the engine that built it, so `codegraph status`
      // can recommend a re-index when the running engine produces richer
      // extraction than the one on disk. Only on a
      // real full index — a sync touches a subset, so it must NOT advance the
      // extraction stamp (the bulk would still be stale). See extraction-version.ts.
      if (result.success && result.filesIndexed > 0) {
        try {
          this.queries.setMetadata('indexed_with_version', CodeGraphPackageVersion);
          this.queries.setMetadata('indexed_with_extraction_version', String(EXTRACTION_VERSION));
        } catch { /* metadata is advisory — never fail an index over it */ }
      }

      // Reconcile the scan's ground truth against what the pipeline
      // accounted for. A shortfall means files were silently dropped
      // (observed in the wild: a run under heavy load came up 37 files
      // short with no error) — record it and tell the user, don't let the
      // index pass as complete.
      try {
        if (!result.success) {
          this.queries.setMetadata('index_state', 'failed');
        } else {
          const accounted = result.filesIndexed + result.filesSkipped + result.filesErrored;
          const discovered = result.filesDiscovered;
          const shortfall = discovered !== undefined ? discovered - accounted : 0;
          if (discovered !== undefined && shortfall > 0) {
            this.queries.setMetadata('index_state', 'partial');
            this.queries.setMetadata('index_files_discovered', String(discovered));
            this.queries.setMetadata('index_files_accounted', String(accounted));
            result.errors.push({
              message: `Index is missing ${shortfall} of ${discovered} discovered files (indexed ${result.filesIndexed}, skipped ${result.filesSkipped}, errored ${result.filesErrored}). The index is PARTIAL — re-run \`codegraph index\`.`,
              severity: 'warning',
              code: 'index_partial',
            });
          } else {
            this.queries.setMetadata('index_state', 'complete');
            if (discovered !== undefined) {
              this.queries.setMetadata('index_files_discovered', String(discovered));
              this.queries.setMetadata('index_files_accounted', String(accounted));
            }
          }
        }
      } catch { /* metadata is advisory — never fail an index over it */ }

      return result;
    } finally {
      // Restore the auto-checkpoint interval AFTER the fold-up above so the
      // next ordinary write doesn't inherit a giant inline checkpoint. On
      // the error path the WAL may still be large; correctness is unchanged
      // (SQLite replays the WAL on the next open) and the follow-up write
      // that folds it is the known cost of a failed run.
      try {
        await stopWalCheckpointValve(walValve);
      } finally {
        if (deferWal || restoreAutocheckpoint) {
          try { this.db.setWalAutocheckpoint(priorAutocheckpoint); } catch { /* connection may be closing */ }
        }
        if (fastInit) {
          // Back to the durable defaults after the disposable bulk build.
          try {
            this.db.getDb().pragma('synchronous = NORMAL');
            this.db.getDb().pragma('journal_mode = WAL');
          } catch { /* connection may be closing */ }
        }
        this.fileLock.release();
      }
    }
  });
}

/**
   * Index specific files
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
export async function indexFiles(this: CodeGraphState, filePaths: string[]): Promise<IndexResult> {
  this.assertWritable('index files');
  return this.indexMutex.withLock(async () => {
    try {
      this.acquireFileLock();
    } catch {
      return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
    }
    try {
      return this.orchestrator.indexFiles(filePaths);
    } finally {
      this.fileLock.release();
    }
  });
}
