import {
  Node,
  NodeKind
} from '../types';
import type { Node as SyntaxNode } from '../web-tree-sitter';
import { getChildByField, getNodeText, getPrecedingDocstring } from './tree-sitter-helpers';
import type { TreeSitterState } from './tree-sitter-state';
import {
  extractName,
  REACT_COMPONENT_HOCS
} from './tree-sitter-syntax';

/**
   * Check if the current node stack indicates we are inside a class-like node
   * (class, struct, interface, trait). File nodes do not count as class-like.
   */
export function isInsideClassLikeNode(this: TreeSitterState): boolean {
  if (this.nodeStack.length === 0) return false;
  const parentId = this.nodeStack[this.nodeStack.length - 1];
  if (!parentId) return false;
  const parentNode = this.nodes.find((n) => n.id === parentId);
  if (!parentNode) return false;
  return (
    parentNode.kind === 'class' ||
    parentNode.kind === 'struct' ||
    parentNode.kind === 'interface' ||
    parentNode.kind === 'trait' ||
    parentNode.kind === 'enum' ||
    parentNode.kind === 'module'
  );
}

/**
   * Ruby `CONST = …` assignment whose LHS is a `constant` node — a class/module
   * (or top-level) constant worth extracting as a symbol even inside a class.
   * Other languages don't give an assignment a `constant`-typed LHS, so this
   * gate is effectively Ruby-only.
   */
export function isClassScopeConstantAssignment(this: TreeSitterState, node: SyntaxNode): boolean {
  if (node.type !== 'assignment') return false;
  const left = getChildByField(node, 'left') ?? node.namedChild(0);
  return left?.type === 'constant';
}

/**
   * Extract a function
   */
export function extractFunction(this: TreeSitterState, node: SyntaxNode, nameOverride?: string): void {
  if (!this.extractor) return;

  // If the language provides getReceiverType and this function has a receiver
  // (e.g., Rust function_item inside an impl block), extract as method instead
  if (this.extractor.getReceiverType?.(node, this.source)) {
    this.extractMethod(node);
    return;
  }

  // nameOverride is supplied only for explicitly-named anonymous functions the
  // caller resolved itself (e.g. arrow values of exported-const object members
  // — SvelteKit actions). Inline-object arrows reached by the general walker
  // get no override, so they still fall through to the <anonymous> skip below.
  let name = nameOverride ?? extractName(node, this.source, this.extractor);
  // For arrow functions and function expressions assigned to variables,
  // resolve the name from the parent variable_declarator.
  // e.g. `export const useAuth = () => { ... }` — the arrow_function node
  // has no `name` field; the name lives on the variable_declarator.
  if (
    !nameOverride &&
    name === '<anonymous>' &&
    (node.type === 'arrow_function' || node.type === 'function_expression')
  ) {
    const parent = node.parent;
    if (parent?.type === 'variable_declarator') {
      const varName = getChildByField(parent, 'name');
      if (varName) {
        name = getNodeText(varName, this.source);
      }
    }
  }
  if (name === '<anonymous>') {
    // Don't emit a node for the anonymous wrapper itself, but still visit its
    // body: AMD/RequireJS and CommonJS module wrappers (`define([], function(){…})`,
    // `(function(){…})()`) hold named inner functions and calls that would
    // otherwise be lost — the dispatcher set skipChildren, so nothing else
    // descends into this subtree. (#528)
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.visitFunctionBody(body, '');
    }
    return;
  }

  // Check for misparse artifacts (e.g. C++ macros causing "namespace detail" functions)
  // Skip the node but still visit the body for calls and structural nodes
  if (this.extractor.isMisparsedFunction?.(name, node)) {
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.visitFunctionBody(body, '');
    }
    return;
  }

  const docstring = getPrecedingDocstring(node, this.source);
  const signature = this.extractor.getSignature?.(node, this.source);
  const visibility = this.extractor.getVisibility?.(node);
  const isExported = this.extractor.isExported?.(node, this.source);
  const isAsync = this.extractor.isAsync?.(node);
  const isStatic = this.extractor.isStatic?.(node);
  const returnType = this.extractor.getReturnType?.(node, this.source);

  const funcNode = this.createNode('function', name, node, {
    docstring,
    signature,
    visibility,
    isExported,
    isAsync,
    isStatic,
    returnType,
  });
  if (!funcNode) return;

  // Extract type annotations (parameter types and return type)
  this.extractTypeAnnotations(node, funcNode.id);

  // Extract decorators applied to the function (rare in JS/TS but
  // present in Python `@decorator def f():` and Java/Kotlin
  // annotations on free functions).
  this.extractDecoratorsFor(node, funcNode.id);

  // Push to stack and visit body
  this.nodeStack.push(funcNode.id);
  const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
    ?? getChildByField(node, this.extractor.bodyField);
  if (body) {
    this.visitFunctionBody(body, funcNode.id);
  }
  this.nodeStack.pop();
}

