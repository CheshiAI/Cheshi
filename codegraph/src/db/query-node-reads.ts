import {
  Language,
  Node,
  NodeKind
} from '../types';
import {
  isLowValueFile,
  type NodeRow,
  rowToNode,
  SQLITE_PARAM_CHUNK_SIZE
} from './query-rows';
import type { QueryState } from './query-state';

/**
   * Get a node by ID
   */
export function getNodeById(this: QueryState, id: string): Node | null {
  // Check cache first
  if (this.nodeCache.has(id)) {
    const cached = this.nodeCache.get(id)!;
    // Move to end to implement LRU (delete and re-add)
    this.nodeCache.delete(id);
    this.nodeCache.set(id, cached);
    return cached;
  }

  if (!this.stmts.getNodeById) {
    this.stmts.getNodeById = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
  }
  const row = this.stmts.getNodeById.get(id) as NodeRow | undefined;
  if (!row) {
    return null;
  }

  const node = rowToNode(row);
  this.cacheNode(node);
  return node;
}

/**
   * Batch lookup: fetch many nodes by ID in a single SQL round-trip.
   *
   * Replaces the N+1 pattern in graph traversal where every edge would
   * trigger its own `getNodeById` call. For a function with 50 callers
   * this collapses 50 point reads into one IN-list query (~10-50x
   * faster end-to-end).
   *
   * Returns a Map keyed by id so callers can preserve their own ordering
   * (typically the order edges were returned from the graph). Missing IDs
   * are simply absent from the map.
   *
   * Cache-aware: ids already in the LRU cache are served from memory and
   * the SQL query only touches the misses.
   */
export function getNodesByIds(this: QueryState, ids: readonly string[]): Map<string, Node> {
  const out = new Map<string, Node>();
  if (ids.length === 0) return out;

  // Serve cache hits first; build the miss list for SQL.
  const misses: string[] = [];
  for (const id of ids) {
    const cached = this.nodeCache.get(id);
    if (cached !== undefined) {
      // LRU touch
      this.nodeCache.delete(id);
      this.nodeCache.set(id, cached);
      out.set(id, cached);
    } else {
      misses.push(id);
    }
  }
  if (misses.length === 0) return out;

  // Chunk under SQLite's build-dependent parameter limit. Staying at 500
  // also keeps the query plan simple on Bun's built-in SQLite backend.
  for (let i = 0; i < misses.length; i += SQLITE_PARAM_CHUNK_SIZE) {
    const chunk = misses.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`)
      .all(...chunk) as NodeRow[];
    for (const row of rows) {
      const node = rowToNode(row);
      out.set(node.id, node);
      this.cacheNode(node);
    }
  }
  return out;
}

export function getExistingNodeIds(this: QueryState, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (ids.length === 0) return out;

  const uniqueIds = [...new Set(ids)];
  for (let i = 0; i < uniqueIds.length; i += SQLITE_PARAM_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT id FROM nodes WHERE id IN (${placeholders})`)
      .all(...chunk) as { id: string }[];
    for (const row of rows) {
      out.add(row.id);
    }
  }

  return out;
}

/**
   * Get all nodes in a file
   */
export function getNodesByFile(this: QueryState, filePath: string): Node[] {
  if (!this.stmts.getNodesByFile) {
    this.stmts.getNodesByFile = this.db.prepare(
      'SELECT * FROM nodes WHERE file_path = ? ORDER BY start_line'
    );
  }
  const rows = this.stmts.getNodesByFile.all(filePath) as NodeRow[];
  return rows.map(rowToNode);
}

/**
   * Find the file that holds the densest concentration of the project's
   * internal call graph — the "core" file. Used by context-builder to
   * boost ranking of symbols in that file's directory (so e.g. sinatra
   * queries surface `lib/sinatra/base.rb`'s `route!` instead of
   * `sinatra-contrib/lib/sinatra/multi_route.rb`'s `route` extension).
   *
   * Returns null if no file has a meaningful concentration (e.g. spread
   * evenly across many files, or empty index).
   *
   * "Internal" = source and target are in the same file. Cross-file
   * edges aren't useful here — they don't tell us which file is the
   * functional center.
   *
   * Excludes test/spec files from candidacy via path-pattern. The agent's
   * typical question is "how does X work", not "how is X tested", so
   * boosting a test file's directory would be a misfire.
   */
export function getDominantFile(this: QueryState): { filePath: string; edgeCount: number; nextEdgeCount: number } | null {
  if (!this.stmts.getDominantFile) {
    // Pull top 20 candidates; we then filter out test/generated files
    // in code (regex-grade matching that SQL LIKE can't express). The
    // generated-file filter is critical — without it, etcd's
    // `api/etcdserverpb/rpc.pb.go` (1916 in-file edges, generated
    // protobuf stub) outranks the real `server/etcdserver/server.go`
    // (470 edges) by 4×, and the boost would push the agent toward
    // generated code.
    this.stmts.getDominantFile = this.db.prepare(`
        SELECT n.file_path AS file_path, COUNT(*) AS edge_count
        FROM edges e
        JOIN nodes n ON e.source = n.id
        JOIN nodes m ON e.target = m.id
        WHERE n.file_path = m.file_path
        GROUP BY n.file_path
        ORDER BY edge_count DESC
        LIMIT 20
      `);
  }
  const rows = this.stmts.getDominantFile.all() as Array<{ file_path: string; edge_count: number }>;
  const filtered = rows.filter(r => !isLowValueFile(r.file_path));
  if (filtered.length === 0 || filtered[0]!.edge_count < 20) return null;
  return {
    filePath: filtered[0]!.file_path,
    edgeCount: filtered[0]!.edge_count,
    nextEdgeCount: filtered[1]?.edge_count ?? 0,
  };
}

