import * as fs from 'fs';
import * as path from 'path';
import { logDebug } from '../errors';
import { Language, Node } from '../types';
import { type MaybeYield } from './cooperative-yield';
import { detectFrameworks } from './frameworks';
import { loadGoModule } from './go-module';
import {
  clearImportResolverMemos,
  extractImportMappings,
  extractReExports,
  loadCppIncludeDirs
} from './import-resolver';
import {
  clearNameMatcherMemos
} from './name-matcher';
import { loadProjectAliases } from './path-aliases';
import {
  SUPERTYPE_BEARING_KINDS
} from './resolver-rules';
import type { ResolverState } from './resolver-state';
import {
  ResolutionContext
} from './types';
import { loadWorkspacePackages } from './workspace-packages';


/** Invalidate the getSupertypes memo — call when resolved edges may have advanced. */
export function advanceSupertypeGeneration(this: ResolverState): void {
  this.supertypeGen++;
  // Lazy invalidation via the gen tag; bound the map so a long run over many
  // batches doesn't accrete dead entries.
  if (this.supertypeMemo.size > 50_000) this.supertypeMemo.clear();
}

/**
   * Initialize the resolver (detect frameworks, etc.)
   */
export function initialize(this: ResolverState): void {
  this.frameworks = detectFrameworks(this.context);
  this.owner.clearCaches();
}

/**
   * Run each framework resolver's cross-file finalization pass and persist
   * the returned node updates. Idempotent — safe to call after every indexAll
   * and every incremental sync. Returns the number of nodes updated.
   *
   * Caches are cleared before/after so the post-extract pass sees fresh DB
   * state and downstream queries see the updated names.
   */
