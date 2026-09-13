import {
  Node,
  NodeKind
} from '../types';
import type { Node as SyntaxNode } from '../web-tree-sitter';
import { getChildByField, getNodeText, getPrecedingDocstring } from './tree-sitter-helpers';
import type { TreeSitterState } from './tree-sitter-state';
import {
  extractName
} from './tree-sitter-syntax';

/**
   * Extract a type alias (e.g. `export type X = ...` in TypeScript).
   * For languages like Go, resolveTypeAliasKind detects when the type_spec
   * wraps a struct or interface definition and creates the correct node kind.
   * Returns true if children should be skipped (struct/interface handled body visiting).
   */
export function extractTypeAlias(this: TreeSitterState, node: SyntaxNode): boolean {
  if (!this.extractor) return false;

  const name = extractName(node, this.source, this.extractor);
  if (name === '<anonymous>') return false;
  const docstring = getPrecedingDocstring(node, this.source);
  const isExported = this.extractor.isExported?.(node, this.source);

  // Check if this type alias is actually a struct or interface definition
  // (e.g. Go: `type Foo struct { ... }` is a type_spec wrapping struct_type)
  const resolvedKind = this.extractor.resolveTypeAliasKind?.(node, this.source);

  if (resolvedKind === 'struct') {
    const structNode = this.createNode('struct', name, node, { docstring, isExported });
    if (!structNode) return true;
    // Visit body children for field extraction
    this.nodeStack.push(structNode.id);
    // Try Go-style 'type' field first, then find inner struct child (C typedef struct)
    const typeChild = getChildByField(node, 'type')
      || this.findChildByTypes(node, this.extractor.structTypes);
    if (typeChild) {
      // Extract struct embedding (e.g. Go: `type DB struct { *Head; Queryable }`)
      this.extractInheritance(typeChild, structNode.id);
      const body = getChildByField(typeChild, this.extractor.bodyField) || typeChild;
      for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i);
        if (child) this.visitNode(child);
      }
    }
    this.nodeStack.pop();
    return true;
  }

  if (resolvedKind === 'enum') {
    const enumNode = this.createNode('enum', name, node, { docstring, isExported });
    if (!enumNode) return true;
    this.nodeStack.push(enumNode.id);
    // Find the inner enum type child (e.g. C: typedef enum { ... } name)
    const innerEnum = this.findChildByTypes(node, this.extractor.enumTypes);
    if (innerEnum) {
      this.extractInheritance(innerEnum, enumNode.id);
      const body = this.extractor.resolveBody?.(innerEnum, this.extractor.bodyField)
        ?? getChildByField(innerEnum, this.extractor.bodyField);
      if (body) {
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
      }
    }
    this.nodeStack.pop();
    return true;
  }

  if (resolvedKind === 'interface') {
    const kind: NodeKind = this.extractor.interfaceKind ?? 'interface';
    const interfaceNode = this.createNode(kind, name, node, { docstring, isExported });
    if (!interfaceNode) return true;
    // Extract interface inheritance from the inner type node
    const typeChild = getChildByField(node, 'type');
    if (typeChild) this.extractInheritance(typeChild, interfaceNode.id);
    // Go: extract the interface's method specs as `method` nodes so implicit
    // interface satisfaction (a struct's method set ⊇ the interface's) and
    // impl-navigation can see the contract. Go has no `implements` keyword, so
    // without the interface's method set there's nothing to match against.
    if (this.language === 'go' && typeChild) {
      this.extractGoInterfaceMethods(typeChild, interfaceNode.id);
    }
    return true;
  }

  const typeAliasNode = this.createNode('type_alias', name, node, {
    docstring,
    isExported,
  });

  // Extract type references from the alias value (e.g., `type X = ITextModel | null`)
  if (typeAliasNode && this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) {
    // The value is everything after the `=`, which is typically the last named child
    // In tree-sitter TS: type_alias_declaration has name + value children
    const value = getChildByField(node, 'value');
    if (value) {
      this.extractTypeRefsFromSubtree(value, typeAliasNode.id);
      // `type X = { foo: T; bar(): T }` — make the members first-class
      // property/method nodes under the type alias so `recorder.stop()`
      // can attach the call edge to `RecorderHandle.stop` instead of
      // an unrelated class method picked by path-proximity (#359).
      if (this.language === 'typescript' || this.language === 'tsx' || this.language === 'arkts') {
        this.extractTsTypeAliasMembers(value, typeAliasNode);
        // `type List = [ Service<'name', Req, Resp>, … ]` — surface each
        // entry's string-literal name as a searchable member (issue #634).
        this.extractTsTupleContractNames(value, typeAliasNode);
      }
    }
  }
  return false;
}