/**
   * Detect a React component declared via an HOC wrapper whose result is itself a
   * component: `forwardRef(...)`, `memo(...)`, `React.forwardRef/memo(...)`, and
   * styled-components / emotion `styled.tag\`…\`` / `styled(Base)\`…\``. These
   * initializers are a call / tagged-template (not a bare arrow), so the const is
   * otherwise classified `constant` — and a constant is skipped by both the
   * JSX-render edge synthesizer and component resolution, so `<Button/>` usages
   * get no edge and callers/impact silently return empty (#841).
   *
   * Returns `{ inner }` — the inline render function to extract as the component
   * body, or `null` when the wrapper has no inline function (`memo(Imported)`,
   * `styled.button\`…\``) and only a bodyless component node is minted — or
   * `undefined` when this initializer is not a recognized component wrapper.
   */
export function reactComponentHoc(this: TreeSitterState, valueNode: SyntaxNode): { inner: SyntaxNode | null } | undefined {
  if (valueNode.type !== 'call_expression') return undefined;
  const callee = getChildByField(valueNode, 'function');
  if (!callee) return undefined;
  const calleeText = getNodeText(callee, this.source);
  // styled-components / emotion: `styled.button\`…\`` / `styled(Base)\`…\``.
  // tree-sitter models these tagged templates as a call_expression whose callee
  // is the `styled.x` / `styled(Base)` tag (\b avoids matching `styledFoo`).
  // No inline render fn — the argument is the CSS template.
  if (/^styled\b/.test(calleeText)) return { inner: null };
  // React HOCs: `forwardRef`/`memo`/`React.forwardRef`/`React.memo`.
  if (!REACT_COMPONENT_HOCS.has(calleeText)) return undefined;
  // The first arrow / function-expression argument is the render fn (if inline;
  // `memo(Imported)` passes a bare identifier and has none).
  const args = getChildByField(valueNode, 'arguments');
  let inner: SyntaxNode | null = null;
  if (args) {
    for (let i = 0; i < args.namedChildCount; i++) {
      const a = args.namedChild(i);
      if (a && (a.type === 'arrow_function' || a.type === 'function_expression')) {
        inner = a;
        break;
      }
    }
  }
  return { inner };
}

/**
   * Emit a `component` node for an HOC-wrapped React component declaration (see
   * reactComponentHoc). Named by the declarator (`Button`) and located at it so
   * the node range spans the body. When the wrapper has an inline render
   * function, its body is walked so the component's callees (hooks, helpers) are
   * captured under the component node — matching how a plain
   * `const Foo = () => …` arrow component already behaves.
   */
export function extractReactComponentNode(this: TreeSitterState, name: string, declarator: SyntaxNode, innerFn: SyntaxNode | null, extra: { docstring?: string; signature?: string; isExported?: boolean }): void {
  const compNode = this.createNode('component', name, declarator, extra);
  if (!compNode || !innerFn || !this.extractor) return;
  this.nodeStack.push(compNode.id);
  const body = this.extractor.resolveBody?.(innerFn, this.extractor.bodyField)
    ?? getChildByField(innerFn, this.extractor.bodyField);
  if (body) this.visitFunctionBody(body, compNode.id);
  this.nodeStack.pop();
}

/**
   * Extract a class
   */
