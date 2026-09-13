import type { Node as SyntaxNode } from '../web-tree-sitter';
import { stripCppTemplateArgs } from './languages/c-cpp';
import { getChildByField, getNodeText } from './tree-sitter-helpers';
import type { TreeSitterState } from './tree-sitter-state';
import {
  extractName,
  INSTANTIATION_KINDS,
  swiftPropertyInfo
} from './tree-sitter-syntax';

/**
   * Visit a node and extract information
   */
export function visitNode(this: TreeSitterState, node: SyntaxNode): void {
  if (!this.extractor) return;

  const nodeType = node.type;
  let skipChildren = false;

  // Language-specific custom visitor hook
  if (this.extractor.visitNode) {
    const ctx = this.makeExtractorContext();
    const handled = this.extractor.visitNode(node, ctx);
    if (handled) {
      // The hook consumed this subtree, so the walkers below never descend
      // into it — scan it for function-as-value candidates (#756). Scala's
      // hook handles val/var definitions (`val table = Seq(targetCb)`), for
      // example. The scan is capture-only and halts at nested functions.
      this.scanFnRefSubtree(node, 0);
      return;
    }
  }

  // Pascal-specific AST handling
  if (this.language === 'pascal') {
    skipChildren = this.visitPascalNode(node);
    if (skipChildren) return;
  }

  // C++ namespace blocks: carry the namespace name as a qualifiedName prefix
  // while walking the body, so `namespace flash { void compute_attn(); }`
  // indexes compute_attn with qualifiedName `flash::compute_attn` and a
  // namespace-qualified call (`flash::compute_attn(...)`) resolves by exact
  // qualified match instead of never resolving — C++ namespaces previously
  // left no trace in qualifiedNames at all, so every `ns::fn()` call site
  // was a permanently dead edge (surfaced by #387 flow validation on
  // flash-attention/cutlass, whose kernel dispatch is namespace-qualified).
  // C++17 nested forms (`namespace a::b {`) prefix as written. An anonymous
  // namespace falls through to the generic walk — its contents stay bare,
  // matching how call sites spell them.
  if (this.language === 'cpp' && nodeType === 'namespace_definition') {
    const nameNode = getChildByField(node, 'name');
    const nsName = nameNode ? getNodeText(nameNode, this.source) : '';
    if (nsName) {
      this.namespacePrefix.push(nsName);
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      this.namespacePrefix.pop();
      return;
    }
  }

  // Function-as-value capture (#756) — independent of the dispatch ladder
  // below (the captured container types have no other handler there), so it
  // can never shadow or be shadowed by an extraction branch.
  this.maybeCaptureFnRefs(node, nodeType);

  // Check for function declarations
  // For Python/Ruby, function_definition inside a class should be treated as method
  if (this.extractor.functionTypes.includes(nodeType)) {
    if (this.isInsideClassLikeNode() && this.extractor.methodTypes.includes(nodeType)) {
      // Inside a class - treat as method
      this.extractMethod(node);
      skipChildren = true; // extractMethod visits children via visitFunctionBody
    } else {
      this.extractFunction(node);
      skipChildren = true; // extractFunction visits children via visitFunctionBody
    }
  }
  // Check for class declarations
  else if (this.extractor.classTypes.includes(nodeType)) {
    // Some languages reuse class_declaration for structs/enums (e.g. Swift)
    const classification = this.extractor.classifyClassNode?.(node) ?? 'class';
    if (classification === 'struct') {
      this.extractStruct(node);
    } else if (classification === 'enum') {
      this.extractEnum(node);
    } else if (classification === 'interface') {
      this.extractInterface(node);
    } else if (classification === 'trait') {
      this.extractClass(node, 'trait');
    } else {
      this.extractClass(node);
    }
    skipChildren = true; // extractClass visits body children
  }
  // Extra class node types (e.g. Dart mixin_declaration, extension_declaration)
  else if (this.extractor.extraClassNodeTypes?.includes(nodeType)) {
    this.extractClass(node);
    skipChildren = true;
  }
  // Check for method declarations (only if not already handled by functionTypes)
  else if (this.extractor.methodTypes.includes(nodeType)) {
    // TS/JS class fields parse as a methodTypes node; only function-valued
    // fields are methods — a plain field (`public fonts: Fonts;`) is a
    // property (#808). classifyMethodNode is absent for other languages.
    if (this.extractor.classifyMethodNode?.(node) === 'property') {
      const propNode = this.extractProperty(node);
      // Walk the initializer so its calls/instantiations attribute to the
      // property (`history = createHistory()` → history calls
      // createHistory). The old field-as-method path never walked these
      // (resolveBody only resolves function bodies), so this is additive.
      const valueNode = getChildByField(node, 'value');
      if (propNode && valueNode) {
        this.nodeStack.push(propNode.id);
        this.visitFunctionBody(valueNode, '');
        this.nodeStack.pop();
      }
      // A field initializer can also register callbacks
      // (`static handlers = { click: onClick }`) — scan it for
      // function-as-value candidates (capture-only, halts at functions).
      this.scanFnRefSubtree(node, 0);
      skipChildren = true;
    } else {
      this.extractMethod(node);
      skipChildren = true; // extractMethod visits children via visitFunctionBody
    }
  }
  // Check for interface/protocol/trait declarations
  else if (this.extractor.interfaceTypes.includes(nodeType)) {
    this.extractInterface(node);
    skipChildren = true; // extractInterface visits body children
  }
  // Check for struct declarations
  else if (this.extractor.structTypes.includes(nodeType)) {
    this.extractStruct(node);
    skipChildren = true; // extractStruct visits body children
  }
  // Check for enum declarations
  else if (this.extractor.enumTypes.includes(nodeType)) {
    this.extractEnum(node);
    skipChildren = true; // extractEnum visits body children
  }
  // Check for type alias declarations (e.g. `type X = ...` in TypeScript)
  // For Go, type_spec wraps struct/interface definitions — resolveTypeAliasKind
  // detects these and extractTypeAlias creates the correct node kind.
  else if (this.extractor.typeAliasTypes.includes(nodeType)) {
    skipChildren = this.extractTypeAlias(node);
  }
  // Check for class properties (e.g. C# property_declaration)
  else if (this.extractor.propertyTypes?.includes(nodeType) && this.isInsideClassLikeNode()) {
    this.extractProperty(node);
    // Property initializers aren't walked — scan for function-as-value
    // candidates (#756): Scala `val table = Seq(targetCb)` in an object,
    // Kotlin `val cb = ::handler` class properties.
    this.scanFnRefSubtree(node, 0);
    skipChildren = true;
  }
  // Check for class fields (e.g. Java field_declaration, C# field_declaration)
  else if (this.extractor.fieldTypes?.includes(nodeType) && this.isInsideClassLikeNode()) {
    this.extractField(node);
    // Field initializers aren't walked — scan for function-as-value
    // candidates (#756): Java `List<IntConsumer> table = List.of(Main::cb)`,
    // C# `List<Action<int>> table = new() { TargetCb }`.
    this.scanFnRefSubtree(node, 0);
    skipChildren = true;
  }
  // Check for variable declarations (const, let, var, etc.)
  // Only extract top-level variables (not inside functions/methods) — plus
  // class/module-scope CONSTANTS, which Ruby (and other const-in-class
  // languages) keep almost exclusively inside a class/module. A Ruby `CONST =
  // …` has a `constant`-typed LHS; other languages don't put one here, so this
  // is effectively Ruby-only and doesn't disturb their class-internal locals.
  else if (
    this.extractor.variableTypes.includes(nodeType) &&
    (!this.isInsideClassLikeNode() || this.isClassScopeConstantAssignment(node))
  ) {
    this.extractVariable(node);
    // extractVariable doesn't walk every initializer shape (object literals
    // are deliberately skipped; Python/Ruby don't walk at all), so scan the
    // declaration subtree for function-as-value candidates — `const routes =
    // { home: renderHome }`, `handlers = {"recv": target_cb}`. The scan halts
    // at nested function definitions (their bodies are walked — and
    // attributed — separately) and flush-time dedup absorbs any overlap with
    // initializers extractVariable DOES walk.
    this.scanFnRefSubtree(node, 0);
    skipChildren = true; // extractVariable handles children
  }
  // Swift properties inside a type. A stored instance property becomes a `field`
  // node; a `static let`/`static var` member becomes `constant`/`variable`
  // (Swift's `static`-namespacing idiom — value-reference edges can then target
  // it); a COMPUTED property (getter block, no stored value) becomes a `property`
  // node whose getter is walked below so its calls attribute to it. A property's
  // PROPERTY WRAPPER (`@Argument`/`@Published`/`@State`/custom) and declared type
  // are dependencies attributed to the enclosing type. (Other languages extract
  // properties via property/field types.)
  else if (
    this.language === 'swift' &&
    (nodeType === 'property_declaration' || nodeType === 'protocol_property_declaration') &&
    this.isInsideClassLikeNode()
  ) {
    const ownerId = this.nodeStack[this.nodeStack.length - 1];
    const { nameNode, isLet, isComputed } = swiftPropertyInfo(node, this.source);
    let computedPropId: string | undefined;
    if (nameNode) {
      if (isComputed) {
        // Computed property — accessed like a property but its getter holds real
        // logic. Index as `property` so search/explore find it (#1020: computed
        // props such as a heavily-read `var isCloudProxy: Bool` returned "No
        // results found"); pushed below so the getter's calls attribute to it
        // rather than flattening onto the owning type (SwiftUI `var body: some
        // View { … }` — the whole subview tree — is the canonical case).
        const prop = this.createNode('property', getNodeText(nameNode, this.source), node, {
          visibility: this.extractor.getVisibility?.(node),
          isStatic: this.extractor.isStatic?.(node) ?? false,
        });
        computedPropId = prop?.id;
      } else {
        // A `static let`/`static var` member is a SHARED constant of the type
        // (esp. in `enum`/`struct`); an instance stored property stays a `field`
        // (per-instance — Swift instance properties otherwise aren't own nodes).
        const isStatic = this.extractor.isStatic?.(node) ?? false;
        this.createNode(isStatic ? (isLet ? 'constant' : 'variable') : 'field',
          getNodeText(nameNode, this.source), node, {
          visibility: this.extractor.getVisibility?.(node),
          isStatic,
        });
      }
    }
    if (ownerId) {
      this.extractDecoratorsFor(node, ownerId);
      this.extractVariableTypeAnnotation(node, ownerId);
      // Fluent / SwiftUI property-wrapper attributes often reference a model or
      // type by metatype in their ARGUMENTS — `@Siblings(through: Pivot.self,
      // …)`, `@Group(…)`. extractDecoratorsFor captures the wrapper type
      // (`Siblings`); this pulls the TYPE out of the argument expressions
      // (`Pivot.self` → a dependency on Pivot), so a model reached ONLY through
      // a relationship (a many-to-many pivot/join model) isn't left orphaned.
      // extractStaticMemberRef self-filters to `Type.member` navigation, so the
      // `\.$keypath` arguments and the wrapper `user_type` are skipped.
      const modifiers = node.namedChildren.find((c: SyntaxNode) => c.type === 'modifiers');
      if (modifiers) {
        const walkAttrArgs = (n: SyntaxNode): void => {
          this.extractStaticMemberRef(n);
          for (let i = 0; i < n.namedChildCount; i++) {
            const c = n.namedChild(i);
            if (c) walkAttrArgs(c);
          }
        };
        walkAttrArgs(modifiers);
      }
    }
    // A computed property's getter holds real logic — walk it with the property
    // node pushed so its calls/instantiations attribute to the property (a
    // SwiftUI `body`'s subview tree becomes the property's callees). skipChildren
    // then stops the generic walker from re-walking the getter (and the
    // modifiers/type annotation already handled above).
    if (computedPropId) {
      const getter = node.namedChildren.find(
        (c: SyntaxNode) =>
          c.type === 'computed_property' || c.type === 'protocol_property_requirements',
      );
      if (getter) {
        this.nodeStack.push(computedPropId);
        this.visitFunctionBody(getter, '');
        this.nodeStack.pop();
      }
      skipChildren = true;
    }
  }
  // `export_statement` itself is not extracted — the walker descends
  // into children, where the inner declaration (lexical_declaration,
  // function_declaration, class_declaration, etc.) is dispatched to
  // its own extractor. `isExported` walks the parent chain, so the
  // exported flag is preserved automatically.
  //
  // Calling extractExportedVariables here AND descending caused every
  // `export const X = ...` to produce two nodes for the same symbol —
  // one kind:'variable' from extractExportedVariables and one
  // kind:'constant' from extractVariable. The dedicated dispatch is
  // the correct one (it picks kind from isConst, captures the
  // initializer signature, and walks type annotations); the
  // export-statement helper was redundant.
  // Check for imports
  else if (this.extractor.importTypes.includes(nodeType)) {
    this.extractImport(node);
  }
  // Re-export from another module — `export { X } from './y'` (TS/JS). A
  // re-export is a dependency on the source module just like an import, but
  // the export_statement is otherwise only descended into (no declaration to
  // extract), so a barrel that ONLY re-exports produced zero edges and showed
  // 0 dependents. Link each re-exported name to its definition. Children are
  // still visited (a non-re-export `export const X = …` has no `source` and
  // falls through to its normal declaration extraction).
  else if (
    nodeType === 'export_statement' &&
    (this.language === 'typescript' || this.language === 'tsx' ||
      this.language === 'javascript' || this.language === 'jsx' ||
      this.language === 'arkts') &&
    getChildByField(node, 'source')
  ) {
    const parentId = this.nodeStack[this.nodeStack.length - 1];
    if (parentId) this.emitReExportRefs(node, parentId);
  }
  // Vuex MODULE default export — `export default { namespaced, actions: {…},
  // mutations: {…} }` (the canonical Vuex module shape). Object-literal methods
  // aren't otherwise extracted, so scan the config's actions/mutations/getters
  // collections and extract their methods as nodes. Store-file gated (the
  // ≥2-signal heuristic) so a plain default-exported object is untouched; skip
  // the subtree afterward (the collection methods are now handled).
  else if (
    nodeType === 'export_statement' &&
    (this.language === 'typescript' || this.language === 'tsx' ||
      this.language === 'javascript' || this.language === 'jsx') &&
    this.looksLikeVueStoreFile()
  ) {
    const exported = getChildByField(node, 'value');
    if (exported && (exported.type === 'object' || exported.type === 'object_expression')) {
      this.extractStoreCollectionMethods(exported);
      skipChildren = true;
    }
  }
  // Check for function calls
  else if (this.extractor.callTypes.includes(nodeType)) {
    this.extractCall(node);
  }
  // `new Foo(...)` / `Foo::new(...)` / object_creation_expression —
  // produce an `instantiates` reference. Children still walked so
  // nested calls inside the constructor args (`new Foo(bar())`) get
  // their own `calls` refs.
  else if (INSTANTIATION_KINDS.has(nodeType) || this.isVbnetConstructorShapedArrayCreation(node)) {
    this.extractInstantiation(node);
    // Java/C# `new T(...) { ... }` — anonymous class with body. Without
    // extracting it as a class node + its methods, the interface→impl
    // synthesizer (Phase 5.5) can't bridge T's abstract methods to the
    // anonymous overrides, and an agent investigating a call through T
    // (`strategy.iterator(...)` where strategy is a Strategy lambda body)
    // has to Read the file to find the actual implementation.
    const anonBody = this.findAnonymousClassBody(node);
    if (anonBody) {
      this.extractAnonymousClass(node, anonBody);
      skipChildren = true;
    }
  }
  // (Decorator handling lives inside the symbol-creating extractors
  // — extractClass / extractFunction / extractProperty — because the
  // decorator node sits BEFORE the symbol in the AST and the walker
  // would otherwise see the wrong nodeStack head.)
  // Rust: `impl Trait for Type { ... }` — creates implements edge from Type to Trait
  else if (nodeType === 'impl_item') {
    this.extractRustImplItem(node);
  }
  // TypeScript interface members: property_signature (`foo: T`, `foo?: T`)
  // and method_signature (`foo(arg: A): R`) both carry type annotations the
  // interface walker would otherwise drop. Extract them as `references`
  // edges from the interface so resolvers can wire callers/impact for
  // types that only appear in interface members.
  else if (
    (nodeType === 'property_signature' || nodeType === 'method_signature') &&
    this.isInsideClassLikeNode() &&
    this.TYPE_ANNOTATION_LANGUAGES.has(this.language)
  ) {
    const parentId = this.nodeStack[this.nodeStack.length - 1];
    if (parentId) {
      this.extractTypeAnnotations(node, parentId);
    }
    // don't skipChildren — nested signatures still need traversal
  }

  // Visit children (unless the extract method already visited them)
  if (!skipChildren) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
  }
}

