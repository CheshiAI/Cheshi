import { isGeneratedFile } from '../extraction/generated-detection';
import type CodeGraph from '../index';
import type { Node } from '../types';
import type { ToolHandlerState } from './tool-handler-state';
import {
  lastQualifierPart,
  RUST_PATH_PREFIXES
} from './tool-symbol-utils';

// =========================================================================
// Symbol resolution helpers
// =========================================================================

/**
 * Find a symbol by name, handling disambiguation when multiple matches exist.
 * Returns the best match and a note about alternatives if any.
 */
/**
 * Check if a node matches a symbol query.
 *
 * Accepts simple names (`run`) and three flavors of qualifier:
 *   - dotted     `Session.request`         (TS/JS/Python)
 *   - colon-pair `stage_apply::run`        (Rust, C++, Ruby)
 *   - slash      `configurator/stage_apply` (path-ish)
 *
 * Multi-level qualifiers compose: `crate::configurator::stage_apply::run`
 * works. Rust path prefixes (`crate`, `super`, `self`) are stripped so
 * the canonical `crate::module::symbol` form resolves.
 *
 * Resolution order, last part must always equal `node.name`:
 *   1. Suffix-match against `qualifiedName` (handles class-scoped methods
 *      where the extractor builds the qualified name from the AST stack)
 *   2. File-path containment (handles file-derived modules in Rust/
 *      Python — `stage_apply::run` matches a `run` in `stage_apply.rs`)
 */
export function matchesSymbol(this: ToolHandlerState, node: Node, symbol: string): boolean {
  // Simple name match
  if (node.name === symbol) return true;
  // File basename match (e.g., "product-card" matches "product-card.liquid")
  if (node.kind === 'file' && node.name.replace(/\.[^.]+$/, '') === symbol) return true;

  // Qualified-name lookups: split on any supported separator. `\w` keeps
  // identifier chars (incl. `_`) intact; everything else is treated as
  // a separator we tolerate.
  if (!/[.\/]|::/.test(symbol)) return false;
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  if (parts.length < 2) return false;

  const lastPart = parts[parts.length - 1]!;
  if (node.name !== lastPart) return false;

  // Stage 1: qualified-name suffix match. The extractor joins the
  // semantic hierarchy with `::`, so `Session.request` and
  // `Session::request` both become `Session::request` here.
  const colonSuffix = parts.join('::');
  if (node.qualifiedName.includes(colonSuffix)) return true;

  // Stage 2: file-path containment. Rust modules and Python packages
  // are not in `qualifiedName` — they're encoded in the file path. So
  // `stage_apply::run` matches a `run` in any file whose path
  // contains a `stage_apply` segment (with or without an extension).
  //
  // Filter out Rust path prefixes that have no file-system equivalent.
  const containerHints = parts.slice(0, -1).filter((p) => !RUST_PATH_PREFIXES.has(p));
  if (containerHints.length === 0) return false;

  const segments = node.filePath.split('/').filter((s) => s.length > 0);
  return containerHints.every((hint) =>
    segments.some((seg) => seg === hint || seg.replace(/\.[^.]+$/, '') === hint)
  );
}

/**
   * Find ALL definitions matching a name, ranked, so codegraph_node can return
   * every overload instead of guessing one (the wrong guess → a Read). Keepers
   * rank before generated stubs (.pb.go etc.); stable within a group preserves
   * FTS order. Returns [] when nothing matches; a qualified lookup that finds no
   * exact match returns [] rather than a misleading fuzzy file hit (#173); a
   * bare name with no exact match falls back to the single top fuzzy result.
   */
