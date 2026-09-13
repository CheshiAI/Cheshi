import { ExtractionError } from '../types';
import { resolveParseTimeoutMs } from './parse-pool';
import * as crypto from 'crypto';

/**
 * Number of files to read in parallel during indexing.
 * File reads are I/O-bound; batching overlaps I/O wait with CPU parse work.
 */
export const FILE_IO_BATCH_SIZE = 10;

/**
 * How many files the `sync()` reconcile processes between cooperative yields to
 * the event loop. The reconcile runs two O(files) loops of synchronous `fs`
 * calls (existsSync for removals, statSync for adds/mods); on a very large repo
 * (~100k files) an un-yielded run wedges the main thread for minutes, which both
 * trips the liveness watchdog (it SIGKILLs a process whose loop stops turning)
 * and blocks the first MCP tool call behind the catch-up gate (issue #905).
 * Yielding every N files keeps the socket, the watchdog heartbeat, and any
 * concurrent read query responsive while the reconcile runs.
 */
export const SYNC_RECONCILE_YIELD_INTERVAL = 1000;

// PARSER_RESET_INTERVAL moved to parse-worker.ts (runs in worker thread)

/**
 * Maximum time (ms) to wait for a single file to parse in the worker thread.
 * If tree-sitter hangs or WASM runs out of memory, this prevents the entire
 * indexing run from freezing. The worker is restarted after a (hard) timeout.
 * Env-overridable via CODEGRAPH_PARSE_TIMEOUT_MS for slow storage (#1231).
 */
export const PARSE_TIMEOUT_MS = resolveParseTimeoutMs(process.env.CODEGRAPH_PARSE_TIMEOUT_MS);

/**
 * Number of files to parse before recycling the worker thread.
 * WASM linear memory can grow but NEVER shrink (WebAssembly spec limitation).
 * The only way to reclaim tree-sitter's WASM heap is to destroy the entire
 * V8 isolate by terminating the worker thread and spawning a fresh one.
 * This interval balances memory usage against the cost of reloading grammars.
 */
export const WORKER_RECYCLE_INTERVAL = 250;

/**
 * Progress callback for indexing operations
 */
export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'storing' | 'resolving' | 'linking';
  current: number;
  total: number;
  currentFile?: string;
}

/**
 * Result of an indexing operation
 */
export interface IndexResult {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  /**
   * How many indexable files the scan discovered — the ground truth the
   * indexed/skipped/errored tallies must add up to. A shortfall means files
   * were silently dropped mid-pipeline (e.g. a killed worker under load) and
   * the index is PARTIAL; callers surface that rather than trusting the
   * counts. Only set by full-index runs (indexAll), not indexFiles/sync.
   */
  filesDiscovered?: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: ExtractionError[];
  durationMs: number;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
  durationMs: number;
  changedFilePaths?: string[];
}

/**
 * Calculate SHA256 hash of file contents
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Skip files larger than this (bytes). Generated bundles, minified JS, and
 * vendored blobs blow the WASM heap and the worker-recycle budget for no useful
 * symbols. 1 MB covers essentially all hand-written source.
 */
export const MAX_FILE_SIZE = 1024 * 1024;
