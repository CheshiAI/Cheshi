import * as path from 'path';
import type { Node as SyntaxNode } from '../web-tree-sitter';
import { getChildByField, getNodeText } from './tree-sitter-helpers';
import type { TreeSitterState } from './tree-sitter-state';

// extractExportedVariables removed — the walker now descends into
// export_statement children and the inner declaration's dedicated
// extractor (extractVariable, extractFunction, extractClass, etc.)
// handles the symbol with isExported=true via parent-walk in the
// language extractor's isExported predicate.

/**
 * Extract an import
 *
 * Creates an import node with the full import statement stored in signature for searchability.
 * Also creates unresolved references for resolution purposes.
 */
export function extractImport(this: TreeSitterState, node: SyntaxNode): void {
  if (!this.extractor) return;

  const importText = getNodeText(node, this.source).trim();

  // Try language-specific hook first
  if (this.extractor.extractImport) {
    const info = this.extractor.extractImport(node, this.source);
    if (info) {
      this.createNode('import', info.moduleName, node, {
        signature: info.signature,
      });
      // Create unresolved reference unless the hook handled it
      if (!info.handledRefs && info.moduleName && this.nodeStack.length > 0) {
        const parentId = this.nodeStack[this.nodeStack.length - 1];
        if (parentId) {
          this.unresolvedReferences.push({
            fromNodeId: parentId,
            referenceName: info.moduleName,
            referenceKind: 'imports',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
      }
      // Link each imported binding to its definition so imported-but-not-
      // called/typed symbols still record a cross-file dependency (TS/JS only).
      if (
        this.language === 'typescript' || this.language === 'tsx' ||
        this.language === 'javascript' || this.language === 'jsx' ||
        this.language === 'arkts'
      ) {
        const parentId = this.nodeStack[this.nodeStack.length - 1];
        if (parentId) this.emitImportBindingRefs(node, parentId);
      }
      // Python `from module import X, Y` — link each imported name to its
      // definition (covers `__init__.py` re-export barrels, which are just
      // `from .sub import X`). Same recall gap as TS: a name imported and
      // used in a non-call position created no dependency edge.
      if (this.language === 'python' && node.type === 'import_from_statement') {
        const parentId = this.nodeStack[this.nodeStack.length - 1];
        if (parentId) this.emitPyFromImportRefs(node, parentId);
      }
      // Rust `use crate::m::Item;` / `pub use self::sub::Item;` — link each
      // imported leaf to its definition. Covers `pub use` re-export hubs
      // (a `mod.rs` re-exporting submodule items, e.g. tokio's `fs/mod.rs`)
      // and items imported but used in non-call/non-type positions.
      if (this.language === 'rust' && node.type === 'use_declaration') {
        const parentId = this.nodeStack[this.nodeStack.length - 1];
        if (parentId) this.emitRustUseBindingRefs(node, parentId);
      }
      // PHP `use Foo\Bar\Baz;` — link to the namespace-qualified definition so
      // an imported-but-DI-injected contract (Laravel's pattern) records a
      // cross-file dependency. Grouped imports are handled in their own branch.
      if (this.language === 'php' && node.type === 'namespace_use_declaration') {
        const parentId = this.nodeStack[this.nodeStack.length - 1];
        if (parentId) this.emitPhpUseRefs(node, parentId);
      }
      // Ruby `require "lib/foo"` / `require_relative "../foo"` — resolve to the
      // required FILE so a file pulled in only by `require` (config-loaded
      // components, gems that don't autoload) records a cross-file dependency.
      if (this.language === 'ruby' && node.type === 'call') {
        const parentId = this.nodeStack[this.nodeStack.length - 1];
        if (parentId) this.emitRubyRequireRefs(node, parentId);
      }
      return;
    }
    // Hook returned null — fall through to multi-import inline handlers only
    // (hook returning null means "I didn't handle this" for multi-import cases,
    // NOT "use generic fallback" — the hook already declined)
  }

  // Multi-import cases that create multiple nodes (can't be expressed with single-return hook)

  // Python import_statement: import os, sys (creates one import per module)
  if (this.language === 'python' && node.type === 'import_statement') {
    const importParentId = this.nodeStack[this.nodeStack.length - 1];
    // A bare `import a.b.c` of an internal module (the standard Django
    // `AppConfig.ready(): import myapp.signals` registration pattern, and any
    // `import pkg.mod` used for its side effects) had no edge to the module
    // file — only `from x import y` was linked. Push an `imports` ref (like
    // Go) so the resolver maps the dotted path to its file. Stdlib/external
    // modules naturally don't resolve (no `os.py` file node in the repo).
    const pushModuleRef = (dotted: SyntaxNode): void => {
      if (!importParentId) return;
      this.unresolvedReferences.push({
        fromNodeId: importParentId,
        referenceName: getNodeText(dotted, this.source),
        referenceKind: 'imports',
        line: dotted.startPosition.row + 1,
        column: dotted.startPosition.column,
      });
    };
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'dotted_name') {
        this.createNode('import', getNodeText(child, this.source), node, {
          signature: importText,
        });
        pushModuleRef(child);
      } else if (child?.type === 'aliased_import') {
        const dottedName = child.namedChildren.find(c => c.type === 'dotted_name');
        if (dottedName) {
          this.createNode('import', getNodeText(dottedName, this.source), node, {
            signature: importText,
          });
          pushModuleRef(dottedName);
        }
      }
    }
    return;
  }

  // Go imports: single or grouped (creates one import per spec)
  if (this.language === 'go') {
    const parentId = this.nodeStack.length > 0 ? this.nodeStack[this.nodeStack.length - 1] : null;
    const extractFromSpec = (spec: SyntaxNode): void => {
      const stringLiteral = spec.namedChildren.find(c => c.type === 'interpreted_string_literal');
      if (stringLiteral) {
        const importPath = getNodeText(stringLiteral, this.source).replace(/['"]/g, '');
        if (importPath) {
          this.createNode('import', importPath, spec, {
            signature: getNodeText(spec, this.source).trim(),
          });
          // Create unresolved reference so the resolver can create imports edges
          if (parentId) {
            this.unresolvedReferences.push({
              fromNodeId: parentId,
              referenceName: importPath,
              referenceKind: 'imports',
              line: spec.startPosition.row + 1,
              column: spec.startPosition.column,
            });
          }
        }
      }
    };

    const importSpecList = node.namedChildren.find(c => c.type === 'import_spec_list');
    if (importSpecList) {
      for (const spec of importSpecList.namedChildren.filter(c => c.type === 'import_spec')) {
        extractFromSpec(spec);
      }
    } else {
      const importSpec = node.namedChildren.find(c => c.type === 'import_spec');
      if (importSpec) {
        extractFromSpec(importSpec);
      }
    }
    return;
  }

  // PHP grouped imports: use X\{A, B} (creates one import per item)
  if (this.language === 'php') {
    const namespacePrefix = node.namedChildren.find(c => c.type === 'namespace_name');
    const useGroup = node.namedChildren.find(c => c.type === 'namespace_use_group');
    if (namespacePrefix && useGroup) {
      const prefix = getNodeText(namespacePrefix, this.source);
      const useClauses = useGroup.namedChildren.filter((c: SyntaxNode) =>
        c.type === 'namespace_use_group_clause' || c.type === 'namespace_use_clause'
      );
      for (const clause of useClauses) {
        const nsName = clause.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_name');
        const name = nsName
          ? nsName.namedChildren.find((c: SyntaxNode) => c.type === 'name')
          : clause.namedChildren.find((c: SyntaxNode) => c.type === 'name');
        if (name) {
          const fullPath = `${prefix}\\${getNodeText(name, this.source)}`;
          this.createNode('import', fullPath, node, {
            signature: importText,
          });
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) this.pushPhpUseRef(fullPath, parentId, node);
        }
      }
      return;
    }
  }

  // If a hook exists but returned null, it intentionally declined this node — don't create fallback
  if (this.extractor.extractImport) return;

  // Generic fallback for languages without hooks
  this.createNode('import', importText, node, {
    signature: importText,
  });
}

/**
   * Emit one `imports` reference per named/default import binding (TS/JS family),
   * attributed to the file node — so the resolver links each imported symbol to
   * the file that DEFINES it.
   *
   * Importing a symbol IS a dependency, but extraction only emits references for
   * calls, instantiations, type annotations, and inheritance. A symbol that's
   * imported and then only re-exported (`export { X } from './x'`), placed in a
   * registry array (`[expressResolver, …]`), passed as an argument, or used in
   * JSX produced NO cross-file edge at all — so the providing file showed a
   * false "0 dependents" and was invisible to blast-radius / `affected`. The
   * resolver maps the local name (alias-aware) to the provider's definition and
   * creates a cross-file `imports` edge; `getFileDependents` picks it up, while
   * `getImpactRadius` keeps it as a bounded leaf (the importing file node).
   *
   * Namespace imports (`import * as NS`) bind a whole module: `NS.member` calls
   * resolve on their own, but a namespace used ONLY via a value-member read
   * (`NS.SOME_CONST`) would leave no edge — so we also emit the namespace local
   * name, which the resolver links to the module FILE as a dependency backstop.
   */
export function emitImportBindingRefs(this: TreeSitterState, node: SyntaxNode, fromNodeId: string): void {
  const clause = node.namedChildren.find((c) => c.type === 'import_clause');
  if (!clause) return; // side-effect import (`import './x'`) — no bindings

  const pushRef = (nameNode: SyntaxNode | null | undefined): void => {
    if (!nameNode) return;
    const name = getNodeText(nameNode, this.source);
    if (!name) return;
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName: name,
      referenceKind: 'imports',
      line: nameNode.startPosition.row + 1,
      column: nameNode.startPosition.column,
    });
  };

  for (const child of clause.namedChildren) {
    if (child.type === 'identifier') {
      // default import: `import Foo from './x'`
      pushRef(child);
    } else if (child.type === 'named_imports') {
      // `import { A, B as C } from './x'` — link the LOCAL name (alias if any)
      for (const spec of child.namedChildren) {
        if (spec.type !== 'import_specifier') continue;
        pushRef(getChildByField(spec, 'alias') ?? getChildByField(spec, 'name') ?? spec.namedChild(0));
      }
    } else if (child.type === 'namespace_import') {
      // `import * as NS from './x'` — emit NS so the module-import backstop can
      // record the file dependency even if NS is only used by value-member read.
      pushRef(child.namedChildren.find((c) => c.type === 'identifier') ?? child.namedChild(0));
    }
  }
}

