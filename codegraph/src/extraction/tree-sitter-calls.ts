import type { Node as SyntaxNode } from '../web-tree-sitter';
import { stripCppTemplateArgs } from './languages/c-cpp';
import { getChildByField, getNodeText } from './tree-sitter-helpers';
import type { TreeSitterState } from './tree-sitter-state';
import {
  ERLANG_MFA_CALLS,
  ERLANG_PREDEFINED_MACROS,
  LITERAL_RECEIVER_TYPES
} from './tree-sitter-syntax';

export function extractCall(this: TreeSitterState, node: SyntaxNode): void {
  if (this.nodeStack.length === 0) return;

  const callerId = this.nodeStack[this.nodeStack.length - 1];
  if (!callerId) return;

  // VB.NET: `foo(args)` is syntactically ambiguous between a call and an
  // index read, so the grammar parses non-empty parens as
  // array_access_expression (field `array`, not `function`) — even Roslyn
  // parses both as InvocationExpression and resolves during binding. Treat
  // all three shapes as call sites: the callee is the member/identifier
  // under the array/function field, qualified with a simple-identifier
  // receiver for resolution. Index reads on collections simply never
  // resolve to a callable, so they cost nothing.
  if (
    this.language === 'vbnet' &&
    (node.type === 'array_access_expression' ||
      node.type === 'invocation_expression' ||
      node.type === 'generic_invocation_expression')
  ) {
    const fn = getChildByField(node, 'function') || getChildByField(node, 'array');
    if (!fn) return;
    let calleeName = '';
    if (fn.type === 'member_access_expression') {
      const member = getChildByField(fn, 'member');
      const memberName = member ? getNodeText(member, this.source) : '';
      if (!memberName) return;
      const receiver = getChildByField(fn, 'object');
      const SKIP = new Set(['me', 'mybase', 'myclass']);
      if (receiver && receiver.type === 'identifier' && !SKIP.has(getNodeText(receiver, this.source).toLowerCase())) {
        calleeName = `${getNodeText(receiver, this.source)}.${memberName}`;
      } else {
        calleeName = memberName;
      }
    } else if (fn.type === 'identifier') {
      calleeName = getNodeText(fn, this.source);
    } else {
      return; // parenthesized/chained receivers: no static name to link
    }
    if (calleeName) {
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: calleeName,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
    return;
  }

  // Erlang: a local call is `call(expr: atom, args)`; a remote call nests it
  // under `remote(module: remote_module, fun: call)` — the module qualifier
  // lives on the PARENT. Remote calls are emitted as `mod::fn`, which is
  // byte-identical to the qualifiedName the module namespace gives every
  // function (see packageTypes in languages/erlang.ts), so they resolve via
  // matchByQualifiedName. A var/macro callee or module (`F(X)`, `?M(X)`,
  // `Mod:handle(X)`) has no static target — except `?MODULE:fn(X)`, which the
  // bare name + same-file preference resolves correctly. `fun name/1` /
  // `fun mod:name/1` values are function REFERENCES (callback registration),
  // and record construction/update/index/field-access are `references` to the
  // record's struct node.
  if (this.language === 'erlang') {
    const line = node.startPosition.row + 1;
    const column = node.startPosition.column;
    const erlAtom = (n: SyntaxNode): string => getNodeText(n, this.source).replace(/^'([\s\S]*)'$/, '$1');
    if (node.type === 'call') {
      let callee = getChildByField(node, 'expr');
      let moduleNode: SyntaxNode | null = null;
      // remote(module, fun: call) — the shape the grammar produces today; the
      // node-types also permit call(expr: remote), so handle both nestings.
      if (node.parent?.type === 'remote') {
        moduleNode = getChildByField(node.parent, 'module');
      } else if (callee?.type === 'remote') {
        moduleNode = getChildByField(callee, 'module');
        callee = getChildByField(callee, 'fun');
      }
      if (callee?.type === 'atom') {
        const fnBare = erlAtom(callee);
        let calleeName = fnBare;
        const moduleExpr = moduleNode ? getChildByField(moduleNode, 'module') : null;
        if (moduleExpr?.type === 'atom') {
          calleeName = `${erlAtom(moduleExpr)}::${calleeName}`;
        } else if (moduleExpr) {
          // Non-atom module qualifier. `?MODULE:f(X)` targets THIS module —
          // keep the bare name so same-file preference resolves it. Anything
          // else (`Mod:f(X)`) is behaviour-style dynamic dispatch with no
          // static target: emitting the bare name would link an arbitrary
          // same-named function, so stay silent instead.
          const macroName =
            moduleExpr.type === 'macro_call_expr' ? getChildByField(moduleExpr, 'name') : null;
          if (!macroName || getNodeText(macroName, this.source) !== 'MODULE') return;
        }
        this.unresolvedReferences.push({
          fromNodeId: callerId,
          referenceName: calleeName,
          referenceKind: 'calls',
          line,
          column,
        });
        // gen_server dispatch: `gen_server:call(?SERVER, Msg)` /
        // `gen_server:cast(other_mod, Msg)` — a request routes to the TARGET
        // module's handle_call/handle_cast. The target is static when the
        // first argument names a module: ?MODULE or a ?MODULE-defined macro
        // (the self API-wrapper idiom), a bare atom (OTP's `{local, ?MODULE}`
        // convention names a server after its module, so a cross-module
        // registered name reaches that module's handlers — and a registered
        // name matching no module resolves to nothing), or a macro defined
        // as a bare atom. Pid/var/tuple targets stay silent.
        if (
          moduleExpr?.type === 'atom' &&
          erlAtom(moduleExpr) === 'gen_server' &&
          (fnBare === 'call' || fnBare === 'cast' || fnBare === 'send_request')
        ) {
          const argsNode = getChildByField(node, 'args');
          const target = argsNode?.namedChild(0) ?? null;
          const targetModule = target ? this.resolveErlangGenServerTarget(target) : null;
          if (targetModule) {
            this.unresolvedReferences.push({
              fromNodeId: callerId,
              referenceName: `${targetModule}::${fnBare === 'cast' ? 'handle_cast' : 'handle_call'}`,
              referenceKind: 'calls',
              line,
              column,
            });
          }
        }
        // MFA-in-argument dispatch: the spawn/apply family names its real
        // callee in ARGUMENT position — `proc_lib:spawn_link(?MODULE,
        // request_process, [Req, Env, Middlewares])` — so the walker above
        // sees only the spawn itself and the spawned function ends up with
        // zero callers (measured on cowboy: request_process had no incoming
        // edges and the agent Read the file to find it). When the (Module,
        // Function) pair is static, lift it as a call edge. The pair is
        // found positionally-agnostically (first adjacent module-atom/
        // ?MODULE + atom pair) so every arity variant works: spawn/3,
        // spawn(Node,M,F,A)/4, timer:apply_after(Time,M,F,A),
        // rpc:call(Node,M,F,A). A var module or fun stays silent.
        const familyKey = moduleExpr?.type === 'atom' ? `${erlAtom(moduleExpr)}:${fnBare}` : fnBare;
        if (ERLANG_MFA_CALLS.has(familyKey)) {
          const argsNode = getChildByField(node, 'args');
          const argExprs = argsNode ? argsNode.namedChildren : [];
          for (let i = 0; i + 1 < argExprs.length; i++) {
            const m = argExprs[i]!;
            const f = argExprs[i + 1]!;
            if (f.type !== 'atom') continue;
            const isLocalModule =
              m.type === 'macro_call_expr' &&
              getChildByField(m, 'name') !== null &&
              getNodeText(getChildByField(m, 'name')!, this.source) === 'MODULE';
            if (m.type !== 'atom' && !isLocalModule) continue;
            this.unresolvedReferences.push({
              fromNodeId: callerId,
              referenceName: isLocalModule ? erlAtom(f) : `${erlAtom(m)}::${erlAtom(f)}`,
              referenceKind: 'calls',
              line: f.startPosition.row + 1,
              column: f.startPosition.column,
            });
            break;
          }
        }
      }
      return;
    }
    if (node.type === 'internal_fun' || node.type === 'external_fun') {
      const funNode = getChildByField(node, 'fun');
      if (funNode?.type !== 'atom') return; // fun Mod:F/A with var parts — dynamic
      let refName = erlAtom(funNode);
      if (node.type === 'external_fun') {
        const moduleWrapper = getChildByField(node, 'module');
        const moduleAtom = moduleWrapper ? getChildByField(moduleWrapper, 'name') : null;
        if (moduleAtom?.type !== 'atom') return;
        refName = `${erlAtom(moduleAtom)}::${refName}`;
      }
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: refName,
        referenceKind: 'references',
        line,
        column,
      });
      return;
    }
    if (node.type === 'macro_call_expr') {
      // Macro use site → the `-define` constant node. Function-like uses
      // (`?LOG_AUDIT(X)` — args present) are inlined code, so they join the
      // call chain and connect through the macro node to the body's calls
      // (attributed there by handlePpDefine); bare reads (`?TIMEOUT`) are
      // `references`, answering "where is this macro used" without
      // polluting call paths. Compiler-predefined macros carry no
      // definition to link. The use site's ARGUMENTS are children and keep
      // walking, so a call nested in `?assertEqual(ok, do_thing())` still
      // attributes to the enclosing function.
      const macroName = getChildByField(node, 'name');
      if (!macroName) return;
      const name = getNodeText(macroName, this.source);
      if (ERLANG_PREDEFINED_MACROS.has(name)) return;
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: name,
        referenceKind: getChildByField(node, 'args') ? 'calls' : 'references',
        line,
        column,
      });
      return;
    }
    // record_expr / record_update_expr / record_index_expr / record_field_expr
    const recordName = getChildByField(node, 'name');
    const recordAtom = recordName?.type === 'record_name' ? getChildByField(recordName, 'name') : null;
    if (recordAtom?.type === 'atom') {
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: erlAtom(recordAtom),
        referenceKind: 'references',
        line,
        column,
      });
    }
    return;
  }

  // Ruby `call` nodes use `receiver` + `method` fields (tree-sitter-ruby), not
  // the `object`/`name`/`function` fields the branches below expect — so
  // without this they fell through to the generic path, which took the
  // receiver as the callee and DROPPED the method name: `lg.log()` produced a
  // `calls` ref to `lg` (unresolvable) and no method edge was ever recorded,
  // so a Ruby method's callers/impact were invisible (#1108 follow-up). Build
  // `receiver.method` so the resolver — and local-variable type inference —
  // can link it; `Foo.new` stays an instantiation.
  if (this.language === 'ruby' && (node.type === 'call' || node.type === 'method_call')) {
    const methodNode = getChildByField(node, 'method');
    const methodName = methodNode ? getNodeText(methodNode, this.source) : '';
    if (!methodName) return; // operator/element-reference call with no method name
    const receiverNode = getChildByField(node, 'receiver');
    const line = node.startPosition.row + 1;
    const column = node.startPosition.column;
    if (!receiverNode) {
      // Bare `foo(...)` — just the method name (unchanged behavior).
      this.unresolvedReferences.push({ fromNodeId: callerId, referenceName: methodName, referenceKind: 'calls', line, column });
      return;
    }
    const receiverName = getNodeText(receiverNode, this.source);
    // `Foo.new` / `Foo::Bar.new` is construction — emit an `instantiates` ref to
    // the class (last `::` segment), preserving the "what creates X" edge.
    if (methodName === 'new') {
      const className = receiverName.includes('::')
        ? receiverName.slice(receiverName.lastIndexOf('::') + 2)
        : receiverName;
      if (/^[A-Z]/.test(className)) {
        this.unresolvedReferences.push({ fromNodeId: callerId, referenceName: className, referenceKind: 'instantiates', line, column });
        return;
      }
    }
    const SKIP_RECEIVERS = new Set(['self', 'super']);
    const skip = SKIP_RECEIVERS.has(receiverName);
    this.unresolvedReferences.push({
      fromNodeId: callerId,
      referenceName: skip ? methodName : `${receiverName}.${methodName}`,
      referenceKind: 'calls',
      line,
      column,
    });
    // A capitalized (constant) receiver — `Foo.bar`, a class/module method call
    // — is itself a dependency on that constant; emit a `references` ref so a
    // class used only via its class methods still records a dependent (the edge
    // the old receiver-only callee happened to provide, now made explicit).
    if (!skip && receiverNode.type === 'constant') {
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: receiverName,
        referenceKind: 'references',
        line: receiverNode.startPosition.row + 1,
        column: receiverNode.startPosition.column,
      });
    }
    return;
  }

  // ArkTS build()-DSL handling. Three shapes carry UI-attribute chains, and
  // all of their attribute names are emitted with a LEADING DOT
  // (`.titleStyle`, `.width`) — an impossible identifier that routes them to
  // a dedicated matcher strategy resolving ONLY to decorator-marked
  // attribute helpers (`@Extend`/`@Styles`/`@AnimatableExtend`/`@Builder`
  // functions). Bare names would go through global name matching, where
  // framework attributes (`.width`, `.fontSize`, appearing on nearly every
  // UI line) hit arbitrary same-named symbols — measured on the OpenHarmony
  // samples monorepo, that produced 36k wrong edges (17% of all calls),
  // including single properties with 3,400+ false callers.
  //
  //   1. `Column({space:8}) { … }.height('100%')` — ONE
  //      arkui_component_expression: `function:` = the component, chained
  //      attributes as repeated `property:`/`arguments:` field pairs.
  //      The component ref (`Column`, `TodoRow`) stays a PLAIN name — it
  //      resolves to the child `@Component struct`, giving the parent→child
  //      component-tree edge the way JSX children do for React.
  //   2. `Image(x).width(10).onClick(this.f)` — ordinary nested
  //      call_expressions whose `function:` is a member_expression chained
  //      on a CALL RESULT (never a named receiver, so `svc.save()` /
  //      `this.vm.load()` are untouched and fall through to the generic
  //      paths below).
  //   3. A nested component whose chain starts on the line AFTER its
  //      closing `}` inside arkui_children — the grammar detaches the chain
  //      into sibling `leading_dot_expression(identifier)` +
  //      `parenthesized_expression(args)` statement pairs; reassemble from
  //      the siblings.
  //
  // `.onXxx(this.handler)` METHOD-REFERENCE bindings (no call parens, so
  // nothing else records them) additionally emit a call ref to the bare
  // handler name — same-class resolution links the tap→handler hop.
  // Arrow-function handlers need nothing: their bodies' calls already
  // attribute to the enclosing build(). Children/argument subtrees are
  // still walked by the caller, so nested components extract normally.
  if (this.language === 'arkts') {
    const emitAttr = (nameNode: SyntaxNode): void => {
      const attrName = getNodeText(nameNode, this.source);
      if (!attrName) return;
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: '.' + attrName,
        referenceKind: 'calls',
        line: nameNode.startPosition.row + 1,
        column: nameNode.startPosition.column,
      });
    };
    // Emit `handler` for each bare `this.handler` among an on-attribute's
    // arguments.
    const emitThisHandlers = (args: SyntaxNode | null): void => {
      if (!args) return;
      for (let j = 0; j < args.namedChildCount; j++) {
        const arg = args.namedChild(j);
        if (arg?.type !== 'member_expression') continue;
        const obj = getChildByField(arg, 'object');
        const prop = getChildByField(arg, 'property');
        if (obj?.type === 'this' && prop) {
          this.unresolvedReferences.push({
            fromNodeId: callerId,
            referenceName: getNodeText(prop, this.source),
            referenceKind: 'calls',
            line: arg.startPosition.row + 1,
            column: arg.startPosition.column,
          });
        }
      }
    };

    // Shape 1: arkui_component_expression with property/arguments pairs.
    if (node.type === 'arkui_component_expression') {
      const componentField = getChildByField(node, 'function');
      if (componentField && componentField.type === 'identifier') {
        this.unresolvedReferences.push({
          fromNodeId: callerId,
          referenceName: getNodeText(componentField, this.source),
          referenceKind: 'calls',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child || child.type !== 'property_identifier') continue;
        emitAttr(child);
        if (/^on[A-Z]/.test(getNodeText(child, this.source))) {
          // The attribute's arguments node is the next `arguments`-typed
          // child before the following attribute name.
          let args: SyntaxNode | null = null;
          for (let k = i + 1; k < node.childCount; k++) {
            const next = node.child(k);
            if (!next) continue;
            if (next.type === 'property_identifier') break;
            if (next.type === 'arguments') {
              args = next;
              break;
            }
          }
          emitThisHandlers(args);
        }
      }
      return;
    }

    // Shape 2: fluent chain on a call result —
    // call_expression(function: member_expression(object: <call>)), or the
    // grammar's DSL-specific arkui_dsl_decorator_member_expression (same
    // object/property fields; produced e.g. by `Column() { … }.alignItems(x)`
    // in some chain positions — it ONLY occurs in attribute chains).
    if (node.type === 'call_expression') {
      const fn = getChildByField(node, 'function');
      if (fn?.type === 'member_expression' || fn?.type === 'arkui_dsl_decorator_member_expression') {
        const obj = getChildByField(fn, 'object');
        const prop = getChildByField(fn, 'property');
        if (
          prop &&
          (fn.type === 'arkui_dsl_decorator_member_expression' ||
            obj?.type === 'call_expression' ||
            obj?.type === 'arkui_component_expression')
        ) {
          emitAttr(prop);
          if (/^on[A-Z]/.test(getNodeText(prop, this.source))) {
            emitThisHandlers(getChildByField(node, 'arguments'));
          }
          return;
        }
      }
      // The INNERMOST call of a proper-form detached chain
      // (`.alignItems(x).layoutWeight(1)…` under a leading_dot_expression)
      // has a BARE IDENTIFIER function — the leading dot was consumed by
      // the wrapper, so it masquerades as a plain `alignItems(...)` call.
      // Walk up the member/call alternation; topping out at
      // leading_dot_expression means the dot belongs to this chain.
      if (fn?.type === 'identifier') {
        let p: SyntaxNode | null = node.parent;
        while (p && (p.type === 'member_expression' || p.type === 'call_expression')) {
          p = p.parent;
        }
        if (p?.type === 'leading_dot_expression') {
          emitAttr(fn);
          if (/^on[A-Z]/.test(getNodeText(fn, this.source))) {
            emitThisHandlers(getChildByField(node, 'arguments'));
          }
          return;
        }
      }
      // Not a chained attribute — fall through to the generic call paths.
    }

    // Shape 3: detached chain segment — leading_dot_expression whose only
    // named child is a bare identifier; its arguments sit in the NEXT
    // sibling statement as a parenthesized_expression.
    if (node.type === 'leading_dot_expression') {
      const only = node.namedChildCount === 1 ? node.namedChild(0) : null;
      if (only && only.type === 'identifier') {
        emitAttr(only);
        if (/^on[A-Z]/.test(getNodeText(only, this.source))) {
          const stmt = node.parent; // expression_statement
          const nextStmt = stmt?.nextNamedSibling;
          const paren = nextStmt?.namedChild(0);
          if (paren?.type === 'parenthesized_expression') {
            emitThisHandlers(paren);
          }
        }
      }
      // The proper form (child is a call_expression chain, as inside
      // `@Extend` bodies) needs nothing here — the walker descends into it
      // and the inner call_expressions take the paths above.
      return;
    }
  }

  // Get the function/method being called
  let calleeName = '';

  // Java/Kotlin method_invocation has 'object' + 'name' fields instead of 'function'
  // PHP member_call_expression has 'object' + 'name', scoped_call_expression has 'scope' + 'name'
  const nameField = getChildByField(node, 'name');
  const objectField = getChildByField(node, 'object') || getChildByField(node, 'scope');

  if (nameField && objectField && (node.type === 'method_invocation' || node.type === 'member_call_expression' || node.type === 'scoped_call_expression')) {
    // Method call with explicit receiver: receiver.method() / $receiver->method() / ClassName::method()
    const methodName = getNodeText(nameField, this.source);
    // Java `this.userbo.toLogin2()` parses as method_invocation(object=field_access(this, userbo)).
    // Without unwrapping, receiverName is `this.userbo` and the name-matcher's
    // single-dot receiver regex fails. Pull out the immediate field after `this.`
    // so the receiver is the field name (`userbo`), which the resolver can then
    // look up in the enclosing class's field declarations.
    // PHP static-factory fluent chain: `Cls::for($x)->method()` — the receiver
    // is itself a static call, so resolution must infer the method's class
    // from what `Cls::for` RETURNS (its `: self` / `: static` / `: Type`),
    // #608 (mirrors the C++ chain fix in #645). Encode `<Cls::factory>().<method>`;
    // the `().` marker lets the PHP resolver split it. The receiver text
    // (`Cls::for('x')`) carries the args, so without this it degrades to an
    // unresolvable string and the call edge is dropped.
    if (methodName && this.language === 'php' && objectField.type === 'scoped_call_expression') {
      const innerScope = getChildByField(objectField, 'scope');
      const innerName = getChildByField(objectField, 'name');
      if (innerScope && innerName) {
        calleeName = `${getNodeText(innerScope, this.source)}::${getNodeText(innerName, this.source)}().${methodName}`;
      } else {
        calleeName = methodName;
      }
      if (calleeName) {
        this.unresolvedReferences.push({
          fromNodeId: callerId,
          referenceName: calleeName,
          referenceKind: 'calls',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return;
    }

    // Java static-factory / fluent chain: `Foo.getInstance().bar()` — the
    // receiver is itself a method call, so resolution must infer bar's class
    // from what `Foo.getInstance` RETURNS (its declared return type), the
    // #645/#608 mechanism. Encode `<inner-receiver>.<inner-method>().<method>`;
    // the `().` marker lets the Java chain resolver split it, and normalizing to
    // empty parens drops any factory args (`Foo.create(cfg).bar()`) that would
    // otherwise leave a `(cfg)` in the receiver text and break the split.
    if (
      methodName &&
      this.language === 'java' &&
      objectField.type === 'method_invocation'
    ) {
      const innerObj = getChildByField(objectField, 'object');
      const innerName = getChildByField(objectField, 'name');
      if (innerObj && innerName) {
        calleeName = `${getNodeText(innerObj, this.source)}.${getNodeText(innerName, this.source)}().${methodName}`;
        this.unresolvedReferences.push({
          fromNodeId: callerId,
          referenceName: calleeName,
          referenceKind: 'calls',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
        return;
      }
    }

    let receiverName: string;
    if (objectField.type === 'field_access') {
      const inner = getChildByField(objectField, 'object');
      const fld = getChildByField(objectField, 'field');
      if (inner && fld && (inner.type === 'this' || inner.type === 'this_expression')) {
        receiverName = getNodeText(fld, this.source);
      } else {
        receiverName = getNodeText(objectField, this.source);
      }
    } else {
      receiverName = getNodeText(objectField, this.source);
    }
    // Strip PHP $ prefix from variable names
    receiverName = receiverName.replace(/^\$/, '');

    if (methodName) {
      // Skip self/this/parent/static receivers — they don't aid resolution
      const SKIP_RECEIVERS = new Set(['self', 'this', 'cls', 'super', 'parent', 'static']);
      if (SKIP_RECEIVERS.has(receiverName)) {
        calleeName = methodName;
      } else {
        calleeName = `${receiverName}.${methodName}`;
      }
    }
  } else if (node.type === 'message_expression') {
    // ObjC message expressions emit one `method` field child per selector
    // keyword: `[obj a:1 b:2 c:3]` has three `method=identifier` siblings.
    // Joining them with `:` reconstructs the full selector and matches the
    // multi-part selector names produced by the ObjC method_definition
    // extractor (`extractObjcMethodName` in languages/objc.ts). Without this
    // join, multi-keyword call sites only emitted the first keyword and never
    // resolved to their target methods (e.g. `GET:parameters:headers:...` had
    // zero callers despite obviously being called).
    const methodKeywords: string[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      if (node.fieldNameForNamedChild(i) === 'method') {
        const kw = node.namedChild(i);
        if (kw) methodKeywords.push(getNodeText(kw, this.source));
      }
    }
    if (methodKeywords.length > 0) {
      // A selector keyword takes a `:` when it has an argument. A SINGLE
      // keyword can be unary (`[c reset]` → `reset`) OR take one argument
      // (`[c storeImage:k]` → `storeImage:`) — distinguished by whether the
      // message has a `:` token. Without this, every single-argument message
      // (the most common form: `addObject:`, `storeImage:`, …) was named
      // without the colon and never matched its `storeImage:` method.
      let hasColon = false;
      for (let i = 0; i < node.childCount; i++) {
        if (node.child(i)?.type === ':') { hasColon = true; break; }
      }
      const methodName: string = hasColon
        ? methodKeywords.map((k) => `${k}:`).join('')
        : (methodKeywords[0] as string);
      const receiverField = getChildByField(node, 'receiver');
      const SKIP_RECEIVERS = new Set(['self', 'super']);
      if (receiverField && receiverField.type !== 'message_expression') {
        const receiverName = getNodeText(receiverField, this.source);
        if (receiverName && !SKIP_RECEIVERS.has(receiverName)) {
          calleeName = `${receiverName}.${methodName}`;
          // A CLASS-message receiver (`[SDImageCache alloc]`,
          // `[SDImageCache sharedCache]`) is a capitalized class name. The
          // call resolves the method (`alloc`/`sharedCache`), but the CLASS
          // itself — whose @interface lives in the header — would otherwise
          // never be referenced. Emit a `references` edge to it so a class
          // used only via class messages (alloc/init, singletons, factories)
          // and its header record a dependent.
          if (/^[A-Z][A-Za-z0-9_]*$/.test(receiverName)) {
            this.unresolvedReferences.push({
              fromNodeId: callerId,
              referenceName: receiverName,
              referenceKind: 'references',
              line: receiverField.startPosition.row + 1,
              column: receiverField.startPosition.column,
            });
          }
        } else {
          calleeName = methodName;
        }
      } else if (receiverField && receiverField.type === 'message_expression' && /^\w+$/.test(methodName)) {
        // Chained message send `[[Foo create] doIt]` — the receiver is itself a
        // class message. Recover the inner `Class.selector` and encode
        // `Class.selector().doIt` so resolution infers doIt's class from what
        // `Class.selector` RETURNS (#645/#608). Only a CLASS-factory chain
        // (capitalized inner receiver); a unary outer selector is required
        // because the chain resolver's method part is `\w+` (no `:`). An
        // instance chain (`[[obj foo] bar]`, lowercase inner) stays bare.
        const innerRecv = getChildByField(receiverField, 'receiver');
        const innerRecvName = innerRecv ? getNodeText(innerRecv, this.source) : '';
        if (innerRecv?.type === 'identifier' && /^[A-Z]/.test(innerRecvName)) {
          const innerKw: string[] = [];
          for (let i = 0; i < receiverField.namedChildCount; i++) {
            if (receiverField.fieldNameForNamedChild(i) === 'method') {
              const kw = receiverField.namedChild(i);
              if (kw) innerKw.push(getNodeText(kw, this.source));
            }
          }
          let innerColon = false;
          for (let i = 0; i < receiverField.childCount; i++) {
            if (receiverField.child(i)?.type === ':') { innerColon = true; break; }
          }
          const innerSelector = innerColon ? innerKw.map((k) => `${k}:`).join('') : innerKw[0];
          calleeName = innerSelector ? `${innerRecvName}.${innerSelector}().${methodName}` : methodName;
        } else {
          calleeName = methodName;
        }
      } else {
        calleeName = methodName;
      }
    }
  } else {
    const func = getChildByField(node, 'function') || node.namedChild(0);

    // C++ explicit operator call `a.operator+(b)` / `p->operator+(b)` (#1247):
    // tree-sitter-cpp can't parse an operator_name in field position, so the
    // callee is NOT a field_expression — the call_expression carries
    // `function: <receiver>` plus an ERROR child wrapping the operator_name.
    // Reading the function field alone yields just the receiver (`a`), an
    // unresolvable ref. Recover `<receiver>.operator+` so it resolves like any
    // other member call (matchMethodCall admits the operator method part).
    // The infix forms `a + b` / `a[i]` need receiver type inference and are
    // tracked separately (#1258).
    if (this.language === 'cpp' && func) {
      let operatorName = '';
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type !== 'ERROR') continue;
        const op = child.namedChildren.find((c: SyntaxNode) => c.type === 'operator_name');
        if (op) { operatorName = getNodeText(op, this.source); break; }
      }
      if (operatorName) {
        // Call sites may space the symbolic name (nlohmann/json's
        // `it.operator * ()`, `other.operator < (*this)`) while definitions
        // index compact (`operator*`) — normalize so they match. The word
        // forms (`operator new`) keep their space.
        const sym = operatorName.slice('operator'.length).trim();
        if (/^[^\w\s]/.test(sym)) operatorName = `operator${sym.replace(/\s+/g, '')}`;
        // `->` receivers resolve identically to `.` ones. A receiver that
        // isn't a simple identifier/member chain (`(*it)`, a call result, …)
        // can't aid type inference, and a bare operator name would fall
        // through to exact-name matching — which GUESSES among the many
        // same-named operators (on nlohmann/json it linked a std::map
        // `object->operator[]` call to an unrelated in-repo operator[]).
        // Drop the ref: a silent miss, never a wrong edge. `this->` keeps
        // the bare name, matching how `this.method()` calls are emitted —
        // the target is on the enclosing class, where exact-name's same-file
        // preference is reliable.
        const receiver = getNodeText(func, this.source).replace(/->/g, '.').replace(/\s+/g, '');
        if (receiver !== 'this' && !/^[A-Za-z_][\w.]*$/.test(receiver)) return;
        const calleeName = receiver === 'this' ? operatorName : `${receiver}.${operatorName}`;
        this.unresolvedReferences.push({
          fromNodeId: callerId,
          referenceName: calleeName,
          referenceKind: 'calls',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
        return;
      }
    }

    if (func) {
      if (func.type === 'member_expression' || func.type === 'attribute' || func.type === 'selector_expression' || func.type === 'navigation_expression' || func.type === 'field_expression') {
        // Method call: obj.method() or obj.field.method()
        // Go uses selector_expression with 'field', JS/TS uses member_expression with 'property'
        // Kotlin uses navigation_expression with navigation_suffix > simple_identifier
        // C/C++ use field_expression for both `obj.method()` and `ptr->method()`
        let property = getChildByField(func, 'property') || getChildByField(func, 'field');
        if (!property) {
          const child1 = func.namedChild(1);
          // Kotlin: navigation_suffix wraps the method name — extract simple_identifier from it
          if (child1?.type === 'navigation_suffix') {
            property = child1.namedChildren.find((c: SyntaxNode) => c.type === 'simple_identifier') ?? child1;
          } else {
            property = child1;
          }
        }
        if (property) {
          const methodName = getNodeText(property, this.source);
          // Include receiver name for qualified resolution (e.g., console.print → "console.print")
          // This helps the resolver distinguish method calls from bare function calls
          // (e.g., Python's console.print() vs builtin print())
          // Skip self/this/cls as they don't aid resolution
          const receiver =
            getChildByField(func, 'object') ||
            getChildByField(func, 'operand') ||
            getChildByField(func, 'argument') ||
            func.namedChild(0);
          // A LITERAL receiver — `", ".join(...)`, `"x".toUpperCase()`,
          // `5.times`, `[].concat(...)` — calls a builtin of the literal's
          // type, never a project symbol. The bare-name fallback below let
          // these exact-match an unrelated same-named project function
          // (`", ".join` bound to a local `join` defined inside a DIFFERENT
          // function, #1230). Emit nothing: a silent miss, never a wrong
          // edge. Nested calls in the arguments are visited independently.
          if (receiver && LITERAL_RECEIVER_TYPES.has(receiver.type)) {
            return;
          }
          const SKIP_RECEIVERS = new Set(['self', 'this', 'cls', 'super']);
          if (receiver && ['typescript', 'tsx', 'javascript', 'jsx'].includes(this.language)) {
            // Preserve the receiver even when it is a field/factory chain or
            // `this`: a bare method name can bind to an unrelated class.
            calleeName = `${getNodeText(receiver, this.source).replace(/\s+/g, '')}.${methodName}`;
          } else if (receiver && (receiver.type === 'identifier' || receiver.type === 'simple_identifier' || receiver.type === 'field_identifier')) {
            const receiverName = getNodeText(receiver, this.source);
            if (!SKIP_RECEIVERS.has(receiverName)) {
              calleeName = `${receiverName}.${methodName}`;
            } else {
              calleeName = methodName;
            }
          } else if (
            (this.language === 'cpp' ||
              this.language === 'c' ||
              this.language === 'kotlin' ||
              this.language === 'swift' ||
              this.language === 'rust' ||
              this.language === 'go' ||
              this.language === 'scala') &&
            receiver &&
            receiver.type === 'call_expression'
          ) {
            // Receiver that is itself a call — `Foo::instance().bar()`,
            // `openSession()->run()`, `mgr.view().render()` (C/C++),
            // `Foo.getInstance().bar()` (Kotlin) / `Foo.make().draw()` (Swift),
            // `Foo::new().bar()` (Rust), or `New().Method()` (Go). Keep the inner
            // call so resolution can infer bar()'s class from what the inner call
            // RETURNS (#645/#608). Encode as `<innerCallee>().<method>`; the `().`
            // marker never appears in an ordinary ref, so the resolver can detect
            // and split it. Other languages keep the bare-name behavior below.
            let innerCallee: string;
            let reencode: boolean;
            if (this.language === 'kotlin' || this.language === 'swift') {
              // tree-sitter-kotlin/swift expose the inner callee as the
              // call_expression's first named child (a navigation_expression
              // `Foo.getInstance`, or a bare identifier for a free/constructor call).
              const innerNav = receiver.namedChild(0);
              innerCallee = innerNav ? getNodeText(innerNav, this.source).replace(/\s+/g, '') : '';
              // Only re-encode a CLASS / companion-factory / constructor chain,
              // whose receiver chain starts with a capitalized type
              // (`Foo.getInstance().bar()`, `Foo().bar()`). An instance chain
              // (`list.filter{}.map{}`) has a lowercase receiver whose type we
              // can't recover here — re-encoding it would only drop the edge (no
              // chain resolution, no bare-name fallback), regressing recall in
              // fluent codebases. Leave those to the bare-name path.
              reencode = /^[A-Z]/.test(innerCallee);
            } else {
              const innerFn = getChildByField(receiver, 'function');
              innerCallee = innerFn
                ? getNodeText(innerFn, this.source).replace(/->/g, '.').replace(/\s+/g, '')
                : '';
              // Rust: only re-encode an associated-function chain
              // (`Foo::new().bar()`), whose inner callee is a path/`scoped_identifier`.
              // Go: only a bare package-level factory chain (`New().Method()`),
              // whose inner callee is an `identifier`. An instance chain
              // (`x.foo().bar()` Rust, `obj.Method().Other()` Go) keeps bare-name —
              // the resolver can't recover a variable's type, so re-encoding would
              // only drop the edge. C/C++ re-encode any inner.
              if (this.language === 'rust') reencode = innerFn?.type === 'scoped_identifier';
              else if (this.language === 'go') reencode = innerFn?.type === 'identifier';
              // Scala: only a companion-factory / case-class-apply chain whose
              // receiver chain starts with a capitalized type (`Foo.create().bar()`,
              // `Foo(args).bar()`). An instance chain (`list.map().filter()`) has a
              // lowercase receiver whose type we can't recover — leave it bare.
              else if (this.language === 'scala') reencode = /^[A-Z]/.test(innerCallee);
              else reencode = !!innerCallee;
            }
            calleeName = reencode ? `${innerCallee}().${methodName}` : methodName;
          } else if (
            this.language === 'cfscript' &&
            receiver &&
            receiver.type === 'member_expression' &&
            /^(variables|this|local|arguments)\.[A-Za-z_]\w*$/i.test(getNodeText(receiver, this.source))
          ) {
            // CFML scope-prefixed member call — `variables.svc.save()` /
            // `arguments.svc.save()`: the receiver is a component field,
            // injected property, or typed argument reached through one of
            // CFML's file-local scopes. Keep the full receiver chain so
            // resolution can strip the scope prefix and infer the field's
            // component type from its declaration (#1108). Gated to these
            // scope keywords: such calls previously emitted a bare method
            // name, which either failed to resolve or resolved ambiguously.
            calleeName = `${getNodeText(receiver, this.source)}.${methodName}`;
          } else if (
            this.language === 'go' &&
            receiver &&
            receiver.type === 'selector_expression' &&
            /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(getNodeText(receiver, this.source).replace(/\s+/g, ''))
          ) {
            // Go 2-hop field chain `target.conn.Exec(...)`: keep the
            // receiver chain so resolution can infer `conn`'s declared type
            // from the Target struct. Previously this emitted the bare
            // method name, and when the field's type is EXTERNAL (sql.DB)
            // the bare name exact-matched an unrelated same-named local
            // method — a fabricated internal dependency (#1276). Chained
            // Go receivers resolve strictly via validated field-hop
            // inference (see matchGoFieldChainCall) or stay unresolved.
            calleeName = `${getNodeText(receiver, this.source).replace(/\s+/g, '')}.${methodName}`;
          } else {
            calleeName = methodName;
          }
        }
      } else if (func.type === 'scoped_identifier' || func.type === 'scoped_call_expression') {
        // Scoped call: Module::function()
        calleeName = getNodeText(func, this.source);
      } else if (this.language === 'csharp' && func.type === 'member_access_expression') {
        // C# member call `recv.Method(...)`. When the receiver is itself a call
        // — a chained factory `Foo.Create(args).Bar()` — encode `inner().Bar`
        // with normalized empty parens so resolution can infer Bar's class from
        // what `Foo.Create` RETURNS (#645/#608). A non-call receiver keeps the
        // full member-access text (the existing `recv.Method` behavior).
        const recv = getChildByField(func, 'expression');
        const nameNode = getChildByField(func, 'name');
        const methodName = nameNode ? getNodeText(nameNode, this.source) : '';
        if (recv && recv.type === 'invocation_expression' && methodName) {
          const innerFunc = getChildByField(recv, 'function');
          const innerCallee = innerFunc ? getNodeText(innerFunc, this.source).replace(/\s+/g, '') : '';
          calleeName = innerCallee ? `${innerCallee}().${methodName}` : methodName;
        } else {
          calleeName = getNodeText(func, this.source);
        }
      } else {
        calleeName = getNodeText(func, this.source);
      }
    }
  }

  // Parenthesized type conversions — Go `(*T)(x)` / `(T)(x)` (and a
  // parenthesized callee generally) parse as a call whose "function" is a
  // parenthesized type/expression, so the callee text is the un-resolvable
  // literal `(*T)`. Normalize to the inner name so it resolves to `T` (a real
  // dependency on the converted-to type) instead of dropping on the floor.
  if (calleeName) {
    const conv = calleeName.match(/^\(\s*\*?\s*([A-Za-z_][\w.]*)\s*\)$/);
    if (conv && conv[1]) calleeName = conv[1];
  }

  // C/C++ templated callees — a direct templated call (`fn<T, 256>(args)`,
  // the shape every CUDA kernel-launch site takes once its `<<<…>>>` config
  // is blanked) or a qualified one (`ns::fn<T>(args)`) — carry template
  // arguments in the callee text, which can never match the bare name the
  // function was DEFINED as, so the call edge silently never resolves. Strip
  // them: the same normalization base-class `extends` refs already get
  // (#1043). `operator<`/`operator<<` callees are excluded — their `<` is the
  // operator itself, not a template-argument list.
  if (
    calleeName &&
    calleeName.includes('<') &&
    (this.language === 'cpp' || this.language === 'c') &&
    !calleeName.includes('operator')
  ) {
    calleeName = stripCppTemplateArgs(calleeName);
  }

  // C++ call/launch through a local function pointer: `auto kernel =
  // &flash_fwd_kernel<…>; … kernel<<<grid, block>>>(params);` — the callee
  // is an unresolvable local name. When the same enclosing symbol bound the
  // local from `&fn` (each branch assignment counts), emit the call against
  // every recorded target instead of the local.
  if (calleeName && this.language === 'cpp' && /^[A-Za-z_]\w*$/.test(calleeName)) {
    const targets = this.cppLocalFnPtrs.get(callerId)?.get(calleeName);
    if (targets && targets.size > 0) {
      for (const target of targets) {
        this.unresolvedReferences.push({
          fromNodeId: callerId,
          referenceName: target,
          referenceKind: 'calls',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return;
    }
  }

  if (calleeName) {
    this.unresolvedReferences.push({
      fromNodeId: callerId,
      referenceName: calleeName,
      referenceKind: 'calls',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }
}
