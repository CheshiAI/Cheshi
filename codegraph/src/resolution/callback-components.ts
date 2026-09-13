import type { QueryBuilder } from '../db/queries';
import type { Edge, Node } from '../types';
import { MAX_CALLBACKS_PER_CHANNEL } from './callback-channels';
import { sliceLines } from './callback-source';
import type { MaybeYield } from './cooperative-yield';
import type { ResolutionContext } from './types';

const SETSTATE_RE = /this\.setState\s*\(/;

const FLUTTER_SETSTATE_RE = /\bsetState\s*\(/;

// Flutter: setState((){…}) / this.setState
const JSX_TAG_RE = /<([A-Z][A-Za-z0-9_]*)[\s/>]/g;

const MAX_JSX_CHILDREN = 30;

// Vue SFC templates: kebab-case child components (<el-button> → ElButton) and
// event bindings (@click="fn" / v-on:click="fn"). PascalCase children (<VPNav/>)
// are already caught by JSX_TAG_RE via the SFC component node.
const VUE_KEBAB_RE = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]/g;

// PascalCase component tags — `<MediaCard ...>`, `<NavBar/>`. HTML elements are
// lowercase, so an uppercase-initial tag is a component usage; built-ins
// (`<NuxtLink>`, `<Transition>`) simply resolve to nothing and emit no edge.
const VUE_PASCAL_RE = /<([A-Z][A-Za-z0-9]*)[\s/>]/g;

const VUE_HANDLER_RE = /(?:@|v-on:)([a-zA-Z][\w-]*)(?:\.\w+)*\s*=\s*"([^"]+)"/g;

// Composable/hook destructure: `const { close: closeSidebar } = useSidebarControl()`.
// Captures the destructure body + the called composable; only `use*` calls qualify.
const VUE_DESTRUCTURE_RE = /(?:const|let|var)\s*\{([^}]+)\x7D\s*=\s*(\w+)\s*\(/g;

function kebabToPascal(s: string): string {
  return s.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

/**
 * Nuxt auto-import name for a component, derived from its path UNDER `components/`:
 * `components/media/Card.vue` → `MediaCard`, `components/base/foo/Bar.vue` →
 * `BaseFooBar`. Each directory segment and the filename is PascalCased and
 * concatenated; a directory whose PascalCase name prefixes the next segment is
 * collapsed (Nuxt's de-dup: `base/BaseButton.vue` → `BaseButton`, not
 * `BaseBaseButton`). Returns null for a flat component (`components/NavBar.vue`)
 * — its node is already named by basename, so a direct tag match finds it.
 */
function nuxtComponentName(filePath: string): string | null {
  const marker = filePath.lastIndexOf('components/');
  if (marker === -1) return null;
  const rel = filePath.slice(marker + 'components/'.length).replace(/\.(vue|ts|tsx|js|jsx)$/i, '');
  const segs = rel.split('/').filter(Boolean).map(kebabToPascal);
  if (segs.length < 2) return null;
  const out: string[] = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && s.startsWith(prev)) out[out.length - 1] = s;
    else out.push(s);
  }
  return out.join('');
}

/**
 * Phase 4: React class-component re-render. `this.setState(...)` re-runs the
 * component's `render()`, but that hop is React-internal — no static edge — so a
 * flow like "mutation → setState → canvas repaint" dead-ends at setState even
 * though `render → getRenderableElements → …` is fully call-connected after it.
 * Bridge it: for each class that has a `render` method, link every sibling method
 * whose body calls `this.setState(` → `render`. The setState gate keeps this to
 * React class components (a non-React class with a `render` method won't call
 * `this.setState`). Over-approximation (all setState methods reach render) is
 * accepted — it's reachability-correct, like the callback channels.
 */
