import { logDebug } from '../errors';
import {
  BuildContextOptions,
  EdgeKind,
  Node,
  SearchResult,
  Subgraph,
  TaskContext,
  TaskInput
} from '../types';
import { DEFAULT_BUILD_OPTIONS } from './context-options';
import type { ContextState } from './context-state';
import { formatContextAsJson, formatContextAsMarkdown } from './formatter';
import { LOW_CONFIDENCE_MARKER } from './markers';


/**
   * Build context for a task
   *
   * Pipeline:
   * 1. Parse task input (string or {title, description})
   * 2. Run semantic search to find entry points
   * 3. Expand graph around entry points
   * 4. Extract code blocks for key nodes
   * 5. Format output for Claude
   *
   * @param input - Task description or object with title/description
   * @param options - Build options
   * @returns TaskContext (structured) or formatted string
   */
export async function buildContext(this: ContextState, input: TaskInput, options: BuildContextOptions = {}): Promise<TaskContext | string> {
  const opts = { ...DEFAULT_BUILD_OPTIONS, ...options };

  // Parse input
  const query = typeof input === 'string' ? input : `${input.title}${input.description ? `: ${input.description}` : ''}`;

  // Find relevant context (semantic search + graph expansion)
  const subgraph = await this.owner.findRelevantContext(query, {
    searchLimit: opts.searchLimit,
    traversalDepth: opts.traversalDepth,
    maxNodes: opts.maxNodes,
    minScore: opts.minScore,
  });

  // Get entry points (nodes from semantic search)
  const entryPoints = this.getEntryPoints(subgraph);

  // Extract code blocks for key nodes
  const codeBlocks = opts.includeCode
    ? await this.extractCodeBlocks(subgraph, opts.maxCodeBlocks, opts.maxCodeBlockSize)
    : [];

  // Get related files
  const relatedFiles = this.getRelatedFiles(subgraph);

  // Generate summary
  const summary = this.generateSummary(query, subgraph, entryPoints);

  // Calculate stats
  const stats = {
    nodeCount: subgraph.nodes.size,
    edgeCount: subgraph.edges.length,
    fileCount: relatedFiles.length,
    codeBlockCount: codeBlocks.length,
    totalCodeSize: codeBlocks.reduce((sum, block) => sum + block.content.length, 0),
  };

  const context: TaskContext = {
    query,
    subgraph,
    entryPoints,
    codeBlocks,
    relatedFiles,
    summary,
    stats,
  };

  // Return formatted output or raw context
  if (opts.format === 'markdown') {
    return formatContextAsMarkdown(context)
      + this.buildCallPathsSection(subgraph)
      + (subgraph.confidence === 'low' ? this.buildLowConfidenceNote(entryPoints) : '');
  } else if (opts.format === 'json') {
    return formatContextAsJson(context);
  }

  return context;
}

/**
   * Honest handoff appended when retrieval confidence is low (the query matched
   * mostly common words). Instead of the usual "this covers the surface" framing
   * — which, when wrong, sends the agent off to Read/Grep — it admits the
   * uncertainty and routes the agent to the precise tools (explore with real
   * symbol names, search, or files to browse the closest areas we *did* surface).
   */
