import type { Node } from '../types';
import { findExportedSymbol } from './import-exports';
import { resolveImportPath } from './import-paths';
import { stripCommentsForRegex } from './strip-comments';
import { thisMemberClassPrefix } from './this-member-scope';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

/** Detect ordinary function/object-method bodies omitted from extracted nodes. */
function crossesNestedThisBoundary(method: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/);
  if (!lines) return true;
  const segment = lines.slice(method.startLine - 1, ref.line);
  segment[segment.length - 1] = segment.at(-1)?.slice(0, ref.column) ?? '';
  segment[0] = segment[0]?.slice(method.startColumn) ?? '';
  const source = stripCommentsForRegex(segment.join('\n'), 'typescript').replace(
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g,
    value => value.replace(/[^\n]/g, ' '),
  );
  const parentheses: number[] = [];
  const bodies: { boundary: boolean; object: boolean }[] = [];
  let closed: { start: number; end: number } | undefined;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '(') parentheses.push(index);
    else if (character === ')') {
      const start = parentheses.pop();
      closed = start === undefined ? undefined : { start, end: index + 1 };
    } else if (character === '{') {
      let boundary = false;
      const callableBody = closed && /^\s*(?::[^={};]+)?$/.test(source.slice(closed.end, index));
      if (closed && callableBody) {
        const header = source.slice(0, closed.start);
        const keyword = /\bfor\s+await\s*$/.test(header) ? 'for' : header.match(/([$\w]+)\s*$/)?.[1];
        // Reserved words are valid object method names: `{ catch() { ... } }`
        // establishes its own this even though `catch (...) { ... }` does not.
        const control = !bodies.at(-1)?.object && ['if', 'for', 'while', 'switch', 'catch', 'with'].includes(keyword ?? '');
        boundary = bodies.length > 0 && !control;
      }
      const before = source.slice(0, index).trimEnd();
      const object = !callableBody && /[=(:,\[]$|\breturn$/.test(before);
      bodies.push({ boundary, object });
      closed = undefined;
    } else if (character === '}') bodies.pop();
  }
  return bodies.some(body => body.boundary);
}

/** A nominal annotation supplies evidence; unions and structural types do not. */
function nominalType(annotation: string): string | null {
  const match = annotation.trim().match(/^([$\w]+(?:\.[$\w]+)*)([\s\S]*)$/);
  if (!match) return null;
  const tail = match[2]!.trim();
  if (!tail) return match[1]!;
  if (!tail.startsWith('<')) return null;
  let depth = 0;
  for (let index = 0; index < tail.length; index++) {
    if (tail[index] === '<') depth++;
    else if (tail[index] === '>') depth--;
    if (depth === 0) return index === tail.length - 1 ? match[1]! : null;
  }
  return null;
}

/** Constructor parameters may contain nested commas in generics and defaults. */
function parameterDeclarations(signature: string): string[] {
  signature = stripCommentsForRegex(signature, 'typescript');
  const parameters: string[] = [];
  const stack: string[] = [];
  let initialized = false;
  let start = 1;
  for (let index = 1; index < signature.length - 1; index++) {
    const character = signature[index]!;
    if ('\"\'`'.includes(character)) {
      const quote = character;
      while (++index < signature.length) {
        if (signature[index] === '\\') index++;
        else if (signature[index] === quote) break;
      }
    } else if ('([{'.includes(character) || (character === '<' && !initialized)) stack.push(character);
    else if (')]}'.includes(character) || (character === '>' && stack.at(-1) === '<')) stack.pop();
    else if (character === '=' && stack.length === 0) initialized = true;
    else if (character === ',' && stack.length === 0) {
      parameters.push(signature.slice(start, index).trim());
      start = index + 1;
      initialized = false;
    }
  }
  parameters.push(signature.slice(start, -1).trim());
  return parameters;
}

function propertyType(property: string, owner: string, nodes: Node[]): string | null {
  const declaration = nodes.find(node => node.qualifiedName === `${owner}::${property}`
    && (node.kind === 'property' || node.kind === 'field') && !node.isStatic);
  if (declaration) {
    const signature = declaration.signature ?? '';
    const suffix = ` ${property}`;
    return signature.endsWith(suffix) ? nominalType(signature.slice(0, -suffix.length)) : null;
  }
  const constructor = nodes.find(node => node.kind === 'method' && node.qualifiedName === `${owner}::constructor`);
  if (!constructor?.signature) return null;
  for (const parameter of parameterDeclarations(constructor.signature)) {
    const match = parameter.match(/^(?:(?:public|protected|private|readonly)\s+)+([$\w]+)\??\s*:\s*([^=]+)(?:=[\s\S]*)?$/);
    if (match?.[1] === property) return nominalType(match[2]!);
  }
  return null;
}

