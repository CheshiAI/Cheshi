import {
  Node,
  NodeKind
} from '../types';
import type { Node as SyntaxNode } from '../web-tree-sitter';
import { getChildByField, getNodeText, getPrecedingDocstring } from './tree-sitter-helpers';
import type { TreeSitterState } from './tree-sitter-state';
import {
  cDeclaratorIdentifier,
  extractName,
  hasFunctionAncestor,
  RTK_HOOK_NAME_RE,
  swiftPropertyInfo,
  VUE_STORE_COLLECTION_NAMES,
  VUE_STORE_FACTORY_CALLEES,
  VUE_STORE_FILE_SIGNAL
} from './tree-sitter-syntax';

/**
   * Extract function-valued properties of an object literal as named function
   * nodes (named by their property key). Shared by the two object-of-functions
   * shapes in extractVariable: the object as a direct const value, and the
   * object returned by a store-initializer call. Handles both `key: () => {}` /
   * `key: function() {}` pairs and method shorthand `key() {}`.
   */
export function extractObjectLiteralFunctions(this: TreeSitterState, obj: SyntaxNode): void {
  for (let i = 0; i < obj.namedChildCount; i++) {
    const member = obj.namedChild(i);
    if (!member) continue;
    if (member.type === 'pair') {
      const key = getChildByField(member, 'key');
      const value = getChildByField(member, 'value');
      if (key && value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
        this.extractFunction(value, this.objectKeyName(key));
      }
    } else if (member.type === 'method_definition') {
      // Method shorthand: `{ fetchUser() {...} }`. extractMethod deliberately
      // skips object-literal methods, so route through extractFunction with an
      // explicit name (method_definition exposes a `body` field, so resolveBody
      // falls through to it and the node spans the full method).
      const key = getChildByField(member, 'name');
      if (key) this.extractFunction(member, this.objectKeyName(key));
    }
  }
}

