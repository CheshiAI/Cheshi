import type { Node as SyntaxNode } from '../web-tree-sitter';
import { getChildByField, getNodeText } from './tree-sitter-helpers';
import type { TreeSitterState } from './tree-sitter-state';
import {
  PHP_TYPE_NODES
} from './tree-sitter-syntax';

/**
   * Extract type references from type annotations on a function/method/field node.
   * Creates 'references' edges for parameter types, return types, and field types.
   */
export function extractTypeAnnotations(this: TreeSitterState, node: SyntaxNode, nodeId: string): void {
  if (!this.extractor) return;
  if (!this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) return;

  // C# tree-sitter doesn't produce `type_identifier` leaves — it uses
  // `identifier`, `predefined_type`, `qualified_name`, `generic_name`,
  // etc. — so the generic walker below emits zero references for it.
  // Dispatch to a C#-aware path that only walks type-position subtrees
  // (the `type` field of a parameter/method/property/field), so
  // parameter NAMES never accidentally surface as type refs (#381).
  if (this.language === 'csharp') {
    this.extractCsharpTypeRefs(node, nodeId);
    return;
  }

  // PHP type-hints are `named_type`/`optional_type`/`union_type` wrapping a
  // `name`/`qualified_name` — never `type_identifier` — so the generic walker
  // below emits nothing for them. Dispatch to a PHP-aware path that walks only
  // type positions (parameter / return / property types), so type-hinted
  // dependencies (the constructor-injected contracts that dominate Laravel) are
  // recorded and a `variable_name` like `$events` never mis-emits as a ref.
  if (this.language === 'php') {
    this.extractPhpTypeRefs(node, nodeId);
    return;
  }

  // Dart: a `method_signature` wraps the real `function_signature` (where the
  // params and return type live), and the return type is a bare
  // `type_identifier` child, not a `type` field — so getChildByField below
  // finds neither. Walk the inner signature: param names / the method name are
  // `identifier` (not `type_identifier`), so only types surface.
  if (this.language === 'dart') {
    let sig: SyntaxNode | undefined = node;
    if (node.type === 'method_signature') {
      sig = node.namedChildren.find(
        (c: SyntaxNode) =>
          c.type === 'function_signature' ||
          c.type === 'getter_signature' ||
          c.type === 'setter_signature' ||
          c.type === 'constructor_signature' ||
          c.type === 'factory_constructor_signature'
      ) ?? node;
    }
    this.extractTypeRefsFromSubtree(sig, nodeId);
    return;
  }

  // Extract parameter type annotations. Scala curries — `def f(a)(implicit
  // M: TC)` has MULTIPLE `parameters` siblings, and the typeclass is almost
  // always in the trailing implicit list — so walk every parameter list, not
  // just getChildByField's first match.
  if (this.language === 'scala') {
    for (const pc of node.namedChildren) {
      if (pc.type === 'parameters') this.extractTypeRefsFromSubtree(pc, nodeId);
    }
  } else {
    const params = getChildByField(node, this.extractor.paramsField || 'parameters');
    if (params) {
      this.extractTypeRefsFromSubtree(params, nodeId);
    }
  }

  // Extract return type annotation
  const returnType = getChildByField(node, this.extractor.returnField || 'return_type');
  if (returnType) {
    this.extractTypeRefsFromSubtree(returnType, nodeId);
  }

  // Scala context bounds / type-parameter bounds: `def f[A: Monoid]`,
  // `[F[_]: Monad]`, `[A <: Foo]` carry the bound type inside `type_parameters`.
  // This is THE pervasive way a typeclass is required in Scala, yet the bound
  // never appears in the value parameters. Param NAMES are `identifier` (not
  // `type_identifier`), so only the bound types surface. Scala-only: in other
  // languages a `type_parameters` child holds declaration names as
  // `type_identifier` (TS `<T>`), which would wrongly surface as refs.
  if (this.language === 'scala') {
    const typeParams = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type_parameters'
    );
    if (typeParams) {
      this.extractTypeRefsFromSubtree(typeParams, nodeId);
    }
  }

  // Extract direct type annotation (for class fields like `model: ITextModel`)
  const typeAnnotation = node.namedChildren.find(
    (c: SyntaxNode) => c.type === 'type_annotation'
  );
  if (typeAnnotation) {
    this.extractTypeRefsFromSubtree(typeAnnotation, nodeId);
  }
}