export function extractClass(this: TreeSitterState, node: SyntaxNode, kind: NodeKind = 'class'): void {
  if (!this.extractor) return;

  // Skip forward declarations / elaborated type references (`class Foo;`) in
  // languages that opt in — bodiless there means "not a definition", so it
  // would otherwise mint a phantom node competing with the real definition
  // (#1093). Languages where a bodiless class is complete (Kotlin, Scala)
  // leave the flag unset. Resolved once here and reused for the body walk.
  const resolvedBody = this.extractor.resolveBody?.(node, this.extractor.bodyField)
    ?? getChildByField(node, this.extractor.bodyField);
  if (this.extractor.skipBodilessClass && !resolvedBody) return;

  const name = extractName(node, this.source, this.extractor);
  const docstring = getPrecedingDocstring(node, this.source);
  const visibility = this.extractor.getVisibility?.(node);
  const isExported = this.extractor.isExported?.(node, this.source);

  const classNode = this.createNode(kind, name, node, {
    docstring,
    visibility,
    isExported,
  });
  if (!classNode) return;

  // Extract extends/implements
  this.extractInheritance(node, classNode.id);

  // C# primary-constructor parameter dependencies (`class Svc(IRepo r, …)`).
  this.extractCsharpPrimaryCtorParamRefs(node, classNode.id);

  // Extract decorators applied to the class (`@Foo class X {}`).
  this.extractDecoratorsFor(node, classNode.id);

  // Push to stack and visit body
  this.nodeStack.push(classNode.id);
  const body = resolvedBody ?? node;

  // Visit all children for methods and properties
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (child) {
      this.visitNode(child);
    }
  }

  // Synthesize compile-time-generated members (Lombok accessors, #912). Runs
  // after the body so the hook can dedup against hand-written members, and
  // while the class is still on the stack so containment/QNs attach.
  if (this.extractor.synthesizeMembers) {
    this.extractor.synthesizeMembers(node, this.makeExtractorContext());
  }

  this.nodeStack.pop();
}

/**
   * Extract a method
   */
export function extractMethod(this: TreeSitterState, node: SyntaxNode): void {
  if (!this.extractor) return;

  // For languages with receiver types (Go, Rust), include receiver in qualified name
  // so FTS can match "scrapeLoop.run" → qualified_name "...::scrapeLoop::run"
  const receiverType = this.extractor.getReceiverType?.(node, this.source);

  // For most languages, only extract as method if inside a class-like node
  // Languages with methodsAreTopLevel (e.g. Go) always treat them as methods
  // Languages with getReceiverType (e.g. Rust) extract as method when receiver is found
  if (!this.isInsideClassLikeNode() && !this.extractor.methodsAreTopLevel && !receiverType) {
    // Skip method_definition nodes inside object literals (getters/setters/methods
    // in inline objects). These are ephemeral and create noise (e.g., Svelte context
    // objects: `ctx.set({ get view() { ... } })`).
    if (node.parent?.type === 'object' || node.parent?.type === 'object_expression') {
      const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
        ?? getChildByField(node, this.extractor.bodyField);
      if (body) {
        this.visitFunctionBody(body, '');
      }
      return;
    }
    // Not inside a class-like node and no receiver type, treat as function
    this.extractFunction(node);
    return;
  }

  const name = extractName(node, this.source, this.extractor);

  // Check for misparse artifacts (e.g. C++ "switch" inside macro-confused class body)
  if (this.extractor.isMisparsedFunction?.(name, node)) {
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.visitFunctionBody(body, '');
    }
    return;
  }

  const docstring = getPrecedingDocstring(node, this.source);
  const signature = this.extractor.getSignature?.(node, this.source);
  const visibility = this.extractor.getVisibility?.(node);
  const isAsync = this.extractor.isAsync?.(node);
  const isStatic = this.extractor.isStatic?.(node);
  const returnType = this.extractor.getReturnType?.(node, this.source);
  const extraProps: Partial<Node> = {
    docstring,
    signature,
    visibility,
    isAsync,
    isStatic,
    returnType,
  };
  if (receiverType) {
    extraProps.qualifiedName = this.composeReceiverQualifiedName(receiverType, name);
  }

  const methodNode = this.createNode('method', name, node, extraProps);
  if (!methodNode) return;

  // For methods with a receiver type but no class-like parent on the stack
  // (e.g., Rust impl blocks), add a contains edge from the owning struct/trait
  if (receiverType && !this.isInsideClassLikeNode()) {
    const ownerNode = this.nodes.find(
      (n) =>
        n.name === receiverType &&
        n.filePath === this.filePath &&
        (n.kind === 'struct' || n.kind === 'class' || n.kind === 'enum' || n.kind === 'trait')
    );
    if (ownerNode) {
      this.edges.push({
        source: ownerNode.id,
        target: methodNode.id,
        kind: 'contains',
      });
    }
  }

  // Extract type annotations (parameter types and return type)
  this.extractTypeAnnotations(node, methodNode.id);

  // Extract decorators (`@Get('/list') list() {}`).
  this.extractDecoratorsFor(node, methodNode.id);

  // Push to stack and visit body
  this.nodeStack.push(methodNode.id);
  const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
    ?? getChildByField(node, this.extractor.bodyField);
  if (body) {
    this.visitFunctionBody(body, methodNode.id);
  }
  this.nodeStack.pop();
}

