import { Language, Node } from '../types';
import { stripJsComments } from './import-bindings';
import { resolveImportPath } from './import-paths';
import { ReExport, ResolutionContext } from './types';

export const exportedSymbolMemos = new WeakMap<ResolutionContext, Map<string, Node | undefined>>();

/**
 * Per-file index of exported symbols, replacing repeated linear `.find`s over
 * `getNodesInFile` arrays (a barrel-heavy repo scans its biggest files once
 * per referencing symbol otherwise). First-wins insertion preserves exactly
 * the array-order semantics of the `.find` calls it replaces.
 */
interface FileExportIndex {
  byName: Map<string, Node>;
  defaultComponent: Node | undefined;
  defaultFnClass: Node | undefined;
}

export const fileExportIndexes = new WeakMap<ResolutionContext, Map<string, FileExportIndex>>();

function getFileExportIndex(filePath: string, context: ResolutionContext): FileExportIndex {
  let perFile = fileExportIndexes.get(context);
  if (!perFile) {
    perFile = new Map();
    fileExportIndexes.set(context, perFile);
  }
  let idx = perFile.get(filePath);
  if (!idx) {
    idx = { byName: new Map(), defaultComponent: undefined, defaultFnClass: undefined };
    for (const n of context.getNodesInFile(filePath)) {
      if (!n.isExported) continue;
      if (!idx.byName.has(n.name)) idx.byName.set(n.name, n);
      if (idx.defaultComponent === undefined && n.kind === 'component') idx.defaultComponent = n;
      if (idx.defaultFnClass === undefined && (n.kind === 'function' || n.kind === 'class')) idx.defaultFnClass = n;
    }
    perFile.set(filePath, idx);
  }
  return idx;
}

/**
 * Extract JS/TS re-export declarations from `content`.
 *
 * Recognised forms:
 *   export { foo } from './a';
 *   export { foo as bar } from './a';
 *   export * from './a';
 *   export * as ns from './a';   (treated as wildcard for chasing)
 *   export { default as Foo } from './a';
 *
 * The walker intentionally stays regex-based — the import-resolver
 * elsewhere in this file already chooses regex over a fresh
 * tree-sitter pass, and this function shares that trade-off. Errors
 * fall through silently; resolution simply skips the broken file.
 */
export function extractReExports(content: string, language: Language): ReExport[] {
  if (
    language !== 'typescript' &&
    language !== 'javascript' &&
    language !== 'tsx' &&
    language !== 'jsx' &&
    language !== 'arkts'
  ) {
    return [];
  }
  const out: ReExport[] = [];

  // Pre-strip block comments + line comments so a commented-out
  // `// export { x } from '...'` doesn't produce a phantom edge.
  // (Template literals are still a possible source of false positives;
  // a project that builds export statements as runtime strings is
  // out of scope.)
  const cleaned = stripJsComments(content);

  // Wildcard: `export * from '...'` or `export * as ns from '...'`
  const wildcardRe = /export\s*\*(?:\s+as\s+\w+)?\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = wildcardRe.exec(cleaned)) !== null) {
    out.push({ kind: 'wildcard', source: m[1]! });
  }

  // Named: `export { a, b as c } from '...'`
  const namedRe = /export\s*\{([^}]+)\x7D\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = namedRe.exec(cleaned)) !== null) {
    const inner = m[1]!;
    const source = m[2]!;
    for (const raw of inner.split(',')) {
      const item = raw.trim();
      if (!item) continue;
      const aliasMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
      if (aliasMatch) {
        out.push({
          kind: 'named',
          exportedName: aliasMatch[2]!,
          originalName: aliasMatch[1]!,
          source,
        });
      } else if (/^\w+$/.test(item)) {
        out.push({
          kind: 'named',
          exportedName: item,
          originalName: item,
          source,
        });
      }
    }
  }

  return out;
}

/** Recursive depth cap for re-export chain following. Real codebases
 *  rarely chain barrels more than 2–3 deep; 8 is a generous safety
 *  net that still bounds worst-case work. */
const REEXPORT_MAX_DEPTH = 8;

