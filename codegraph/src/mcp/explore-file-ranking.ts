import { isGeneratedFile } from '../extraction/generated-detection';
import type CodeGraph from '../index';
import { normalizeNameToken } from '../search/query-utils';
import type { Edge, Node, Subgraph } from '../types';
import {
  isConfigLeafNode
} from '../utils';
import type { ToolHandlerState } from './tool-handler-state';

export function rankExploreFiles(
  this: ToolHandlerState,
  cg: CodeGraph,
  query: string,
  subgraph: Subgraph,
) {


  // Graph-aware glue: findRelevantContext builds the subgraph from name/text
  // search, so a method that BRIDGES named symbols — e.g. App.tsx's
  // triggerRender, which calls the named triggerUpdate — is never a search hit
  // and gets missed, forcing the agent to Read the file to trace it. Pull in
  // the callers/callees of the entry (root) nodes, but ONLY those that live in
  // files the subgraph already surfaces (where the agent reads to fill gaps),
  // so we add wiring without dragging in unrelated files. These get an
  // importance boost below so they survive the per-file cluster budget.
  const glueNodeIds = new Set<string>();
  const subgraphFiles = new Set<string>();
  for (const n of subgraph.nodes.values()) subgraphFiles.add(n.filePath);
  const GLUE_NODE_CAP = 60;
  for (const rootId of subgraph.roots) {
    if (glueNodeIds.size >= GLUE_NODE_CAP) break;
    let neighbors: Node[] = [];
    try {
      neighbors = [
        ...cg.getCallers(rootId).map(c => c.node),
        ...cg.getCallees(rootId).map(c => c.node),
      ];
    } catch {
      continue;
    }
    for (const nb of neighbors) {
      if (glueNodeIds.size >= GLUE_NODE_CAP) break;
      if (subgraph.nodes.has(nb.id)) continue;
      if (!subgraphFiles.has(nb.filePath)) continue;
      subgraph.nodes.set(nb.id, nb);
      glueNodeIds.add(nb.id);
    }
  }

  // Named-symbol seeding: findRelevantContext is an FTS/text rank, so a query
  // that's a BAG of symbol names skewed toward one phase (Alamofire: 5 build
  // terms, each a high-frequency name, vs 3 validate terms) lets the
  // lower-frequency names fall below the search cut — their definitions, and
  // whole files (Validation.swift), never get gathered, so they can never
  // render and the agent Reads them. Resolve EACH named token to its
  // substantive definition (skip empty stubs + test files, same relevance the
  // trace endpoint picker uses) and inject it as an entry, so every symbol the
  // agent explicitly named is in the subgraph and its file is scored.
  const namedSeedIds = new Set<string>();
  const exactQueryRootIds = new Set<string>();
  // The subset of named seeds that earns the named-FIRST sort tier. We still
  // SEED every ≤3-def name (so RWR / flow ranking is unchanged), but only the
  // most-substantive def is tiered — a bare name's unrelated namesakes (Go's
  // `NewClient` = real client + test fake + xds pool) must not fill the tier
  // and crowd out the real answer file (grpc's `dialoptions.go`). Corroborated
  // overloads (the query also named the type) all earn it. (#1064)
  const tierSeedIds = new Set<string>();
  {
    const FILE_EXT = /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte|astro|erl|hrl)$/i;
    const CALLABLE = new Set(['method', 'function', 'component', 'constructor']);
    const isTestPath = (p: string) => /(^|\/)(tests?|specs?|__tests__|testdata|mocks?|fixtures?)\//i.test(p) || /\.(test|spec)\.[a-z]+$/i.test(p);
    const bodyLines = (n: Node) => Math.max(0, (n.endLine ?? n.startLine) - n.startLine);
    const callerCount = (n: Node) => { try { return cg.getCallers(n.id).length; } catch { return 0; } };
    const tokens = [...new Set(
      query.split(/[\s,()[\]]+/)
        .map((t) => t.replace(FILE_EXT, '').trim())
        .filter((t) => t.length >= 3 && /^[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*$/.test(t))
    )].slice(0, 16);
    for (const id of subgraph.roots) {
      const node = subgraph.nodes.get(id);
      if (node && tokens.some((token) => this.matchesSymbol(node, token))) exactQueryRootIds.add(id);
    }
    // PascalCase tokens in the query are type/file disambiguators — when the
    // agent writes "DataRequest task validate", the `task`/`validate` it wants
    // are DataRequest's, NOT the same-named overloads in Validation.swift /
    // Concurrency.swift / the abstract base. Used below to bias overloaded
    // names toward the file/class the query also names. EXCLUDE the project
    // name (a PascalCase token a user naturally includes) — it names the whole
    // repo, so biasing toward it just pulls overloads to whichever stack
    // embeds it, re-burying the rest (#720).
    const projectNameTokens = cg.getProjectNameTokens();
    const typeTokens = tokens.filter(
      (o) => /^[A-Z][A-Za-z0-9]{3,}/.test(o) && !projectNameTokens.has(normalizeNameToken(o)),
    );
    const inNamedContext = (n: Node) =>
      typeTokens.some((ct) => {
        const lc = ct.toLowerCase();
        return n.filePath.toLowerCase().includes(lc) || n.qualifiedName.toLowerCase().includes(lc);
      });
    // NL-stopword guard: this seeding treats every token as "a symbol the
    // agent named", but explore also takes natural-language questions, whose
    // ordinary English words collide with real callables — "…check the latest
    // version…" exact-matched a lone `check()` method, which then earned the
    // named-FIRST sort tier and displaced the corroborated answer files from
    // the whole render budget (the agent fell back to Read). A shape-precise
    // token (camelCase, PascalCase, snake_case, qualified) is an unambiguous
    // symbol reference and seeds unconditionally; a BARE lowercase word seeds
    // only where the query corroborates the file — another query token is
    // itself a symbol defined in that same file (the "check drain fire"
    // sibling-bag case), which an incidental English-word collision never is.
    const lcTokens = new Set(tokens.map((x) => x.toLowerCase()));
    const isPreciseToken = (x: string) =>
      /[._$]|::|\//.test(x) || /[a-z][A-Z]/.test(x) || /^[A-Z]/.test(x);
    const fileNameSets = new Map<string, Set<string>>();
    const coNamedInFile = (t: string, fp: string): boolean => {
      let names = fileNameSets.get(fp);
      if (!names) {
        names = new Set<string>();
        try {
          for (const n of cg.getNodesInFile(fp)) names.add(n.name.toLowerCase());
        } catch { /* unreadable file entry — treat as uncorroborated */ }
        fileNameSets.set(fp, names);
      }
      const self = t.toLowerCase();
      for (const o of lcTokens) {
        if (o !== self && names.has(o)) return true;
      }
      return false;
    };
    for (const t of tokens) {
      // Enumerate ALL defs of a bare token via the direct index, not FTS — a
      // 50+-overload name (tokio `poll`) ranks the wanted def (`Harness::poll`)
      // below the FTS cut, so findAllSymbols would never see it and the
      // type-token bias below couldn't pick the harness.rs one. (Same fix as
      // codegraph_node's findSymbolMatches.) Qualified tokens keep findAllSymbols.
      const isQual = /[.\/]|::/.test(t);
      const raw = isQual ? this.findAllSymbols(cg, t).nodes : cg.getNodesByName(t);
      let cands = raw
        .filter((n) => CALLABLE.has(n.kind) && !isTestPath(n.filePath))
        .sort((a, b) => (bodyLines(b) > 1 ? 1 : 0) - (bodyLines(a) > 1 ? 1 : 0) || bodyLines(b) - bodyLines(a));
      // Field-name seeding fallback (#1196): a camelCase token that names NO
      // definition of its own is usually an object-literal key / API field
      // (`profileInfo`) — no node exists, so it contributed zero seeds and
      // the files that DEFINE it (`getProfileInfoV2` in profileController)
      // never surfaced. Seed its camel-infix definers instead: callables
      // whose name contains the token at a hump boundary or as a prefix.
      // Exact-empty + camel-shaped only (bare words keep the NL-stopword
      // guard below), shortest-first, capped so a hot infix can't flood.
      if (cands.length === 0 && !isQual && /[a-z][A-Z]/.test(t)) {
        const lcToken = t.toLowerCase();
        cands = cg
          .getNodesByNameSubstring(t, {
            kinds: ['function', 'method', 'component'],
            limit: 60,
          })
          .filter((n) => CALLABLE.has(n.kind) && !isTestPath(n.filePath))
          .filter((n) => {
            const idx = n.name.toLowerCase().indexOf(lcToken);
            if (idx < 0) return false;
            if (idx === 0) return n.name.length > t.length; // prefix definer
            return /[A-Z]/.test(n.name.charAt(idx)); // camel-hump boundary
          })
          .sort((a, b) => a.name.length - b.name.length)
          .slice(0, 3);
      }
      // Bare lowercase words only seed defs their query-siblings corroborate
      // (see the NL-stopword guard above). Filtering CANDS (not picks) applies
      // the guard uniformly to both branches below, including the >3-def
      // single-pick fallback — an uncorroborated bare `run` must not tier its
      // most-substantive namesake any more than a 1-def `check` may.
      if (!isPreciseToken(t)) {
        cands = cands.filter((n) => coNamedInFile(t, n.filePath));
      }
      // A specific name (<=3 defs) injects all its defs. An overloaded name
      // (`validate` = 10, `request` = 44) would flood the subgraph, so inject
      // only: the overloads whose file/class the query ALSO names (the agent
      // told us which one it wants — DataRequest's, not Validation.swift's),
      // capped; else fall back to the single most-substantive def. This is the
      // explore-side mirror of codegraph_node's overload disambiguation.
      let picks: Node[];
      let tierPicks: Node[]; // subset that earns the named-first tier (#1064)
      if (cands.length <= 3) {
        picks = cands;
        // Centrality de-noise: tier the most-substantive def PLUS any co-named
        // def of comparable centrality (a real overload/wrapper — excalidraw's
        // `mutateElement` lives in mutateElement.ts, App.tsx AND Scene.ts, all
        // within ~2x callers). EXCLUDE a vastly-less-central namesake (Go's
        // `NewClient`: real client 492 callers vs xds-pool 11, test-fake 3 →
        // ratio <0.025) so it doesn't fill the tier and crowd out the answer.
        const counts = new Map(cands.map((c) => [c.id, callerCount(c)]));
        const maxCallers = Math.max(1, ...counts.values());
        tierPicks = cands.filter((c, i) => i === 0 || (counts.get(c.id) ?? 0) >= maxCallers * 0.25);
      } else {
        const ctx = cands.filter(inNamedContext);
        picks = ctx.length > 0 ? ctx.slice(0, 4) : cands.slice(0, 1);
        tierPicks = picks; // corroborated overloads (or the single fallback) all earn it
      }
      for (const n of picks) {
        if (!subgraph.nodes.has(n.id)) subgraph.nodes.set(n.id, n);
        // Mark as a named seed EVEN IF the FTS gather already had it — being
        // "named by the agent" is independent of whether search happened to
        // surface it, and it drives the +50 score, the gate, and the
        // named-file sort below. (Previously only NEW injections were marked,
        // so a named symbol FTS already gathered never sorted to the top.)
        namedSeedIds.add(n.id);
      }
      for (const n of tierPicks) tierSeedIds.add(n.id);
    }
  }

  // Step 2: Group nodes by file, score by relevance
  const fileGroups = new Map<string, { nodes: Node[]; score: number }>();
  // Once explicit definitions resolve, loose FTS stems are not additional
  // query subjects (startPluginWorkflow must not promote unrelated start()).
  // Keep exact class/file roots too, so a named cross-file flow retains its
  // explicitly requested types and implementations.
  const entryNodeIds = new Set([
    ...(tierSeedIds.size ? exactQueryRootIds : subgraph.roots),
    ...namedSeedIds,
  ]);
  subgraph.roots = [...entryNodeIds];

  // Build a set of nodes directly connected to entry points (depth 1)
  const connectedToEntry = new Set<string>();
  for (const edge of subgraph.edges) {
    if (entryNodeIds.has(edge.source)) connectedToEntry.add(edge.target);
    if (entryNodeIds.has(edge.target)) connectedToEntry.add(edge.source);
  }

  // CHANGE SURFACE (#1064): a named method's signature types — its parameter
  // and return types — are part of what you'd edit to "add a parameter to X",
  // yet they can be lexically dissimilar to the query ("add a parameter to
  // NewClient" shares no words with `dialoptions.go`, which defines NewClient's
  // `DialOption`) and sit a hop away. COLLECT them here from each named-seed
  // callable's outgoing signature edges (full graph — the type is often not in
  // the subgraph); the decision to surface one is DEFERRED to the buried-rescue
  // pass below, which fires only when the type's file would otherwise be
  // dropped — so a well-connected type (excalidraw's element types, Alamofire's
  // `DataRequest` on a flow query) is left to rank on its own and never
  // displaces a flow-central file. Bounded: only the few named seeds, only the
  // types in their signatures.
  const CALLABLE_KINDS = new Set(['method', 'function', 'component', 'constructor']);
  const TYPE_KINDS = new Set(['class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'type_alias']);
  const SIG_EDGE = new Set(['references', 'type_of', 'returns']);
  const changeSurfaceCandidates: Node[] = [];
  const seenChangeSurface = new Set<string>();
  for (const seedId of tierSeedIds) {
    const seedNode = subgraph.nodes.get(seedId);
    if (!seedNode || !CALLABLE_KINDS.has(seedNode.kind)) continue;
    let outs: Edge[] = [];
    try { outs = cg.getOutgoingEdges(seedId); } catch { continue; }
    for (const e of outs) {
      if (!SIG_EDGE.has(e.kind)) continue;
      const tgt = cg.getNode(e.target);
      if (!tgt || !TYPE_KINDS.has(tgt.kind) || namedSeedIds.has(tgt.id)) continue;
      if (seenChangeSurface.has(tgt.id)) continue;
      seenChangeSurface.add(tgt.id);
      changeSurfaceCandidates.push(tgt);
    }
  }

  for (const node of subgraph.nodes.values()) {
    // Skip import/export nodes — they add noise without information
    if (node.kind === 'import' || node.kind === 'export') continue;
    // SECURITY (#383): never render the on-disk source of a config-leaf
    // (Spring application.{yml,properties} key) — its line is `key = <secret>`,
    // so whole-file/cluster rendering here would push secrets into context
    // unbidden. The key still appears in the flow/symbol listing above.
    if (isConfigLeafNode(node)) continue;

    const group = fileGroups.get(node.filePath) || { nodes: [], score: 0 };
    group.nodes.push(node);
    // Score: a NAMED-SEED node (a symbol the agent named that FTS missed, now
    // injected) is worth far more than a mere reference — its file is where the
    // answer lives. Without this, an incidental file that name-drops the flow
    // (Combine.swift references request/task → score 23 from connected nodes)
    // outranks the file that DEFINES a named symbol (Validation.swift's
    // `validate` → 10) and steals its render slot. Definition ≫ reference.
    if (namedSeedIds.has(node.id)) {
      group.score += 50;
    } else if (entryNodeIds.has(node.id)) {
      group.score += 10;
    } else if (connectedToEntry.has(node.id)) {
      group.score += 3;
    } else {
      group.score += 1;
    }
    fileGroups.set(node.filePath, group);
  }

  // Only include files that have entry points or nodes directly connected to entry points
  let relevantFiles = [...fileGroups.entries()].filter(([, group]) => group.score >= 3);

  // Extract query terms for relevance checking
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);

  // Test/spec/icon/i18n file detector — used both for the pre-sort hard
  // filter (tiny tier) and the comparator deprioritization (all tiers).
  const isLowValue = (p: string) => {
    const lp = p.toLowerCase();
    return (
      /\/(tests?|__tests?__|spec)\//.test(lp) ||
      /_test\.go$/.test(lp) ||
      /(?:^|\/)test_[^/]+\.py$/.test(lp) ||
      /_test\.py$/.test(lp) ||
      /_spec\.rb$/.test(lp) ||
      /_test\.rb$/.test(lp) ||
      /\.(test|spec)\.[jt]sx?$/.test(lp) ||
      /(test|spec|tests)\.(java|kt|scala)$/.test(lp) ||
      /(tests?|spec)\.cs$/.test(lp) ||
      /tests?\.swift$/.test(lp) ||
      /_test\.dart$/.test(lp) ||
      /\bicons?\b/.test(lp) ||
      /\bi18n\b/.test(lp)
    );
  };

  // Hard-exclude test/spec files (ALL tiers, not just tiny). One slipped test
  // file dominates the per-file budget on small repos (cobra's `command_test.go`
  // displaced `args.go`) AND wastes budget on large ones (Django's
  // `custom_lookups/tests.py` ate ~2.3 KB of the 28 KB cap, crowding out the
  // SQLCompiler mechanism the agent then Read). A test file almost never answers
  // an architecture question. Skip when the query itself is about tests — the
  // legitimate "explore the tests" case — and only cut if ≥2 non-test candidates
  // remain (else tests are the only signal for this area).
  {
    const queryMentionsTests = /\b(test|tests|testing|spec|verify|verifies)\b/i.test(query);
    if (!queryMentionsTests) {
      const nonLow = relevantFiles.filter(([p]) => !isLowValue(p));
      if (nonLow.length >= 2) {
        relevantFiles = nonLow;
      }
    }
  }

  // Secondary signal: how many DISTINCT query terms each file matches (path +
  // symbol names). Kept only as a tiebreak — the PRIMARY relevance is graph
  // connectivity below. (Term counting alone tied the real central file with
  // incidental same-word matches; it's a weak text signal, not the ranker.)
  const uniqueQueryTerms = [...new Set(queryTerms)].filter(t => t.length >= 3);
  const fileTermHits = new Map<string, number>();
  for (const [fp, group] of relevantFiles) {
    const hay = fp.toLowerCase() + ' ' + group.nodes.map(n => n.name.toLowerCase()).join(' ');
    let hits = 0;
    for (const t of uniqueQueryTerms) if (hay.includes(t)) hits++;
    fileTermHits.set(fp, hits);
  }

  // PRIMARY relevance: graph connectivity (Random-Walk-with-Restart from the
  // matched seeds — see computeGraphRelevance). Aggregate each file's nodes'
  // walk mass. This is the signal text search lacks: the real cluster
  // (org-user.storage.ts, call-connected to the matches) accrues mass; a lone
  // text match (LensSwitcher.swift, matched "switch" but calls nothing in the
  // flow) gets only its restart probability → ~0, and is dropped by the gate.
  const nodeRwr = this.computeGraphRelevance(
    [...subgraph.nodes.keys()], subgraph.edges, entryNodeIds,
  );
  const fileGraphScore = new Map<string, number>();
  for (const node of subgraph.nodes.values()) {
    fileGraphScore.set(
      node.filePath,
      (fileGraphScore.get(node.filePath) ?? 0) + (nodeRwr.get(node.id) ?? 0),
    );
  }
  const maxGraph = Math.max(0, ...fileGraphScore.values());

  // Central file(s): the 1-2 most graph-central files that also match the
  // query textually (so a connected hub-utility with no term match isn't
  // mistaken for the subject). The heart of the answer — they earn the larger
  // WHOLE-FILE ceiling below (a god-file central file still exceeds it and
  // falls to generous full-method sectioning — never a whole dump).
  const centralFiles = new Set(
    [...fileGraphScore.entries()]
      .filter(([fp, g]) => g > 0 && (fileTermHits.get(fp) ?? 0) >= 1)
      .sort((a, b) => b[1] - a[1] || (fileTermHits.get(b[0]) ?? 0) - (fileTermHits.get(a[0]) ?? 0))
      .slice(0, 2)
      .map(([f]) => f),
  );

  // Files that DEFINE a symbol the agent named (or a subgraph root). These are
  // the highest-relevance files there are — the agent asked for them by name —
  // so the connectivity gate below must never drop them, even when their RWR
  // mass is low (a leaf family file like codec.ts is call-connected to little
  // but is exactly what the agent queried). Without this protection the gate
  // prunes a named file and the agent Reads it back.
  const entryFiles = new Set<string>();
  for (const id of entryNodeIds) {
    const n = subgraph.nodes.get(id);
    if (n) entryFiles.add(n.filePath);
  }
  // Buried-rescue pass (#1064): surface a named method's signature type ONLY
  // when its file is genuinely buried — near-zero graph mass AND not lexically
  // matched. That is the invisible case (grpc's `DialOption` → `dialoptions.go`,
  // g≈0, 0 term hits): reachable but ranked nowhere, so the agent greps. A
  // well-connected type file (excalidraw element types, Alamofire `DataRequest`)
  // is NOT buried and is left alone — rescuing it would displace a flow-central
  // file (App.tsx, Validation.swift). Buried is judged on the PRE-rescue graph,
  // so injecting the type below can't make it look connected. A rescued file is
  // injected (so it renders), force-kept (gate + relevantFiles), and tiered.
  const changeSurfaceFiles = new Set<string>();
  for (const t of changeSurfaceCandidates) {
    const fp = t.filePath;
    const buried = (fileGraphScore.get(fp) ?? 0) < maxGraph * 0.06
      && (fileTermHits.get(fp) ?? 0) < 2;
    if (!buried) continue;
    changeSurfaceFiles.add(fp);
    if (!subgraph.nodes.has(t.id)) subgraph.nodes.set(t.id, t);
    let group = fileGroups.get(fp);
    if (!group) { group = { nodes: [], score: 0 }; fileGroups.set(fp, group); }
    if (!group.nodes.some((n) => n.id === t.id)) group.nodes.push(t);
    group.score = Math.max(group.score, 45);
    if (!relevantFiles.some(([f]) => f === fp)) relevantFiles.push([fp, group]);
  }

  // Relevance gate (so the generous budget is a CEILING, not a target): keep a
  // file only if it is STRUCTURALLY relevant by ANY of:
  //   - graph score within a fraction of the top (it's on/near the flow), OR
  //   - central (a query entry-point lives here), OR
  //   - it DEFINES a symbol the agent named (entryFiles), OR
  //   - it matches >= 2 DISTINCT named query terms — a strong text signal that
  //     the agent is asking about this file even when nothing calls it (codec.ts:
  //     the agent named `encode`/`Codec`/`JsonCodec`, all leaf classes with zero
  //     RWR mass — graph alone wrongly drops it).
  // A lone text match on one shared word (LensSwitcher: term=1, g~0) is still
  // dropped, so the budget never fills with incidental files. Guarded so it
  // never prunes below 2.
  if (maxGraph > 0) {
    const gated = relevantFiles.filter(([fp]) =>
      (fileGraphScore.get(fp) ?? 0) >= maxGraph * 0.06
      || centralFiles.has(fp)
      || entryFiles.has(fp)
      || changeSurfaceFiles.has(fp)
      || (fileTermHits.get(fp) ?? 0) >= 2,
    );
    if (gated.length >= (tierSeedIds.size ? 1 : 2)) relevantFiles = gated;
  }

  // Sort files: graph-central first, then distinct-term match, then the
  // existing low-value/generated/score tiebreaks.
  // Files that DEFINE a symbol the agent NAMED. These sort first — ahead of
  // graph connectivity — because the agent asked for them by name. Without
  // this, a named leaf override reached only by dynamic dispatch (Alamofire's
  // `DataRequest.task`/`validate`, low RWR mass) sorts below the high-
  // connectivity abstract base (`Request.swift`) and the same-named overloads
  // in other files (`Validation.swift`), falls outside the budget, and the
  // agent Reads it. The named file is the answer — rank it at the top.
  const namedSeedFiles = new Set<string>();
  for (const id of tierSeedIds) {
    const n = subgraph.nodes.get(id);
    if (n) namedSeedFiles.add(n.filePath);
  }
  // A rescued change-surface file (only the genuinely-buried ones — see the
  // buried-rescue pass) is the lexically-dissimilar answer; give it the named
  // tier so it isn't buried under files that merely share surface words (#1064).
  for (const fp of changeSurfaceFiles) namedSeedFiles.add(fp);

  // Multi-term corroboration tier: a file that is BOTH (a) an entry/central file
  // (a search root, named seed, or graph-central hub — i.e. structurally part of
  // the answer) AND (b) matched by ≥2 DISTINCT query terms must not be buried by
  // graph-centrality mass that accrued to a denser-but-off-topic cluster. In a
  // cross-layer monorepo (an API server alongside a much larger, internally dense
  // frontend that mirrors the same domain words) the Random-Walk-with-Restart mass
  // — seeded from text matches that skew to the bigger layer — floats hits=0
  // frontend files above the hits=2/3 backend service that IS the answer (its many
  // callers don't help: it's call-isolated from the frontend seed cluster). The
  // entry/central GUARD keeps this safe: an INCIDENTAL multi-term file that is
  // neither entry nor central (a type/util file that matches "element"+x but isn't
  // the flow) is NOT promoted, so it can't displace the graph-central answer file
  // (hits=1) the way a blunt hits-only tier would. Single-layer repos with one
  // cluster are unaffected (no competing mass). Set CODEGRAPH_RANK_NO_MULTITERM=1
  // to disable.
  const MULTITERM_OFF = process.env.CODEGRAPH_RANK_NO_MULTITERM === '1';
  const isCorroborated = (fp: string) =>
    !MULTITERM_OFF &&
    (fileTermHits.get(fp) ?? 0) >= 2 &&
    (entryFiles.has(fp) || centralFiles.has(fp));
  const sortedFiles = relevantFiles.sort((a, b) => {
    const aPath = a[0].toLowerCase();
    const bPath = b[0].toLowerCase();

    // Agent-named files first (it asked for a symbol defined here by name).
    const aNamed = namedSeedFiles.has(a[0]) ? 1 : 0;
    const bNamed = namedSeedFiles.has(b[0]) ? 1 : 0;
    if (aNamed !== bNamed) return bNamed - aNamed;

    // Corroborated (entry/central + ≥2 terms) tier, above the graph signal.
    const aCorr = isCorroborated(a[0]) ? 1 : 0;
    const bCorr = isCorroborated(b[0]) ? 1 : 0;
    if (aCorr !== bCorr) return bCorr - aCorr;

    // Graph connectivity is the next key (small epsilon so near-ties fall
    // through to the text signal rather than coin-flipping on float noise).
    const aG = fileGraphScore.get(a[0]) ?? 0;
    const bG = fileGraphScore.get(b[0]) ?? 0;
    if (Math.abs(aG - bG) > maxGraph * 0.01) return bG - aG;

    const aHits = fileTermHits.get(a[0]) ?? 0;
    const bHits = fileTermHits.get(b[0]) ?? 0;
    if (aHits !== bHits) return bHits - aHits;

    const aLow = isLowValue(aPath);
    const bLow = isLowValue(bPath);
    if (aLow !== bLow) return aLow ? 1 : -1;

    // Deprioritize generated source (.pb.go / .pulsar.go / _mocks.go / …) —
    // the agent rarely needs to see the protobuf scaffold or gomock output
    // when asking about the actual flow, and dumping their bodies inflates
    // the response (the cosmos Q3 explore otherwise leads with
    // `expected_keepers_mocks.go`, displacing the real `tally.go` content
    // and forcing the agent to Read tally.go anyway).
    const aGen = isGeneratedFile(a[0]);
    const bGen = isGeneratedFile(b[0]);
    if (aGen !== bGen) return aGen ? 1 : -1;

    if (a[1].score !== b[1].score) return b[1].score - a[1].score;
    return b[1].nodes.length - a[1].nodes.length;
  });
  return { tierSeedIds, CALLABLE_KINDS, sortedFiles, entryNodeIds, centralFiles, glueNodeIds, connectedToEntry, fileGroups };
}
