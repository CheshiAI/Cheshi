import { Edge, UnresolvedReference } from '../types';
import { createYielder, type MaybeYield } from './cooperative-yield';
import {
  matchDottedCallChain,
  matchMethodCall,
  matchScopedCallChain
} from './name-matcher';
import {
  PHP_PROP_SHAPE,
  SCOPED_CHAIN_LANGUAGES
} from './resolver-rules';
import type { ResolverState } from './resolver-state';
import {
  ResolutionResult,
  ResolvedRef,
  UnresolvedRef
} from './types';


/**
   * Create edges from resolved references
   */
export function createEdges(this: ResolverState, resolved: ResolvedRef[]): Edge[] {
  return resolved.map((ref) => {
    // `function_ref` (#756) is internal-only: it persists as a `references`
    // edge (the registration site depends on the callback), distinguishable
    // by metadata.resolvedBy === 'function-ref'. callers/impact already
    // traverse `references`, so registration sites surface with no
    // graph-layer changes.
    let kind: Edge['kind'] =
      ref.original.referenceKind === 'function_ref' ? 'references' : ref.original.referenceKind;

    // Promote "extends" to "implements" when a class/struct targets an interface
    if (kind === 'extends') {
      const targetNode = this.queries.getNodeById(ref.targetNodeId);
      if (targetNode && (targetNode.kind === 'interface' || targetNode.kind === 'protocol')) {
        const sourceNode = this.queries.getNodeById(ref.original.fromNodeId);
        if (sourceNode && sourceNode.kind !== 'interface' && sourceNode.kind !== 'protocol') {
          kind = 'implements';
        }
      }
    }

    // Promote "calls" to "instantiates" when the resolved target is a
    // class/struct. Languages without a `new` keyword (Python, Ruby)
    // express instantiation as `Foo()` — extraction can't tell that
    // apart from a function call without symbol info, but resolution
    // can: if `Foo` resolves to a class, the call IS an instantiation.
    if (kind === 'calls') {
      const targetNode = this.queries.getNodeById(ref.targetNodeId);
      if (targetNode && (targetNode.kind === 'class' || targetNode.kind === 'struct')) {
        kind = 'instantiates';
      }
    }

    return {
      source: ref.original.fromNodeId,
      target: ref.targetNodeId,
      kind,
      line: ref.original.line,
      column: ref.original.column,
      metadata: {
        confidence: ref.confidence,
        resolvedBy: ref.resolvedBy,
        // The ORIGINAL reference text (and kind, when edge-kind promotion
        // rewrote it — calls→instantiates, extends→implements,
        // function_ref→references). If this edge's target is later removed
        // by a re-index, the edge is resurrected as exactly this ref and
        // re-resolved (#1240 removal case) — a faithful resurrection, so
        // re-resolution can never bind anywhere a full re-index wouldn't.
        // Reconstruction from the target node's name instead would strip
        // receiver/qualifier context (`h.greet` → `greet`) and risk a
        // wrong rebind; edges without refName (pre-#1240, synthesized) are
        // deliberately NOT resurrected for the same reason.
        refName: ref.original.referenceName,
        ...(ref.original.referenceKind !== kind ? { refKind: ref.original.referenceKind } : {}),
        // Uniform marker for function-as-value edges (#756), regardless of
        // which strategy resolved them (import vs matchFunctionRef) — lets
        // tooling label "callback registration" and lets validation diff
        // exactly the edges this feature added.
        ...(ref.original.referenceKind === 'function_ref' ? { fnRef: true } : {}),
      },
    };
  });
}

/**
   * Split resolved refs into rows deletable by id and hand-built refs that
   * must fall back to the key-tuple delete. Rows loaded from the database
   * carry their row id and are deleted by exactly that id; the key tuple
   * omits line/col, so it also removes SIBLING rows — the same caller calling
   * the same callee at other lines — that a later batch hadn't attempted yet:
   * when a batch boundary split a caller's same-named call sites, the later
   * sites' edges were silently never created (#1269).
   */
export function partitionResolvedCleanup(resolved: ResolvedRef[]): {
  rowIds: number[];
  legacyKeys: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>;
} {
  const rowIds: number[] = [];
  const legacyKeys: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }> = [];
  for (const r of resolved) {
    if (r.original.rowId != null) rowIds.push(r.original.rowId);
    else legacyKeys.push({
      fromNodeId: r.original.fromNodeId,
      referenceName: r.original.referenceName,
      referenceKind: r.original.referenceKind,
    });
  }
  return { rowIds, legacyKeys };
}

/**
   * Same row-id precision for parking unresolvable refs as status='failed'
   * (#1240): the key-tuple fallback would flip same-key sibling rows in later
   * batches to 'failed' before they were ever attempted, and resolution
   * outcome can differ per call site (receiver-type inference reads the
   * ref's line), so a sibling must not inherit this row's failure (#1269).
   */
