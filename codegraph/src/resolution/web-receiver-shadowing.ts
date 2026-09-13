import type { Node } from '../types';
import { stripCommentsForRegex } from './strip-comments';
import type { ResolutionContext, UnresolvedRef } from './types';

function containsCall(node: Node, ref: UnresolvedRef): boolean {
  return (node.startLine < ref.line || (node.startLine === ref.line && node.startColumn <= ref.column))
    && (node.endLine > ref.line || (node.endLine === ref.line && node.endColumn >= ref.column));
}

function lineOffsets(lines: string[]): number[] {
  let position = 0;
  return lines.map(line => {
    const start = position;
    position += line.length + 1;
    return start;
  });
}

/** Split declarators only at top-level commas, never inside initializer calls. */
function declaresReceiver(source: string, start: number, receiver: string): boolean {
  let binding = '';
  let depth = 0;
  let initialized = false;
  const matches = () => {
    const trimmed = binding.trim();
    if (/^[{\[]/.test(trimmed)) {
      const end = delimiterEnd(trimmed, 0);
      if (end === null) return false;
      return new RegExp(`\\b${receiver}\\b(?!\\s*:)`).test(trimmed.slice(0, end));
    }
    return new RegExp(`^${receiver}(?=\\s*(?:[:?=,;)}\\]]|\\bof\\b|\\bin\\b|$))`).test(trimmed);
  };
  for (let i = start; i < source.length; i++) {
    const character = source[i]!;
    if (depth === 0 && (character === ';' || character === '}' || character === ')')) return matches();
    if (depth === 0 && character === ',') {
      if (matches()) return true;
      binding = '';
      initialized = false;
      continue;
    }
    if (depth === 0 && character === '=') initialized = true;
    if (!initialized) binding += character;
    if ('([{'.includes(character)) depth++;
    else if (')]}'.includes(character)) depth--;
  }
  return matches();
}

/** Remove literals as well as comments: examples in strings are not bindings. */
function bindingSource(source: string): string {
  return stripCommentsForRegex(source, 'typescript').replace(
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g,
    value => value.replace(/[^\n]/g, ' '),
  );
}

/** Offsets are exclusive; source has already had comments and literals masked. */
function delimiterEnd(source: string, start: number): number | null {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let index = start; index < source.length; index++) {
    const character = source[index]!;
    if (pairs[character]) stack.push(pairs[character]!);
    else if (')]}'.includes(character) && stack.pop() !== character) return null;
    if (stack.length === 0) return index + 1;
  }
  return null;
}

function skipSpace(source: string, start: number): number {
  while (/\s/.test(source[start] ?? '') && start < source.length) start++;
  return start;
}

function endsAtLineBreak(source: string, start: number, lineBreak: number): boolean {
  const before = source.slice(start, lineBreak).trimEnd();
  const after = source.slice(skipSpace(source, lineBreak + 1));
  // An identifier cannot directly follow a completed expression. Operators,
  // calls, member access and indexing on the next line may continue it.
  return /[$\w)\]}]$/.test(before) && /^[$\w]/.test(after)
    && !/\b(?:await|new|typeof|void|delete|instanceof|in|as|satisfies)$/.test(before)
    && !/^(?:instanceof|in|as|satisfies)\b/.test(after);
}

