import type { Node as SyntaxNode } from '../../web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';

/**
 * Find the function NAME's `qualified_identifier` (`Foo::bar`) inside a
 * declarator, skipping the `parameter_list` — a parameter with a qualified type
 * (`const std::string& x`) must NOT be mistaken for the method name. Without the
 * skip, a plain free function `std::string TableFileName(const std::string&...)`
 * was named `string` (from the parameter type), so calls to it never resolved
 * and its file looked like nothing depended on it.
 */
function findDeclaratorQualifiedId(declarator: SyntaxNode): SyntaxNode | undefined {
  const queue: SyntaxNode[] = [declarator];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.type === 'qualified_identifier') return current;
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i);
      // Don't descend into parameters or the trailing return type — their types
      // (`const std::string&`, `-> std::string`) aren't the function name.
      if (child && child.type !== 'parameter_list' && child.type !== 'trailing_return_type') {
        queue.push(child);
      }
    }
  }
  return undefined;
}

/**
 * Recover the real function name from the macro-definition idiom
 * `MACRO_NAME(real_name, typed args…) { body }` — flash-attention's
 * `DEFINE_FLASH_FORWARD_KERNEL(flash_fwd_kernel, bool Is_dropout, …) { … }`
 * being the motivating case: tree-sitter parses the invocation as a
 * function_definition NAMED after the macro, so every such kernel shared one
 * name (`DEFINE_FLASH_FORWARD_KERNEL`) and the launch sites' calls to the real
 * names (`flash_fwd_kernel<…><<<…>>>`) could never resolve.
 *
 * Deliberately narrow so name-in-first-arg is unambiguous — ALL of:
 *  - the parsed name is macro-shaped: ALL-CAPS with at least one underscore
 *    (`TEST` never matches; K&R C definitions have lowercase names);
 *  - the first "parameter" is a LONE identifier (no type, no declarator)
 *    containing a lowercase letter — the name being defined;
 *  - at least one more parameter follows and NONE of them is another lone
 *    identifier — a second bare arg means the first isn't the name (gtest's
 *    `TEST_F(Fixture, Name)`, `PYBIND11_MODULE(ext, m)`,
 *    google-benchmark's `BENCHMARK_DEFINE_F(Fix, name)` all bail here).
 */
function recoverCppMacroDefinedName(node: SyntaxNode, source: string): string | undefined {
  if (node.type !== 'function_definition') return undefined;
  const declarator = getChildByField(node, 'declarator');
  if (declarator?.type !== 'function_declarator') return undefined;
  const inner = getChildByField(declarator, 'declarator');
  if (inner?.type !== 'identifier') return undefined;
  const macroName = getNodeText(inner, source);
  if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(macroName)) return undefined;
  const params = getChildByField(declarator, 'parameters');
  if (!params || params.namedChildCount < 2) return undefined;
  const loneIdentText = (p: SyntaxNode): string | null =>
    p.type === 'parameter_declaration' &&
      p.namedChildCount === 1 &&
      p.namedChild(0)?.type === 'type_identifier'
      ? getNodeText(p.namedChild(0)!, source)
      : null;
  const first = params.namedChild(0);
  const name = first ? loneIdentText(first) : null;
  if (!name || !/[a-z]/.test(name)) return undefined;
  for (let i = 1; i < params.namedChildCount; i++) {
    const p = params.namedChild(i);
    if (p && loneIdentText(p) !== null) return undefined;
  }
  return name;
}

export function extractCppQualifiedMethodName(node: SyntaxNode, source: string): string | undefined {
  const macroDefined = recoverCppMacroDefinedName(node, source);
  if (macroDefined) return macroDefined;
  const declarator = getChildByField(node, 'declarator');
  if (!declarator) return undefined;
  const qid = findDeclaratorQualifiedId(declarator);
  if (!qid) return undefined;
  const parts = getNodeText(qid, source).trim().split('::').filter(Boolean);
  return parts[parts.length - 1];
}

export function extractCppReceiverType(node: SyntaxNode, source: string): string | undefined {
  const declarator = getChildByField(node, 'declarator');
  if (!declarator) return undefined;
  const qid = findDeclaratorQualifiedId(declarator);
  if (!qid) return undefined;
  const parts = getNodeText(qid, source).trim().split('::').filter(Boolean);
  if (parts.length <= 1) return undefined;
  // An out-of-line template method definition carries the class's template
  // parameter list in the qualifier (`template<typename T> T Box<T>::get()`),
  // but the class node is indexed as bare `Box` — strip `<…>` so the receiver
  // matches it, the same normalization #1043 applies to base-class refs.
  // Multi-line parameter lists otherwise leak whole `<…>` blocks (newlines
  // included) into qualified_name, which can exceed NAME_MAX (#1286).
  const receiver = stripCppTemplateArgs(parts.slice(0, -1).join('::'));
  return receiver || undefined;
}

