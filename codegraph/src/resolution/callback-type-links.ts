import type { QueryBuilder } from '../db/queries';
import type { Edge, Node } from '../types';
import { MAX_CALLBACKS_PER_CHANNEL } from './callback-channels';
import type { MaybeYield } from './cooperative-yield';

/**
 * Phase 4c: C++ virtual override. A call through a base/interface pointer
 * (`db->Get(...)`, `iter->Next()`) dispatches at runtime to a subclass override,
 * but that hop is a vtable indirection — no static call edge — so a flow stops at
 * the abstract base method. Bridge it like react-render: for each C++ class that
 * `extends` a base, link each base method → the subclass method of the same name
 * (the override), so trace/callees from the interface method reach the
 * implementation(s). Over-approximation accepted (reachability-correct); capped
 * per class and gated to C++ to avoid touching other languages' dispatch.
 */
export async function cppOverrideEdges(queries: QueryBuilder, onYield: MaybeYield): Promise<Edge[]> {
  let scanned255 = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const methodsOf = (classId: string): Node[] =>
    queries
      .getOutgoingEdges(classId, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
  for (const cls of queries.iterateNodesByKind('class')) {
    if ((++scanned255 & 63) === 0) await onYield();
    const subMethods = methodsOf(cls.id).filter((n) => n.language === 'cpp');
    if (subMethods.length === 0) continue;
    for (const ext of queries.getOutgoingEdges(cls.id, ['extends'])) {
      const base = queries.getNodeById(ext.target);
      if (!base || base.language !== 'cpp' || base.id === cls.id) continue;
      const baseMethods = new Map(methodsOf(base.id).map((m) => [m.name, m]));
      let added = 0;
      for (const m of subMethods) {
        if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
        const bm = baseMethods.get(m.name);
        if (!bm || bm.id === m.id) continue;
        const key = `${bm.id}>${m.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: bm.id,
          target: m.id,
          kind: 'calls',
          line: bm.startLine,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'cpp-override', via: m.name, registeredAt: `${m.filePath}:${m.startLine}` },
        });
        added++;
      }
    }
  }
  return edges;
}

/**
 * Phase 5.5: interface / abstract dispatch (Java, Kotlin). A call through an
 * injected interface (`@Autowired FooService svc; svc.list()`) or an abstract
 * base dispatches at runtime to the implementing class's override — a vtable
 * indirection with no static call edge — so a request→service flow stops at the
 * interface method. Bridge it like cpp-override: for each class that
 * `implements` an interface (or `extends` an abstract base), link each
 * base/interface method → the class's same-name method (the override) so
 * trace/callees reach the implementation. Over-approximation accepted
 * (reachability-correct); capped per class, gated to JVM languages.
 */
// Languages whose static `implements`/`extends` edges should bridge an
// interface (or abstract base) method to the matching concrete-class method.
// The set is "languages with explicit nominal subtyping and a single class
// kind that holds methods" — i.e. the shape this loop expects. Swift and
// Scala fit shape-wise (Swift `protocol`/`class`, Scala `trait`/`class`)
// and are added below; their concrete-side nodes can be a `struct` (Swift)
// or an `object` (Scala) so the loop also iterates those kinds.
const IFACE_OVERRIDE_LANGS = new Set([
  'java', 'kotlin', 'csharp', 'typescript', 'javascript', 'swift', 'scala', 'go', 'rust',
  'arkts',
]);

/**
 * Kotlin Multiplatform `expect`/`actual` linking. A `common` source set declares
 * `expect fun foo()` / `expect class Bar`; each platform source set (jvm, native,
 * js, …) provides an `actual` implementation with the IDENTICAL fully-qualified
 * name in a different file. Callers in common code resolve to the `expect`
 * declaration, so every `actual` impl ends up with zero dependents — invisible to
 * impact/affected even though editing it can break every caller of the API.
 *
 * Synthesize a `calls` edge from the common declaration to each platform `actual`
 * (mirroring the interface-impl bridge: abstract → concrete), so editing a
 * platform impl surfaces the common `expect` and its callers, and the impl file
 * participates in the graph.
 *
 * `expect`/`actual` are captured onto the node's `decorators` list at extraction
 * (kotlin.ts `extractModifiers`). Members of an `expect class` are NOT themselves
 * keyword-marked, so the declaration side is matched as the same-FQN, same-kind
 * node that is NOT marked `actual`. Requiring an `actual`-marked counterpart also
 * gates out plain cross-file overloads (neither side is marked).
 */
// Kinds that an `expect`/`actual` pair may legitimately straddle. `expect class`
// is routinely fulfilled by an `actual typealias` (e.g. `actual typealias
// CancellationException = …`, `actual typealias SchedulerTask = Task`), so a
// strict kind match would miss those one-line alias files. Same-FQN + the
// `actual` marker already gates out unrelated symbols, so widening to the
// type-like kinds is safe.
const KMP_TYPE_KINDS = new Set(['class', 'interface', 'struct', 'enum', 'type_alias']);

function kmpKindsCompatible(a: string, b: string): boolean {
  return a === b || (KMP_TYPE_KINDS.has(a) && KMP_TYPE_KINDS.has(b));
}

export async function kotlinExpectActualEdges(queries: QueryBuilder, onYield: MaybeYield): Promise<Edge[]> {
  let scanned255 = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  // SQL-side language+decorator pre-filter, streamed. The old
  // `getAllNodes().filter(...)` hydrated the ENTIRE node table into one array
  // just to find kotlin `actual` declarations — on a 2M-node graph that alone
  // exceeded Node's default heap and killed the index (#1212). The LIKE
  // pre-filter can over-match (substring), so the exact decorator check stays.
  for (const act of queries.iterateNodesByLanguageWithDecorator('kotlin', 'actual')) {
    if ((++scanned255 & 63) === 0) await onYield();
    if (!act.decorators?.includes('actual')) continue;
    let added = 0;
    for (const cand of queries.getNodesByQualifiedNameExact(act.qualifiedName)) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      // The declaration side: same FQN + compatible kind, a different file, NOT
      // itself an `actual` (that would be a sibling platform impl, not the decl).
      if (cand.language !== 'kotlin' || cand.id === act.id) continue;
      if (!kmpKindsCompatible(cand.kind, act.kind) || cand.filePath === act.filePath) continue;
      if (cand.decorators?.includes('actual')) continue;
      const key = `${cand.id}>${act.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: cand.id,
        target: act.id,
        kind: 'calls',
        line: cand.startLine,
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'kotlin-expect-actual',
          via: act.name,
          registeredAt: `${act.filePath}:${act.startLine}`,
        },
      });
      added++;
    }
  }
  return edges;
}

export async function interfaceOverrideEdges(queries: QueryBuilder, onYield: MaybeYield): Promise<Edge[]> {
  let scanned255 = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  // Memoized: a popular base interface's method list is otherwise re-fetched
  // once per implementer (dubbo-style hub interfaces have hundreds), and the
  // memo only ever serves reads. Same rows, same order — byte-identical.
  const methodsMemo = new Map<string, Node[]>();
  const methodsOf = (classId: string): Node[] => {
    const hit = methodsMemo.get(classId);
    if (hit) return hit;
    const methods = queries
      .getOutgoingEdges(classId, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
    methodsMemo.set(classId, methods);
    return methods;
  };
  // Concrete-side kinds vary by language: `class` covers Java / Kotlin /
  // C# / TS / Swift-classes / Scala-classes; `struct` covers Swift value
  // types that conform to protocols. Iterate both.
  const concreteKinds = ['class', 'struct'] as const;
  for (const kind of concreteKinds) {
    for (const cls of queries.iterateNodesByKind(kind)) {
      if ((++scanned255 & 63) === 0) await onYield();
      // A class can only emit here if it HAS a supertype edge — check that
      // (one edge query) before materializing its methods: most classes in a
      // typical graph extend/implement nothing and skip in one hop.
      const sups = queries.getOutgoingEdges(cls.id, ['implements', 'extends']);
      if (sups.length === 0) continue;
      const implMethods = methodsOf(cls.id).filter((n) => IFACE_OVERRIDE_LANGS.has(n.language));
      if (implMethods.length === 0) continue;
      for (const sup of sups) {
        const base = queries.getNodeById(sup.target);
        if (!base || !IFACE_OVERRIDE_LANGS.has(base.language) || base.id === cls.id) continue;
        // Group impl methods by name to handle OVERLOADS: an interface `list()` and
        // `list(params)` are distinct nodes and a call may resolve to either, so
        // link every base overload → every same-name impl overload (keying by name
        // alone would drop all but one and miss the resolved overload).
        const implByName = new Map<string, Node[]>();
        for (const m of implMethods) {
          const arr = implByName.get(m.name);
          if (arr) arr.push(m); else implByName.set(m.name, [m]);
        }
        let added = 0;
        for (const bm of methodsOf(base.id)) {
          if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
          for (const m of implByName.get(bm.name) ?? []) {
            if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
            if (bm.id === m.id) continue;
            const key = `${bm.id}>${m.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({
              source: bm.id,
              target: m.id,
              kind: 'calls',
              line: bm.startLine,
              provenance: 'heuristic',
              metadata: { synthesizedBy: 'interface-impl', via: m.name, registeredAt: `${m.filePath}:${m.startLine}` },
            });
            added++;
          }
        }
      }
    }
  }
  return edges;
}
