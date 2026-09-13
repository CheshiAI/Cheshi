import type { Node as SyntaxNode } from '../web-tree-sitter';
import { getChildByField, getNodeText } from './tree-sitter-helpers';
import type { TreeSitterState } from './tree-sitter-state';
import {
  MEMBER_ACCESS_TYPES,
  scalaBaseTypeName,
  STATIC_MEMBER_LANGS
} from './tree-sitter-syntax';

export function resolveErlangGenServerTarget(this: TreeSitterState, target: SyntaxNode): string | null {
  const ownModule = (this.filePath.split('/').pop() ?? '').replace(/\.erl$/, '');
  if (target.type === 'atom') {
    const name = getNodeText(target, this.source).replace(/^'([\s\S]*)'$/, '$1');
    return name || null;
  }
  if (target.type !== 'macro_call_expr') return null;
  const nameNode = getChildByField(target, 'name');
  if (!nameNode) return null;
  const macroName = getNodeText(nameNode, this.source);
  if (macroName === 'MODULE') return ownModule || null;
  if (this.erlangServerMacroFile !== this.filePath) {
    this.erlangServerMacroFile = this.filePath;
    this.erlangSelfMacros = new Set<string>();
    this.erlangAtomMacros = new Map<string, string>();
    let root: SyntaxNode = target;
    while (root.parent) root = root.parent;
    for (let i = 0; i < root.namedChildCount; i++) {
      const form = root.namedChild(i);
      if (form?.type !== 'pp_define') continue;
      const lhs = getChildByField(form, 'lhs');
      const defName = lhs ? getChildByField(lhs, 'name') : null;
      const replacement = getChildByField(form, 'replacement');
      if (!defName || !replacement) continue;
      if (
        replacement.type === 'macro_call_expr' &&
        getChildByField(replacement, 'name') &&
        getNodeText(getChildByField(replacement, 'name')!, this.source) === 'MODULE'
      ) {
        this.erlangSelfMacros.add(getNodeText(defName, this.source));
      } else if (replacement.type === 'atom') {
        this.erlangAtomMacros.set(
          getNodeText(defName, this.source),
          getNodeText(replacement, this.source).replace(/^'([\s\S]*)'$/, '$1'),
        );
      }
    }
  }
  if (this.erlangSelfMacros.has(macroName)) return ownModule || null;
  return this.erlangAtomMacros.get(macroName) ?? null;
}

/**
   * `new Foo(...)` / `Foo::new(...)` / object_creation_expression —
   * emit an `instantiates` reference to the class name. The resolver
   * then links it to the class node, producing the `instantiates`
   * edge that powers "what creates instances of X" queries.
   *
   * Children are still walked so nested calls inside the constructor
   * arguments (`new Foo(bar())`) get their own `calls` references.
   */
/**
 * VB.NET `New Invoice(1)` is syntactically ambiguous between constructing
 * Invoice with an argument and allocating an Invoice array of bound 1; the
 * grammar parses the parenthesized form as array_creation_expression. A
 * user-defined type with no `{...}` array initializer is overwhelmingly a
 * constructor call, so treat it as an instantiation. Predefined element
 * types (`New Byte(1023)`) and brace-initialized forms stay arrays.
 */
export function isVbnetConstructorShapedArrayCreation(this: TreeSitterState, node: SyntaxNode): boolean {
  if (this.language !== 'vbnet' || node.type !== 'array_creation_expression') return false;
  const typeNode = getChildByField(node, 'type');
  if (!typeNode || typeNode.type === 'predefined_type' || typeNode.type === 'array_type') return false;
  for (const child of node.namedChildren) {
    if (child?.type === 'array_initializer') return false;
  }
  return true;
}