/**
   * Extract the method specs of a Go `interface_type` body as `method` nodes
   * contained by the interface (e.g. `Marshal`, `Unmarshal` of a `Core`
   * interface). tree-sitter-go names these `method_elem` (newer) or
   * `method_spec` (older). Embedded interfaces (`Reader` inside `ReadWriter`)
   * are `type_identifier`s, not methods, and are left to inheritance extraction.
   */
export function extractGoInterfaceMethods(this: TreeSitterState, interfaceType: SyntaxNode, ifaceId: string): void {
  this.nodeStack.push(ifaceId);
  for (let i = 0; i < interfaceType.namedChildCount; i++) {
    const m = interfaceType.namedChild(i);
    if (!m || (m.type !== 'method_elem' && m.type !== 'method_spec')) continue;
    const nameNode = getChildByField(m, 'name') ?? m.namedChild(0);
    if (!nameNode) continue;
    const mname = getNodeText(nameNode, this.source);
    if (mname) {
      this.createNode('method', mname, m, {
        signature: this.extractor?.getSignature?.(m, this.source),
      });
    }
  }
  this.nodeStack.pop();
}

/**
   * Surface the members of a TypeScript `type X = { ... }` (or intersection
   * thereof) as `property` / `method` nodes under the type-alias node. Only
   * walks the immediate object_type / intersection operands so anonymous
   * nested object types inside generic arguments (`Promise<{ ok: true }>`)
   * don't produce phantom members.
   */
export function extractTsTypeAliasMembers(this: TreeSitterState, value: SyntaxNode, typeAliasNode: Node): void {
  const objectTypes: SyntaxNode[] = [];
  if (value.type === 'object_type') {
    objectTypes.push(value);
  } else if (value.type === 'intersection_type') {
    for (let i = 0; i < value.namedChildCount; i++) {
      const op = value.namedChild(i);
      if (op && op.type === 'object_type') objectTypes.push(op);
    }
  } else {
    return;
  }

  this.nodeStack.push(typeAliasNode.id);
  for (const objType of objectTypes) {
    for (let i = 0; i < objType.namedChildCount; i++) {
      const child = objType.namedChild(i);
      if (!child) continue;
      if (child.type !== 'property_signature' && child.type !== 'method_signature') continue;

      const nameNode = getChildByField(child, 'name');
      const memberName = nameNode ? getNodeText(nameNode, this.source) : '';
      if (!memberName) continue;

      // `foo: () => T` and `foo(): T` are functionally a method on the
      // type contract. Treat the property_signature with a function-typed
      // annotation as a method too so call sites can resolve to it.
      const memberKind: NodeKind = child.type === 'method_signature'
        ? 'method'
        : this.isTsFunctionTypedProperty(child) ? 'method' : 'property';

      const docstring = getPrecedingDocstring(child, this.source);
      const signature = getNodeText(child, this.source);
      this.createNode(memberKind, memberName, child, {
        docstring,
        signature,
        qualifiedName: `${typeAliasNode.name}::${memberName}`,
      });

      // Emit `references` edges from the type alias to types named in the
      // member's signature, matching the interface-member behavior added in
      // #432. We attach refs to the type-alias parent (consistent with
      // interface property_signature treatment).
      this.extractTypeAnnotations(child, typeAliasNode.id);
    }
  }
  this.nodeStack.pop();
}

