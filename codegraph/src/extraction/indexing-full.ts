import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { logWarn } from '../errors';
import { loadExtensionOverrides } from '../project-config';
import { createYielder } from '../resolution/cooperative-yield';
import { codeGraphRuntimePath } from '../runtime-paths';
import {
  ExtractionError,
  ExtractionResult
} from '../types';
import { validatePathWithinRoot } from '../utils';
import {
  detectLanguage,
  initGrammars,
  isFileLevelOnlyLanguage,
  loadGrammarsForLanguages,
  readGrammarWasmBytes
} from './grammars';
import {
  FILE_IO_BATCH_SIZE,
  type IndexProgress,
  type IndexResult,
  MAX_FILE_SIZE,
  PARSE_TIMEOUT_MS,
  WORKER_RECYCLE_INTERVAL
} from './indexing-contracts';
import type { ExtractionState } from './indexing-state';
import { materializeKernelResult } from './kernel';
import { ParseWorkerPool, resolveParsePoolSize } from './parse-pool';
import { scanDirectoryAsync } from './scan-directory';
import { StoreWriter } from './store-writer';
import { extractFromSource } from './tree-sitter';


/**
   * Index all files in the project
   */
export async function indexAll(this: ExtractionState, onProgress?: (progress: IndexProgress) => void, signal?: AbortSignal, verbose?: boolean, walBackpressure?: () => Promise<void> | null, storeWriterOpts?: { dbPath: string; fastInit: boolean } | null): Promise<IndexResult> {
  const tGrammar = Date.now();
  await initGrammars();
  if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] grammar-init: ${Date.now() - tGrammar}ms`);
  const startTime = Date.now();
  const errors: ExtractionError[] = [];
  let filesIndexed = 0;
  let filesSkipped = 0;
  let filesErrored = 0;
  let totalNodes = 0;
  let totalEdges = 0;

  // Custom extension → language overrides from the project's codegraph.json.
  // Threaded into language detection so custom-extension files load the right
  // grammar and store under the mapped language.
  const overrides = loadExtensionOverrides(this.rootDir);

  const log = verbose
    ? (msg: string) => { console.log(`[worker] ${msg}`); }
    : (_msg: string) => { };

  // Phase 1: Scan for files
  onProgress?.({
    phase: 'scanning',
    current: 0,
    total: 0,
  });

  // Phase attribution to stderr (same opt-in as the synthesis timings):
  // early-run 5-10s single stalls were observed on 95k-file repos but never
  // attributed — these labels settle scan vs framework-detect vs grammars.
  const tScan = Date.now();
  const files = await scanDirectoryAsync(this.rootDir, (current, file) => {
    onProgress?.({
      phase: 'scanning',
      current,
      total: 0,
      currentFile: file,
    });
  });
  if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] scan: ${Date.now() - tScan}ms (${files.length} files)`);

  // Detect frameworks once per indexAll run using the scanned file list.
  // Names are passed to each parse call so framework-specific extractors
  // (route nodes, middleware, etc.) run after the tree-sitter pass.
  // Framework detection is reset each run so adding e.g. requirements.txt
  // between runs is picked up without restarting the process.
  this.detectedFrameworkNames = null;
  const tFw = Date.now();
  const frameworkNames = this.ensureDetectedFrameworks(files);
  if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] framework-detect: ${Date.now() - tFw}ms`);

  if (signal?.aborted) {
    return {
      success: false,
      filesIndexed: 0,
      filesSkipped: 0,
      filesErrored: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      errors: [{ message: 'Aborted', severity: 'error' }],
      durationMs: Date.now() - startTime,
    };
  }

  // Phase 2: Parse files in a worker thread (keeps main thread unblocked for UI)
  const total = files.length;
  let processed = 0;

  // Emit parsing phase immediately so the progress bar appears during worker setup.
  // The yield lets the shimmer worker flush the phase transition to stdout before
  // the main thread starts synchronous grammar detection work.
  onProgress?.({
    phase: 'parsing',
    current: 0,
    total,
  });
  await new Promise(resolve => setImmediate(resolve));

  // Detect needed languages and load grammars in the parse worker
  const neededLanguages = [...new Set(files.map((f) => detectLanguage(f, undefined, overrides)))];
  // .h files default to 'c' but may be C++ — ensure cpp grammar is loaded when c is needed
  if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
    neededLanguages.push('cpp');
  }

  // Parse files on a pool of worker threads (keeps the main thread free for UI
  // and uses every core). Bun executes the TypeScript worker directly.
  const parseWorkerPath = codeGraphRuntimePath('workers', 'parse-worker.js')
    ?? path.join(__dirname, 'parse-worker.ts');
  const useWorker = fs.existsSync(parseWorkerPath);

  let pool: ParseWorkerPool | null = null;
  let storeWriter: StoreWriter | null = null;
  await using workerCleanup = new AsyncDisposableStack();
  workerCleanup.defer(async () => {
    // Every path after worker creation — parse/store exceptions, retry-store
    // failures, aborts, and successful returns — must release both pools.
    // Close the writer first so its DB handle is gone before parse workers
    // terminate; the nested finally guarantees one cleanup cannot skip the
    // other.
    try {
      if (storeWriter) await storeWriter.close();
    } finally {
      if (pool) await pool.destroy();
    }
  });

  if (useWorker) {
    // CODEGRAPH_PARSE_WORKERS: explicit worker count; 1 = the old single-worker
    // behaviour (the conservative rollback). Unset → clamp(cores-1, 1, 8),
    // with cores from availableParallelism — cpuset/affinity-honest, where
    // os.cpus() enumerates the host's CPUs and spawned 8 wasm workers (and
    // their grammar heaps) inside a 2-CPU container for zero extra
    // throughput (§7a.1). Floored so a 2-core box still gets 2 workers:
    // parse is worker-side CPU, and 1 worker measured 34% slower than the
    // old oversubscribed pool on the kernel-scale 2-cpuset envelope
    // (493s vs 369s) — main + store-worker don't fill the second core.
    const poolSize = resolveParsePoolSize(process.env.CODEGRAPH_PARSE_WORKERS, Math.max(3, os.availableParallelism()));
    // Read each needed grammar's WASM ONCE here and hand the bytes to every
    // worker, so spawns/respawns load grammars from memory instead of
    // re-reading them from disk (#1231: on an HDD, respawn re-reads amplify
    // the very I/O contention that caused the respawn).
    const grammarBuffers = await readGrammarWasmBytes(neededLanguages);
    pool = new ParseWorkerPool({
      languages: neededLanguages,
      size: poolSize,
      workerScriptPath: parseWorkerPath,
      recycleInterval: WORKER_RECYCLE_INTERVAL,
      parseTimeoutMs: PARSE_TIMEOUT_MS,
      log,
      grammarBuffers,
    });
    log(`Parse worker pool: ${poolSize} worker(s)`);
    // Bulk index: every core will be needed — spawn the whole pool now so
    // worker boot overlaps the first read batches instead of trickling in
    // behind queue-pressure growth.
    pool.prewarm();
  } else {
    // In-process fallback: load grammars locally and parse on the main thread.
    await loadGrammarsForLanguages(neededLanguages);
  }

  // Dedicated store writer thread (fresh DB only — see the parameter doc).
  // Same availability rule as the parse pool: needs the sibling source worker.
  const storeWorkerPath = codeGraphRuntimePath('workers', 'store-worker.js')
    ?? path.join(__dirname, 'store-worker.ts');
  if (
    storeWriterOpts &&
    process.env.CODEGRAPH_NO_STORE_WORKER !== '1' &&
    fs.existsSync(storeWorkerPath)
  ) {
    // Deliberately NOT awaiting ready(): worker_threads delivers messages in
    // order, so bundles posted while the worker is still booting queue
    // behind 'open'. A boot failure surfaces at the first drain() — same
    // propagation point as a store error.
    storeWriter = new StoreWriter(storeWorkerPath, storeWriterOpts.dbPath, storeWriterOpts.fastInit);
    log('Store writer thread active');
  }
  /** Queue-depth bound for un-acked bundles (bundles hold whole node/edge arrays). */
  const STORE_WRITER_WINDOW = 64;

  /**
   * Parse one file: on the pool when available (the promise REJECTS on a worker
   * crash/timeout — the caller records it and the retry pass re-attempts), or
   * in-process synchronously as the no-worker fallback. The language is resolved
   * here on the main thread, where the codegraph.json overrides are loaded.
   */
  const parseFile = (filePath: string, content: string): Promise<ExtractionResult> => {
    const language = detectLanguage(filePath, content, overrides);
    if (!pool) return Promise.resolve(extractFromSource(filePath, content, language, frameworkNames));
    return pool.requestParse({ filePath, content, language, frameworkNames });
  };

  // --- Bounded rolling-window dispatch, ordered commit ---
  // Reads stay batched/parallel; parses run concurrently across the pool; the
  // SQLite store stays on the main thread (it isn't thread-safe). Crucially we
  // COMMIT results in original file order, not parse-completion order: the
  // resolution phase (run after indexing) resolves an ambiguous reference to one
  // of several same-named candidates by the nodes' DB insertion order, so a
  // stable commit order keeps the resulting graph deterministic — byte-identical
  // to the single-worker path — instead of drifting with parse timing. The
  // `completed` buffer holds at most ~windowSize out-of-order results, so memory
  // stays bounded.
  const windowSize = pool ? Math.max(4, pool.size * 2) : 1;
  const inFlight = new Set<Promise<void>>();
  const completed = new Map<number,
    | { ok: true; filePath: string; content: string; stats: fs.Stats; result: ExtractionResult }
    | { ok: false; filePath: string; err: unknown }>();
  let nextSeq = 0;       // file-order sequence assigned at dispatch
  let nextToStore = 0;   // cursor: next sequence to commit
  let aborted = false;

  // Yielder for the in-order commit path: a single giant generated file's
  // store is otherwise one unyielding multi-second transaction span on the
  // main thread (5–14s single stalls measured on llvm-project), starving
  // the #850 watchdog heartbeat on slow hardware.
  const commitYield = createYielder();

  const storeResult = async (filePath: string, content: string, stats: fs.Stats, result: ExtractionResult): Promise<void> => {
    processed++;

    // WAL hard-cap backstop: between files (never mid-transaction), pause
    // the store until the off-thread checkpoint catches up. Resolves to
    // null in the normal case — a single size check, no cost.
    const bp = walBackpressure?.();
    if (bp) await bp;

    // Kernel deferred-decode results carry table sizes in kernelCounts
    // (their object arrays are empty — decode happens at the store).
    const nodeCount = result.kernelCounts?.nodes ?? result.nodes.length;
    const edgeCount = result.kernelCounts?.edges ?? result.edges.length;

    // Store: on the writer thread when active (fresh DB — bundles applied
    // in the same file order this chain dispatches them), else on the main
    // thread (SQLite connections are per-thread).
    if (nodeCount > 0 || result.errors.length === 0) {
      const language = detectLanguage(filePath, content, overrides);
      if (storeWriter) {
        if (result.kernelBuffers) {
          // Buffers go to the writer as-is; the worker decodes + finalizes.
          // The main thread's only per-file work stays O(1) + the content hash.
          storeWriter.send({
            kernel: true,
            filePath,
            language,
            buffers: result.kernelBuffers,
            file: this.buildFileRecord(filePath, content, language, stats, nodeCount, result.errors),
          });
        } else {
          storeWriter.send(this.buildFreshStoreBundle(filePath, content, language, stats, result));
        }
        await storeWriter.waitBelow(STORE_WRITER_WINDOW);
      } else {
        const materialized = materializeKernelResult(result, filePath, language);
        await this.storeExtractionResult(filePath, content, language, stats, materialized, commitYield);
      }
    }

    if (result.errors.length > 0) {
      for (const err of result.errors) {
        if (!err.filePath) err.filePath = filePath;
      }
      errors.push(...result.errors);
    }

    if (nodeCount > 0) {
      filesIndexed++;
      totalNodes += nodeCount;
      totalEdges += edgeCount;
    } else if (result.errors.some((e) => e.severity === 'error')) {
      filesErrored++;
    } else {
      // Files with no symbols but no errors (yaml, twig, properties) are
      // tracked at the file level — count them as indexed so the CLI doesn't
      // misleadingly report "No files found to index".
      const lang = detectLanguage(filePath, content, overrides);
      if (isFileLevelOnlyLanguage(lang)) {
        filesIndexed++;
      } else {
        filesSkipped++;
      }
    }

    onProgress?.({ phase: 'parsing', current: processed, total, currentFile: filePath });
  };

  const recordParseFailure = (filePath: string, err: unknown): void => {
    processed++;
    filesErrored++;
    errors.push({
      message: err instanceof Error ? err.message : String(err),
      filePath,
      severity: 'error',
      code: 'parse_error',
    });
    onProgress?.({ phase: 'parsing', current: processed, total });
  };

  // Commit buffered parses to the DB in file order, advancing the cursor over
  // contiguous completed results. Runs after each parse settles (and once more
  // after the drain). storeResult is now async (it yields between chunked
  // inserts), so commits are SERIALIZED on a promise chain — concurrent parse
  // completions append to the chain instead of interleaving mid-store, which
  // preserves both the file-order commit invariant (#1015: resolution
  // disambiguates same-named candidates by insertion order) and the
  // single-writer discipline for SQLite. Errors are recorded and re-thrown
  // at the drain, matching the old synchronous propagation.
  let flushChain: Promise<void> = Promise.resolve();
  let flushError: unknown = null;
  const flushOrdered = (): Promise<void> => {
    flushChain = flushChain.then(async () => {
      if (aborted || flushError) return;
      try {
        while (completed.has(nextToStore)) {
          const item = completed.get(nextToStore)!;
          completed.delete(nextToStore);
          nextToStore++;
          if (item.ok) await storeResult(item.filePath, item.content, item.stats, item.result);
          else recordParseFailure(item.filePath, item.err);
        }
      } catch (err) {
        flushError = err;
      }
    });
    return flushChain;
  };

  // Dispatch one file's parse (parses run concurrently across the pool), tagged
  // with its file-order sequence so flushOrdered commits results in order. The
  // backpressure below bounds how far parsing runs ahead of the in-order commit.
  const feed = async (filePath: string, content: string, stats: fs.Stats): Promise<void> => {
    const seq = nextSeq++;
    const p = (async () => {
      try {
        const result = await parseFile(filePath, content);
        completed.set(seq, { ok: true, filePath, content, stats, result });
      } catch (parseErr) {
        completed.set(seq, { ok: false, filePath, err: parseErr });
      }
      await flushOrdered();
    })();
    const tracked = p.finally(() => { inFlight.delete(tracked); });
    inFlight.add(tracked);
    // Backpressure on the dispatched-but-not-yet-committed count (in-flight +
    // buffered), not just in-flight: a slow file sitting at the commit cursor
    // lets later parses finish and buffer, which would otherwise grow without
    // bound. Wait for parses to settle (each may advance the cursor) until the
    // window has room. When nothing is in flight but the window is still full,
    // the async commit chain is what's behind — await it so the cursor
    // advances (buffered items hold whole file contents, so this bound is
    // load-bearing for memory).
    while (nextSeq - nextToStore >= windowSize) {
      if (inFlight.size > 0) await Promise.race(inFlight);
      else await flushOrdered();
    }
  };

  const tParseLoop = Date.now();
  for (let i = 0; i < files.length; i += FILE_IO_BATCH_SIZE) {
    if (signal?.aborted) { aborted = true; break; }

    const batch = files.slice(i, i + FILE_IO_BATCH_SIZE);

    // Read files in parallel (with path validation before any I/O)
    const fileContents = await Promise.all(
      batch.map(async (fp) => {
        try {
          // Indexing read: follow in-root symlinks the directory walk already
          // descended into (the `../` guard still applies) so files reached
          // via an in-root symlink-to-outside still index (#935).
          const fullPath = validatePathWithinRoot(this.rootDir, fp, { allowSymlinkEscape: true });
          if (!fullPath) {
            logWarn('Path traversal blocked in batch reader', { filePath: fp });
            return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: new Error('Path traversal blocked') };
          }
          const content = await fsp.readFile(fullPath, 'utf-8');
          const stats = await fsp.stat(fullPath);
          return { filePath: fp, content, stats, error: null as Error | null };
        } catch (err) {
          return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: err as Error };
        }
      })
    );

    // Dispatch each readable file into the bounded parse window; the window
    // stores results on the main thread as they arrive.
    for (const { filePath, content, stats, error } of fileContents) {
      if (signal?.aborted) { aborted = true; break; }

      if (error || content === null || stats === null) {
        processed++;
        filesErrored++;
        errors.push({
          message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
          filePath,
          severity: 'error',
          code: 'read_error',
        });
        onProgress?.({ phase: 'parsing', current: processed, total });
        continue;
      }

      // Honour MAX_FILE_SIZE. Without this check, vendored generated
      // headers, minified bundles, and other multi-MB files get indexed,
      // wasting WASM heap and the worker recycle budget on inputs with no
      // useful symbols. The single-file extractFile path already enforces
      // this; the bulk path used to silently skip the check.
      if (stats.size > MAX_FILE_SIZE) {
        processed++;
        filesSkipped++;
        errors.push({
          message: `File exceeds max size (${stats.size} > ${MAX_FILE_SIZE})`,
          filePath,
          severity: 'warning',
          code: 'size_exceeded',
        });
        onProgress?.({ phase: 'parsing', current: processed, total });
        continue;
      }

      // Parse on the pool (main thread stays unblocked). Errors/timeouts are
      // handled inside feed() → recordParseFailure, feeding the retry pass.
      await feed(filePath, content, stats);
    }

    if (aborted) break;
  }

  // Drain parses still in flight (skip on abort — we tear down below instead),
  // then commit any results the cursor hasn't reached yet.
  if (!aborted) {
    await Promise.all(inFlight);
    await flushOrdered();
    if (flushError) {
      throw flushError;
    }
    // All bundles are posted; wait for the writer to apply them, then close
    // its connection BEFORE any main-thread DB work below (retry pass,
    // resolution) so exactly one connection writes at a time.
    if (storeWriter) {
      try {
        await storeWriter.drain();
      } finally {
        await storeWriter.close();
        storeWriter = null;
      }
    }
  }
  if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] parse-loop: ${Date.now() - tParseLoop}ms`);

  if (signal?.aborted || aborted) {
    return {
      success: false,
      filesIndexed,
      filesSkipped,
      filesErrored,
      filesDiscovered: total,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors: [{ message: 'Aborted', severity: 'error' }, ...errors],
      durationMs: Date.now() - startTime,
    };
  }

  // Report 100% so the progress bar doesn't hang at 99%
  onProgress?.({
    phase: 'parsing',
    current: total,
    total,
  });

  // Yield so the shimmer worker's buffered stdout writes can flush.
  // Worker thread stdout is proxied through the main thread's event loop,
  // so synchronous work here blocks the animation from rendering.
  await new Promise(resolve => setImmediate(resolve));

  // Retry pass: files that failed due to WASM memory corruption may succeed
  // on a fresh worker with a clean heap. Recycle before each attempt so
  // every file gets the absolute cleanest WASM state possible. Timeouts are
  // retried too (#1231): most are main-thread-stall artifacts, not slow
  // parses, and this pass parses one file at a time with the store strictly
  // after each parse resolves, so the stall window can't recur here.
  const retryableErrors = errors.filter(
    (e) => e.code === 'parse_error' && e.filePath &&
      (e.message.includes('Worker exited') ||
        e.message.includes('memory access out of bounds') ||
        e.message.includes('timed out'))
  );

  if (retryableErrors.length > 0 && pool) {
    log(`Retrying ${retryableErrors.length} files that failed due to WASM memory errors or timeouts...`);

    // Fresh WASM heaps for the retry phase. A retry that still crashes its
    // worker makes the pool respawn it, so later retries keep landing on clean
    // workers too.
    pool.recycleAll();

    const stillFailing: typeof retryableErrors = [];

    for (const errEntry of retryableErrors) {
      const filePath = errEntry.filePath!;
      if (signal?.aborted) break;

      let content: string;
      try {
        const fullPath = validatePathWithinRoot(this.rootDir, filePath);
        if (!fullPath) continue;
        content = await fsp.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }

      let result: ExtractionResult;
      try {
        result = await parseFile(filePath, content);
      } catch {
        stillFailing.push(errEntry);
        continue;
      }

      if (result.nodes.length > 0 || result.errors.length === 0) {
        const language = detectLanguage(filePath, content, overrides);
        const stats = await fsp.stat(path.join(this.rootDir, filePath));
        await this.storeExtractionResult(filePath, content, language, stats, result, commitYield);

        const idx = errors.indexOf(errEntry);
        if (idx >= 0) errors.splice(idx, 1);
        filesErrored--;
        filesIndexed++;
        totalNodes += result.nodes.length;
        totalEdges += result.edges.length;
        log(`Retry OK: ${filePath} (${result.nodes.length} nodes)`);
      }
    }

    // Last resort: for files that still crash on a clean worker, strip
    // comment-only lines to reduce WASM memory pressure. Many compiler
    // test files are 90%+ comments (CHECK directives) that don't contribute
    // code nodes but consume parser memory.
    if (stillFailing.length > 0) {
      log(`${stillFailing.length} files still failing — retrying with comments stripped...`);
      pool.recycleAll();

      for (const errEntry of stillFailing) {
        const filePath = errEntry.filePath!;
        if (signal?.aborted) break;

        let fullContent: string;
        try {
          const fullPath = validatePathWithinRoot(this.rootDir, filePath);
          if (!fullPath) continue;
          fullContent = await fsp.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }

        // Strip lines that are entirely comments (preserving line numbers
        // by replacing with empty lines so node positions stay correct)
        const stripped = fullContent
          .split('\n')
          .map(line => /^\s*\/\//.test(line) ? '' : line)
          .join('\n');

        let result: ExtractionResult;
        try {
          result = await parseFile(filePath, stripped);
        } catch {
          continue;
        }

        if (result.nodes.length > 0 || result.errors.length === 0) {
          const language = detectLanguage(filePath, fullContent, overrides);
          const stats = await fsp.stat(path.join(this.rootDir, filePath));
          await this.storeExtractionResult(filePath, fullContent, language, stats, result, commitYield);

          const idx = errors.indexOf(errEntry);
          if (idx >= 0) errors.splice(idx, 1);
          filesErrored--;
          filesIndexed++;
          totalNodes += result.nodes.length;
          totalEdges += result.edges.length;
          log(`Retry (stripped) OK: ${filePath} (${result.nodes.length} nodes)`);
        }
      }
    }
  }

  return {
    success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
    filesIndexed,
    filesSkipped,
    filesErrored,
    filesDiscovered: total,
    nodesCreated: totalNodes,
    edgesCreated: totalEdges,
    errors,
    durationMs: Date.now() - startTime,
  };
}
