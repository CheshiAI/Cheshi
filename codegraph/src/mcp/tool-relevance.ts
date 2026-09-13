import type CodeGraph from '../index';
import { isTestFile } from '../search/query-utils';
import type { Edge, Node, Subgraph } from '../types';
import type { ToolHandlerState } from './tool-handler-state';

/**
   * Compact "blast radius" for the entry symbols of an explore result: who
   * depends on each (callers) and which test files cover it — LOCATIONS ONLY,
   * no source, so the agent knows what to update / re-verify before editing
   * without reaching for a separate impact call. Always-on, but skips symbols
   * that have no dependents (nothing to warn about), and returns '' when none
   * qualify so a leaf-only exploration stays clean.
   */
export function buildBlastRadiusSection(this: ToolHandlerState, cg: CodeGraph, subgraph: Subgraph): string {
  const ROOT_CAP = 5; // only the symbols the query actually targeted
  const FILE_CAP = 4; // caller files listed per symbol before "+N more"
  const MEANINGFUL = new Set<string>([
    'function', 'method', 'class', 'interface', 'struct', 'trait', 'protocol',
    'enum', 'type_alias', 'component', 'constant', 'variable', 'property', 'field',
  ]);
  const rel = (p: string) => p.replace(/\\/g, '/');

  const roots = subgraph.roots
    .map((id) => subgraph.nodes.get(id))
    .filter((n): n is Node => !!n && MEANINGFUL.has(n.kind))
    .slice(0, ROOT_CAP);
  if (roots.length === 0) return '';

  const entries: string[] = [];
  for (const root of roots) {
    let callers: Array<{ node: Node }> = [];
    try { callers = cg.getCallers(root.id) as Array<{ node: Node }>; } catch { /* skip this root */ }

    const seen = new Set<string>();
    const uniq: Node[] = [];
    for (const c of callers) {
      if (c?.node && !seen.has(c.node.id)) { seen.add(c.node.id); uniq.push(c.node); }
    }
    if (uniq.length === 0) continue; // no blast radius → nothing to flag

    const callerFiles = [...new Set(uniq.map((n) => rel(n.filePath)))];
    const testFiles = callerFiles.filter((f) => isTestFile(f));
    const nonTest = callerFiles.filter((f) => !isTestFile(f));

    const shown = nonTest.slice(0, FILE_CAP).map((f) => `\`${f}\``).join(', ');
    const more = nonTest.length > FILE_CAP ? ` +${nonTest.length - FILE_CAP} more` : '';
    const where = nonTest.length > 0 ? ` in ${shown}${more}` : '';
    const tests = testFiles.length > 0
      ? `; tests: ${testFiles.slice(0, FILE_CAP).map((f) => `\`${f}\``).join(', ')}${testFiles.length > FILE_CAP ? ` +${testFiles.length - FILE_CAP}` : ''}`
      : this.indirectTestNote(cg, uniq, rel);

    entries.push(
      `- \`${root.name}\` (${rel(root.filePath)}:${root.startLine}) — ${uniq.length} caller${uniq.length === 1 ? '' : 's'}${where}${tests}`,
    );
  }
  if (entries.length === 0) return '';

  return [
    '**Blast radius — what depends on these (update/verify before editing)**',
    '',
    ...entries,
    '',
  ].join('\n');
}

/**
   * Test-coverage note for a blast-radius entry whose DIRECT callers include no
   * test file. A helper called only by production code can still be exercised
   * by tests further up the caller chain (#1475: 40% of directly-unflagged
   * symbols had a test within 2-3 hops), so walk up to 2 more hops before
   * claiming anything — and even then claim only what was measured.
   */