/** Find a loop body's statement, including nested loops and if/else bodies. */
function statementEnd(source: string, start: number): number | null {
  start = skipSpace(source, start);
  if (source[start] === '{') return delimiterEnd(source, start);
  const control = /^(if|for|while|with|switch)\b(?:\s+await\b)?\s*\(/.exec(source.slice(start));
  if (control) {
    const headerEnd = delimiterEnd(source, start + control[0].lastIndexOf('('));
    if (headerEnd === null) return null;
    const bodyEnd = statementEnd(source, headerEnd);
    if (bodyEnd === null) return null;
    const tail = skipSpace(source, bodyEnd);
    return control[1] === 'if' && /^else\b/.test(source.slice(tail))
      ? statementEnd(source, tail + 4) : bodyEnd;
  }
  for (let index = start; index < source.length; index++) {
    const character = source[index]!;
    if ('([{'.includes(character)) {
      const end = delimiterEnd(source, index);
      if (end === null) return null;
      index = end - 1;
    } else if (character === ';') return index + 1;
    else if (character === '}') return index;
    else if (character === '\n' && endsAtLineBreak(source, start, index)) return index;
  }
  return source.length;
}

function loopBindingContainsCall(source: string, declaration: number, call: number): boolean {
  const header = /\bfor(?:\s+await)?\s*\(\s*$/.exec(source.slice(0, declaration));
  if (!header) return true;
  const start = header.index;
  const headerEnd = delimiterEnd(source, start + header[0].indexOf('('));
  if (headerEnd === null) return false;
  const end = statementEnd(source, headerEnd);
  return end !== null && call >= start && call < end;
}

function sameBlock(source: string, declaration: number, call: number): boolean {
  if (!loopBindingContainsCall(source, declaration, call)) return false;
  const stack: number[] = [];
  const ends = new Map<number, number>();
  let declarationStack: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (i === declaration) declarationStack = [...stack];
    if (source[i] === '{') stack.push(i);
    else if (source[i] === '}') {
      const start = stack.pop();
      if (start !== undefined) ends.set(start, i);
    }
  }
  return declarationStack.every(start => start <= call && (ends.get(start) ?? source.length) >= call);
}

/**
 * A visible value binding must not fall through to a class with the same name.
 * This guard runs after proven receiver-type inference, so typed parameters and
 * `new Type()` locals retain their real method targets.
 */
export function hasWebReceiverBinding(
  receiver: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  includeModuleBinding = true,
): boolean {
  if (!/^[$\w]+$/.test(receiver)) return false;
  const nodes = context.getNodesInFile(ref.filePath);
  const scopes = nodes.filter(node => (node.kind === 'function' || node.kind === 'method') && containsCall(node, ref));
  const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parameter = new RegExp(`(?:^|[(,{\\[])\\s*(?:\\.\\.\\.)?${escaped}\\s*(?=[:?=,)}\\]]|=>|$)`);
  if (scopes.some(scope => parameter.test(bindingSource(scope.signature ?? '')))) return true;

  // A file-level value shadows a class imported/found in another file, too.
  if (includeModuleBinding && nodes.some(node => (node.kind === 'variable' || node.kind === 'constant')
    && node.name === receiver && !node.qualifiedName.includes('::'))) return true;

  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/);
  if (!lines) return false;
  const original = lines.join('\n');
  const offsets = lineOffsets(lines);
  const offset = (line: number, column: number) => (offsets[line - 1] ?? original.length) + column;
  const call = offset(ref.line, ref.column);
  for (const scope of scopes) {
    const start = offset(scope.startLine, scope.startColumn);
    const end = offset(scope.endLine, scope.endColumn);
    let source = bindingSource(original.slice(start, end));
    // Declarations in sibling/nested functions do not bind this call's name.
    for (const child of nodes) {
      if ((child.kind !== 'function' && child.kind !== 'method') || child.id === scope.id || containsCall(child, ref)) continue;
      const childStart = offset(child.startLine, child.startColumn) - start;
      const childEnd = offset(child.endLine, child.endColumn) - start;
      if (childStart >= 0 && childEnd <= source.length) {
        source = source.slice(0, childStart) + source.slice(childStart, childEnd).replace(/[^\n]/g, ' ') + source.slice(childEnd);
      }
    }
    for (const match of source.matchAll(/\b(const|let|var)\s+/g)) {
      if (!declaresReceiver(source, match.index + match[0].length, escaped)) continue;
      if (match[1] === 'var' || sameBlock(source, match.index, call - start)) return true;
    }
  }
  return false;
}