/**
   * Extract C# type references from a node that owns a type position —
   * a method/constructor declaration, a property declaration, or a
   * field declaration (which wraps `variable_declaration → type`).
   *
   * Walks ONLY into known type fields, so parameter names like
   * `request` in `Build(UserDto request)` are never mis-emitted as
   * type references. Once inside a type subtree, `walkCsharpTypePosition`
   * recognizes C#'s actual type-leaf node kinds (`identifier`,
   * `qualified_name`, `generic_name`, `array_type`, `nullable_type`,
   * `tuple_type`, …) — none of which are `type_identifier`. Closes #381.
   */
export function extractCsharpTypeRefs(this: TreeSitterState, node: SyntaxNode, nodeId: string): void {
  // A property's type is under the `type` field; a method/constructor's RETURN
  // type is under `returns` (tree-sitter-c-sharp 0.23.x — older builds used
  // `type` for both). A node carries only one of the two, so checking both
  // covers return types and property types without conflating them.
  const directType = getChildByField(node, 'type') ?? getChildByField(node, 'returns');
  if (directType) this.walkCsharpTypePosition(directType, nodeId);

  // Field declarations wrap declarators in a `variable_declaration`
  // whose `type` field carries the type. The outer `field_declaration`
  // has no `type` field of its own, so the call above is a no-op here
  // and we descend one level.
  const varDecl = node.namedChildren.find((c: SyntaxNode) => c.type === 'variable_declaration');
  if (varDecl) {
    const vdType = getChildByField(varDecl, 'type');
    if (vdType) this.walkCsharpTypePosition(vdType, nodeId);
  }

  // Method / constructor parameters. The field name on
  // `method_declaration` is `parameters`; it points at a
  // `parameter_list` whose `parameter` children each have their own
  // `type` field. Walking ONLY the type field skips parameter NAMES,
  // which would otherwise mis-emit as type references.
  const params = getChildByField(node, 'parameters');
  if (params) {
    for (let i = 0; i < params.namedChildCount; i++) {
      const child = params.namedChild(i);
      if (!child || child.type !== 'parameter') continue;
      const paramType = getChildByField(child, 'type');
      if (paramType) this.walkCsharpTypePosition(paramType, nodeId);
    }
  }
}

/**
   * Record the dependencies declared by a C# PRIMARY CONSTRUCTOR
   * (`class Svc(IRepo repo, [FromKeyedServices("k")] ICache cache) { … }`,
   * C# 12+). The parameter list hangs off the class/struct/record declaration
   * as an unnamed-field `parameter_list` child (not the `parameters` field a
   * method uses), so it's found by node type. Each parameter's declared type
   * becomes a `references` edge from the owning type — these are exactly the
   * services a DI-registered type depends on, so impact/blast-radius and
   * "who depends on this contract" now see them. No-op when there's no primary
   * constructor. (#237)
   */
export function extractCsharpPrimaryCtorParamRefs(this: TreeSitterState, node: SyntaxNode, ownerId: string): void {
  if (this.language !== 'csharp') return;
  const paramList = node.namedChildren.find((c: SyntaxNode) => c.type === 'parameter_list');
  if (!paramList) return;
  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param || param.type !== 'parameter') continue;
    const paramType = getChildByField(param, 'type');
    if (paramType) this.walkCsharpTypePosition(paramType, ownerId);
  }
}

/**
   * Walk a C# subtree that is KNOWN to be in a type position
   * (return type, parameter type, property type, field type, generic
   * argument). Identifiers here are type names, not parameter names.
   */
export function walkCsharpTypePosition(this: TreeSitterState, node: SyntaxNode, fromNodeId: string): void {
  // `predefined_type` is int/string/bool/etc. — never a project ref.
  if (node.type === 'predefined_type') return;

  // Bare type name: `Foo` in `Foo bar`, or the `Foo` inside `List<Foo>`.
  if (node.type === 'identifier') {
    const name = getNodeText(node, this.source);
    if (name && !this.BUILTIN_TYPES.has(name)) {
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: name,
        referenceKind: 'references',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
    return;
  }

  // `Namespace.Foo` → the rightmost identifier is the type. Emit the
  // full qualified name as the reference; the resolver can still match
  // on the trailing simple name when needed.
  if (node.type === 'qualified_name') {
    const text = getNodeText(node, this.source);
    const last = text.split('.').pop() ?? text;
    if (last && !this.BUILTIN_TYPES.has(last)) {
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: last,
        referenceKind: 'references',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
    return;
  }

  // `(int Code, Foo Payload)` — tuple element has BOTH a `type` and a
  // `name` field; descending into all named children would mis-emit
  // the element name (`Code`, `Payload`) as a type ref. Walk only the
  // type field.
  if (node.type === 'tuple_element') {
    const t = getChildByField(node, 'type');
    if (t) this.walkCsharpTypePosition(t, fromNodeId);
    return;
  }

  // Composite type nodes — recurse into named children. Covers
  // `generic_name` (head identifier + `type_argument_list`),
  // `nullable_type`, `array_type`, `pointer_type`, `tuple_type`,
  // `ref_type`, and any newer wrapping shapes the grammar adds.
  // Identifiers reached here are all type-positional (parameter/field
  // names are gated out before we descend).
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) this.walkCsharpTypePosition(child, fromNodeId);
  }
}