/**
   * Emit one `imports` reference per re-exported binding of a
   * `export { A, B as C } from './y'` statement, attributed to the file node —
   * so a barrel that re-exports from another module records a dependency on it.
   *
   * Links the SOURCE-side name (`A`, the `name` field — not the local alias
   * `C`), since that is what the source module defines. `export * from './y'`
   * has no named bindings to attribute and `export { default as X }` can't be
   * name-matched, so both are skipped.
   */
export function emitReExportRefs(this: TreeSitterState, node: SyntaxNode, fromNodeId: string): void {
  const clause = node.namedChildren.find((c) => c.type === 'export_clause');
  if (!clause) return; // `export * from './y'` — no named bindings
  for (const spec of clause.namedChildren) {
    if (spec.type !== 'export_specifier') continue;
    const nameNode = getChildByField(spec, 'name') ?? spec.namedChild(0);
    if (!nameNode) continue;
    const name = getNodeText(nameNode, this.source);
    if (!name || name === 'default') continue;
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName: name,
      referenceKind: 'imports',
      line: nameNode.startPosition.row + 1,
      column: nameNode.startPosition.column,
    });
  }
}

/**
   * Emit one `imports` reference per binding of a Rust `use` declaration —
   * `use crate::m::Item`, `use crate::m::{A, B as C}`, `pub use self::sub::Item`.
   * Emits the FULL path (e.g. `self::sub::Item`, not just `Item`) so the resolver
   * can resolve the module prefix to a file and find the leaf symbol there —
   * disambiguating common-name re-exports (`pub use self::read::read`, where the
   * leaf `read` collides with many same-named symbols). Falls back to name-match
   * on the leaf when the path can't be resolved. `use ...::*` has no leaf binding.
   */
