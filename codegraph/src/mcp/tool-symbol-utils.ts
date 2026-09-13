import type { NodeKind } from '../types';

/**
 * Rust path roots that have no file-system equivalent — `crate` is the
 * current crate, `super` is the parent module, `self` is the current
 * module. Used by `matchesSymbol` to strip these before file-path
 * matching so `crate::configurator::stage_apply::run` resolves the
 * same as `configurator::stage_apply::run`.
 */
export const RUST_PATH_PREFIXES = new Set(['crate', 'super', 'self']);

/**
 * Node kinds that contain other symbols. For these, `codegraph_node` with
 * `includeCode=true` returns a structural outline (member names + signatures
 * + line numbers) instead of the full body, which for a large class is a
 * multi-thousand-character wall of source that bloats the agent's context.
 */
export const CONTAINER_NODE_KINDS = new Set<NodeKind>([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'namespace', 'module',
]);

/** Last `::` / `.` / `/`-separated segment of a qualified symbol. */
export function lastQualifierPart(symbol: string): string {
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? symbol;
}

/**
 * Normalize Erlang-native symbol spellings in an explore query into the shapes
 * the rest of the pipeline already understands. Agents working Erlang code
 * name symbols the way the language spells them — `mod:fn/3`, `init/2` — and
 * those tokens previously died in both consumers: the flow-builder's token
 * filter rejects `:` and `/arity` outright, and the search-side field parser
 * eats `mod:fn` as an unknown `field:value`. Measured on cowboy: the agent
 * named `cowboy_stream_h:request_process/3` in two queries, got no body back
 * either time, and fell back to Read.
 *
 *   - `fn/3` → `fn` (arity tail after an identifier; a path segment like
 *     `src/2fa` doesn't match because the tail must be all digits)
 *   - `mod:fn` → `mod.fn` (exactly one colon between identifiers, so it rides
 *     the existing Class.method qualified handling; `::`, URLs, drive letters,
 *     and times don't match, and the query language's own field prefixes —
 *     kind:/lang:/language:/path:/name: — are left alone)
 *
 * Safe cross-language: Lua's `t:m` spelling maps to the same `t.m` its
 * qualified names use, and no other supported spelling contains a bare
 * single-colon identifier pair.
 */
export function normalizeQuerySpelling(query: string): string {
  return query
    .replace(/\b([A-Za-z_][\w@]*)\/(\d{1,3})(?=$|[\s,()[\]/])/g, '$1')
    .replace(
      /(^|[\s,()[\]])(?!(?:kind|lang|language|path|name):)([a-z_][\w@]*):([A-Za-z_][\w@]*)(?=$|[\s,()[\]])/g,
      '$1$2.$3'
    );
}