/** Property-key text with surrounding quotes stripped (`'foo'` → `foo`). */
export function objectKeyName(this: TreeSitterState, key: SyntaxNode): string {
  return getNodeText(key, this.source).replace(/^['"`]|['"`]$/g, '');
}

/**
   * Given a `call_expression` initializer (`create((set, get) => ({...}))`),
   * find the object literal RETURNED by a function argument — descending through
   * nested call_expression arguments so middleware wrappers are unwrapped
   * (`create(persist((set, get) => ({...}), {...}))`, devtools, immer,
   * subscribeWithSelector). Returns null when no such object is found — the
   * common case for ordinary call initializers — so this stays cheap and silent
   * rather than guessing. Keyed purely on AST shape; no library names.
   */
export function findInitializerReturnedObject(this: TreeSitterState, callNode: SyntaxNode, depth = 0): SyntaxNode | null {
  if (depth > 4) return null;
  const args = getChildByField(callNode, 'arguments');
  if (!args) return null;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (!arg) continue;
    if (arg.type === 'arrow_function' || arg.type === 'function_expression') {
      const obj = this.functionReturnedObject(arg);
      if (obj) return obj;
    } else if (arg.type === 'call_expression') {
      const obj = this.findInitializerReturnedObject(arg, depth + 1);
      if (obj) return obj;
    }
  }
  return null;
}

/**
   * The object literal a function expression returns — either the `=> ({...})`
   * arrow form (a parenthesized_expression wrapping an object) or a
   * `=> { return {...} }` block. Returns null for any other body shape.
   */
export function functionReturnedObject(this: TreeSitterState, fnNode: SyntaxNode): SyntaxNode | null {
  const body = getChildByField(fnNode, 'body');
  if (!body) return null;
  const asObject = (n: SyntaxNode | null): SyntaxNode | null => {
    if (!n) return null;
    if (n.type === 'object' || n.type === 'object_expression') return n;
    if (n.type === 'parenthesized_expression') {
      for (let i = 0; i < n.namedChildCount; i++) {
        const inner = asObject(n.namedChild(i));
        if (inner) return inner;
      }
    }
    return null;
  };
  // `(set, get) => ({...})` — body is the (parenthesized) object directly.
  const direct = asObject(body);
  if (direct) return direct;
  // `(set, get) => { return {...} }` — scan top-level return statements.
  if (body.type === 'statement_block') {
    for (let i = 0; i < body.namedChildCount; i++) {
      const stmt = body.namedChild(i);
      if (stmt?.type !== 'return_statement') continue;
      for (let j = 0; j < stmt.namedChildCount; j++) {
        const obj = asObject(stmt.namedChild(j));
        if (obj) return obj;
      }
    }
  }
  return null;
}

/**
   * RTK Query: from a `createApi({ ..., endpoints: build => ({...}) })` or a
   * `baseApi.injectEndpoints({ endpoints: build => ({...}) })` call initializer,
   * return the object literal of endpoint definitions (the object the `endpoints`
   * arrow returns). Returns null for any other call — the common case — so this
   * stays cheap and silent. Keyed on the RTK entry-point names (`createApi` /
   * `injectEndpoints`) like the framework extractors key on their library APIs.
   */
export function findRtkEndpointsObject(this: TreeSitterState, callNode: SyntaxNode): SyntaxNode | null {
  const callee = getChildByField(callNode, 'function');
  if (!callee) return null;
  const calleeName =
    callee.type === 'identifier'
      ? getNodeText(callee, this.source)
      : callee.type === 'member_expression'
        ? getNodeText(getChildByField(callee, 'property') ?? callee, this.source)
        : '';
  if (calleeName !== 'createApi' && calleeName !== 'injectEndpoints') return null;
  const args = getChildByField(callNode, 'arguments');
  if (!args) return null;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (arg?.type !== 'object' && arg?.type !== 'object_expression') continue;
    for (let j = 0; j < arg.namedChildCount; j++) {
      const member = arg.namedChild(j);
      // Two equally-common spellings: `endpoints: build => ({...})` (pair with an
      // arrow value) and `endpoints(build) { return {...} }` (method shorthand).
      if (member?.type === 'pair') {
        const key = getChildByField(member, 'key');
        if (!key || getNodeText(key, this.source) !== 'endpoints') continue;
        const value = getChildByField(member, 'value');
        if (value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
          return this.functionReturnedObject(value);
        }
      } else if (member?.type === 'method_definition') {
        const key = getChildByField(member, 'name');
        if (!key || getNodeText(key, this.source) !== 'endpoints') continue;
        return this.functionReturnedObject(member);
      }
    }
  }
  return null;
}

/**
   * Extract each RTK Query endpoint (`getX: build.query({...})` / `build.mutation`)
   * as a function node named by the endpoint key, spanning its primary handler
   * (the `queryFn`/`query` arrow) so the fetch logic's calls attribute to the
   * endpoint. Without this an endpoint exists only as an object-literal property —
   * never a node — so the generated `useXQuery` hook can't be bridged to it.
   */
export function extractRtkEndpoints(this: TreeSitterState, obj: SyntaxNode): void {
  for (let i = 0; i < obj.namedChildCount; i++) {
    const member = obj.namedChild(i);
    if (member?.type !== 'pair') continue;
    const key = getChildByField(member, 'key');
    const value = getChildByField(member, 'value');
    if (!key || value?.type !== 'call_expression') continue;
    // The value must be a builder dispatch `<builder>.query|mutation(...)`.
    const callee = getChildByField(value, 'function');
    if (callee?.type !== 'member_expression') continue;
    const method = getNodeText(getChildByField(callee, 'property') ?? callee, this.source);
    if (method !== 'query' && method !== 'mutation' && method !== 'infiniteQuery') continue;
    const handler = this.rtkEndpointHandler(value);
    if (handler) {
      this.extractFunction(handler, this.objectKeyName(key));
    } else {
      // Factory / config-only handler (`queryFn: makeQueryFn(url)`): no function
      // literal to name. Mint a bare endpoint node spanning the builder call so
      // the generated hook still bridges to it, and walk the call so its handler
      // factory (and any inline transform) is captured as an outgoing edge.
      const epNode = this.createNode('function', this.objectKeyName(key), value, {
        signature: getNodeText(value, this.source).slice(0, 80),
      });
      if (epNode) {
        this.nodeStack.push(epNode.id);
        this.visitFunctionBody(value, epNode.id);
        this.nodeStack.pop();
      }
    }
  }
}