export function emitRustUseBindingRefs(this: TreeSitterState, node: SyntaxNode, fromNodeId: string): void {
  const paths: { text: string; node: SyntaxNode }[] = [];
  const join = (prefix: string, seg: string): string => (prefix ? `${prefix}::${seg}` : seg);
  const collect = (n: SyntaxNode, prefix: string): void => {
    switch (n.type) {
      case 'identifier':
        paths.push({ text: join(prefix, getNodeText(n, this.source)), node: n });
        break;
      case 'scoped_identifier': {
        // Full scoped path (`a::b::C`); combine with any outer group prefix.
        const full = getNodeText(n, this.source).trim();
        paths.push({ text: prefix ? `${prefix}::${full}` : full, node: n });
        break;
      }
      case 'scoped_use_list': {
        // `path::{ ... }` — the group's path becomes the prefix for each item.
        const pathNode = getChildByField(n, 'path');
        const seg = pathNode ? getNodeText(pathNode, this.source).trim() : '';
        const newPrefix = seg ? join(prefix, seg) : prefix;
        const list = getChildByField(n, 'list') ?? n.namedChildren.find((c) => c.type === 'use_list');
        if (list) collect(list, newPrefix);
        break;
      }
      case 'use_list':
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i);
          if (c) collect(c, prefix);
        }
        break;
      case 'use_as_clause': {
        // `Path as Alias` → link the source path (the definition), not the alias.
        const p = getChildByField(n, 'path') ?? n.namedChild(0);
        if (p) collect(p, prefix);
        break;
      }
      // use_wildcard → no specific binding to link.
    }
  };
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) collect(c, '');
  }
  for (const p of paths) {
    // The leaf must be a real name (skip a path that is only `self`/`super`/`crate`).
    const leaf = p.text.split('::').pop();
    if (!leaf || leaf === 'self' || leaf === 'super' || leaf === 'crate' || leaf === '*') continue;
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName: p.text,
      referenceKind: 'imports',
      line: p.node.startPosition.row + 1,
      column: p.node.startPosition.column,
    });
  }
}

