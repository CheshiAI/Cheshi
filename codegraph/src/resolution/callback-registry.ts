import type { Edge, Node } from '../types';
import { enclosingFn } from './callback-source';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import type { ResolutionContext } from './types';

// ── Object-literal registry dispatch ─────────────────────────────────────────
// A command/handler registry maps string keys → handler class/function symbols in an
// object literal, then dispatches by a RUNTIME key static parsing can't follow:
//   this.commands = { [Cmd.ADD]: AddObjectCommand, ... }    // registration
//   new this.commands[command](args).execute()              // dynamic dispatch
// Bridge it like gin-middleware-chain: link each dispatching function → each registered
// handler's callable entry (a class's execute/run/handle/… method — preferring the method
// chained at the dispatch site — or the function value). Scoped to a registry + dispatch in
// the SAME file (the cross-file barrel-namespace variant, e.g. trezor's getMethod, is
// deferred). Gated on a real object literal with ≥2 entries that RESOLVE to callables (a
// `{ width: 5 }` literal resolves to nothing → no edges); fan-out capped.
const REGISTRY_ASSIGN_RE = /(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)|((?:this\.)?[A-Za-z_$][\w$]*))\s*=\s*\{/g;

const REGISTRY_DISPATCH_RE = /(?:\bnew\s+)?((?:this\.)?[A-Za-z_$][\w$]*)\s*\[\s*([A-Za-z_$][\w$.]*)\s*\x5D\s*(?:\(|\.[A-Za-z_$])/g;

const REGISTRY_MIN_ENTRIES = 2;

const REGISTRY_FANOUT_CAP = 40;

const REGISTRY_CLASS_ENTRY = new Set(['execute', 'run', 'handle', 'perform', 'process', 'call', 'apply', 'dispatch']);

const REGISTRY_JS_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

/** From the index of an opening `{`, return the brace-balanced body up to its matching `}`. */
function braceBody(src: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(openIdx + 1, i);
  }
  return null;
}

/** Top-level `key: Identifier` entries of an object-literal body. DEPTH-AWARE: only depth-0
 *  segments are considered, so method-shorthand bodies (`number(a,b){…}`), arrow values
 *  (`x: () => …`), and nested objects (`x: { … }`) don't leak their inner `k: v` pairs as
 *  bogus handlers. The per-segment anchor (`^… key: Ident …$`) keeps only pure identifier
 *  values — a data value (`x: 5`), call, or arrow fails to match. */
function registryEntryNames(body: string): string[] {
  const segs: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { segs.push(body.slice(start, i)); start = i + 1; }
  }
  segs.push(body.slice(start));
  const names: string[] = [];
  for (const seg of segs) {
    const m = /^\s*(?:\[[^\x5D]+\x5D|['"]?[\w$]+['"]?)\s*:\s*([A-Za-z_$][\w$]*)\s*$/.exec(seg);
    if (m && m[1]!.length >= 3 && !names.includes(m[1]!)) names.push(m[1]!);
  }
  return names;
}

/** Resolve a registered handler name to its callable entry: a function value, or a class's
 *  `execute`-like method (preferring the method chained at the dispatch site), else the class. */
function resolveRegistryHandler(ctx: ResolutionContext, name: string, chained: string | null): Node | null {
  const cands = ctx.getNodesByName(name);
  const fn = cands.find((n) => n.kind === 'function');
  if (fn) return fn;
  const cls = cands.find((n) => n.kind === 'class' || n.kind === 'struct');
  if (cls) {
    const methods = ctx
      .getNodesInFile(cls.filePath)
      .filter((n) => n.kind === 'method' && n.startLine >= cls.startLine && n.startLine <= (cls.endLine ?? cls.startLine));
    const want = chained && REGISTRY_CLASS_ENTRY.has(chained) ? chained : null;
    const entry =
      (want && methods.find((m) => m.name === want)) ||
      methods.find((m) => REGISTRY_CLASS_ENTRY.has(m.name)) ||
      methods.find((m) => m.name === 'constructor');
    return entry ?? cls;
  }
  // Require a CALLABLE target — a registry dispatched as `reg[k](…)` invokes a function/
  // method, never a data `constant` (dropping it removes false positives like a `{ x: URL }`
  // entry resolving to the global URL constant).
  return cands.find((n) => n.kind === 'method') ?? null;
}

export async function objectRegistryEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scannedFiles = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if ((++scanned & 255) === 0) await onYield(); // #1091: yield mid-scan on huge graphs
    if (!REGISTRY_JS_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    // Cheap pre-filter: a computed member access BY NAME (`ident[ident`) — the dispatch shape.
    if (!content || !/[\w$]\s*\[\s*[A-Za-z_$]/.test(content)) continue;
    // Skip minified/generated bundles (draco, three.min, base64…): their pervasive `h[x](...)`
    // calls + single-letter `{a:b}` literals are a false-positive minefield. Average line
    // length is the reliable tell — real source ~30–80, minified in the hundreds/thousands.
    const newlines = (content.match(/\n/g)?.length ?? 0) + 1;
    if (content.length / newlines > 200) continue;
    const safe = stripCommentsForRegex(content, /\.(?:jsx?|mjs|cjs)$/.test(file) ? 'javascript' : 'typescript');

    // 1. Dispatch sites: `(new )?<ref>[<ident-key>]` followed by a call or a chained method.
    //    A quoted-string key (`['save']`) does NOT match — that's a static access, not dispatch.
    REGISTRY_DISPATCH_RE.lastIndex = 0;
    const dispatches: Array<{ ref: string; line: number; chained: string | null }> = [];
    let dm: RegExpExecArray | null;
    while ((dm = REGISTRY_DISPATCH_RE.exec(safe))) {
      const win = safe.slice(dm.index, dm.index + 160);
      const cm = /\x5D\s*\([^)]*\)\s*\.\s*([A-Za-z_$][\w$]*)/.exec(win) || /\x5D\s*\.\s*([A-Za-z_$][\w$]*)/.exec(win);
      dispatches.push({ ref: dm[1]!, line: safe.slice(0, dm.index).split('\n').length, chained: cm ? cm[1]! : null });
    }
    if (!dispatches.length) continue;
    // Normalize a leading `this.` so a class FIELD-INITIALIZER registry (`commands = {…}`)
    // matches a `this.commands[k]` dispatch, not just the constructor form `this.commands = {…}`.
    const norm = (r: string) => r.replace(/^this\./, '');
    const refs = new Set(dispatches.map((d) => norm(d.ref)));

    // 2. Registries: an object literal assigned to a dispatched ref, ≥2 entries resolving to callables.
    REGISTRY_ASSIGN_RE.lastIndex = 0;
    const registries = new Map<string, { names: string[]; line: number }>();
    let am: RegExpExecArray | null;
    while ((am = REGISTRY_ASSIGN_RE.exec(safe))) {
      const lhs = norm(am[1] ?? am[2]!);
      if (!refs.has(lhs) || registries.has(lhs)) continue;
      const body = braceBody(safe, am.index + am[0].length - 1);
      if (!body) continue;
      const names = registryEntryNames(body); // depth-0 `key: Identifier` entries only
      if (names.length >= REGISTRY_MIN_ENTRIES) {
        registries.set(lhs, { names, line: safe.slice(0, am.index).split('\n').length });
      }
    }
    if (!registries.size) continue;

    // 3. Link each dispatcher → each registered handler's callable entry.
    const nodesInFile = ctx.getNodesInFile(file);
    for (const d of dispatches) {
      const reg = registries.get(norm(d.ref));
      if (!reg) continue;
      const disp = enclosingFn(nodesInFile, d.line);
      if (!disp) continue;
      let added = 0;
      for (const name of reg.names) {
        if (added >= REGISTRY_FANOUT_CAP) break;
        const target = resolveRegistryHandler(ctx, name, d.chained);
        if (!target || target.id === disp.id) continue;
        const key = `${disp.id}>${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: disp.id,
          target: target.id,
          kind: 'calls',
          line: d.line,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'object-registry', via: name, registeredAt: `${file}:${reg.line}` },
        });
        added++;
      }
    }
  }
  return edges;
}
