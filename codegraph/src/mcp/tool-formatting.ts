import type CodeGraph from '../index';
import type { Edge, Node, SearchResult, Subgraph } from '../types';
import {
  type ToolResult
} from './tool-definitions';
import type { ToolHandlerState } from './tool-handler-state';
import {
  numberSourceLines
} from './tool-messages';
import {
  MAX_OUTPUT_LENGTH
} from './tool-options';

/**
   * Truncate output if it exceeds the maximum length
   */
export function truncateOutput(this: ToolHandlerState, text: string): string {
  if (text.length <= MAX_OUTPUT_LENGTH) return text;
  const truncated = text.slice(0, MAX_OUTPUT_LENGTH);
  const lastNewline = truncated.lastIndexOf('\n');
  const cutPoint = lastNewline > MAX_OUTPUT_LENGTH * 0.8 ? lastNewline : MAX_OUTPUT_LENGTH;
  return truncated.slice(0, cutPoint) + '\n\n... (output truncated)';
}

// =========================================================================
// Formatting helpers (compact by default to reduce context usage)
// =========================================================================
export function formatSearchResults(this: ToolHandlerState, results: SearchResult[]): string {
  const lines: string[] = [`**Search Results (${results.length} found)**`, ''];

  for (const result of results) {
    const { node } = result;
    const location = node.startLine ? `:${node.startLine}` : '';
    // Compact format: one line per result with key info
    lines.push(`**${node.name}** (${node.kind})`);
    lines.push(`${node.filePath}${location}`);
    if (node.signature) lines.push(`\`${node.signature}\``);
    lines.push('');
  }

  return lines.join('\n');
}

export function formatNodeList(this: ToolHandlerState, nodes: Node[], title: string, labels?: Map<string, string>): string {
  const lines: string[] = [`**${title} (${nodes.length} found)**`, ''];

  for (const node of nodes) {
    const location = node.startLine ? `:${node.startLine}` : '';
    // Compact: just name, kind, location — plus the relationship when it
    // isn't a plain call (callback registration, instantiation, …).
    const label = labels?.get(node.id);
    lines.push(
      `- ${node.name} (${node.kind}) - ${node.filePath}${location}${label ? ` — via ${label}` : ''}`
    );
  }

  return lines.join('\n');
}

/**
   * Relationship label for a non-`calls` edge in callers/callees lists. A
   * function-as-value edge (#756) is the high-signal one: `callers(cb)`
   * showing "via callback registration" tells the agent this is where the
   * callback is WIRED, not where it's invoked.
   */
export function edgeLabel(this: ToolHandlerState, edge: Edge): string | null {
  if (edge.kind === 'calls') return null;
  if (edge.metadata?.fnRef === true) return 'callback registration';
  if (edge.kind === 'instantiates') return 'instantiation';
  if (edge.kind === 'imports') return 'import';
  if (edge.kind === 'references') return 'reference';
  return edge.kind;
}

export function formatImpact(this: ToolHandlerState, symbol: string, impact: Subgraph): string {
  const nodeCount = impact.nodes.size;

  // Compact format: just list affected symbols grouped by file
  const lines: string[] = [
    `**Impact: "${symbol}" affects ${nodeCount} symbols**`,
    '',
  ];

  // Group by file
  const byFile = new Map<string, Node[]>();
  for (const node of impact.nodes.values()) {
    const existing = byFile.get(node.filePath) || [];
    existing.push(node);
    byFile.set(node.filePath, existing);
  }

  for (const [file, nodes] of byFile) {
    lines.push(`**${file}:**`);
    // Compact: inline list
    const nodeList = nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
    lines.push(nodeList);
    lines.push('');
  }

  return lines.join('\n');
}

/**
   * Build a compact structural outline of a container symbol from its
   * indexed children (methods, fields, properties, …) — name, kind,
   * line number, and signature — so the agent gets the shape of a class
   * without the full source of every method. Returns '' when the container
   * has no indexed children, so the caller can fall back to full source.
   */
export function buildContainerOutline(this: ToolHandlerState, cg: CodeGraph, node: Node): string {
  const children = cg.getChildren(node.id)
    .filter(c => c.kind !== 'import' && c.kind !== 'export')
    .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
  if (children.length === 0) return '';

  const lines = [`**Members (${children.length}):**`, ''];
  for (const c of children) {
    const loc = c.startLine ? `:${c.startLine}` : '';
    const sig = c.signature ? ` — \`${c.signature}\`` : '';
    lines.push(`- ${c.name} (${c.kind})${loc}${sig}`);
  }
  return lines.join('\n');
}

export function formatNodeDetails(this: ToolHandlerState, node: Node, code: string | null, outline?: string | null): string {
  const location = node.startLine ? `:${node.startLine}` : '';
  const lines: string[] = [
    `**${node.name}** (${node.kind})`,
    '',
    `**Location:** ${node.filePath}${location}`,
  ];

  if (node.signature) {
    lines.push(`**Signature:** \`${node.signature}\``);
  }

  // Only include docstring if it's short and useful
  if (node.docstring && node.docstring.length < 200) {
    lines.push('', node.docstring);
  }

  if (outline) {
    lines.push('', outline, '',
      `> Structural outline only. Read \`${node.filePath}\` or call codegraph_node on a specific member for its body.`);
  } else if (code) {
    // Line-numbered (cat -n style, like codegraph_explore and Read) so the
    // agent can cite/edit exact lines without re-Reading the file for them.
    const numbered = node.startLine ? numberSourceLines(code, node.startLine) : code;
    lines.push('', '```' + node.language, numbered, '```');
  }

  return lines.join('\n');
}

export function textResult(this: ToolHandlerState, text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

export function errorResult(this: ToolHandlerState, message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}
