import type { Node as SyntaxNode } from '../web-tree-sitter';
import { stripCppTemplateArgs } from './languages/c-cpp';
import { getChildByField, getNodeText } from './tree-sitter-helpers';
import type { TreeSitterState } from './tree-sitter-state';
import {
  scalaBaseTypeName
} from './tree-sitter-syntax';

/**
   * Extract inheritance relationships
   */
export function extractInheritance(this: TreeSitterState, node: SyntaxNode, classId: string): void {
  // Objective-C @interface MyClass : NSObject <ProtoA, ProtoB>
  if (node.type === 'class_interface') {
    const superclass = getChildByField(node, 'superclass');
    if (superclass) {
      const name = getNodeText(superclass, this.source);
      this.unresolvedReferences.push({
        fromNodeId: classId,
        referenceName: name,
        referenceKind: 'extends',
        line: superclass.startPosition.row + 1,
        column: superclass.startPosition.column,
      });
    }
    for (let j = 0; j < node.namedChildCount; j++) {
      const argList = node.namedChild(j);
      if (argList?.type !== 'parameterized_arguments') continue;
      for (let k = 0; k < argList.namedChildCount; k++) {
        const typeName = argList.namedChild(k);
        if (!typeName) continue;
        const typeId = typeName.namedChildren.find(
          (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'identifier'
        );
        if (!typeId) continue;
        const protocolName = getNodeText(typeId, this.source);
        this.unresolvedReferences.push({
          fromNodeId: classId,
          referenceName: protocolName,
          referenceKind: 'implements',
          line: typeId.startPosition.row + 1,
          column: typeId.startPosition.column,
        });
      }
    }
    return;
  }

  // Look for extends/implements clauses
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    if (
      child.type === 'extends_clause' ||
      child.type === 'superclass' ||
      child.type === 'base_clause' || // PHP class extends
      child.type === 'extends_interfaces' // Java interface extends
    ) {
      // Scala: `extends A[X] with B with C` packs EVERY supertype into the
      // one extends_clause (separated by `with`), each a `generic_type` /
      // `type_identifier` / `stable_type_identifier`. The generic path below
      // takes only namedChild(0) and keeps the full text (`A[X]`), so a
      // parameterized supertype — every typeclass in cats/algebra — never
      // matched and `with`-mixed traits past the first were dropped. Iterate
      // all supertypes and unwrap each to its base type name.
      if (this.language === 'scala') {
        for (const target of child.namedChildren) {
          const name = scalaBaseTypeName(target, this.source);
          if (name) {
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'extends',
              line: target.startPosition.row + 1,
              column: target.startPosition.column,
            });
          }
        }
        continue;
      }
      // Dart: `class C extends Base with M1, M2` — the `superclass` node holds
      // the extends type as a direct `type_identifier` AND a `mixins` child
      // listing the `with` mixins (and `class C with M` has ONLY mixins, no
      // extends type). The generic `namedChild(0)` path would read the
      // `mixins` node itself as the superclass and drop every mixin — yet
      // mixins are Dart's core composition mechanism (Flutter is built on
      // them). Emit `extends` for the base and `implements` for each mixin.
      if (this.language === 'dart' && child.type === 'superclass') {
        for (const t of child.namedChildren) {
          if (t.type === 'mixins') {
            for (const m of t.namedChildren) {
              if (m.type === 'type_identifier') {
                this.unresolvedReferences.push({
                  fromNodeId: classId,
                  referenceName: getNodeText(m, this.source),
                  referenceKind: 'implements',
                  line: m.startPosition.row + 1,
                  column: m.startPosition.column,
                });
              }
            }
          } else if (t.type === 'type_identifier') {
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: getNodeText(t, this.source),
              referenceKind: 'extends',
              line: t.startPosition.row + 1,
              column: t.startPosition.column,
            });
          }
        }
        continue;
      }
      // Extract parent class/interface names
      // Java uses type_list wrapper: superclass -> type_identifier, extends_interfaces -> type_list -> type_identifier
      const typeList = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_list');
      const targets = typeList ? typeList.namedChildren : [child.namedChild(0)];
      for (const target of targets) {
        if (target) {
          const name = getNodeText(target, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'extends',
            line: target.startPosition.row + 1,
            column: target.startPosition.column,
          });
        }
      }
    }

    // C++ base classes: `class Derived : public Base, private Other` →
    // base_class_clause holds access specifiers + base type(s). Emit an extends
    // ref per base type (skip the public/private/protected keywords). A
    // templated base (`Base<int>`, `ns::Tpl<int>`) arrives as a `template_type`
    // or a `qualified_identifier` wrapping one; strip the `<…>` args so the ref
    // matches the bare class the template was defined as — `Base`, `ns::Tpl` —
    // instead of never resolving (#1043).
    if (child.type === 'base_class_clause') {
      for (const t of child.namedChildren) {
        if (
          t.type === 'type_identifier' ||
          t.type === 'qualified_identifier' ||
          t.type === 'template_type'
        ) {
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: stripCppTemplateArgs(getNodeText(t, this.source)),
            referenceKind: 'extends',
            line: t.startPosition.row + 1,
            column: t.startPosition.column,
          });
        }
      }
    }

    if (
      child.type === 'implements_clause' ||
      child.type === 'class_interface_clause' ||
      child.type === 'super_interfaces' || // Java class implements
      child.type === 'interfaces' // Dart
    ) {
      // Extract implemented interfaces
      // Java uses type_list wrapper: super_interfaces -> type_list -> type_identifier
      const typeList = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_list');
      const targets = typeList ? typeList.namedChildren : child.namedChildren;
      for (const iface of targets) {
        if (iface) {
          const name = getNodeText(iface, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'implements',
            line: iface.startPosition.row + 1,
            column: iface.startPosition.column,
          });
        }
      }
    }

    // Python superclass list: `class Flask(Scaffold, Mixin):`
    // argument_list contains identifier children for each parent class
    if (child.type === 'argument_list' && node.type === 'class_definition') {
      for (const arg of child.namedChildren) {
        if (arg.type === 'identifier' || arg.type === 'attribute') {
          const name = getNodeText(arg, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'extends',
            line: arg.startPosition.row + 1,
            column: arg.startPosition.column,
          });
        }
      }
    }

    // Go interface embedding: `type Querier interface { LabelQuerier; ... }`
    // constraint_elem wraps the embedded interface type identifier
    if (child.type === 'constraint_elem') {
      const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      if (typeId) {
        const name = getNodeText(typeId, this.source);
        this.unresolvedReferences.push({
          fromNodeId: classId,
          referenceName: name,
          referenceKind: 'extends',
          line: typeId.startPosition.row + 1,
          column: typeId.startPosition.column,
        });
      }
    }

    // Go struct embedding: field_declaration without field_identifier
    // e.g. `type DB struct { *Head; Queryable }` — no field name means embedded type
    if (child.type === 'field_declaration') {
      const hasFieldIdentifier = child.namedChildren.some((c: SyntaxNode) => c.type === 'field_identifier');
      if (!hasFieldIdentifier) {
        const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
        if (typeId) {
          const name = getNodeText(typeId, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'extends',
            line: typeId.startPosition.row + 1,
            column: typeId.startPosition.column,
          });
        }
      }
    }

    // Rust trait supertraits: `trait SubTrait: SuperTrait + Display { ... }`
    // trait_bounds contains type_identifier, generic_type, or higher_ranked_trait_bound children
    if (child.type === 'trait_bounds') {
      for (const bound of child.namedChildren) {
        let typeName: string | undefined;
        let posNode: SyntaxNode | undefined;

        if (bound.type === 'type_identifier') {
          typeName = getNodeText(bound, this.source);
          posNode = bound;
        } else if (bound.type === 'generic_type') {
          // e.g. `Deserialize<'de>`
          const inner = bound.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
          if (inner) { typeName = getNodeText(inner, this.source); posNode = inner; }
        } else if (bound.type === 'higher_ranked_trait_bound') {
          // e.g. `for<'de> Deserialize<'de>`
          const generic = bound.namedChildren.find((c: SyntaxNode) => c.type === 'generic_type');
          const typeId = generic?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
            ?? bound.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
          if (typeId) { typeName = getNodeText(typeId, this.source); posNode = typeId; }
        }

        if (typeName && posNode) {
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: typeName,
            referenceKind: 'extends',
            line: posNode.startPosition.row + 1,
            column: posNode.startPosition.column,
          });
        }
      }
    }

    // VB.NET: `Inherits Base` / `Implements IFoo, IBar(Of T)` are STATEMENTS
    // inside the class body (children of the class node), not header clauses.
    // Each name is a simple/qualified/generic reference; generics unwrap to
    // the base identifier and dotted paths keep the trailing segment.
    if (
      this.language === 'vbnet' &&
      (child.type === 'inherits_statement' || child.type === 'implements_statement')
    ) {
      const kind = child.type === 'inherits_statement' ? 'extends' : 'implements';
      for (const ref of child.namedChildren) {
        if (!ref || (ref.type !== 'simple_name' && ref.type !== 'qualified_name' && ref.type !== 'generic_name' && ref.type !== 'global_qualified_name')) continue;
        let name = getNodeText(ref, this.source);
        name = name.replace(/\(\s*Of\b[^)]*\)/gi, '');
        const lastDot = name.lastIndexOf('.');
        if (lastDot >= 0) name = name.slice(lastDot + 1);
        name = name.trim();
        if (!name) continue;
        this.unresolvedReferences.push({
          fromNodeId: classId,
          referenceName: name,
          referenceKind: kind,
          line: ref.startPosition.row + 1,
          column: ref.startPosition.column,
        });
      }
    }

    // C#: `class Movie : BaseItem, IPlugin` → base_list with identifier children
    // base_list combines both base class and interfaces in a single colon-separated list.
    // We emit all as 'extends' since the syntax doesn't distinguish them.
    if (child.type === 'base_list') {
      for (const baseType of child.namedChildren) {
        if (baseType) {
          // For generic base types like `ClientBase<T>`, extract just the type name
          const name = baseType.type === 'generic_name'
            ? getNodeText(baseType.namedChildren.find((c: SyntaxNode) => c.type === 'identifier') ?? baseType, this.source)
            : getNodeText(baseType, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'extends',
            line: baseType.startPosition.row + 1,
            column: baseType.startPosition.column,
          });
        }
      }
    }

    // Kotlin: `class Foo : Bar, Baz` → delegation_specifier > user_type > type_identifier
    // Also handles `class Foo : Bar()` → delegation_specifier > constructor_invocation > user_type
    if (child.type === 'delegation_specifier') {
      const userType = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type');
      const constructorInvocation = child.namedChildren.find((c: SyntaxNode) => c.type === 'constructor_invocation');
      const target = userType ?? constructorInvocation;
      if (target) {
        const typeId = target.type === 'user_type'
          ? target.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier') ?? target
          : target.namedChildren.find((c: SyntaxNode) => c.type === 'user_type')?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
          ?? target.namedChildren.find((c: SyntaxNode) => c.type === 'user_type') ?? target;
        const name = getNodeText(typeId, this.source);
        this.unresolvedReferences.push({
          fromNodeId: classId,
          referenceName: name,
          referenceKind: 'extends',
          line: typeId.startPosition.row + 1,
          column: typeId.startPosition.column,
        });
      }
    }

    // Swift: inheritance_specifier > user_type > type_identifier
    // Used for class inheritance, protocol conformance, and protocol inheritance
    if (child.type === 'inheritance_specifier') {
      const userType = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type');
      const typeId = userType?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      if (typeId) {
        const name = getNodeText(typeId, this.source);
        this.unresolvedReferences.push({
          fromNodeId: classId,
          referenceName: name,
          referenceKind: 'extends',
          line: typeId.startPosition.row + 1,
          column: typeId.startPosition.column,
        });
      }
    }

    // JavaScript class_heritage has bare identifier without extends_clause wrapper
    // e.g. `class Foo extends Bar {}` → class_heritage → identifier("Bar")
    if (
      (child.type === 'identifier' || child.type === 'type_identifier') &&
      node.type === 'class_heritage'
    ) {
      const name = getNodeText(child, this.source);
      this.unresolvedReferences.push({
        fromNodeId: classId,
        referenceName: name,
        referenceKind: 'extends',
        line: child.startPosition.row + 1,
        column: child.startPosition.column,
      });
    }

    // Recurse into container nodes (e.g. field_declaration_list in Go structs,
    // class_heritage in TypeScript which wraps extends_clause/implements_clause)
    if (child.type === 'field_declaration_list' || child.type === 'class_heritage') {
      this.extractInheritance(child, classId);
    }

    // CFML cfscript `component extends="Base" implements="IFoo,IBar" { ... }`
    // (also covers `interface extends="IBase" { ... }`, which reuses the same
    // component_attribute shape). Attributes are generic name=value pairs —
    // (identifier label, expression value) — not a dedicated extends_clause,
    // so filter by the label text. `implements` is a comma-separated list.
    if (child.type === 'component_attribute' && node.type === 'component') {
      const label = child.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      const value = child.namedChildren.find((c: SyntaxNode) => c.type !== 'identifier');
      if (label && value) {
        const labelText = getNodeText(label, this.source).toLowerCase();
        if (labelText === 'extends' || labelText === 'implements') {
          const valueText = getNodeText(value, this.source).replace(/^["']|["']$/g, '');
          const names = labelText === 'implements'
            ? valueText.split(',').map((s) => s.trim()).filter(Boolean)
            : [valueText.trim()].filter(Boolean);
          for (const name of names) {
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: labelText === 'implements' ? 'implements' : 'extends',
              line: value.startPosition.row + 1,
              column: value.startPosition.column,
            });
          }
        }
      }
    }
  }
}