export function findSymbolMatches(this: ToolHandlerState, cg: CodeGraph, symbol: string): Node[] {
  const isQualified = /[.\/]|::/.test(symbol);

  // For a bare name, enumerate EVERY exact-name definition via the direct index
  // (not FTS, which caps + ranks): tokio's `poll` has 50+ defs and the one the
  // caller wants (`Harness::poll` at harness.rs:153) ranks below any search cut,
  // so it could be neither rendered nor pinned by the file/line disambiguator —
  // and the agent Read it. With the full set, the multi-overload render + the
  // file/line filter can both reach it.
  if (!isQualified) {
    const exact = cg.getNodesByName(symbol);
    if (exact.length > 0) {
      return [...exact].sort((a, b) => (isGeneratedFile(a.filePath) ? 1 : 0) - (isGeneratedFile(b.filePath) ? 1 : 0));
    }
    // No exact match — use the single top fuzzy result (e.g. a file basename).
    const fuzzy = cg.searchNodes(symbol, { limit: 10 });
    return fuzzy[0] ? [fuzzy[0].node] : [];
  }

  // Qualified lookup (`Session.request`, `stage_apply::run`): FTS + matchesSymbol.
  const limit = 50;
  let results = cg.searchNodes(symbol, { limit });

  // FTS strips colons, so `stage_apply::run` searches the literal
  // `stage_applyrun` and finds nothing. Re-search by the bare last part and
  // let `matchesSymbol` filter by qualifier.
  if (isQualified && results.length === 0) {
    const tail = lastQualifierPart(symbol);
    if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit });
  }

  if (results.length === 0) return [];

  const exactMatches = results.filter((r) => this.matchesSymbol(r.node, symbol));
  if (exactMatches.length === 0) {
    // No exact match — a qualified lookup must not fall back to a fuzzy file
    // hit (#173); a bare name may use the single top fuzzy result.
    return isQualified ? [] : results[0] ? [results[0].node] : [];
  }

  // Down-rank generated files (.pb.go, .pulsar.go, _grpc.pb.go, …) so a flow
  // query prefers the keeper implementation over the protobuf-generated stub.
  return [...exactMatches]
    .sort((a, b) => (isGeneratedFile(a.node.filePath) ? 1 : 0) - (isGeneratedFile(b.node.filePath) ? 1 : 0))
    .map((r) => r.node);
}

/**
   * Find ALL symbols matching a name. Used by callers/callees/impact to aggregate
   * results across all matching symbols (e.g., multiple classes with an `execute` method).
   */
export function findAllSymbols(this: ToolHandlerState, cg: CodeGraph, symbol: string): { nodes: Node[]; note: string } {
  // Nix option paths: the declaration is stored as `options.<path>` and
  // config writes carry longer/quoted tails (`<path>."git/config".text`),
  // so a dotted option token (`xdg.configFile`, `launchd.user.agents`) has
  // no exact-name node and would degrade to bare-tail FTS soup — burying
  // the declaration hub the nix-option-path edges hang off. Resolve the
  // convention directly: declaration first, then the exact write, then a
  // capped prefix scan of write sites. Three index hits; non-nix graphs
  // fall straight through.
  if (/^[a-z][\w'-]*(?:\.[\w'-]+)+$/.test(symbol)) {
    const optionHits = [
      ...cg.getNodesByName(`options.${symbol}`),
      ...cg.getNodesByName(symbol),
      ...cg.getNodesByNamePrefix(`${symbol}.`, 12),
    ].filter((n) => n.language === 'nix');
    if (optionHits.length > 0) {
      const seen = new Set<string>();
      const nodes = optionHits.filter((n) => !seen.has(n.id) && !!seen.add(n.id)).slice(0, 10);
      return { nodes, note: '' };
    }
  }
  let results = cg.searchNodes(symbol, { limit: 50 });

  // Mirror the fallback in `findSymbol` for qualified queries — FTS
  // strips colons, so a module-qualified lookup needs a second pass
  // by the bare last part.
  if (results.length === 0 && /[.\/]|::/.test(symbol)) {
    const tail = lastQualifierPart(symbol);
    if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit: 50 });
  }

  if (results.length === 0) {
    return { nodes: [], note: '' };
  }

  const exactMatches = results.filter(r => this.matchesSymbol(r.node, symbol));

  if (exactMatches.length <= 1) {
    const node = exactMatches[0]?.node ?? results[0]!.node;
    return { nodes: [node], note: '' };
  }

  // Same generated-file down-rank as findSymbol — keeps callers/callees
  // /impact aggregation aligned (a query against "Send" returns the
  // hand-written implementations before the protobuf scaffold).
  const ranked = [...exactMatches].sort((a, b) => {
    const aGen = isGeneratedFile(a.node.filePath) ? 1 : 0;
    const bGen = isGeneratedFile(b.node.filePath) ? 1 : 0;
    return aGen - bGen;
  });

  const locations = ranked.map(r =>
    `${r.node.kind} at ${r.node.filePath}:${r.node.startLine}`
  );
  const note = `\n\n> **Note:** Aggregated results across ${ranked.length} symbols named "${symbol}": ${locations.join(', ')}`;
  return { nodes: ranked.map(r => r.node), note };
}