/**
   * The primary handler arrow of a `build.query({ queryFn|query: (…) => … })`
   * endpoint — prefers `queryFn`, then `query`, else the first function-valued
   * property. Returns null when the endpoint is config-only (no handler arrow).
   */
export function rtkEndpointHandler(this: TreeSitterState, callNode: SyntaxNode): SyntaxNode | null {
  const args = getChildByField(callNode, 'arguments');
  if (!args) return null;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (arg?.type !== 'object' && arg?.type !== 'object_expression') continue;
    let queryFn: SyntaxNode | null = null;
    let query: SyntaxNode | null = null;
    let firstFn: SyntaxNode | null = null;
    for (let j = 0; j < arg.namedChildCount; j++) {
      const member = arg.namedChild(j);
      // The handler may be `queryFn: () => …` / `query: () => …` (pair) or the
      // method-shorthand `query(arg) { … }` / `queryFn(arg) { … }`.
      let fn: SyntaxNode | null = null;
      let kn = '';
      if (member?.type === 'pair') {
        const v = getChildByField(member, 'value');
        if (v?.type === 'arrow_function' || v?.type === 'function_expression') {
          fn = v;
          const k = getChildByField(member, 'key');
          kn = k ? getNodeText(k, this.source) : '';
        }
      } else if (member?.type === 'method_definition') {
        fn = member;
        const k = getChildByField(member, 'name');
        kn = k ? getNodeText(k, this.source) : '';
      }
      if (!fn) continue;
      if (kn === 'queryFn') queryFn = fn;
      else if (kn === 'query') query = fn;
      if (!firstFn) firstFn = fn;
    }
    if (queryFn) return queryFn;
    if (query) return query;
    if (firstFn) return firstFn;
  }
  return null;
}

/**
   * RTK Query generated-hook bindings. `export const { useGetXQuery,
   * useUpdateYMutation } = someApi` destructures the hooks RTK generates per
   * endpoint off a createApi result. They are real exported symbols that
   * components import, but destructured bindings aren't otherwise extracted —
   * mint a function node per binding matching the RTK hook convention so the hook
   * resolves and the synthesizer can bridge it to its endpoint. Gated tight by the
   * caller (object-pattern off a bare identifier) + the name convention here, so
   * ordinary destructures stay unextracted.
   */
export function extractRtkHookBindings(this: TreeSitterState, pattern: SyntaxNode, isExported: boolean): void {
  for (let i = 0; i < pattern.namedChildCount; i++) {
    const binding = pattern.namedChild(i);
    if (binding?.type !== 'shorthand_property_identifier_pattern') continue;
    const name = getNodeText(binding, this.source);
    if (!RTK_HOOK_NAME_RE.test(name)) continue;
    this.createNode('function', name, binding, {
      isExported,
      signature: '= RTK Query generated hook',
    });
  }
}

/** Cheap per-file heuristic: the file carries ≥2 distinct Vue-store signals
   *  (defineStore/createStore/Vuex, or the actions/mutations/getters/namespaced
   *  vocabulary). Gates the non-exported `const actions = {…}` Vuex-module form so
   *  a stray `const actions` in unrelated code is never mistaken for a store. */
export function looksLikeVueStoreFile(this: TreeSitterState): boolean {
  if (this.vueStoreFile !== null) return this.vueStoreFile;
  const seen = new Set<string>();
  VUE_STORE_FILE_SIGNAL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VUE_STORE_FILE_SIGNAL.exec(this.source))) {
    seen.add(m[0]);
    if (seen.size >= 2) break;
  }
  this.vueStoreFile = seen.size >= 2;
  return this.vueStoreFile;
}

