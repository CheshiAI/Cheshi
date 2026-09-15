import type { Node } from '../types';
import { isJavaScriptCall } from './name-match-candidates';
import { stripCommentsForRegex } from './strip-comments';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { hasWebReceiverBinding } from './web-receiver-shadowing';

interface StoreActions {
  getter?: string;
  actions: Node[];
}

const storesByContext = new WeakMap<ResolutionContext, Map<string, { source: string; store: StoreActions | null }>>();
const STORE_MIDDLEWARE = new Set(['persist', 'devtools', 'subscribeWithSelector']);

export function clearStoreActionMemos(context: ResolutionContext): void {
  storesByContext.delete(context);
}

function maskedSource(source: string): string {
  return stripCommentsForRegex(source, 'typescript').replace(
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g,
    literal => literal.replace(/[^\r\n]/g, ' '),
  );
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The end is exclusive. Reject unmatched delimiters rather than guessing. */
function closingDelimiter(source: string, start: number): number | null {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let index = start; index < source.length; index++) {
    const character = source[index]!;
    if (pairs[character]) stack.push(pairs[character]!);
    else if (')]}'.includes(character) && stack.pop() !== character) return null;
    if (!stack.length) return index + 1;
  }
  return null;
}

function positionOffset(source: string, line: number, column: number): number {
  let start = 0;
  for (let row = 1; row < line; row++) {
    const next = source.indexOf('\n', start);
    if (next < 0) return source.length;
    start = next + 1;
  }
  return start + column;
}

/**
 * Recover only proven Zustand initializer objects. This uses the existing
 * extracted function positions, so nested functions cannot donate an action.
 * It does not need a WASM parser in a resolution worker (grammars can live only
 * in parse workers). Unknown factories and unsupported expressions stay unset.
 */
function storeActions(value: Node, context: ResolutionContext): StoreActions | null {
  if (value.kind !== 'constant' || value.isExported !== true || value.qualifiedName !== value.name) return null;
  const source = context.readFile(value.filePath);
  if (!source) return null;
  let cache = storesByContext.get(context);
  if (!cache) { cache = new Map(); storesByContext.set(context, cache); }
  const cached = cache.get(value.id);
  if (cached?.source === source) return cached.store;
  const store = inspectStoreActions(value, source, context);
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(value.id, { source, store });
  return store;
}