export function extractInstantiation(this: TreeSitterState, node: SyntaxNode): void {
  if (this.nodeStack.length === 0) return;
  const fromId = this.nodeStack[this.nodeStack.length - 1];
  if (!fromId) return;

  // The class name is in the `constructor`/`type`/first-named-child
  // depending on grammar.
  const ctor =
    getChildByField(node, 'constructor') ||
    getChildByField(node, 'type') ||
    getChildByField(node, 'name') ||
    node.namedChild(0);
  if (!ctor) return;

  // Go composite literals: `Widget{...}` (same package) and `pkga.Widget{...}`
  // (cross-package). Only a directly-named struct type is a meaningful
  // instantiation target — skip slice/map/array literals (`[]T{}`,
  // `map[K]V{}`) whose `type` field is a composite type, not a named type.
  // Unlike `new ns.Foo()`, KEEP the package qualifier (`pkga.Widget`) so the
  // Go cross-package resolver can disambiguate it to the right package's type.
  if (node.type === 'composite_literal') {
    if (ctor.type !== 'type_identifier' && ctor.type !== 'qualified_type') return;
    let goType = getNodeText(ctor, this.source).trim();
    const brIdx = goType.indexOf('['); // strip Go generic args: `Box[T]{}` -> `Box`
    if (brIdx > 0) goType = goType.slice(0, brIdx).trim();
    if (goType) {
      this.unresolvedReferences.push({
        fromNodeId: fromId,
        referenceName: goType,
        referenceKind: 'instantiates',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
    return;
  }

  // Scala: `new Monoid[Int] { ... }` — the constructor is a `generic_type`
  // (or qualified `stable_type_identifier`) using `[...]` type args, which the
  // generic `<...>` strip below misses. Unwrap to the base type name.
  if (node.type === 'instance_expression') {
    const name = scalaBaseTypeName(ctor, this.source);
    if (name) {
      this.unresolvedReferences.push({
        fromNodeId: fromId,
        referenceName: name,
        referenceKind: 'instantiates',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
    return;
  }

  let className = getNodeText(ctor, this.source);
  // Strip type-argument suffix first: `new Map<K, V>()` would
  // otherwise produce className 'Map<K, V>' (the constructor
  // field is a `generic_type` node) and resolution would fail
  // because no class is named with the angle-bracket suffix.
  const ltIdx = className.indexOf('<');
  if (ltIdx > 0) className = className.slice(0, ltIdx);
  // VB.NET spells generics with parentheses: `New List(Of String)` /
  // `New Dictionary(Of K, V)(cap)` — strip from the `(` so the bare
  // type name is what resolution matches.
  if (this.language === 'vbnet') {
    const parenIdx = className.indexOf('(');
    if (parenIdx > 0) className = className.slice(0, parenIdx);
  }
  // For namespaced/qualified constructors (`new ns.Foo()`,
  // `new ns::Foo()`) keep the trailing identifier — that's what
  // matches a class node in the index.
  const lastDot = Math.max(
    className.lastIndexOf('.'),
    className.lastIndexOf('::')
  );
  if (lastDot >= 0) className = className.slice(lastDot + 1).replace(/^[:.]/, '');
  className = className.trim();

  if (className) {
    this.unresolvedReferences.push({
      fromNodeId: fromId,
      referenceName: className,
      referenceKind: 'instantiates',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }
}

/**
   * Is this C++ `declaration` a stack/direct-initialization object construction
   * that invokes a constructor — `Calculator calc(0)` (direct-init) or
   * `Widget w{1, 2}` (brace-init) — as opposed to a plain variable or a
   * function declaration? Used to emit an `instantiates` edge for the
   * call-less construction syntax (#1035); heap `new T(...)` is handled
   * separately by INSTANTIATION_KINDS.
   *
   * Two signals, both required:
   *  - the `type` field is a class-like NAMED type (`type_identifier`,
   *    `template_type`, or `qualified_identifier`). Primitives (`int x(0)`),
   *    `auto` (`placeholder_type_specifier` — that form always carries a real
   *    `call_expression`, already handled), and sized specifiers are excluded —
   *    they construct no class; and
   *  - a declarator carries constructor arguments: an `init_declarator` whose
   *    `value` is an `argument_list` (`(args)`) or `initializer_list` (`{args}`).
   *    This skips default construction `Calculator c;` (no value) and the
   *    most-vexing-parse `Calculator c();` (a bodyless `function_declarator`,
   *    a function decl — not a construction).
   */
export function isCppStackConstruction(this: TreeSitterState, node: SyntaxNode): boolean {
  const typeNode = getChildByField(node, 'type');
  if (
    !typeNode ||
    (typeNode.type !== 'type_identifier' &&
      typeNode.type !== 'template_type' &&
      typeNode.type !== 'qualified_identifier')
  ) {
    return false;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type !== 'init_declarator') continue;
    const value = getChildByField(child, 'value');
    if (value && (value.type === 'argument_list' || value.type === 'initializer_list')) {
      return true;
    }
  }
  return false;
}

/**
   * Static-member / value-read pass. A type/enum/class used only via a member
   * VALUE — `Enum.value`, `Type.CONST`, `Colors.red`, `Foo::BAR` — recorded no
   * edge, because the body walker only handled CALLS (`Type.method()`). So a
   * type referenced only by an enum value or a static field looked like nothing
   * depended on it (the residual frontier across Dart/Java/C#/Swift/Kotlin/PHP).
   * Emit a `references` edge to the capitalized receiver. Gated to languages
   * where types are Capitalized by convention, and skipped when the access is a
   * call's callee (the call extractor already links the method).
   */
export function extractStaticMemberRef(this: TreeSitterState, node: SyntaxNode): void {
  if (!STATIC_MEMBER_LANGS.has(this.language)) return;
  if (this.nodeStack.length === 0) return;
  const ownerId = this.nodeStack[this.nodeStack.length - 1];
  if (!ownerId) return;

  // Dart structures member access as an `identifier` + a sibling `selector`,
  // not a single node. A value-read selector (no `argument_part`) whose
  // previous sibling is a capitalized identifier is `Enum.value`.
  if (this.language === 'dart') {
    if (node.type !== 'selector') return;
    if (node.namedChildren.some((c: SyntaxNode) => c.type === 'argument_part')) return;
    const prev = node.previousNamedSibling;
    if (prev?.type === 'identifier' && /^[A-Z][A-Za-z0-9_]*$/.test(prev.text)) {
      this.pushStaticMemberRef(prev.text, ownerId, prev);
    }
    return;
  }

  if (!MEMBER_ACCESS_TYPES.has(node.type)) return;

  // Skip `Type.method()` — the access is the callee of a call, already linked.
  const parent = node.parent;
  if (parent && this.extractor!.callTypes.includes(parent.type)) {
    const callee =
      getChildByField(parent, 'function') ??
      getChildByField(parent, 'method') ??
      parent.namedChild(0);
    if (callee && callee.startIndex === node.startIndex) return;
  }

  // The receiver must be a SIMPLE capitalized identifier — `Type.X`, not the
  // nested `a.B.c` (whose own head member-access is visited separately) nor a
  // lowercase `obj.field` / `pkg.func`.
  const recv =
    getChildByField(node, 'object') ??
    getChildByField(node, 'expression') ??
    getChildByField(node, 'scope') ??
    node.namedChild(0);
  if (!recv) return;
  const t = recv.type;
  if (
    t === 'identifier' || t === 'type_identifier' || t === 'simple_identifier' ||
    t === 'name' || t === 'scoped_type_identifier'
  ) {
    const text = getNodeText(recv, this.source);
    if (/^[A-Z][A-Za-z0-9_]*$/.test(text)) this.pushStaticMemberRef(text, ownerId, recv);
  }
}

export function pushStaticMemberRef(this: TreeSitterState, name: string, ownerId: string, node: SyntaxNode): void {
  this.unresolvedReferences.push({
    fromNodeId: ownerId,
    referenceName: name,
    referenceKind: 'references',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/**
   * Find a `class_body` child of an `object_creation_expression` — the
   * marker for an anonymous class (`new T() { ... }`). Returns the body
   * node so the caller can walk it as the anon class's members.
   */
export function findAnonymousClassBody(this: TreeSitterState, node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    // Java: `class_body`. C# uses the same node kind.
    if (child && (child.type === 'class_body' || child.type === 'declaration_list')) {
      return child;
    }
  }
  return null;
}

/**
   * Extract a Java/C# anonymous class — `new T() { ...members }`. Emits a
   * `class` node named `<T$anon@line>`, an `extends` reference to T (so
   * Phase 5.5 interface-impl can bridge), and walks the body so its
   * `method_declaration` members become method nodes under the anon class.
   *
   * Why this matters: without anon-class extraction, the overrides inside
   * a lambda-returned `new T() { @Override int foo(){...} }` are not nodes,
   * so a call through T.foo (the abstract parent method) has no static
   * target — the agent has to Read the file to find the implementation.
   */
export function extractAnonymousClass(this: TreeSitterState, node: SyntaxNode, body: SyntaxNode): void {
  if (!this.extractor) return;

  // The instantiated type sits in the same field/position that
  // extractInstantiation reads from. Use the same lookup so the anon
  // class's `extends` target matches the `instantiates` edge.
  const typeNode =
    getChildByField(node, 'constructor') ||
    getChildByField(node, 'type') ||
    getChildByField(node, 'name') ||
    node.namedChild(0);
  let typeName = typeNode ? getNodeText(typeNode, this.source) : 'Object';
  const ltIdx = typeName.indexOf('<');
  if (ltIdx > 0) typeName = typeName.slice(0, ltIdx);
  const lastDot = Math.max(typeName.lastIndexOf('.'), typeName.lastIndexOf('::'));
  if (lastDot >= 0) typeName = typeName.slice(lastDot + 1).replace(/^[:.]/, '');
  typeName = typeName.trim() || 'Object';

  const anonName = `<${typeName}$anon@${node.startPosition.row + 1}>`;
  const classNode = this.createNode('class', anonName, node, {});
  if (!classNode) return;

  // The anonymous class implicitly extends/implements the named type.
  // We can't tell at extraction time whether T is a class or an interface,
  // so emit `extends`. Resolution will still bind T to whatever it is, and
  // Phase 5.5 (which already handles both `extends` and `implements`) will
  // bridge T's methods to the override names found in the anon body.
  this.unresolvedReferences.push({
    fromNodeId: classNode.id,
    referenceName: typeName,
    referenceKind: 'extends',
    line: typeNode?.startPosition.row ?? node.startPosition.row,
    column: typeNode?.startPosition.column ?? node.startPosition.column,
  });

  // Walk the body's children so method_declaration nodes inside become
  // method nodes scoped to the anon class.
  this.nodeStack.push(classNode.id);
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (child) this.visitNode(child);
  }
  this.nodeStack.pop();
}
