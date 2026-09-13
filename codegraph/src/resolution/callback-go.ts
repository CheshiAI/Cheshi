import type { QueryBuilder } from '../db/queries';
import { isGeneratedFile } from '../extraction/generated-detection';
import type { Edge, Node, NodeKind } from '../types';
import { MAX_CALLBACKS_PER_CHANNEL } from './callback-channels';
import { sliceLines } from './callback-source';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import type { ResolutionContext } from './types';

/**
 * Go implicit interface satisfaction (#584). Go has no `implements` keyword — a
 * struct satisfies an interface structurally when its method set covers the
 * interface's. Synthesize the missing `implements` edge (struct → interface) by
 * matching method-NAME sets, so impl-navigation works and the interface-dispatch
 * bridge ({@link interfaceOverrideEdges}, now 'go'-enabled) can link an interface
 * method call to the concrete overrides.
 *
 * Name-only matching (signatures ignored) — over-approximation accepted, in line
 * with the other dispatch synthesizers; capped per interface. Empty interfaces
 * (`any`) are skipped so they don't match every struct.
 */
export async function goImplementsEdges(queries: QueryBuilder, onYield: MaybeYield): Promise<Edge[]> {
  let scanned255 = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();

  const methodNameSet = (id: string): Set<string> =>
    new Set(
      queries
        .getOutgoingEdges(id, ['contains'])
        .map((e) => queries.getNodeById(e.target))
        .filter((n): n is Node => !!n && n.kind === 'method')
        .map((n) => n.name),
    );

  // Materializes GO structs only (the pass is language-gated by the caller),
  // never the whole struct kind — that array is O(nodes) on struct-heavy
  // repos like the Linux kernel (#1212).
  const goStructs: Node[] = [];
  for (const s of queries.iterateNodesByKind('struct')) {
    if ((++scanned255 & 63) === 0) await onYield();
    if (s.language === 'go') goStructs.push(s);
  }
  const structMethods = new Map<string, Set<string>>();
  for (const s of goStructs) structMethods.set(s.id, methodNameSet(s.id));

  for (const iface of queries.iterateNodesByKind('interface')) {
    if ((++scanned255 & 63) === 0) await onYield();

    if ((++scanned255 & 63) === 0) await onYield();
    if (iface.language !== 'go') continue;
    const want = methodNameSet(iface.id);
    if (want.size === 0) continue; // empty interface (`any`) — would match everything
    let added = 0;
    for (const s of goStructs) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      const have = structMethods.get(s.id);
      if (!have || have.size < want.size) continue;
      let all = true;
      for (const m of want) {
        if (!have.has(m)) { all = false; break; }
      }
      if (!all) continue;
      const key = `${s.id}>${iface.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: s.id,
        target: iface.id,
        kind: 'implements',
        line: s.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'go-implements', via: iface.name, registeredAt: `${s.filePath}:${s.startLine}` },
      });
      added++;
    }
  }
  return edges;
}

/**
 * Cross-file Go method → receiver-type `contains` edges. In Go a type's methods
 * are commonly declared in a different file from the `type` declaration itself
 * (`type User struct{…}` in `user.go`, `func (u *User) Save()` in
 * `user_store.go`). Extraction attaches the struct→method `contains` edge only
 * when the receiver type is in the SAME file — the owner lookup in
 * `tree-sitter.ts` is scoped to the file being parsed — so a cross-file method
 * is left orphaned from its type (it's still `contains`ed by its file, just not
 * its struct). That breaks `codegraph_node` member outlines, any
 * callers/callees/impact traversal that goes through the type's `contains`
 * edges, and the {@link goImplementsEdges} method-set computation (which derives
 * a struct's method set from those same edges, so it under-counts interfaces a
 * cross-file struct satisfies).
 *
 * Go guarantees a method's receiver type is declared in the SAME PACKAGE as the
 * method, and a Go package is a single directory — so this is a deterministic
 * structural link, not a heuristic: find the same-named type in the method's own
 * directory and add the missing `contains` edge (no `provenance: 'heuristic'`,
 * matching the same-file edges extraction already emits). Skips methods that
 * already have a type parent (the same-file case). (#583, cross-file half)
 */
export async function goCrossFileMethodContainsEdges(queries: QueryBuilder, onYield: MaybeYield): Promise<Edge[]> {
  let scanned255 = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const TYPE_KINDS = new Set<NodeKind>(['struct', 'class', 'interface', 'enum', 'type_alias']);
  const dirOf = (p: string): string => {
    const i = p.replace(/\\/g, '/').lastIndexOf('/');
    return i >= 0 ? p.slice(0, i) : '';
  };

  for (const method of queries.iterateNodesByKind('method')) {
    if ((++scanned255 & 63) === 0) await onYield();

    if ((++scanned255 & 63) === 0) await onYield();
    if (method.language !== 'go') continue;
    // The receiver type is encoded in the method's qualifiedName as `Recv::name`
    // (extraction sets `${receiverType}::${name}` for receiver methods).
    const qn = method.qualifiedName;
    if (!qn) continue;
    const sep = qn.lastIndexOf('::');
    if (sep <= 0) continue;
    const receiver = qn.slice(0, sep);
    if (!receiver) continue;

    // Already attached to its type (same-file case handled at extraction)?
    const hasTypeParent = queries
      .getIncomingEdges(method.id, ['contains'])
      .some((e) => {
        const src = queries.getNodeById(e.source);
        return src != null && TYPE_KINDS.has(src.kind);
      });
    if (hasTypeParent) continue;

    // Find the receiver type in the SAME directory (= same Go package). Go forbids
    // duplicate type names within a package, so a same-name same-dir match is
    // unambiguous; scoping to the directory avoids linking to a same-named type
    // in another package.
    const dir = dirOf(method.filePath);
    const owner = queries
      .getNodesByName(receiver)
      .find((n) => n.language === 'go' && TYPE_KINDS.has(n.kind) && dirOf(n.filePath) === dir);
    if (!owner) continue;

    const key = `${owner.id}>${method.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source: owner.id, target: method.id, kind: 'contains', line: method.startLine });
  }
  return edges;
}