export function indirectTestNote(this: ToolHandlerState, cg: CodeGraph, directCallers: Node[], rel: (p: string) => string): string {
  const MAX_HOPS = 3; // direct callers are hop 1
  const BUDGET = 64;  // getCallers lookups per entry — bounds god-fan-in symbols
  const FILE_CAP = 2;
  let budget = BUDGET;
  const visited = new Set(directCallers.map((n) => n.id));
  let frontier = directCallers;
  for (let hop = 2; hop <= MAX_HOPS && frontier.length > 0 && budget > 0; hop++) {
    const next: Node[] = [];
    const found = new Set<string>();
    for (const node of frontier) {
      if (budget-- <= 0) break;
      let callers: Array<{ node: Node }> = [];
      try { callers = cg.getCallers(node.id) as Array<{ node: Node }>; } catch { continue; }
      for (const c of callers) {
        const n = c?.node;
        if (!n || visited.has(n.id)) continue;
        visited.add(n.id);
        const f = rel(n.filePath);
        if (isTestFile(f)) found.add(f);
        else next.push(n);
      }
    }
    if (found.size > 0) {
      const files = [...found];
      const shown = files.slice(0, FILE_CAP).map((f) => `\`${f}\``).join(', ');
      const more = files.length > FILE_CAP ? ` +${files.length - FILE_CAP}` : '';
      return `; tested via callers: ${shown}${more}`;
    }
    frontier = next;
  }
  // Budget exhaustion means hops 2-3 weren't fully searched — fall back to
  // the weaker claim that IS established by the direct-caller check.
  return budget > 0
    ? `; no tests found within ${MAX_HOPS} caller hops`
    : '; no test calls this directly';
}

/**
   * Graph-connectivity relevance via Random-Walk-with-Restart (personalized
   * PageRank) from the query's matched SEED nodes over the call/reference graph.
   *
   * This is the ranking signal text search (FTS/bm25) CANNOT provide, and it's
   * codegraph's home turf: relevance by STRUCTURE, not words. A file whose
   * symbols are call-connected to the matched cluster accrues walk mass and
   * ranks high; a lone TEXT match — e.g. `LensSwitcher.swift` matched the word
   * "switch" from `switchOrganization`, but calls none of `setUser`/`fetchUser`
   * — gets only its own restart probability and ranks ~0. Immune to the
   * tokenization trap that fools term matching, deterministic, no embeddings.
   *
   * Undirected adjacency (reachability both ways), restart α=0.25 to the seeds,
   * power iteration to convergence. Bounded to the already-relevant subgraph, so
   * it's a few hundred nodes × ~25 iterations — negligible cost.
   */
export function computeGraphRelevance(this: ToolHandlerState, nodeIds: string[], edges: Edge[], seedIds: Set<string>): Map<string, number> {
  const out = new Map<string, number>();
  const n = nodeIds.length;
  if (n === 0) return out;
  const idx = new Map<string, number>();
  for (let i = 0; i < n; i++) idx.set(nodeIds[i]!, i);

  const RANK_EDGES = new Set<string>([
    'calls', 'references', 'extends', 'implements', 'overrides',
    'instantiates', 'returns', 'type_of', 'imports',
  ]);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    if (!RANK_EDGES.has(e.kind)) continue;
    const i = idx.get(e.source);
    const j = idx.get(e.target);
    if (i === undefined || j === undefined || i === j) continue;
    adj[i]!.push(j);
    adj[j]!.push(i); // undirected — reachable either direction
  }

  // Restart vector: uniform over seeds present in the candidate set. (Falls
  // back to uniform-over-all if no seed landed in the set, so we never return
  // all-zero.)
  const r = new Array<number>(n).fill(0);
  let rsum = 0;
  for (const id of seedIds) {
    const i = idx.get(id);
    if (i !== undefined) { r[i] = 1; rsum += 1; }
  }
  if (rsum === 0) { for (let i = 0; i < n; i++) r[i] = 1; rsum = n; }
  for (let i = 0; i < n; i++) r[i]! /= rsum;

  const alpha = 0.25;
  let s = r.slice();
  for (let iter = 0; iter < 25; iter++) {
    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const si = s[i]!;
      if (si === 0) continue;
      const d = adj[i]!.length;
      if (d === 0) { next[i]! += si; continue; } // dangling: keep its mass
      const share = si / d;
      for (const j of adj[i]!) next[j]! += share;
    }
    for (let i = 0; i < n; i++) s[i] = (1 - alpha) * next[i]! + alpha * r[i]!;
  }
  for (let i = 0; i < n; i++) out.set(nodeIds[i]!, s[i]!);
  return out;
}
