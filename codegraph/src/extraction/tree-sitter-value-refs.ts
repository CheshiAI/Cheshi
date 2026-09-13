import {
  NodeKind
} from '../types';
import type { Node as SyntaxNode } from '../web-tree-sitter';
import { captureFnRefCandidates } from './function-ref';
import { isGeneratedFile } from './generated-detection';
import { getChildByField, getNodeText } from './tree-sitter-helpers';
import type { TreeSitterState } from './tree-sitter-state';
import { MAX_VALUE_REF_NODES, VALUE_REF_LANGS } from './tree-sitter-state-constants';
import {
  cDeclaratorIdentifier,
  firstSimpleIdentifier
} from './tree-sitter-syntax';

/**
   * Function-as-value capture (#756): if this node is one of the language's
   * value-position containers (call arguments, assignment RHS, struct/object
   * initializer, array/table literal), collect candidate function names from
   * it. Candidates are gated & flushed at end-of-file (flushFnRefCandidates).
   */
export function maybeCaptureFnRefs(this: TreeSitterState, node: SyntaxNode, nodeType: string): void {
  const spec = this.fnRefSpec;
  if (!spec) return;
  const rule = spec.dispatch.get(nodeType);
  if (!rule || this.nodeStack.length === 0) return;
  const fromNodeId = this.nodeStack[this.nodeStack.length - 1];
  if (!fromNodeId) return;
  for (const cand of captureFnRefCandidates(node, rule, spec, this.source)) {
    this.fnRefCandidates.push({ ...cand, fromNodeId });
  }
}

/**
   * Candidates-only scan of a subtree the main walkers won't traverse
   * (top-level variable initializers). No extraction side effects. Halts at
   * nested function definitions: their bodies are walked — and their
   * candidates attributed — by extractFunction's own body walk.
   */
export function scanFnRefSubtree(this: TreeSitterState, node: SyntaxNode, depth: number): void {
  if (!this.fnRefSpec || depth > 12) return;
  const nodeType = node.type;
  if (depth > 0 && (
    this.extractor?.functionTypes.includes(nodeType) ||
    nodeType === 'arrow_function' ||
    nodeType === 'function_expression' ||
    nodeType === 'lambda_literal' ||
    nodeType === 'lambda_expression'
  )) {
    return;
  }
  this.maybeCaptureFnRefs(node, nodeType);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) this.scanFnRefSubtree(child, depth + 1);
  }
}

/**
   * Gate captured function-as-value candidates and push survivors as
   * `function_ref` unresolved references.
   *
   * The gate bounds volume and protects precision: a candidate survives only
   * if its name matches a function/method DEFINED IN THIS FILE or a name this
   * file imports/references. Everything else (locals, params, fields passed
   * as arguments) is dropped before it ever reaches the database. Resolution
   * then matches survivors against function/method nodes only
   * (matchFunctionRef) and emits `references` edges — which callers/impact
   * already traverse.
   *
   * Known v1 limit, deliberate: a C/C++ callback registered in a DIFFERENT
   * translation unit than its definition (extern, no symbol imports to match)
   * is not captured. Same-file registration — the dominant C pattern (static
   * callback + same-file ops struct) — is.
   */
