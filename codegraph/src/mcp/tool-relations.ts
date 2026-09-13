import { isGeneratedFile } from '../extraction/generated-detection';
import type { Edge, Node, NodeKind } from '../types';
import {
  clamp
} from '../utils';
import {
  type ToolResult
} from './tool-definitions';
import type { ToolHandlerState } from './tool-handler-state';

/**
   * Handle codegraph_search
   */
export async function handleSearch(this: ToolHandlerState, args: Record<string, unknown>): Promise<ToolResult> {
  const query = this.validateString(args.query, 'query');
  if (typeof query !== 'string') return query;

  const cg = this.getCodeGraph(args.projectPath as string | undefined);
  const rawKind = args.kind as string | undefined;
  // The schema enum says 'type' (what agents naturally reach for); the
  // NodeKind is 'type_alias'. Without the mapping, kind: "type" silently
  // matched nothing — a filter value we advertise must work.
  const kind = rawKind === 'type' ? 'type_alias' : rawKind;
  const rawLimit = Number(args.limit) || 10;
  const limit = clamp(rawLimit, 1, 100);

  const results = cg.searchNodes(query, {
    limit,
    kinds: kind ? [kind as NodeKind] : undefined,
  });

  if (results.length === 0) {
    return this.textResult(`No results found for "${query}"`);
  }

  // Down-rank generated files within the FTS-returned set so a search
  // for "Send" surfaces the hand-written keeper before .pb.go stubs
  // that share the name. Stable: only reorders generated vs. not.
  const ranked = [...results].sort((a, b) => {
    const aGen = isGeneratedFile(a.node.filePath) ? 1 : 0;
    const bGen = isGeneratedFile(b.node.filePath) ? 1 : 0;
    return aGen - bGen;
  });

  const formatted = this.formatSearchResults(ranked);
  return this.textResult(this.truncateOutput(formatted));
}

/**
   * Group symbol matches into DISTINCT DEFINITIONS — one group per
   * (filePath, qualifiedName), so same-file overloads stay together while
   * unrelated same-named classes across a monorepo's apps (#764: one
   * `UserService` per NestJS app) are kept apart. Optionally narrowed by a
   * `file` path/suffix first.
   */