/**
   * Find the file that holds the densest concentration of the project's
   * `route` nodes (framework-emitted: Express/Gin/Flask/Rails/Drupal/etc.).
   * Used by handleContext on small repos to inline the project's routing
   * config when the agent's query is about request flow — eliminating the
   * "Glob + Read routes.rb" pattern that beats codegraph on tiny realworld
   * template repos.
   *
   * Excludes test/generated files from candidacy. Returns null if there
   * are fewer than 3 non-test routes total, or if no file holds at least
   * 30% of them (diffuse routing → no single answer file).
   */
export function getTopRouteFile(this: QueryState): { filePath: string; routeCount: number; totalRoutes: number } | null {
  if (!this.stmts.getTopRouteFile) {
    this.stmts.getTopRouteFile = this.db.prepare(`
        SELECT file_path, COUNT(*) AS cnt
        FROM nodes
        WHERE kind = 'route'
        GROUP BY file_path
        ORDER BY cnt DESC
        LIMIT 20
      `);
  }
  const rows = this.stmts.getTopRouteFile.all() as Array<{ file_path: string; cnt: number }>;
  const filtered = rows.filter(r => !isLowValueFile(r.file_path));
  if (filtered.length === 0) return null;
  const totalRoutes = filtered.reduce((sum, r) => sum + r.cnt, 0);
  const top = filtered[0]!;
  if (totalRoutes < 3 || top.cnt < 3) return null;
  if (top.cnt / totalRoutes < 0.30) return null;
  return { filePath: top.file_path, routeCount: top.cnt, totalRoutes };
}

/**
   * Build a URL → handler manifest from the index. Each route node's
   * `references` edge points at the function/method that handles the
   * request. We join them in one pass; the agent gets the canonical
   * routing answer ("POST /users/login → AuthController#login") without
   * having to parse the framework's route DSL itself.
   *
   * Also returns the file with the most handler endpoints — used as the
   * "top handler file" to inline source for, so the agent has both the
   * mapping AND the handler implementations.
   */
export function getRoutingManifest(this: QueryState, limit: number = 40): {
  entries: Array<{ url: string; handler: string; handlerFile: string; handlerLine: number; handlerKind: string }>;
  topHandlerFile: string | null;
  topHandlerFileCount: number;
  totalRoutes: number;
} | null {
  if (!this.stmts.getRoutingManifest) {
    // Edge kind varies across framework resolvers: Spring/Rails/
    // Laravel/Drupal emit `references`, Express emits `calls`. Accept
    // both — the semantic is the same (route → its handler).
    this.stmts.getRoutingManifest = this.db.prepare(`
        SELECT
          r.name AS url,
          h.name AS handler,
          h.file_path AS handler_file,
          h.start_line AS handler_line,
          h.kind AS handler_kind
        FROM nodes r
        JOIN edges e ON e.source = r.id
        JOIN nodes h ON e.target = h.id
        WHERE r.kind = 'route'
          AND e.kind IN ('references', 'calls')
          AND h.kind IN ('function', 'method', 'class')
        ORDER BY r.file_path, r.start_line
        LIMIT ?
      `);
  }
  const rows = this.stmts.getRoutingManifest.all(limit) as Array<{
    url: string; handler: string; handler_file: string; handler_line: number; handler_kind: string;
  }>;
  // Drop test/generated handlers — same hygiene as elsewhere.
  const filtered = rows.filter(r => !isLowValueFile(r.handler_file));
  if (filtered.length < 3) return null;
  // Identify the file holding the most handlers (the "primary handler file").
  const fileCounts = new Map<string, number>();
  for (const r of filtered) {
    fileCounts.set(r.handler_file, (fileCounts.get(r.handler_file) ?? 0) + 1);
  }
  let topHandlerFile: string | null = null;
  let topHandlerFileCount = 0;
  for (const [file, count] of fileCounts) {
    if (count > topHandlerFileCount) {
      topHandlerFile = file;
      topHandlerFileCount = count;
    }
  }
  return {
    entries: filtered.map(r => ({
      url: r.url,
      handler: r.handler,
      handlerFile: r.handler_file,
      handlerLine: r.handler_line,
      handlerKind: r.handler_kind,
    })),
    topHandlerFile,
    topHandlerFileCount,
    totalRoutes: filtered.length,
  };
}

/**
   * Get all nodes of a specific kind
   */
