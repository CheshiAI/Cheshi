import type { QueryBuilder } from '../db/queries';
import type { Edge } from '../types';
import { cFnPointerDispatchEdges } from './c-fnptr-synthesizer';
import { arkuiEmitterEdges, arkuiRouterEdges, arkuiStateBuildEdges } from './callback-arkui';
import { closureCollectionEdges, eventEmitterEdges, fieldChannelEdges } from './callback-channels';
import {
  flutterBuildEdges,
  reactJsxChildEdges,
  reactRenderEdges,
  svelteKitLoadEdges,
  vueTemplateEdges,
} from './callback-components';
import { erlangBehaviourDispatchEdges } from './callback-erlang';
import {
  ginMiddlewareChainEdges,
  goCrossFileMethodContainsEdges,
  goGrpcStubImplEdges,
  goImplementsEdges,
} from './callback-go';
import { laravelEventEdges } from './callback-laravel';
import { mediatrDispatchEdges } from './callback-mediatr';
import { mybatisJavaXmlEdges } from './callback-mybatis';
import {
  expoCrossPlatformEdges,
  fabricNativeImplEdges,
  rnCrossPlatformEdges,
  rnEventEdges,
} from './callback-native';
import { nixOptionPathEdges } from './callback-nix';
import { pascalFormEdges } from './callback-pascal';
import { reduxThunkEdges, rtkQueryEdges } from './callback-redux';
import { objectRegistryEdges } from './callback-registry';
import { springEventEdges } from './callback-spring';
import { celeryDispatchEdges, sidekiqDispatchEdges } from './callback-task-queues';
import { cppOverrideEdges, interfaceOverrideEdges, kotlinExpectActualEdges } from './callback-type-links';
import { piniaStoreEdges, vuexDispatchEdges } from './callback-vue-stores';
import { createYielder, type MaybeYield } from './cooperative-yield';
import { goframeRouteEdges } from './goframe-synthesizer';
import type { ResolutionContext } from './types';

/**
 * Synthesize dispatcher→callback edges (field observers + EventEmitters +
 * React re-render + JSX children + Vue templates + SvelteKit load + RN event
 * channel + Fabric native-impl + MyBatis Java↔XML + Gin middleware chain +
 * Redux-thunk dispatch chain + object-literal registry dispatch + RTK Query
 * generated-hook → endpoint + Pinia useStore().action() + Vuex string dispatch +
 * Celery task .delay()/.apply_async() → task body + Spring publishEvent → @EventListener +
 * MediatR Send/Publish → IRequestHandler/INotificationHandler +
 * Sidekiq Worker.perform_async → #perform + Laravel event(new X) → listener handle).
 * Returns the count added. Never throws into indexing — callers wrap in try/catch.
 */

/**
 * Number of progress steps synthesizeCallbackEdges reports: one per `__mark()`
 * call (every synthesis pass, plus the dedupe-merge and edge-insert steps).
 * Cosmetic only — drift just makes the progress bar end early or jump — and a
 * test pins it to the actual step count (registry passes + the fixed
 * pre/post marks) so adding a pass without bumping this fails loudly instead
 * of silently skewing the bar.
 */
const JS_FAMILY = ['typescript', 'javascript', 'tsx', 'jsx'];

/** `has(...)` shape passed to pass gates — true when the project contains any of the languages. */
type HasLang = (...ls: string[]) => boolean;

/**
 * One independent synthesis pass. Every pass scans the COMMITTED graph (plus
 * source via ctx) and returns an edge list; nothing it produces is persisted
 * until the ordered merge in synthesizeCallbackEdges — which is what makes
 * execution order free and the passes safe to fan out across the resolver
 * pool's read-only workers. `gate` short-circuits a pass whose language never
 * appears in the project (its result is provably empty — see #1212).
 */
export interface SynthPassDef {
  name: string;
  gate: (has: HasLang) => boolean;
  run: (
    queries: QueryBuilder,
    ctx: ResolutionContext,
    yieldToLoop: MaybeYield,
    subProgress?: (fraction: number) => void
  ) => Promise<Edge[]>;
}

