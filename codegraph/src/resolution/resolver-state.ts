import { QueryBuilder } from '../db/queries';
import { Node } from '../types';
import { type GoModule } from './go-module';
import type { ReferenceResolver } from './index';
import { LRUCache } from './lru-cache';
import { type AliasMap } from './path-aliases';
import {
  appendDeferredFromWorkers,
  resolveAndPersistBatched,
  resolveListForAdmission,
} from './resolver-batches';
import {
  advanceSupertypeGeneration,
  clearCaches,
  createContext,
  getDetectedFrameworks,
  getResolutionContext,
  initialize,
  readFileCached,
  runPostExtract,
  warmCaches,
  warmCachesYielding,
} from './resolver-context';
import {
  gateFrameworkLanguage,
  gateLanguage,
  getFilePathFromNodeId,
  getLanguageFromNodeId,
  hasAnyPossibleMatch,
  isBuiltInOrExternal,
  matchesAnyImport,
  resolveAll,
  resolveOne,
} from './resolver-matching';
import {
  getRazorUsings,
  resolveCfmlComponentPath,
  resolveDeferredThisMemberRefs,
  resolveRazorUsing,
  resolveThisMemberFnRef,
} from './resolver-members';
import {
  createEdges,
  resolveAndPersist,
  resolveAndPersistListYielding,
  resolveBatchYielding,
  resolveChainedCallsViaConformance,
} from './resolver-persistence';
import { dumpResolveProfile, resolveOneTimed, stageAdd } from './resolver-profiling';
import {
  resolveCacheLimit
} from './resolver-rules';
import {
  FrameworkResolver,
  ImportMapping,
  type ReExport,
  ResolutionContext,
  UnresolvedRef
} from './types';
import { type WorkspacePackages } from './workspace-packages';

/** Internal state and method bindings for ReferenceResolver. */
export class ResolverState {
  readonly projectRoot: string;

  readonly queries: QueryBuilder;

  readonly context: ResolutionContext;

  frameworks: FrameworkResolver[] = [];

  // Chained static-factory/fluent call refs the first pass couldn't resolve,
  // collected in-memory (the batched resolver deletes unresolved refs from the
  // DB, so they can't be re-read). Drained by resolveChainedCallsViaConformance
  // once implements/extends edges exist, to resolve methods on a supertype the
  // receiver conforms to (#750).
  deferredChainRefs: UnresolvedRef[] = [];

  // `this.<member>` function-as-value refs whose member is NOT on the
  // enclosing class itself — possibly inherited. Collected in-memory for the
  // same reason as deferredChainRefs and drained by
  // resolveDeferredThisMemberRefs once implements/extends edges exist (#808).
  deferredThisMemberRefs: UnresolvedRef[] = [];

  // Per-`.razor`/`.cshtml`-file `@using` namespace set (own directives + folder
  // `_Imports.razor`, cascading to the project root). Used to disambiguate a
  // markup type ref to the right C# namespace.
  razorUsingsCache = new Map<string, string[]>();

  // All per-resolver caches are LRU-bounded. Previously these were
  // unbounded Maps that grew with every distinct lookup and OOM'd on
  // codebases with 20k+ files (see issue: unbounded cache growth).
  nodeCache: LRUCache<string, Node[]>;

  // per-file node cache
  fileCache: LRUCache<string, string | null>;

  // per-file content cache
  importMappingCache: LRUCache<string, ImportMapping[]>;

  reExportCache: LRUCache<string, ReExport[]>;

  nameCache: LRUCache<string, Node[]>;

  // name → nodes cache
  lowerNameCache: LRUCache<string, Node[]>;

  // lower(name) → nodes cache
  qualifiedNameCache: LRUCache<string, Node[]>;

  // qualified_name → nodes cache
  fileLinesCache: LRUCache<string, string[] | null>;

  // file → split lines cache
  methodMatchCache: LRUCache<string, Node[]>;

  // lang\0Type::method → matching method nodes
  // Per-(language, methodName) owner index for getMethodMatches: buckets a
  // method name's candidates by their qualifiedName's last two segments so a
  // (type, method) query is a lookup instead of an O(candidates) filter per
  // methodMatchCache miss. Derived purely from node rows (stable through the
  // resolution loop, same window nameCache relies on); dropped in clearCaches.
  methodOwnerIndexCache = new Map<string, Map<string, Node[]>>();