/** True if an object literal has ≥1 inline function member (`key: () => …` /
   *  `method(){}`) — distinguishes an inline action map (zustand/SvelteKit form
   *  actions) from a Pinia SETUP store's all-shorthand `return { foo, bar }`
   *  (whose functions are body-local consts, walked normally instead). */
export function objectHasInlineFunctions(this: TreeSitterState, obj: SyntaxNode): boolean {
  for (let i = 0; i < obj.namedChildCount; i++) {
    const member = obj.namedChild(i);
    if (member?.type === 'method_definition') return true;
    if (member?.type === 'pair') {
      const v = getChildByField(member, 'value');
      if (v?.type === 'arrow_function' || v?.type === 'function_expression') return true;
    }
  }
  return false;
}

/** Vue store action/mutation/getter collections defined INLINE in a store call:
   *  `defineStore({ actions: {…}, getters: {…} })` (Pinia options form),
   *  `defineStore('id', { actions: {…} })`, `createStore({ mutations: {…} })`,
   *  `new Vuex.Store({ actions: {…} })`. Returns the object literals under those
   *  keys so their methods become nodes. Gated on the store-factory callee. */
export function findVueStoreCollectionObjects(this: TreeSitterState, callNode: SyntaxNode): SyntaxNode[] {
  const callee = getChildByField(callNode, 'function') ?? getChildByField(callNode, 'constructor');
  if (!callee) return [];
  const calleeName =
    callee.type === 'identifier'
      ? getNodeText(callee, this.source)
      : callee.type === 'member_expression'
        ? getNodeText(getChildByField(callee, 'property') ?? callee, this.source)
        : '';
  if (!VUE_STORE_FACTORY_CALLEES.has(calleeName) && calleeName !== 'Store') return [];
  const args = getChildByField(callNode, 'arguments');
  if (!args) return [];
  const objects: SyntaxNode[] = [];
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (arg?.type !== 'object' && arg?.type !== 'object_expression') continue;
    for (let j = 0; j < arg.namedChildCount; j++) {
      const member = arg.namedChild(j);
      if (member?.type !== 'pair') continue;
      const key = getChildByField(member, 'key');
      if (!key || !VUE_STORE_COLLECTION_NAMES.has(getNodeText(key, this.source))) continue;
      const value = getChildByField(member, 'value');
      if (value && (value.type === 'object' || value.type === 'object_expression')) {
        objects.push(value);
      }
    }
  }
  return objects;
}

/** Extract the methods of a store-config object's `actions`/`mutations`/`getters`
   *  properties. Used for the canonical Vuex MODULE shape `export default {
   *  namespaced, actions: {…}, mutations: {…} }` — object-literal methods aren't
   *  otherwise extracted, so the actions/mutations would never be nodes. */
export function extractStoreCollectionMethods(this: TreeSitterState, configObj: SyntaxNode): void {
  for (let j = 0; j < configObj.namedChildCount; j++) {
    const member = configObj.namedChild(j);
    if (member?.type !== 'pair') continue;
    const key = getChildByField(member, 'key');
    if (!key || !VUE_STORE_COLLECTION_NAMES.has(getNodeText(key, this.source))) continue;
    const value = getChildByField(member, 'value');
    if (value && (value.type === 'object' || value.type === 'object_expression')) {
      this.extractObjectLiteralFunctions(value);
    }
  }
}

/** The SETUP function of a Pinia setup store (`defineStore('id', () => {…})`)
   *  — an arrow/function arg with a block body. Returns null for the options form
   *  (`defineStore({…})`) and for any non-defineStore call. The setup body's local
   *  function consts are the store's actions; the generic body walk doesn't reach
   *  them (nested functions are separate scopes), so they're extracted explicitly. */
export function findPiniaSetupFn(this: TreeSitterState, callNode: SyntaxNode): SyntaxNode | null {
  const callee = getChildByField(callNode, 'function');
  if (!callee || callee.type !== 'identifier' || getNodeText(callee, this.source) !== 'defineStore') return null;
  const args = getChildByField(callNode, 'arguments');
  if (!args) return null;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (arg?.type !== 'arrow_function' && arg?.type !== 'function_expression') continue;
    const body = getChildByField(arg, 'body');
    if (body?.type === 'statement_block') return arg; // block body ⇒ setup form
  }
  return null;
}