export async function reactRenderEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scanned255 = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  // A class can only emit here if it CONTAINS a method named `render` — so one
  // indexed name lookup bounds the candidate set up front, and the class scan
  // below skips everything else before its per-class edge/node queries. On a
  // repo with few/no render methods (any non-React codebase) this collapses
  // the pass from every-class fan-out to ~zero DB work, with identical output:
  // the skipped classes fail the same `render` check today, just after paying
  // for their children. (Not a language gate: `render` + `this.setState(` in
  // Java — e.g. Litho — legitimately matches today and still does.)
  const renderOwners = new Set<string>();
  for (const n of ctx.getNodesByName('render')) {
    if (n.kind !== 'method') continue;
    for (const e of queries.getIncomingEdges(n.id, ['contains'])) renderOwners.add(e.source);
  }
  if (renderOwners.size === 0) return edges;
  for (const cls of queries.iterateNodesByKind('class')) {
    if ((++scanned255 & 63) === 0) await onYield();
    if (!renderOwners.has(cls.id)) continue;
    const children = queries.getOutgoingEdges(cls.id, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
    const render = children.find((n) => n.name === 'render');
    if (!render) continue;
    let added = 0;
    for (const m of children) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      if (m.id === render.id) continue;
      const content = ctx.readFile(m.filePath);
      const src = content && sliceLines(content, m.startLine, m.endLine);
      if (!src || !SETSTATE_RE.test(src)) continue;
      const key = `${m.id}>${render.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: m.id, target: render.id, kind: 'calls', line: m.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'react-render', via: 'setState', registeredAt: `${render.filePath}:${render.startLine}` },
      });
      added++;
    }
  }
  return edges;
}

/**
 * Phase 4b: Flutter setState → build (the Dart analog of react-render). In a
 * StatefulWidget's State class, `setState(() {…})` re-runs `build(context)`, but
 * that hop is framework-internal (Flutter calls build), so a flow like
 * "onPressed → _increment → setState → rebuilt UI" dead-ends at setState. Bridge
 * it: for each Dart class with a `build` method, link every sibling method whose
 * body calls `setState(` → `build`. The setState gate + `.dart` file keep this to
 * Flutter State classes. Over-approximation accepted (reachability-correct).
 */
export async function flutterBuildEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scanned255 = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const cls of queries.iterateNodesByKind('class')) {
    if ((++scanned255 & 63) === 0) await onYield();
    const children = queries.getOutgoingEdges(cls.id, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
    const build = children.find((n) => n.name === 'build');
    if (!build || !build.filePath.endsWith('.dart')) continue;
    let added = 0;
    for (const m of children) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      if (m.id === build.id) continue;
      const content = ctx.readFile(m.filePath);
      const src = content && sliceLines(content, m.startLine, m.endLine);
      if (!src || !FLUTTER_SETSTATE_RE.test(src)) continue;
      const key = `${m.id}>${build.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: m.id, target: build.id, kind: 'calls', line: m.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'flutter-build', via: 'setState', registeredAt: `${build.filePath}:${build.startLine}` },
      });
      added++;
    }
  }
  return edges;
}

/**
 * Phase 5: React JSX child rendering. A component that returns `<Child .../>`
 * mounts Child — React calls it — but JSX instantiation isn't a static call edge,
 * so a render tree (App.render → StaticCanvas → renderStaticScene) breaks at the
 * JSX hop. Link parent → each capitalized JSX child it renders. File-oriented
 * (read each JSX file once). Precision gate: the child name must resolve to a
 * component/function/class node — TS generics like `Array<Foo>` resolve to a type
 * (or nothing) and are dropped.
 */
