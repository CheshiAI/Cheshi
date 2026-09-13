import { existsSync, readFileSync } from 'fs';
import type CodeGraph from '../index';
import type { Edge, Node } from '../types';
import {
  validatePathWithinRoot
} from '../utils';
import { scanDynamicDispatch } from './dynamic-boundaries';
import type { ToolHandlerState } from './tool-handler-state';

/**
   * Describe a synthesized (dynamic-dispatch) edge for human output: how the
   * callback was wired up — the bridge static parsing can't see. Returns null
   * for ordinary static edges. Used by trace + the node trail so a synthesized
   * hop reads as "registered via onUpdate at App.tsx:3148", not a bare arrow.
   */
export function synthEdgeNote(this: ToolHandlerState, edge: Edge | null): { label: string; compact: string; registeredAt?: string } | null {
  if (!edge || edge.provenance !== 'heuristic') return null;
  const m = edge.metadata as Record<string, unknown> | undefined;
  const registeredAt = typeof m?.registeredAt === 'string' ? m.registeredAt : undefined;
  const at = registeredAt ? ` @${registeredAt}` : '';
  if (m?.synthesizedBy === 'callback') {
    const via = m.via ? `\`${String(m.via)}\`` : 'a registrar';
    const field = m.field ? ` on .${String(m.field)}` : '';
    return {
      label: `callback — registered via ${via}${field} (dynamic dispatch)`,
      compact: `dynamic: callback via ${via}${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'event-emitter') {
    const ev = m.event ? `\`${String(m.event)}\`` : 'an event';
    return {
      label: `event ${ev} — emit → handler (dynamic dispatch)`,
      compact: `dynamic: event ${ev}${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'react-render') {
    return {
      label: `React re-render — \`setState\` re-runs render() (dynamic dispatch)`,
      compact: `dynamic: React re-render via setState${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'jsx-render') {
    const child = m.via ? `<${String(m.via)}>` : 'a child component';
    return {
      label: `renders ${child} (JSX child — dynamic dispatch)`,
      compact: `dynamic: renders ${child}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'vue-handler') {
    const ev = m.event ? `@${String(m.event)}` : 'a template event';
    return {
      label: `Vue template handler — bound to ${ev} (dynamic dispatch)`,
      compact: `dynamic: Vue ${ev} handler`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'interface-impl') {
    return {
      label: `interface/abstract dispatch — runs the implementation override (dynamic dispatch)`,
      compact: `dynamic: interface → impl${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'closure-collection') {
    const field = m.field ? `\`${String(m.field)}\`` : 'a collection';
    return {
      label: `closure collection — runs handlers appended to ${field} (dynamic dispatch)`,
      compact: `dynamic: runs ${field} handlers${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'fn-pointer-dispatch') {
    const via = m.via ? `\`${String(m.via)}\`` : 'a function pointer';
    return {
      label: `function-pointer dispatch via ${via} (dynamic dispatch)`,
      compact: `dynamic: fn-pointer ${m.via ? String(m.via) : ''}${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'goframe-route') {
    const route = m.route ? `\`${String(m.route)}\`` : 'a route';
    return {
      label: `GoFrame route ${route} — reflective Bind → controller method (dynamic dispatch)`,
      compact: `dynamic: GoFrame route ${m.route ? String(m.route) : ''}${at}`,
      registeredAt,
    };
  }
  // Generic fallback for any other synthesizer (redux-thunk, gin-middleware-chain,
  // flutter-build, …): a synthesized hop must never read as a bare static `calls`.
  // It's a dynamic-dispatch bridge — label it as one and keep its wiring site.
  if (typeof m?.synthesizedBy === 'string') {
    const kind = m.synthesizedBy.replace(/-/g, ' ');
    return { label: `${kind} (dynamic dispatch)`, compact: `dynamic: ${kind}${at}`, registeredAt };
  }
  return null;
}

/**
   * Flow-from-named-symbols: an agent's codegraph_explore query is a bag of
   * symbol names that usually spans the flow it's investigating (e.g.
   * "PmsProductController getList PmsProductService list PmsProductServiceImpl").
   * Surface the longest call chain AMONG those named symbols — scoped to what the
   * agent explicitly named, so (unlike a fuzzy relevance set) there's no
   * wrong-feature wandering. Rides synthesized edges, so controller→service-
   * interface→impl shows up. Returns '' if no chain of >=3 nodes exists.
   *
   * Ambiguous tokens (Java `list` → dozens of nodes) are disambiguated by
   * CO-NAMING: the agent names the class too, so we keep only `list` candidates
   * whose qualifiedName contains another named token (`PmsProductServiceImpl::list`),
   * dropping unrelated `OmsOrderService::list`.
   */
export function buildFlowFromNamedSymbols(this: ToolHandlerState, cg: CodeGraph, query: string): { text: string; pathNodeIds: Set<string>; namedNodeIds: Set<string>; uniqueNamedNodeIds: Set<string>; spineCallSites: Map<string, number> } {
  // spineCallSites: for each spine node, the line where it CALLS the next hop —
  // lets the source assembler window an oversize spine method (e.g. n8n's 962-line
  // processRunExecutionData) to the call site instead of dumping the whole body.
  const EMPTY = { text: '', pathNodeIds: new Set<string>(), namedNodeIds: new Set<string>(), uniqueNamedNodeIds: new Set<string>(), spineCallSites: new Map<string, number>() };
  try {
    const CALLABLE = new Set(['method', 'function', 'component', 'constructor']);
    // Strip only a REAL file extension (Create.cs → Create); KEEP qualified
    // names (Class.method / Class::method) — the agent's most precise input,
    // resolved exactly by findAllSymbols. (The old strip mangled Class.method
    // into Class, throwing the method away.)
    const FILE_EXT = /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte|astro|erl|hrl)$/i;
    const tokens = [...new Set(
      query.split(/[\s,()[\]]+/)
        .map((t) => t.replace(FILE_EXT, '').trim())
        .filter((t) => t.length >= 3 && /^[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*$/.test(t))
    )].slice(0, 16);
    if (tokens.length < 2) return EMPTY;
    // Pool of name SEGMENTS (Class + method from every token) used to
    // disambiguate an ambiguous SIMPLE name: keep a candidate only if its
    // CONTAINER class is itself named in the query.
    const segPool = new Set<string>();
    for (const t of tokens) for (const s of t.toLowerCase().split(/::|\./)) if (s) segPool.add(s);
    const named = new Map<string, Node>();
    // Nodes whose token is SPECIFIC — a (near-)unique callable name (<=3 defs in
    // the whole graph). These are safe to SPARE a file on: the agent named THIS
    // method (`getResponseWithInterceptorChain`, 1 def). A hyper-polymorphic name
    // (`as_sql`, 110 defs across every Expression/Compiler subclass) is NOT here,
    // so naming it doesn't keep every backend variant full and flood the budget.
    const uniqueNamedNodeIds = new Set<string>();
    // token → resolved node ids: drives the token-coverage check that gates
    // the dynamic-boundary scan (a token is covered when ANY of its nodes
    // lands on the main chain — overloads off the chain don't count against).
    const tokenNodes = new Map<string, string[]>();
    // token → its full same-name callable family (before the container filter).
    // A LARGE family that fails to connect on the chain is a polymorphic
    // interface/registry dispatch — surfaced by buildPolymorphicBoundaries below.
    const tokenFamily = new Map<string, Node[]>();
    // Non-callable endpoints (CONSTANT/VARIABLE/FIELD) connected by a SYNTHESIZED
    // edge. RTK thunks are `const X = createAsyncThunk(...)`, so a thunk→thunk hop
    // is constant→constant — the CALLABLE-only `named` set can't hold it, and
    // without this the hop is invisible to the Flow path at every tier (the
    // Relationships section catches it only on repos ≥500 files). Kept SEPARATE
    // from `named` (which drives the call-chain + source sizing, callable-only);
    // fed only to the dynamic-dispatch-links scan below.
    const dynNamed = new Map<string, Node>();
    const DYN_KINDS = new Set(['constant', 'variable', 'field', 'property']);
    const hasHeuristicEdge = (id: string): boolean =>
      [...cg.getCallers(id), ...cg.getCallees(id)].some(({ edge }) => edge.provenance === 'heuristic');
    for (const t of tokens) {
      const hits = this.findAllSymbols(cg, t).nodes;
      const cands = hits.filter((n) => CALLABLE.has(n.kind));
      tokenFamily.set(t, cands);
      // A qualified or otherwise-specific name (<=3 hits) keeps all; an
      // ambiguous simple name keeps only candidates whose container is named.
      const specific = cands.length <= 3;
      const pick = specific
        ? cands
        : cands.filter((n) => {
          const segs = (n.qualifiedName || '').toLowerCase().split(/::|\./).filter(Boolean);
          const container = segs.length >= 2 ? segs[segs.length - 2] : '';
          return !!container && segPool.has(container);
        });
      const kept = pick.slice(0, 6);
      tokenNodes.set(t, kept.map((n) => n.id));
      for (const n of kept) {
        named.set(n.id, n);
        if (specific) uniqueNamedNodeIds.add(n.id);
      }
      // Same token, non-callable synth endpoints (capped, precision-gated on an
      // actual heuristic edge so plain config constants never qualify).
      // Per-token sub-cap so one token's many endpoints (10 nix option writes
      // of `programs.git.enable` across test configs) can't fill the pool
      // before later tokens (`home.file`) get a slot.
      if (dynNamed.size < 12) {
        let tokenDyn = 0;
        for (const n of hits) {
          if (CALLABLE.has(n.kind) || !DYN_KINDS.has(n.kind) || dynNamed.has(n.id)) continue;
          if (hasHeuristicEdge(n.id)) {
            dynNamed.set(n.id, n);
            tokenDyn++;
          }
          if (dynNamed.size >= 12 || tokenDyn >= 4) break;
        }
      }
      if (named.size > 40) break;
    }
    // Surface synthesized (heuristic) edges incident to a named symbol — INCLUDING
    // the non-callable CONSTANT endpoints in `dynNamed`. `skipInChain` drops a hop
    // already shown in the rendered main chain (a 2-node chain renders nothing, so a
    // direct named→named synth hop still surfaces — #687).
    const collectSynthLinks = (skipInChain: ((e: Edge) => boolean) | null): string[] => {
      const synthLines: string[] = [];
      const synthSeen = new Set<string>();
      for (const n of [...named.values(), ...dynNamed.values()]) {
        if (synthLines.length >= 6) break;
        for (const { node: other, edge } of [...cg.getCallers(n.id), ...cg.getCallees(n.id)]) {
          if (synthLines.length >= 6) break;
          if (edge.provenance !== 'heuristic' || other.id === n.id) continue;
          if (skipInChain && skipInChain(edge)) continue;
          const src = edge.source === n.id ? n : other;
          const tgt = edge.source === n.id ? other : n;
          const key = `${src.name}>${tgt.name}`;
          if (synthSeen.has(key)) continue;
          synthSeen.add(key);
          const note = this.synthEdgeNote(edge);
          synthLines.push(`- ${src.name} → ${tgt.name}   [${note ? note.compact : edge.kind}]`);
        }
      }
      return synthLines;
    };
    if (named.size < 2) {
      // <2 CALLABLES resolved. Two recoveries before giving up: (1) synthesized
      // edges among named CONSTANT/VARIABLE endpoints — RTK thunk→thunk is
      // constant→constant, so `named` can be empty while `dynNamed` holds the
      // whole chain; (2) the one resolved callable's body may hold the
      // dynamic-dispatch site that EXPLAINS a half-connected flow.
      const synthLines = collectSynthLinks(null);
      const boundaries = named.size === 0 ? '' : (this.buildDynamicBoundaries(cg, [...named.values()], named) || '');
      if (synthLines.length === 0 && !boundaries) return EMPTY;
      const out: string[] = [];
      if (synthLines.length) out.push(
        '**Dynamic-dispatch links among your symbols**',
        '(synthesized — the indirect hops grep/Read would reconstruct; the `@file:line` is the wiring site)',
        '', ...synthLines, '');
      if (boundaries) out.push(boundaries);
      out.push('> Source ranges for these symbols follow; check continuation notices for omitted source.\n');
      return { text: out.join('\n'), pathNodeIds: new Set(), namedNodeIds: new Set<string>([...named.keys(), ...dynNamed.keys()]), uniqueNamedNodeIds, spineCallSites: new Map<string, number>() };
    }
    const MAX_HOPS = 7;
    let best: Array<{ node: Node; edge: Edge | null }> | null = null;
    // BFS the full call graph (incl. synth edges) from each named seed, but
    // only ACCEPT a sink that is also named — both ends anchored to symbols the
    // agent named, so the chain stays on-topic while bridging intermediates
    // (e.g. the exact interface overload) that the token resolution missed.
    for (const seed of [...named.values()].slice(0, 8)) {
      const parent = new Map<string, { prev: string | null; edge: Edge | null; node: Node }>();
      parent.set(seed.id, { prev: null, edge: null, node: seed });
      const q: Array<{ id: string; depth: number; streak: number }> = [{ id: seed.id, depth: 0, streak: 0 }];
      let deep: string | null = null, deepDepth = 0;
      const MAX_BRIDGE = 1; // ≤1 consecutive UNNAMED hop: bridge one missing intermediate, never wander a god-function's fan-out
      for (let h = 0; h < q.length && parent.size < 1500; h++) {
        const { id, depth, streak } = q[h]!;
        if (id !== seed.id && named.has(id) && depth > deepDepth) { deep = id; deepDepth = depth; }
        if (depth >= MAX_HOPS - 1) continue;
        for (const c of cg.getCallees(id)) {
          if (c.edge.kind !== 'calls' || parent.has(c.node.id)) continue;
          const newStreak = named.has(c.node.id) ? 0 : streak + 1;
          if (newStreak > MAX_BRIDGE) continue;
          parent.set(c.node.id, { prev: id, edge: c.edge, node: c.node });
          q.push({ id: c.node.id, depth: depth + 1, streak: newStreak });
        }
      }
      if (!deep) continue;
      const chain: Array<{ node: Node; edge: Edge | null }> = [];
      let cur: string | null = deep;
      while (cur) { const p = parent.get(cur); if (!p) break; chain.push({ node: p.node, edge: p.edge }); cur = p.prev; }
      chain.reverse();
      if (!best || chain.length > best.length) best = chain;
    }
    const hasMain = !!best && best.length >= 3;
    const pathIds = new Set((best ?? []).map((s) => s.node.id));
    // Where each spine node calls the NEXT hop (best[i+1].edge is the edge from
    // best[i] → best[i+1]; its line is the call site inside best[i]'s body). Lets
    // the assembler window an oversize spine method to the call instead of dumping it.
    const spineCallSites = new Map<string, number>();
    if (best) for (let i = 0; i < best.length - 1; i++) {
      const ln = best[i + 1]?.edge?.line;
      if (ln && ln > 0 && !spineCallSites.has(best[i]!.node.id)) spineCallSites.set(best[i]!.node.id, ln);
    }

    // Dynamic-boundary scan (#687) — fires ONLY when the flow the agent
    // asked about did not fully connect: some token resolved to nodes but
    // none of them sit on the main chain (or there is no chain at all). A
    // healthy flow skips this entirely. Scan order: the chain's dead end
    // first (where the partial flow stops), then the disconnected symbols,
    // agent-specific (unique-named) ones first.
    let boundaryText = '';
    {
      const uncovered: Node[] = [];
      if (!hasMain) {
        // No rendered chain — but a 2-node chain still CONNECTS its two
        // endpoints (e.g. via one synthesized hop, surfaced below as a
        // dynamic-dispatch link). Only nodes off that short chain are
        // unexplained breaks worth scanning.
        for (const n of named.values()) if (!pathIds.has(n.id)) uncovered.push(n);
      } else {
        for (const ids of tokenNodes.values()) {
          if (ids.length === 0 || ids.some((id) => pathIds.has(id))) continue;
          for (const id of ids) { const n = named.get(id); if (n) uncovered.push(n); }
        }
      }
      if (uncovered.length > 0) {
        const scanList: Node[] = [];
        if (hasMain) scanList.push(best![best!.length - 1]!.node);
        scanList.push(...uncovered.sort((a, b) =>
          (uniqueNamedNodeIds.has(b.id) ? 1 : 0) - (uniqueNamedNodeIds.has(a.id) ? 1 : 0)));
        boundaryText = this.buildDynamicBoundaries(cg, scanList, named);
      }
    }

    // Interface/registry-dispatch announcement (extends #687 to GRAPH-visible
    // polymorphism). A method the agent NAMED that resolves to a large same-name
    // family AND did not land on the main chain is almost always a runtime
    // dispatch (plugin/strategy/handler interface): the concrete target is chosen
    // at runtime from N implementations, so no single static edge is the answer.
    // The body-scan above can't see this — `nodeType.execute()` is textually an
    // ordinary call; the polymorphism lives in the graph (implements edges), so
    // detect it there. Fires ONLY for an uncovered named token; a connected flow
    // stays silent.
    let polyText = '';
    {
      const POLY_MIN_FAMILY = 8; // smaller families are overload sets, not dispatch
      const polyCands: Array<{ token: string; family: Node[] }> = [];
      for (const [t, fam] of tokenFamily) {
        if (fam.length < POLY_MIN_FAMILY) continue;
        const ids = tokenNodes.get(t) || [];
        if (ids.some((id) => pathIds.has(id))) continue; // covered by the flow — silent
        polyCands.push({ token: t, family: fam });
      }
      if (polyCands.length) polyText = this.buildPolymorphicBoundaries(cg, polyCands, named);
    }

    // Supplementary: dynamic-dispatch (synthesized) edges incident to a named
    // symbol (incl. the non-callable CONSTANT endpoints in `dynNamed`) — the
    // indirect hops an agent would otherwise grep/Read to reconstruct ("where do
    // the appended `validators` actually run?"). Surfaced even when the OTHER end
    // wasn't named. The skip drops a hop already in the rendered main chain; a
    // 2-node chain renders nothing (hasMain false) so a direct named→named synth
    // hop still surfaces — too short for Flow, but #687-visible here.
    const synthLines = collectSynthLinks(
      hasMain ? (e: Edge) => pathIds.has(e.source) && pathIds.has(e.target) : null
    );

    if (!hasMain && synthLines.length === 0 && !boundaryText && !polyText) return EMPTY;
    const out: string[] = [];
    if (hasMain) {
      out.push('**Flow (call path among the symbols you queried)**', '');
      for (let i = 0; i < best!.length; i++) {
        const step = best![i]!;
        if (step.edge) { const sy = this.synthEdgeNote(step.edge); out.push(`   ↓ ${sy ? sy.compact : step.edge.kind}`); }
        out.push(`${i + 1}. ${step.node.name} (${step.node.filePath}:${step.node.startLine})`);
      }
      out.push('');
    }
    if (synthLines.length) {
      out.push(
        '**Dynamic-dispatch links among your symbols**',
        '(synthesized — the indirect hops grep/Read would reconstruct; the `@file:line` is the wiring site)',
        '',
        ...synthLines,
        ''
      );
    }
    if (boundaryText) out.push(boundaryText);
    if (polyText) out.push(polyText);
    out.push('> Source ranges follow the call flow; check continuation notices for omitted source.', '');
    // namedNodeIds = every callable the agent explicitly named (a superset of
    // the spine). A file holding one is something the agent asked to SEE, so it
    // must keep full source even if it's an off-spine polymorphic sibling — the
    // agent named `getResponseWithInterceptorChain` / `SQLCompiler.execute_sql`
    // as the mechanism, not as an interchangeable leaf. See the skeleton gate.
    return { text: out.join('\n'), pathNodeIds: pathIds, namedNodeIds: new Set<string>([...named.keys(), ...dynNamed.keys()]), uniqueNamedNodeIds, spineCallSites };
  } catch {
    return EMPTY;
  }
}

/**
   * Dynamic-boundary surfacing (#687): when the flow among the agent's named
   * symbols does not fully connect, scan the disconnected symbols' bodies for
   * dynamic-dispatch sites (computed member calls, getattr, reflection, typed
   * message buses, runtime-keyed emits) and ANNOUNCE the boundary — the exact
   * site, the form, and (when a key is statically visible) candidate targets —
   * instead of guessing edges. The answer to "how does A reach B" when no
   * static path exists IS the dispatch site: that's where the flow continues
   * at runtime. Query-time, deterministic, zero graph mutation; a fully
   * connected flow never reaches this method.
   */
export function buildDynamicBoundaries(this: ToolHandlerState, cg: CodeGraph, scanList: Node[], named: Map<string, Node>): string {
  const MAX_NOTES = 4;       // boundary bullets per explore
  const MAX_SCAN = 8;        // bodies scanned
  const MAX_TOTAL_CHARS = 200_000;
  let projectRoot: string;
  try { projectRoot = cg.getProjectRoot(); } catch { return ''; }
  const notes: string[] = [];
  const seenNode = new Set<string>();
  const seenSite = new Set<string>();
  let scanned = 0, charsScanned = 0;
  for (const node of scanList) {
    if (notes.length >= MAX_NOTES || scanned >= MAX_SCAN || charsScanned > MAX_TOTAL_CHARS) break;
    if (seenNode.has(node.id) || !node.startLine || !node.endLine) continue;
    seenNode.add(node.id);
    const absPath = validatePathWithinRoot(projectRoot, node.filePath);
    if (!absPath || !existsSync(absPath)) continue;
    let content: string;
    try { content = readFileSync(absPath, 'utf-8'); } catch { continue; }
    const body = content.split('\n').slice(node.startLine - 1, node.endLine).join('\n');
    scanned++;
    charsScanned += body.length;
    for (const m of scanDynamicDispatch(body, node.language || '', node.startLine)) {
      if (notes.length >= MAX_NOTES) break;
      const siteKey = `${node.filePath}:${m.line}:${m.form}`;
      if (seenSite.has(siteKey)) continue;
      seenSite.add(siteKey);
      const more = m.moreSites ? ` (+${m.moreSites} more such site${m.moreSites > 1 ? 's' : ''} in this body)` : '';
      notes.push(`- \`${node.name}\` (${node.filePath}:${m.line}) — ${m.label}: \`${m.snippet}\`${more}`);
      if (m.key) {
        const cand = this.boundaryCandidates(cg, m.key, !!m.keyIsType, named, node.id);
        if (cand) notes.push(`  ${cand}`);
      }
    }
  }
  if (notes.length === 0) return '';
  return [
    '**Dynamic boundaries (the static path ends at runtime dispatch)**',
    '',
    ...notes,
    '',
    '> These sites choose their call target at runtime (registry / bus / reflection) — the site shown IS where the flow continues. To follow it, run codegraph_explore or codegraph_node on a candidate; source for the sites above is included below.',
    '',
  ].join('\n');
}

/**
   * Interface/registry-dispatch announcement — #687 extended to GRAPH-visible
   * polymorphism (the body-scan can't see it: `nodeType.execute()` is textually
   * an ordinary call; the polymorphism lives in the `implements`/`extends` edges).
   *
   * A method the agent named that resolves to a large same-name family whose
   * definers overwhelmingly implement/extend ONE supertype is a runtime dispatch:
   * the concrete target is chosen at runtime from N implementations, so no single
   * static edge is "the answer" — the implementations ARE the continuations. We
   * announce the supertype, its TRUE implementer count, and a few concrete targets,
   * then steer to codegraph_explore. Graph-only, query-time, zero mutation; the
   * caller fires it ONLY for an UNCOVERED named token, so a connected flow is silent.
   *
   * Robust to FTS sampling bias: the same-name family is a capped FTS sample that
   * over-represents whatever FTS ranks first (n8n: DB `TableOperation.execute`
   * outnumbered `INodeType.execute` in the sample 7:6 even though INodeType has
   * 611 implementers vs a handful). So candidate supertypes are ranked by their
   * TRUE graph-wide implementer count, NOT their frequency in the sample.
   */
export function buildPolymorphicBoundaries(this: ToolHandlerState, cg: CodeGraph, candidates: Array<{ token: string; family: Node[] }>, named: Map<string, Node>): string {
  const CLASSY = new Set(['class', 'struct', 'interface', 'trait', 'protocol', 'abstract']);
  const MIN_IMPL = 8;     // a supertype needs >= this many implementers to count as "polymorphic"
  const MIN_SUPPORT = 2;  // >= this many sampled definers must share the supertype (ties it to the token)
  const SAMPLE = 40;      // family members inspected per token
  const MAX_NOTES = 3;
  const rel = (p: string) => p.replace(/\\/g, '/');
  const containerOf = (m: Node): Node | null => {
    try { const ce = cg.getIncomingEdges(m.id).find((e) => e.kind === 'contains'); return ce ? cg.getNode(ce.source) : null; }
    catch { return null; }
  };
  const notes: string[] = [];
  const seenSuper = new Set<string>();
  for (const { token, family } of candidates) {
    if (notes.length >= MAX_NOTES) break;
    // supertype id → how many sampled definers share it + a few example definers
    const supers = new Map<string, { node: Node; count: number; targets: Node[] }>();
    for (const m of family.slice(0, SAMPLE)) {
      const container = containerOf(m);
      if (!container || !CLASSY.has(container.kind)) continue;
      let sups: Node[] = [];
      try {
        sups = cg.getOutgoingEdges(container.id)
          .filter((e) => e.kind === 'implements' || e.kind === 'extends')
          .map((e) => { try { return cg.getNode(e.target); } catch { return null; } })
          .filter((n): n is Node => !!n && CLASSY.has(n.kind) && (n.name?.length || 0) >= 3);
      } catch { /* no supertypes — free function or unresolved */ }
      for (const s of sups) {
        const e = supers.get(s.id) || { node: s, count: 0, targets: [] };
        e.count++;
        if (e.targets.length < 6) e.targets.push(m);
        supers.set(s.id, e);
      }
    }
    // Pick the supertype with the most TRUE implementers (graph-wide), among
    // those genuinely shared by the token's definers.
    let best: { node: Node; impl: number; targets: Node[] } | null = null;
    for (const { node, count, targets } of supers.values()) {
      if (count < MIN_SUPPORT) continue;
      let impl = 0;
      try { impl = cg.getIncomingEdges(node.id).filter((e) => e.kind === 'implements' || e.kind === 'extends').length; }
      catch { /* leave 0 — gated out below */ }
      if (impl < MIN_IMPL) continue;
      if (!best || impl > best.impl) best = { node, impl, targets };
    }
    if (!best || seenSuper.has(best.node.id)) continue;
    seenSuper.add(best.node.id);
    const namedNames = new Set([...named.values()].map((n) => n.name));
    const eg = best.targets.slice(0, 4).map((m) => {
      const cont = containerOf(m);
      const disp = cont ? `${cont.name}.${m.name}` : (m.qualifiedName || m.name);
      const mark = cont && namedNames.has(cont.name) ? ' ← you named this' : '';
      return `\`${disp}\` (${rel(m.filePath)}:${m.startLine})${mark}`;
    });
    const more = best.impl > eg.length ? ` +${best.impl - eg.length} more` : '';
    notes.push(`- \`${token}\` → runtime dispatch to **${best.impl}** types implementing \`${best.node.name}\` — the static path ends here, the target is chosen at runtime. e.g. ${eg.join(', ')}${more}`);
  }
  if (notes.length === 0) return '';
  return [
    '**Interface dispatch (a named method has many implementations)**',
    '',
    ...notes,
    '',
    '> The method above is dispatched at runtime to one of the listed implementations (a registry / plugin / strategy interface) — there is no single static caller→callee edge; the implementations ARE the continuations. To follow one, run codegraph_explore on a listed target.',
    '',
  ].join('\n');
}

/**
   * Shortlist candidate runtime targets for a dispatch key surfaced by
   * {@link buildDynamicBoundaries}. Exact conventional names first (`save` →
   * `onSave`/`handleSave`; `CreateCmd` → `CreateCmdHandler`), then FTS, with a
   * normalized-containment post-filter (FTS camel-splitting is fuzzier than a
   * candidate list should be). Symbols the agent already named sort first and
   * are marked — that's the "you were right, here's the wiring" case.
   */
export function boundaryCandidates(this: ToolHandlerState, cg: CodeGraph, key: string, keyIsType: boolean, named: Map<string, Node>, selfId: string): string {
  const CALLABLE = new Set(['method', 'function', 'component', 'constructor', 'class']);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const keyNorm = norm(key);
  if (keyNorm.length < 3) return '';
  const cands = new Map<string, Node>();
  const consider = (n: Node | undefined | null) => {
    if (!n || n.id === selfId || !CALLABLE.has(n.kind) || cands.has(n.id)) return;
    const nameNorm = norm(n.name || '');
    if (nameNorm.length < 3) return;
    if (!nameNorm.includes(keyNorm) && !keyNorm.includes(nameNorm)) return;
    cands.set(n.id, n);
  };
  const cap = key.charAt(0).toUpperCase() + key.slice(1);
  const probes = keyIsType
    ? [`${key}Handler`, key]
    : [key, `on${cap}`, `handle${cap}`, `${key}Handler`, `handle_${key}`];
  for (const p of probes) {
    try { for (const n of cg.getNodesByName(p)) consider(n); } catch { /* exact probe miss is fine */ }
  }
  let raw = 0;
  try {
    const results = cg.searchNodes(key, { limit: 12 });
    raw = results.length;
    for (const r of results) consider(r.node);
  } catch { /* FTS syntax edge — exact probes already ran */ }
  if (cands.size === 0) {
    return raw >= 12 && key.length < 5 ? `key \`${key}\` is too generic to shortlist (${raw}+ matches)` : '';
  }
  // A constructor candidate duplicates its class: extractors emit ctors as
  // METHOD nodes named like the class (C#/Java `Foo::Foo`) — keep the class.
  const all = [...cands.values()];
  const classKey = new Set(all.filter((n) => n.kind === 'class').map((n) => `${n.name}|${n.filePath}`));
  const namedNames = new Set([...named.values()].map((n) => n.name));
  const isNamed = (n: Node) => named.has(n.id) || namedNames.has(n.name); // the flow's named set holds callables only — transfer the mark to the class
  const list = all
    .filter((n) => !(n.kind !== 'class' && classKey.has(`${n.name}|${n.filePath}`)))
    .sort((a, b) => (isNamed(b) ? 1 : 0) - (isNamed(a) ? 1 : 0))
    .slice(0, 4)
    .map((n) => {
      // Typed-bus convention: the runtime target is the candidate class's
      // Handle/Execute/Consume method — name the exact node, not just the class.
      let display = n.qualifiedName || n.name;
      let at = `${n.filePath}:${n.startLine}`;
      if (keyIsType && n.kind === 'class') {
        try {
          const HANDLER_METHODS = /^(handle|handleAsync|execute|executeAsync|consume|consumeAsync|run|__invoke)$/i;
          const method = cg.getOutgoingEdges(n.id)
            .filter((e) => e.kind === 'contains')
            .map((e) => { try { return cg.getNode(e.target); } catch { return null; } })
            .find((c): c is Node => !!c && c.kind === 'method' && HANDLER_METHODS.test(c.name));
          if (method) { display = `${n.name}.${method.name}`; at = `${method.filePath}:${method.startLine}`; }
        } catch { /* class without resolvable members — show the class itself */ }
      }
      return `\`${display}\` (${at})${isNamed(n) ? ' ← you named this' : ''}`;
    });
  return `candidates for key \`${key}\`: ${list.join(', ')}`;
}