/**
 * Find an exported symbol in `filePath`, following `export { x } from
 * './other'` and `export * from './other'` chains until the original
 * declaration is reached. Cycle-safe via the `visited` set.
 *
 * Without this, every barrel-style import (`import { Foo } from
 * './index'` where `index.ts` only re-exports) used to resolve to
 * nothing — the existing code only looked for declarations IN the
 * resolved file, not declarations the file forwarded.
 */
export function findExportedSymbol(
  filePath: string,
  want: {
    isDefault: boolean;
    isNamespace: boolean;
    exportedName: string;
    memberName: string | null;
  },
  language: Language,
  context: ResolutionContext,
  visited: Set<string>,
  depth = 0
): Node | undefined {
  // Memoize fresh (top-level) lookups only: recursive re-export steps carry a
  // populated `visited` set, whose contents change the reachable answer.
  // Every ref to the same imported symbol repeats this exact walk, so the
  // top-level memo removes the re-export chase + per-file linear scans from
  // all but the first occurrence.
  if (depth === 0 && visited.size === 0) {
    let memo = exportedSymbolMemos.get(context);
    if (!memo) {
      memo = new Map();
      exportedSymbolMemos.set(context, memo);
    }
    const key = `${filePath}\0${want.isDefault ? 1 : 0}${want.isNamespace ? 1 : 0}\0${want.exportedName}\0${want.memberName ?? ''}\0${language}`;
    if (memo.has(key)) return memo.get(key);
    const result = findExportedSymbolWalk(filePath, want, language, context, visited, depth);
    memo.set(key, result);
    return result;
  }
  return findExportedSymbolWalk(filePath, want, language, context, visited, depth);
}

function findExportedSymbolWalk(
  filePath: string,
  want: {
    isDefault: boolean;
    isNamespace: boolean;
    exportedName: string;
    memberName: string | null;
  },
  language: Language,
  context: ResolutionContext,
  visited: Set<string>,
  depth: number
): Node | undefined {
  if (depth > REEXPORT_MAX_DEPTH) return undefined;
  if (visited.has(filePath)) return undefined;
  visited.add(filePath);

  const exportIndex = getFileExportIndex(filePath, context);

  // 1. Direct hit: the symbol is declared in this file.
  if (want.isDefault) {
    // Svelte/Vue single-file components ARE the module's default export,
    // but are extracted as kind 'component' (not function/class). Prefer
    // the component node; fall back to an exported function/class for the
    // `.ts`/`.tsx` `export default fn`/`class` case. Without the component
    // branch, an `export { default as X } from './X.svelte'` barrel never
    // resolves and the component shows a false 0 callers (#629).
    const direct = exportIndex.defaultComponent ?? exportIndex.defaultFnClass;
    if (direct) return direct;
  } else if (want.isNamespace && want.memberName) {
    const direct = exportIndex.byName.get(want.memberName);
    if (direct) return direct;
  } else {
    const direct = exportIndex.byName.get(want.exportedName);
    if (direct) return direct;
  }

  // 2. Re-export hit: the file forwards the symbol to another module.
  const reExports = context.getReExports?.(filePath, language) ?? [];
  if (reExports.length === 0) return undefined;

  // Look for explicit `export { want } from './other'` (with optional rename).
  const targetName = want.isDefault ? 'default' : want.exportedName;
  for (const rex of reExports) {
    if (rex.kind === 'named' && rex.exportedName === targetName) {
      const next = resolveImportPath(rex.source, filePath, language, context);
      if (!next) continue;
      // After rename: `export { foo as bar } from './x'` — to chase
      // `bar`, we look for `foo` in `./x`.
      const chained = findExportedSymbol(
        next,
        {
          isDefault: rex.originalName === 'default',
          isNamespace: false,
          exportedName: rex.originalName,
          memberName: null,
        },
        language,
        context,
        visited,
        depth + 1
      );
      if (chained) return chained;
    }
  }

  // 3. Wildcard re-export: `export * from './other'` — try every
  //    forwarding source. This is the barrel-of-barrels case.
  for (const rex of reExports) {
    if (rex.kind === 'wildcard') {
      const next = resolveImportPath(rex.source, filePath, language, context);
      if (!next) continue;
      const chained = findExportedSymbol(next, want, language, context, visited, depth + 1);
      if (chained) return chained;
    }
  }

  return undefined;
}
