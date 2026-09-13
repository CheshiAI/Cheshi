import type { Node as SyntaxNode, Tree } from '../web-tree-sitter';
import { getChildByField, getNodeText } from './tree-sitter-helpers';
import type { LanguageExtractor } from './tree-sitter-types';

/**
 * RTK Query generated-hook naming convention: `use` + PascalCase endpoint (with
 * an optional `Lazy` variant prefix) + `Query`/`Mutation`. Matches the hook
 * bindings to extract from an `export const {...} = api` destructuring. Kept in
 * sync with the same convention in `callback-synthesizer.ts` (the synth side).
 */
export const RTK_HOOK_NAME_RE = /^use[A-Z][A-Za-z0-9]*(?:Query|Mutation)$/;

/** React HOC callees whose result is itself a component — a PascalCase const
 *  initialized with one of these is a component, not a constant (#841). */
export const REACT_COMPONENT_HOCS = new Set(['forwardRef', 'memo', 'React.forwardRef', 'React.memo']);

/** Vue store collections whose object-literal members are the symbols an agent
 *  looks for. Extracted as function nodes so `actions`/`mutations`/`getters` are
 *  findable + readable (the foundation under any later dispatch-bridge synth). */
export const VUE_STORE_COLLECTION_NAMES = new Set(['actions', 'mutations', 'getters']);

/** Store-definition callees whose config object carries those collections. */
export const VUE_STORE_FACTORY_CALLEES = new Set(['defineStore', 'createStore']);

/** Distinct signals that a file is a Vuex/Pinia store (≥2 ⇒ treat a bare
 *  `const actions = {…}` as a store collection — see looksLikeVueStoreFile). */
export const VUE_STORE_FILE_SIGNAL = /\bdefineStore\b|\bcreateStore\b|\bVuex\b|\bmutations\b|\bactions\b|\bgetters\b|\bnamespaced\b/g;

export function requireParsedTree(tree: Tree | null): Tree {
  if (!tree) throw new Error('Parser returned null tree');
  return tree;
}

/**
 * Erlang calls that take their real callee as (Module, Function, Args)
 * ARGUMENTS — the spawn/apply family. Keys are the callee as the call site
 * spells it: bare for auto-imported BIFs, `module:function` for remote calls.
 * Used by the erlang branch of extractCall to lift a static MFA pair into a
 * call edge (the spawned/applied function is otherwise invisible to the graph).
 */
/** Compiler-predefined Erlang macros — no `-define` exists to link a use to. */
export const ERLANG_PREDEFINED_MACROS = new Set([
  'MODULE', 'MODULE_STRING', 'FILE', 'LINE', 'MACHINE',
  'FUNCTION_NAME', 'FUNCTION_ARITY', 'OTP_RELEASE',
  'FEATURE_AVAILABLE', 'FEATURE_ENABLED',
]);

export const ERLANG_MFA_CALLS = new Set([
  'spawn', 'spawn_link', 'spawn_monitor', 'spawn_opt', 'apply',
  'erlang:spawn', 'erlang:spawn_link', 'erlang:spawn_monitor', 'erlang:spawn_opt', 'erlang:apply',
  'proc_lib:spawn', 'proc_lib:spawn_link', 'proc_lib:spawn_opt', 'proc_lib:start', 'proc_lib:start_link',
  'timer:apply_after', 'timer:apply_interval',
  'rpc:call', 'rpc:cast', 'rpc:async_call',
  'erpc:call', 'erpc:cast',
]);

/**
 * Extract the name from a node based on language
 */
export function extractName(node: SyntaxNode, source: string, extractor: LanguageExtractor): string {
  const name = extractNameRaw(node, source, extractor);
  // Universal fallback: recover a real identifier from a name still mangled by a
  // macro the pre-parse didn't blank (C/C++ only — see recoverMangledName). A
  // no-op on well-formed names, so a clean name is never altered.
  return extractor.recoverMangledName ? extractor.recoverMangledName(name) : name;
}