/**
 * Go gRPC stub → impl bridge. The protoc-gen-go-grpc codegen emits an
 * `UnimplementedXxxServer` struct in `*_grpc.pb.go` carrying one method
 * per service RPC; the real handler is a hand-written struct in another
 * file (`x/bank/keeper/msg_server.go::msgServer.Send` in cosmos-sdk).
 * Go's structural typing means no `implements` edge exists for our
 * resolver to follow, so `trace("Send","SendCoins")` lands on the
 * empty stub and reports "no path" (validated empirically — the cosmos
 * Q1 r1 trace failure that drove this work).
 *
 * Bridge: for each `UnimplementedXxxServer` whose RPC-method names are
 * a SUBSET of some other Go struct's method names, emit `calls` edges
 * `stub.method → impl.method` (paired by name). Excludes the gRPC
 * internal markers `mustEmbedUnimplementedXxxServer` and
 * `testEmbeddedByValue`, and skips candidate impls that themselves
 * live in a generated file (their `xxxClient` / sibling stubs would
 * otherwise look like impls).
 *
 * Multiple candidates is allowed and capped at MAX_CALLBACKS_PER_CHANNEL —
 * a service often has both a production impl and one or more test
 * mocks; linking to all preserves trace utility without false-favoring.
 *
 * Provenance: `heuristic`, `synthesizedBy: 'go-grpc-stub-impl'`. The
 * stub's source line is the wiring site shown in the trace trail.
 */
