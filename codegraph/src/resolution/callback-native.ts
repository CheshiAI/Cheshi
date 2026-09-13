import type { QueryBuilder } from '../db/queries';
import type { Edge, Node } from '../types';
import { EVENT_FANOUT_CAP } from './callback-channels';
import { enclosingFn, makeLineAt } from './callback-source';
import type { MaybeYield } from './cooperative-yield';
import type { ResolutionContext } from './types';

/**
 * React Native cross-language event channel (Phase 3 of the mixed-iOS/RN
 * bridging effort). Same shape as `eventEmitterEdges` but cross-language:
 *
 *   Native (ObjC, on RCTEventEmitter subclass):
 *     [self sendEventWithName:@"locationUpdate" body:@{...}];
 *
 *   Native (Java/Kotlin, via the JS module dispatcher):
 *     emitter.emit("locationUpdate", body);
 *     reactContext.getJSModule(RCTDeviceEventEmitter.class).emit("locationUpdate", body);
 *
 *   JS (subscriber):
 *     new NativeEventEmitter(NativeModules.Geo).addListener("locationUpdate", handler);
 *     DeviceEventEmitter.addListener("locationUpdate", handler);
 *
 * Synthesize: native dispatch site → JS handler, keyed by the literal
 * event name. Only matches NAMED handlers (the existing `ON_RE` named-
 * capture form). Inline arrow handlers like `addListener('x', d => …)`
 * aren't named at extraction time and would need link-through-body
 * support; matches the deliberate scope of the in-language synthesizer.
 *
 * Provenance `'heuristic'`, synthesizedBy `'rn-event-channel'`.
 */
// ObjC's `[self sendEventWithName:@"X" body:...]` shape (bracket syntax,
// `@` string literals).
const RN_OBJC_SEND_RE = /\bsendEventWithName\s*:\s*@"([^"]+)"/g;

// Swift's `sendEvent(withName: "X", body: ...)` shape — same RCTEventEmitter
// method, different call syntax. Both Objective-C and Swift subclass
// RCTEventEmitter so this catches the Swift-side equivalent emission sites
// (e.g. RNFusedLocation.swift's `sendEvent(withName: "geolocationDidChange",
// body: locationData)`).
const RN_SWIFT_SEND_RE = /\bsendEvent\s*\(\s*withName\s*:\s*"([^"]+)"/g;

// JVM-side emitter calls: `emitter.emit("X", body)`. Matches both Java
// and Kotlin syntax because the call form is identical. Restricted to
// JVM source files in the consumer so we don't re-process JS emits
// (which `eventEmitterEdges` already handles).
const RN_JVM_EMIT_RE = /\.emit\s*\(\s*"([^"]+)"\s*,/g;

// Custom `sendEvent(reactContext, "X", body)` wrapper — extremely common
// (react-native-device-info and many libs wrap `DeviceEventManagerModule…emit`
// behind a helper whose `.emit(eventName, …)` uses a VARIABLE, so RN_JVM_EMIT_RE
// misses it; the literal lives in the wrapper CALL instead). Captures the first
// string literal inside a `sendEvent(...)` call. `[^;{}]*?` keeps it on one
// statement and stops at a block boundary, so the wrapper DEFINITION (whose `(`
// is followed by `… ) {`) never matches. Multi-line tolerant. (java/kotlin/swift)
const RN_NATIVE_SENDEVENT_RE = /\bsendEvent\s*\([^;{}]*?"([^"]+)"/g;