function extractNameRaw(node: SyntaxNode, source: string, extractor: LanguageExtractor): string {
  const hookName = extractor.resolveName?.(node, source);
  if (hookName) return hookName;

  // Try field name first
  const nameNode = getChildByField(node, extractor.nameField);
  if (nameNode) {
    // Unwrap pointer_declarator / reference_declarator for C/C++ pointer and
    // reference return types (`int* f()`, `int& f()`, `int&& f()`). Without
    // unwrapping the reference wrapper an inline reference-returning method is
    // named "& f() const" instead of "f" — common in Unreal Engine gameplay
    // headers (`const FGameplayTagContainer& GetActiveTags() const`). Out-of-line
    // defs (`T& C::f()`) already resolve via the qualified-name hook. A
    // pointer_declarator exposes its inner through a `declarator` field; a
    // reference_declarator has none, so it's reached via namedChild(0).
    let resolved = nameNode;
    while (resolved.type === 'pointer_declarator' || resolved.type === 'reference_declarator') {
      const inner = getChildByField(resolved, 'declarator') || resolved.namedChild(0);
      if (!inner) break;
      resolved = inner;
    }
    // C++ user-defined conversion operator: the declarator is an `operator_cast`
    // whose first child is the target type and second is the `() const` tail. Name
    // it `operator <type>` (the conventional spelling) rather than the whole
    // `operator EALSMovementState() const` declarator, so it matches symbolic
    // overloads (`operator+`) and is findable by the type name.
    if (resolved.type === 'operator_cast') {
      const typeNode = resolved.namedChild(0);
      return typeNode ? `operator ${getNodeText(typeNode, source).trim()}` : getNodeText(resolved, source);
    }
    // Handle complex declarators (C/C++)
    if (resolved.type === 'function_declarator' || resolved.type === 'declarator') {
      const innerName = getChildByField(resolved, 'declarator') || resolved.namedChild(0);
      return innerName ? getNodeText(innerName, source) : getNodeText(resolved, source);
    }
    // Lua: `function t.f()` / `function t:m()` — the name node is a dot/method
    // index expression; the simple name is the trailing field/method (the table
    // receiver is captured separately via getReceiverType).
    if (resolved.type === 'dot_index_expression') {
      const field = getChildByField(resolved, 'field');
      if (field) return getNodeText(field, source);
    }
    if (resolved.type === 'method_index_expression') {
      const method = getChildByField(resolved, 'method');
      if (method) return getNodeText(method, source);
    }
    return getNodeText(resolved, source);
  }

  // For Dart method_signature, look inside inner signature types
  if (node.type === 'method_signature') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (
        child.type === 'function_signature' ||
        child.type === 'getter_signature' ||
        child.type === 'setter_signature' ||
        child.type === 'constructor_signature' ||
        child.type === 'factory_constructor_signature'
      )) {
        // Find identifier inside the inner signature
        for (let j = 0; j < child.namedChildCount; j++) {
          const inner = child.namedChild(j);
          if (inner?.type === 'identifier') {
            return getNodeText(inner, source);
          }
        }
      }
    }
  }

  // Arrow/function expressions get their name from the parent variable_declarator,
  // not from identifiers in their body. Without this, single-expression arrow
  // functions like `const fn = () => someIdentifier` get named "someIdentifier"
  // instead of "fn", because the fallback below finds the body identifier.
  if (node.type === 'arrow_function' || node.type === 'function_expression') {
    return '<anonymous>';
  }

  // Fall back to first identifier child
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (
      child &&
      (child.type === 'identifier' ||
        child.type === 'type_identifier' ||
        child.type === 'simple_identifier' ||
        child.type === 'constant')
    ) {
      return getNodeText(child, source);
    }
  }

  return '<anonymous>';
}

/**
 * Resolve a Scala type node to its base type NAME for name-matching — unwrapping
 * `generic_type` (`Monoid[Int]` → `Monoid`), taking the last segment of a
 * qualified `stable_type_identifier` (`cats.Functor` → `Functor`), and falling
 * back to a descendant `type_identifier`. Returns null for non-type nodes.
 * Shared by Scala inheritance and type-reference extraction.
 */