/** Extract a Pinia setup store's actions: the body-local `const foo = () => …`
   *  / `function foo(){}` declarations, named by the binding. (State refs and other
   *  consts are left to the normal value-extraction; only the functions matter as
   *  the store's callable surface.) */
export function extractPiniaSetupBody(this: TreeSitterState, setupFn: SyntaxNode): void {
  const body = getChildByField(setupFn, 'body');
  if (!body || body.type !== 'statement_block') return;
  for (let i = 0; i < body.namedChildCount; i++) {
    const stmt = body.namedChild(i);
    if (!stmt) continue;
    if (stmt.type === 'function_declaration') {
      this.extractFunction(stmt);
    } else if (this.extractor!.variableTypes.includes(stmt.type)) {
      for (let j = 0; j < stmt.namedChildCount; j++) {
        const decl = stmt.namedChild(j);
        if (decl?.type !== 'variable_declarator') continue;
        const v = getChildByField(decl, 'value');
        if (v?.type === 'arrow_function' || v?.type === 'function_expression') {
          this.extractFunction(v); // name resolved from the parent declarator
        }
      }
    }
  }
}

/**
   * Extract a variable declaration (const, let, var, etc.)
   *
   * Extracts top-level and module-level variable declarations.
   * Captures the variable name and first 100 chars of initializer in signature for searchability.
   */