export function flushFnRefCandidates(this: TreeSitterState): void {
  if (this.fnRefCandidates.length === 0) return;
  const candidates = this.fnRefCandidates;
  this.fnRefCandidates = [];

  // Generated/minified files (vendored jquery.min.js and friends): their
  // function-as-value edges are noise — single-letter minified symbols
  // resolve everywhere. Same policy as the callback synthesizer.
  if (isGeneratedFile(this.filePath)) return;

  const definedHere = new Set<string>();
  for (const n of this.nodes) {
    if (n.kind === 'function' || n.kind === 'method') definedHere.add(n.name);
    // Python only (#1478): class-as-value is a first-class idiom (DRF
    // get_serializer_class, Meta.model, registry dicts), so same-file CLASS
    // names pass the gate too. Other languages keep the function/method
    // gate — TS/JS recover class references through type annotations, and
    // resolution's kind filter would drop their class candidates anyway.
    else if (this.language === 'python' && n.kind === 'class') definedHere.add(n.name);
  }

  // Import-binding names only (all binding emitters push kind 'imports').
  // Deliberately NOT 'references': those carry type-annotation and
  // interface-member names, which let local variables that share a type
  // member's name slip through the gate (excalidraw A/B finding). A dotted
  // import (JVM `import com.example.OtherClass`) also contributes its LAST
  // segment — the simple name Java/Kotlin code uses in `OtherClass::method`
  // references.
  const SIMPLE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  // JVM imports are dotted (`com.example.OtherClass`); PHP `use` imports
  // are backslashed (`App\Services\Mailer`). Both contribute their last
  // segment — the simple name code uses to reference them.
  const QUALIFIED_IMPORT = /^[A-Za-z_$][A-Za-z0-9_$.\\]*[.\\]([A-Za-z_$][A-Za-z0-9_$]*)$/;
  const importedNames = new Set<string>();
  for (const r of this.unresolvedReferences) {
    if (r.referenceKind !== 'imports') continue;
    if (SIMPLE_NAME.test(r.referenceName)) {
      importedNames.add(r.referenceName);
    } else {
      const qualified = r.referenceName.match(QUALIFIED_IMPORT);
      if (qualified) importedNames.add(qualified[1]!);
    }
  }

  const ungated = this.fnRefSpec?.ungatedModes;
  const addressOfOnly = this.fnRefSpec?.addressOfOnly === true;
  const seen = new Set<string>();
  for (const c of candidates) {
    const atFileScope = c.fromNodeId.startsWith('file:');
    // C++ (addressOfOnly): a BARE identifier qualifies only inside a
    // file-scope initializer table. Everywhere else — args, assignments,
    // local braced-init lists like `{begin, size}` — only explicit `&`
    // forms count (fmt A/B finding: generic names `begin`/`out`/`size`
    // collide with locals and members).
    if (
      addressOfOnly &&
      !c.explicitRef &&
      !(atFileScope && (c.mode === 'value' || c.mode === 'list'))
    ) {
      continue;
    }
    // Gate policy by candidate shape:
    //  - `this.<member>`: ALWAYS flush — the member may be inherited from a
    //    class in another file (definedHere can't see it), volume is
    //    naturally bounded by real `this.X` expressions, and resolution is
    //    strictly class-scoped (own members or the validated supertype
    //    pass), so nothing fuzzy can leak.
    //  - `Scope::member` (C++ member-pointers, Java/Kotlin type-qualified
    //    method refs, PHP `'Cls::m'`): ALWAYS flush — the explicit-ref
    //    syntax is self-selecting, the referenced type often needs NO
    //    import (Java/Kotlin same-package, Kotlin companions), and
    //    resolution is scope-suffix-anchored + unique-or-drop, so a
    //    same-named member on another class can't match.
    //  - C-family file-scope initializers skip the gate entirely
    //    (constant-expression context — see FnRefSpec.ungatedModes).
    //  - everything else: name ∈ same-file functions/methods ∪ imports.
    if (!c.name.startsWith('this.') && !c.name.includes('::')) {
      const skipGate =
        (ungated?.has(c.mode) === true && atFileScope) ||
        c.skipGate === true; // PHP HOF-position string callables (see FnRefCandidate.skipGate)
      if (!skipGate && !definedHere.has(c.name) && !importedNames.has(c.name)) {
        continue;
      }
    }
    const key = `${c.fromNodeId}|${c.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    this.unresolvedReferences.push({
      fromNodeId: c.fromNodeId,
      referenceName: c.name,
      referenceKind: 'function_ref',
      line: c.line,
      column: c.column,
    });
  }
}

/**
   * Record value-reference bookkeeping as nodes are created: file-scope const/var symbols with
   * distinctive names become reference targets; function/method/const/var symbols become reader
   * scopes whose bodies flushValueRefs scans.
   */
export function captureValueRefScope(this: TreeSitterState, kind: NodeKind, name: string, id: string, node: SyntaxNode): void {
  // Pascal targets `constant` only: its extractor emits function PARAMETERS
  // (`Dest: TBufferWriter`) and class fields (`declField`) as `variable` at the
  // enclosing scope, which would otherwise become noisy targets (a param name
  // shared across many procs collapses to one file-wide target). Genuine
  // Pascal shared values are `const` (`constant`), so restrict to that. (Unit
  // `var` globals are the rare cost; the parameter/field noise dominates.)
  const targetKindOk =
    this.language === 'pascal' ? kind === 'constant' : kind === 'constant' || kind === 'variable';
  if (targetKindOk && name.length >= 3 && /[A-Z_]/.test(name)) {
    const parentId = this.nodeStack[this.nodeStack.length - 1];
    // file-scope OR class/module/struct/enum-scope constants are targets.
    // Class/module scope matters for languages (Ruby) that keep nearly all
    // constants inside a class or module; struct/enum scope matters for Swift,
    // which namespaces shared constants in `struct`/`enum` (`enum Constants {
    // static let X }`). Readers are same-file methods of that type.
    if (
      parentId &&
      (parentId.startsWith('file:') || parentId.startsWith('class:') ||
        parentId.startsWith('module:') || parentId.startsWith('struct:') ||
        parentId.startsWith('enum:'))
    ) {
      this.fileScopeValues.set(name, id);
      // How many target nodes carry this name. A conditional def
      // (`try: X = a; except: X = b`) makes >1 — distinct from a local shadow,
      // which adds a binding the prune must catch (see flushValueRefs).
      this.fileScopeValueCounts.set(name, (this.fileScopeValueCounts.get(name) ?? 0) + 1);
    }
  }
  if (kind === 'function' || kind === 'method' || kind === 'constant' || kind === 'variable') {
    this.valueRefScopes.push({ id, node, name });
  }
}

/**
   * Emit same-file `references` edges from a symbol to the file-scope const/var it reads (TS/JS).
   * The engine doesn't edge const→consumer, so impact analysis misses "change this table, affect
   * its readers" (the ReScript-PR false positive). Same-file only (resolution is unambiguous),
   * distinctive target names only (dodges the local-shadowing precision trap documented on
   * function_ref), deduped per (reader, target). Default on (CODEGRAPH_VALUE_REFS=0 disables) +
   * additive. Shadowed targets are pruned — see below.
   */
export function flushValueRefs(this: TreeSitterState): void {
  const scopes = this.valueRefScopes;
  const targets = this.fileScopeValues;
  const fileScopeCounts = this.fileScopeValueCounts;
  this.valueRefScopes = [];
  this.fileScopeValues = new Map();
  this.fileScopeValueCounts = new Map();
  if (!this.valueRefsEnabled || !VALUE_REF_LANGS.has(this.language)) return;
  if (targets.size === 0 || scopes.length === 0 || isGeneratedFile(this.filePath)) return;

  // Prune SHADOWED targets. A target re-bound in an INNER scope (a
  // bundled/Emscripten `const Module` re-declared as a nested `var Module`; a
  // Go package `const Timeout` shadowed by a local `Timeout := …`; a Python
  // module `CONFIG` shadowed by a local `CONFIG = …`) resolves to the inner
  // binding for nested readers, so a file-scope edge is a false positive.
  // Inner re-bindings aren't graph nodes, so detect them at the syntax level:
  // count every declarator of the name across the tree and compare against how
  // many FILE-SCOPE nodes carry it. A real shadow makes (declarators >
  // file-scope nodes) — the excess is the local binding. A conditional
  // module-level def (`try: X = a; except: X = b`) makes them EQUAL (both
  // declarators are file-scope nodes), so it's correctly kept. Complements the
  // path-based isGeneratedFile() check, which can't catch content-minified
  // bundles.
  //
  // Declarator node types are per-grammar; a file only contains its own
  // language's nodes, so matching all of them in one switch is safe.
  if (this.tree) {
    const declCounts = new Map<string, number>();
    const bump = (nameNode: SyntaxNode | null) => {
      // `simple_identifier` is Kotlin's name node (a property declarator's name).
      if (nameNode && (nameNode.type === 'identifier' || nameNode.type === 'simple_identifier')) {
        const nm = getNodeText(nameNode, this.source);
        if (targets.has(nm)) declCounts.set(nm, (declCounts.get(nm) ?? 0) + 1);
      }
    };
    const dstack: SyntaxNode[] = [this.tree.rootNode];
    let dvisited = 0;
    while (dstack.length > 0 && dvisited < MAX_VALUE_REF_NODES) {
      const n = dstack.pop()!;
      dvisited++;
      switch (n.type) {
        case 'variable_declarator': // TS/JS/tsx
        case 'const_spec':          // Go  `const X = …`
        case 'var_spec':            // Go  `var X = …`
          bump(n.namedChild(0));
          break;
        case 'const_item':          // Rust  `const X: T = …`
        case 'static_item':         // Rust  `static X: T = …`
          bump(getChildByField(n, 'name'));
          break;
        case 'let_declaration':       // Rust  `let x = …` (locals — the shadow source)
        case 'short_var_declaration': // Go    `x, Y := …`
        case 'assignment': {          // Python `X = …` / `X: T = …` / `A, B = …`
          const left = getChildByField(n, 'left') ?? getChildByField(n, 'pattern') ?? n.namedChild(0);
          if (left?.type === 'identifier') bump(left);
          else if (left) for (const c of left.namedChildren) bump(c);
          break;
        }
        case 'init_declarator':       // C  `T X = …` (file-scope const AND the local that shadows it)
          bump(cDeclaratorIdentifier(n));
          break;
        case 'val_definition':        // Scala  `val X = …` (object/top-level const AND a method-local that shadows it)
        case 'var_definition': {      // Scala  `var X = …`
          const pat = getChildByField(n, 'pattern');
          if (pat?.type === 'identifier') bump(pat);
          break;
        }
        case 'static_final_declaration':         // Dart  top-level/`static` `const`/`final` (the target itself)
        case 'initialized_identifier':           // Dart  instance field / `var`
        case 'initialized_variable_definition': { // Dart  a method-local `const`/`final`/`var` that shadows a const
          const id = n.namedChildren.find((c) => c.type === 'identifier');
          if (id) bump(id);
          break;
        }
        case 'declConst':  // Pascal  unit/class `const` (the target itself) AND a function-local `const` that shadows it
        case 'declVar': {  // Pascal  a function-local `var` that shadows a const
          bump(getChildByField(n, 'name'));
          break;
        }
        case 'property_declaration': { // Kotlin / Swift  `val`/`let X = …` (object/static const AND a method-local that shadows it)
          // Kotlin: variable_declaration → simple_identifier; Swift: a `pattern`
          // (`<name>` field) → simple_identifier. Resolve either shape.
          const vd = n.namedChildren.find((c) => c.type === 'variable_declaration');
          const id = vd
            ? vd.namedChildren.find((c) => c.type === 'simple_identifier')
            : firstSimpleIdentifier(
              getChildByField(n, 'name') ??
              n.namedChildren.find((c) => c.type === 'value_binding_pattern' || c.type === 'pattern') ??
              null,
            );
          if (id) bump(id);
          break;
        }
      }
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c) dstack.push(c);
      }
    }
    for (const [nm, c] of declCounts) if (c > (fileScopeCounts.get(nm) ?? 1)) targets.delete(nm);
    if (targets.size === 0) return;
  }

  for (const scope of scopes) {
    const seen = new Set<string>();
    const stack: SyntaxNode[] = [scope.node];
    // Dart and Pascal attach a function/method BODY as a *next sibling* of the
    // signature node that is stored as the reader scope (Dart `method_signature`
    // ← `function_body`; Pascal `declProc` ← `block`, both under a `defProc`),
    // not as a child — so the scope subtree is just the signature and the reads
    // live in the sibling. Pull it in. (A body as a next sibling of the scope
    // node is unique to Dart/Pascal among the value-ref languages — every other
    // grammar nests the body inside the function node — so this is inert
    // elsewhere.)
    const sib = scope.node.nextNamedSibling;
    if (sib && (sib.type === 'function_body' || sib.type === 'block')) stack.push(sib);
    let visited = 0;
    while (stack.length > 0 && visited < MAX_VALUE_REF_NODES) {
      const n = stack.pop()!;
      visited++;
      // `constant` covers Ruby, where both a constant's definition and its
      // references are `constant`-typed nodes, not `identifier`. `name` covers
      // PHP, where a constant reference — bare `MAX_ITEMS` or the const half of
      // `self::MAX_ITEMS` / `Foo::MAX_ITEMS` — is a `name` node (a `$var` local
      // is a `variable_name`, a different namespace, so it can never shadow a
      // bare constant — no prune wiring needed). `simple_identifier` covers
      // Kotlin, whose every name reference (a const read included) is that
      // node type. Safe across languages: a file only holds its own grammar's
      // nodes; `name` is PHP-only and `simple_identifier` is Kotlin-only here.
      if (
        n.type === 'identifier' || n.type === 'constant' ||
        n.type === 'name' || n.type === 'simple_identifier'
      ) {
        const refName = getNodeText(n, this.source);
        const targetId = targets.get(refName);
        // Skip self and same-name targets: a symbol referencing a file-scope
        // sibling of its own name (the two halves of a conditional `try: X=…;
        // except: X=…`) is never a meaningful value read.
        if (targetId && targetId !== scope.id && refName !== scope.name && !seen.has(targetId)) {
          seen.add(targetId);
          this.edges.push({
            source: scope.id,
            target: targetId,
            kind: 'references',
            metadata: { valueRef: true },
          });
        }
      }
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c) stack.push(c);
      }
    }
  }
}
