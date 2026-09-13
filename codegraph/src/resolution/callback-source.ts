import type { QueryBuilder } from '../db/queries';
import type { Node } from '../types';

export function sliceLines(content: string, startLine?: number, endLine?: number): string | null {
  if (!startLine || !endLine) return null;
  return content.split('\n').slice(startLine - 1, endLine).join('\n');
}

/**
 * Per-match line resolver over `src`, 1-based at `baseLine`. The inline
 * `src.slice(0, idx).split('\n').length` idiom is O(source-length) PER MATCH,
 * which goes quadratic on a match-dense source (a generated function full of
 * `.push(` calls re-scanned tens of thousands of times was most of the #1235
 * indexing wedge). Builds the newline index once — lazily, since most sources
 * never produce a match — then answers each call with a binary search.
 */
export function makeLineAt(src: string, baseLine: number): (idx: number) => number {
  let nl: number[] | null = null;
  return (idx: number) => {
    if (!nl) {
      nl = [];
      for (let i = src.indexOf('\n'); i !== -1; i = src.indexOf('\n', i + 1)) nl.push(i);
    }
    // Count newlines strictly before idx.
    let lo = 0;
    let hi = nl.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nl[mid]! < idx) lo = mid + 1;
      else hi = mid;
    }
    return baseLine + lo;
  };
}

const FN_KINDS = new Set(['method', 'function', 'component']);

/** Innermost function/method node whose line range contains `line`. */
export function enclosingFn(nodesInFile: Node[], line: number): Node | null {
  let best: Node | null = null;
  for (const n of nodesInFile) {
    if (!FN_KINDS.has(n.kind)) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= line && end >= line) {
      if (!best || n.startLine >= best.startLine) best = n; // prefer the tightest (latest-starting) encloser
    }
  }
  return best;
}

/**
 * Stream method + function nodes lazily. The synthesizers only scan-and-filter
 * down to a tiny matched subset, so materializing every function/method (which
 * is gigabytes on a symbol-dense project) just to iterate it once is what OOM'd
 * #610. Iterating keeps memory O(1) in the node count.
 */
export function* methodAndFunctionNodes(queries: QueryBuilder): IterableIterator<Node> {
  yield* queries.iterateNodesByKind('method');
  yield* queries.iterateNodesByKind('function');
}
