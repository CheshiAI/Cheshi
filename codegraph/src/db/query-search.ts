import { boundedEditDistance, parseQuery } from '../search/query-parser';
import { kindBonus, nameMatchBonus, scorePathRelevance } from '../search/query-utils';
import {
  Language,
  NodeKind,
  SearchOptions,
  SearchResult
} from '../types';
import {
  appendNodeFilters,
  type NodeRow,
  rowToNode
} from './query-rows';
import type { QueryState } from './query-state';

/**
   * Search nodes by name using FTS with fallback to LIKE for better matching
   *
   * Search strategy:
   * 1. Try FTS5 prefix match (query*) for word-start matching
   * 2. If no results, try LIKE for substring matching (e.g., "signIn" finds "signInWithGoogle")
   * 3. Score results based on match quality
   */
export function searchNodes(this: QueryState, query: string, options: SearchOptions = {}): SearchResult[] {
  const { limit = 100, offset = 0 } = options;

  // Parse field-qualified bits out of the raw query (kind:, lang:,
  // path:, name:). Anything not recognised stays in `text` and goes
  // to FTS unchanged. Filters compose with the SearchOptions arg —
  // both are applied (intersection-style).
  const parsed = parseQuery(query);
  const mergedKinds =
    parsed.kinds.length > 0
      ? Array.from(new Set([...(options.kinds ?? []), ...parsed.kinds]))
      : options.kinds;
  const mergedLanguages =
    parsed.languages.length > 0
      ? Array.from(new Set([...(options.languages ?? []), ...parsed.languages]))
      : options.languages;
  const pathFilters = parsed.pathFilters;
  const nameFilters = parsed.nameFilters;
  // The text portion drives FTS/LIKE; if all the user typed was
  // filters (`kind:function`), we still need *some* candidate set,
  // so synthesise an empty-text path that returns everything matching
  // the filters.
  const text = parsed.text;
  const kinds = mergedKinds;
  const languages = mergedLanguages;

  // First try FTS5 with prefix matching
  let results = text
    ? this.searchNodesFTS(text, { kinds, languages, limit, offset })
    // Over-fetch by 5× when running filter-only (no text). The
    // post-scoring path: + name: filters can be very selective, so
    // a smaller multiplier risks returning fewer than `limit`
    // results despite the DB having plenty of matches.
    : this.searchAllByFilters({ kinds, languages, limit: limit * 5 });

  // If no FTS results, try LIKE-based substring search
  if (results.length === 0 && text.length >= 2) {
    results = this.searchNodesLike(text, { kinds, languages, limit, offset });
  }

  // Final fuzzy fallback: scan all known names and keep those within
  // a tight Levenshtein distance. Only fires when both FTS and LIKE
  // returned nothing AND there's a text portion long enough to be
  // worth fuzzing (1-char queries would match too much).
  if (results.length === 0 && text.length >= 3) {
    results = this.searchNodesFuzzy(text, { kinds, languages, limit });
  }

  // Supplement: ensure exact name matches are always candidates.
  // BM25 can bury short exact-match names (e.g. "getBean") under hundreds of
  // compound names (e.g. "getBeanDescriptor") in large codebases,
  // pushing them past the FTS fetch limit before post-hoc scoring can help.
  // Use the max BM25 score as the base so the nameMatchBonus (exact=30 vs
  // prefix=20) actually differentiates them after rescoring.
  if (results.length > 0 && query) {
    const existingIds = new Set(results.map(r => r.node.id));
    const maxFtsScore = Math.max(...results.map(r => r.score));
    const terms = query.split(/\s+/).filter(t => t.length >= 2);
    for (const term of terms) {
      let sql = 'SELECT * FROM nodes WHERE name = ? COLLATE NOCASE';
      const params: (string | number)[] = [term];
      sql = appendNodeFilters(sql, params, kinds, languages);
      sql += ' LIMIT 20';
      const rows = this.db.prepare(sql).all(...params) as NodeRow[];
      for (const row of rows) {
        if (!existingIds.has(row.id)) {
          results.push({ node: rowToNode(row), score: maxFtsScore });
          existingIds.add(row.id);
        }
      }
    }
  }

  // Apply multi-signal scoring
  if (results.length > 0 && (text || query)) {
    const scoringQuery = text || query;
    results = results.map(r => ({
      ...r,
      score: r.score
        + kindBonus(r.node.kind)
        + scorePathRelevance(r.node.filePath, scoringQuery, this.projectNameTokens)
        + nameMatchBonus(r.node.name, scoringQuery),
    }));
    results.sort((a, b) => b.score - a.score);
    // Trim to requested limit after rescoring
    if (results.length > limit) {
      results = results.slice(0, limit);
    }
  }

  // Apply path: + name: filters AFTER scoring. Scoring already uses
  // path/name as a soft signal; the explicit filters here are a hard
  // gate. Done last so the FTS limit fetched plenty of candidates to
  // narrow from.
  if (pathFilters.length > 0) {
    const lowered = pathFilters.map((p) => p.toLowerCase());
    results = results.filter((r) => {
      const fp = r.node.filePath.toLowerCase();
      return lowered.some((p) => fp.includes(p));
    });
  }
  if (nameFilters.length > 0) {
    const lowered = nameFilters.map((n) => n.toLowerCase());
    results = results.filter((r) => {
      const nm = r.node.name.toLowerCase();
      return lowered.some((n) => nm.includes(n));
    });
  }

  return results;
}