export function runPostExtract(this: ResolverState): number {
  let updated = 0;
  this.owner.clearCaches();
  for (const fw of this.frameworks) {
    if (!fw.postExtract) continue;
    try {
      const nodes = fw.postExtract(this.context);
      for (const node of nodes) {
        this.queries.updateNode(node);
        updated++;
      }
    } catch (err) {
      logDebug(`Framework '${fw.name}' postExtract failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (updated > 0) this.owner.clearCaches();
  return updated;
}

/**
   * Pre-build lightweight caches for resolution.
   * Node lookups are now handled by indexed SQLite queries instead of
   * loading all nodes into memory (which caused OOM on large codebases).
   * We cache the set of known symbol names for fast pre-filtering.
   */
export function warmCaches(this: ResolverState): void {
  if (this.cachesWarmed) return;

  // Only cache the set of known file paths (lightweight string set)
  this.knownFiles = new Set(this.queries.getAllFilePaths());

  // Cache all distinct symbol names for fast pre-filtering (just strings, not full nodes)
  this.knownNames = new Set(this.queries.getAllNodeNames());

  this.cachesWarmed = true;
}

/**
   * warmCaches for the async resolution entry points: streams the distinct
   * name set with periodic yields instead of one synchronous `.all()`. On a
   * multi-million-node index the DISTINCT scan is a solid multi-second block
   * (measured up to 28s inside `codegraph sync` on the Linux kernel index),
   * long enough to matter to the #850 watchdog on slower hardware. Same
   * result, same memory — only the event loop keeps turning.
   */
export async function warmCachesYielding(this: ResolverState, onYield: MaybeYield): Promise<void> {
  if (this.cachesWarmed) return;

  this.knownFiles = new Set(this.queries.getAllFilePaths());

  const names = new Set<string>();
  let scanned = 0;
  for (const name of this.queries.iterateNodeNames()) {
    names.add(name);
    if ((++scanned & 8191) === 0) await onYield();
  }
  this.knownNames = names;

  this.cachesWarmed = true;
}

/**
   * Clear internal caches
   */
export function clearCaches(this: ResolverState): void {
  this.nodeCache.clear();
  this.fileCache.clear();
  this.importMappingCache.clear();
  this.reExportCache.clear();
  this.nameCache.clear();
  this.lowerNameCache.clear();
  this.qualifiedNameCache.clear();
  this.fileLinesCache.clear();
  this.methodMatchCache.clear();
  this.methodOwnerIndexCache.clear();
  this.supertypeMemo.clear();
  this.supertypeGen++;
  this.nodesByKindCache.clear();
  this.knownNames = null;
  this.knownFiles = null;
  this.cachesWarmed = false;
  // The import-resolver's and name-matcher's per-context memos assume the
  // same stable window as the caches above — drop them together.
  if (this.context) {
    clearImportResolverMemos(this.context);
    clearNameMatcherMemos(this.context);
  }
}

/** `readFile` through the LRU content cache (null = read failed, also cached). */
export function readFileCached(this: ResolverState, filePath: string): string | null {
  if (this.fileCache.has(filePath)) {
    return this.fileCache.get(filePath)!;
  }
  const fullPath = path.join(this.projectRoot, filePath);
  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    this.fileCache.set(filePath, content);
    return content;
  } catch (error) {
    logDebug('Failed to read file for resolution', { filePath, error: String(error) });
    this.fileCache.set(filePath, null);
    return null;
  }
}

/**
   * Create the resolution context
   */
export function createContext(this: ResolverState): ResolutionContext {
  return {
    getNodesInFile: (filePath: string) => {
      if (!this.nodeCache.has(filePath)) {
        this.nodeCache.set(filePath, this.queries.getNodesByFile(filePath));
      }
      return this.nodeCache.get(filePath)!;
    },

    getNodesByName: (name: string) => {
      const cached = this.nameCache.get(name);
      if (cached !== undefined) return cached;
      const result = this.queries.getNodesByName(name);
      this.nameCache.set(name, result);
      return result;
    },

    getMethodMatches: (typeName: string, methodName: string, language: Language) => {
      const key = `${language} ${typeName}::${methodName}`;
      const cached = this.methodMatchCache.get(key);
      if (cached !== undefined) return cached;
      let candidates = this.nameCache.get(methodName);
      if (candidates === undefined) {
        candidates = this.queries.getNodesByName(methodName);
        this.nameCache.set(methodName, candidates);
      }
      const want = `${typeName}::${methodName}`;
      let matches: Node[];
      if (typeName.includes('::') || methodName.includes(':')) {
        // Legacy linear filter for the shapes the owner index below can't
        // key exactly: a multi-segment typeName (the endsWith test then
        // spans more than two `::` segments) and ObjC selectors (whose
        // single/empty-keyword colons defeat the segment split). Tiny
        // populations; the per-key memo above still amortizes them.
        matches = [];
        for (const m of candidates) {
          if (m.kind !== 'method') continue;
          if (m.language !== language) continue;
          const qn = m.qualifiedName;
          if (qn === want || qn.endsWith(`::${want}`)) matches.push(m);
        }
      } else {
        // Owner index: the linear filter above is O(all same-named methods)
        // per CACHE MISS, and on overload-heavy landscapes the distinct
        // (type, method) key space is so large the per-key memo never
        // amortizes — Swift's `init` has tens of thousands of candidates
        // and the compiler repo measured 732µs per failing call, most of it
        // this scan (re-entered once per supertype recursion level, too).
        // Bucket each (language, methodName)'s candidates ONCE by the
        // qualifiedName's last two `::` segments — exactly the span the
        // `qn === want || qn.endsWith('::' + want)` predicate tests for a
        // segment-clean typeName — then every query is a map lookup.
        // Bucket insertion follows candidate order, so each bucket is
        // byte-identical to what the linear filter produced.
        const idxKey = `${language} ${methodName}`;
        let ownerIndex = this.methodOwnerIndexCache.get(idxKey);
        if (!ownerIndex) {
          ownerIndex = new Map<string, Node[]>();
          for (const m of candidates) {
            if (m.kind !== 'method') continue;
            if (m.language !== language) continue;
            const qn = m.qualifiedName;
            const i2 = qn.lastIndexOf('::');
            if (i2 < 0) continue; // single-segment qn can never match `T::m`
            const i1 = qn.lastIndexOf('::', i2 - 1);
            const bucketKey = i1 < 0 ? qn : qn.slice(i1 + 2);
            const bucket = ownerIndex.get(bucketKey);
            if (bucket) bucket.push(m);
            else ownerIndex.set(bucketKey, [m]);
          }
          this.methodOwnerIndexCache.set(idxKey, ownerIndex);
        }
        matches = ownerIndex.get(want) ?? [];
      }
      this.methodMatchCache.set(key, matches);
      return matches;
    },

    getNodesByQualifiedName: (qualifiedName: string) => {
      const cached = this.qualifiedNameCache.get(qualifiedName);
      if (cached !== undefined) return cached;
      const result = this.queries.getNodesByQualifiedNameExact(qualifiedName);
      this.qualifiedNameCache.set(qualifiedName, result);
      return result;
    },

    getNodesByKind: (kind: Node['kind']) => {
      const cached = this.nodesByKindCache.get(kind);
      if (cached !== undefined) return cached;
      const result = this.queries.getNodesByKind(kind);
      this.nodesByKindCache.set(kind, result);
      return result;
    },

    // Streamed, uncached — synthesizers scan-and-filter whole kinds, and
    // both the materialized array AND the per-kind cache retention are
    // O(nodes) memory (#1212). Per-ref resolvers keep the cached array
    // variant above.
    iterateNodesByKind: (kind: Node['kind']) => this.queries.iterateNodesByKind(kind),

    fileExists: (filePath: string) => {
      // Check pre-built known files set first (O(1))
      if (this.knownFiles) {
        const normalized = filePath.replace(/\\/g, '/');
        if (this.knownFiles.has(filePath) || this.knownFiles.has(normalized)) {
          return true;
        }
      }
      // Fall back to filesystem for files not yet indexed
      const fullPath = path.join(this.projectRoot, filePath);
      try {
        return fs.existsSync(fullPath);
      } catch (error) {
        logDebug('Error checking file existence', { filePath, error: String(error) });
        return false;
      }
    },

    readFile: (filePath: string) => this.readFileCached(filePath),

    getFileLines: (filePath: string) => {
      const cached = this.fileLinesCache.get(filePath);
      if (cached !== undefined) return cached;
      const source = this.readFileCached(filePath);
      const lines = source === null ? null : source.split(/\r?\n/);
      this.fileLinesCache.set(filePath, lines);
      return lines;
    },

    getProjectRoot: () => this.projectRoot,

    getAllFiles: () => {
      return this.queries.getAllFilePaths();
    },

    listDirectories: (relativePath: string) => {
      const target = relativePath === '.' || relativePath === ''
        ? this.projectRoot
        : path.join(this.projectRoot, relativePath);
      try {
        return fs
          .readdirSync(target, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch (error) {
        logDebug('Failed to list directory for resolution', {
          relativePath,
          error: String(error),
        });
        return [];
      }
    },

    getNodesByLowerName: (lowerName: string) => {
      const cached = this.lowerNameCache.get(lowerName);
      if (cached !== undefined) return cached;
      const result = this.queries.getNodesByLowerName(lowerName);
      this.lowerNameCache.set(lowerName, result);
      return result;
    },

    getNodeById: (id: string) => {
      return this.queries.getNodeById(id);
    },

    getSupertypes: (typeName: string, language) => {
      // Union the `implements`/`extends` targets of every same-named type node.
      // Matching by simple name (not id) reconciles a type declared in one node
      // (`KF::Builder`) with conformance declared in a separate extension node
      // (`KF.Builder: KFOptionSetter`) — both have name `Builder`.
      // Memoized per batch generation (see supertypeMemo): within a batch the
      // edge state is fixed, and the conformance walk re-queries the same
      // popular supertypes (Swift stdlib protocols especially) thousands of
      // times per batch.
      const memoKey = `${language} ${typeName}`;
      const hit = this.supertypeMemo.get(memoKey);
      if (hit && hit.gen === this.supertypeGen) return hit.supers;
      const typeNodes = this.context
        .getNodesByName(typeName)
        .filter((n) => SUPERTYPE_BEARING_KINDS.has(n.kind) && n.language === language);
      let supers: string[];
      if (typeNodes.length === 0) {
        supers = [];
      } else {
        const supertypes = new Set<string>();
        for (const tn of typeNodes) {
          for (const edge of this.queries.getOutgoingEdges(tn.id, ['implements', 'extends'])) {
            const target = this.queries.getNodeById(edge.target);
            if (target?.name && target.name !== typeName) supertypes.add(target.name);
          }
        }
        supers = [...supertypes];
      }
      this.supertypeMemo.set(memoKey, { gen: this.supertypeGen, supers });
      return supers;
    },

    getImportMappings: (filePath: string, language) => {
      const cacheKey = filePath;
      const cached = this.importMappingCache.get(cacheKey);
      if (cached) return cached;

      const content = this.context.readFile(filePath);
      if (!content) {
        this.importMappingCache.set(cacheKey, []);
        return [];
      }

      const mappings = extractImportMappings(filePath, content, language);
      this.importMappingCache.set(cacheKey, mappings);
      return mappings;
    },

    getProjectAliases: () => {
      if (this.projectAliases === undefined) {
        this.projectAliases = loadProjectAliases(this.projectRoot);
      }
      return this.projectAliases;
    },

    getGoModule: () => {
      if (this.goModule === undefined) {
        this.goModule = loadGoModule(this.projectRoot);
      }
      return this.goModule;
    },

    getWorkspacePackages: () => {
      if (this.workspacePackages === undefined) {
        this.workspacePackages = loadWorkspacePackages(this.projectRoot);
      }
      return this.workspacePackages;
    },

    getReExports: (filePath: string, language) => {
      const cached = this.reExportCache.get(filePath);
      if (cached) return cached;
      const content = this.context.readFile(filePath);
      if (!content) {
        this.reExportCache.set(filePath, []);
        return [];
      }
      // Re-exports are a JS/TS-only construct, and what matters is the
      // BARREL file's own language — not the consuming reference's. A
      // `.svelte`/`.vue` consumer threads its own language down the
      // re-export chase, which would make extractReExports() bail on a
      // `.ts` index barrel and silently break the chain (#629). Re-key
      // the parse on the barrel's extension so the chase works no matter
      // what kind of file imports through it.
      const isJsFamily = /\.(?:d\.ts|[cm]?tsx?|[cm]?jsx?|ets)$/i.test(filePath);
      const reExports = extractReExports(content, isJsFamily ? 'typescript' : language);
      this.reExportCache.set(filePath, reExports);
      return reExports;
    },

    getCppIncludeDirs: () => {
      return loadCppIncludeDirs(this.projectRoot);
    },
  };
}

/**
   * The resolver's live ResolutionContext — resolver-pool workers use it to
   * run synthesis passes against their own read-only connection.
   */
export function getResolutionContext(this: ResolverState): ResolutionContext {
  return this.context;
}

/**
   * Get detected frameworks
   */
export function getDetectedFrameworks(this: ResolverState): string[] {
  return this.frameworks.map((f) => f.name);
}