export async function reactJsxChildEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scannedFiles = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const PARENT_KINDS = new Set(['method', 'function', 'component']);
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if ((++scanned & 255) === 0) await onYield(); // #1091: yield mid-scan on huge graphs
    const content = ctx.readFile(file);
    if (!content || (!content.includes('</') && !content.includes('/>'))) continue; // JSX-file gate
    const parents = ctx.getNodesInFile(file).filter((n) => PARENT_KINDS.has(n.kind));
    for (const parent of parents) {
      const src = sliceLines(content, parent.startLine, parent.endLine);
      if (!src || (!src.includes('</') && !src.includes('/>'))) continue;
      const names = new Set<string>();
      JSX_TAG_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = JSX_TAG_RE.exec(src))) names.add(m[1]!);
      let added = 0;
      for (const name of names) {
        if (added >= MAX_JSX_CHILDREN) break;
        const child = ctx.getNodesByName(name).find(
          (n) => n.kind === 'component' || n.kind === 'function' || n.kind === 'class'
        );
        if (!child || child.id === parent.id) continue;
        const key = `${parent.id}>${child.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: parent.id, target: child.id, kind: 'calls', line: parent.startLine,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'jsx-render', via: name },
        });
        added++;
      }
    }
  }
  return edges;
}

/**
 * Phase 6: Vue SFC templates. The `.vue` extractor only parses `<script>`, so
 * template usage is invisible — child components and event handlers used ONLY in
 * the template have no edge to them. PascalCase children (`<VPNav/>`) are already
 * caught by reactJsxChildEdges (which scans the SFC component node), so this adds
 * the two Vue-specific shapes:
 *   - kebab-case children: `<el-button>` → `ElButton` component (renders).
 *   - event bindings: `@click="onClick"` / `v-on:submit="save"` → handler method.
 * Scoped to the `<template>` block of `.vue` files; resolution gate (kebab→
 * component, handler→function/method) keeps precision; inline arrows / `$emit`
 * skipped.
 */
export async function vueTemplateEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scannedFiles = 0;
  let scanned255 = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const COMPONENT_KINDS = new Set(['component', 'function', 'class']);
  const HANDLER_KINDS = new Set(['method', 'function']);
  // A composable's returned member may be a fn (`function close(){}`) or an
  // arrow assigned to a const (`const close = () => {}`).
  const RETURN_KINDS = new Set(['method', 'function', 'variable', 'constant']);
  // Nuxt auto-imports nested components by a DIRECTORY-PREFIXED name —
  // `components/media/Card.vue` is used as `<MediaCard/>`, not `<Card/>` — but
  // the component node is named by basename (`Card`), so a direct tag match
  // misses it (flat components match by basename and don't need this). Map each
  // nested component's Nuxt name → node so those template usages resolve.
  const nuxtComponents = new Map<string, Node>();
  for (const c of (ctx.iterateNodesByKind?.('component') ?? ctx.getNodesByKind('component'))) {
    if ((++scanned255 & 63) === 0) await onYield();
    const nn = nuxtComponentName(c.filePath);
    if (nn && !nuxtComponents.has(nn)) nuxtComponents.set(nn, c);
  }
  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if (!file.endsWith('.vue')) continue;
    const content = ctx.readFile(file);
    const tpl = content && content.match(/<template[^>]*>([\s\S]*)<\/template>/i)?.[1];
    if (!tpl) continue;
    const comp = ctx.getNodesInFile(file).find((n) => n.kind === 'component');
    if (!comp) continue;

    // Composable-destructure map: alias → { composable, key }. Lets us resolve a
    // template handler that isn't a local function but a destructured composable
    // return (`@click="closeSidebar"` ← `const { close: closeSidebar } = useSidebarControl()`).
    const script = content.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? '';
    const destructured = new Map<string, { composable: string; key: string }>();
    VUE_DESTRUCTURE_RE.lastIndex = 0;
    let dm: RegExpExecArray | null;
    while ((dm = VUE_DESTRUCTURE_RE.exec(script))) {
      if (!/^use[A-Z]/.test(dm[2]!)) continue; // composables / hooks only
      for (const part of dm[1]!.split(',')) {
        const pm = part.trim().match(/^(\w+)\s*(?::\s*(\w+))?$/); // key | key: alias
        if (pm) destructured.set(pm[2] || pm[1]!, { composable: dm[2]!, key: pm[1]! });
      }
    }

    let added = 0;
    const addEdge = (target: Node | undefined, meta: Record<string, unknown>) => {
      if (added >= MAX_JSX_CHILDREN || !target || target.id === comp.id) return;
      const k = `${comp.id}>${target.id}>${meta.synthesizedBy}`;
      if (seen.has(k)) return;
      seen.add(k);
      edges.push({ source: comp.id, target: target.id, kind: 'calls', line: comp.startLine, provenance: 'heuristic', metadata: meta });
      added++;
    };
    // Prefer a target in THIS SFC (handlers live in the same file's script) —
    // avoids cross-file mis-match when a name repeats across a monorepo.
    const resolve = (name: string, kinds: Set<string>): Node | undefined => {
      const matches = ctx.getNodesByName(name).filter((n) => kinds.has(n.kind));
      return matches.find((n) => n.filePath === file) ?? matches[0];
    };

    let m: RegExpExecArray | null;
    VUE_KEBAB_RE.lastIndex = 0;
    while ((m = VUE_KEBAB_RE.exec(tpl))) {
      const tag = kebabToPascal(m[1]!);
      addEdge(resolve(tag, COMPONENT_KINDS) ?? nuxtComponents.get(tag), { synthesizedBy: 'jsx-render', via: m[1] });
    }
    // PascalCase component tags. Try a direct name match first (flat components
    // and explicit registrations), then the Nuxt dir-prefixed auto-import name
    // (`<MediaCard>` → components/media/Card.vue). Built-ins match neither → no edge.
    VUE_PASCAL_RE.lastIndex = 0;
    while ((m = VUE_PASCAL_RE.exec(tpl))) {
      const tag = m[1]!;
      addEdge(resolve(tag, COMPONENT_KINDS) ?? nuxtComponents.get(tag), { synthesizedBy: 'jsx-render', via: tag });
    }
    VUE_HANDLER_RE.lastIndex = 0;
    while ((m = VUE_HANDLER_RE.exec(tpl))) {
      const event = m[1]!;
      const expr = m[2]!.trim();
      if (expr.includes('=>') || expr.startsWith('$')) continue; // inline arrow / $emit
      const name = expr.match(/^([A-Za-z_]\w*)/)?.[1];
      if (!name) continue;
      const direct = resolve(name, HANDLER_KINDS);
      if (direct) { addEdge(direct, { synthesizedBy: 'vue-handler', event }); continue; }
      // Composable-destructure handler → resolve to the composable's returned fn.
      const d = destructured.get(name);
      if (!d) continue;
      const composable = resolve(d.composable, HANDLER_KINDS);
      // Resolve to the SPECIFIC returned member (e.g. `close`) defined in the
      // composable's file. No fallback to the composable itself — the component
      // already has a static `useX()` call edge, so that would just be redundant
      // and less precise.
      const keyFn = composable
        ? ctx.getNodesByName(d.key).find((n) => RETURN_KINDS.has(n.kind) && n.filePath === composable.filePath)
        : undefined;
      if (keyFn) addEdge(keyFn, { synthesizedBy: 'vue-handler', event, via: d.composable });
    }
  }
  return edges;
}

/**
 * SvelteKit file-convention data flow. A route directory's `+page.svelte` (a
 * `component` node) receives its `data` from the sibling `+page.server.{ts,js}`
 * / `+page.{ts,js}` `load` function and posts forms to its `actions` — wired by
 * the framework BY FILE PATH, with no static import between them. So editing a
 * `load` shows no impact on the page it feeds, and the page looks like it has no
 * server-side dependency. Link the page component to its sibling loader's
 * `load` / `actions` (same for `+layout`). The pairing is path-deterministic
 * (same directory, matching `+page`/`+layout` prefix), so it's precise — but
 * it's a framework-convention edge, so provenance stays `heuristic`.
 *
 * Direction: page → load, so `getImpactRadius(load)` surfaces the page (editing
 * a loader's data shows the page it feeds) and the page's dependencies include
 * its loader.
 */
export async function svelteKitLoadEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scannedFiles = 0;
  const edges: Edge[] = [];
  const allFiles = new Set(ctx.getAllFiles());
  const HOOKS = new Set(['load', 'actions']);
  const HOOK_KINDS = new Set(['function', 'method', 'constant', 'variable']);
  for (const file of allFiles) {
    if ((++scannedFiles & 255) === 0) await onYield();
    const m = file.match(/(.*\/)(\+(?:page|layout))\.svelte$/);
    if (!m) continue;
    const dir = m[1]!;
    const prefix = m[2]!;
    const page = ctx.getNodesInFile(file).find((n) => n.kind === 'component');
    if (!page) continue;
    for (const ext of ['.server.ts', '.server.js', '.ts', '.js']) {
      const loaderFile = `${dir}${prefix}${ext}`;
      if (!allFiles.has(loaderFile)) continue;
      for (const hook of ctx.getNodesInFile(loaderFile)) {
        if (!HOOK_KINDS.has(hook.kind) || !HOOKS.has(hook.name)) continue;
        edges.push({
          source: page.id,
          target: hook.id,
          kind: 'references',
          line: page.startLine,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'sveltekit-load',
            via: hook.name,
            registeredAt: `${loaderFile}:${hook.startLine ?? 0}`,
          },
        });
      }
    }
  }
  return edges;
}
