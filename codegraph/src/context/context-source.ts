import * as fs from 'fs';
import { logDebug } from '../errors';
import {
  CodeBlock,
  Node,
  Subgraph
} from '../types';
import { isConfigLeafNode, validatePathWithinRoot } from '../utils';
import type { ContextState } from './context-state';


/**
   * Get the source code for a node
   *
   * Reads the file and extracts the code between startLine and endLine.
   *
   * @param nodeId - ID of the node
   * @returns Code string or null if not found
   */
export async function getCode(this: ContextState, nodeId: string): Promise<string | null> {
  const node = this.queries.getNodeById(nodeId);
  if (!node) {
    return null;
  }

  return this.extractNodeCode(node);
}

/**
   * Extract code from a node's source file
   */
export async function extractNodeCode(this: ContextState, node: Node): Promise<string | null> {
  // SECURITY (#383): a config-leaf node's on-disk line is `key = <secret>`.
  // Return the KEY only — never read the value off disk. This closes the
  // includeCode / buildContext code-block path, mirroring the explore source
  // renderer; an agent that genuinely needs a value can read the file itself.
  if (isConfigLeafNode(node)) {
    return node.signature || node.qualifiedName || node.name;
  }

  const filePath = validatePathWithinRoot(this.projectRoot, node.filePath);

  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Extract lines (1-indexed to 0-indexed)
    const startIdx = Math.max(0, node.startLine - 1);
    const endIdx = Math.min(lines.length, node.endLine);

    return lines.slice(startIdx, endIdx).join('\n');
  } catch (error) {
    logDebug('Failed to extract code from node', { nodeId: node.id, filePath: node.filePath, error: String(error) });
    return null;
  }
}

/**
   * Extract code blocks for key nodes in the subgraph
   */
export async function extractCodeBlocks(this: ContextState, subgraph: Subgraph, maxBlocks: number, maxBlockSize: number): Promise<CodeBlock[]> {
  const blocks: CodeBlock[] = [];

  // Prioritize entry points, then functions/methods
  const priorityNodes: Node[] = [];

  // First: entry points
  for (const id of subgraph.roots) {
    const node = subgraph.nodes.get(id);
    if (node) {
      priorityNodes.push(node);
    }
  }

  // Then: functions and methods
  for (const node of subgraph.nodes.values()) {
    if (!subgraph.roots.includes(node.id)) {
      if (node.kind === 'function' || node.kind === 'method') {
        priorityNodes.push(node);
      }
    }
  }

  // Then: classes
  for (const node of subgraph.nodes.values()) {
    if (!subgraph.roots.includes(node.id)) {
      if (node.kind === 'class') {
        priorityNodes.push(node);
      }
    }
  }

  // Extract code for priority nodes
  for (const node of priorityNodes) {
    if (blocks.length >= maxBlocks) break;

    const code = await this.extractNodeCode(node);
    if (code) {
      // Truncate if too long. Language-neutral marker (no `//` — not a
      // comment in Python, Ruby, etc.); this renders inside a fenced
      // source block whose language varies.
      const truncated = code.length > maxBlockSize
        ? code.slice(0, maxBlockSize) + '\n... (truncated) ...'
        : code;

      blocks.push({
        content: truncated,
        filePath: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
        language: node.language,
        node,
      });
    }
  }

  return blocks;
}
