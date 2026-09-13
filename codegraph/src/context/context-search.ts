import * as path from 'path';
import { logDebug } from '../errors';
import {
  extractSearchTerms,
  getStemVariants,
  isDistinctiveIdentifier,
  isTestFile,
  scorePathRelevance,
} from '../search/query-utils';
import {
  Edge,
  EdgeKind,
  FindRelevantContextOptions,
  Node,
  NodeKind,
  SearchResult,
  Subgraph
} from '../types';
import { DEFAULT_FIND_OPTIONS } from './context-options';
import type { ContextState } from './context-state';
import { extractSymbolsFromQuery } from './query-symbols';


/**
   * Find relevant subgraph for a query
   *
   * Uses hybrid search combining exact symbol lookup with semantic search:
   * 1. Extract potential symbol names from query
   * 2. Look up exact matches for those symbols (high confidence)
   * 3. Use semantic search for concept matching
   * 4. Merge results, prioritizing exact matches
   * 5. Traverse graph from entry points
   *
   * @param query - Natural language query
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
export async function findRelevantContext(this: ContextState, query: string, options: FindRelevantContextOptions = {}): Promise<Subgraph> {
  const opts = { ...DEFAULT_FIND_OPTIONS, ...options };

  // Start with empty subgraph
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const roots: string[] = [];

  // Handle empty query - return empty subgraph
  if (!query || query.trim().length === 0) {
    return { nodes, edges, roots };
  }

  // === HYBRID SEARCH ===

  // Step 1: Extract potential symbol names from query
  const symbolsFromQuery = extractSymbolsFromQuery(query);
  logDebug('Extracted symbols from query', { query, symbols: symbolsFromQuery });

  // Step 2: Look up exact matches for extracted symbols
  let exactMatches: SearchResult[] = [];
  if (symbolsFromQuery.length > 0) {
    try {
      // Get more results so we can apply co-location boosting before trimming
      exactMatches = this.queries.findNodesByExactName(symbolsFromQuery, {
        limit: Math.ceil(opts.searchLimit * 5),
        kinds: opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
      });

      // Co-location boost: when multiple extracted symbols appear in the same file,
      // those results are much more likely to be what the user is looking for.
      // E.g., "scrapeLoop" + "run" both in scrape/scrape.go → boost both.
      if (exactMatches.length > 1) {
        // Build a map of files → how many distinct symbol names matched in that file
        const fileSymbolCounts = new Map<string, Set<string>>();
        for (const r of exactMatches) {
          const names = fileSymbolCounts.get(r.node.filePath) || new Set();
          names.add(r.node.name.toLowerCase());
          fileSymbolCounts.set(r.node.filePath, names);
        }
        // Boost results in files where multiple query symbols co-occur
        exactMatches = exactMatches.map(r => {
          const symbolCount = fileSymbolCounts.get(r.node.filePath)?.size || 1;
          return {
            ...r,
            score: symbolCount > 1 ? r.score + (symbolCount - 1) * 20 : r.score,
          };
        });
        exactMatches.sort((a, b) => b.score - a.score);
      }

      // Trim back to reasonable size
      exactMatches = exactMatches.slice(0, Math.ceil(opts.searchLimit * 2));
      logDebug('Exact symbol matches', { count: exactMatches.length });
    } catch (error) {
      logDebug('Exact symbol lookup failed', { error: String(error) });
    }
  }

  // Step 2b: Search for extracted symbols as definition (class/interface) prefixes.
  // When the user writes "REST", "bulk", or "allocation", they usually mean classes
  // like RestController, BulkRequest, AllocationService — not nodes named exactly that.
  // Also tries stem variants: "caching" → "cache" finds Cache, CacheBuilder.
  if (symbolsFromQuery.length > 0) {
    const definitionKinds: NodeKind[] = ['class', 'interface', 'struct', 'trait',
      'protocol', 'enum', 'type_alias'];
    // Expand symbols with stem variants for broader definition matching
    const expandedSymbols = new Set(symbolsFromQuery);
    for (const sym of symbolsFromQuery) {
      for (const variant of getStemVariants(sym)) {
        expandedSymbols.add(variant);
      }
    }
    for (const sym of expandedSymbols) {
      // Title-case the symbol: "REST" → "Rest", "bulk" → "Bulk", "allocation" → "Allocation"
      const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
      if (titleCased === sym) continue; // already title-case (e.g., "Engine") — handled by exact match
      // Fetch more results since popular prefixes have many matches
      const prefixResults = this.queries.searchNodes(titleCased, {
        limit: 30,
        kinds: definitionKinds,
      });
      const matched: SearchResult[] = [];
      for (const r of prefixResults) {
        if (r.node.name.toLowerCase().startsWith(titleCased.toLowerCase())) {
          // Favor shorter names: "AllocationService" (18 chars) over
          // "AllocationBalancingRoundMetrics" (31 chars). Core classes tend
          // to have concise names; test/helper classes are verbose.
          const brevityBonus = Math.max(0, 10 - (r.node.name.length - titleCased.length) / 3);
          matched.push({ ...r, score: r.score + 15 + brevityBonus });
        }
      }
      matched.sort((a, b) => b.score - a.score);
      for (const r of matched.slice(0, Math.ceil(opts.searchLimit))) {
        const existing = exactMatches.find(e => e.node.id === r.node.id);
        if (!existing) {
          exactMatches.push(r);
        }
      }
    }
    exactMatches.sort((a, b) => b.score - a.score);
    exactMatches = exactMatches.slice(0, Math.ceil(opts.searchLimit * 3));
  }

  // Step 3: Run text search for natural language term matching
  // This catches file-name and node-name matches that semantic search may miss,
  // which is critical for template-heavy codebases (e.g., Liquid/Shopify themes)
  // where file names are the primary identifiers.
  let textResults: SearchResult[] = [];
  try {
    const searchTerms = extractSearchTerms(query);
    if (searchTerms.length > 0) {
      // Search each term individually to get broader coverage,
      // then boost results that match multiple terms
      const termResultsMap = new Map<string, { result: SearchResult; termHits: number }>();
      // When no explicit kind filter is set, exclude imports — they flood FTS
      // results with qualified name matches (e.g., "REST" matches 445K import paths)
      // but are almost never what exploration queries want.
      const searchKinds = opts.nodeKinds && opts.nodeKinds.length > 0
        ? opts.nodeKinds
        : ['file', 'module', 'class', 'struct', 'interface', 'trait', 'protocol',
          'function', 'method', 'property', 'field', 'variable', 'constant',
          'enum', 'enum_member', 'type_alias', 'namespace', 'export',
          'route', 'component'] as NodeKind[];
      for (const term of searchTerms) {
        const termResults = this.queries.searchNodes(term, {
          limit: opts.searchLimit * 2,
          kinds: searchKinds,
        });
        for (const r of termResults) {
          const existing = termResultsMap.get(r.node.id);
          if (existing) {
            existing.termHits++;
            existing.result.score = Math.max(existing.result.score, r.score);
          } else {
            termResultsMap.set(r.node.id, { result: r, termHits: 1 });
          }
        }
      }
      // Boost results matching multiple terms and sort
      textResults = Array.from(termResultsMap.values())
        .map(({ result, termHits }) => ({
          ...result,
          score: result.score + (termHits - 1) * 5,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, opts.searchLimit * 2);
    }
    logDebug('Text search results', { count: textResults.length });
  } catch (error) {
    logDebug('Text search failed', { query, error: String(error) });
  }

  // Step 4: Merge results, taking the max score when duplicates appear
  // across search channels. Exact matches may have lower scores than FTS
  // results for the same node — use the best score from any channel.
  const resultById = new Map<string, SearchResult>();
  let searchResults: SearchResult[] = [];

  // Add exact matches first
  for (const result of exactMatches) {
    const existing = resultById.get(result.node.id);
    if (existing) {
      existing.score = Math.max(existing.score, result.score);
    } else {
      resultById.set(result.node.id, result);
      searchResults.push(result);
    }
  }

  // Add text search results, upgrading scores for duplicates
  for (const result of textResults) {
    const existing = resultById.get(result.node.id);
    if (existing) {
      existing.score = Math.max(existing.score, result.score);
    } else {
      resultById.set(result.node.id, result);
      searchResults.push(result);
    }
  }

  const queryLower = query.toLowerCase();
  const isTestQuery = queryLower.includes('test') || queryLower.includes('spec');

  // Deprioritize test files early so they don't take multi-term boost slots
  if (!isTestQuery) {
    for (const result of searchResults) {
      if (isTestFile(result.node.filePath)) {
        result.score *= 0.3;
      }
    }
  }

  // Iter7 — Core-directory boost. On projects with one file that holds
  // the dense majority of internal call edges (e.g. sinatra's
  // `lib/sinatra/base.rb` at 85% of all in-file edges), the agent's
  // task usually asks about the framework's core. Without this boost,
  // ranking favors small focused extension files (e.g. text search
  // picks `sinatra-contrib/lib/sinatra/multi_route.rb`'s 10-line
  // `route` method over `base.rb`'s `route!` because the extension
  // file's `route` matches the query verbatim AND the file is small,
  // dwarfing the longer name `route!` in a 1500-line file). Boost
  // results that share a directory prefix with the dominant file's
  // directory so the core file's siblings outrank sibling-package
  // extensions.
  try {
    const dominant = this.queries.getDominantFile?.();
    if (dominant && dominant.edgeCount >= 3 * dominant.nextEdgeCount) {
      // Take the directory of the dominant file (everything up to the
      // last slash). For `lib/sinatra/base.rb` → `lib/sinatra/`.
      const slash = dominant.filePath.lastIndexOf('/');
      if (slash > 0) {
        const coreDir = dominant.filePath.slice(0, slash + 1);
        for (const result of searchResults) {
          if (result.node.filePath.startsWith(coreDir)) {
            result.score += 25;
          }
        }
      }
    }
  } catch {
    // SQL failure — fall through, scoring works without the boost
  }

  // Step 5a: Multi-term co-occurrence re-ranking (applied BEFORE truncation).
  // For multi-word queries like "search execution from request to shard",
  // nodes matching 2+ query terms in their name or path are far more relevant
  // than nodes matching just one generic term. Without this, "ExecutionUtils"
  // (matches only "execution") fills budget slots meant for "ShardSearchRequest"
  // (matches "shard" + "search" + "request").
  const queryTermsForBoost = extractSearchTerms(query);
  if (queryTermsForBoost.length >= 2) {
    // Group terms that are substrings of each other (stem variants of the same
    // root word). "indexed", "indexe", "index" should count as ONE concept match,
    // not three. Without this, stem variants inflate matchCount and give false
    // multi-term boosts to symbols matching one root word multiple times.
    const termGroups: string[][] = [];
    const sorted = [...queryTermsForBoost].sort((a, b) => b.length - a.length);
    const assigned = new Set<string>();
    for (const term of sorted) {
      if (assigned.has(term)) continue;
      const group = [term];
      assigned.add(term);
      for (const other of sorted) {
        if (assigned.has(other)) continue;
        if (term.includes(other) || other.includes(term)) {
          group.push(other);
          assigned.add(other);
        }
      }
      termGroups.push(group);
    }

    // Build a set of exact-match node IDs so we can exempt them from dampening.
    // When the query is "LiveEditMode DevServerPreview", these are specific
    // symbols the user asked for — dampening them because they only match 1
    // term group is counter-productive.
    const exactMatchIds = new Set(exactMatches.map(r => r.node.id));

    // ...but only exempt exact matches the user *named as an identifier*
    // (camelCase/snake_case/acronym). A plain dictionary word that happens to
    // exact-match an unrelated symbol — query "flat object" → a constant named
    // FLAT — must NOT be exempt, or the +exact-name bonus floats it to the top
    // of a prose query with zero corroboration from any other term. Classify by
    // the QUERY token (what the user typed), not the matched symbol's name.
    const distinctiveTokens = new Set(
      symbolsFromQuery.filter(isDistinctiveIdentifier).map(s => s.toLowerCase())
    );
    const distinctiveExactMatchIds = new Set(
      exactMatches
        .filter(r => distinctiveTokens.has(r.node.name.toLowerCase()))
        .map(r => r.node.id)
    );

    for (const result of searchResults) {
      // Check term matches in name (substring) and path DIRECTORIES (exact).
      // Directory segments must match exactly — "search" matches directory
      // "search/" but NOT "elasticsearch/". The class name is checked
      // separately via substring match on the node name.
      const nameLower = result.node.name.toLowerCase();
      const dirSegments = path.dirname(result.node.filePath).toLowerCase().split('/');
      let matchCount = 0;
      for (const group of termGroups) {
        const groupMatches = group.some(term => {
          const inName = nameLower.includes(term);
          const inDir = dirSegments.some(seg => seg === term);
          return inName || inDir;
        });
        if (groupMatches) matchCount++;
      }
      if (matchCount >= 2) {
        // Multiplicative boost — 2 terms → 2x, 3 terms → 2.5x
        result.score *= 1 + matchCount * 0.5;
      } else if (distinctiveExactMatchIds.has(result.node.id)) {
        // Exact match on a distinctive identifier the user explicitly named —
        // keep full score (e.g. "LiveEditMode DevServerPreview").
      } else if (exactMatchIds.has(result.node.id)) {
        // Exact match on a COMMON word (e.g. "flat" → FLAT): high-scoring noise
        // inflated by the +exact-name bonus, corroborated by no other query
        // term. Demote hard so corroborated matches win.
        result.score *= 0.3;
      } else {
        // Mild dampen for generic single-term matches — they might be generic
        // but could also be the right result (e.g., "Protocol" class for an IPC query).
        result.score *= 0.6;
      }
    }
    searchResults.sort((a, b) => b.score - a.score);
  }

  // Step 5b: CamelCase-boundary matching via LIKE query.
  // FTS can't find "Search" inside "TransportSearchAction" (one FTS token).
  // LIKE reliably finds these substring matches. Results are appended with
  // guaranteed slots so they don't compete with higher-scoring prefix matches.
  if (symbolsFromQuery.length > 0) {
    const camelDefinitionKinds: NodeKind[] = ['class', 'interface', 'struct', 'trait',
      'protocol', 'enum', 'type_alias'];
    // Callable kinds participate too: in service-layer codebases the
    // camel-infix definers of a queried FIELD are methods/functions
    // (`profileInfo` → `getProfileInfoV2`), not classes — the type-only
    // whitelist made this whole step dead code there (#1196). Fetched as a
    // SEPARATE LIKE batch so one hot single-word term can't crowd classes
    // out of the length-ordered 200-row batch.
    const camelCallableKinds: NodeKind[] = ['function', 'method', 'component'];
    const camelSearchedTerms = new Set<string>();
    const searchIdSet = new Set(searchResults.map(r => r.node.id));
    // Track per-node term hits for multi-term boosting
    const camelNodeTerms = new Map<string, { result: SearchResult; termCount: number }>();
    const maxCamelPerTerm = Math.ceil(opts.searchLimit / 2);

    for (const sym of symbolsFromQuery) {
      const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
      if (titleCased.length < 3) continue;
      const termKey = titleCased.toLowerCase();
      if (camelSearchedTerms.has(termKey)) continue;
      camelSearchedTerms.add(termKey);

      // Fetch a large batch — popular terms like "Search" in Elasticsearch
      // have hundreds of substring matches. The LIKE scan cost is the same
      // regardless of LIMIT (SQLite scans all matches to sort), so we fetch
      // generously and let path-relevance scoring pick the best ones.
      const likeResults = [
        ...this.queries.findNodesByNameSubstring(titleCased, {
          limit: 200,
          kinds: camelDefinitionKinds,
          excludePrefix: true,
        }),
        ...this.queries.findNodesByNameSubstring(titleCased, {
          limit: 200,
          kinds: camelCallableKinds,
          excludePrefix: true,
        }),
      ];

      // Filter to CamelCase boundaries, score by path relevance, and take top N
      const termCandidates: SearchResult[] = [];
      for (const r of likeResults) {
        const name = r.node.name;
        // Case-INSENSITIVE hump lookup: title-casing lowercases interior
        // humps (`profileInfo` → `Profileinfo`), which SQLite's LIKE still
        // matched but a case-sensitive indexOf here silently dropped —
        // making every multi-hump query term unfindable by this step
        // (#1196). The match must still LAND on an uppercase char, so a
        // plain lowercase infix can't slip through.
        const idx = name.toLowerCase().indexOf(termKey);
        if (idx <= 0) continue;
        if (!/[A-Z]/.test(name.charAt(idx))) continue;
        // Accept CamelCase boundary (lowercase before match) OR
        // acronym boundary (uppercase before match, e.g., RPCProtocol)
        if (!/[a-zA-Z]/.test(name.charAt(idx - 1))) continue;
        if (searchIdSet.has(r.node.id)) continue;
        if (isTestFile(r.node.filePath) && !isTestQuery) continue;

        const pathScore = scorePathRelevance(r.node.filePath, query);
        const brevityBonus = Math.max(0, 6 - (name.length - titleCased.length) / 4);
        termCandidates.push({ node: r.node, score: 8 + brevityBonus + pathScore });
      }
      termCandidates.sort((a, b) => b.score - a.score);

      // Widen the per-term pool for accumulation so multi-term co-occurrences
      // can be discovered. A class matching 3 query terms at CamelCase boundaries
      // is far more relevant than one matching just 1, but it needs to survive
      // the per-term cut for EACH term to accumulate its count.
      const accumPerTerm = maxCamelPerTerm * 4;
      for (const r of termCandidates.slice(0, accumPerTerm)) {
        const existing = camelNodeTerms.get(r.node.id);
        if (existing) {
          existing.termCount++;
        } else {
          camelNodeTerms.set(r.node.id, {
            result: r,
            termCount: 1,
          });
        }
      }
    }

    // Append CamelCase matches with multi-term boost.
    // These are structurally important (class names containing query terms at
    // CamelCase boundaries) but score much lower than FTS results. Scale their
    // scores up so multi-term CamelCase matches can compete with FTS results.
    const camelResults: SearchResult[] = [];
    for (const [, info] of camelNodeTerms) {
      // Multi-term CamelCase matches are extremely relevant — a class matching
      // 3+ query terms in its name (e.g., ExtensionHostProcess) is almost
      // certainly what the user wants. Scale aggressively.
      info.result.score = info.result.score * (1 + info.termCount) + (info.termCount - 1) * 30;
      camelResults.push(info.result);
    }
    camelResults.sort((a, b) => b.score - a.score);
    const maxCamelTotal = opts.searchLimit;
    for (const r of camelResults.slice(0, maxCamelTotal)) {
      searchResults.push(r);
      searchIdSet.add(r.node.id);
    }

    // Step 5c: Compound term matching — find classes whose name contains 2+
    // query terms at ANY position (not just CamelCase boundaries).
    // The CamelCase step above requires idx > 0, which misses classes that
    // START with a query term (e.g., "SearchShardsRequest" starts with "Search").
    // For multi-word queries, a class matching multiple query terms in its name
    // is almost certainly relevant regardless of position.
    if (symbolsFromQuery.length >= 2) {
      // Collect ALL LIKE results per term (reusing findNodesByNameSubstring)
      // but without the CamelCase boundary or prefix exclusion filters.
      const compoundTermMap = new Map<string, { node: Node; terms: Set<string> }>();
      for (const sym of symbolsFromQuery) {
        const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
        if (titleCased.length < 3) continue;

        const likeResults = [
          ...this.queries.findNodesByNameSubstring(titleCased, {
            limit: 200,
            kinds: camelDefinitionKinds,
            excludePrefix: false,
          }),
          // Same separate callable batch as Step 5b (#1196).
          ...this.queries.findNodesByNameSubstring(titleCased, {
            limit: 200,
            kinds: camelCallableKinds,
            excludePrefix: false,
          }),
        ];

        for (const r of likeResults) {
          if (searchIdSet.has(r.node.id)) continue;
          if (isTestFile(r.node.filePath) && !isTestQuery) continue;
          const entry = compoundTermMap.get(r.node.id);
          if (entry) {
            entry.terms.add(titleCased);
          } else {
            compoundTermMap.set(r.node.id, { node: r.node, terms: new Set([titleCased]) });
          }
        }
      }

      // Keep only nodes matching 2+ distinct terms
      const compoundResults: SearchResult[] = [];
      for (const [, entry] of compoundTermMap) {
        if (entry.terms.size >= 2) {
          const pathScore = scorePathRelevance(entry.node.filePath, query);
          const brevityBonus = Math.max(0, 6 - entry.node.name.length / 8);
          compoundResults.push({
            node: entry.node,
            score: 10 + (entry.terms.size - 1) * 20 + pathScore + brevityBonus,
          });
        }
      }
      compoundResults.sort((a, b) => b.score - a.score);
      const maxCompound = Math.ceil(opts.searchLimit / 2);
      for (const r of compoundResults.slice(0, maxCompound)) {
        searchResults.push(r);
        searchIdSet.add(r.node.id);
      }
    }
  }

  // Final sort and truncation — all search channels (exact, text, CamelCase,
  // compound) have now contributed. Sort by score so multi-term matches from
  // later steps can outrank dampened single-term matches from earlier steps.
  searchResults.sort((a, b) => b.score - a.score);
  searchResults = searchResults.slice(0, opts.searchLimit * 3);

  // Filter by minimum score
  let filteredResults = searchResults.filter((r) => r.score >= opts.minScore);

  // Resolve imports/exports to their actual definitions
  // If someone searches "terminal" and finds `import { TerminalPanel }`,
  // they want the TerminalPanel class, not the import statement
  filteredResults = this.resolveImportsToDefinitions(filteredResults);

  // Cap entry points so traversal budget isn't spread too thin.
  // With 36 entry points and maxNodes=120, each gets only 3 nodes — useless.
  // Cap to searchLimit so each entry point gets a meaningful traversal budget.
  if (filteredResults.length > opts.searchLimit) {
    filteredResults = filteredResults.slice(0, opts.searchLimit);
  }

  // Confidence signal for the honest-handoff footer (consumed in buildContext).
  // A multi-term prose query that resolves only to isolated common-word matches
  // — no entry point corroborated by 2+ distinct query terms, and none a
  // distinctive identifier the user explicitly named — is LOW confidence: the
  // results are best-effort, not a located answer, so the agent should be told
  // to drill in with explore/trace rather than trust the list as comprehensive.
  // Single-keyword and symbol-name queries are exempt (their single match IS the
  // answer), so the handoff never fires on them.
  let confidence: 'high' | 'low' = 'high';
  const confTerms = extractSearchTerms(query, { stems: false }).filter(t => t.length >= 3);
  if (confTerms.length >= 2 && filteredResults.length > 0) {
    const distinctive = new Set(
      symbolsFromQuery.filter(isDistinctiveIdentifier).map(s => s.toLowerCase())
    );
    const anyStrong = filteredResults.some(r => {
      if (distinctive.has(r.node.name.toLowerCase())) return true;
      const nameLower = r.node.name.toLowerCase();
      const dirSegs = path.dirname(r.node.filePath).toLowerCase().split('/');
      let hits = 0;
      for (const t of confTerms) {
        if (nameLower.includes(t) || dirSegs.includes(t)) {
          if (++hits >= 2) return true;
        }
      }
      return false;
    });
    if (!anyStrong) confidence = 'low';
  }

  // Add entry points to subgraph
  for (const result of filteredResults) {
    nodes.set(result.node.id, result.node);
    roots.push(result.node.id);
  }

  // Expand type hierarchy for class/interface entry points.
  // BFS often exhausts its per-entry-point budget on contained methods
  // before reaching extends/implements neighbors. This dedicated step
  // ensures subclasses and superclasses always appear in results.
  // Budget: up to maxNodes/4 hierarchy nodes to avoid flooding.
  const typeHierarchyKinds = new Set<string>(['class', 'interface', 'struct', 'trait', 'protocol']);
  const maxHierarchyNodes = Math.ceil(opts.maxNodes / 4);
  let hierarchyNodesAdded = 0;
  for (const result of filteredResults) {
    if (hierarchyNodesAdded >= maxHierarchyNodes) break;
    if (typeHierarchyKinds.has(result.node.kind)) {
      const hierarchy = this.traverser.getTypeHierarchy(result.node.id);
      for (const [id, node] of hierarchy.nodes) {
        if (!nodes.has(id)) {
          nodes.set(id, node);
          hierarchyNodesAdded++;
        }
      }
      for (const edge of hierarchy.edges) {
        const exists = edges.some(
          (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
        );
        if (!exists) {
          edges.push(edge);
        }
      }
    }
  }

  // Pass 2: expand hierarchy of newly-discovered parent types to find siblings.
  // E.g., InternalEngine → Engine (parent, from pass 1) → ReadOnlyEngine (sibling).
  if (hierarchyNodesAdded > 0) {
    const pass2Candidates = [...nodes.values()].filter(
      n => typeHierarchyKinds.has(n.kind) && !roots.includes(n.id)
    );
    for (const candidate of pass2Candidates) {
      if (hierarchyNodesAdded >= maxHierarchyNodes) break;
      const siblingHierarchy = this.traverser.getTypeHierarchy(candidate.id);
      for (const [id, node] of siblingHierarchy.nodes) {
        if (!nodes.has(id) && hierarchyNodesAdded < maxHierarchyNodes) {
          nodes.set(id, node);
          hierarchyNodesAdded++;
        }
      }
      for (const edge of siblingHierarchy.edges) {
        if (nodes.has(edge.source) && nodes.has(edge.target)) {
          const exists = edges.some(
            (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
          );
          if (!exists) {
            edges.push(edge);
          }
        }
      }
    }
  }

  // Traverse from each entry point
  for (const result of filteredResults) {
    const traversalResult = this.traverser.traverseBFS(result.node.id, {
      maxDepth: opts.traversalDepth,
      edgeKinds: opts.edgeKinds && opts.edgeKinds.length > 0 ? opts.edgeKinds : undefined,
      nodeKinds: opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
      direction: 'both',
      limit: Math.ceil(opts.maxNodes / Math.max(1, filteredResults.length)),
    });

    // Merge nodes
    for (const [id, node] of traversalResult.nodes) {
      if (!nodes.has(id)) {
        nodes.set(id, node);
      }
    }

    // Merge edges (avoid duplicates)
    for (const edge of traversalResult.edges) {
      const exists = edges.some(
        (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
      );
      if (!exists) {
        edges.push(edge);
      }
    }
  }

  // Trim to max nodes if needed
  let finalNodes = nodes;
  let finalEdges = edges;
  if (nodes.size > opts.maxNodes) {
    // Prioritize entry points and their direct neighbors
    const priorityIds = new Set(roots);
    for (const edge of edges) {
      if (priorityIds.has(edge.source)) {
        priorityIds.add(edge.target);
      }
      if (priorityIds.has(edge.target)) {
        priorityIds.add(edge.source);
      }
    }

    // Keep priority nodes, then fill remaining slots
    finalNodes = new Map<string, Node>();
    for (const id of priorityIds) {
      const node = nodes.get(id);
      if (node && finalNodes.size < opts.maxNodes) {
        finalNodes.set(id, node);
      }
    }

    // Fill remaining from other nodes
    for (const [id, node] of nodes) {
      if (finalNodes.size >= opts.maxNodes) break;
      if (!finalNodes.has(id)) {
        finalNodes.set(id, node);
      }
    }

    // Filter edges to only include kept nodes
    finalEdges = edges.filter(
      (e) => finalNodes.has(e.source) && finalNodes.has(e.target)
    );
  }

  // Per-file diversity cap: prevent any single file from monopolizing the
  // node budget. When BFS traverses from a method, it follows `contains`
  // to the parent class, then back down to all sibling methods. With
  // multiple entry points in the same class, one file can consume 30-40%
  // of maxNodes. Cap each file to ~20% to ensure cross-file diversity.
  const maxPerFile = Math.max(5, Math.ceil(opts.maxNodes * 0.2));
  const fileCounts = new Map<string, string[]>();
  for (const [id, node] of finalNodes) {
    const ids = fileCounts.get(node.filePath) || [];
    ids.push(id);
    fileCounts.set(node.filePath, ids);
  }
  const rootSet = new Set(roots);
  for (const [, nodeIds] of fileCounts) {
    if (nodeIds.length <= maxPerFile) continue;
    // Sort: entry points first, then classes/interfaces, then others
    const kindPriority: Record<string, number> = {
      class: 3, interface: 3, struct: 3, trait: 3, protocol: 3, enum: 3,
      method: 1, function: 1, property: 0, field: 0, variable: 0,
    };
    nodeIds.sort((a, b) => {
      const aRoot = rootSet.has(a) ? 10 : 0;
      const bRoot = rootSet.has(b) ? 10 : 0;
      const aKind = kindPriority[finalNodes.get(a)!.kind] ?? 0;
      const bKind = kindPriority[finalNodes.get(b)!.kind] ?? 0;
      return (bRoot + bKind) - (aRoot + aKind);
    });
    // Remove excess nodes (keep the highest-priority ones)
    for (const id of nodeIds.slice(maxPerFile)) {
      finalNodes.delete(id);
    }
  }
  // Non-production node cap: limit test/sample/integration/example files to
  // at most 15% of the budget. Many codebases have dozens of near-identical
  // test implementations (e.g., 6 Guard classes in integration tests) that
  // individually survive score dampening but collectively flood the result.
  // Test entry points are NOT exempt — they should be evicted too.
  if (!isTestQuery) {
    const maxNonProd = Math.max(3, Math.ceil(opts.maxNodes * 0.15));
    const nonProdIds: string[] = [];
    for (const [id, node] of finalNodes) {
      if (isTestFile(node.filePath)) {
        nonProdIds.push(id);
      }
    }
    if (nonProdIds.length > maxNonProd) {
      for (const id of nonProdIds.slice(maxNonProd)) {
        finalNodes.delete(id);
        // Also remove from roots — test file entry points shouldn't anchor results
        const rootIdx = roots.indexOf(id);
        if (rootIdx !== -1) roots.splice(rootIdx, 1);
      }
    }
  }

  // Re-filter edges after per-file and non-production caps
  finalEdges = finalEdges.filter(
    (e) => finalNodes.has(e.source) && finalNodes.has(e.target)
  );

  // Edge recovery: BFS with many entry points leaves most nodes disconnected.
  // Discover edges between already-selected nodes to recover connectivity.
  const recoveryKinds: EdgeKind[] = ['calls', 'extends', 'implements', 'references', 'overrides'];
  const recoveredEdges = this.queries.findEdgesBetweenNodes(
    [...finalNodes.keys()],
    recoveryKinds,
  );
  const existingEdgeKeys = new Set(
    finalEdges.map((e) => `${e.source}:${e.target}:${e.kind}`)
  );
  for (const edge of recoveredEdges) {
    const key = `${edge.source}:${edge.target}:${edge.kind}`;
    if (!existingEdgeKeys.has(key)) {
      finalEdges.push(edge);
      existingEdgeKeys.add(key);
    }
  }

  return { nodes: finalNodes, edges: finalEdges, roots, confidence };
}