export function scalaBaseTypeName(node: SyntaxNode | null, source: string): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'type_identifier':
    case 'identifier':
      return getNodeText(node, source);
    case 'generic_type':
      // `<base> type_arguments` — the base type is the first named child.
      return scalaBaseTypeName(node.namedChild(0), source);
    case 'stable_type_identifier':
    case 'stable_identifier': {
      // Qualified `a.b.C` — match on the simple (last) segment.
      const ids = node.namedChildren.filter(
        (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'identifier'
      );
      const last = ids[ids.length - 1];
      return last ? getNodeText(last, source) : null;
    }
    default: {
      const id = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      return id ? getNodeText(id, source) : null;
    }
  }
}

/**
 * Resolve the declared identifier inside a C declarator. A `declaration`'s
 * `declarator` field nests the name through `init_declarator` (with value),
 * `pointer_declarator`/`array_declarator`/`parenthesized_declarator`
 * wrappers (each via their own `declarator` field) down to an `identifier`.
 * A `function_declarator` means the declaration is a function prototype (or a
 * function-pointer var) — return null so it isn't extracted as a variable.
 */
export function cDeclaratorIdentifier(node: SyntaxNode | null): SyntaxNode | null {
  let cur: SyntaxNode | null = node;
  let guard = 0;
  while (cur && guard++ < 12) {
    switch (cur.type) {
      case 'identifier':
        return cur;
      case 'function_declarator':
        return null;
      case 'init_declarator':
      case 'pointer_declarator':
      case 'array_declarator':
      case 'parenthesized_declarator':
        cur = getChildByField(cur, 'declarator');
        break;
      default:
        return null;
    }
  }
  return null;
}

/** First `simple_identifier` in `node`'s subtree (breadth-ish, first-found).
 * Swift's property name nests as `property_declaration → <name> pattern →
 * bound_identifier → simple_identifier`; this resolves it (and the bound name of
 * a Kotlin/Swift property declarator for the shadow prune). For a tuple pattern
 * (`let (a, b)`) it returns the first — acceptable, those are rare for consts. */