export function getNodesByKind(this: QueryState, kind: NodeKind): Node[] {
  if (!this.stmts.getNodesByKind) {
    this.stmts.getNodesByKind = this.db.prepare('SELECT * FROM nodes WHERE kind = ?');
  }
  const rows = this.stmts.getNodesByKind.all(kind) as NodeRow[];
  return rows.map(rowToNode);
}

/**
   * Stream every node of a kind one at a time (lazy) instead of materializing
   * them all like {@link getNodesByKind}. For unbounded kinds (`function`,
   * `method`) on a symbol-dense project the full array is gigabytes; the
   * dynamic-edge synthesizers only scan-and-filter, so they iterate to keep
   * memory O(1) in the node count rather than O(nodes) (#610).
   */
export function* iterateNodesByKind(this: QueryState, kind: NodeKind): IterableIterator<Node> {
  // Fresh statement per call (not a cached one): an iterator holds an open
  // cursor, so a shared statement would conflict across overlapping scans.
  const stmt = this.db.prepare('SELECT * FROM nodes WHERE kind = ?');
  for (const row of stmt.iterate(kind)) {
    yield rowToNode(row as NodeRow);
  }
}

/**
   * Get all nodes in the database
   */
export function getAllNodes(this: QueryState): Node[] {
  const rows = this.db.prepare('SELECT * FROM nodes').all() as NodeRow[];
  return rows.map(rowToNode);
}

/**
   * Stream nodes of one language whose `decorators` JSON array contains
   * `decorator`. The LIKE on the JSON text is a cheap index-free pre-filter
   * (a decorator name can appear as a substring of another), so callers must
   * still exact-check `node.decorators.includes(decorator)`. Exists so the
   * kotlin expect/actual synthesizer never materializes the whole node table
   * the way `getAllNodes().filter(...)` did — that array alone OOM'd Node's
   * default heap on a 2M-node graph (#1212).
   */
export function* iterateNodesByLanguageWithDecorator(this: QueryState, language: Language, decorator: string): IterableIterator<Node> {
  // Fresh statement per call — an iterator holds an open cursor (see
  // iterateNodesByKind).
  const stmt = this.db.prepare(
    "SELECT * FROM nodes WHERE language = ? AND decorators LIKE '%' || ? || '%'"
  );
  for (const row of stmt.iterate(language, `"${decorator}"`)) {
    yield rowToNode(row as NodeRow);
  }
}

/**
   * Distinct languages present in the files table. One indexed aggregate —
   * lets the dynamic-edge synthesizers skip passes for languages the project
   * doesn't contain at all (a Kotlin pass has no work on a pure-C repo), so
   * their cost is zero rather than a full-graph scan that finds nothing (#1212).
   */
export function getDistinctFileLanguages(this: QueryState): Set<string> {
  const rows = this.db.prepare('SELECT DISTINCT language FROM files').all() as Array<{ language: string }>;
  return new Set(rows.map((r) => r.language));
}

/**
   * Get nodes by exact name match (uses idx_nodes_name index)
   */
export function getNodesByName(this: QueryState, name: string): Node[] {
  if (!this.stmts.getNodesByName) {
    this.stmts.getNodesByName = this.db.prepare('SELECT * FROM nodes WHERE name = ?');
  }
  const rows = this.stmts.getNodesByName.all(name) as NodeRow[];
  return rows.map(rowToNode);
}

/**
   * Nodes whose name starts with `prefix`, by index range scan (a LIKE would
   * skip idx_nodes_name under SQLite's default case-insensitive LIKE).
   */
export function getNodesByNamePrefix(this: QueryState, prefix: string, limit = 20): Node[] {
  if (!this.stmts.getNodesByNamePrefix) {
    this.stmts.getNodesByNamePrefix = this.db.prepare(
      'SELECT * FROM nodes WHERE name >= ? AND name < ? ORDER BY name LIMIT ?'
    );
  }
  const rows = this.stmts.getNodesByNamePrefix.all(prefix, prefix + '￿', limit) as NodeRow[];
  return rows.map(rowToNode);
}

/**
   * Get nodes by exact qualified name match (uses idx_nodes_qualified_name index)
   */
export function getNodesByQualifiedNameExact(this: QueryState, qualifiedName: string): Node[] {
  if (!this.stmts.getNodesByQualifiedNameExact) {
    this.stmts.getNodesByQualifiedNameExact = this.db.prepare(
      'SELECT * FROM nodes WHERE qualified_name = ?'
    );
  }
  const rows = this.stmts.getNodesByQualifiedNameExact.all(qualifiedName) as NodeRow[];
  return rows.map(rowToNode);
}

/**
   * Get nodes by lowercase name match (uses idx_nodes_lower_name expression index)
   */
export function getNodesByLowerName(this: QueryState, lowerName: string): Node[] {
  if (!this.stmts.getNodesByLowerName) {
    this.stmts.getNodesByLowerName = this.db.prepare(
      'SELECT * FROM nodes WHERE lower(name) = ?'
    );
  }
  const rows = this.stmts.getNodesByLowerName.all(lowerName) as NodeRow[];
  return rows.map(rowToNode);
}
