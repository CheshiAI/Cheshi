import { readFileSync } from 'fs';
import type { Node } from '../types';
import {
  clamp,
  validatePathWithinRoot
} from '../utils';
import { rankExploreFiles } from './explore-file-ranking';
import { renderRequestedSource, requestedSourceSize } from './explore-source';
import {
  type ReadToolResult
} from './tool-definitions';
import type { ToolHandlerState } from './tool-handler-state';
import {
  fileSectionHeader,
  numberSourceLines,
  SUMMARY_SENTINEL
} from './tool-messages';
import {
  adaptiveExploreEnabled,
  exploreLineNumbersEnabled,
  type ExploreOutputBudget,
  getExploreBudget,
  getExploreOutputBudget
} from './tool-options';
import {
  normalizeQuerySpelling
} from './tool-symbol-utils';

/**
   * Handle codegraph_explore — deep exploration in a single call
   *
   * Strategy: find relevant symbols via graph traversal, group by file,
   * then prioritize requested definitions before adding surrounding context.
   * This replaces multiple codegraph_node + Read calls.
   *
   * Output size is adaptive to project file count via
   * `getExploreOutputBudget` — see #185 for why a fixed 35k cap was a
   * tax on small projects while earning its keep on large ones.
   */
export async function handleExplore(this: ToolHandlerState, args: Record<string, unknown>): Promise<ReadToolResult> {
  const rawQuery = this.validateString(args.query, 'query');
  if (typeof rawQuery !== 'string') return rawQuery;
  // One normalization point so the flow-builder, relevance search, and
  // ranking all see the same canonical spelling (Erlang `mod:fn/arity`).
  const query = normalizeQuerySpelling(rawQuery);

  const cg = this.getCodeGraph(args.projectPath as string | undefined);
  const projectRoot = cg.getProjectRoot();

  // Resolve adaptive output budget from project size. Falls back to the
  // largest-tier defaults if stats aren't available, which preserves
  // pre-#185 behavior for callers that hit the rare stats failure.
  let budget: ExploreOutputBudget;
  try {
    budget = getExploreOutputBudget(cg.getStats().fileCount);
  } catch {
    budget = getExploreOutputBudget(Infinity);
  }
  const maxFiles = clamp((args.maxFiles as number) || budget.defaultMaxFiles, 1, 20);

  // Step 1: Find relevant context with generous parameters.
  // Use a large maxNodes budget — explore has its own bounded output budget
  // that prevents context bloat, so more nodes just means better coverage
  // across entry points (especially for large files like Svelte components).
  const subgraph = await cg.findRelevantContext(query, {
    searchLimit: 8,
    traversalDepth: 3,
    maxNodes: 200,
    minScore: 0.2,
  });

  if (subgraph.nodes.size === 0) {
    return this.textResult(`No relevant code found for "${query}"`);
  }

  const { tierSeedIds, CALLABLE_KINDS, sortedFiles, entryNodeIds, centralFiles, glueNodeIds, connectedToEntry, fileGroups } = rankExploreFiles.call(this, cg, query, subgraph);

  // Step 3: Build relationship map
  const lines: string[] = [
    `**Exploration: ${query}**`,
    '',
    // Curated summary — filled in after the source loop (see below). We do NOT
    // report `subgraph.nodes.size` / `fileGroups.size` here: that's the raw
    // candidate gather, which a broad natural-language query inflates wildly
    // (260 symbols / 124 files on a 636-file repo) even though only a handful
    // render. Reporting the pool read as "260 results to wade through" when the
    // real, correctly-ranked answer is the few files below (#1046).
    '',
    '',
  ];
  const summaryLineIdx = 2;

  // Blast radius (always-on, compact): for the entry symbols, who depends on
  // them + which tests cover them — locations only, no source — so the agent
  // knows what to update/verify before editing without a separate call.
  const blastRadius = this.buildBlastRadiusSection(cg, subgraph);
  if (blastRadius) lines.push(blastRadius);

  // Relationship map — show how symbols connect
  const significantEdges = subgraph.edges.filter(e =>
    e.kind !== 'contains' // skip contains — it's implied by file grouping
  );

  if (budget.includeRelationships && significantEdges.length > 0) {
    lines.push('**Relationships**');
    lines.push('');

    // Group edges by kind for readability
    const byKind = new Map<string, Array<{ source: string; target: string }>>();
    for (const edge of significantEdges) {
      const sourceNode = subgraph.nodes.get(edge.source);
      const targetNode = subgraph.nodes.get(edge.target);
      if (!sourceNode || !targetNode) continue;

      const group = byKind.get(edge.kind) || [];
      group.push({ source: sourceNode.name, target: targetNode.name });
      byKind.set(edge.kind, group);
    }

    for (const [kind, edges] of byKind) {
      const cap = budget.maxEdgesPerRelationshipKind;
      const shown = edges.slice(0, cap);
      lines.push(`**${kind}:**`);
      for (const e of shown) {
        lines.push(`- ${e.source} → ${e.target}`);
      }
      if (edges.length > cap) {
        lines.push(`- ... and ${edges.length - cap} more`);
      }
      lines.push('');
    }
  }

  // Step 4: Read contiguous file sections
  // Compute the flow spine once — used both to prepend the Flow section (below)
  // and to gate adaptive source sizing: files on the spine get full source,
  // off-spine peers skeletonize.
  const flow = this.buildFlowFromNamedSymbols(cg, query);

  // The same explicit definitions that rank files must also select their bodies.
  // Flow discovery can be empty for a single qualified symbol; it is not a
  // substitute for the named seeds resolved above.
  const requestedNodes = [...tierSeedIds]
    .map((id) => subgraph.nodes.get(id))
    .filter((node): node is Node => node !== undefined && CALLABLE_KINDS.has(node.kind));
  const requestedByFile = new Map<string, Node[]>();
  for (const node of requestedNodes) {
    const nodes = requestedByFile.get(node.filePath) ?? [];
    nodes.push(node);
    requestedByFile.set(node.filePath, nodes);
  }
  const sourceCache = new Map<string, { content: string; lines: string[]; stale: boolean } | null>();
  const readSource = (filePath: string) => {
    if (sourceCache.has(filePath)) return sourceCache.get(filePath) ?? null;
    const absolutePath = validatePathWithinRoot(projectRoot, filePath);
    let source = null;
    if (absolutePath) {
      try {
        const content = readFileSync(absolutePath, 'utf8');
        source = { content, lines: content.split('\n'), stale: this.isFileStaleOnDisk(cg, filePath, content) };
      } catch { /* unavailable source is omitted, with continuation for a named definition */ }
    }
    sourceCache.set(filePath, source);
    return source;
  };
  // Reserve room for later named files before adding optional context to an
  // earlier one. One large definition must not consume every requested file's
  // allocation. maxFiles remains the caller's explicit breadth limit.
  const requestedReservations = new Map<string, number>();
  for (const [filePath] of sortedFiles.slice(0, maxFiles)) {
    const nodes = requestedByFile.get(filePath);
    if (!nodes) continue;
    const source = readSource(filePath);
    if (!source || source.stale) continue;
    requestedReservations.set(filePath, Math.min(budget.maxCharsPerFile, requestedSourceSize(source.lines, nodes)) + 200);
  }

  // Polymorphic-sibling detector for adaptive sizing. A class that implements/
  // extends a supertype shared by >= MIN_SIBLINGS classes is one of many
  // INTERCHANGEABLE implementations (OkHttp's 14 `: Interceptor` classes —
  // showing one + the rest as signatures is enough), as opposed to a DISTINCT
  // pipeline step (Excalidraw's `renderStaticScene`, which shares no supertype and
  // must stay full or the agent loses real content). Only off-spine sibling files
  // skeletonize; distinct steps and on-spine files keep full source. Cache
  // supertype→(has ≥N implementers) so this stays a handful of edge queries.
  const MIN_SIBLINGS = 3;
  const siblingSuper = new Map<string, boolean>();
  const isPolymorphicSibling = (nodes: Node[]): boolean => {
    for (const n of nodes) {
      for (const e of cg.getOutgoingEdges(n.id)) {
        if (e.kind !== 'implements' && e.kind !== 'extends') continue;
        let many = siblingSuper.get(e.target);
        if (many === undefined) {
          many = cg.getIncomingEdges(e.target)
            .filter((x) => x.kind === 'implements' || x.kind === 'extends').length >= MIN_SIBLINGS;
          siblingSuper.set(e.target, many);
        }
        if (many) return true;
      }
    }
    return false;
  };

  // A file that DEFINES a polymorphic supertype (a class/interface with ≥
  // MIN_SIBLINGS implementers) AND co-locates its subclasses is a redundant
  // "family" file — Django's compiler.py holds `SQLCompiler` + its 4 subclasses
  // (SQLInsert/Update/Delete/AggregateCompiler) in 2,266 lines. Such files are
  // huge and read-anyway, so they should STILL skeletonize even when the agent
  // named a method in them: a full one eats ~6.5K of the explore budget (Django
  // is pinned at the 28K cap, truncating), starving the sibling files the agent
  // then Reads. This flag OVERRIDES the named-callable spare below — it does NOT
  // by itself spare a file. (OkHttp's RealCall implements the `Lockable` mixin
  // but defines no ≥3-impl supertype, so the named spare keeps it full.)
  const superMany = new Map<string, boolean>();
  const definesPolymorphicSupertype = (nodes: Node[]): boolean => {
    for (const n of nodes) {
      if (n.kind !== 'class' && n.kind !== 'interface' && n.kind !== 'struct'
        && n.kind !== 'trait' && n.kind !== 'protocol' && n.kind !== 'type_alias') continue;
      let many = superMany.get(n.id);
      if (many === undefined) {
        many = cg.getIncomingEdges(n.id)
          .filter((x) => x.kind === 'implements' || x.kind === 'extends').length >= MIN_SIBLINGS;
        superMany.set(n.id, many);
      }
      if (many) return true;
    }
    return false;
  };

  lines.push('**Source Code**');
  lines.push('');
  // Recorded so the drift pass below (#1474) can append a per-file exception
  // to this guarantee after the render loop knows which files drifted.
  const verbatimHeaderIdx = lines.length;
  lines.push('> The blocks below contain current on-disk source ranges. They may cover only part of a file. Follow any source-incomplete notice to retrieve a missing range.');
  lines.push('');

  let totalChars = flow.text.length + lines.join('\n').length;
  const fairReservation = Math.max(0, Math.floor(
    (budget.maxOutputChars - totalChars - 1500) / Math.max(1, requestedReservations.size),
  ));
  for (const [filePath, size] of requestedReservations) {
    requestedReservations.set(filePath, Math.min(size, fairReservation));
  }
  let filesIncluded = 0;
  // Paths we actually render source for below. Drives the curated header count
  // (#1046) — it must reflect what we show, not the raw candidate gather.
  const renderedFilePaths: string[] = [];
  let anyFileTrimmed = false;
  // Files that changed on disk after their last index sync (#1474). Their
  // indexed line ranges are untrustworthy, so sliced renders (adaptive /
  // skeleton / clusters) are OFF for them: a small drifted file still ships
  // whole (current bytes, correct by construction → staleRendered), a big one
  // is omitted with an explicit notice (→ staleOmitted) — honest absence
  // instead of a different symbol's code under the requested name.
  const staleRendered: string[] = [];
  const staleOmitted: string[] = [];

  for (const [filePath, group] of sortedFiles) {
    if (filesIncluded >= maxFiles) break;
    requestedReservations.delete(filePath);
    const reservedChars = [...requestedReservations.values()].reduce((sum, size) => sum + size, 0);
    // A file DEFINES a named/spine symbol (the answer) vs merely references the
    // flow. Past 90% budget, stop pulling INCIDENTAL files — but keep scanning
    // for necessary ones, which render even past the cap (bounded by maxFiles).
    // Without this `continue` (was an unconditional `break`), the loop stopped
    // after the build + validators-exec files and never reached the ranked-in
    // validate-logic file (Alamofire's Validation.swift).
    const fileNecessary = group.nodes.some(n =>
      entryNodeIds.has(n.id) || flow.pathNodeIds.has(n.id) || flow.uniqueNamedNodeIds.has(n.id));
    if (!fileNecessary && totalChars + reservedChars > budget.maxOutputChars * 0.9) continue;

    const source = readSource(filePath);
    if (!source) continue;
    const fileContent = source.content;
    const fileLines = source.lines;
    const lang = group.nodes[0]?.language || '';

    // Disk-drift gate (#1474): every render branch below except whole-file
    // slices fileContent (CURRENT bytes) at INDEXED line ranges. Content is
    // already in hand, so the check costs one stat (hash only on mismatch).
    const fileStale = source.stale;

    const isCentralFile = centralFiles.has(filePath);
    const wholeLineLimit = isCentralFile ? 280 : 220;
    const wholeCharLimit = budget.maxCharsPerFile * (isCentralFile ? 1.5 : 3);
    const wholeSection = fileLines.length <= wholeLineLimit && fileContent.length <= wholeCharLimit
      ? numberSourceLines(fileContent.replace(/\n+$/, ''), 1) : '';
    const canRenderWhole = wholeSection.length > 0
      && totalChars + reservedChars + wholeSection.length + 200 <= budget.maxOutputChars;

    const requested = requestedByFile.get(filePath);
    if (!fileStale && requested?.length && !canRenderWhole) {
      const sourceBudget = Math.max(0, budget.maxOutputChars - totalChars - reservedChars - 1500);
      const pathNodes = [...flow.pathNodeIds]
        .map((id) => cg.getNode(id))
        .filter((node): node is Node => node !== null && node !== undefined
          && node.filePath === filePath && CALLABLE_KINDS.has(node.kind));
      const body = renderRequestedSource(fileLines, requested, sourceBudget, pathNodes);
      if (body) {
        const names = requested.map((node) => `${node.name}(${node.kind})`).join(', ');
        const section = [fileSectionHeader(filePath, `${names} · requested definitions`), '', '```' + lang, body, '```', ''].join('\n');
        lines.push(section);
        totalChars += section.length;
        renderedFilePaths.push(filePath);
        filesIncluded++;
      }
      anyFileTrimmed = true;
      continue;
    }

    // Adaptive sizing (CODEGRAPH_ADAPTIVE_EXPLORE, default on): collapse a file
    // to a per-symbol view when it's a redundant member of a polymorphic family.
    // Engages iff ALL hold:
    //   1. a flow spine exists,
    //   2. no symbol in the file is on that spine (it's not the mechanism path),
    //   3. it IS a polymorphic sibling (≥ MIN_SIBLINGS impls of a shared supertype),
    //   4. it is NOT SPARED, where a file is spared iff the agent named a
    //      (near-)UNIQUE callable in it (`getResponseWithInterceptorChain`, 1 def →
    //      keep RealCall.kt full) UNLESS the file DEFINES the family supertype (a
    //      base+subclasses "family" file like Django's compiler.py — collapse it).
    //      Uniqueness matters: `as_sql` has 110 defs across every Compiler/Expression
    //      subclass; naming it must NOT keep every backend variant + test file full
    //      and flood the budget. That's why the spare reads uniqueNamedNodeIds.
    // Within a collapsed file the render is PER-SYMBOL (condition B): a method the
    // agent NAMED or that's on the spine is shown with its FULL body (so the agent
    // doesn't Read the file back for it — Django's SQLCompiler.execute_sql/as_sql);
    // every other symbol is just its signature. So the base mechanism survives while
    // the file's other ~80 symbols + the redundant subclasses collapse to one line each.
    const spareNamed = group.nodes.some(n => flow.uniqueNamedNodeIds.has(n.id));
    const fileDefinesSuper = definesPolymorphicSupertype(group.nodes);
    const spared = spareNamed && !fileDefinesSuper;
    const CALLABLE_BODY = new Set(['method', 'function', 'constructor', 'component']);
    const hasSpineNode = group.nodes.some(n => flow.pathNodeIds.has(n.id));
    // On-spine god-file: the flow path runs THROUGH this file, but it also holds
    // many OTHER named methods, and rendering all of them in full blows the
    // per-file budget and starves the other flow files (Alamofire: the agent
    // names ~7 Session.swift methods — the build spine PLUS off-path
    // task/didCompleteTask — far past the whole response budget). Engage the
    // per-symbol view to keep the SPINE full and collapse the off-path named
    // methods to signatures. Only when there IS off-path content to shed —
    // otherwise the spine is irreducible (a sequential flow has no redundancy),
    // so leave it to the normal full render.
    const namedBodyChars = group.nodes
      .filter(n => CALLABLE_BODY.has(n.kind) && (flow.pathNodeIds.has(n.id) || flow.uniqueNamedNodeIds.has(n.id)))
      .reduce((s, n) => s + fileLines.slice(n.startLine - 1, n.endLine).join('\n').length, 0);
    const onSpineGodFile = hasSpineNode
      && namedBodyChars > budget.maxCharsPerFile
      && group.nodes.some(n => CALLABLE_BODY.has(n.kind) && flow.uniqueNamedNodeIds.has(n.id) && !flow.pathNodeIds.has(n.id));
    if (!fileStale && adaptiveExploreEnabled() && flow.pathNodeIds.size > 0
      && (onSpineGodFile || (!hasSpineNode && isPolymorphicSibling(group.nodes) && !spared))) {
      const syms = group.nodes
        .filter(n => n.kind !== 'import' && n.kind !== 'export' && n.startLine > 0)
        .sort((a, b) => a.startLine - b.startLine);
      // Pass 1: choose which symbols get a FULL body, by priority, greedily within
      // a per-file body cap — so one huge family file can't body every named method
      // and crowd out the other flow files (Django's query.py). A symbol earns a
      // body if it's on-spine, or UNIQUELY named (`SQLCompiler.execute_sql`), or a
      // co-named method WHEN this file DEFINES the family supertype (so the base
      // `SQLCompiler.as_sql` body shows, but the 110 leaf `as_sql` overrides — and
      // OkHttp's 5 `intercept`s if the agent names `intercept` — stay signatures).
      const prio = (n: Node) => !CALLABLE_BODY.has(n.kind) ? 99
        : flow.pathNodeIds.has(n.id) ? 0
          : flow.uniqueNamedNodeIds.has(n.id) ? 1
            : (fileDefinesSuper && flow.namedNodeIds.has(n.id)) ? 2 : 99;
      // One ~250-line WINDOW per file. syms are taken by priority (spine first,
      // then uniquely-named, then family-base), and the cap applies to ALL of
      // them — including the spine — so a big-spine god-file (tokio's worker.rs:
      // run→run_task→next_task→steal_work) can't eat the whole response and
      // starve the co-flow file (harness.rs's poll). The native agent windows
      // such a file too (~190 lines at a time), so this mimics, not truncates.
      // Always emit ≥1 (never an empty section).
      const bodyCap = budget.maxCharsPerFile * 1.5;
      const bodyIds = new Set<string>();
      let bodyChars = 0;
      for (const n of syms.filter(n => prio(n) < 99 && n.endLine >= n.startLine).sort((a, b) => prio(a) - prio(b))) {
        const sz = fileLines.slice(n.startLine - 1, n.endLine).join('\n').length;
        if (bodyChars + sz > bodyCap && bodyIds.size > 0) continue;
        bodyIds.add(n.id);
        bodyChars += sz;
      }
      // Pass 2: render in line order — full body for chosen symbols, else the
      // signature line (capped, with a "+N more" tail so the structure map of a
      // god-file doesn't itself bloat the budget).
      const skel: string[] = [];
      let coveredUntil = 0; // skip symbols already inside an emitted body
      let sigCount = 0, sigDropped = 0;
      const SIG_MAX = Math.max(12, budget.maxSymbolsInFileHeader * 2);
      for (const n of syms) {
        if (n.startLine <= coveredUntil) continue;
        if (bodyIds.has(n.id)) {
          const end = n.endLine;
          const body = fileLines.slice(n.startLine - 1, end).join('\n');
          skel.push(numberSourceLines(body, n.startLine));
          coveredUntil = end;
        } else {
          // Elide the body, emit the signature. node.startLine can point at a
          // decorator/annotation, so scan forward for the line that names the symbol.
          let lineNo = n.startLine;
          for (let k = 0; k < 4; k++) {
            if ((fileLines[n.startLine - 1 + k] || '').includes(n.name)) { lineNo = n.startLine + k; break; }
          }
          if (lineNo <= coveredUntil) continue;
          if (sigCount >= SIG_MAX) { sigDropped++; continue; }
          const sig = (fileLines[lineNo - 1] || '').trim();
          if (sig) { skel.push(`${lineNo}\t${sig}`); sigCount++; }
        }
      }
      if (sigDropped > 0) skel.push(`… +${sigDropped} more (signatures elided)`);
      if (skel.length > 0) {
        const names = [...new Set(group.nodes.filter(n => n.kind !== 'import' && n.kind !== 'export').map(n => n.name))]
          .slice(0, budget.maxSymbolsInFileHeader).join(', ');
        // Steer the agent to codegraph_explore for an elided body — NEVER to
        // Read. The old "Read for more" / "Read for a full body" tags invited
        // a Read of the very file just skeletonized; on a central, wanted file
        // (Session.swift, DataRequest.swift) that fired an over-investigation
        // spiral (the agent Read the skeletonized file, then kept digging).
        // CLAUDE.md: explore output must never tell the agent to Read.
        const tag = bodyIds.size > 0
          ? 'focused (selected method bodies and signatures; use codegraph_node with includeCode=true for other bodies)'
          : 'skeleton (signatures only — codegraph_explore a name for its full body; do NOT Read)';
        lines.push(fileSectionHeader(filePath, `${names} · ${tag}`), '', '```' + lang, skel.join('\n'), '```', '');
        totalChars += skel.join('\n').length + 120;
        renderedFilePaths.push(filePath);
        filesIncluded++;
        continue;
      }
    }

    // Whole-file rule: if a relevant file is small enough to afford, return it
    // ENTIRELY instead of clustering. Clustering exists to tame god-files
    // (App.tsx ~13k lines); on a ~134-line component a cluster is a lossy
    // subset of a file the agent will just Read in full anyway — costing a
    // round-trip and a re-read every later turn. Reserve clustering for files
    // too big to ship whole. Still bounded by the total maxOutputChars check.
    //
    // CENTRAL files (where the query's entry points live) get a larger — but
    // bounded — ceiling: they're the heart of the answer, the file(s) the agent
    // would Read whole, so a genuinely small one comes back whole rather than as
    // thin clusters. A LARGE central file (the 791-line org-user store) exceeds
    // the ceiling and falls through to sectioning/clustering below — full method
    // bodies + signatures — so we never dump (or overflow on) a whole god-file.
    if (canRenderWhole) {
      const uniqSymbols = [...new Set(
        group.nodes
          .filter(n => n.kind !== 'import' && n.kind !== 'export')
          .map(n => `${n.name}(${n.kind})`)
      )];
      const headerNames = uniqSymbols.slice(0, budget.maxSymbolsInFileHeader);
      const omitted = uniqSymbols.length - headerNames.length;
      // A drifted file rendered WHOLE is still correct (current bytes,
      // numbered from 1) — only the index-derived symbol list / line refs to
      // it elsewhere in this response may be shifted (#1474). Flag that.
      const staleSuffix = fileStale ? ' · ⚠ changed since last index sync — source below is current; the symbol list may be outdated' : '';
      const wholeHeader = fileSectionHeader(filePath, (omitted > 0 ? `${headerNames.join(', ')}, +${omitted} more` : headerNames.join(', ')) + staleSuffix);

      lines.push(wholeHeader, '', '```' + lang, wholeSection, '```', '');
      totalChars += wholeSection.length + 200;
      renderedFilePaths.push(filePath);
      filesIncluded++;
      if (fileStale) staleRendered.push(filePath);
      continue;
    }

    // Drifted file too big for the whole-file window (#1474): the cluster /
    // skeleton renders below would slice current bytes at indexed ranges —
    // on a shifted file that serves a DIFFERENT symbol's code under the
    // requested name. Omit the source with an explicit notice instead;
    // never render a possibly-wrong slice.
    if (fileStale) {
      staleOmitted.push(filePath);
      lines.push(
        fileSectionHeader(filePath, '⚠ changed on disk after the last index sync — source omitted (indexed line ranges no longer match, so a slice could show the wrong code). Read this file directly for current content; the change is picked up on that project\'s next index sync.'),
        '',
      );
      totalChars += 260;
      continue;
    }

    // Cluster nearby symbols to avoid reading huge gaps between distant symbols.
    // Sort by start line, then merge overlapping/adjacent ranges (within the
    // adaptive gap threshold). Include both node ranges AND edge source
    // locations so template sections with component usages/calls are
    // covered (not just script block symbols).
    //
    // Each range carries an `importance` score so we can rank clusters
    // when the per-file budget forces us to drop some: entry-point nodes
    // are worth 10, directly-connected nodes 3, peripheral nodes 1, and
    // bare edge-source lines 2 (less than a connected node but more than
    // a peripheral one — they hint at a reference but aren't a definition).
    // Container kinds whose body can span most/all of a file. When such a
    // node covers most of the file we drop it from the ranges: keeping it
    // would merge every method inside it into one giant cluster spanning
    // the whole file, which then tail-trims down to just the container's
    // opening lines (its header/declarations) and buries the methods the
    // query actually asked about (#185 follow-up — Session.swift in
    // Alamofire is the canonical case: the `Session` class spans ~1,400
    // lines). We want the granular symbols inside, not the envelope.
    const ENVELOPE_KINDS = new Set(['file', 'module', 'class', 'struct', 'interface', 'enum', 'namespace', 'protocol', 'trait', 'component']);
    // Cluster from this file's gathered nodes PLUS any callable the agent NAMED that
    // lives here. Explore's relevance gather can miss a named method def in a huge
    // non-sibling file — Django's query.py is 3,040 lines and `_fetch_all` (L2237)
    // was gathered only as call-reference edges, never as a def, so it formed no
    // cluster and the agent Read it back. Inject named defs directly and rank them
    // ABOVE connected/glue nodes (importance 9) so their cluster wins the per-file
    // budget — the agent explicitly asked for these symbols.
    const rangeNodes = new Map<string, Node>();
    for (const n of group.nodes) if (n.startLine > 0 && n.endLine > 0) rangeNodes.set(n.id, n);
    for (const id of flow.namedNodeIds) {
      if (rangeNodes.has(id)) continue;
      const n = cg.getNode(id);
      if (n && n.filePath === filePath && n.startLine > 0 && n.endLine > 0) rangeNodes.set(id, n);
    }
    const ranges: Array<{ start: number; end: number; name: string; kind: string; importance: number; spine: boolean; spineCallLine?: number }> = [...rangeNodes.values()]
      // Drop whole-file envelope nodes (containers covering >50% of the file).
      .filter(n => !(ENVELOPE_KINDS.has(n.kind) && (n.endLine - n.startLine + 1) > fileLines.length * 0.5))
      .map(n => {
        let importance = 1;
        if (entryNodeIds.has(n.id)) importance = 10;
        else if (flow.namedNodeIds.has(n.id)) importance = 9; // agent named it → keep its cluster
        else if (glueNodeIds.has(n.id)) importance = 6; // bridging caller/callee of an entry
        else if (connectedToEntry.has(n.id)) importance = 3;
        // On the rendered call-path spine? That IS the flow answer — its cluster
        // must never be dropped by the per-file budget (n8n's huge workflow-execute.ts:
        // processRunExecutionData, the named flow ENTRY at L1562, is a large
        // low-density method that lost the budget to denser blocks and got cut, so
        // the agent Read it back — the very thing explore exists to prevent).
        return { start: n.startLine, end: n.endLine, name: n.name, kind: n.kind, importance, spine: flow.pathNodeIds.has(n.id), spineCallLine: flow.spineCallSites.get(n.id) };
      });

    // Add edge source locations in this file — captures template references
    // (component usages, event handlers) that aren't nodes themselves.
    // Query edges directly from the DB (not just the subgraph) because BFS
    // traversal may have pruned template reference targets due to node budget.
    const edgeLines = new Set<string>(); // dedup by "line:name"
    for (const node of group.nodes) {
      const outgoing = cg.getOutgoingEdges(node.id);
      for (const edge of outgoing) {
        if (!edge.line || edge.line <= 0 || edge.kind === 'contains') continue;
        const key = `${edge.line}:${edge.target}`;
        if (edgeLines.has(key)) continue;
        edgeLines.add(key);
        // Look up target name from subgraph first, fall back to edge kind
        const targetNode = subgraph.nodes.get(edge.target);
        const targetName = targetNode?.name ?? edge.kind;
        ranges.push({ start: edge.line, end: edge.line, name: targetName, kind: edge.kind, importance: 2, spine: false });
      }
    }

    ranges.sort((a, b) => a.start - b.start);

    if (ranges.length === 0) continue;

    const gapThreshold = budget.gapThreshold;
    const clusters: Array<{ start: number; end: number; symbols: string[]; score: number; maxImportance: number; hasSpine: boolean; spineCallLine?: number }> = [];
    let current = {
      start: ranges[0]!.start,
      end: ranges[0]!.end,
      symbols: [`${ranges[0]!.name}(${ranges[0]!.kind})`],
      score: ranges[0]!.importance,
      maxImportance: ranges[0]!.importance,
      hasSpine: ranges[0]!.spine,
      spineCallLine: ranges[0]!.spineCallLine,
    };

    for (let i = 1; i < ranges.length; i++) {
      const r = ranges[i]!;
      if (r.start <= current.end + gapThreshold) {
        current.end = Math.max(current.end, r.end);
        current.symbols.push(`${r.name}(${r.kind})`);
        current.score += r.importance;
        current.maxImportance = Math.max(current.maxImportance, r.importance);
        current.hasSpine = current.hasSpine || r.spine;
        current.spineCallLine = current.spineCallLine ?? r.spineCallLine;
      } else {
        clusters.push(current);
        current = {
          start: r.start,
          end: r.end,
          symbols: [`${r.name}(${r.kind})`],
          score: r.importance,
          maxImportance: r.importance,
          hasSpine: r.spine,
          spineCallLine: r.spineCallLine,
        };
      }
    }
    clusters.push(current);

    // Build file section output from clusters, capped by per-file budget.
    // The pathological case (#185): a file like Session.swift where every
    // method is adjacent collapses into one cluster spanning the whole
    // file, and dumping that into the agent's context is most of the
    // token cost on small projects. We pick clusters in priority order
    // until the per-file char cap is hit. Truly enormous single clusters
    // get tail-trimmed with a marker.
    const contextPadding = 3;
    // Language-neutral separator (no `//` — not a comment in Python, Ruby,
    // etc.). With line numbers on, the line-number jump also signals the gap.
    const GAP_MARKER = '\n\n... (gap) ...\n\n';
    // An oversize spine method (the call path runs THROUGH a god-method — n8n's
    // processRunExecutionData is 962 lines) is windowed to its next-hop CALL site
    // plus the signature head, NOT dumped whole. Without this the cluster is too big
    // for any per-file cap and gets dropped, so the agent Reads the method back —
    // the exact gap this closes. Bounded, so a god-method can't blow the budget yet
    // the spine's call still appears in context.
    const OVERSIZE_SPINE_LINES = 200;
    const SPINE_WINDOW = 28; // lines each side of the next-hop call site
    const buildSection = (c: { start: number; end: number; hasSpine?: boolean; spineCallLine?: number }): string => {
      if (c.hasSpine && c.spineCallLine && (c.end - c.start + 1) > OVERSIZE_SPINE_LINES) {
        const call = c.spineCallLine;
        const winStart = Math.max(c.start, call - SPINE_WINDOW);
        const winEnd = Math.min(c.end, call + SPINE_WINDOW);
        const parts: string[] = [];
        // Signature head, only when it sits clearly above the window (else the
        // window already covers the method opening).
        const headEnd = Math.min(c.start + 4, winStart - 2);
        if (headEnd >= c.start) {
          const head = fileLines.slice(c.start - 1, headEnd).join('\n');
          parts.push(numberSourceLines(head, c.start));
        }
        const win = fileLines.slice(winStart - 1, winEnd).join('\n');
        parts.push(numberSourceLines(win, winStart));
        return parts.join(GAP_MARKER);
      }
      const startIdx = Math.max(0, c.start - 1 - contextPadding);
      const endIdx = Math.min(fileLines.length, c.end + contextPadding);
      const slice = fileLines.slice(startIdx, endIdx).join('\n');
      // startIdx is 0-based, so the slice's first line is line startIdx + 1.
      return numberSourceLines(slice, startIdx + 1);
    };

    // Rank clusters for inclusion under the per-file cap. Entry-point
    // clusters come first: a cluster containing a query entry point
    // (importance 10) must outrank a dense block of mere declarations,
    // otherwise on a large file like Session.swift the top-of-file class
    // header + property list (many adjacent low-importance nodes, high
    // density) wins the budget and buries the actual methods the query
    // asked about (perform/didCreateURLRequest/task live deep in the
    // file). Within the same importance tier, prefer density (score per
    // line) so we still favor focused clusters over sprawling ones, then
    // smaller span as a cheap-to-include tiebreak.
    const rankedClusters = clusters
      .map((c, i) => ({ idx: i, span: c.end - c.start + 1, c }))
      .sort((a, b) => {
        // Spine clusters first — the rendered call path IS the flow answer, so it
        // outranks any denser block of peripheral declarations (a low-density entry
        // method must not lose the budget to them). Within spine / within non-spine,
        // the existing importance → density → score → span order holds.
        if (a.c.hasSpine !== b.c.hasSpine) return (b.c.hasSpine ? 1 : 0) - (a.c.hasSpine ? 1 : 0);
        if (b.c.maxImportance !== a.c.maxImportance) return b.c.maxImportance - a.c.maxImportance;
        const densityA = a.c.score / a.span;
        const densityB = b.c.score / b.span;
        if (densityB !== densityA) return densityB - densityA;
        if (b.c.score !== a.c.score) return b.c.score - a.c.score;
        return a.span - b.span;
      });

    // Per-file budget is the SMALLER of the per-file cap and what's left of the
    // total output cap — so selection (which ranks by importance) keeps the
    // high-importance clusters and drops peripheral ones, instead of the
    // downstream source-order trim slicing off whatever comes last in the file.
    // That source-order slice is what cut Django's `_fetch_all` (L2237, importance
    // 9 — agent-named) when query.py was the last of four big files to be emitted.
    const fileBudget = Math.min(budget.maxCharsPerFile, Math.max(0, budget.maxOutputChars - totalChars - 200));
    // Spine ceiling: a flow-path cluster may exceed the per-file cap (the call
    // path is the answer), but bounded — at most ~2.5× the per-file cap and never
    // past what's left of the total output cap — so a pathological long in-file
    // spine can't run away or starve co-flow files entirely.
    const SPINE_CEILING = Math.min(budget.maxCharsPerFile * 2.5, Math.max(0, budget.maxOutputChars - totalChars - 200));
    const chosenIndices = new Set<number>();
    let projectedChars = 0;
    for (const rc of rankedClusters) {
      const sectionLen = buildSection(rc.c).length + (chosenIndices.size > 0 ? GAP_MARKER.length : 0);
      // Always take the top-ranked cluster, even if oversize, so we don't
      // return an empty file section (agent would then re-Read the file,
      // negating the savings).
      if (chosenIndices.size === 0) {
        chosenIndices.add(rc.idx);
        projectedChars += sectionLen;
        continue;
      }
      // A spine cluster (the rendered call path) is the flow answer — include it
      // past the per-file budget up to the spine ceiling; non-spine clusters obey
      // the normal per-file budget.
      const fits = projectedChars + sectionLen <= fileBudget;
      const spineFits = rc.c.hasSpine && projectedChars + sectionLen <= SPINE_CEILING;
      if (!fits && !spineFits) continue;
      chosenIndices.add(rc.idx);
      projectedChars += sectionLen;
    }

    // Emit chosen clusters in source order so the file reads top-to-bottom.
    let fileSection = '';
    const allSymbols: string[] = [];
    for (let i = 0; i < clusters.length; i++) {
      if (!chosenIndices.has(i)) continue;
      const cluster = clusters[i]!;
      const section = buildSection(cluster);
      if (fileSection.length > 0) fileSection += GAP_MARKER;
      fileSection += section;
      allSymbols.push(...cluster.symbols);
    }

    // A chosen cluster is a COMPLETE method-range — we never cut through a body.
    // An oversize single cluster (a long monolithic function) renders in FULL:
    // half a method is useless (the agent just Reads the rest for the other half),
    // which is the very fallback explore exists to prevent. A pathological file is
    // bounded by the per-file cluster SELECTION above + the total hard ceiling.
    if (chosenIndices.size < clusters.length) {
      anyFileTrimmed = true;
    }

    // Dedupe + cap the symbols list shown in the per-file header. Some
    // files (Session.swift in Alamofire) produced 3.4KB symbol lists
    // from cluster scoring + edge-source lines, dwarfing the per-file
    // body cap. Show top names by frequency, with a "+N more" tail.
    const symbolCounts = new Map<string, number>();
    for (const s of allSymbols) {
      symbolCounts.set(s, (symbolCounts.get(s) ?? 0) + 1);
    }
    const sortedSymbols = [...symbolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    const headerCap = budget.maxSymbolsInFileHeader;
    const headerSymbols = sortedSymbols.slice(0, headerCap);
    const omittedCount = sortedSymbols.length - headerSymbols.length;
    const headerSuffix = omittedCount > 0
      ? `${headerSymbols.join(', ')}, +${omittedCount} more`
      : headerSymbols.join(', ');
    const fileHeader = fileSectionHeader(filePath, headerSuffix);

    // The total cap bounds INCIDENTAL files only. A file that DEFINES a symbol
    // the agent named (or that's on the flow spine) renders even when the
    // nominal total is used up — it's the answer, and the set is bounded by
    // maxFiles AND by true-spine/named-seeding having already trimmed each file
    // to its necessary content. A file that merely REFERENCES the flow
    // (Combine.swift name-drops request/task) is incidental → still capped, so
    // freed budget never leaks into noise. This is the last god-file layer:
    // build (Session, true-spined) + validators-exec (Request) + validate
    // (DataRequest/Validation) all render, instead of the cap dropping whichever
    // phase the file order happened to put last.
    if (!fileNecessary && totalChars + reservedChars + fileSection.length + 200 > budget.maxOutputChars) {
      // Incidental file that doesn't fit: SKIP it whole — never slice mid-method.
      // Keep scanning for necessary files (which bypass this cap and render in
      // full, bounded by the hard ceiling).
      anyFileTrimmed = true;
      continue;
    }

    lines.push(fileHeader);
    lines.push('');
    lines.push('```' + lang);
    lines.push(fileSection);
    lines.push('```');
    lines.push('');

    totalChars += fileSection.length + 200;
    renderedFilePaths.push(filePath);
    filesIncluded++;
  }

  // A named file excluded by maxFiles can still receive a continuation. Check
  // its freshness too, so that continuation never uses shifted index offsets.
  for (const filePath of requestedByFile.keys()) {
    if (renderedFilePaths.includes(filePath) || staleOmitted.includes(filePath)) continue;
    if (sourceCache.get(filePath)?.stale ?? this.isFileStaleOnDisk(cg, filePath)) {
      staleOmitted.push(filePath);
    }
  }

  // Drift epilogue (#1474). Drifted files render from the start of the current
  // file or are omitted; indexed ranges must never select their source.
  // Omitted files need Reading, and index-derived line references to drifted
  // files (flow steps, blast radius, trail) may be shifted.
  if (staleOmitted.length > 0) {
    lines[verbatimHeaderIdx] += ' (Exception: files flagged "⚠ changed on disk" below drifted from the index after their last sync — their source is omitted rather than risk a mis-sliced block; Read those specific files.)';
  }
  const staleAll = [...new Set([...staleOmitted, ...staleRendered])];
  if (staleAll.length > 0) {
    lines.push(
      '',
      `> ⚠ Changed on disk after the last index sync: ${staleAll.join(', ')}. Line numbers referencing ${staleAll.length === 1 ? 'this file' : 'these files'} elsewhere in this response (flow steps, blast radius, symbol lists) may be shifted until that project's next sync re-indexes ${staleAll.length === 1 ? 'it' : 'them'}.`,
    );
  }

  // The curated header count is computed from the files that SURVIVE the final
  // truncation (see end of method) — `filesIncluded` can over-count when the
  // hard ceiling drops trailing sections — so leave a sentinel here and fill it
  // in once the output is final.
  lines[summaryLineIdx] = SUMMARY_SENTINEL;

  // Add remaining files as references (from both relevant and peripheral files).
  // Small projects (per budget) skip this — the relevant story already fits
  // in the source section, and a trailing pointer list is pure overhead.
  if (budget.includeAdditionalFiles) {
    const remainingRelevant = sortedFiles.slice(filesIncluded);
    const peripheralFiles = [...fileGroups.entries()]
      .filter(([, group]) => group.score < 3)
      .sort((a, b) => b[1].score - a[1].score);
    const remainingFiles = [...remainingRelevant, ...peripheralFiles];
    if (remainingFiles.length > 0) {
      lines.push('**Not shown above — explore these names for their source**');
      lines.push('');
      for (const [filePath, group] of remainingFiles.slice(0, 10)) {
        const symbols = group.nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
        lines.push(`- ${filePath}: ${symbols}`);
      }
      if (remainingFiles.length > 10) {
        lines.push(`- ... and ${remainingFiles.length - 10} more files`);
      }
    }
  }

  // Describe excerpt coverage and how to retrieve another definition. Small
  // projects skip the general note unless a section was actually trimmed.
  if (budget.includeCompletenessSignal) {
    lines.push('');
    lines.push('---');
    lines.push('> Only the displayed source ranges are included. For another definition, use codegraph_node with its symbol, file, and includeCode=true; use file/offset/limit to continue a partial body.');
  } else if (anyFileTrimmed) {
    lines.push('');
    lines.push('> Source excerpts omit other definitions. Use codegraph_node with symbol, file, and includeCode=true for another body; follow any continuation below for a partial body.');
  }

  // Add explore budget note based on project size
  if (budget.includeBudgetNote) {
    try {
      const stats = cg.getStats();
      const callBudget = getExploreBudget(stats.fileCount);
      lines.push('');
      lines.push(`> **Explore budget: ${callBudget} calls for this project (${stats.fileCount.toLocaleString()} files indexed).** Each call covers ~6 files; if your question spans more, spend your remaining calls on the uncovered area BEFORE falling back to Read — another explore is cheaper and more complete than reading those files. Synthesize once you've used ${callBudget}.`);
    } catch {
      // Stats unavailable — skip budget note
    }
  }

  // Final ceiling — an ABSOLUTE inline cap, not a multiple of the budget. The
  // render loop renders necessary (named/spine) files even a bit past
  // maxOutputChars and caps only incidental ones, so this is the last safety.
  // It MUST stay under the host's inline tool-result limit (~25K chars): above
  // that the result is externalized to a file the agent Reads back (a 35K
  // vscode explore did exactly this in the n=4 A/B). So allow a little
  // necessary overflow above the 24K budget, but hard-stop at 25K — never into
  // externalize territory.
  const output = flow.text + lines.join('\n');

  const hardCeiling = Math.min(Math.round(budget.maxOutputChars * 1.5), 25000);
  // The main thread appends watcher/worktree notices after worker dispatch.
  // Carry compact metadata so the FINAL response can reserve those notices,
  // audit surviving source, and update the summary inside the same ceiling.
  return {
    ...this.textResult(output),
    exploreSource: {
      // Leave room for replacing the summary sentinel after clipping.
      maxChars: hardCeiling - 128,
      targets: requestedNodes.map(({ filePath, name, qualifiedName, startLine, endLine }) =>
        ({ filePath, name, qualifiedName, startLine, endLine })),
      staleFiles: staleAll,
      projectPath: projectRoot,
      lineNumbers: exploreLineNumbersEnabled(),
      summaryPlaceholder: SUMMARY_SENTINEL,
      fallbackSummary: `Found ${subgraph.nodes.size} symbol${subgraph.nodes.size === 1 ? '' : 's'} across ${fileGroups.size} file${fileGroups.size === 1 ? '' : 's'}.`,
      files: renderedFilePaths.map((path) => ({
        path,
        symbolCount: new Set((fileGroups.get(path)?.nodes ?? [])
          .filter((node) => node.kind !== 'import' && node.kind !== 'export').map((node) => node.id)).size,
      })),
    },
  };
}