/**
   * Emit an `imports` reference for a single PHP `use Foo\Bar\Baz;` (grouped
   * imports `use Foo\{A, B}` are handled where their per-item nodes are created).
   * The reference targets the namespace-qualified `Foo\Bar::Baz` form classes are
   * stored under (see the PHP `namespace` capture), so it resolves to the RIGHT
   * definition — Laravel has many same-named contracts (`Factory`, `Dispatcher`,
   * `Guard`) across namespaces that a bare-name match can't disambiguate.
   */
export function emitPhpUseRefs(this: TreeSitterState, node: SyntaxNode, fromNodeId: string): void {
  const clause = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_use_clause');
  if (!clause) return;
  const qn = clause.namedChildren.find((c: SyntaxNode) => c.type === 'qualified_name')
    ?? clause.namedChildren.find((c: SyntaxNode) => c.type === 'name');
  if (qn) this.pushPhpUseRef(getNodeText(qn, this.source), fromNodeId, node);
}

/**
   * Ruby `require`/`require_relative` → an `imports` ref to the required FILE.
   * `require "sidekiq/fetch"` is load-path-relative (matched by file-path suffix
   * via {@link matchByFilePath}); `require_relative "../foo"` is resolved against
   * this file's directory. Bare gem/stdlib requires (`require "json"`, no slash)
   * are skipped — they're external. The path form (a `/` + `.rb`) makes the ref
   * resolve to the file node, so a file pulled in only by `require` — not by a
   * resolved constant/call — still records a cross-file dependency.
   */