export function buildLowConfidenceNote(this: ContextState, entryPoints: Node[]): string {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const n of entryPoints) {
    const slash = n.filePath.lastIndexOf('/');
    const dir = slash > 0 ? n.filePath.slice(0, slash) : n.filePath;
    if (!seen.has(dir)) { seen.add(dir); dirs.push(dir); }
    if (dirs.length >= 4) break;
  }
  const dirLine = dirs.length
    ? `\n- \`codegraph_files\` a likely area: ${dirs.map(d => `\`${d}\``).join(', ')}`
    : '';
  return `\n\n${LOW_CONFIDENCE_MARKER}\n\n`
    + 'This query matched mostly on common words, so the entry points above may '
    + 'be off-target — treat them as a starting point, not a complete answer. '
    + 'For a reliable result:\n'
    + '- `codegraph_explore` with the **exact symbol names** you are after '
    + '(class / function / method names), or\n'
    + '- `codegraph_search <name>` for one specific symbol'
    + dirLine
    + '\n\nDo not assume the list above is comprehensive.';
}

/**
   * Surface short call-paths among the symbols this context already found,
   * derived in-memory from the subgraph's `calls` edges (no extra queries).
   *
   * This bakes the value of path-finding INTO the always-loaded `context` tool.
   * Agents reliably read context's output but do NOT discover/adopt a standalone
   * trace tool (in deferred-MCP harnesses they only ToolSearch-select tools they
   * already know). Delivering the flow here means "how does X reach Y" is
   * answered without the agent needing to find, load, or choose a new tool.
   * Chains stop where the static call graph ends (e.g. dynamic dispatch) — that
   * truncation is honest, and the agent can codegraph_node the last hop to bridge.
   */
export function buildCallPathsSection(this: ContextState, subgraph: Subgraph): string {
  const adj = new Map<string, string[]>();
  for (const e of subgraph.edges) {
    if (e.kind !== 'calls') continue;
    if (!subgraph.nodes.has(e.source) || !subgraph.nodes.has(e.target)) continue;
    const list = adj.get(e.source);
    if (list) list.push(e.target);
    else adj.set(e.source, [e.target]);
  }
  if (adj.size === 0) return '';

  const MAX_HOPS = 6;
  const chains: string[][] = [];
  let budget = 2000; // bound DFS work on dense subgraphs
  const dfs = (id: string, path: string[], seen: Set<string>): void => {
    if (budget-- <= 0) return;
    const next = (adj.get(id) ?? []).filter((t) => !seen.has(t));
    if (next.length === 0 || path.length >= MAX_HOPS) {
      if (path.length >= 3) chains.push([...path]); // >=3 nodes = a real flow, not a single call
      return;
    }
    for (const t of next) {
      seen.add(t);
      dfs(t, [...path, t], seen);
      seen.delete(t);
    }
  };
  const starts = (subgraph.roots.length > 0
    ? subgraph.roots.filter((id) => adj.has(id))
    : [...adj.keys()]
  ).slice(0, 5);
  for (const s of starts) dfs(s, [s], new Set([s]));
  if (chains.length === 0) return '';

  // Keep only chains that connect TWO OR MORE query-relevant symbols (roots).
  // A chain from a root into an arbitrary callee (render → onMagicFrameGenerate)
  // is structurally valid but tangential to the question; requiring ≥2 roots
  // keeps the chain anchored to what the user actually asked about. Rank by
  // #roots then length, and drop any that are a sub-path of a longer kept chain.
  const rootSet = new Set(subgraph.roots);
  const rootCount = (c: string[]): number => c.reduce((n, id) => n + (rootSet.has(id) ? 1 : 0), 0);
  const relevant = chains.filter((c) => rootCount(c) >= 2);
  relevant.sort((a, b) => rootCount(b) - rootCount(a) || b.length - a.length);
  const kept: string[][] = [];
  for (const c of relevant) {
    const key = c.join('>');
    if (kept.some((k) => k.join('>').includes(key))) continue;
    kept.push(c);
    if (kept.length >= 3) break;
  }
  if (kept.length === 0) return '';
  const name = (id: string): string => subgraph.nodes.get(id)?.name ?? id;

  // Synthesized (dynamic-dispatch) hops are real `calls` edges but invisible to
  // static parsing — mark them inline so the agent sees WHERE the callback was
  // wired up (`registered @file:line`) instead of grepping for it. Keyed by
  // "source>target".
  const synthByPair = new Map<string, string>();
  for (const e of subgraph.edges) {
    if (e.kind !== 'calls' || e.provenance !== 'heuristic') continue;
    const m = e.metadata as Record<string, unknown> | undefined;
    if (!m?.synthesizedBy) continue;
    const at = typeof m.registeredAt === 'string' ? ` @${m.registeredAt}` : '';
    const label = m.synthesizedBy === 'callback'
      ? `callback via ${m.via ? `\`${String(m.via)}\`` : 'registrar'}${at}`
      : m.synthesizedBy === 'react-render'
        ? `React re-render via setState${at}`
        : m.synthesizedBy === 'jsx-render'
          ? `renders <${String(m.via || 'child')}>`
          : m.synthesizedBy === 'vue-handler'
            ? `Vue @${String(m.event || 'event')} handler`
            : `event ${m.event ? `\`${String(m.event)}\`` : ''}${at}`;
    synthByPair.set(`${e.source}>${e.target}`, label);
  }
  const renderChain = (c: string[]): string => {
    let s = name(c[0]!);
    for (let i = 1; i < c.length; i++) {
      const synth = synthByPair.get(`${c[i - 1]}>${c[i]}`);
      s += synth ? ` →[${synth}] ${name(c[i]!)}` : ` → ${name(c[i]!)}`;
    }
    return s;
  };
  const hasSynth = kept.some((c) => c.some((_, i) => i > 0 && synthByPair.has(`${c[i - 1]}>${c[i]}`)));
  const lines = [
    '',
    '## Call paths',
    '',
    'Execution flow among the key symbols (traced through the call graph):',
    '',
    ...kept.map((c) => `- ${renderChain(c)}`),
    '',
    hasSynth
      ? '_Hops marked `[callback/event …]` are dynamic dispatch bridged by codegraph (with the registration site); the rest are direct calls. codegraph_node any symbol for its body._'
      : '_codegraph_node any symbol above for its source + its own callers/callees._',
  ];
  return '\n' + lines.join('\n') + '\n';
}

/**
   * Get entry points from a subgraph (the root nodes)
   */
export function getEntryPoints(this: ContextState, subgraph: Subgraph): Node[] {
  return subgraph.roots
    .map((id) => subgraph.nodes.get(id))
    .filter((n): n is Node => n !== undefined);
}

/**
   * Get unique files from a subgraph
   */
export function getRelatedFiles(this: ContextState, subgraph: Subgraph): string[] {
  const files = new Set<string>();
  for (const node of subgraph.nodes.values()) {
    files.add(node.filePath);
  }
  return Array.from(files).sort();
}

/**
   * Generate a summary of the context
   */
export function generateSummary(this: ContextState, _query: string, subgraph: Subgraph, entryPoints: Node[]): string {
  const nodeCount = subgraph.nodes.size;
  const edgeCount = subgraph.edges.length;
  const files = this.getRelatedFiles(subgraph);

  const entryPointNames = entryPoints
    .slice(0, 3)
    .map((n) => n.name)
    .join(', ');

  const remaining = entryPoints.length > 3 ? ` and ${entryPoints.length - 3} more` : '';

  return `Found ${nodeCount} relevant code symbols across ${files.length} files. ` +
    `Key entry points: ${entryPointNames}${remaining}. ` +
    `${edgeCount} relationships identified.`;
}

/**
   * Resolve import/export nodes to their actual definitions
   *
   * When search returns `import { TerminalPanel }`, users want the TerminalPanel
   * class definition, not the import statement. This follows the `imports` edge
   * to find and return the actual definition instead.
   *
   * @param results - Search results that may include import/export nodes
   * @returns Results with imports resolved to definitions where possible
   */
export function resolveImportsToDefinitions(this: ContextState, results: SearchResult[]): SearchResult[] {
  const resolved: SearchResult[] = [];
  const seenIds = new Set<string>();

  for (const result of results) {
    const { node, score } = result;

    // If it's not an import/export, keep it as-is
    if (node.kind !== 'import' && node.kind !== 'export') {
      if (!seenIds.has(node.id)) {
        seenIds.add(node.id);
        resolved.push(result);
      }
      continue;
    }

    // For imports/exports, try to find what they reference
    // Imports have outgoing 'imports' edges to the definition
    // Exports have outgoing 'exports' edges to the definition
    const edgeKind = node.kind === 'import' ? 'imports' : 'exports';
    const outgoingEdges = this.queries.getOutgoingEdges(node.id, [edgeKind as EdgeKind]);

    let foundDefinition = false;
    for (const edge of outgoingEdges) {
      const targetNode = this.queries.getNodeById(edge.target);
      if (targetNode && !seenIds.has(targetNode.id)) {
        // Found the definition - use it instead of the import
        seenIds.add(targetNode.id);
        resolved.push({
          node: targetNode,
          score: score, // Preserve the original score
        });
        foundDefinition = true;
        logDebug('Resolved import to definition', {
          import: node.name,
          definition: targetNode.name,
          kind: targetNode.kind,
        });
      }
    }

    // If we couldn't resolve the import, skip it (it's low-value on its own)
    if (!foundDefinition) {
      logDebug('Skipping unresolved import', { name: node.name, file: node.filePath });
    }
  }

  return resolved;
}