/**
   * Match-everything path used when the user supplied only field
   * filters (`kind:function lang:typescript`) with no text. Returns
   * candidates ordered by name; the caller's filter pass narrows to
   * what was asked for.
   */
export function searchAllByFilters(this: QueryState, options: {
  kinds?: NodeKind[];
  languages?: Language[];
  limit: number;
}): SearchResult[] {
  const { kinds, languages, limit } = options;
  let sql = 'SELECT * FROM nodes';
  const params: (string | number)[] = [];
  const filters: string[] = [];
  if (kinds && kinds.length > 0) {
    filters.push(`kind IN (${kinds.map(() => '?').join(',')})`);
    params.push(...kinds);
  }
  if (languages && languages.length > 0) {
    filters.push(`language IN (${languages.map(() => '?').join(',')})`);
    params.push(...languages);
  }
  if (filters.length > 0) sql += ` WHERE ${filters.join(' AND ')}`;
  sql += ' ORDER BY name LIMIT ?';
  params.push(limit);
  const rows = this.db.prepare(sql).all(...params) as NodeRow[];
  return rows.map((row) => ({ node: rowToNode(row), score: 1 }));
}

/**
   * Fuzzy fallback: when zero FTS/LIKE hits, try an edit-distance
   * sweep over the distinct symbol-name set. Caps `maxDist` at 2 so
   * `getUssr` finds `getUser` but `process` doesn't match `prosody`.
   * Bounded edit distance keeps each comparison cheap; the per-query
   * scan is O(distinct-name-count) which is far smaller than total
   * node count on any real codebase.
   */
export function searchNodesFuzzy(this: QueryState, text: string, options: { kinds?: NodeKind[]; languages?: Language[]; limit: number }): SearchResult[] {
  const { kinds, languages, limit } = options;
  const lowered = text.toLowerCase();
  const maxDist = lowered.length <= 4 ? 1 : 2;

  // Pull the distinct name list once. The set is cached on QueryBuilder
  // by getAllNodeNames(); even on a 200k-node project the distinct
  // name set is typically O(10k) because most names repeat. The
  // candidate-cap below bounds memory regardless.
  const allNames = this.owner.getAllNodeNames();
  const candidates: Array<{ name: string; dist: number }> = [];
  for (const name of allNames) {
    const dist = boundedEditDistance(name.toLowerCase(), lowered, maxDist);
    if (dist <= maxDist) candidates.push({ name, dist });
  }
  candidates.sort((a, b) => a.dist - b.dist);

  // Cap the per-name follow-up queries. Each survivor triggers a
  // separate `SELECT * FROM nodes WHERE name = ?`; without this cap
  // a project with many similar names (`getUser1`, `getUser2`...)
  // could fan out far beyond `limit` queries before the inner-loop
  // limit kicks in.
  const FUZZY_FOLLOWUP_CAP = Math.max(limit * 2, 50);
  const cappedCandidates = candidates.slice(0, FUZZY_FOLLOWUP_CAP);

  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const c of cappedCandidates) {
    if (results.length >= limit) break;
    let sql = 'SELECT * FROM nodes WHERE name = ?';
    const params: (string | number)[] = [c.name];
    sql = appendNodeFilters(sql, params, kinds, languages);
    sql += ' LIMIT 5';
    const rows = this.db.prepare(sql).all(...params) as NodeRow[];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      // Lower the score for each edit step away from the query so
      // exact-match fallbacks (dist 0) outrank dist-2 typos.
      results.push({ node: rowToNode(row), score: 1 / (1 + c.dist) });
      if (results.length >= limit) break;
    }
  }
  return results;
}