export function partitionFailedCleanup(unresolved: UnresolvedRef[]): {
  byRowId: Array<{ rowId: number; referenceName: string }>;
  legacyKeys: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>;
} {
  const byRowId: Array<{ rowId: number; referenceName: string }> = [];
  const legacyKeys: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }> = [];
  for (const r of unresolved) {
    if (r.rowId != null) byRowId.push({ rowId: r.rowId, referenceName: r.referenceName });
    else legacyKeys.push({
      fromNodeId: r.fromNodeId,
      referenceName: r.referenceName,
      referenceKind: r.referenceKind,
    });
  }
  return { byRowId, legacyKeys };
}

/**
   * Resolve and persist edges to database
   */
export function resolveAndPersist(this: ResolverState, unresolvedRefs: UnresolvedReference[], onProgress?: (current: number, total: number) => void): ResolutionResult {
  const result = this.owner.resolveAll(unresolvedRefs, onProgress);

  // Create edges from resolved references
  const edges = this.owner.createEdges(result.resolved);

  // Insert edges into database
  if (edges.length > 0) {
    this.queries.insertEdges(edges);
  }

  // Clean up resolved refs from unresolved_refs table so metrics are accurate
  if (result.resolved.length > 0) {
    const { rowIds, legacyKeys } = partitionResolvedCleanup(result.resolved);
    this.queries.deleteReferencesByRowIds(rowIds);
    this.queries.deleteSpecificResolvedReferences(legacyKeys);
  }

  // Park unresolvable refs as status='failed' — parity with
  // resolveAndPersistBatched. Deleting them was wrong (#1240): a ref whose
  // own file never changes is otherwise gone forever, so when a DIFFERENT
  // file later gains the export/symbol that would satisfy it, no sync can
  // recreate the edge — only a full re-index. Failed rows are excluded from
  // the pending readers, which preserves the #1187 orphan sweep's
  // invariant in status form: after a COMPLETED pass nothing it processed
  // is still 'pending', so any pending row at rest belongs to an
  // interrupted run and the sweep can key off the pending count.
  if (result.unresolved.length > 0) {
    const { byRowId, legacyKeys } = partitionFailedCleanup(result.unresolved);
    this.queries.markReferencesFailedByRowIds(byRowId);
    this.queries.markReferencesFailed(legacyKeys);
  }

  return result;
}

/**
   * Yielding counterpart of {@link resolveAndPersist} for a caller-supplied
   * ref list — used by sync's changed-file and failed-ref retry passes
   * (#1240). Same persistence semantics: resolved refs become edges and their
   * rows are deleted; still-unresolvable refs are (re-)marked failed (a no-op
   * for rows already in that status). Yields per-ref because sync can run on
   * the daemon's liveness-watchdog thread (#850/#1091) and a retry set is
   * unbounded when a large edit lands many popular symbol names at once.
   * `backpressure` is awaited before each persistence transaction so a scoped
   * Git fast-path run has the same WAL hard-cap protection as the full batch
   * resolver without widening its input to every pending reference.
   */
export async function resolveAndPersistListYielding(this: ResolverState, refs: UnresolvedReference[], onProgress?: (current: number, total: number) => void, backpressure?: () => Promise<void> | null): Promise<ResolutionResult> {
  const maybeYield = createYielder();
  const result = await this.resolveBatchYielding(refs, maybeYield, onProgress);

  const PERSIST_CHUNK = 1000;
  const persistChunk = async (write: () => void): Promise<void> => {
    const pause = backpressure?.();
    if (pause) await pause;
    write();
    await maybeYield();
  };
  const edges = this.owner.createEdges(result.resolved);
  for (let i = 0; i < edges.length; i += PERSIST_CHUNK) {
    await persistChunk(() => this.queries.insertEdges(edges.slice(i, i + PERSIST_CHUNK)));
  }

  const resolvedCleanup = partitionResolvedCleanup(result.resolved);
  for (let i = 0; i < resolvedCleanup.rowIds.length; i += PERSIST_CHUNK) {
    await persistChunk(() => this.queries.deleteReferencesByRowIds(resolvedCleanup.rowIds.slice(i, i + PERSIST_CHUNK)));
  }
  for (let i = 0; i < resolvedCleanup.legacyKeys.length; i += PERSIST_CHUNK) {
    await persistChunk(() => this.queries.deleteSpecificResolvedReferences(resolvedCleanup.legacyKeys.slice(i, i + PERSIST_CHUNK)));
  }

  const failedCleanup = partitionFailedCleanup(result.unresolved);
  for (let i = 0; i < failedCleanup.byRowId.length; i += PERSIST_CHUNK) {
    await persistChunk(() => this.queries.markReferencesFailedByRowIds(failedCleanup.byRowId.slice(i, i + PERSIST_CHUNK)));
  }
  for (let i = 0; i < failedCleanup.legacyKeys.length; i += PERSIST_CHUNK) {
    await persistChunk(() => this.queries.markReferencesFailed(failedCleanup.legacyKeys.slice(i, i + PERSIST_CHUNK)));
  }

  return result;
}