  // Generation-tagged memo for getSupertypes. Supertype edges GROW during the
  // resolution loop (batch k persists its implements/extends edges BEFORE
  // batch k+1 fans out — the #1320 ordering), so a plain cache would freeze an
  // early batch's emptier answer and change later batches' outcomes. Within
  // one batch the edge state is fixed by that same ordering, so entries are
  // tagged with a generation that advances at every batch entry point
  // (resolveBatchYielding / resolveListForAdmission) — a stale-gen entry is
  // recomputed, making the memo behavior-identical to no memo at every point
  // in time. On the Swift compiler the unmemoized walk ran 971k times for
  // 565s of combined worker time (~581µs each, recursion-multiplied).
  supertypeGen = 0;

  supertypeMemo = new Map<string, { gen: number; supers: string[] }>();

  // Node kinds are a small fixed set (~24), so this is a plain Map, not an LRU.
  // getNodesByKind returns the FULL node list for a kind; it was previously
  // uncached — a per-ref `SELECT * FROM nodes WHERE kind=?` + row-mapping. Called
  // for every dotted call ref by the Spring resolver (constants) and every
  // `hook_` ref by the Drupal resolver (functions), that scan dominated
  // resolution on large repos (#1180). The node set is stable within a
  // resolution pass (same lifetime assumption as nameCache); clearCaches() resets
  // it between passes. Callers must treat the returned array as read-only.
  nodesByKindCache = new Map<Node['kind'], Node[]>();

  knownNames: Set<string> | null = null;

  // all known symbol names for fast pre-filtering
  knownFiles: Set<string> | null = null;

  cachesWarmed = false;

  // tsconfig/jsconfig path-alias map. `undefined` = not yet computed,
  // `null` = computed and absent. Treated as immutable for the
  // resolver's lifetime; callers re-create the resolver if config changes.
  projectAliases: AliasMap | null | undefined = undefined;

  // go.mod module path. Same lazy/immutable convention as projectAliases.
  goModule: GoModule | null | undefined = undefined;

  // Monorepo workspace member packages. Same lazy/immutable convention.
  workspacePackages: WorkspacePackages | null | undefined = undefined;

  constructor(projectRoot: string, queries: QueryBuilder, readonly owner: Pick<ReferenceResolver, keyof ReferenceResolver> = this) {
    this.projectRoot = projectRoot;
    this.queries = queries;

    const limit = resolveCacheLimit();
    // The content cache is heavier (full file text), so we give it a
    // smaller budget than the metadata caches.
    const contentLimit = Math.max(64, Math.floor(limit / 5));
    this.nodeCache = new LRUCache(limit);
    this.fileCache = new LRUCache(contentLimit);
    this.importMappingCache = new LRUCache(limit);
    this.reExportCache = new LRUCache(limit);
    this.nameCache = new LRUCache(limit);
    this.lowerNameCache = new LRUCache(limit);
    this.qualifiedNameCache = new LRUCache(limit);
    // Split-lines arrays are heavier than content strings; refs arrive
    // file-ordered, so a small cache still hits nearly always.
    this.fileLinesCache = new LRUCache(contentLimit);
    this.methodMatchCache = new LRUCache(limit);

    this.context = this.createContext();
  }

  /**
   * Resolve a list of refs and return everything the ADMISSION side needs to
   * persist the outcome: resolutions, failures, the deferred post-pass refs
   * this run produced (drained, so the caller owns routing them), and stats.
   * This is the resolver-worker entry point — it runs the exact per-ref loop
   * of resolveBatchYielding, minus the main-thread yields (worker threads have
   * no watchdog heartbeat to starve). Results are in input order.
   */
  /**
   * CODEGRAPH_RESOLVE_PROFILE=1: per-outcome wall-clock histogram of
   * resolveOne, keyed by the winning strategy (`resolvedBy`) or
   * `fail:<referenceKind>` — the §7a.2 "profile the per-ref path" probe. The
   * kernel-scale batch loop is ~430s and CORE-INVARIANT (835.9s pooled-4-on-8
   * ≈ 812.5s sequential-on-2 for the whole superphase), so the next lever is
   * which CLASS of ref the time belongs to, not more parallelism. Off by
   * default: the hrtime pair costs ~100ns/ref only when the env is set.
   */
  resolveProfile: Map<string, { n: number; ns: bigint }> | null =
    process.env.CODEGRAPH_RESOLVE_PROFILE ? new Map() : null;

