import type { Node } from '../types';
import { SUPERTYPE_BEARING_KINDS } from './resolver-rules';
import { stripCommentsForRegex } from './strip-comments';
import type { ResolutionContext } from './types';

function isClassScope(node: Node): boolean {
  return SUPERTYPE_BEARING_KINDS.has(node.kind) || node.kind === 'module';
}

function isLexicalArrow(node: Node, context: ResolutionContext): boolean {
  const lines = context.getFileLines?.(node.filePath) ?? context.readFile(node.filePath)?.split(/\r?\n/);
  if (!lines) return false;
  const source = lines.slice(node.startLine - 1, node.endLine);
  source[0] = source[0]?.slice(node.startColumn) ?? '';
  const declaration = stripCommentsForRegex(source.join('\n'), 'typescript').trimStart();
  // Function nodes in JS/TS are declarations, expressions, or arrows. Only
  // arrows inherit this; an ordinary function is a lexical boundary even
  // when its body contains an arrow or it accepts a callback parameter.
  return !/^(?:async\s+)?function\b/.test(declaration)
    && /^(?:async\s+)?(?:\(|<|[$\w]+\s*=>)/.test(declaration);
}

/** Find the actual this owner, retaining historical scoping for other languages. */
export function thisMemberClassPrefix(from: Node, context: ResolutionContext): string | null {
  if (isClassScope(from)) return from.qualifiedName;
  const web = ['typescript', 'tsx', 'javascript', 'jsx'].includes(from.language);
  if (!web) {
    const separator = from.qualifiedName.lastIndexOf('::');
    return separator > 0 ? from.qualifiedName.slice(0, separator) : null;
  }
  let current = from;
  while (true) {
    if (current.kind === 'function' && !isLexicalArrow(current, context)) return null;
    const separator = current.qualifiedName.lastIndexOf('::');
    if (separator <= 0) return null;
    const prefix = current.qualifiedName.slice(0, separator);
    const parent = context.getNodesByQualifiedName(prefix).find(node => node.filePath === from.filePath
      && node.startLine <= current.startLine && node.endLine >= current.endLine);
    if (!parent) return null;
    if (isClassScope(parent)) return parent.qualifiedName;
    // A method on a nested object has its own receiver, not the outer class.
    if (current.kind !== 'function') return null;
    current = parent;
  }
}
