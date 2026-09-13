import type { QueryBuilder } from '../db/queries';
import type { Edge } from '../types';
import { sliceLines } from './callback-source';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import type { ResolutionContext } from './types';

/**
 * Redux-thunk dispatch chain. `export const X = createAsyncThunk(prefix, async (a, api) => {...})`
 * (or a wrapper like trezor's `createThunk(...)`) passes the async body as an ARGUMENT, so
 * tree-sitter never extracts it as a function node: `X` is a `constant` whose body's calls are
 * ORPHANED. The `dispatch(nextThunk(...))` calls that drive a thunk chain forward therefore produce
 * no edges, so `callees(X)` is empty and a flow `dispatch(X(...)) → X → nextThunk` dead-ends at the
 * constant (validated on trezor-suite: the signXxxThunk constants had ZERO outgoing edges). Bridge
 * it: body-scan each thunk constant for `dispatch(Y(...))` and link `X → Y`, so the dispatch chain
 * connects. High-precision — the `dispatch(` keyword plus `Y` must resolve to a function/constant/
 * method node; capped; gated on thunk constants existing so it never runs on non-RTK repos.
 * Cross-file by design (a suite thunk dispatches a wallet-core thunk). Provenance `heuristic`,
 * `synthesizedBy:'redux-thunk'`; `registeredAt` is the dispatch site.
 */
const THUNK_DECL_RE = /create(?:Async)?Thunk/;

const THUNK_DISPATCH_RE = /\bdispatch\s*\(\s*([A-Za-z_]\w*)\s*[(),]/g;

const THUNK_FANOUT_CAP = 24;

export async function reduxThunkEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scanned255 = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const node of queries.iterateNodesByKind('constant')) {
    if ((++scanned255 & 63) === 0) await onYield();
    // Cheap gate: the initializer (captured in `signature`) must be a create(Async)Thunk call —
    // avoids reading every constant's body on a large repo.
    if (!node.signature || !THUNK_DECL_RE.test(node.signature)) continue;
    const content = ctx.readFile(node.filePath);
    const src = content && sliceLines(content, node.startLine, node.endLine);
    if (!src) continue;
    // Thunks are TS/JS-family (same // and /* */ comment syntax); map to a CommentLang.
    const safe = stripCommentsForRegex(src, node.language === 'javascript' || node.language === 'jsx' ? 'javascript' : 'typescript');
    THUNK_DISPATCH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let added = 0;
    while ((m = THUNK_DISPATCH_RE.exec(safe)) && added < THUNK_FANOUT_CAP) {
      const name = m[1]!;
      if (name === node.name) continue; // self-dispatch (recursive thunk) — skip
      // Resolve the dispatched name, PREFERRING the thunk/action-creator over a same-named
      // service function. `dispatch(X(...))` dispatches a thunk or an action-creator (both
      // `constant`s) — never an unrelated helper that merely shares the name. On octo-call,
      // `leaveCall` is BOTH a `createAsyncThunk` const AND a service function, and the bare
      // `.find()` picked the function (wrong). Order: thunk const > other const > same-file
      // callable > first match. A single candidate (no collision) is unaffected.
      const cands = ctx
        .getNodesByName(name)
        .filter((n) => n.kind === 'constant' || n.kind === 'function' || n.kind === 'method');
      const target =
        cands.find((n) => !!n.signature && THUNK_DECL_RE.test(n.signature)) ??
        cands.find((n) => n.kind === 'constant') ??
        cands.find((n) => n.filePath === node.filePath) ??
        cands[0];
      if (!target || target.id === node.id) continue;
      const key = `${node.id}>${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = node.startLine + safe.slice(0, m.index).split('\n').length - 1;
      edges.push({
        source: node.id,
        target: target.id,
        kind: 'calls',
        line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'redux-thunk', via: name, registeredAt: `${node.filePath}:${line}` },
      });
      added++;
    }
  }
  return edges;
}

// ── RTK Query generated-hook → endpoint ──────────────────────────────────────
// RTK Query generates one `useGetXQuery`/`useUpdateYMutation` hook per endpoint
// (`createApi({ endpoints: b => ({ getX: b.query(...) }) })`). Components call the
// hook; the fetch logic lives in the endpoint's queryFn. The hook↔endpoint link is
// pure NAMING CONVENTION (no static edge): strip `use` + the optional `Lazy`
// variant + the `Query|Mutation` suffix, lowercase the head → the endpoint key.
// Both are extracted as function nodes (the hook from its `export const {…}=api`
// binding, carrying a sentinel signature; the endpoint from the createApi object),
// so bridging hook→endpoint connects `component → useGetXQuery → getX → queryFn`.
// Gated on the extraction sentinel so it only ever fires on genuinely-generated
// hooks (never a hand-written `useFooQuery`), and on a SAME-FILE endpoint (RTK
// colocates the hooks and their api in one module) — 0 on any non-RTK repo.
const RTK_HOOK_DERIVE_RE = /^use([A-Z][A-Za-z0-9]*?)(?:Query|Mutation)$/;

// MUST match the signature set in tree-sitter.ts `extractRtkHookBindings`.
const RTK_GENERATED_HOOK_SIGNATURE = '= RTK Query generated hook';

/** Derive the endpoint key from a generated-hook name (`useLazyGetRecordsQuery`
 *  → `getRecords`), or null if it doesn't fit the convention. */
function rtkEndpointNameFromHook(hook: string): string | null {
  const m = RTK_HOOK_DERIVE_RE.exec(hook);
  if (!m) return null;
  let mid = m[1]!;
  if (mid.startsWith('Lazy')) mid = mid.slice(4); // useLazyGetX → getX (same endpoint)
  if (!mid) return null;
  return mid.charAt(0).toLowerCase() + mid.slice(1);
}

export async function rtkQueryEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scanned255 = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const hook of queries.iterateNodesByKind('function')) {
    if ((++scanned255 & 63) === 0) await onYield();
    // Only our extracted generated-hook bindings (sentinel) — not a real hook fn.
    if (hook.signature !== RTK_GENERATED_HOOK_SIGNATURE) continue;
    const endpointName = rtkEndpointNameFromHook(hook.name);
    if (!endpointName) continue;
    // The endpoint is a same-file function by the derived name (RTK colocates the
    // api definition and its generated-hook exports in one module).
    const target = ctx
      .getNodesByName(endpointName)
      .find((n) => n.kind === 'function' && n.filePath === hook.filePath);
    if (!target || target.id === hook.id) continue;
    const key = `${hook.id}>${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      source: hook.id,
      target: target.id,
      kind: 'calls',
      line: hook.startLine,
      provenance: 'heuristic',
      metadata: { synthesizedBy: 'rtk-query', via: endpointName, registeredAt: `${hook.filePath}:${hook.startLine}` },
    });
  }
  return edges;
}
