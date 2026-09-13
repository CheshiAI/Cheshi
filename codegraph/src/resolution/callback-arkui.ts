import type { QueryBuilder } from '../db/queries';
import type { Edge, Node } from '../types';
import { MAX_CALLBACKS_PER_CHANNEL } from './callback-channels';
import { sliceLines } from './callback-source';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import type { ResolutionContext } from './types';

/**
 * Reactive ArkUI property decorators: assigning a property carrying one of
 * these re-runs the owning struct's `build()`. Covers both state models —
 * V1 (`@Component`: State/Prop/Link/Provide/Consume/Storage*) and V2
 * (`@ComponentV2`: Local/Provider/Consumer; `@Param` is read-only in V2 so
 * the assignment gate never fires on it, and `@Trace` lives on `@ObservedV2`
 * data classes, not struct properties).
 */
const ARKUI_REACTIVE_DECORATORS = new Set([
  'State', 'Prop', 'Link', 'Provide', 'Consume', 'StorageLink', 'StorageProp',
  'LocalStorageLink', 'LocalStorageProp', 'ObjectLink',
  'Local', 'Provider', 'Consumer',
]);

/** ArkUI-observed array mutators — `this.todos.push(x)` re-renders like an assignment. */
const ARKUI_ARRAY_MUTATORS = 'push|pop|shift|unshift|splice|sort|reverse|fill';

/**
 * Phase 4b-ets: ArkUI state → build (the ArkTS analog of react-render /
 * flutter-build). Assigning a reactive-decorated property (`@State count`,
 * `@Link selected`, …) re-runs the `@Component struct`'s `build()`, but that
 * hop is framework-internal — no static edge — so "onClick → markAllDone →
 * this.todos = […] → rebuilt list" dead-ends at the assignment. Bridge it:
 * for each arkts struct with a `build()` method and at least one reactive
 * property, link every sibling method whose body ASSIGNS (or array-mutates)
 * one of those properties → `build`. Assignment-gated on the struct's OWN
 * reactive property names — a method that merely reads state, or a struct
 * with no reactive properties, gets nothing (this is the precision line the
 * all-sibling-methods design would erase).
 */