/**
 * Built-in / non-class return types that can never be a method receiver. We
 * store no `returnType` for these so resolution never tries to resolve a method
 * on `void` / `int` / etc.
 */
const CPP_NON_CLASS_RETURN = new Set([
  'void', 'bool', 'char', 'short', 'int', 'long', 'float', 'double', 'unsigned',
  'signed', 'size_t', 'ssize_t', 'auto', 'wchar_t', 'char8_t', 'char16_t',
  'char32_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t',
  'uint32_t', 'uint64_t', 'intptr_t', 'uintptr_t', 'nullptr_t',
]);

/**
 * Normalize a C++ return type to the bare class name a method could be called
 * on. Unwraps smart-pointer / optional wrappers to their element type
 * (`std::unique_ptr<Widget>` → `Widget`) so a factory's `->method()` resolves on
 * the pointee. Strips cv-qualifiers, `&`/`*`, namespace qualifiers, and other
 * template args. Returns undefined for primitives / void / `auto` / empty.
 */
export function normalizeCppReturnType(raw: string): string | undefined {
  let t = raw.trim();
  if (!t) return undefined;
  // Unwrap smart pointers / optional to their pointee (the thing you call `->` on).
  const wrapper = t.match(/\b(?:std\s*::\s*)?(?:unique_ptr|shared_ptr|weak_ptr|optional)\s*<\s*([^,>]+?)\s*>/);
  if (wrapper && wrapper[1]) t = wrapper[1];
  t = t
    .replace(/\b(?:const|volatile|typename|struct|class|enum)\b/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return undefined;
  const last = t.split('::').filter(Boolean).pop();
  if (!last) return undefined;
  if (CPP_NON_CLASS_RETURN.has(last)) return undefined;
  if (!/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

/**
 * Strip C++ template arguments from a base-type reference name so it matches the
 * bare class/struct the template was DEFINED as. `template<typename T> class
 * Base { … }` is indexed as a node named `Base`, but a derived class
 * `class D : public Base<int>` records its base as the full `Base<int>` (and
 * `class Q : public ns::Tpl<int>` as `ns::Tpl<int>`) — neither name-matches
 * `Base` / `ns::Tpl`, so the `extends` edge never resolves and the derived class
 * looks like it inherits from nothing (#1043).
 *
 * Removes every balanced `<…>` group regardless of nesting or position, so
 * `Base<int>` → `Base`, `ns::Tpl<Foo<int>>` → `ns::Tpl`, and the rare
 * `Outer<int>::Inner` → `Outer::Inner`. The remaining qualified head is exactly
 * what the non-templated base case already produces, so resolution treats them
 * identically. A name with no template args passes through unchanged.
 */
export function stripCppTemplateArgs(name: string): string {
  if (!name.includes('<')) return name;
  let out = '';
  let depth = 0;
  for (const ch of name) {
    if (ch === '<') depth++;
    else if (ch === '>') { if (depth > 0) depth--; }
    else if (depth === 0) out += ch;
  }
  return out.trim();
}

/**
 * A function/method's return type lives in the `function_definition`'s `type`
 * field (`Metrics& Metrics::instance()` → `Metrics`). Constructors, destructors,
 * and conversion operators have no `type` field → undefined.
 */
export function extractCppReturnType(node: SyntaxNode, source: string): string | undefined {
  const typeNode = getChildByField(node, 'type');
  if (!typeNode) return undefined;
  return normalizeCppReturnType(getNodeText(typeNode, source));
}

export function resolveCFamilyTypeAliasKind(node: SyntaxNode): 'enum' | 'struct' | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'enum_specifier' && getChildByField(child, 'body')) return 'enum';
    if (child.type === 'struct_specifier' && getChildByField(child, 'body')) return 'struct';
  }
  return undefined;
}

export function extractCIncludeImport(node: SyntaxNode, source: string): { moduleName: string; signature: string } | null {
  const importText = source.substring(node.startIndex, node.endIndex).trim();
  const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string');
  if (systemLib) {
    return { moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''), signature: importText };
  }
  const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
  const stringContent = stringLiteral?.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
  return stringContent
    ? { moduleName: getNodeText(stringContent, source), signature: importText }
    : null;
}