/**
   * Record a C++ local function-pointer binding (`local = &fn` / `&fn<…>` /
   * `&ns::fn<…>`) for the CURRENT enclosing symbol, so calls through the local
   * resolve to the real target (see cppLocalFnPtrs). Only the address-of shape
   * is accepted — a bare-identifier RHS (`auto x = y;`) is any value copy, and
   * linking through it would guess.
   */
export function recordCppFnPtrBinding(this: TreeSitterState, localName: string, value: SyntaxNode | null): void {
  if (!value || value.type !== 'pointer_expression') return;
  if (value.child(0)?.type !== '&') return; // `*p` dereference, not address-of
  const arg = getChildByField(value, 'argument') ?? value.namedChild(0);
  if (
    !arg ||
    (arg.type !== 'identifier' &&
      arg.type !== 'template_function' &&
      arg.type !== 'qualified_identifier')
  ) {
    return;
  }
  const callerId = this.nodeStack[this.nodeStack.length - 1];
  if (!callerId) return;
  const target = stripCppTemplateArgs(getNodeText(arg, this.source));
  if (!target || target === localName) return;
  let locals = this.cppLocalFnPtrs.get(callerId);
  if (!locals) {
    locals = new Map();
    this.cppLocalFnPtrs.set(callerId, locals);
  }
  let targets = locals.get(localName);
  if (!targets) {
    targets = new Set();
    locals.set(localName, targets);
  }
  targets.add(target);
}