const ALWAYS = (): boolean => true;

/**
 * The independent passes, in MERGE ORDER — the first-seen dedup in
 * synthesizeCallbackEdges follows this array, so reordering entries changes
 * which duplicate edge wins. The two Go pre-passes (cross-file method
 * `contains`, implicit `implements`) are NOT here: they persist before these
 * run because interfaceOverrideEdges reads their edges from the DB.
 */
export const SYNTH_PASSES: SynthPassDef[] = [
  { name: 'fieldEdges', gate: ALWAYS, run: (q, c, y) => fieldChannelEdges(q, c, y) },
  { name: 'closureCollEdges', gate: ALWAYS, run: (q, c, y) => closureCollectionEdges(q, c, y) },
  { name: 'emitterEdges', gate: ALWAYS, run: (_q, c, y) => eventEmitterEdges(c, y) },
  { name: 'renderEdges', gate: ALWAYS, run: (q, c, y) => reactRenderEdges(q, c, y) },
  { name: 'jsxEdges', gate: ALWAYS, run: (_q, c, y) => reactJsxChildEdges(c, y) },
  { name: 'vueEdges', gate: (has) => has('vue'), run: (_q, c, y) => vueTemplateEdges(c, y) },
  { name: 'svelteKitEdges', gate: (has) => has('svelte'), run: (_q, c, y) => svelteKitLoadEdges(c, y) },
  { name: 'pascalEdges', gate: ALWAYS, run: (_q, c, y) => pascalFormEdges(c, y) },
  { name: 'flutterEdges', gate: (has) => has('dart'), run: (q, c, y) => flutterBuildEdges(q, c, y) },
  { name: 'arkuiStateEdges', gate: (has) => has('arkts'), run: (q, c, y) => arkuiStateBuildEdges(q, c, y) },
  { name: 'arkuiEmitter', gate: (has) => has('arkts'), run: (_q, c, y) => arkuiEmitterEdges(c, y) },
  { name: 'arkuiRoutes', gate: (has) => has('arkts'), run: (_q, c, y) => arkuiRouterEdges(c, y) },
  { name: 'cppEdges', gate: (has) => has('cpp'), run: (q, _c, y) => cppOverrideEdges(q, y) },
  {
    name: 'ifaceEdges',
    gate: (has) => has('java', 'kotlin', 'csharp', 'swift', 'scala', 'go', 'rust', 'arkts', ...JS_FAMILY),
    run: (q, _c, y) => interfaceOverrideEdges(q, y),
  },
  { name: 'kotlinExpectActual', gate: (has) => has('kotlin'), run: (q, _c, y) => kotlinExpectActualEdges(q, y) },
  { name: 'goGrpcEdges', gate: (has) => has('go'), run: (q, _c, y) => goGrpcStubImplEdges(q, y) },
  { name: 'rnEventEdgesList', gate: (has) => has(...JS_FAMILY), run: (_q, c, y) => rnEventEdges(c, y) },
  { name: 'fabricNativeEdges', gate: ALWAYS, run: (_q, c, y) => fabricNativeImplEdges(c, y) },
  // Expo module nodes (`expo-module:` ids) are emitted only from .swift/.kt
  // files, and a pair needs BOTH platforms — so without both languages the
  // pass's only collection loop is provably empty (it was streaming every
  // method row on pure-Java repos to find nothing).
  { name: 'expoXPlatEdges', gate: (has) => has('swift') && has('kotlin'), run: (q, _c, y) => expoCrossPlatformEdges(q, y) },
  // An RN cross-platform edge requires a JS-language caller on the native
  // method (`isBridge`) — no JS-family files means no JS-language nodes, so
  // the result is provably empty.
  { name: 'rnXPlatEdges', gate: (has) => has(...JS_FAMILY), run: (q, _c, y) => rnCrossPlatformEdges(q, y) },
  {
    name: 'mybatisEdges',
    gate: (has) => has('java', 'kotlin') && has('xml'),
    run: (q, _c, y) => mybatisJavaXmlEdges(q, y),
  },
  { name: 'ginEdges', gate: (has) => has('go'), run: (q, c, y) => ginMiddlewareChainEdges(q, c, y) },
  { name: 'thunkEdges', gate: (has) => has(...JS_FAMILY), run: (q, c, y) => reduxThunkEdges(q, c, y) },
  { name: 'registryEdges', gate: ALWAYS, run: (_q, c, y) => objectRegistryEdges(c, y) },
  { name: 'rtkEdges', gate: (has) => has(...JS_FAMILY), run: (q, c, y) => rtkQueryEdges(q, c, y) },
  { name: 'piniaEdges', gate: (has) => has('vue', ...JS_FAMILY), run: (_q, c, y) => piniaStoreEdges(c, y) },
  { name: 'vuexEdges', gate: (has) => has('vue', ...JS_FAMILY), run: (_q, c, y) => vuexDispatchEdges(c, y) },
  { name: 'celeryEdges', gate: (has) => has('python'), run: (_q, c, y) => celeryDispatchEdges(c, y) },
  { name: 'springEdges', gate: (has) => has('java'), run: (_q, c, y) => springEventEdges(c, y) },
  { name: 'mediatrEdges', gate: (has) => has('csharp'), run: (_q, c, y) => mediatrDispatchEdges(c, y) },
  { name: 'sidekiqEdges', gate: (has) => has('ruby'), run: (_q, c, y) => sidekiqDispatchEdges(c, y) },
  {
    name: 'erlangBehaviourEdges',
    gate: (has) => has('erlang'),
    run: (q, c, y) => erlangBehaviourDispatchEdges(q, c, y),
  },
  { name: 'laravelEdges', gate: (has) => has('php'), run: (_q, c, y) => laravelEventEdges(c, y) },
  {
    name: 'cFnPtrEdges',
    gate: (has) => has('c', 'cpp'),
    run: (q, c, y, sub) => cFnPointerDispatchEdges(q, c, y, sub),
  },
  { name: 'goframeEdges', gate: (has) => has('go'), run: (_q, c, y) => goframeRouteEdges(c, y) },
  { name: 'nixOptionEdges', gate: (has) => has('nix'), run: (q, _c, y) => nixOptionPathEdges(q, y) },
];