export async function arkuiStateBuildEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scanned255 = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const struct of queries.iterateNodesByKind('struct')) {
    if ((++scanned255 & 63) === 0) await onYield();
    if (struct.language !== 'arkts') continue;
    const children = queries.getOutgoingEdges(struct.id, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n);
    const build = children.find((n) => n.kind === 'method' && n.name === 'build');
    if (!build) continue;
    const reactiveProps = children.filter(
      (n) => n.kind === 'property' && (n.decorators ?? []).some((d) => ARKUI_REACTIVE_DECORATORS.has(d))
    );
    if (reactiveProps.length === 0) continue;
    const propAlternation = reactiveProps
      .map((p) => p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    // `this.count = …` / `+=` / `++` / `--` / `this.todos.push(…)`. The
    // `=(?!=)` keeps `this.done == x` comparisons out.
    const mutationRe = new RegExp(
      `this\\.(${propAlternation})\\s*(?:=(?!=)|\\+\\+|--|[+\\-*/%&|^]=|\\.(${ARKUI_ARRAY_MUTATORS})\\s*\\()`
    );
    let added = 0;
    for (const m of children) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      if (m.kind !== 'method' || m.id === build.id) continue;
      const content = ctx.readFile(m.filePath);
      const src = content && sliceLines(content, m.startLine, m.endLine);
      if (!src || !mutationRe.test(stripCommentsForRegex(src, 'typescript'))) continue;
      const key = `${m.id}>${build.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: m.id, target: build.id, kind: 'calls', line: m.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'arkui-state', via: 'state assignment', registeredAt: `${build.filePath}:${build.startLine}` },
      });
      added++;
    }
  }
  return edges;
}

/** Emit/subscribe call sites of HarmonyOS's `@ohos.events.emitter` bus. */
const ARKUI_EMITTER_CALL_RE = /\bemitter\s*\.\s*(emit|on|once)\s*\(\s*([A-Za-z_$][\w$.]*|\{[^)]{0,120}?\beventId\s*:\s*[^,}]+[^)]*?\x7D)/g;

/** Cap per event bucket — a generic key with many parties is dynamic routing, not a static pair. */
const ARKUI_EMITTER_FANOUT_CAP = 8;

/**
 * Phase 4b-ets2: HarmonyOS `@ohos.events.emitter` bridge. The cross-component
 * bus — `emitter.emit(eventId)` fires `emitter.on(eventId, cb)` — is
 * framework-internal, so an order flow riding it (OrangeShopping's
 * add-to-cart) dead-ends at the emit. Link emit-site enclosing
 * function/method → on/once-site enclosing function/method when both
 * reference the SAME statically-recoverable event key.
 *
 * Key recovery, per call site (comment-stripped enclosing-file source): the
 * first argument is an `{ eventId: K }` literal, a `Names.Dotted` constant, or
 * a local whose same-file declaration is `new EventsId(K)` / `= K` — chase one
 * level. Precision scoping learned from the samples monorepo (thousands of
 * unrelated samples, most using eventId 1): NUMERIC keys pair within the same
 * FILE only; NAMED keys pair within the same workspace module directory (or
 * the whole project when it declares no modules — the single-app case), both
 * behind a fan-out cap. Inline `on(id, (e) => {…})` arrows need no special
 * handling — their bodies' calls already attribute to the registering method,
 * so targeting that method keeps the chain connected.
 */
export async function arkuiEmitterEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scannedFiles = 0;
  interface Site { nodeId: string; file: string; line: number }
  // bucket key -> emit sites / handler sites
  const emits = new Map<string, Site[]>();
  const handlers = new Map<string, Site[]>();

  const moduleDirs = (() => {
    const ws = ctx.getWorkspacePackages?.();
    return ws ? [...new Set(ws.byName.values())].sort((a, b) => b.length - a.length) : [];
  })();
  const moduleScopeOf = (file: string): string => {
    for (const dir of moduleDirs) {
      if (file === dir || file.startsWith(dir + '/')) return dir;
    }
    return '';
  };

  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if (!file.endsWith('.ets')) continue;
    const content = ctx.readFile(file);
    if (!content || !content.includes('emitter.')) continue;
    const safe = stripCommentsForRegex(content, 'typescript');
    const nodes = ctx.getNodesInFile(file)
      .filter((n) => n.kind === 'method' || n.kind === 'function');

    ARKUI_EMITTER_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ARKUI_EMITTER_CALL_RE.exec(safe))) {
      const verb = m[1]!;
      const arg = m[2]!.trim();
      const line = safe.slice(0, m.index).split('\n').length;
      const encl = nodes
        .filter((n) => n.startLine <= line && n.endLine >= line)
        .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
      if (!encl) continue;

      // Recover the event key from the first argument.
      let key: string | null = null;
      const idLit = arg.startsWith('{') ? arg.match(/\beventId\s*:\s*([\w$.]+)/)?.[1] : undefined;
      const token = idLit ?? arg;
      if (token !== undefined) {
        if (/^\d+$/.test(token)) {
          key = `num:${file}:${token}`; // numeric: same-file only
        } else if (token.includes('.')) {
          key = `name:${moduleScopeOf(file)}:${token}`;
        } else {
          // Local variable — chase its same-file declaration one level:
          // `let x = new EventsId(K)` / `const x = K`.
          const declRe = new RegExp(
            `\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b\\s*(?::[^=\\n]+)?=\\s*(?:new\\s+[\\w$.]+\\(\\s*([^)\\n]+?)\\s*\\)|([\\w$.]+))`
          );
          const decl = safe.match(declRe);
          const inner = (decl?.[1] ?? decl?.[2])?.trim();
          if (inner && /^\d+$/.test(inner)) key = `num:${file}:${inner}`;
          else if (inner && /^[\w$.]+$/.test(inner)) key = `name:${moduleScopeOf(file)}:${inner}`;
        }
      }
      if (!key) continue;

      const site: Site = { nodeId: encl.id, file, line };
      if (verb === 'emit') {
        (emits.get(key) ?? emits.set(key, []).get(key)!).push(site);
      } else {
        (handlers.get(key) ?? handlers.set(key, []).get(key)!).push(site);
      }
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [key, emitSites] of emits) {
    const handlerSites = handlers.get(key);
    if (!handlerSites) continue;
    if (emitSites.length > ARKUI_EMITTER_FANOUT_CAP || handlerSites.length > ARKUI_EMITTER_FANOUT_CAP) continue;
    const eventLabel = key.slice(key.lastIndexOf(':') + 1);
    for (const e of emitSites) for (const h of handlerSites) {
      if (e.nodeId === h.nodeId) continue;
      const dedupe = `${e.nodeId}>${h.nodeId}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      edges.push({
        source: e.nodeId, target: h.nodeId, kind: 'calls', line: e.line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'arkui-emitter', event: eventLabel, registeredAt: `${h.file}:${h.line}` },
      });
    }
  }
  return edges;
}

