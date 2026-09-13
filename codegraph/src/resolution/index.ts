import { QueryBuilder } from '../db/queries';
import { ResolverState } from './resolver-state';
import { Edge, UnresolvedReference } from '../types';
import { type MaybeYield } from './cooperative-yield';
import {
  ResolutionContext,
  ResolutionResult,
  ResolvedRef,
  UnresolvedRef
} from './types';




export * from './types';

/**
 * Reference Resolver
 *
 * Orchestrates reference resolution using multiple strategies.
 */
export class ReferenceResolver {
  private readonly state: ResolverState;

  constructor(projectRoot: string, queries: QueryBuilder) {
    this.state = new ResolverState(projectRoot, queries, this);
  }

  initialize(): void {
    return this.state.initialize();
  }

  runPostExtract(): number {
    return this.state.runPostExtract();
  }

  warmCaches(): void {
    return this.state.warmCaches();
  }

  async warmCachesYielding(onYield: MaybeYield): Promise<void> {
    return this.state.warmCachesYielding(onYield);
  }

  clearCaches(): void {
    return this.state.clearCaches();
  }

  resolveAll(unresolvedRefs: UnresolvedReference[], onProgress?: (current: number, total: number) => void): ResolutionResult {
    return this.state.resolveAll(unresolvedRefs, onProgress);
  }

  resolveOne(ref: UnresolvedRef): ResolvedRef | null {
    return this.state.resolveOne(ref);
  }

  createEdges(resolved: ResolvedRef[]): Edge[] {
    return this.state.createEdges(resolved);
  }

  resolveAndPersist(unresolvedRefs: UnresolvedReference[], onProgress?: (current: number, total: number) => void): ResolutionResult {
    return this.state.resolveAndPersist(unresolvedRefs, onProgress);
  }

  async resolveAndPersistListYielding(refs: UnresolvedReference[], onProgress?: (current: number, total: number) => void, backpressure?: () => Promise<void> | null): Promise<ResolutionResult> {
    return this.state.resolveAndPersistListYielding(refs, onProgress, backpressure);
  }

  async resolveChainedCallsViaConformance(): Promise<number> {
    return this.state.resolveChainedCallsViaConformance();
  }

  dumpResolveProfile(label: string): void {
    return this.state.dumpResolveProfile(label);
  }

  resolveListForAdmission(refs: UnresolvedReference[]): {
    resolved: ResolvedRef[];
    unresolved: UnresolvedRef[];
    deferredChain: UnresolvedRef[];
    deferredThisMember: UnresolvedRef[];
    byMethod: Record<string, number>;
  } {
    return this.state.resolveListForAdmission(refs);
  }

  getResolutionContext(): ResolutionContext {
    return this.state.getResolutionContext();
  }

  appendDeferredFromWorkers(deferredChain: UnresolvedRef[], deferredThisMember: UnresolvedRef[]): void {
    return this.state.appendDeferredFromWorkers(deferredChain, deferredThisMember);
  }

  async resolveAndPersistBatched(onProgress?: (current: number, total: number) => void, batchSize: number = 5000, onSynthesisProgress?: (done: number, total: number) => void, parallel?: {
    dbPath: string;
    bulkEdgeLoad?: { begin: () => void; end: () => void | Promise<void> };
    /** unresolved_refs index window for the batched loop — the loop only
     *  reads the status index + PK; dropping the sync-path ref indexes cuts
     *  each per-batch DELETE's B-tree work (DatabaseConnection.beginBulkRefLoad). */
    refIndexLoad?: { begin: () => void; end: () => void | Promise<void> };
    backpressure?: () => Promise<void> | null;
  }): Promise<ResolutionResult> {
    return this.state.resolveAndPersistBatched(onProgress, batchSize, onSynthesisProgress, parallel);
  }

  getDetectedFrameworks(): string[] {
    return this.state.getDetectedFrameworks();
  }

  async resolveDeferredThisMemberRefs(): Promise<number> {
    return this.state.resolveDeferredThisMemberRefs();
  }
}

/**
 * Create a reference resolver instance
 */
export function createResolver(projectRoot: string, queries: QueryBuilder): ReferenceResolver {
  const resolver = new ReferenceResolver(projectRoot, queries);
  resolver.initialize();
  return resolver;
}