export function groupDefinitions(this: ToolHandlerState, nodes: Node[], fileFilter: string | undefined): { groups: Node[][]; filteredOut: boolean } {
  let pool = nodes;
  let filteredOut = false;
  if (fileFilter) {
    const wanted = fileFilter.replace(/^\.\//, '');
    const narrowed = pool.filter(
      (n) => n.filePath === wanted || n.filePath.endsWith(wanted) || n.filePath.endsWith(`/${wanted}`)
    );
    if (narrowed.length > 0) {
      pool = narrowed;
    } else {
      filteredOut = true;
    }
  }
  const byDef = new Map<string, Node[]>();
  for (const n of pool) {
    const key = `${n.filePath}|${n.qualifiedName}`;
    const group = byDef.get(key);
    if (group) group.push(n);
    else byDef.set(key, [n]);
  }
  return { groups: [...byDef.values()], filteredOut };
}

/** Section heading for one distinct definition in grouped output. */
export function definitionHeading(this: ToolHandlerState, group: Node[]): string {
  const head = group[0]!;
  const line = head.startLine ? `:${head.startLine}` : '';
  return `**${head.qualifiedName}** (${head.kind}) — ${head.filePath}${line}`;
}

/**
   * Handle codegraph_callers
   */
export async function handleCallers(this: ToolHandlerState, args: Record<string, unknown>): Promise<ToolResult> {
  const symbol = this.validateString(args.symbol, 'symbol');
  if (typeof symbol !== 'string') return symbol;

  const cg = this.getCodeGraph(args.projectPath as string | undefined);
  const limit = clamp((args.limit as number) || 20, 1, 100);
  const fileFilter = typeof args.file === 'string' ? args.file : undefined;

  const allMatches = this.findAllSymbols(cg, symbol);
  if (allMatches.nodes.length === 0) {
    return this.textResult(`Symbol "${symbol}" not found in the codebase`);
  }

  const { groups, filteredOut } = this.groupDefinitions(allMatches.nodes, fileFilter);
  const filterNote = filteredOut
    ? `\n\n> **Note:** no definition of "${symbol}" matches file "${fileFilter}" — showing all definitions instead.`
    : '';

  const collect = (defNodes: Node[]) => {
    const seen = new Set<string>();
    const callers: Node[] = [];
    const labels = new Map<string, string>();
    for (const node of defNodes) {
      for (const c of cg.getCallers(node.id)) {
        if (!seen.has(c.node.id)) {
          seen.add(c.node.id);
          callers.push(c.node);
          const label = this.edgeLabel(c.edge);
          if (label) labels.set(c.node.id, label);
        }
      }
    }
    return { callers, labels };
  };

  // Single definition (or same-file overloads): the familiar flat list.
  if (groups.length === 1) {
    const { callers, labels } = collect(groups[0]!);
    if (callers.length === 0) {
      return this.textResult(`No callers found for "${symbol}"${allMatches.note}${filterNote}`);
    }
    // A successful `file` narrowing makes the multi-symbol aggregation note
    // stale — suppress it.
    const note = fileFilter && !filteredOut ? '' : allMatches.note;
    const formatted = this.formatNodeList(callers.slice(0, limit), `Callers of ${symbol}`, labels) + note + filterNote;
    return this.textResult(this.truncateOutput(formatted));
  }

  // Multiple DISTINCT definitions (#764): one section per definition so an
  // agent never mistakes one app's callers for another's. Narrow with
  // `file` to focus a single definition.
  const lines: string[] = [
    `**Callers of ${symbol} — ${groups.length} distinct definitions (narrow with \`file\`)**`,
  ];
  for (const group of groups) {
    const { callers, labels } = collect(group);
    lines.push('', this.definitionHeading(group));
    if (callers.length === 0) {
      lines.push('- (no callers)');
      continue;
    }
    for (const node of callers.slice(0, limit)) {
      const location = node.startLine ? `:${node.startLine}` : '';
      const label = labels.get(node.id);
      lines.push(`- ${node.name} (${node.kind}) - ${node.filePath}${location}${label ? ` — via ${label}` : ''}`);
    }
  }
  return this.textResult(this.truncateOutput(lines.join('\n') + filterNote));
}

/**
   * Handle codegraph_callees
   */
export async function handleCallees(this: ToolHandlerState, args: Record<string, unknown>): Promise<ToolResult> {
  const symbol = this.validateString(args.symbol, 'symbol');
  if (typeof symbol !== 'string') return symbol;

  const cg = this.getCodeGraph(args.projectPath as string | undefined);
  const limit = clamp((args.limit as number) || 20, 1, 100);
  const fileFilter = typeof args.file === 'string' ? args.file : undefined;

  const allMatches = this.findAllSymbols(cg, symbol);
  if (allMatches.nodes.length === 0) {
    return this.textResult(`Symbol "${symbol}" not found in the codebase`);
  }

  const { groups, filteredOut } = this.groupDefinitions(allMatches.nodes, fileFilter);
  const filterNote = filteredOut
    ? `\n\n> **Note:** no definition of "${symbol}" matches file "${fileFilter}" — showing all definitions instead.`
    : '';

  const collect = (defNodes: Node[]) => {
    const seen = new Set<string>();
    const callees: Node[] = [];
    const labels = new Map<string, string>();
    for (const node of defNodes) {
      for (const c of cg.getCallees(node.id)) {
        if (!seen.has(c.node.id)) {
          seen.add(c.node.id);
          callees.push(c.node);
          const label = this.edgeLabel(c.edge);
          if (label) labels.set(c.node.id, label);
        }
      }
    }
    return { callees, labels };
  };

  if (groups.length === 1) {
    const { callees, labels } = collect(groups[0]!);
    if (callees.length === 0) {
      return this.textResult(`No callees found for "${symbol}"${allMatches.note}${filterNote}`);
    }
    // A successful `file` narrowing makes the multi-symbol aggregation note
    // stale — suppress it.
    const note = fileFilter && !filteredOut ? '' : allMatches.note;
    const formatted = this.formatNodeList(callees.slice(0, limit), `Callees of ${symbol}`, labels) + note + filterNote;
    return this.textResult(this.truncateOutput(formatted));
  }

  // Multiple DISTINCT definitions (#764): per-definition sections.
  const lines: string[] = [
    `**Callees of ${symbol} — ${groups.length} distinct definitions (narrow with \`file\`)**`,
  ];
  for (const group of groups) {
    const { callees, labels } = collect(group);
    lines.push('', this.definitionHeading(group));
    if (callees.length === 0) {
      lines.push('- (no callees)');
      continue;
    }
    for (const node of callees.slice(0, limit)) {
      const location = node.startLine ? `:${node.startLine}` : '';
      const label = labels.get(node.id);
      lines.push(`- ${node.name} (${node.kind}) - ${node.filePath}${location}${label ? ` — via ${label}` : ''}`);
    }
  }
  return this.textResult(this.truncateOutput(lines.join('\n') + filterNote));
}

/**
   * Handle codegraph_impact
   */
export async function handleImpact(this: ToolHandlerState, args: Record<string, unknown>): Promise<ToolResult> {
  const symbol = this.validateString(args.symbol, 'symbol');
  if (typeof symbol !== 'string') return symbol;

  const cg = this.getCodeGraph(args.projectPath as string | undefined);
  const depth = clamp((args.depth as number) || 2, 1, 10);
  const fileFilter = typeof args.file === 'string' ? args.file : undefined;

  const allMatches = this.findAllSymbols(cg, symbol);
  if (allMatches.nodes.length === 0) {
    return this.textResult(`Symbol "${symbol}" not found in the codebase`);
  }

  const { groups, filteredOut } = this.groupDefinitions(allMatches.nodes, fileFilter);
  const filterNote = filteredOut
    ? `\n\n> **Note:** no definition of "${symbol}" matches file "${fileFilter}" — showing all definitions instead.`
    : '';

  const impactOf = (defNodes: Node[]) => {
    const mergedNodes = new Map<string, Node>();
    const mergedEdges: Edge[] = [];
    const seenEdges = new Set<string>();
    for (const node of defNodes) {
      const impact = cg.getImpactRadius(node.id, depth);
      for (const [id, n] of impact.nodes) {
        mergedNodes.set(id, n);
      }
      for (const e of impact.edges) {
        const key = `${e.source}->${e.target}:${e.kind}`;
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          mergedEdges.push(e);
        }
      }
    }
    return { nodes: mergedNodes, edges: mergedEdges, roots: defNodes.map((n) => n.id) };
  };

  // Single definition (or same-file overloads): the familiar merged report.
  if (groups.length === 1) {
    const formatted = this.formatImpact(symbol, impactOf(groups[0]!)) + (fileFilter && !filteredOut ? "" : allMatches.note) + filterNote;
    return this.textResult(this.truncateOutput(formatted));
  }

  // Multiple DISTINCT definitions (#764): a blast radius PER definition —
  // merging unrelated same-named classes (one UserService per monorepo app)
  // overstated impact and confused agents. Narrow with `file`.
  const sections: string[] = [
    `**Impact of ${symbol} — ${groups.length} distinct definitions (each with its own blast radius; narrow with \`file\`)**`,
  ];
  for (const group of groups) {
    const head = group[0]!;
    const line = head.startLine ? `:${head.startLine}` : '';
    sections.push(
      '',
      this.formatImpact(`${head.qualifiedName} (${head.filePath}${line})`, impactOf(group))
    );
  }
  return this.textResult(this.truncateOutput(sections.join('\n') + filterNote));
}
