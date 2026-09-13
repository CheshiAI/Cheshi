import type { Edge, Node } from '../types';
import { enclosingFn } from './callback-source';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import type { ResolutionContext } from './types';

// ── Pinia useStore().action() dispatch bridge ────────────────────────────────
// A Pinia store factory `export const useXStore = defineStore(...)` exposes its
// actions as methods on the store instance; a consumer does `const s = useXStore()`
// then `s.action()`. The call is a method-on-instance with no static edge to the
// action (which lives in the store's module). Bridge it: map each factory → its
// file, bind `const <var> = useXStore()` per consumer file, and link the enclosing
// function → the `<var>.method()` action node IN THE STORE'S FILE. The same-store-
// file gate keeps it precise (a Pinia built-in like `$patch` or an unrelated
// same-named method resolves to nothing). Covers both the options and setup store
// forms uniformly (the action is a function node in the store file either way).
const PINIA_CONSUMER_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue)$/;

const PINIA_FACTORY_RE = /\b(?:export\s+)?const\s+(\w+)\s*=\s*defineStore\s*\(/g;

const PINIA_BIND_RE = /\bconst\s+(\w+)\s*=\s*(?:await\s+)?(\w+)\s*\(/g;

const PINIA_CALL_RE = /(\w+)\s*\.\s*(\w+)\s*\(/g;

const PINIA_FANOUT_CAP = 80;

export async function piniaStoreEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scannedFiles = 0;
  // 1. Map each `const useXStore = defineStore(...)` factory → its store file.
  const factoryFile = new Map<string, string>();
  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if (!PINIA_CONSUMER_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || !content.includes('defineStore')) continue;
    PINIA_FACTORY_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PINIA_FACTORY_RE.exec(content))) factoryFile.set(m[1]!, file);
  }
  if (!factoryFile.size) return [];

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if (!PINIA_CONSUMER_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || !content.includes('Store')) continue;
    const safe = stripCommentsForRegex(content, /\.(?:jsx?|mjs|cjs)$/.test(file) ? 'javascript' : 'typescript');

    // 2. Bind store vars in this file: `const <var> = <known-factory>(...)`.
    const varStore = new Map<string, string>();
    PINIA_BIND_RE.lastIndex = 0;
    let bm: RegExpExecArray | null;
    while ((bm = PINIA_BIND_RE.exec(safe))) {
      const sf = factoryFile.get(bm[2]!);
      if (sf) varStore.set(bm[1]!, sf);
    }
    if (!varStore.size) continue;

    // 3. Link `<var>.<method>(` → the action function node in the store's file.
    const nodesInFile = ctx.getNodesInFile(file);
    const fallbackDispatcher = nodesInFile.find((n) => n.kind === 'component'); // .vue top-level setup
    PINIA_CALL_RE.lastIndex = 0;
    let cm: RegExpExecArray | null;
    let added = 0;
    while ((cm = PINIA_CALL_RE.exec(safe)) && added < PINIA_FANOUT_CAP) {
      const storeFile = varStore.get(cm[1]!);
      if (!storeFile) continue;
      const method = cm[2]!;
      const line = safe.slice(0, cm.index).split('\n').length;
      const disp = enclosingFn(nodesInFile, line) ?? fallbackDispatcher;
      if (!disp) continue;
      const target = ctx
        .getNodesByName(method)
        .find((n) => n.kind === 'function' && n.filePath === storeFile);
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
        metadata: { synthesizedBy: 'pinia-store', via: method, registeredAt: `${file}:${line}` },
      });
      added++;
    }
  }
  return edges;
}

// ── Vuex string-keyed dispatch / commit bridge ───────────────────────────────
// Vuex dispatches actions/mutations by a runtime STRING key: `dispatch('user/login')`
// / `commit('SET_TOKEN')` / `this.$store.dispatch('app/toggleDevice')`. The action
// & mutation definitions are object-literal methods in store module files (now
// extracted as function nodes). Bridge the string key to its node: the LAST `/`
// segment is the action/mutation name; the preceding segment is the namespace
// (≈ the store module's file). Resolve the name to a function node IN A STORE FILE
// (the store-file gate excludes a same-named `api/` helper — `getInfo`/`login`
// commonly collide), disambiguated by the namespace appearing in the path (or, for
// a root key, the same file — Vuex's local-module `commit('M')` inside an action).
const VUEX_DISPATCH_RE = /\b(?:dispatch|commit)\s*\(\s*['"]([A-Za-z][\w/]*)['"]/g;

const VUEX_STORE_SIGNAL = /\bdefineStore\b|\bcreateStore\b|\bVuex\b|\bmutations\b|\bactions\b|\bgetters\b|\bnamespaced\b/g;

const VUEX_FANOUT_CAP = 120;

/** A path segment (dir or filename stem) equals `seg` — `…/modules/user.js` has
 *  the segment `user` for namespace `user`. */
function pathHasSegment(filePath: string, seg: string): boolean {
  return new RegExp('[\\\\/]' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\\\/.]').test(filePath);
}

export async function vuexDispatchEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scannedFiles = 0;
  const storeFileCache = new Map<string, boolean>();
  const isStoreFile = (file: string): boolean => {
    let v = storeFileCache.get(file);
    if (v === undefined) {
      const c = ctx.readFile(file);
      const seen = new Set<string>();
      if (c) {
        VUEX_STORE_SIGNAL.lastIndex = 0;
        let sm: RegExpExecArray | null;
        while ((sm = VUEX_STORE_SIGNAL.exec(c))) { seen.add(sm[0]); if (seen.size >= 2) break; }
      }
      v = seen.size >= 2;
      storeFileCache.set(file, v);
    }
    return v;
  };

  const resolve = (key: string, dispatchFile: string): Node | null => {
    const segs = key.split('/');
    const action = segs[segs.length - 1]!;
    const cands = ctx.getNodesByName(action).filter((n) => n.kind === 'function' && isStoreFile(n.filePath));
    if (!cands.length) return null;
    if (segs.length > 1) {
      const mod = segs[segs.length - 2]!; // immediate namespace ≈ the module file
      return cands.find((c) => pathHasSegment(c.filePath, mod)) ?? (cands.length === 1 ? cands[0]! : null);
    }
    // Root key: a local `commit('M')` inside an action targets the same module file;
    // otherwise accept only an unambiguous single store-wide match.
    return cands.find((c) => c.filePath === dispatchFile) ?? (cands.length === 1 ? cands[0]! : null);
  };

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if (!PINIA_CONSUMER_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || (!content.includes('dispatch(') && !content.includes('commit('))) continue;
    const safe = stripCommentsForRegex(content, /\.(?:jsx?|mjs|cjs)$/.test(file) ? 'javascript' : 'typescript');
    const nodesInFile = ctx.getNodesInFile(file);
    const fallback = nodesInFile.find((n) => n.kind === 'component'); // .vue top-level
    VUEX_DISPATCH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let added = 0;
    while ((m = VUEX_DISPATCH_RE.exec(safe)) && added < VUEX_FANOUT_CAP) {
      const key = m[1]!;
      const line = safe.slice(0, m.index).split('\n').length;
      const disp = enclosingFn(nodesInFile, line) ?? fallback;
      if (!disp) continue;
      const target = resolve(key, file);
      if (!target || target.id === disp.id) continue;
      const edgeKey = `${disp.id}>${target.id}`;
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);
      edges.push({
        source: disp.id,
        target: target.id,
        kind: 'calls',
        line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'vuex-dispatch', via: key, registeredAt: `${file}:${line}` },
      });
      added++;
    }
  }
  return edges;
}