export async function rnEventEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scannedFiles = 0;
  // Native dispatchers (source = the native method whose body sends the
  // event) and JS handlers (target = the function/method registered as
  // the listener) keyed by event name.
  const nativeDispatchersByEvent = new Map<string, Set<string>>();
  const jsHandlersByEvent = new Map<string, Map<string, string>>();

  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    const content = ctx.readFile(file);
    if (!content) continue;

    const nodesInFile = ctx.getNodesInFile(file);
    const lineOf = makeLineAt(content, 1);
    const addDispatcher = (event: string, line: number) => {
      const disp = enclosingFn(nodesInFile, line);
      if (!disp) return;
      const set = nativeDispatchersByEvent.get(event) ?? new Set<string>();
      set.add(disp.id);
      nativeDispatchersByEvent.set(event, set);
    };

    // ObjC side: `sendEventWithName:@"X"` only fires inside `.m`/`.mm`
    // files (RCTEventEmitter subclasses).
    if (file.endsWith('.m') || file.endsWith('.mm')) {
      RN_OBJC_SEND_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = RN_OBJC_SEND_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index));
      }
    }

    // Swift side: same RCTEventEmitter method, parens/named-args syntax.
    if (file.endsWith('.swift')) {
      RN_SWIFT_SEND_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = RN_SWIFT_SEND_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index));
      }
      RN_NATIVE_SENDEVENT_RE.lastIndex = 0;
      while ((m = RN_NATIVE_SENDEVENT_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index));
      }
    }

    // JVM side: `.emit("X", …)` in Java/Kotlin, plus the common
    // `sendEvent(ctx, "X", body)` wrapper. (We pattern-match anywhere in the
    // file; the JS in-language path uses a separate emitter object pattern and
    // is already handled by eventEmitterEdges.)
    if (file.endsWith('.java') || file.endsWith('.kt')) {
      let m: RegExpExecArray | null;
      RN_JVM_EMIT_RE.lastIndex = 0;
      while ((m = RN_JVM_EMIT_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index));
      }
      RN_NATIVE_SENDEVENT_RE.lastIndex = 0;
      while ((m = RN_NATIVE_SENDEVENT_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index));
      }
    }

    // JS subscribers (.addListener("X", handler)). Restrict to JS-family
    // files so a native file's `addListener:` (the ObjC method) doesn't
    // get mistaken for a JS subscription — they're entirely different
    // things despite sharing a name.
    if (
      file.endsWith('.js') ||
      file.endsWith('.jsx') ||
      file.endsWith('.ts') ||
      file.endsWith('.tsx') ||
      file.endsWith('.mjs') ||
      file.endsWith('.cjs')
    ) {
      // Match BOTH the named-handler form (`.addListener('x', fn)`) and
      // an unnamed-handler form (`.addListener('x', listener)` where
      // `listener` is a parameter — common in RN wrapper APIs like
      // RNFirebase's `messaging().onMessageReceived(listener)`). For the
      // unnamed case we attribute the subscription to the ENCLOSING JS
      // function (the abstraction layer), giving a reachability-correct
      // hop even when the actual user-side handler lives one call up.
      const ADDLISTENER_ANY = /\.(?:on|once|addListener)\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_][\w.]*)/g;
      ADDLISTENER_ANY.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ADDLISTENER_ANY.exec(content))) {
        const event = m[1];
        const arg = m[2];
        if (!event || !arg) continue;
        const bareName = arg.includes('.') ? arg.slice(arg.lastIndexOf('.') + 1) : arg;
        // Try a named-symbol match first (matches the in-language semantic).
        const namedHandler = ctx
          .getNodesByName(bareName)
          .find((n) => n.kind === 'function' || n.kind === 'method');
        let targetId: string | null = namedHandler?.id ?? null;
        if (!targetId) {
          // Fall back to the enclosing function — the subscribe-wrapper
          // pattern means the event fires THROUGH this function on its
          // way to user code. Reachability-correct attribution.
          const enclosing = enclosingFn(nodesInFile, lineOf(m.index));
          targetId = enclosing?.id ?? null;
        }
        if (!targetId) {
          // Broader fallback for JS object-literal API shape
          // (`const Foo = { watchX(...) { … addListener(...) … } }`):
          // method shorthand inside an object literal isn't extracted
          // as a method node, so enclosingFn returns null. Attribute to
          // the smallest enclosing `constant` / `variable` node — that's
          // the API surface a downstream caller would `import` and
          // invoke. Reachability-correct.
          const line = lineOf(m.index);
          let smallest: typeof nodesInFile[number] | null = null;
          for (const n of nodesInFile) {
            if (n.kind !== 'constant' && n.kind !== 'variable') continue;
            const end = n.endLine ?? n.startLine;
            if (n.startLine <= line && end >= line) {
              if (!smallest || n.startLine >= smallest.startLine) smallest = n;
            }
          }
          targetId = smallest?.id ?? null;
        }
        if (!targetId) continue;
        const map = jsHandlersByEvent.get(event) ?? new Map<string, string>();
        map.set(targetId, `${file}:${lineOf(m.index)}`);
        jsHandlersByEvent.set(event, map);
      }
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [event, dispatchers] of nativeDispatchersByEvent) {
    const handlers = jsHandlersByEvent.get(event);
    if (!handlers) continue;
    // Same fan-out guard as the in-language channel: generic event names
    // (e.g. 'change', 'error', 'data') with many handlers/dispatchers
    // can't be matched precisely without receiver-type info.
    if (dispatchers.size > EVENT_FANOUT_CAP || handlers.size > EVENT_FANOUT_CAP) continue;
    for (const d of dispatchers) {
      for (const [h, registeredAt] of handlers) {
        if (d === h) continue;
        const key = `${d}>${h}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: d,
          target: h,
          kind: 'calls',
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'rn-event-channel', event, registeredAt },
        });
      }
    }
  }
  return edges;
}

/**
 * Phase 6 — React Native Fabric/Codegen view component bridge.
 *
 * The Fabric framework extractor (`frameworks/fabric.ts`) emits
 * `component` nodes named after the JS-visible component (e.g.
 * `RNSScreenStack`) from each `codegenNativeComponent<Props>('Name')`
 * spec declaration. The native implementation lives in an ObjC++/.mm or
 * Kotlin/Java class whose name follows one of RN's conventions:
 *
 *   - Exact: `RNSScreenStack`
 *   - With suffix: `RNSScreenStackView`, `RNSScreenStackViewManager`,
 *     `RNSScreenStackComponentView`, `RNSScreenStackManager`
 *
 * This synthesizer walks every Fabric component node and looks for a
 * native class matching one of those names; when found, emits a
 * `calls` edge `component → native class` (provenance `'heuristic'`,
 * `synthesizedBy:'fabric-native-impl'`) so trace from JSX usage of the
 * component continues into native.
 *
 * The convention-based suffix lookup is precise: there's no name
 * collision in RN view-manager codebases by design (Codegen output would
 * conflict otherwise).
 */
const FABRIC_NATIVE_SUFFIXES = ['', 'View', 'ViewManager', 'ComponentView', 'Manager'];

/**
 * Expo Modules cross-platform pairing. An Expo Module exposes the SAME
 * JS-visible method (`AsyncFunction("getBatteryLevelAsync")`) from BOTH an iOS
 * (Swift) and an Android (Kotlin) implementation. A JS callsite name-resolves to
 * only ONE of them, so the other platform's impl looked like nothing called it
 * (and editing it showed no blast radius). Link the iOS and Android impls of the
 * same `<module>.<method>` to each other (both directions), so a JS call that
 * reaches one platform reaches the other, and editing either surfaces the JS
 * caller. The Expo method nodes are id-prefixed `expo-module:` and qualified
 * `<file>::<module>.<method>` by the framework extractor.
 */
export async function expoCrossPlatformEdges(queries: QueryBuilder, onYield: MaybeYield): Promise<Edge[]> {
  let scanned255 = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const byKey = new Map<string, Node[]>();
  for (const m of queries.iterateNodesByKind('method')) {
    if ((++scanned255 & 63) === 0) await onYield();
    if (!m.id.startsWith('expo-module:')) continue;
    const key = m.qualifiedName.split('::').pop(); // `<module>.<method>`
    if (!key) continue;
    const arr = byKey.get(key);
    if (arr) arr.push(m);
    else byKey.set(key, [m]);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const a of group) {
      for (const b of group) {
        if (a.id === b.id || a.language === b.language) continue; // cross-platform only
        const key = `${a.id}>${b.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: a.id,
          target: b.id,
          kind: 'calls',
          line: a.startLine,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'expo-cross-platform', via: a.name },
        });
      }
    }
  }
  return edges;
}