function declaresTypeParameter(node: Node, name: string, context: ResolutionContext): boolean {
  if (node.typeParameters?.some(parameter => parameter.match(/^\s*([$\w]+)/)?.[1] === name)) return true;
  const lines = context.getFileLines?.(node.filePath) ?? context.readFile(node.filePath)?.split(/\r?\n/);
  if (!lines) return false;
  const source = lines.slice(node.startLine - 1, node.endLine);
  source[0] = source[0]?.slice(node.startColumn) ?? '';
  const declaration = stripCommentsForRegex(source.join('\n'), 'typescript');
  const header = declaration.match(/^(?:(?:export|default|abstract|async)\s+)*(?:class|function)\s+[$\w]+\s*<([\s\S]*)/);
  if (!header) return false;
  let depth = 1;
  for (let index = 0; index < header[1]!.length; index++) {
    const character = header[1]![index];
    if (character === '<') depth++;
    else if (character === '>') depth--;
    if (depth === 0) {
      return parameterDeclarations(`(${header[1]!.slice(0, index)})`)
        .some(parameter => parameter.match(/^(?:(?:const|in|out)\s+)*([$\w]+)/)?.[1] === name);
    }
  }
  return true;
}

function resolvePropertyClass(type: string, owner: string, ref: UnresolvedRef, context: ResolutionContext): Node | undefined {
  const parts = type.split('.');
  const owningScopes = owner.split('::');
  while (owningScopes.length) {
    const declaration = context.getNodesByQualifiedName(owningScopes.join('::')).find(node => node.filePath === ref.filePath);
    if (declaration && declaresTypeParameter(declaration, parts[0]!, context)) return undefined;
    owningScopes.pop();
  }
  // The property's declaration scope takes precedence over module imports.
  // Method-local classes cannot change a type annotation on the owning class.
  const scopes = owner.split('::');
  scopes.pop();
  while (true) {
    const qualified = [...scopes, parts[0]!].join('::');
    const candidates = context.getNodesByQualifiedName(qualified).filter(node => node.filePath === ref.filePath
      && ['class', 'interface', 'type_alias', 'enum', 'namespace'].includes(node.kind));
    if (candidates.length > 0) return parts.length === 1 && candidates.length === 1 ? candidates[0] : undefined;
    if (scopes.length === 0) break;
    scopes.pop();
  }
  const imported = context.getImportMappings(ref.filePath, ref.language).find(mapping => mapping.localName === parts[0]);
  if (!imported) return undefined;
  const file = resolveImportPath(imported.source, ref.filePath, ref.language, context);
  if (!file || (!imported.isNamespace && parts.length !== 1)) return undefined;
  return findExportedSymbol(file, {
    isDefault: imported.isDefault,
    isNamespace: imported.isNamespace,
    exportedName: imported.isDefault ? 'default' : imported.exportedName,
    memberName: imported.isNamespace ? parts.slice(1).join('.') : null,
  }, ref.language, context, new Set());
}

/** Follow one explicitly typed this-property, retaining its imported identity. */
export function resolveWebPropertyCall(
  receiver: string,
  method: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const property = receiver.match(/^this\.([$\w]+)$/)?.[1];
  if (!property) return null;
  const nodes = context.getNodesInFile(ref.filePath);
  const from = context.getNodeById?.(ref.fromNodeId) ?? nodes.find(node => node.id === ref.fromNodeId);
  if (!from || from.isStatic) return null;
  const owner = thisMemberClassPrefix(from, context);
  if (!owner) return null;
  if (nodes.some(node => node.kind === 'method' && node.isStatic
    && (from.id === node.id || from.qualifiedName.startsWith(`${node.qualifiedName}::`)))) return null;
  const methodScope = nodes.find(node => node.kind === 'method' && node.qualifiedName.startsWith(`${owner}::`)
    && !node.qualifiedName.slice(owner.length + 2).includes('::')
    && (from.id === node.id || from.qualifiedName.startsWith(`${node.qualifiedName}::`)));
  if (!methodScope || crossesNestedThisBoundary(methodScope, ref, context)) return null;
  const type = propertyType(property, owner, nodes);
  if (!type) return null;
  const target = resolvePropertyClass(type, owner, ref, context);
  if (!target || (target.kind !== 'class' && target.kind !== 'interface')) return null;
  const candidates = context.getNodesByQualifiedName(`${target.qualifiedName}::${method}`)
    .filter(node => node.filePath === target.filePath && node.kind === 'method' && !node.isStatic);
  if (candidates.length === 0) return null;
  return { original: ref, targetNodeId: candidates[0]!.id, confidence: 0.9, resolvedBy: 'instance-method' };
}