/** `router.pushUrl({ url: 'pages/Detail' })` / replaceUrl — literal urls only. */
const ARKUI_ROUTER_RE = /\brouter\s*\.\s*(?:pushUrl|replaceUrl)\s*\(\s*\{[^)]{0,200}?\burl\s*:\s*['"]([\w\-./]+)['"]/g;

/**
 * Phase 4b-ets3: HarmonyOS page navigation. `router.pushUrl({ url:
 * 'pages/Detail' })` reaches the `@Entry struct` of
 * `<module>/src/main/ets/pages/Detail.ets`, but the hop is a string — no
 * static edge — so "tap → openDetail → ???" ends at the router call. Bridge
 * literal urls to the page struct: the url resolves against the standard
 * `src/main/ets/` layout (what main_pages.json entries name); candidates
 * prefer the caller's own workspace module (routes are module-scoped), and
 * anything still ambiguous is dropped rather than guessed. Only `@Entry`
 * structs qualify as targets — the decorator is what makes a file a page.
 */
export async function arkuiRouterEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const edges: Edge[] = [];
  const seen = new Set<string>();

  const allFiles = ctx.getAllFiles();
  const moduleDirs = (() => {
    const ws = ctx.getWorkspacePackages?.();
    return ws ? [...new Set(ws.byName.values())].sort((a, b) => b.length - a.length) : [];
  })();
  const moduleScopeOf = (file: string): string => {
    for (const dir of moduleDirs) {
      if (file === dir || file.startsWith(dir + '/')) return dir;
    }
    return '';
  };

  let scannedFiles = 0;
  for (const file of allFiles) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if (!file.endsWith('.ets')) continue;
    const content = ctx.readFile(file);
    if (!content || !content.includes('router.')) continue;
    const safe = stripCommentsForRegex(content, 'typescript');
    const nodes = ctx.getNodesInFile(file)
      .filter((n) => n.kind === 'method' || n.kind === 'function');

    ARKUI_ROUTER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ARKUI_ROUTER_RE.exec(safe))) {
      const url = m[1]!;
      const line = safe.slice(0, m.index).split('\n').length;
      const encl = nodes
        .filter((n) => n.startLine <= line && n.endLine >= line)
        .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
      if (!encl) continue;

      const suffix = `/src/main/ets/${url}.ets`;
      let candidates = allFiles.filter((f) => f.endsWith(suffix));
      if (candidates.length > 1) {
        const scope = moduleScopeOf(file);
        const sameModule = candidates.filter((f) => moduleScopeOf(f) === scope);
        if (sameModule.length > 0) candidates = sameModule;
      }
      if (candidates.length !== 1) continue; // ambiguous or unresolved — never guess

      const page = ctx.getNodesInFile(candidates[0]!).find(
        (n) => n.kind === 'struct' && (n.decorators ?? []).includes('Entry')
      );
      if (!page) continue;

      const key = `${encl.id}>${page.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: encl.id, target: page.id, kind: 'calls', line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'arkui-route', event: url, registeredAt: `${candidates[0]}:${page.startLine}` },
      });
    }
  }
  return edges;
}
