import type { QueryBuilder } from '../db/queries';
import type { Edge, Node } from '../types';
import { enclosingFn } from './callback-source';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import type { ResolutionContext } from './types';

// ── Erlang behaviour-callback dispatch ────────────────────────────────────────
// An Erlang behaviour is a compile-checked callback contract: the behaviour
// module declares `-callback init(...) -> ...`, implementers declare
// `-behaviour(B)` and export the callbacks, and the framework side dispatches
// through a VARIABLE module — cowboy's `Handler:init(Req, Opts)` and
// `Middleware:execute(Req, Env)` folds, ejabberd's `Mod:start/2`. Extraction
// deliberately leaves var-module calls silent (no static target), so the flow
// breaks at exactly the hop agents ask about (request → handler init). Bridge:
//
//   dispatch site `Var:fn(args…)` → every in-repo implementer of the behaviour
//   declaring `fn` with the SITE's arity — provided exactly ONE in-repo
//   behaviour declares (fn, arity); a name+arity collision across behaviours
//   bails (silent beats wrong) — and the implementer defines and exports `fn`.
//
// Behaviours are discovered by scanning every Erlang file for `-callback`
// declarations (not just `implements` targets), so a behaviour with zero
// implementers still participates in the ambiguity gate. Fan-out control: a
// mega-behaviour (ejabberd's gen_mod, ~200 mod_* implementers) would mint
// hundreds of edges per site that READ as complete coverage while being
// arbitrary — above the cap the site is skipped entirely and the boundary
// stays visibly dynamic (explore's boundary announcer covers it) instead of
// silently truncated.
const ERLANG_EXT = /\.(?:erl|hrl)$/;

// `Var:fn(` — variable (capitalized) module, lowercase function, immediate
// open-paren. The leading char class rejects `?MODULE:fn(` (macro), `a:b(`
// (static remote call, already linked), and mid-word matches.
const ERLANG_DISPATCH_RE = /(^|[^?\w@'])([A-Z][A-Za-z0-9_@]*):([a-z][A-Za-z0-9_@]*)\(/g;

const ERLANG_CALLBACK_DECL_RE = /(^|\n)\s*-callback\s+('[^'\n]+'|[a-z][A-Za-z0-9_@]*)\s*\(/g;

const ERLANG_BEHAVIOUR_FANOUT_CAP = 24;

/**
 * Argument count of the call/declaration whose `(` sits at `openIdx` —
 * top-level commas + 1, `()` → 0, unbalanced/oversized → -1. Skips nested
 * (), [], {}, <<>> content, `"strings"`, `'atoms'`, and `$c` char literals,
 * so `-callback init(fun((a, b) -> ok), #{k => v}) -> ok.` counts 2.
 */
function erlangArityAt(src: string, openIdx: number): number {
  let depth = 1;
  let commas = 0;
  let sawArg = false;
  const limit = Math.min(src.length, openIdx + 4000);
  for (let i = openIdx + 1; i < limit; i++) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      i++;
      while (i < limit && src[i] !== ch) {
        if (src[i] === '\\') i++;
        i++;
      }
      sawArg = true;
      continue;
    }
    if (ch === '$') {
      i++;
      if (src[i] === '\\') i++;
      sawArg = true;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; sawArg = true; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return sawArg ? commas + 1 : 0;
      continue;
    }
    if (ch === ',' && depth === 1) { commas++; continue; }
    if (!/\s/.test(ch)) sawArg = true;
  }
  return -1;
}

export async function erlangBehaviourDispatchEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scannedFiles = 0;
  let scanned255 = 0;
  // Cheap language gate: no Erlang modules → no cost beyond one streamed
  // kind scan (never a materialized array of every namespace — #1212).
  const erlangModules: Node[] = [];
  for (const n of queries.iterateNodesByKind('namespace')) {
    if ((++scanned255 & 63) === 0) await onYield();
    if (n.language === 'erlang') erlangModules.push(n);
  }
  if (erlangModules.length === 0) return [];

  // Pass 1 — scan every Erlang file with `-callback` decls: behaviour module →
  // its (name, arity) callback set, and the global `name/arity` → declaring
  // behaviours map that drives the ambiguity gate.
  const moduleByFile = new Map<string, Node>();
  for (const ns of erlangModules) {
    if (!moduleByFile.has(ns.filePath)) moduleByFile.set(ns.filePath, ns);
  }
  const declaringBehaviours = new Map<string, Node[]>(); // `fn/arity` → behaviour namespaces
  const callbackNames = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if (!ERLANG_EXT.test(file)) continue;
    const behaviour = moduleByFile.get(file);
    if (!behaviour) continue; // a .hrl or module-less file can't be a behaviour
    const content = ctx.readFile(file);
    if (!content || !content.includes('-callback')) continue;
    const safe = stripCommentsForRegex(content, 'erlang');
    ERLANG_CALLBACK_DECL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ERLANG_CALLBACK_DECL_RE.exec(safe))) {
      const name = m[2]!.replace(/^'|'$/g, '');
      const arity = erlangArityAt(safe, m.index + m[0].length - 1);
      if (arity < 0) continue;
      const key = `${name}/${arity}`;
      const arr = declaringBehaviours.get(key);
      if (arr) {
        if (!arr.some((b) => b.id === behaviour.id)) arr.push(behaviour);
      } else {
        declaringBehaviours.set(key, [behaviour]);
      }
      callbackNames.add(name);
    }
  }
  if (declaringBehaviours.size === 0) return [];

  // Implementer target lookup, lazy per (behaviour, fn): implementers come
  // from the `implements` edges extraction resolved, and the target is the
  // implementer module's own exported `fn` function node.
  const targetCache = new Map<string, Node[]>();
  const targetsOf = (behaviour: Node, fn: string): Node[] => {
    const cacheKey = `${behaviour.id}#${fn}`;
    let targets = targetCache.get(cacheKey);
    if (targets) return targets;
    targets = [];
    for (const e of queries.getIncomingEdges(behaviour.id, ['implements'])) {
      const impl = queries.getNodeById(e.source);
      if (!impl || impl.language !== 'erlang' || impl.kind !== 'namespace') continue;
      const fnNode = ctx
        .getNodesInFile(impl.filePath)
        .find((n) => n.kind === 'function' && n.name === fn && n.isExported !== false);
      if (fnNode) targets.push(fnNode);
    }
    targetCache.set(cacheKey, targets);
    return targets;
  };

  // Pass 2 — dispatch sites. Only files containing a var-module call shape are
  // scanned in full.
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if (!ERLANG_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || !/[A-Z][A-Za-z0-9_@]*:[a-z]/.test(content)) continue;
    const safe = stripCommentsForRegex(content, 'erlang');
    const nodesInFile = ctx.getNodesInFile(file);
    ERLANG_DISPATCH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ERLANG_DISPATCH_RE.exec(safe))) {
      const fn = m[3]!;
      if (!callbackNames.has(fn)) continue;
      const openIdx = m.index + m[0].length - 1;
      const arity = erlangArityAt(safe, openIdx);
      if (arity < 0) continue;
      const behaviours = declaringBehaviours.get(`${fn}/${arity}`);
      if (!behaviours || behaviours.length !== 1) continue; // unknown or ambiguous
      const behaviour = behaviours[0]!;
      const targets = targetsOf(behaviour, fn);
      if (targets.length === 0 || targets.length > ERLANG_BEHAVIOUR_FANOUT_CAP) continue;
      const line = safe.slice(0, m.index).split('\n').length;
      const disp = enclosingFn(nodesInFile, line);
      if (!disp) continue;
      for (const target of targets) {
        if (target.id === disp.id) continue;
        const key = `${disp.id}>${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: disp.id,
          target: target.id,
          kind: 'calls',
          line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'erlang-behaviour',
            via: `${behaviour.name}:${fn}/${arity}`,
            registeredAt: `${file}:${line}`,
          },
        });
      }
    }
  }
  return edges;
}
