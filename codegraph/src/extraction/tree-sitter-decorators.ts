import type { Node as SyntaxNode } from '../web-tree-sitter';
import { getChildByField, getNodeText } from './tree-sitter-helpers';
import type { TreeSitterState } from './tree-sitter-state';

/**
   * Scan `declNode` and its preceding siblings (within the parent's
   * named children) for decorator nodes, emitting a `decorates`
   * reference from `decoratedId` to each decorator's function name.
   *
   * Why preceding siblings: in TypeScript, `@Foo class Bar {}` parses
   * as an `export_statement` (or top-level wrapper) with the
   * `decorator` as a child *before* the `class_declaration` — so the
   * decorator isn't a child of the class itself. For methods/
   * properties, the decorator IS a direct child of the declaration,
   * so we also scan declNode.namedChildren.
   *
   * Idempotent across grammars: if neither location yields decorators
   * (most non-decorator-using languages), the function is a no-op.
   */
export function extractDecoratorsFor(this: TreeSitterState, declNode: SyntaxNode, decoratedId: string): void {
  const consider = (n: SyntaxNode | null): void => {
    if (!n) return;
    // Solidity `modifier_invocation` (unique to that grammar) sits
    // decorator-position in the function header — OUTSIDE the `body:` field
    // the call walker descends — but its body executes around the function
    // via `_;`, so it is a real call-flow hop (`withdraw → onlyOwner →
    // _checkRole` is the canonical audit trace). The same node type carries
    // base-constructor invocations (`constructor() ERC20("T","TOK")`), the
    // constructor-chain hop. Emit `calls`, not `decorates`, so flow
    // traversal rides it.
    if (n.type === 'modifier_invocation') {
      const target = n.namedChild(0);
      const name = target?.type === 'identifier' ? getNodeText(target, this.source) : undefined;
      if (name) {
        this.unresolvedReferences.push({
          fromNodeId: decoratedId,
          referenceName: name,
          referenceKind: 'calls',
          line: n.startPosition.row + 1,
          column: n.startPosition.column,
        });
      }
      return;
    }
    // `marker_annotation` is Java's grammar for arg-less annotations
    // (`@Override`, `@Deprecated`); `attribute` is Swift's grammar for
    // attributes and PROPERTY WRAPPERS (`@objc`, `@Argument`, `@Published`,
    // `@State`). Without these, those usages would be silently skipped.
    if (
      n.type !== 'decorator' &&
      n.type !== 'annotation' &&
      n.type !== 'marker_annotation' &&
      n.type !== 'attribute'
    ) {
      return;
    }
    // Find the leading identifier: skip the `@` punct, unwrap
    // a call_expression if the decorator is invoked with args.
    let target: SyntaxNode | null = null;
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (!child) continue;
      if (child.type === 'call_expression') {
        const fn = getChildByField(child, 'function') ?? child.namedChild(0);
        if (fn) target = fn;
        if (target) break;
      }
      if (
        child.type === 'identifier' ||
        child.type === 'member_expression' ||
        child.type === 'scoped_identifier' ||
        child.type === 'navigation_expression' ||
        child.type === 'user_type' ||      // swift attribute → user_type (`@Argument`)
        child.type === 'type_identifier'
      ) {
        target = child;
        break;
      }
    }
    if (!target) return;
    let name = getNodeText(target, this.source);
    const lt = name.indexOf('<'); // strip generic args: `@Argument<T>` → `Argument`
    if (lt > 0) name = name.slice(0, lt);
    const lastDot = Math.max(name.lastIndexOf('.'), name.lastIndexOf('::'));
    if (lastDot >= 0) name = name.slice(lastDot + 1).replace(/^[:.]/, '');
    name = name.trim();
    if (!name) return;
    this.unresolvedReferences.push({
      fromNodeId: decoratedId,
      referenceName: name,
      referenceKind: 'decorates',
      line: n.startPosition.row + 1,
      column: n.startPosition.column,
    });
  };

  // 1. Decorators that are direct children of the declaration
  //    (method/property style, also some grammars for class).
  for (let i = 0; i < declNode.namedChildCount; i++) {
    const child = declNode.namedChild(i);
    consider(child);
    // Java/Kotlin/C# put annotations INSIDE a `modifiers` node
    // (`@MyAnno public class X` → class_declaration → modifiers → annotation),
    // so descend into it — otherwise every annotation usage is silently
    // dropped and annotation types show zero dependents.
    if (child && child.type === 'modifiers') {
      for (let j = 0; j < child.namedChildCount; j++) {
        consider(child.namedChild(j));
      }
    }
  }

  // 2. Decorators that are PRECEDING siblings of the declaration
  //    inside the parent's children (TypeScript class style).
  //    Walk BACKWARDS from the declaration and stop at the first
  //    non-decorator sibling — without that stop, decorators
  //    belonging to an EARLIER unrelated declaration leak in
  //    (e.g. `@A class Foo {} @B class Bar {}` would otherwise
  //    attribute @A to Bar).
  //
  //    Note on identity: tree-sitter web bindings return fresh JS
  //    wrapper objects from `parent`/`namedChild` navigation, so
  //    `sibling === declNode` is unreliable — `startIndex` does
  //    the matching instead.
  const parent = declNode.parent;
  if (parent) {
    const declStart = declNode.startIndex;
    let declIdx = -1;
    for (let i = 0; i < parent.namedChildCount; i++) {
      const sibling = parent.namedChild(i);
      if (sibling && sibling.startIndex === declStart) {
        declIdx = i;
        break;
      }
    }
    if (declIdx > 0) {
      for (let j = declIdx - 1; j >= 0; j--) {
        const sibling = parent.namedChild(j);
        if (!sibling) continue;
        if (sibling.type !== 'decorator' && sibling.type !== 'annotation' && sibling.type !== 'marker_annotation') {
          break; // non-decorator separator → stop consuming
        }
        consider(sibling);
      }
    }
  }
}