export async function goGrpcStubImplEdges(queries: QueryBuilder, onYield: MaybeYield): Promise<Edge[]> {
  let scanned255 = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();

  const STUB_RE = /^Unimplemented.*Server$/;
  // gRPC internal-helper methods that appear on every Unimplemented*Server;
  // not part of the service contract, so exclude when computing the RPC-method
  // signature used to match impls.
  const isInternalMarker = (n: string) => n.startsWith('mustEmbed') || n === 'testEmbeddedByValue';

  // Methods directly contained by each Go struct, name-only. Built once.
  const methodNamesByStruct = new Map<string, Set<string>>();
  const methodNodesByStruct = new Map<string, Node[]>();
  const goStructs: Node[] = [];
  for (const s of queries.iterateNodesByKind('struct')) {
    if ((++scanned255 & 63) === 0) await onYield();
    if (s.language !== 'go') continue;
    goStructs.push(s);
    const ms = queries
      .getOutgoingEdges(s.id, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
    methodNodesByStruct.set(s.id, ms);
    methodNamesByStruct.set(s.id, new Set(ms.map((m) => m.name)));
  }

  for (const stub of goStructs) {
    if (!STUB_RE.test(stub.name)) continue;
    // The stub MUST live in a generated file — that's what tells us this is
    // a protoc-emitted scaffold rather than someone naming a struct
    // `UnimplementedXxxServer` by hand. Without this gate we'd also bridge
    // such hand-written structs and create misleading edges.
    if (!isGeneratedFile(stub.filePath)) continue;

    const stubMethods = (methodNodesByStruct.get(stub.id) ?? []).filter(
      (m) => !isInternalMarker(m.name),
    );
    if (stubMethods.length === 0) continue;
    const stubMethodNames = stubMethods.map((m) => m.name);

    for (const cand of goStructs) {
      if (cand.id === stub.id) continue;
      // Skip generated-file candidates — they're siblings (msgClient,
      // UnsafeMsgServer, …) whose method sets coincidentally match.
      if (isGeneratedFile(cand.filePath)) continue;

      const candNames = methodNamesByStruct.get(cand.id);
      if (!candNames) continue;
      // Subset: every RPC method must exist on the candidate by name.
      // Signature-level match would tighten this further, but name-match
      // alone already gives one-to-one pairing in real codebases because
      // gRPC method-name sets are highly distinctive (Send + MultiSend +
      // UpdateParams + SetSendEnabled is unique to bank's MsgServer).
      if (!stubMethodNames.every((n) => candNames.has(n))) continue;

      const candMethods = methodNodesByStruct.get(cand.id) ?? [];
      let added = 0;
      for (const sm of stubMethods) {
        if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
        for (const cm of candMethods) {
          if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
          if (cm.name !== sm.name) continue;
          const key = `${sm.id}>${cm.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({
            source: sm.id,
            target: cm.id,
            kind: 'calls',
            line: sm.startLine,
            provenance: 'heuristic',
            metadata: {
              synthesizedBy: 'go-grpc-stub-impl',
              via: cm.name,
              registeredAt: `${cm.filePath}:${cm.startLine}`,
            },
          });
          added++;
        }
      }
    }
  }
  return edges;
}

/**
 * Gin middleware chain. Gin runs its entire handler chain through one dynamic
 * line in `(*Context).Next`:
 *     for c.index < len(c.handlers) { c.handlers[c.index](c); c.index++ }
 * `c.handlers` is a `HandlersChain` (`[]HandlerFunc`) assembled at registration
 * time by `combineHandlers` from the funcs passed to `r.Use(...)` /
 * `r.GET("/path", h...)` / `r.Handle(...)`. Because the call is a computed index
 * into a runtime-built slice, tree-sitter resolves `c.handlers[c.index](c)` to
 * NOTHING — so `callees(Next)` is just the `len()` helper and the flow
 * `ServeHTTP → handleHTTPRequest → Next` dead-ends at the exact symbol the
 * "how do requests flow through the middleware chain" question is about. The
 * agent then re-queries Next and falls back to Read/grep (validated: the gin
 * WITH-arm rabbit-holed on precisely this dead-end).
 *
 * Bridge it: find the chain DISPATCHER (a Go method whose body invokes a
 * `handlers` slice by index) and link it → every HandlerFunc registered via a
 * gin registration call, so `callees(Next)` and `trace(ServeHTTP, <handler>)`
 * connect end-to-end. Named handlers only (`gin.Logger()` → `Logger`,
 * `authMiddleware`); inline closures are anonymous and skipped. Like
 * react-render / interface-impl this is a deliberate over-approximation —
 * reachability-correct (any registered handler CAN run for some route), capped,
 * and gated on the dispatcher existing so it never runs on non-gin Go repos.
 * Provenance `heuristic`, `synthesizedBy:'gin-middleware-chain'`; `registeredAt`
 * is the `.Use`/`.GET` site an agent would otherwise grep for.
 */
const GIN_DISPATCH_RE = /\.handlers\s*\[[^\x5D]*\x5D\s*\(/;

// c.handlers[c.index](c)
const GIN_REG_RE = /\.(?:Use|GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any|Handle)\s*\(/g;

/** Balanced `(...)` body starting at the '(' index; null if unbalanced. */
function goBalancedArgs(s: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return s.slice(openIdx + 1, i); }
  }
  return null;
}

/** Split a top-level comma list, respecting nested () [] {}. */
function goSplitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const c of args) {
    if (c === '(' || c === '[' || c === '{') { depth++; cur += c; }
    else if (c === ')' || c === ']' || c === '}') { depth--; cur += c; }
    else if (c === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Tail ident of a handler arg: `gin.Logger()`→`Logger`, `mw`→`mw`; null for string paths / closures. */
function goHandlerIdent(expr: string): string | null {
  const cleaned = expr.trim().replace(/\(\s*\)$/, '');                  // drop a trailing call ()
  if (!cleaned || cleaned.startsWith('"') || cleaned.startsWith('`') || cleaned.startsWith('func')) return null;
  const m = cleaned.match(/(?:\.|^)([A-Za-z_]\w*)$/);
  return m ? m[1]! : null;
}

export async function ginMiddlewareChainEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scanned255 = 0;
  let scannedFiles = 0;
  // 1. Find the chain dispatcher(s): a Go method that invokes a `handlers` slice by index.
  const dispatchers: Node[] = [];
  for (const n of queries.iterateNodesByKind('method')) {
    if ((++scanned255 & 63) === 0) await onYield();
    if (n.language !== 'go') continue;
    const content = ctx.readFile(n.filePath);
    const src = content && sliceLines(content, n.startLine, n.endLine);
    if (src && GIN_DISPATCH_RE.test(src)) dispatchers.push(n);
  }
  if (dispatchers.length === 0) return [];                              // not a gin repo — bail

  // 2. Collect handler identifiers registered via gin registration calls
  //    (.Use / .GET / … / .Handle). String args (paths/methods) and inline
  //    closures are dropped by goHandlerIdent; the rest are HandlerFuncs.
  const registered = new Map<string, string>();                         // name → registeredAt (file:line)
  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if (!file.endsWith('.go')) continue;
    const content = ctx.readFile(file);
    if (!content || (!content.includes('.Use(') && !/\.(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any|Handle)\(/.test(content))) continue;
    const safe = stripCommentsForRegex(content, 'go');
    GIN_REG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = GIN_REG_RE.exec(safe))) {
      const parenIdx = m.index + m[0].length - 1;
      const argStr = goBalancedArgs(safe, parenIdx);
      if (!argStr) continue;
      const line = safe.slice(0, m.index).split('\n').length;
      for (const arg of goSplitArgs(argStr)) {
        const name = goHandlerIdent(arg);
        if (name && !registered.has(name)) registered.set(name, `${file}:${line}`);
      }
    }
  }
  if (registered.size === 0) return [];

  // 3. Link each dispatcher → each registered handler node (dedup, capped).
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const disp of dispatchers) {
    let added = 0;
    for (const [name, registeredAt] of registered) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      const handler = ctx.getNodesByName(name).find(
        (n) => (n.kind === 'function' || n.kind === 'method') && n.language === 'go'
      );
      if (!handler || handler.id === disp.id) continue;
      const key = `${disp.id}>${handler.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: disp.id, target: handler.id, kind: 'calls', line: disp.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'gin-middleware-chain', via: name, registeredAt },
      });
      added++;
    }
  }
  return edges;
}