/**
   * Extract an interface/protocol/trait
   */
export function extractInterface(this: TreeSitterState, node: SyntaxNode): void {
  if (!this.extractor) return;

  const name = extractName(node, this.source, this.extractor);
  const docstring = getPrecedingDocstring(node, this.source);
  const isExported = this.extractor.isExported?.(node, this.source);

  const kind: NodeKind = this.extractor.interfaceKind ?? 'interface';

  const interfaceNode = this.createNode(kind, name, node, {
    docstring,
    isExported,
  });
  if (!interfaceNode) return;

  // Extract extends (interface inheritance)
  this.extractInheritance(node, interfaceNode.id);

  // Visit body children for interface methods and nested types
  this.nodeStack.push(interfaceNode.id);
  let body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
    ?? getChildByField(node, this.extractor.bodyField);
  if (!body) body = node;
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (child) {
      this.visitNode(child);
    }
  }
  this.nodeStack.pop();
}

/**
   * Extract a struct
   */
export function extractStruct(this: TreeSitterState, node: SyntaxNode): void {
  if (!this.extractor) return;

  // Skip forward declarations and type references (no body = not a definition)
  // — EXCEPT C# positional records (`record struct M(decimal Amount);`),
  // complete definitions with no body block. (#831)
  const body = getChildByField(node, this.extractor.bodyField);
  if (!body && node.type !== 'record_declaration') return;

  const name = extractName(node, this.source, this.extractor);
  const docstring = getPrecedingDocstring(node, this.source);
  const visibility = this.extractor.getVisibility?.(node);
  const isExported = this.extractor.isExported?.(node, this.source);

  const structNode = this.createNode('struct', name, node, {
    docstring,
    visibility,
    isExported,
  });
  if (!structNode) return;

  // Extract inheritance (e.g. Swift: struct HTTPMethod: RawRepresentable)
  this.extractInheritance(node, structNode.id);

  // C# primary-constructor parameter dependencies (`struct P(int x)`, and
  // `record struct M(decimal Amount)` which the grammar nests here).
  this.extractCsharpPrimaryCtorParamRefs(node, structNode.id);

  // Push to stack for field extraction (bodiless positional records have
  // no members to visit)
  if (body) {
    this.nodeStack.push(structNode.id);
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }
}

/**
   * Extract an enum
   */
export function extractEnum(this: TreeSitterState, node: SyntaxNode): void {
  if (!this.extractor) return;

  // Skip forward declarations and type references (no body = not a definition)
  const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
    ?? getChildByField(node, this.extractor.bodyField);
  if (!body) return;

  const name = extractName(node, this.source, this.extractor);
  const docstring = getPrecedingDocstring(node, this.source);
  const visibility = this.extractor.getVisibility?.(node);
  const isExported = this.extractor.isExported?.(node, this.source);

  const enumNode = this.createNode('enum', name, node, {
    docstring,
    visibility,
    isExported,
  });
  if (!enumNode) return;

  // Extract inheritance (e.g. Swift: enum AFError: Error)
  this.extractInheritance(node, enumNode.id);

  // Push to stack and visit body children (enum members, nested types, methods)
  this.nodeStack.push(enumNode.id);

  const memberTypes = this.extractor.enumMemberTypes;
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;

    if (memberTypes?.includes(child.type)) {
      this.extractEnumMembers(child);
    } else {
      this.visitNode(child);
    }
  }
  this.nodeStack.pop();
}