/** Fixed non-registry steps: goMethodContains, goImplements, dedupe-merge, insertMergedEdges. */
const FIXED_SYNTH_STEPS = 4;

export const SYNTH_PROGRESS_STEPS = SYNTH_PASSES.length + FIXED_SYNTH_STEPS;

export async function synthesizeCallbackEdges(
  queries: QueryBuilder,
  ctx: ResolutionContext,
  onProgress?: (done: number, total: number) => void,
  // A live resolver pool to fan the independent passes across (structural type
  // so this file never imports the pool — resolver-worker imports THIS file).
  // Null/omitted → the sequential path, byte-identical to the pool path.
  pool?: { runSynthPass(name: string): Promise<{ edges: Edge[]; ms: number }> } | null,
  // WAL-valve writer backstop (WalCheckpointValve.backpressure), called at
  // pool-idle points in the edge-insert loops below — the passes themselves
  // only read; every write in this function happens with the pool idle.
  backpressure?: () => Promise<void> | null
): Promise<number> {
  // Each sub-pass below is a whole-graph scan, and there are ~30 of them, all
  // running synchronously on the indexer's main thread. Their AGGREGATE can run
  // for well over a minute on a large repo — long enough for the #850 liveness
  // watchdog to SIGKILL the process mid-index (#1091), since its heartbeat lives
  // on this same thread. Yield between passes so the heartbeat can fire; a pass
  // that itself hangs (a real wedge) never reaches the next yield, so the
  // watchdog still catches that. See ./cooperative-yield.
  const yieldToLoop = createYielder();

  // Synthesis runs AFTER the resolution progress bar reaches 100%, so without
  // its own progress the UI freezes at "Resolving refs 100%" for the whole
  // tail — long enough on big repos that users conclude the index hung and
  // kill it. Report each completed pass; the caller surfaces it as its own
  // progress phase. Emit 0/total up front so the phase flips immediately.
  // Emissions are throttled to whole-percent movement (each consumes a UI
  // message); values may be fractional steps from within-pass reporting.
  let passesDone = 0;
  let lastPct = -1;
  const emit = (value: number): void => {
    if (!onProgress) return;
    const v = Math.min(value, SYNTH_PROGRESS_STEPS);
    const pct = Math.floor((v / SYNTH_PROGRESS_STEPS) * 100);
    if (pct === lastPct) return;
    lastPct = pct;
    onProgress(v, SYNTH_PROGRESS_STEPS);
  };
  // A single long pass otherwise parks the bar between steps; a pass that
  // takes this callback reports a 0..1 fraction of its own work, surfaced
  // here as fractional progress within its step.
  const subProgress = (fraction: number): void =>
    emit(passesDone + Math.max(0, Math.min(fraction, 1)));
  emit(0);

  // Per-pass wall-clock timing to stderr, opt-in via CODEGRAPH_SYNTH_TIMINGS
  // (=1: passes over 250ms; =all: every pass). This is the diagnostic that
  // located both the #1091/#1122 watchdog stalls and the #1212 OOM — keep it.
  const markT = { t: Date.now() };
  const __mark = (label: string): void => {
    const now = Date.now();
    const dt = now - markT.t;
    markT.t = now;
    if (process.env.CODEGRAPH_SYNTH_TIMINGS && (dt > 250 || process.env.CODEGRAPH_SYNTH_TIMINGS === 'all')) {
      console.error(`[synth-timing] ${label}: ${dt}ms`);
    }
    passesDone++;
    emit(passesDone);
  };

  // Language gating: one indexed DISTINCT over the files table lets a pass
  // whose own filters reference a specific language/extension be skipped
  // outright when the project has no such files — its result is provably
  // empty, so skipping is behavior-identical and the cost drops to zero
  // (the Kotlin pass was the OOM culprit on the pure-C Linux kernel, #1212).
  // Passes without an explicit language filter always run.
  const langs = queries.getDistinctFileLanguages();
  const has = (...ls: string[]): boolean => ls.some((l) => langs.has(l));
  const NONE: Edge[] = [];

  // Cross-file Go method→type `contains` edges must be synthesized AND persisted
  // FIRST: a method declared in a different file from its receiver type is
  // otherwise orphaned from the struct, and goImplementsEdges (next) derives a
  // struct's method set from its `contains` edges — so without this it would
  // under-count the interfaces a cross-file struct satisfies. (#583)
  // Writer-side WAL backstop for the insert loops here (see the param doc):
  // one fstat when under the valve's hard cap, a parked full backfill past it.
  const foldIfOver = async (): Promise<void> => {
    const bp = backpressure?.();
    if (bp) await bp;
  };

  const goMethodContains = has('go') ? await goCrossFileMethodContainsEdges(queries, yieldToLoop) : NONE;
  for (let i = 0; i < goMethodContains.length; i += 2000) {
    queries.insertEdges(goMethodContains.slice(i, i + 2000));
    await yieldToLoop();
    await foldIfOver();
  }
  await yieldToLoop(); __mark('goMethodContains');

  // Go implicit `implements` edges must be synthesized AND persisted next: the
  // interface-dispatch bridge below reads `implements` edges from the DB, and
  // Go has none statically. (Other languages already have static implements
  // edges from extraction, so they don't need this pre-pass.)
  const goImpl = has('go') ? await goImplementsEdges(queries, yieldToLoop) : NONE;
  for (let i = 0; i < goImpl.length; i += 2000) {
    queries.insertEdges(goImpl.slice(i, i + 2000));
    await yieldToLoop();
    await foldIfOver();
  }
  await yieldToLoop(); __mark('goImplements');

  // Run the independent passes (see SYNTH_PASSES). Their results are merged in
  // REGISTRY ORDER below regardless of execution order, and none of their edges
  // persist until that merge — so every pass sees the same committed
  // post-resolution DB state whether it runs sequentially here or on a resolver
  // pool worker. With a live pool (already booted on ≥150k-ref repos), passes
  // fan out across its read-only workers and the per-pass wall-clock comes from
  // the worker; a pass that fails on a worker falls back to running on the main
  // thread, so a worker crash isolates to a retry instead of failing synthesis.
  const passEdges: Edge[][] = new Array<Edge[]>(SYNTH_PASSES.length).fill(NONE);
  const markPass = (label: string, dt: number): void => {
    if (process.env.CODEGRAPH_SYNTH_TIMINGS && (dt > 250 || process.env.CODEGRAPH_SYNTH_TIMINGS === 'all')) {
      console.error(`[synth-timing] ${label}: ${dt}ms`);
    }
    passesDone++;
    emit(passesDone);
  };
  const runPassOnMain = async (i: number): Promise<void> => {
    const pass = SYNTH_PASSES[i]!;
    const t0 = Date.now();
    passEdges[i] = await pass.run(queries, ctx, yieldToLoop, subProgress);
    await yieldToLoop();
    markPass(pass.name, Date.now() - t0);
  };

  const gatedIn: number[] = [];
  for (let i = 0; i < SYNTH_PASSES.length; i++) {
    if (SYNTH_PASSES[i]!.gate(has)) gatedIn.push(i);
    else markPass(SYNTH_PASSES[i]!.name, 0);
  }

  // Above this node count, a pass that OOM-killed its worker must NOT be
  // retried on the main thread — the retry would OOM the whole process and
  // take the index with it (the #1212 failure class). Below it, a worker
  // failure is more likely a transient crash than a memory ceiling, and the
  // main-thread retry keeps coverage. Skipping loses only that pass's
  // synthesized edges; the index still completes.
  const MAIN_RETRY_MAX_NODES = 1_500_000;
  const graphNodes = queries.getNodeAndEdgeCount().nodes;

  if (pool && gatedIn.length > 1) {
    await Promise.all(
      gatedIn.map(async (i) => {
        const pass = SYNTH_PASSES[i]!;
        try {
          const out = await pool.runSynthPass(pass.name);
          passEdges[i] = out.edges;
          markPass(pass.name, out.ms);
        } catch (err) {
          if (graphNodes > MAIN_RETRY_MAX_NODES) {
            // Worker died at a scale where the main-thread retry is a process
            // OOM risk: skip the pass, keep the index alive, and say so.
            console.error(
              `[synthesis] pass '${pass.name}' failed on a worker at ${graphNodes} nodes — skipped (edges from this pass are absent): ${err instanceof Error ? err.message : String(err)}`
            );
            markPass(`${pass.name} (skipped at scale)`, 0);
            return;
          }
          // Worker-side failure (crash, OOM, unknown pass after a version
          // mismatch): retry this one pass on the main thread.
          await runPassOnMain(i);
        }
      })
    );
  } else {
    for (const i of gatedIn) {
      await runPassOnMain(i);
    }
  }

  const merged: Edge[] = [];
  const seen = new Set<string>();
  for (const e of passEdges.flat()) {
    const key = `${e.source}>${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  __mark('dedupe-merge');
  // Chunked insert with yields: on the Linux kernel the merged synthesized
  // edge set is ~275k rows, and one transaction for all of them was a 20s
  // unyielded main-thread span (#1212 follow-up) — the last one in the tail.
  for (let i = 0; i < merged.length; i += 2000) {
    queries.insertEdges(merged.slice(i, i + 2000));
    await yieldToLoop();
    await foldIfOver();
  }
  __mark('insertMergedEdges');
  return merged.length + goImpl.length + goMethodContains.length;
}
