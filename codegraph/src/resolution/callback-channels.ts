import type { QueryBuilder } from '../db/queries';
import type { Edge, Node } from '../types';
import { enclosingFn, makeLineAt, methodAndFunctionNodes, sliceLines } from './callback-source';
import type { MaybeYield } from './cooperative-yield';
import type { ResolutionContext } from './types';

const REGISTRAR_NAME = /^(on[A-Z]\w*|subscribe|addListener|addEventListener|register|watch|listen|addCallback)$/;

const DISPATCHER_NAME = /(emit|trigger|notify|dispatch|fire|publish|flush)/i;

export const MAX_CALLBACKS_PER_CHANNEL = 40;

export const EVENT_FANOUT_CAP = 6;

// skip events with more handlers/dispatchers than this (too generic without type info)

const ON_RE = /\.(?:on|once|addListener)\(\s*['"]([^'"]+)['"]\s*,\s*(?:function\s+(\w+)|(?:this\.)?(\w+))/g;

const EMIT_RE = /\.(?:emit|fire|dispatchEvent)\(\s*['"]([^'"]+)['"]/g;

// Closure-collection dynamic dispatch (language-agnostic, Swift-first). A method
// appends a closure to a collection property; another method iterates that
// property *invoking each element* (`coll.forEach { $0() }` / `{ it() }`). The
// element-invoke (`$0(` / `it(`) PROVES the collection holds closures, so pairing
// a dispatcher to same-named registrars (`.append`/`.add`/`.push`/`.insert`,
// incl. Swift `prop.write { $0.append }`) is high-precision. Cross-file/class by
// design: Alamofire appends in `DataRequest.validate` but iterates in the base
// `Request.didCompleteTask` — neither same-file nor same-class pairing reaches it.
const CC_DISPATCH_RE = /(\w+)\.forEach\s*\{\s*(?:\$0|it)\s*\(/g;

const CC_APPEND_WRITE_RE = /(\w+)\.write\s*\{\s*\$0(?:\.(\w+))?\.(?:append|add|push|insert)\s*\(/g;

const CC_APPEND_DIRECT_RE = /(\w+)\.(?:append|add|push|insert)\s*\(/g;

const CC_FANOUT_CAP = 8;

// skip a field name with more dispatchers/registrars than this (too generic to pair confidently)
// The dispatcher gate — `{ $0( ` / `{ it( ` element-invocation — is Swift/Kotlin
// trailing-closure syntax, so ONLY those languages can ever contribute a
// dispatcher, and a cross-language registrar pairing (a JS `.push(` against a
// Swift dispatcher's field name) would be a wrong edge, not a missed one.
// Gating both sides here isn't just precision: `.push(`/`.add(` is everywhere
// in JS/PHP, so an ungated scan slices + regexes nearly every function on repos
// where the pass cannot emit a single edge — on a 12k-file PHP/JS app that was
// 20+ minutes of the "Resolving refs" tail and a #850 watchdog kill (#1235).
const CC_LANGUAGES = new Set(['swift', 'kotlin']);

function registrarField(src: string): string | null {
  const m = src.match(/this\.(\w+)\.(?:add|push|set)\(/);
  return m ? m[1]! : null;
}

function dispatcherField(src: string): string | null {
  const forOf = src.match(/\bof\s+(?:Array\.from\(\s*)?this\.(\w+)/);
  if (forOf && /\b\w+\s*\(/.test(src)) return forOf[1]!;
  const forEach = src.match(/this\.(\w+)\.forEach\(/);
  if (forEach) return forEach[1]!;
  return null;
}

/** Phase 1: field-backed observer channels (registrar/dispatcher share a store). */
export async function fieldChannelEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const registrars: Array<{ node: Node; field: string }> = [];
  const dispatchers: Array<{ node: Node; field: string }> = [];

  let scanned = 0;
  for (const m of methodAndFunctionNodes(queries)) {
    if ((++scanned & 255) === 0) await onYield(); // #1091: yield mid-scan on huge graphs
    const isReg = REGISTRAR_NAME.test(m.name);
    const isDisp = DISPATCHER_NAME.test(m.name);
    if (!isReg && !isDisp) continue;
    const content = ctx.readFile(m.filePath);
    const src = content && sliceLines(content, m.startLine, m.endLine);
    if (!src) continue;
    if (isReg) { const f = registrarField(src); if (f) registrars.push({ node: m, field: f }); }
    if (isDisp) { const f = dispatcherField(src); if (f) dispatchers.push({ node: m, field: f }); }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const reg of registrars) {
    const chDispatchers = dispatchers.filter(
      (d) => d.node.filePath === reg.node.filePath && d.field === reg.field
    );
    if (chDispatchers.length === 0) continue;
    const argRe = new RegExp(`${reg.node.name}\\s*\\(\\s*(?:this\\.)?(\\w+)`);
    let added = 0;
    for (const e of queries.getIncomingEdges(reg.node.id, ['calls'])) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      if (!e.line) continue;
      const caller = queries.getNodeById(e.source);
      if (!caller) continue;
      const line = ctx.readFile(caller.filePath)?.split('\n')[e.line - 1];
      const am = line?.match(argRe);
      if (!am) continue;
      const fn = ctx.getNodesByName(am[1]!).find((n) => n.kind === 'method' || n.kind === 'function');
      if (!fn) continue;
      for (const disp of chDispatchers) {
        if (disp.node.id === fn.id) continue;
        const key = `${disp.node.id}>${fn.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: disp.node.id, target: fn.id, kind: 'calls', line: disp.node.startLine,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'callback', via: reg.node.name, field: reg.field,
            // Where the callback was wired up (`scene.onUpdate(this.triggerRender)`).
            // This is the #1 thing an agent reads/greps to explain the flow — surface
            // it so node/trace/context can show it without a callers() + Read round-trip.
            registeredAt: `${caller.filePath}:${e.line}`,
          },
        });
        added++;
      }
    }
  }
  return edges;
}

/**
 * Closure-collection dispatch: dispatcher iterates a closure-collection property
 * invoking each element; registrar appends a closure to the same-named property.
 * Emits dispatcher → registrar so a flow reaches the registration site (where the
 * appended closure's body — and its callers — live). High-precision: the
 * dispatcher's element-invoke is the gate (a `.forEach` that does NOT invoke its
 * element is ignored), so a repo with no closure-collection dispatch yields zero
 * edges regardless of how many `.append`/`.push` sites it has.
 *
 * Pairs globally by field name (cross-file/class is required — see Alamofire's
 * base-class `Request.didCompleteTask` iterating `validators` appended by the
 * subclass `DataRequest.validate`), bounded by a fan-out cap so a generic field
 * name shared across unrelated classes can't fan out into noise.
 */
export async function closureCollectionEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const dispatchers = new Map<string, Array<{ node: Node; line: number }>>(); // field → dispatcher methods + forEach line
  const registrars = new Map<string, Array<{ node: Node; line: number }>>();   // field → registrar methods + append line

  const addReg = (field: string | undefined, node: Node, absLine: number) => {
    if (!field || /^\d+$/.test(field)) return; // `$0.append` mis-captures the `0`; the write-RE owns that field
    const arr = registrars.get(field) ?? [];
    if (!arr.some((r) => r.node.id === node.id)) arr.push({ node, line: absLine });
    registrars.set(field, arr);
  };

  // Slices EVERY Swift/Kotlin method/function's source (no cheap name-gate), so
  // on a repo with a huge file this is the heaviest synthesis pass — yield
  // mid-scan (and mid-match-loop below: a single generated function dense with
  // matches must not starve the watchdog either) so it can't wedge the #850
  // watchdog on its own (#1091, #1235).
  let scanned = 0;
  let matchTick = 0;
  for (const m of methodAndFunctionNodes(queries)) {
    if ((++scanned & 127) === 0) await onYield();
    if (!CC_LANGUAGES.has(m.language)) continue;
    const content = ctx.readFile(m.filePath);
    const src = content && sliceLines(content, m.startLine, m.endLine);
    if (!src) continue;
    const hasForEach = src.includes('.forEach');
    const hasAppend = src.includes('.append(') || src.includes('.add(') || src.includes('.push(') || src.includes('.insert(');
    if (!hasForEach && !hasAppend) continue;
    const lineAt = makeLineAt(src, m.startLine ?? 1);

    if (hasForEach) {
      CC_DISPATCH_RE.lastIndex = 0;
      let d: RegExpExecArray | null;
      while ((d = CC_DISPATCH_RE.exec(src))) {
        if ((++matchTick & 255) === 0) await onYield();
        const arr = dispatchers.get(d[1]!) ?? [];
        if (!arr.some((n) => n.node.id === m.id)) arr.push({ node: m, line: lineAt(d.index) });
        dispatchers.set(d[1]!, arr);
      }
    }
    if (hasAppend) {
      CC_APPEND_WRITE_RE.lastIndex = 0;
      let w: RegExpExecArray | null;
      while ((w = CC_APPEND_WRITE_RE.exec(src))) {
        if ((++matchTick & 255) === 0) await onYield();
        addReg(w[2] || w[1], m, lineAt(w.index)); // nested `$0.streams` else the `.write` receiver
      }
      CC_APPEND_DIRECT_RE.lastIndex = 0;
      let a: RegExpExecArray | null;
      while ((a = CC_APPEND_DIRECT_RE.exec(src))) {
        if ((++matchTick & 255) === 0) await onYield();
        addReg(a[1], m, lineAt(a.index));
      }
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [field, disps] of dispatchers) {
    const regs = registrars.get(field);
    if (!regs || regs.length === 0) continue;
    if (disps.length > CC_FANOUT_CAP || regs.length > CC_FANOUT_CAP) continue; // generic field — can't pair confidently
    for (const disp of disps) for (const reg of regs) {
      if (disp.node.id === reg.node.id) continue;
      const key = `${disp.node.id}>${reg.node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: disp.node.id, target: reg.node.id, kind: 'calls', line: disp.line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'closure-collection', field, registeredAt: `${reg.node.filePath}:${reg.line}` },
      });
    }
  }
  return edges;
}

/** Phase 2: string-keyed EventEmitter channels (on('e', fn) ↔ emit('e')). */
export async function eventEmitterEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scannedFiles = 0;
  const emitsByEvent = new Map<string, Set<string>>();          // event → dispatcher node ids
  const handlersByEvent = new Map<string, Map<string, string>>(); // event → handler id → registration site (file:line)

  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if ((++scanned & 255) === 0) await onYield(); // #1091: yield mid-scan on huge graphs
    const content = ctx.readFile(file);
    if (!content) continue;
    const hasEmit = content.includes('.emit(') || content.includes('.fire(') || content.includes('.dispatchEvent(');
    const hasOn = content.includes('.on(') || content.includes('.once(') || content.includes('.addListener(');
    if (!hasEmit && !hasOn) continue;
    const nodesInFile = ctx.getNodesInFile(file);
    const lineOf = makeLineAt(content, 1);

    if (hasEmit) {
      EMIT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = EMIT_RE.exec(content))) {
        const disp = enclosingFn(nodesInFile, lineOf(m.index));
        if (!disp) continue;
        const set = emitsByEvent.get(m[1]!) ?? new Set<string>();
        set.add(disp.id); emitsByEvent.set(m[1]!, set);
      }
    }
    if (hasOn) {
      ON_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ON_RE.exec(content))) {
        const handlerName = m[2] || m[3];
        if (!handlerName) continue;
        const handler = ctx.getNodesByName(handlerName).find((n) => n.kind === 'function' || n.kind === 'method');
        if (!handler) continue;
        const map = handlersByEvent.get(m[1]!) ?? new Map<string, string>();
        map.set(handler.id, `${file}:${lineOf(m.index)}`); handlersByEvent.set(m[1]!, map);
      }
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [event, dispatchers] of emitsByEvent) {
    const handlers = handlersByEvent.get(event);
    if (!handlers) continue;
    // Precision guard: a generic event name with many handlers/dispatchers can't
    // be matched without receiver-type info (Phase 3) — skip rather than over-link.
    if (dispatchers.size > EVENT_FANOUT_CAP || handlers.size > EVENT_FANOUT_CAP) continue;
    for (const d of dispatchers) for (const [h, registeredAt] of handlers) {
      if (d === h) continue;
      const key = `${d}>${h}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: d, target: h, kind: 'calls', provenance: 'heuristic', metadata: { synthesizedBy: 'event-emitter', event, registeredAt } });
    }
  }
  return edges;
}