/**
   * Extract enum member names from an enum member node.
   * Handles multi-case declarations (Swift: `case put, delete`) and single-case patterns.
   */
export function extractEnumMembers(this: TreeSitterState, node: SyntaxNode): void {
  // Try field-based name first (e.g. Rust enum_variant has a 'name' field)
  const nameNode = getChildByField(node, 'name');
  if (nameNode) {
    this.createNode('enum_member', getNodeText(nameNode, this.source), node);
    return;
  }

  // Check for identifier-like children (Swift: simple_identifier, TS: property_identifier)
  let found = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && (child.type === 'simple_identifier' || child.type === 'identifier' || child.type === 'property_identifier')) {
      this.createNode('enum_member', getNodeText(child, this.source), child);
      found = true;
    }
  }

  // If the node itself IS the identifier (e.g. TS property_identifier directly in enum body)
  if (!found && node.namedChildCount === 0) {
    this.createNode('enum_member', getNodeText(node, this.source), node);
  }
}

/**
   * Extract a class property declaration (e.g. C# `public string Name { get; set; }`).
   * Extracts as 'property' kind node inside the owning class.
   */
export function extractProperty(this: TreeSitterState, node: SyntaxNode): Node | null {
  if (!this.extractor) return null;

  const docstring = getPrecedingDocstring(node, this.source);
  const visibility = this.extractor.getVisibility?.(node);
  const isStatic = this.extractor.isStatic?.(node) ?? false;

  const hookName = this.extractor.extractPropertyName?.(node, this.source);
  // JS `field_definition` names its key the `property` field (TS uses
  // `name`) — try both before the generic identifier scan (#808).
  const nameNode = hookName
    ? null
    : getChildByField(node, 'name') ||
    getChildByField(node, 'property') ||
    node.namedChildren.find(c => c.type === 'identifier');
  const name = hookName ?? (nameNode ? getNodeText(nameNode, this.source) : null);
  if (!name) return null;

  // Get property type. TS/JS field definitions carry an explicit `type`
  // field (a `type_annotation`); their other named children are the name
  // and the initializer VALUE, which the generic finder below would
  // wrongly pick — so fields use the type field only (#808). Other
  // languages (C# property_declaration) keep the generic scan.
  const isTsJsField =
    node.type === 'public_field_definition' || node.type === 'field_definition';
  const typeNode = isTsJsField
    ? getChildByField(node, 'type')
    : node.namedChildren.find(
      c => c.type !== 'modifier' && c.type !== 'modifiers'
        && c.type !== 'identifier' && c.type !== 'accessor_list'
        && c.type !== 'accessors' && c.type !== 'equals_value_clause'
    );
  const typeText = typeNode
    ? getNodeText(typeNode, this.source).replace(/^:\s*/, '')
    : undefined;
  const signature = typeText ? `${typeText} ${name}` : name;

  const propNode = this.createNode('property', name, node, {
    docstring,
    signature,
    visibility,
    isStatic,
  });

  // `@Inject() private svc: Foo` and similar — capture the
  // decorator->target relationship for class properties too.
  if (propNode) {
    this.extractDecoratorsFor(node, propNode.id);
    // Emit `references` edges from the property to types named in its
    // type annotation (#381). The generic walker handles TS-style
    // `type_annotation` children; the C# branch walks the `type` field.
    this.extractTypeAnnotations(node, propNode.id);
  }
  return propNode;
}

/**
   * Extract a class field declaration (e.g. Java field_declaration, C# field_declaration).
   * Extracts each declarator as a 'field' kind node inside the owning class.
   */