/**
   * Rust `impl Trait for Type` — creates an implements edge from Type to Trait.
   * For plain `impl Type { ... }` (no trait), no inheritance edge is needed.
   */
export function extractRustImplItem(this: TreeSitterState, node: SyntaxNode): void {
  // Check if this is `impl Trait for Type` by looking for a `for` keyword
  const hasFor = node.children.some(
    (c: SyntaxNode) => c.type === 'for' && !c.isNamed
  );
  if (!hasFor) return;

  // In `impl Trait for Type`, the type_identifiers are:
  // first = Trait name, last = implementing Type name
  // Also handle generic types like `impl<T> Trait for MyStruct<T>`
  const typeIdents = node.namedChildren.filter(
    (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'generic_type' || c.type === 'scoped_type_identifier'
  );
  if (typeIdents.length < 2) return;

  const traitNode = typeIdents[0]!;
  const typeNode = typeIdents[typeIdents.length - 1]!;

  // Get the trait name (handle scoped paths like std::fmt::Display)
  const traitName = traitNode.type === 'scoped_type_identifier'
    ? this.source.substring(traitNode.startIndex, traitNode.endIndex)
    : getNodeText(traitNode, this.source);

  // Get the implementing type name (extract inner type_identifier for generics)
  let typeName: string;
  if (typeNode.type === 'generic_type') {
    const inner = typeNode.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type_identifier'
    );
    typeName = inner ? getNodeText(inner, this.source) : getNodeText(typeNode, this.source);
  } else {
    typeName = getNodeText(typeNode, this.source);
  }

  // Find the struct/type node for the implementing type
  const typeNodeId = this.findNodeByName(typeName);
  if (typeNodeId) {
    this.unresolvedReferences.push({
      fromNodeId: typeNodeId,
      referenceName: traitName,
      referenceKind: 'implements',
      line: traitNode.startPosition.row + 1,
      column: traitNode.startPosition.column,
    });
  }
}