export function visitFunctionBody(this: TreeSitterState, body: SyntaxNode, _functionId: string): void {
  if (!this.extractor) return;

  const visitForCallsAndStructure = (node: SyntaxNode): void => {
    const nodeType = node.type;

    // Function-as-value capture (#756) — function bodies are walked here,
    // not in visitNode, so the capture hook must fire in both walkers.
    this.maybeCaptureFnRefs(node, nodeType);

    // Rocket route-registration macros (`routes![…]` / `catchers![…]`): the
    // handler paths live in a raw token tree the call walker can't see.
    if (nodeType === 'macro_invocation') this.extractRustRouteMacro(node);

    if (this.extractor!.callTypes.includes(nodeType)) {
      this.extractCall(node);
    } else if (INSTANTIATION_KINDS.has(nodeType) || this.isVbnetConstructorShapedArrayCreation(node)) {
      // `new Foo()` inside a function body — emit an `instantiates`
      // reference. Without this branch the body walker only knew
      // about `call_expression`, so constructor invocations
      // produced no graph edges at all.
      this.extractInstantiation(node);
      // Anonymous class with body: `new T() { ... }` (Java/C#). Extract as
      // a class so interface-impl synthesis (Phase 5.5) can bridge T's
      // methods to the overrides — same rationale as in visitNode.
      const anonBody = this.findAnonymousClassBody(node);
      if (anonBody) {
        this.extractAnonymousClass(node, anonBody);
        return;
      }
    } else if (this.extractor!.extractBareCall) {
      const calleeName = this.extractor!.extractBareCall(node, this.source);
      if (calleeName && this.nodeStack.length > 0) {
        const callerId = this.nodeStack[this.nodeStack.length - 1];
        if (callerId) {
          this.unresolvedReferences.push({
            fromNodeId: callerId,
            referenceName: calleeName,
            referenceKind: 'calls',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
      }
    }

    // C++ stack / direct-initialization construction — `Calculator calc(0)`
    // and `Widget w{1, 2}`. Unlike heap `new Calculator(0)` (a new_expression
    // handled above), these carry the constructor arguments directly on the
    // declarator with NO call/new node, so the body walker saw no constructor
    // invocation and recorded no `instantiates` edge (#1035). A declaration's
    // `type` field IS the constructed class name, so reuse extractInstantiation
    // (which strips template args / namespace and emits the `instantiates`
    // ref). Children still recurse below, so a nested ctor-arg call
    // (`Calculator calc(make())`) keeps its own `calls` ref.
    if (nodeType === 'declaration' && this.language === 'cpp' && this.isCppStackConstruction(node)) {
      this.extractInstantiation(node);
    }

    // C++ local function-pointer bindings (see cppLocalFnPtrs): record
    // `auto kernel = &fn<…>;` declarations and `kernel = &other_fn<…>;`
    // branch reassignments so a call/launch through the local links to the
    // real target(s). The body walker sees these in source order, and C++
    // requires declaration-before-use, so the map is always populated before
    // the call that consumes it.
    if (this.language === 'cpp' && this.nodeStack.length > 0) {
      if (nodeType === 'declaration') {
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child?.type !== 'init_declarator') continue;
          const decl = getChildByField(child, 'declarator');
          if (decl?.type !== 'identifier') continue;
          this.recordCppFnPtrBinding(
            getNodeText(decl, this.source),
            getChildByField(child, 'value')
          );
        }
      } else if (nodeType === 'assignment_expression') {
        const left = getChildByField(node, 'left');
        if (left?.type === 'identifier') {
          this.recordCppFnPtrBinding(
            getNodeText(left, this.source),
            getChildByField(node, 'right')
          );
        }
      }
    }

    // Static-member / value-read: `Enum.value`, `Type.CONST`, `Foo::BAR`.
    this.extractStaticMemberRef(node);

    // Local variable type annotations inside a body — `const items: Foo[] = []`,
    // `const x: SomeType = svc.load()`. We deliberately do NOT create nodes for
    // locals (that would explode the graph — the data-flow frontier we leave
    // uncovered), but the TYPE a local is annotated with is a real dependency of
    // the enclosing function, so attribute a `references` edge to it. Without
    // this, a function that uses a type ONLY in its body (very common — e.g. a
    // resolver building `const nodes: Node[] = []`) produced no edge to that
    // type, so impact / `affected` missed the dependency entirely. We fall
    // through to the default recursion below so the initializer's calls (and any
    // nested declarators) are still walked.
    if (
      nodeType === 'variable_declarator' &&
      this.TYPE_ANNOTATION_LANGUAGES.has(this.language)
    ) {
      const ownerId = this.nodeStack[this.nodeStack.length - 1];
      if (ownerId) this.extractVariableTypeAnnotation(node, ownerId);
    }

    // Nested NAMED functions inside a body — function declarations and named
    // function expressions like `.on('mount', function onmount(){})` — become
    // their own nodes so the graph can link to them (callback handlers, local
    // helpers, including arrows assigned to named local bindings). Unbound
    // anonymous arrows/expressions fall through to the default
    // recursion below, keeping their inner calls attributed to the enclosing
    // function: this bounds the new nodes to NAMED functions only (no explosion,
    // no lost edges). extractFunction walks the nested body itself, so we return.
    if (this.extractor!.functionTypes.includes(nodeType)) {
      const nestedName = extractName(node, this.source, this.extractor!);
      const binding = node.parent?.type === 'variable_declarator'
        ? getChildByField(node.parent, 'name') : null;
      if ((nestedName && nestedName !== '<anonymous>') || binding?.type === 'identifier') {
        this.extractFunction(node);
        return;
      }
    }

    // Extract structural nodes found inside function bodies.
    // Each extract method visits its own children, so we return after extracting.
    if (this.extractor!.classTypes.includes(nodeType)) {
      const classification = this.extractor!.classifyClassNode?.(node) ?? 'class';
      if (classification === 'struct') this.extractStruct(node);
      else if (classification === 'enum') this.extractEnum(node);
      else if (classification === 'interface') this.extractInterface(node);
      else if (classification === 'trait') this.extractClass(node, 'trait');
      else this.extractClass(node);
      return;
    }
    if (this.extractor!.structTypes.includes(nodeType)) {
      this.extractStruct(node);
      return;
    }
    if (this.extractor!.enumTypes.includes(nodeType)) {
      this.extractEnum(node);
      return;
    }
    if (this.extractor!.interfaceTypes.includes(nodeType)) {
      this.extractInterface(node);
      return;
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) {
        visitForCallsAndStructure(child);
      }
    }
  };

  visitForCallsAndStructure(body);
}