/**
   * Extract PHP type references from a method/function/property declaration.
   * Walks ONLY type positions: each parameter's type child (inside
   * `formal_parameters`), the return type, and a property's type — all
   * `named_type` / `optional_type` / `union_type` / … direct children. Parameter
   * and property NAMES are `variable_name` (`$x`), never type nodes, so they
   * can't be mis-emitted.
   */
export function extractPhpTypeRefs(this: TreeSitterState, node: SyntaxNode, nodeId: string): void {
  const params = node.namedChildren.find((c: SyntaxNode) => c.type === 'formal_parameters');
  if (params) {
    for (const p of params.namedChildren) {
      // simple_parameter / property_promotion_parameter / variadic_parameter
      for (const c of p.namedChildren) {
        if (PHP_TYPE_NODES.has(c.type)) this.walkPhpTypePosition(c, nodeId);
      }
    }
  }
  // Return type (method/function) and property type are TYPE nodes that are
  // DIRECT children of the declaration.
  for (const c of node.namedChildren) {
    if (PHP_TYPE_NODES.has(c.type)) this.walkPhpTypePosition(c, nodeId);
  }
}

/** Walk a PHP subtree KNOWN to be in a type position; emit class/interface refs. */
export function walkPhpTypePosition(this: TreeSitterState, node: SyntaxNode, fromNodeId: string): void {
  if (node.type === 'primitive_type') return; // int/string/void/…
  if (node.type === 'name') {
    const name = getNodeText(node, this.source);
    if (name && !this.PHP_PSEUDO_TYPES.has(name)) {
      this.unresolvedReferences.push({
        fromNodeId, referenceName: name, referenceKind: 'references',
        line: node.startPosition.row + 1, column: node.startPosition.column,
      });
    }
    return;
  }
  if (node.type === 'qualified_name') {
    // `App\Contracts\Logger` → match on the trailing simple name (what the
    // class node is stored as, and what a `use` import brings into scope).
    const last = getNodeText(node, this.source).split('\\').pop() ?? '';
    if (last && !this.PHP_PSEUDO_TYPES.has(last)) {
      this.unresolvedReferences.push({
        fromNodeId, referenceName: last, referenceKind: 'references',
        line: node.startPosition.row + 1, column: node.startPosition.column,
      });
    }
    return;
  }
  // optional_type / nullable_type / union_type / intersection_type / named_type → recurse
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) this.walkPhpTypePosition(child, fromNodeId);
  }
}

/**
   * Extract type references from a variable's type annotation.
   */
export function extractVariableTypeAnnotation(this: TreeSitterState, node: SyntaxNode, nodeId: string): void {
  if (!this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) return;

  // Find type_annotation child (covers TS `: Type`, Rust `: Type`, etc.)
  const typeAnnotation = node.namedChildren.find(
    (c: SyntaxNode) => c.type === 'type_annotation'
  );
  if (typeAnnotation) {
    this.extractTypeRefsFromSubtree(typeAnnotation, nodeId);
  }
}

/**
   * Recursively walk a subtree and extract all type_identifier references.
   * Handles unions, intersections, generics, arrays, etc.
   */
export function extractTypeRefsFromSubtree(this: TreeSitterState, node: SyntaxNode, fromNodeId: string): void {
  if (node.type === 'type_identifier') {
    const typeName = getNodeText(node, this.source);
    if (typeName && !this.BUILTIN_TYPES.has(typeName)) {
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: typeName,
        referenceKind: 'references',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
    return; // type_identifier is a leaf
  }

  // Recurse into children (handles union_type, intersection_type, generic_type, etc.)
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) {
      this.extractTypeRefsFromSubtree(child, fromNodeId);
    }
  }
}