function inspectStoreActions(value: Node, source: string, context: ResolutionContext): StoreActions | null {
  const start = positionOffset(source, value.startLine, value.startColumn);
  const end = positionOffset(source, value.endLine, value.endColumn);
  const masked = maskedSource(source);
  // Only module declarations can use the module's factory import as evidence.
  // A namespace/local binding may shadow it and is intentionally unsupported.
  const prefix = masked.slice(0, start);
  let depth = 0;
  for (const character of prefix) {
    if ('([{'.includes(character)) depth++;
    else if (')]}'.includes(character)) depth--;
  }
  if (depth !== 0) return null;
  const declaration = masked.slice(start, end);
  // Regex literal delimiters are not understood by this small source scanner.
  // A slash outside comments/strings makes the declaration unsupported.
  if (declaration.includes('/')) return null;
  const imports = context.getImportMappings(value.filePath, value.language);
  const factories = imports.filter(imp => !imp.isDefault && !imp.isNamespace
    && ((imp.source === 'zustand' && imp.exportedName === 'create')
      || (imp.source === 'zustand/vanilla' && imp.exportedName === 'createStore')));
  const factory = factories.find(imp => new RegExp(`^${escapePattern(value.name)}\\s*=\\s*${escapePattern(imp.localName)}(?:\\s*<[^<>;{}]*>)?\\s*\\(`).test(declaration));
  if (!factory) return null;
  const factoryCall = new RegExp(`^${escapePattern(value.name)}\\s*=\\s*${escapePattern(factory.localName)}(?:\\s*<[^<>;{}]*>)?\\s*\\(`).exec(declaration)!;
  let cursor = factoryCall[0].length;
  // The curried TS spelling: create<State>()((set, get) => ({ ... })).
  const curry = /^\s*\)\s*\(/.exec(declaration.slice(cursor));
  if (curry) cursor += curry[0].length;
  const middleware = imports.filter(imp => imp.source === 'zustand/middleware' && STORE_MIDDLEWARE.has(imp.exportedName) && !imp.isDefault && !imp.isNamespace);
  for (let depth = 0; depth < 5; depth++) {
    const wrapper = middleware.find(imp => new RegExp(`^\\s*${escapePattern(imp.localName)}\\s*\\(`).test(declaration.slice(cursor)));
    if (!wrapper) break;
    cursor += new RegExp(`^\\s*${escapePattern(wrapper.localName)}\\s*\\(`).exec(declaration.slice(cursor))![0].length;
  }
  // Keep the accepted initializer narrow: identifier parameters, no defaults or
  // destructuring. Its second parameter is the getter by the factory contract.
  const initializer = /^\s*\(\s*([$\w]+)(?:\s*,\s*([$\w]+))?(?:\s*,\s*[$\w]+)?\s*\)\s*=>\s*/.exec(declaration.slice(cursor));
  if (!initializer) return null;
  cursor += initializer[0].length;
  if (declaration[cursor] === '(') cursor += /^\(\s*/.exec(declaration.slice(cursor))![0].length;
  else if (declaration[cursor] === '{') {
    // Accept only a direct unconditional return; conditional/alternate objects
    // need control-flow evidence this conservative matcher does not collect.
    const returned = /^\{\s*return\s+(?=\{)/.exec(declaration.slice(cursor));
    if (!returned) return null;
    cursor += returned[0].length;
  }
  if (declaration[cursor] !== '{') return null;
  const objectEnd = closingDelimiter(declaration, cursor);
  if (objectEnd === null) return null;
  const objectStart = cursor;
  const actionPositions = new Set<number>();
  let memberStart = true;
  // Extracted inline functions start at the outer object's member depth. Skip
  // their parameter lists/bodies and any nested expression as complete units.
  for (cursor++; cursor < objectEnd - 1; cursor++) {
    // A spread or computed key may replace an otherwise visible action.
    // Reject the object instead of assuming the inline definition survives.
    const character = declaration[cursor]!;
    if (memberStart && (declaration.startsWith('...', cursor) || character === '[')) return null;
    if (character === ',') memberStart = true;
    else if (!/\s/.test(character)) memberStart = false;
    actionPositions.add(start + cursor);
    if ('([{'.includes(declaration[cursor]!)) {
      const close = closingDelimiter(declaration, cursor);
      if (close === null) return null;
      cursor = close - 1;
    }
  }
  const actions = context.getNodesInFile(value.filePath).filter(node => node.kind === 'function'
    && actionPositions.has(positionOffset(source, node.startLine, node.startColumn))
    && positionOffset(source, node.endLine, node.endColumn) <= start + objectEnd
    && positionOffset(source, node.startLine, node.startColumn) > start + objectStart);
  return { getter: initializer[2], actions };
}

function resolveAction(store: StoreActions, action: string, ref: UnresolvedRef): ResolvedRef | null {
  const candidates = store.actions.filter(node => node.name === action);
  if (candidates.length !== 1) return null;
  return { original: ref, targetNodeId: candidates[0]!.id, confidence: 0.95, resolvedBy: 'instance-method' };
}

/** An imported value is already pinned to its exporting file by import resolution. */
export function resolveImportedStoreAction(
  value: Node, localName: string, ref: UnresolvedRef, context: ResolutionContext,
): ResolvedRef | null {
  if (!isJavaScriptCall(ref)) return null;
  const match = new RegExp(`^${escapePattern(localName)}\\.getState\\(\\)\\.([$\\w]+)$`).exec(ref.referenceName);
  if (!match || hasWebReceiverBinding(localName, ref, context)) return null;
  const store = storeActions(value, context);
  return store ? resolveAction(store, match[1]!, ref) : null;
}

/** Same-file store access and a getter bound by that store's initializer. */
export function resolveLocalStoreAction(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!isJavaScriptCall(ref)) return null;
  const external = /^([$\w]+)\.getState\(\)\.([$\w]+)$/.exec(ref.referenceName);
  const sibling = /^([$\w]+)\(\)\.([$\w]+)$/.exec(ref.referenceName);
  if (!external && !sibling) return null;
  const nodes = context.getNodesInFile(ref.filePath);
  const receiver = (external ?? sibling)![1]!;
  if (hasWebReceiverBinding(receiver, ref, context, false)) return null;
  const stores = nodes.filter(node => node.kind === 'constant'
    && (external ? node.name === receiver : node.startLine <= ref.line && node.endLine >= ref.line))
    .map(node => storeActions(node, context)).filter((store): store is StoreActions => store !== null);
  const matches = stores.filter(store => external || (store.getter === receiver
    && store.actions.some(action => action.startLine <= ref.line && action.endLine >= ref.line
      && (action.startLine < ref.line || action.startColumn <= ref.column)
      && (action.endLine > ref.line || action.endColumn >= ref.column)
      // Function declarations also bind the getter name. They are separate
      // extracted nodes; parameter/variable shadows were checked above.
      && !nodes.some(node => node.id !== action.id && node.kind === 'function' && node.name === receiver
        && (node.startLine > action.startLine || (node.startLine === action.startLine && node.startColumn > action.startColumn))
        && (node.endLine < action.endLine || (node.endLine === action.endLine && node.endColumn < action.endColumn))))));
  return matches.length === 1 ? resolveAction(matches[0]!, (external ?? sibling)![2]!, ref) : null;
}