export function firstSimpleIdentifier(node: SyntaxNode | null): SyntaxNode | null {
  const stack: SyntaxNode[] = node ? [node] : [];
  let guard = 0;
  while (stack.length > 0 && guard++ < 40) {
    const n = stack.shift()!;
    if (n.type === 'simple_identifier') return n;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return null;
}

/** Swift property facts: the bound name, whether it's a `let`, and whether it's
 * a *computed* property (a getter block, no stored value — never a constant). */
export function swiftPropertyInfo(
  node: SyntaxNode,
  source: string,
): { nameNode: SyntaxNode | null; isLet: boolean; isComputed: boolean } {
  const pattern =
    getChildByField(node, 'name') ??
    node.namedChildren.find((c) => c.type === 'value_binding_pattern' || c.type === 'pattern') ??
    null;
  const binding = node.namedChildren.find((c) => c.type === 'value_binding_pattern');
  const isLet = binding != null && getNodeText(binding, source).trimStart().startsWith('let');
  const isComputed = node.namedChildren.some(
    (c) => c.type === 'computed_property' || c.type === 'protocol_property_requirements',
  );
  return { nameNode: firstSimpleIdentifier(pattern), isLet, isComputed };
}

/** True when `node` is (transitively) inside a C function body — i.e. a local,
 * not a file/namespace-scope declaration. Walks the parent chain to the root. */
export function hasFunctionAncestor(node: SyntaxNode): boolean {
  let p = node.parent;
  while (p) {
    if (p.type === 'function_definition') return true;
    p = p.parent;
  }
  return false;
}

/**
 * PHP type-position wrapper node kinds (a type-hint is `named_type`,
 * `?Foo` is `optional_type`, `A|B` is `union_type`, `A&B` is
 * `intersection_type`). Used to find the type subtree inside a parameter /
 * property / return position before walking it for class references.
 */
export const PHP_TYPE_NODES: ReadonlySet<string> = new Set([
  'named_type', 'optional_type', 'nullable_type',
  'union_type', 'intersection_type', 'disjunctive_normal_form_type',
  'primitive_type',
]);

/**
 * Member-access node kinds whose receiver, when it's a capitalized
 * type/enum/class name, is a real dependency — `Enum.value`, `Type.CONST`,
 * `Foo::BAR`. These VALUE reads (as opposed to `Type.method()` calls, already
 * handled) produced no edge, so a type used only via a static member or enum
 * value looked like nothing depended on it. See {@link extractStaticMemberRef}.
 */
export const MEMBER_ACCESS_TYPES: ReadonlySet<string> = new Set([
  'field_access',                       // java (`Foo.BAR`)
  'member_access_expression',           // c#  (`Foo.Bar`)
  'navigation_expression',              // kotlin / swift (`Foo.bar`)
  'field_expression',                   // scala (`Foo.bar`)
  'class_constant_access_expression',   // php (`Foo::CONST`, `Foo::class`)
  'scoped_property_access_expression',  // php (`Foo::$bar`)
  'qualified_identifier',               // c++ (`Foo::bar`)
]);

/**
 * Languages whose types are Capitalized by convention, so a capitalized
 * member-access receiver is reliably a type (not a local/variable). The
 * static-member/value-read pass is gated to these — the ones where it was the
 * confirmed residual frontier (enum-value / static-field reads). TS/JS/Python
 * are deliberately excluded, and a measured A/B confirms the call: extending the
 * pass to them adds ZERO coverage — in import-based languages you must `import` a
 * type before any `Type.MEMBER` read, so the import edge already covers it (the
 * static read is pure duplication) — while adding real graph noise (+1813 edges /
 * +2448 `references` on excalidraw, the retrieval-perf benchmark, all pointing at
 * already-covered types). Don't re-add `member_expression`/`attribute` here.
 */
export const STATIC_MEMBER_LANGS: ReadonlySet<string> = new Set([
  'java', 'csharp', 'kotlin', 'swift', 'scala', 'dart', 'php', 'cpp',
]);

/**
 * Tree-sitter node kinds that represent constructor invocations
 * (`new Foo()` and friends). Used by extractInstantiation to emit
 * an `instantiates` reference targeting the class name.
 */
export const INSTANTIATION_KINDS: ReadonlySet<string> = new Set([
  'new_expression',                  // typescript / javascript / tsx / jsx
  'object_creation_expression',      // java / c#
  'instance_creation_expression',    // some grammars
  'composite_literal',               // go — `Widget{...}` / `pkga.Widget{...}`
  'struct_expression',               // rust — `Widget { n: 1 }` / `m::Widget { .. }`
  'instance_expression',             // scala — `new Monoid[Int] { ... }`
]);

/**
 * TreeSitterExtractor - Main extraction class
 */
/**
 * tree-sitter node types (across grammars) for literal expressions in method-
 * call RECEIVER position. A literal's methods are the language's builtins —
 * `", ".join`, `"x".toUpperCase()`, `5.times`, `[].concat` — never project
 * symbols, so a member call on one must not emit a `calls` ref that bare-name
 * matching could bind to an unrelated same-named project function (#1230).
 */
export const LITERAL_RECEIVER_TYPES = new Set([
  // strings
  'string', 'string_literal', 'interpreted_string_literal', 'raw_string_literal',
  'template_string', 'concatenated_string', 'formatted_string', 'f_string',
  'line_string_literal', 'string_content', 'heredoc_body',
  // numbers
  'number', 'number_literal', 'integer', 'integer_literal', 'float',
  'float_literal', 'int_literal', 'decimal_integer_literal', 'real_literal',
  // chars / runes / regex / booleans / null-likes
  'char_literal', 'character_literal', 'rune_literal', 'regex', 'regex_literal',
  'true', 'false', 'boolean_literal', 'bool_literal', 'none', 'null', 'nil',
  'null_literal', 'undefined',
  // collection literals
  'list', 'list_literal', 'array', 'array_literal', 'array_creation_expression',
  'dictionary', 'dict_literal', 'object', 'tuple', 'set',
]);