/**
 * Classic React Native NativeModules cross-platform pairing. A native module
 * method (`@ReactMethod` on Android, `RCT_EXPORT_METHOD` on iOS) is implemented
 * on BOTH platforms, but a JS callsite name-resolves to only ONE — so the other
 * platform's impl looked like nothing called it. A native method that HAS a JS
 * caller is a confirmed bridge method; link it to the same-named native method
 * in another language (the other platform's impl) so a JS call reaching one
 * platform reaches the other, and editing either surfaces the JS caller.
 *
 * Names are normalized to the first selector keyword (`getFreeDiskStorage:` →
 * `getFreeDiskStorage`) — that's the JS-visible name, and how the iOS selector
 * lines up with the bare Android method name.
 */
export async function rnCrossPlatformEdges(queries: QueryBuilder, onYield: MaybeYield): Promise<Edge[]> {
  let scanned255 = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const NATIVE = new Set(['java', 'kotlin', 'objc', 'cpp']);
  const JS = new Set(['typescript', 'tsx', 'javascript', 'jsx']);
  // RN module INFRASTRUCTURE methods exist on every native module (called by the
  // RN runtime, not user JS), so pairing them by name would cross-link unrelated
  // modules in a multi-module repo. Skip them — they aren't user-facing methods.
  const RN_INFRA = new Set([
    'addListener', 'removeListeners', 'getConstants', 'constantsToExport', 'getName',
    'invalidate', 'initialize', 'getDefaultEventTypes', 'supportedEvents',
    'requiresMainQueueSetup', 'methodQueue',
  ]);
  const norm = (name: string): string => {
    const i = name.indexOf(':');
    return i >= 0 ? name.slice(0, i) : name;
  };

  // Index native methods by their JS-visible (normalized) name. Only names with
  // impls in ≥2 native languages can pair, so the per-method JS-caller check
  // below only runs for genuine cross-platform candidates.
  const byName = new Map<string, Node[]>();
  for (const m of queries.iterateNodesByKind('method')) {
    if ((++scanned255 & 63) === 0) await onYield();
    if (!NATIVE.has(m.language)) continue;
    const key = norm(m.name);
    const arr = byName.get(key);
    if (arr) arr.push(m);
    else byName.set(key, [m]);
  }

  for (const [groupName, group] of byName) {
    if (RN_INFRA.has(groupName)) continue;
    const langs = new Set(group.map((m) => m.language));
    if (langs.size < 2) continue; // single-platform — nothing to pair
    for (const m of group) {
      // Is m a bridge method? (a JS-language `calls` edge points at it)
      const incoming = queries.getIncomingEdges(m.id, ['calls']);
      if (incoming.length === 0) continue;
      const sources = queries.getNodesByIds(incoming.map((e) => e.source));
      const isBridge = incoming.some((e) => {
        const s = sources.get(e.source);
        return !!s && JS.has(s.language);
      });
      if (!isBridge) continue;
      // Link to the other-platform impls (both directions).
      for (const sib of group) {
        if (sib.id === m.id || sib.language === m.language) continue;
        for (const [a, b] of [[m, sib], [sib, m]] as const) {
          const key = `${a.id}>${b.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({
            source: a.id,
            target: b.id,
            kind: 'calls',
            line: a.startLine,
            provenance: 'heuristic',
            metadata: { synthesizedBy: 'rn-cross-platform', via: norm(m.name) },
          });
        }
      }
    }
  }
  return edges;
}

export async function fabricNativeImplEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scanned255 = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();

  // The Fabric extractor IDs are prefixed `fabric-component:` so we can
  // filter to just those while streaming — never materializing the whole
  // `component` kind (#1212).
  const components: Node[] = [];
  for (const n of (ctx.iterateNodesByKind?.('component') ?? ctx.getNodesByKind('component'))) {
    if ((++scanned255 & 63) === 0) await onYield();
    if (n.id.startsWith('fabric-component:')) components.push(n);
  }
  if (components.length === 0) return edges;

  // Pre-index native classes by name for O(1) lookup.
  const nativeClassesByName = new Map<string, Node[]>();
  for (const n of (ctx.iterateNodesByKind?.('class') ?? ctx.getNodesByKind('class'))) {
    if ((++scanned255 & 63) === 0) await onYield();
    if (n.language !== 'objc' && n.language !== 'kotlin' && n.language !== 'java' && n.language !== 'cpp') continue;
    const arr = nativeClassesByName.get(n.name);
    if (arr) arr.push(n);
    else nativeClassesByName.set(n.name, [n]);
  }

  for (const component of components) {
    for (const suffix of FABRIC_NATIVE_SUFFIXES) {
      const candidate = component.name + suffix;
      const matches = nativeClassesByName.get(candidate);
      if (!matches || matches.length === 0) continue;
      // Link the component node to every matching native class (iOS +
      // Android each have one).
      for (const native of matches) {
        const key = `${component.id}>${native.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: component.id,
          target: native.id,
          kind: 'calls',
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'fabric-native-impl',
            viaSuffix: suffix || '(exact)',
            componentName: component.name,
          },
        });
      }
    }
  }

  return edges;
}