/**
   * FTS5 search with prefix matching
   */
export function searchNodesFTS(this: QueryState, query: string, options: SearchOptions): SearchResult[] {
  const { kinds, languages, limit = 100, offset = 0 } = options;

  // Add prefix wildcard for better matching (e.g., "auth" matches "AuthService", "authenticate")
  // Escape special FTS5 characters and add prefix wildcard.
  //
  // `::` is a qualifier separator in Rust/C++/Ruby, not a token char,
  // so treat it as whitespace before the strip step. Otherwise queries
  // like `stage_apply::run` collapse to `stage_applyrun` (the colons
  // are stripped without splitting) and find nothing. See #173.
  const ftsQuery = query
    .replace(/::/g, ' ') // Rust/C++/Ruby qualifier separator
    .replace(/['"*():^]/g, '') // Remove FTS5 special chars
    .split(/\s+/)
    .filter(term => term.length > 0)
    // Strip FTS5 boolean operators to prevent query manipulation
    .filter(term => !/^(AND|OR|NOT|NEAR)$/i.test(term))
    .map(term => `"${term}"*`) // Prefix match each term
    .join(' OR ');

  if (!ftsQuery) {
    return [];
  }

  // BM25 column weights: id=0, name=20, qualified_name=5, docstring=1, signature=2
  // Heavy name weight ensures exact/prefix name matches rank above incidental
  // mentions in long docstrings or qualified names of nested symbols.
  // Fetch 5x requested limit so post-hoc rescoring (kindBonus, pathRelevance,
  // nameMatchBonus) can promote results that BM25 alone undervalues.
  const ftsLimit = Math.max(limit * 5, 100);

  let sql = [
    'SELECT nodes.*,',
    'bm25(nodes_fts, 0, 20, 5, 1, 2) AS score',
    'FROM nodes_fts',
    'JOIN nodes ON nodes_fts.id = nodes.id',
    'WHERE nodes_fts MATCH ?',
  ].join(' ');

  const params: (string | number)[] = [ftsQuery];

  sql = appendNodeFilters(sql, params, kinds, languages, 'nodes.');

  sql += ' ORDER BY score LIMIT ? OFFSET ?';
  params.push(ftsLimit, offset);

  try {
    const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
    return rows.map((row) => ({
      node: rowToNode(row),
      score: Math.abs(row.score), // bm25 returns negative scores
    }));
  } catch {
    // FTS query failed, return empty
    return [];
  }
}

/**
   * LIKE-based substring search for cases where FTS doesn't match
   * Useful for camelCase matching (e.g., "signIn" finds "signInWithGoogle")
   */
export function searchNodesLike(this: QueryState, query: string, options: SearchOptions): SearchResult[] {
  const { kinds, languages, limit = 100, offset = 0 } = options;

  let sql = `
      SELECT nodes.*,
        CASE
          WHEN name = ? THEN 1.0
          WHEN name LIKE ? THEN 0.9
          WHEN name LIKE ? THEN 0.8
          WHEN qualified_name LIKE ? THEN 0.7
          ELSE 0.5
        END as score
      FROM nodes
      WHERE (
        name LIKE ? OR
        qualified_name LIKE ? OR
        name LIKE ?
      )
    `;

  // Pattern variants for better matching
  const exactMatch = query;
  const startsWith = `${query}%`;
  const contains = `%${query}%`;

  const params: (string | number)[] = [
    exactMatch,     // Exact match score
    startsWith,     // Starts with score
    contains,       // Contains score
    contains,       // Qualified name score
    contains,       // WHERE: name contains
    contains,       // WHERE: qualified_name contains
    startsWith,     // WHERE: name starts with
  ];

  sql = appendNodeFilters(sql, params, kinds, languages);

  sql += ' ORDER BY score DESC, length(name) ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];

  return rows.map((row) => ({
    node: rowToNode(row),
    score: row.score,
  }));
}

/**
   * Find nodes by exact name match
   *
   * Used for hybrid search - looks up symbols by exact name or case-insensitive match.
   * Returns high-confidence matches for known symbol names extracted from query.
   *
   * @param names - Array of symbol names to look up
   * @param options - Search options (kinds, languages, limit)
   * @returns SearchResult array with exact matches scored at 1.0
   */
export function findNodesByExactName(this: QueryState, names: string[], options: SearchOptions = {}): SearchResult[] {
  if (names.length === 0) return [];

  const { kinds, languages, limit = 50 } = options;

  // Two-pass approach to handle common names (e.g., "run" has 40+ matches):
  // Pass 1: Find which files contain distinctive (rare) symbols from the query.
  // Pass 2: Query each name, boosting results that co-locate with distinctive symbols.

  // Pass 1: Find files containing each queried name, identify distinctive names
  const nameToFiles = new Map<string, Set<string>>();
  for (const name of names) {
    let sql = 'SELECT DISTINCT file_path FROM nodes WHERE name COLLATE NOCASE = ?';
    const params: (string | number)[] = [name];
    sql = appendNodeFilters(sql, params, kinds);
    sql += ' LIMIT 100';
    const rows = this.db.prepare(sql).all(...params) as { file_path: string }[];
    nameToFiles.set(name.toLowerCase(), new Set(rows.map(r => r.file_path)));
  }

  // Distinctive names are those with fewer than 10 file matches (e.g., "scrapeLoop" = 1 file)
  const distinctiveFiles = new Set<string>();
  for (const [, files] of nameToFiles) {
    if (files.size > 0 && files.size < 10) {
      for (const f of files) distinctiveFiles.add(f);
    }
  }

  // Pass 2: Query each name with per-name limit, scoring by co-location
  const perNameLimit = Math.max(8, Math.ceil(limit / names.length));
  const allResults: SearchResult[] = [];
  const seenIds = new Set<string>();

  for (const name of names) {
    let sql = `
        SELECT nodes.*, 1.0 as score
        FROM nodes
        WHERE name COLLATE NOCASE = ?
      `;
    const params: (string | number)[] = [name];

    sql = appendNodeFilters(sql, params, kinds, languages);

    // Fetch enough to find co-located results among common names
    sql += ' LIMIT ?';
    params.push(Math.max(perNameLimit * 3, 50));

    const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
    const nameResults: SearchResult[] = [];
    for (const row of rows) {
      const node = rowToNode(row);
      if (seenIds.has(node.id)) continue;
      // Boost results in files that also contain distinctive symbols
      const coLocationBoost = distinctiveFiles.has(node.filePath) ? 20 : 0;
      nameResults.push({ node, score: row.score + coLocationBoost });
    }

    // Sort by score (co-located first), take per-name limit
    nameResults.sort((a, b) => b.score - a.score);
    for (const r of nameResults.slice(0, perNameLimit)) {
      seenIds.add(r.node.id);
      allResults.push(r);
    }
  }

  // Sort all results by score so co-located results bubble up
  allResults.sort((a, b) => b.score - a.score);
  return allResults.slice(0, limit);
}

/**
   * Find nodes whose name contains a substring (LIKE-based).
   * Useful for CamelCase-part matching where FTS fails because
   * e.g. "TransportSearchAction" is one FTS token, not matchable by "Search"*.
   *
   * Results are ordered by name length (shorter = more likely to be the core type).
   */
export function findNodesByNameSubstring(this: QueryState, substring: string, options: SearchOptions & { excludePrefix?: boolean } = {}): SearchResult[] {
  const { kinds, languages, limit = 30, excludePrefix } = options;

  let sql = `
      SELECT nodes.*, 1.0 as score
      FROM nodes
      WHERE name LIKE ?
    `;
  const params: (string | number)[] = [`%${substring}%`];

  // Exclude prefix matches (handled by FTS-based prefix search in Step 2b)
  if (excludePrefix) {
    sql += ` AND name NOT LIKE ?`;
    params.push(`${substring}%`);
  }

  sql = appendNodeFilters(sql, params, kinds, languages);

  sql += ' ORDER BY length(name) ASC LIMIT ?';
  params.push(limit);

  const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
  return rows.map((row) => ({
    node: rowToNode(row),
    score: row.score,
  }));
}