export function emitRubyRequireRefs(this: TreeSitterState, node: SyntaxNode, fromNodeId: string): void {
  const method = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
  const mname = method ? getNodeText(method, this.source) : '';
  if (mname !== 'require' && mname !== 'require_relative') return;
  const argList = node.namedChildren.find((c: SyntaxNode) => c.type === 'argument_list');
  const str = argList?.namedChildren.find((c: SyntaxNode) => c.type === 'string');
  const content = str?.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
  if (!content) return;
  const req = getNodeText(content, this.source).trim();
  if (!req) return;

  let refPath: string;
  if (mname === 'require_relative') {
    const slash = this.filePath.lastIndexOf('/');
    const dir = slash >= 0 ? this.filePath.slice(0, slash) : '';
    refPath = path.posix.normalize(dir ? `${dir}/${req}` : req);
  } else {
    refPath = req; // load-path require — suffix-matched against the file path
  }
  if (!refPath.includes('/')) return; // bare gem/stdlib require — external
  if (!refPath.endsWith('.rb')) refPath += '.rb';
  this.unresolvedReferences.push({
    fromNodeId,
    referenceName: refPath,
    referenceKind: 'imports',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/** Convert a PHP FQN `Foo\Bar\Baz` to the stored `Foo\Bar::Baz` and emit an `imports` ref. */
export function pushPhpUseRef(this: TreeSitterState, fqn: string, fromNodeId: string, node: SyntaxNode): void {
  const clean = fqn.replace(/^\\/, '');
  const lastSep = clean.lastIndexOf('\\');
  if (lastSep < 0) return; // global-namespace class — already matches by simple name
  this.unresolvedReferences.push({
    fromNodeId,
    referenceName: `${clean.slice(0, lastSep)}::${clean.slice(lastSep + 1)}`,
    referenceKind: 'imports',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/**
   * Emit one `imports` reference per name imported in a Python
   * `from module import A, B as C` statement, attributed to the file node — so
   * the resolver links each imported name to the module that DEFINES it.
   *
   * Same recall gap as TS: extraction only emitted references for calls,
   * instantiations, and inheritance, so a name imported and then used in a
   * non-call position (a list/dict literal, a default argument, a decorator
   * target, or simply re-exported through an `__init__.py` barrel) produced no
   * cross-file edge — the providing module showed a false "0 dependents". Links
   * the LOCAL name (alias when present, since that's what the resolver's import
   * mapping keys on); `from module import *` has no names to attribute.
   */
export function emitPyFromImportRefs(this: TreeSitterState, node: SyntaxNode, fromNodeId: string): void {
  const moduleNameNode = getChildByField(node, 'module_name');
  for (const child of node.namedChildren) {
    // Skip the `from <module>` part itself and `import *`.
    if (moduleNameNode &&
      child.startIndex === moduleNameNode.startIndex &&
      child.endIndex === moduleNameNode.endIndex) continue;
    if (child.type === 'wildcard_import') continue;

    let nameNode: SyntaxNode | null | undefined = null;
    if (child.type === 'aliased_import') {
      nameNode = getChildByField(child, 'alias') ?? getChildByField(child, 'name') ?? child.namedChild(0);
    } else if (child.type === 'dotted_name') {
      nameNode = child;
    }
    if (!nameNode) continue;

    const raw = getNodeText(nameNode, this.source);
    // Imported names are simple identifiers; defensively take the last segment.
    const local = raw.includes('.') ? raw.split('.').pop()! : raw;
    if (!local) continue;
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName: local,
      referenceKind: 'imports',
      line: nameNode.startPosition.row + 1,
      column: nameNode.startPosition.column,
    });
  }
}