  /**
   * CODEGRAPH_RESOLVE_PROFILE=2 additionally attributes time to the
   * STRATEGIES inside resolveOne (`stage:<name>|<refKind>|hit/miss` rows in
   * the same histogram) — i.e. WHICH machinery a failing class of refs pays
   * for, not just that it fails. =1 keeps the per-outcome rows only.
   */
  profileStages: boolean = process.env.CODEGRAPH_RESOLVE_PROFILE === '2';
}

export interface ResolverState {
  advanceSupertypeGeneration: typeof advanceSupertypeGeneration;
  initialize: typeof initialize;
  runPostExtract: typeof runPostExtract;
  warmCaches: typeof warmCaches;
  warmCachesYielding: typeof warmCachesYielding;
  clearCaches: typeof clearCaches;
  readFileCached: typeof readFileCached;
  createContext: typeof createContext;
  resolveAll: typeof resolveAll;
  hasAnyPossibleMatch: typeof hasAnyPossibleMatch;
  matchesAnyImport: typeof matchesAnyImport;
  resolveOne: typeof resolveOne;
  createEdges: typeof createEdges;
  resolveAndPersist: typeof resolveAndPersist;
  resolveAndPersistListYielding: typeof resolveAndPersistListYielding;
  resolveChainedCallsViaConformance: typeof resolveChainedCallsViaConformance;
  resolveBatchYielding: typeof resolveBatchYielding;
  stageAdd: typeof stageAdd;
  resolveOneTimed: typeof resolveOneTimed;
  dumpResolveProfile: typeof dumpResolveProfile;
  resolveListForAdmission: typeof resolveListForAdmission;
  getResolutionContext: typeof getResolutionContext;
  appendDeferredFromWorkers: typeof appendDeferredFromWorkers;
  resolveAndPersistBatched: typeof resolveAndPersistBatched;
  getDetectedFrameworks: typeof getDetectedFrameworks;
  isBuiltInOrExternal: typeof isBuiltInOrExternal;
  getFilePathFromNodeId: typeof getFilePathFromNodeId;
  getLanguageFromNodeId: typeof getLanguageFromNodeId;
  getRazorUsings: typeof getRazorUsings;
  resolveRazorUsing: typeof resolveRazorUsing;
  resolveCfmlComponentPath: typeof resolveCfmlComponentPath;
  resolveThisMemberFnRef: typeof resolveThisMemberFnRef;
  resolveDeferredThisMemberRefs: typeof resolveDeferredThisMemberRefs;
  gateLanguage: typeof gateLanguage;
  gateFrameworkLanguage: typeof gateFrameworkLanguage;
}

Object.assign(ResolverState.prototype, {
  advanceSupertypeGeneration,
  initialize,
  runPostExtract,
  warmCaches,
  warmCachesYielding,
  clearCaches,
  readFileCached,
  createContext,
  resolveAll,
  hasAnyPossibleMatch,
  matchesAnyImport,
  resolveOne,
  createEdges,
  resolveAndPersist,
  resolveAndPersistListYielding,
  resolveChainedCallsViaConformance,
  resolveBatchYielding,
  stageAdd,
  resolveOneTimed,
  dumpResolveProfile,
  resolveListForAdmission,
  getResolutionContext,
  appendDeferredFromWorkers,
  resolveAndPersistBatched,
  getDetectedFrameworks,
  isBuiltInOrExternal,
  getFilePathFromNodeId,
  getLanguageFromNodeId,
  getRazorUsings,
  resolveRazorUsing,
  resolveCfmlComponentPath,
  resolveThisMemberFnRef,
  resolveDeferredThisMemberRefs,
  gateLanguage,
  gateFrameworkLanguage,
});