export function extractField(this: TreeSitterState, node: SyntaxNode): void {
  if (!this.extractor) return;

  const docstring = getPrecedingDocstring(node, this.source);
  const visibility = this.extractor.getVisibility?.(node);
  const isStatic = this.extractor.isStatic?.(node) ?? false;

  // A class field that is actually a CONSTANT (Java `static final`, C# `const`
  // / `static readonly`) is extracted as `constant` kind, not `field`, so
  // value-reference edges treat it as a target (the gate accepts
  // constant/variable, not field). Scoped to languages whose `isConst`
  // predicate is field-shaped — other languages' fields stay `field`.
  const fieldKind: NodeKind =
    (this.language === 'java' || this.language === 'csharp') &&
      (this.extractor.isConst?.(node) ?? false)
      ? 'constant'
      : 'field';

  // Java field_declaration: "private final String name = value;" → variable_declarator(s) are direct children
  // C# field_declaration: wraps in variable_declaration → variable_declarator(s)
  let declarators = node.namedChildren.filter(
    c => c.type === 'variable_declarator'
  );
  // C#: look inside variable_declaration wrapper
  if (declarators.length === 0) {
    const varDecl = node.namedChildren.find(c => c.type === 'variable_declaration');
    if (varDecl) {
      declarators = varDecl.namedChildren.filter(c => c.type === 'variable_declarator');
    }
  }

  // PHP property_declaration: property_element → variable_name → name
  if (declarators.length === 0) {
    const propElements = node.namedChildren.filter(c => c.type === 'property_element');
    if (propElements.length > 0) {
      // Get type annotation if present (e.g. "string", "int", "?Foo")
      const typeNode = node.namedChildren.find(
        c => c.type !== 'visibility_modifier' && c.type !== 'static_modifier'
          && c.type !== 'readonly_modifier' && c.type !== 'property_element'
          && c.type !== 'var_modifier'
      );
      const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;

      for (const elem of propElements) {
        const varName = elem.namedChildren.find(c => c.type === 'variable_name');
        const nameNode = varName?.namedChildren.find(c => c.type === 'name');
        if (!nameNode) continue;
        const name = getNodeText(nameNode, this.source);
        const signature = typeText ? `${typeText} $${name}` : `$${name}`;
        this.createNode('field', name, elem, {
          docstring,
          signature,
          visibility,
          isStatic,
        });
      }
      return;
    }
  }

  if (declarators.length > 0) {
    // Get field type from the type child
    // Java: type is a direct child of field_declaration
    // C#: type is inside variable_declaration wrapper
    const varDecl = node.namedChildren.find(c => c.type === 'variable_declaration');
    const typeSearchNode = varDecl ?? node;
    const typeNode = typeSearchNode.namedChildren.find(
      c => c.type !== 'modifiers' && c.type !== 'modifier' && c.type !== 'variable_declarator'
        && c.type !== 'variable_declaration' && c.type !== 'marker_annotation' && c.type !== 'annotation'
    );
    const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;

    for (const decl of declarators) {
      const nameNode = getChildByField(decl, 'name')
        || decl.namedChildren.find(c => c.type === 'identifier');
      if (!nameNode) continue;
      const name = getNodeText(nameNode, this.source);
      const signature = typeText ? `${typeText} ${name}` : name;
      const fieldNode = this.createNode(fieldKind, name, decl, {
        docstring,
        signature,
        visibility,
        isStatic,
      });
      // Java/Kotlin annotations / TS field decorators sit on the
      // outer field_declaration, not on the individual declarator.
      if (fieldNode) {
        this.extractDecoratorsFor(node, fieldNode.id);
        // Same as properties: emit `references` to the field's annotated
        // type. The outer `field_declaration` is the right scope to
        // search from — C# carries the `type` inside `variable_declaration`
        // and the language-aware path in `extractTypeAnnotations` descends
        // into that wrapper (#381).
        this.extractTypeAnnotations(node, fieldNode.id);
      }
    }
  } else {
    // Fallback: try to find an identifier child directly
    const nameNode = getChildByField(node, 'name')
      || node.namedChildren.find(c => c.type === 'identifier');
    if (nameNode) {
      const name = getNodeText(nameNode, this.source);
      this.createNode(fieldKind, name, node, {
        docstring,
        visibility,
        isStatic,
      });
    }
  }
}