/**
   * Second resolution pass for chained static-factory / fluent calls whose
   * chained method is defined on a SUPERTYPE the receiver's type conforms to —
   * a protocol-extension / inherited / default-interface method (#750). The
   * first pass can't resolve these because `implements`/`extends` edges aren't
   * built yet; this runs AFTER edges are persisted, so `context.getSupertypes`
   * (and the conformance fallback in resolveMethodOnType) can walk them.
   *
   * Operates only on the leftover unresolved refs that have the `inner().method`
   * chain shape, for the dotted-chain languages — a small set — and is idempotent
   * (re-resolving an already-resolved ref is a no-op since it's been deleted).
   * Returns the number of newly-created edges.
   */
export async function resolveChainedCallsViaConformance(this: ResolverState): Promise<number> {
  const deferred = this.deferredChainRefs;
  this.deferredChainRefs = [];
  if (deferred.length === 0) return 0;

  // Read fresh edges (the main pass built the implements/extends edges after
  // these refs were deferred). matchDottedCallChain now resolves a method on a
  // supertype via context.getSupertypes -> resolveMethodOnType's conformance walk.
  this.owner.clearCaches();
  // This post-pass runs synchronously on the indexer's main thread; yield
  // periodically so the #850 liveness watchdog heartbeat can fire on a repo
  // with many deferred chained calls (#1091).
  const maybeYield = createYielder();
  const resolved: ResolvedRef[] = [];
  for (const ref of deferred) {
    // PHP `this->prop.method` resolves via matchMethodCall (declared-type
    // inference + resolveMethodOnType conformance walk); `::`-receiver
    // languages (Rust) split on `::` (matchScopedCallChain); other
    // dotted-receiver languages on `.` (matchDottedCallChain).
    const chainMatch = (ref.language === 'php' && PHP_PROP_SHAPE.test(ref.referenceName))
      ? matchMethodCall(ref, this.context)
      : SCOPED_CHAIN_LANGUAGES.has(ref.language)
        ? matchScopedCallChain(ref, this.context)
        : matchDottedCallChain(ref, this.context);
    const match = this.gateLanguage(chainMatch, ref);
    if (match) resolved.push(match);
    await maybeYield();
  }
  if (resolved.length === 0) return 0;

  const edges = this.owner.createEdges(resolved);
  if (edges.length > 0) {
    this.queries.insertEdges(edges);
    this.owner.clearCaches();
  }
  return edges.length;
}

/**
   * Resolve one batch with a yield checkpoint between EVERY ref so the #850
   * liveness heartbeat can fire on a slow/dense batch (#1091). The checkpoint
   * granularity is per-ref — not per-N-refs — because per-ref cost is unbounded
   * in the worst case (a collision-heavy method name whose candidate set misses
   * the LRU re-fetches tens of thousands of rows): any fixed N multiplies that
   * worst case into the watchdog window, which is how v1.2.0 still got killed
   * at "Resolving refs" on large Java monorepos (#1122). `maybeYield()` is a
   * ~ns time check when under budget, so per-ref checkpoints cost nothing.
   * Behaviourally identical to `resolveAll(batch)`: `warmCaches()` is
   * idempotent (guarded) and `resolveOne` is independent per ref, so yielding
   * between refs changes only timing, never which edges get created.
   */
export async function resolveBatchYielding(this: ResolverState, batch: UnresolvedReference[], maybeYield: MaybeYield, onProgress?: (current: number, total: number) => void): Promise<ResolutionResult> {
  this.owner.warmCaches();
  this.advanceSupertypeGeneration();

  const resolved: ResolvedRef[] = [];
  const unresolved: UnresolvedRef[] = [];
  const byMethod: Record<string, number> = {};
  let lastReportedPercent = -1;

  for (let i = 0; i < batch.length; i++) {
    const raw = batch[i]!;
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

    if (onProgress) {
      const currentPercent = Math.floor((i / batch.length) * 100);
      if (currentPercent > lastReportedPercent) {
        lastReportedPercent = currentPercent;
        onProgress(i + 1, batch.length);
      }
    }

    // Fast-path the per-ref yield check: awaiting the async no-op costs a
    // microtask hop per ref, which dominates at ~10⁵ refs (see MaybeYield).
    const y = maybeYield();
    if (y) await y;
  }

  if (onProgress && batch.length > 0) onProgress(batch.length, batch.length);

  return {
    resolved,
    unresolved,
    stats: {
      total: batch.length,
      resolved: resolved.length,
      unresolved: unresolved.length,
      byMethod,
    },
  };
}