/**
   * Visit function body and extract calls (and structural nodes).
   *
   * In addition to call expressions, this also detects class/struct/enum
   * definitions inside function bodies. This handles two cases:
   *   1. Local class/struct/enum definitions (valid in C++, Java, etc.)
   *   2. C++ macro misparsing — macros like NLOHMANN_JSON_NAMESPACE_BEGIN cause
   *      tree-sitter to interpret the namespace block as a function_definition,
   *      hiding real class/struct/enum nodes inside the "function body".
   */
/**
 * Rocket route-registration macros — `routes![a::b::handler, c::d::other]`
 * and `catchers![not_found]`. Tree-sitter leaves a macro body as a flat
 * `token_tree` of raw tokens (`identifier`, `::`, `,`), so the handler paths
 * are never seen as references and each handler fn looks like it has no caller
 * — it's mounted by Rocket at runtime, not called by in-repo code, so its file
 * shows 0 dependents. Walk the token tree, reconstruct each comma-separated
 * path, and emit a `references` edge; the Rust path resolver
 * (`resolveRustPathReference`) then links it to the handler fn. The handler
 * names are explicit in source, so this is precise static extraction, not a
 * heuristic — no false edges (resolution still validates each path).
 */
export function extractRustRouteMacro(this: TreeSitterState, node: SyntaxNode): void {
  if (this.language !== 'rust') return;
  const macroName = node.namedChild(0);
  if (!macroName) return;
  const name = getNodeText(macroName, this.source);
  if (name !== 'routes' && name !== 'catchers') return;
  const tokenTree = node.namedChildren.find((c: SyntaxNode) => c.type === 'token_tree');
  if (!tokenTree) return;
  const fromId = this.nodeStack[this.nodeStack.length - 1];
  if (!fromId) return;

  // The token tree is a flat stream: `[ id :: id :: id , id … ]`. Group runs
  // of `identifier` tokens (the `::` joiners are anonymous) into one path; a
  // `,` (or the closing `]`) ends a path.
  let parts: string[] = [];
  let line = 0;
  let column = 0;
  const flush = (): void => {
    if (parts.length > 0) {
      this.unresolvedReferences.push({
        fromNodeId: fromId,
        referenceName: parts.join('::'),
        referenceKind: 'references',
        line,
        column,
      });
      parts = [];
    }
  };
  for (let i = 0; i < tokenTree.childCount; i++) {
    const t = tokenTree.child(i);
    if (!t) continue;
    if (t.type === 'identifier') {
      if (parts.length === 0) {
        line = t.startPosition.row + 1;
        column = t.startPosition.column;
      }
      parts.push(getNodeText(t, this.source));
    } else if (t.type === ',') {
      flush();
    }
  }
  flush();
}