/**
   * Surface the string-literal "names" of a TypeScript service/contract
   * registry written as a tuple of generic instantiations:
   *
   *   type MyServiceList = [
   *     Service<'query_apply_record', Req, Resp>,
   *     Service<'apply_confirm', Req, Resp>,
   *   ];
   *
   * Each `Service<'name', …>` tags an entry with a string-literal name that a
   * dynamic factory (`createService<MyServiceList>()`) turns into a callable
   * property (`api.query_apply_record(…)`). Static extraction otherwise never
   * sees that name — it's a type argument, not a declaration — so
   * `codegraph query query_apply_record` returned nothing (issue #634). We emit
   * each name as a `method` node under the type alias (qualifiedName
   * `MyServiceList::query_apply_record`) so it's searchable and resolvable as a
   * symbol. (A call through the proxy, `api.query_apply_record(…)`, still
   * resolves to the imported `api` binding — the receiver's type isn't known —
   * so this fixes discoverability, not the per-method call edge.)
   *
   * Scope is deliberately narrow to avoid noise: only a string literal that is
   * a DIRECT type argument of a `generic_type` that is itself a DIRECT element
   * of a `tuple_type`. This excludes utility types (`Pick`/`Omit`/`Record` are
   * never written as tuples) and string args nested deeper
   * (`Service<'a', Pick<U, 'id'>>` yields only `a`, never `id`). Names must be
   * valid identifiers, which also rules out route paths / arbitrary strings.
   */
export function extractTsTupleContractNames(this: TreeSitterState, value: SyntaxNode, typeAliasNode: Node): void {
  const tuples: SyntaxNode[] = [];
  const collectTuples = (n: SyntaxNode, depth: number): void => {
    if (depth > 6) return; // a type expression is shallow; cap defensively
    if (n.type === 'tuple_type') tuples.push(n);
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) collectTuples(c, depth + 1);
    }
  };
  collectTuples(value, 0);
  if (tuples.length === 0) return;

  this.nodeStack.push(typeAliasNode.id);
  for (const tuple of tuples) {
    for (let i = 0; i < tuple.namedChildCount; i++) {
      const entry = tuple.namedChild(i);
      if (!entry || entry.type !== 'generic_type') continue;
      const typeArgs = getChildByField(entry, 'type_arguments');
      if (!typeArgs) continue;
      for (let j = 0; j < typeArgs.namedChildCount; j++) {
        const arg = typeArgs.namedChild(j);
        if (!arg || arg.type !== 'literal_type') continue;
        // literal_type wraps the actual literal; only a string is a name.
        const strNode = arg.namedChild(0);
        if (!strNode || strNode.type !== 'string') continue;
        const name = getNodeText(strNode, this.source)
          .trim()
          .replace(/^['"`]/, '')
          .replace(/['"`]$/, '');
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) continue;
        const signature = getNodeText(entry, this.source).replace(/\s+/g, ' ').trim().slice(0, 120);
        this.createNode('method', name, entry, {
          signature,
          qualifiedName: `${typeAliasNode.name}::${name}`,
        });
      }
    }
  }
  this.nodeStack.pop();
}

/**
   * `foo: () => T` → property_signature whose type_annotation contains a
   * `function_type`. Treat that as a method-shaped contract member, since
   * the call site `obj.foo()` has identical semantics to `bar(): T`.
   */
export function isTsFunctionTypedProperty(this: TreeSitterState, propertySignature: SyntaxNode): boolean {
  const typeAnno = getChildByField(propertySignature, 'type');
  if (!typeAnno) return false;
  for (let i = 0; i < typeAnno.namedChildCount; i++) {
    const inner = typeAnno.namedChild(i);
    if (inner && inner.type === 'function_type') return true;
  }
  return false;
}
