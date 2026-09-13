import { WalCheckpointValve } from './db/wal-valve';
import {
  SyncResult
} from './extraction';
import {
  startWalCheckpointValve,
  stopWalCheckpointValve
} from './project-lifecycle';
import type { IndexOptions } from './project-options';
import type { CodeGraphState } from './project-state';
import { LockUnavailableError } from './sync';

/**
   * Sync with current file state (incremental update)
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
export async function sync(this: CodeGraphState, options: IndexOptions = {}): Promise<SyncResult> {
  this.assertWritable('sync');
  return this.indexMutex.withLock(async () => {
    try {
      this.acquireFileLock();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new LockUnavailableError(`CodeGraph sync could not acquire the file lock: ${reason}`);
    }
    // Defer WAL auto-checkpointing for the whole incremental run, exactly
    // as indexAll does for the bulk path (#1231): sync's store loop and its
    // resolution passes churn the same FTS + secondary-index hot pages, and
    // at the default 1000-page cadence the inline checkpoints re-write them
    // over and over — on HDD-class storage a 7-file sync took 2 minutes at
    // 0-2% CPU (#1248). The cost scales with the EXISTING database size,
    // not the change size, so small syncs on big indexes hurt most. The
    // valve bounds WAL growth off-thread; runMaintenance at the end does
    // the final fold-up before the interval is restored in the finally.
    // Same kill switch as indexAll: CODEGRAPH_NO_WAL_DEFER=1. Idle valve
    // cost is one timer, so watcher-frequency syncs stay cheap.
    const deferWal = process.env.CODEGRAPH_NO_WAL_DEFER !== '1' && this.db.getJournalMode() === 'wal';
    let walValve: WalCheckpointValve | null = null;
    let priorAutocheckpoint = 1000;
    if (deferWal) {
      const state = startWalCheckpointValve(this.db, options.verbose);
      walValve = state.walValve;
      priorAutocheckpoint = state.priorAutocheckpoint;
    }
    try {
      // Captured BEFORE the sync runs: the sync's own incremental writes
      // populate vocab rows for the files it touches, so an end-of-sync
      // emptiness check would see "non-empty" and skip the backfill forever,
      // leaving every unchanged file's names unsegmented.
      const vocabWasEmpty = (() => {
        try { return this.queries.isNameSegmentVocabEmpty(); } catch { return false; }
      })();

      const result = await this.orchestrator.sync(options.onProgress, options.paths);

      // Fold the store phase's WAL BEFORE the post-store reads below
      // (resolution reads on the main thread) — same rationale as
      // indexAll's fold between store and resolution.
      if (walValve) await walValve.foldNow();

      // Cross-file finalization (e.g. NestJS RouterModule prefixes). Run on
      // every sync that touched files so edits to `app.module.ts` propagate
      // to controllers in unchanged files. The pass is idempotent and cheap
      // (regex over *.module.ts only).
      if (result.filesAdded > 0 || result.filesModified > 0) {
        this.resolver.runPostExtract();
      } else if (result.filesRemoved > 0) {
        // A pure-removal sync still resolves refs below — the deletion path
        // resurrects the removed file's incoming edges as pending refs
        // (#1240 removal case) and the orphan sweep consumes them. In a
        // long-lived process (daemon) the resolver's name caches were
        // warmed against the pre-removal graph; drop them so resolution
        // sees the post-removal state. (runPostExtract above clears caches
        // itself, so the changed-files branch is already covered.)
        this.resolver.clearCaches();
      }

      // Resolve references if files were updated
      const filesChanged = result.filesAdded > 0 || result.filesModified > 0;
      if (filesChanged) {
        if (result.changedFilePaths) {
          // Scope resolution to changed files (git fast path — bounded set)
          const tRefLoad = Date.now();
          const unresolvedRefs = this.queries.getUnresolvedReferencesByFiles(result.changedFilePaths);
          if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] sync-ref-load: ${Date.now() - tRefLoad}ms (${unresolvedRefs.length} refs)`);

          options.onProgress?.({
            phase: 'resolving',
            current: 0,
            total: unresolvedRefs.length,
          });

          await this.resolver.resolveAndPersistListYielding(
            unresolvedRefs,
            (current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            },
            walValve ? () => walValve!.backpressure() : undefined,
          );

          // Retry previously-failed refs the changed files may now satisfy
          // (#1240). Scoped resolution above only re-resolves refs FROM the
          // changed files — but when a changed file gains an export/symbol,
          // refs in UNCHANGED files that failed against the old graph can
          // now resolve, and nothing else ever revisits them (their rows
          // were parked as status='failed' by an earlier completed pass).
          // Look them up by the symbol names the changed files now carry
          // and re-resolve just that set. On a sync where no failed ref
          // matches, this is one indexed lookup.
          const tRetry = Date.now();
          const retryable = this.queries.getRetryableFailedReferences(
            this.queries.getNodeNamesByFiles(result.changedFilePaths)
          );
          if (retryable.length > 0) {
            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: retryable.length,
            });
            await this.resolver.resolveAndPersistListYielding(
              retryable,
              undefined,
              walValve ? () => walValve!.backpressure() : undefined,
            );
            options.onProgress?.({
              phase: 'resolving',
              current: retryable.length,
              total: retryable.length,
            });
          }
          if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] sync-failed-ref-retry: ${Date.now() - tRetry}ms (${retryable.length} refs)`);
        } else {
          // No git info — use batched resolution to avoid OOM
          const unresolvedCount = this.queries.getUnresolvedReferencesCount();

          options.onProgress?.({
            phase: 'resolving',
            current: 0,
            total: unresolvedCount,
          });

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
        }
      }

      // Orphan sweep (#1187). A resolution pass that dies mid-run — the #850
      // daemon liveness watchdog's SIGKILL (#1122), Ctrl-C, a crash — leaves
      // the refs it never reached in unresolved_refs, and the git-scoped fast
      // path above never revisits them (it reads only the changed files'
      // rows). Those files' call edges were then missing PERMANENTLY, with
      // nothing to see except a too-small blast radius, until a full
      // re-index. A completed pass takes every row it processed out of the
      // PENDING set (resolved rows are deleted, unresolvable ones parked as
      // status='failed' for the #1240 retry above), so any pending row now
      // is such an orphan — or a row from an older engine's scoped pass.
      // Grind them down with the batched resolver; this also makes a bare
      // `codegraph sync` the recovery command for a wedged index. On a
      // healthy index this is one COUNT query.
      const orphanCount = this.queries.getUnresolvedReferencesCount();
      if (orphanCount > 0) {
        options.onProgress?.({
          phase: 'resolving',
          current: 0,
          total: orphanCount,
        });

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
      }

      if (filesChanged || orphanCount > 0) {
        // Second pass: chained calls whose method lives on a supertype the
        // receiver conforms to (protocol-extension / inherited). Needs the
        // implements/extends edges built above (#750).
        await this.resolver.resolveChainedCallsViaConformance();
        // Same lifecycle for `this.<member>` callback registrations whose
        // member is inherited from a supertype (#808).
        await this.resolver.resolveDeferredThisMemberRefs();
      }

      // Refresh planner stats + checkpoint the WAL after bulk writes.
      // Off-thread — see indexAll's call site.
      if (filesChanged || result.filesRemoved > 0 || orphanCount > 0) {
        await stopWalCheckpointValve(walValve);
        await this.db.runMaintenance();
      }

      // Heal the segment vocabulary on indexes built before the table
      // existed (upgrade path): incremental writes above only cover changed
      // files, so a vocab that was empty when this sync STARTED means the
      // bulk was never segmented — backfill it (INSERT OR IGNORE, so the
      // rows the sync just wrote are fine). Batched + yielding — sync can
      // run on the daemon's liveness-watchdog thread (#850/#1091).
      try {
        if (vocabWasEmpty && this.queries.getNodeAndEdgeCount().nodes > 0) {
          await this.rebuildNameSegmentVocab();
        }
      } catch { /* vocab is advisory — never fail a sync over it */ }

      return result;
    } finally {
      // Mirror indexAll's teardown: stop the valve, then restore the
      // auto-checkpoint interval (runMaintenance above already folded the
      // WAL on the success path; on the error path SQLite replays it on
      // the next open).
      try {
        await stopWalCheckpointValve(walValve);
      } finally {
        if (deferWal) {
          try { this.db.setWalAutocheckpoint(priorAutocheckpoint); } catch { /* connection may be closing */ }
        }
        this.fileLock.release();
      }
    }
  });
}