export function extractVariable(this: TreeSitterState, node: SyntaxNode): void {
  if (!this.extractor) return;

  // Different languages have different variable declaration structures
  // TypeScript/JavaScript: lexical_declaration contains variable_declarator children
  // Python: assignment has left (identifier) and right (value)
  // Go: var_declaration, short_var_declaration, const_declaration

  const isConst = this.extractor.isConst?.(node) ?? false;
  const kind: NodeKind = isConst ? 'constant' : 'variable';
  const docstring = getPrecedingDocstring(node, this.source);
  const isExported = this.extractor.isExported?.(node, this.source) ?? false;

  // Extract variable declarators based on language
  if (this.language === 'typescript' || this.language === 'javascript' ||
    this.language === 'tsx' || this.language === 'jsx' || this.language === 'cfscript' ||
    this.language === 'arkts') {
    // Handle lexical_declaration and variable_declaration
    // These contain one or more variable_declarator children
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'variable_declarator') {
        const nameNode = getChildByField(child, 'name');
        const valueNode = getChildByField(child, 'value');

        if (nameNode) {
          // Skip destructured patterns (e.g., `let { x, y } = $props()` in Svelte)
          // These produce ugly multi-line names like "{ class: className }".
          // EXCEPT `export const { useGetXQuery } = someApi` — the RTK Query
          // generated hooks: real exported symbols destructured off a createApi
          // result. Mint a node per binding matching the hook convention (gated
          // on a bare-identifier RHS so ordinary destructures stay skipped).
          if (nameNode.type === 'object_pattern' || nameNode.type === 'array_pattern') {
            if (nameNode.type === 'object_pattern' && valueNode?.type === 'identifier') {
              this.extractRtkHookBindings(nameNode, isExported);
            }
            continue;
          }
          const name = getNodeText(nameNode, this.source);
          // Arrow functions / function expressions: extract as function instead of variable
          if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')) {
            this.extractFunction(valueNode);
            continue;
          }

          // Capture first 100 chars of initializer for context (stored in signature for searchability)
          const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
          const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

          // React HOC-wrapped components (`forwardRef`/`memo`/`styled`) — see
          // reactComponentHoc. The initializer is a call / tagged-template (not
          // a bare arrow), so without this the const is a plain `constant`,
          // which the JSX-render synthesizer and component resolution both skip
          // → `<Button/>` usages get no edge and callers/impact return empty
          // (the whole shadcn/ui design-system pattern, #841). PascalCase-gated
          // to the component naming convention so a memoization util
          // (`const cache = memo(fn)`) stays a constant.
          if (valueNode && /^[A-Z]/.test(name)) {
            const hoc = this.reactComponentHoc(valueNode);
            if (hoc) {
              this.extractReactComponentNode(name, child, hoc.inner, {
                docstring,
                signature: initSignature,
                isExported,
              });
              continue;
            }
          }

          const varNode = this.createNode(kind, name, child, {
            docstring,
            signature: initSignature,
            isExported,
          });

          // Extract type annotation references (e.g., const x: ITextModel = ...)
          if (varNode) {
            this.extractVariableTypeAnnotation(child, varNode.id);
          }

          // Exported const object-of-functions — extract each function-valued
          // property as a function named by its key + walk its body so its
          // calls are captured. Two shapes, both keyed on AST shape (not on any
          // library name):
          //   `export const actions = { default: async () => {} }` — object is
          //     the DIRECT value (SvelteKit form actions / handler maps / route
          //     tables).
          //   `export const useStore = create((set, get) => ({ fetchUser:
          //     async () => {} }))` — object is RETURNED by an initializer call,
          //     possibly through middleware wrappers (persist/devtools/immer).
          //     Covers Zustand/Redux/Pinia/MobX stores generically. Without
          //     this, store actions exist only as object-literal properties —
          //     never nodes — so `node`/`callers` on `fetchUser` return "not
          //     found" and the agent Reads the store to reconstruct the flow.
          // Scoped to EXPORTED consts to exclude inline-object noise
          // (`ctx.set({...})`) the object-method skip deliberately avoids.
          const objectOfFns =
            valueNode && (valueNode.type === 'object' || valueNode.type === 'object_expression')
              ? valueNode
              : valueNode?.type === 'call_expression'
                ? this.findInitializerReturnedObject(valueNode)
                : null;
          // Only treat as an inline object-of-functions when the object actually
          // HAS inline functions. A Pinia SETUP store `defineStore('id', () => {
          // const foo = …; return { foo } })` returns an ALL-SHORTHAND object
          // whose functions are body-local consts — it must fall through to a
          // normal body walk (extracting those consts), not be skipped here.
          const hasInlineFns = !!objectOfFns && this.objectHasInlineFunctions(objectOfFns);
          const extractObjectMethods = isExported && !!objectOfFns && hasInlineFns;

          // RTK Query: `createApi`/`injectEndpoints` define endpoints as
          // object-literal properties whose values are `build.query/mutation(...)`
          // calls — nested under an `endpoints` arrow, so neither the
          // object-of-functions path above nor the normal walk extracts them.
          // Extract each endpoint as a function node (named by its key), and skip
          // walking the createApi call body (its handler arrows are extracted
          // individually below, exactly like the store-factory case).
          const rtkEndpoints =
            valueNode?.type === 'call_expression' ? this.findRtkEndpointsObject(valueNode) : null;

          // Pinia SETUP store: `defineStore('id', () => { const foo = …; return {…} })`.
          // Its actions are body-local consts the generic walk can't reach.
          const piniaSetup =
            valueNode?.type === 'call_expression' ? this.findPiniaSetupFn(valueNode) : null;

          // Vue store collections — make `actions`/`mutations`/`getters` findable
          // function nodes (the foundation under any later dispatch-bridge synth).
          // Two positions: INLINE in a store call (`defineStore({ actions: {…} })`
          // / `createStore` / `new Vuex.Store`), and the non-exported Vuex-MODULE
          // form (`const actions = {…}` at a store file's top level, wired via a
          // `export default { actions }`). The Pinia SETUP form is handled by the
          // body walk above (its actions are local consts).
          const storeCollections: SyntaxNode[] = [];
          if (valueNode?.type === 'call_expression' || valueNode?.type === 'new_expression') {
            storeCollections.push(...this.findVueStoreCollectionObjects(valueNode));
          }
          if (objectOfFns && !extractObjectMethods &&
            VUE_STORE_COLLECTION_NAMES.has(name) && this.looksLikeVueStoreFile()) {
            storeCollections.push(objectOfFns);
          }

          // Visit the initializer body for calls — EXCEPT object literals (their
          // function-valued properties are extracted below) and the store-factory
          // / createApi / store-collection call whose nested objects we extract
          // method-by-method below (walking the whole call would re-visit those
          // method arrows and mis-attribute their inner calls to the file scope).
          if (valueNode &&
            valueNode.type !== 'object' &&
            valueNode.type !== 'object_expression' &&
            !(extractObjectMethods && valueNode.type === 'call_expression') &&
            !rtkEndpoints &&
            !piniaSetup &&
            storeCollections.length === 0) {
            this.visitFunctionBody(valueNode, '');
          }

          if (extractObjectMethods && objectOfFns) {
            this.extractObjectLiteralFunctions(objectOfFns);
          }
          if (rtkEndpoints) {
            this.extractRtkEndpoints(rtkEndpoints);
          }
          if (piniaSetup) {
            this.extractPiniaSetupBody(piniaSetup);
          }
          for (const coll of storeCollections) {
            this.extractObjectLiteralFunctions(coll);
          }
        }
      }
    }
  } else if (this.language === 'python' || this.language === 'ruby') {
    // Python/Ruby assignment: left = right
    const left = getChildByField(node, 'left') || node.namedChild(0);
    const right = getChildByField(node, 'right') || node.namedChild(1);

    // Ruby constant assignments (`MAX = 3`) have a `constant`-typed LHS, not
    // `identifier`; without this they were never extracted as symbols at all.
    if (left && (left.type === 'identifier' || left.type === 'constant')) {
      const name = getNodeText(left, this.source);
      // Skip if name starts with lowercase and looks like a function call result
      // Python constants are usually UPPER_CASE
      const initValue = right ? getNodeText(right, this.source).slice(0, 100) : undefined;
      const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

      this.createNode(kind, name, node, {
        docstring,
        signature: initSignature,
      });
    }
  } else if (this.language === 'go') {
    // Go: var_declaration, short_var_declaration, const_declaration
    // These can have multiple identifiers on the left
    const specs = node.namedChildren.filter(c =>
      c.type === 'var_spec' || c.type === 'const_spec'
    );

    for (const spec of specs) {
      const nameNode = spec.namedChild(0);
      let varNode: Node | null = null;
      if (nameNode && nameNode.type === 'identifier') {
        const name = getNodeText(nameNode, this.source);
        const valueNode = spec.namedChildCount > 1 ? spec.namedChild(spec.namedChildCount - 1) : null;
        const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
        const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

        varNode = this.createNode(node.type === 'const_declaration' ? 'constant' : 'variable', name, spec, {
          docstring,
          signature: initSignature,
        });
      }
      // Walk the initializer so composite literals and calls in a
      // package-level `var Query Binding = queryBinding{}` (a registry of
      // implementations) or `var c = pkg.New()` are extracted as
      // instantiates/calls dependencies — the body walker only covers
      // initializers inside functions, not these top-level declarations.
      // Scope the walk to the declared symbol so a call inside an anonymous
      // func_literal initializer — a cobra `RunE: func(){…}` handler, a
      // goroutine or callback closure — attributes to the var instead of
      // leaking to the file node (which reads as "no caller"), issue #693.
      const valueField = getChildByField(spec, 'value');
      if (valueField) {
        if (varNode) this.nodeStack.push(varNode.id);
        this.visitFunctionBody(valueField, varNode?.id ?? '');
        if (varNode) this.nodeStack.pop();
      }
    }

    // Handle short_var_declaration (:=)
    if (node.type === 'short_var_declaration') {
      const left = getChildByField(node, 'left');
      const right = getChildByField(node, 'right');

      if (left) {
        // Can be expression_list with multiple identifiers
        const identifiers = left.type === 'expression_list'
          ? left.namedChildren.filter(c => c.type === 'identifier')
          : [left];

        for (const id of identifiers) {
          const name = getNodeText(id, this.source);
          const initValue = right ? getNodeText(right, this.source).slice(0, 100) : undefined;
          const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

          this.createNode('variable', name, node, {
            docstring,
            signature: initSignature,
          });
        }
      }
    }
  } else if (this.language === 'lua' || this.language === 'luau') {
    // Lua/Luau: variable_declaration → assignment_statement → variable_list
    //      (name: identifier...) = expression_list. `local x, y = 1, 2`
    //      declares multiple names; only plain identifiers are locals.
    const assign = node.namedChildren.find((c) => c.type === 'assignment_statement') ?? node;
    const varList = assign.namedChildren.find((c) => c.type === 'variable_list');
    const exprList = assign.namedChildren.find((c) => c.type === 'expression_list');
    const values = exprList ? exprList.namedChildren : [];
    const names = varList ? varList.namedChildren.filter((c) => c.type === 'identifier') : [];
    names.forEach((nameNode, i) => {
      const name = getNodeText(nameNode, this.source);
      if (!name) return;
      const valueNode = values[i];
      const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
      const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;
      this.createNode(kind, name, nameNode, { docstring, signature: initSignature, isExported });
    });
  } else if (this.language === 'c') {
    // C: a `declaration` node's name nests inside the `declarator` field —
    // `init_declarator` (with value) or bare/pointer/array declarators (no
    // value); a `function_declarator` is a prototype, not a variable. The
    // generic fallback below only finds a *direct* identifier child, which C
    // never has, so file-scope consts/globals went unextracted entirely (and
    // so had no impact-radius edges). Only file-scope declarations are tracked
    // — locals inside a function body are skipped (a `static const` table read
    // by same-file functions is the value the impact graph wants, not every
    // block-local). C allows several declarators per declaration
    // (`int a = 1, b = 2;`), so iterate them.
    if (!hasFunctionAncestor(node)) {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        // Accept only `init_declarator` (has a value) and pointer/array
        // declarators. A *bare* `identifier` declarator is deliberately
        // skipped: an unknown leading macro (`CURL_EXTERN`, `XXH_PUBLIC_API`)
        // makes tree-sitter-c misparse a prototype `MACRO RetType fn(args);`
        // as a declaration whose "variable" is the bare return-type
        // identifier, splitting `fn(args)` off as a bogus expression — minting
        // a spurious type-named global for every macro-prefixed prototype in a
        // header. Those misparses are always bare identifiers; real
        // consts/tables always carry an initializer. The only legit loss is
        // uninitialized scalar globals (`static int g;`).
        if (
          child.type !== 'init_declarator' &&
          child.type !== 'pointer_declarator' &&
          child.type !== 'array_declarator'
        ) {
          continue;
        }
        const nameNode = cDeclaratorIdentifier(child);
        if (!nameNode) continue;
        const name = getNodeText(nameNode, this.source);
        if (!name) continue;
        const valueNode =
          child.type === 'init_declarator' ? getChildByField(child, 'value') : null;
        const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
        const initSignature = initValue
          ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}`
          : undefined;
        this.createNode(kind, name, child, { docstring, signature: initSignature, isExported });
      }
    }
  } else if (this.language === 'swift') {
    // Swift top-level property (`let X = …` / `var Y = …`). The name nests in
    // a `pattern`, which the generic fallback can't read, so top-level Swift
    // constants/globals went unextracted. A top-level `let`→`constant`,
    // `var`→`variable`; a computed property (getter, no value) is skipped.
    const { nameNode, isLet, isComputed } = swiftPropertyInfo(node, this.source);
    if (nameNode && !isComputed) {
      this.createNode(isLet ? 'constant' : 'variable', getNodeText(nameNode, this.source), node, {
        docstring,
        isExported,
      });
    }
  } else {
    // Generic fallback for other languages
    // Try to find identifier children
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'identifier' || child?.type === 'variable_declarator') {
        const name = child.type === 'identifier'
          ? getNodeText(child, this.source)
          : extractName(child, this.source, this.extractor);

        if (name && name !== '<anonymous>') {
          this.createNode(kind, name, child, {
            docstring,
            isExported,
          });
        }
      }
    }
  }
}
