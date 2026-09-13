import { Language, Node } from '../types';
import { resolveCppIncludePath } from './import-cpp-paths';
import { applyAliases } from './path-aliases';
import { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { resolveWorkspaceImport } from './workspace-packages';
import * as path from 'path';

/**
 * Extension resolution order by language
 */
export const EXTENSION_RESOLUTION: Record<string, string[]> = {
  typescript: ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'],
  // ArkTS imports both `.ets` components and plain `.ts` logic modules —
  // HarmonyOS projects are always a mix. `/Index.ets` (capital I) is ohpm's
  // module-entry convention, hit when a bare workspace import ("data") is
  // rewritten to the member's directory; lowercase variants for safety.
  arkts: ['.ets', '.ts', '.d.ts', '.js', '/Index.ets', '/index.ets', '/index.ts', '/index.js'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs', '/index.js', '/index.jsx'],
  tsx: ['.tsx', '.ts', '.d.ts', '.js', '.jsx', '/index.tsx', '/index.ts', '/index.js'],
  jsx: ['.jsx', '.js', '/index.jsx', '/index.js'],
  // SFC consumers import plain TS/JS, sibling components, and barrels
  // (`./lib` → `./lib/index.ts`). Without a list, relative imports from a
  // `.svelte`/`.vue` file resolve to nothing, so barrel callers vanish (#629).
  svelte: ['.ts', '.js', '.svelte', '.tsx', '.jsx', '/index.ts', '/index.js', '/index.svelte'],
  vue: ['.ts', '.js', '.vue', '.tsx', '.jsx', '/index.ts', '/index.js', '/index.vue'],
  astro: ['.ts', '.js', '.astro', '.tsx', '.jsx', '/index.ts', '/index.js', '/index.astro'],
  python: ['.py', '/__init__.py'],
  go: ['.go'],
  rust: ['.rs', '/mod.rs'],
  java: ['.java'],
  c: ['.h', '.c'],
  cpp: ['.h', '.hpp', '.hxx', '.cpp', '.cc', '.cxx'],
  csharp: ['.cs'],
  php: ['.php'],
  ruby: ['.rb'],
  objc: ['.h', '.m', '.mm'],
  nix: ['.nix', '/default.nix'],
};

export function isNixPathImportRef(ref: UnresolvedRef): boolean {
  return (
    ref.language === 'nix' &&
    ref.referenceKind === 'imports' &&
    (ref.referenceName.startsWith('./') || ref.referenceName.startsWith('../')) &&
    !/[\s{}()[\];"'<>$]/.test(ref.referenceName)
  );
}

/**
 * Resolve an import path to an actual file
 */
// Per-context memos for the two hottest pure lookups on the resolution path:
// import-specifier → file resolution and exported-symbol lookup. Both are pure
// given a stable file set + node table, which is exactly the window between
// ReferenceResolver.clearCaches() calls — clearImportResolverMemos() is invoked
// there, so the staleness discipline matches the resolver's own caches.
export const importPathMemos = new WeakMap<ResolutionContext, Map<string, string | null>>();

export function resolveImportPath(
  importPath: string,
  fromFile: string,
  language: Language,
  context: ResolutionContext
): string | null {
  let memo = importPathMemos.get(context);
  if (!memo) {
    memo = new Map();
    importPathMemos.set(context, memo);
  }
  const key = `${language}\0${fromFile}\0${importPath}`;
  const hit = memo.get(key);
  if (hit !== undefined || memo.has(key)) return hit ?? null;
  const resolved = resolveImportPathUncached(importPath, fromFile, language, context);
  memo.set(key, resolved);
  return resolved;
}

function resolveImportPathUncached(
  importPath: string,
  fromFile: string,
  language: Language,
  context: ResolutionContext
): string | null {
  // COBOL COPY/EXEC SQL INCLUDE names a copybook member, not a path — the
  // compiler searches a library, so we match against indexed file basenames.
  // Must run before isExternalImport: a bare member name would otherwise be
  // misclassified as an external package.
  if (language === 'cobol') {
    return resolveCobolCopybook(importPath, fromFile, context);
  }

  // Skip external/npm packages — but pass the context so the
  // bare-specifier heuristic can consult the project's tsconfig
  // alias map first (custom prefixes like `@components/*` would
  // otherwise be misclassified as npm).
  if (isExternalImport(importPath, language, context)) {
    return null;
  }

  const projectRoot = context.getProjectRoot();
  const fromDir = path.dirname(path.join(projectRoot, fromFile));

  // Handle relative imports
  if (importPath.startsWith('.')) {
    return resolveRelativeImport(importPath, fromDir, language, context);
  }

  // Handle absolute/aliased imports (like @/ or src/)
  const aliased = resolveAliasedImport(importPath, projectRoot, language, context);
  if (aliased) return aliased;

  // C/C++ include directory search: when neither relative nor aliased
  // resolution found a match, search -I directories from
  // compile_commands.json or heuristic probing.
  if (language === 'c' || language === 'cpp') {
    return resolveCppIncludePath(importPath, language, context);
  }

  return null;
}

/**
 * COBOL copybook lookup: `COPY CVACT01Y` (or `EXEC SQL INCLUDE X`) names a
 * library member resolved by the compiler's copybook search path, so we match
 * the member against indexed file basenames, case-insensitively. `.cpy` wins
 * over a same-named program; a same-directory hit wins within a tier. The
 * stem index is built once per resolution context (a per-ref scan of every
 * file node would go quadratic on copybook-heavy repos).
 */
export const cobolCopybookIndexes = new WeakMap<ResolutionContext, Map<string, string[]>>();

/**
 * Per-context basename → file-paths index for Lua/Luau require resolution
 * (cobolCopybookIndexes pattern). resolveLuaRequire previously ran
 * `getAllFiles().filter(endsWith)` FOUR times per require ref — ~7.5k string
 * suffix scans each, measured at ~0.9ms/ref (2.7s combined on kong's 3k
 * requires). Buckets preserve getAllFiles() iteration order so the per-suffix
 * candidate list filters to exactly the array the full scan produced —
 * identical matches, identical stable sort, identical winner.
 */
export const luaFileBasenameIndexes = new WeakMap<ResolutionContext, Map<string, string[]>>();

export function luaBasenameIndex(context: ResolutionContext): Map<string, string[]> {
  let index = luaFileBasenameIndexes.get(context);
  if (!index) {
    index = new Map();
    for (const f of context.getAllFiles()) {
      const base = f.split('/').pop() ?? '';
      const paths = index.get(base);
      if (paths) paths.push(f);
      else index.set(base, [f]);
    }
    luaFileBasenameIndexes.set(context, index);
  }
  return index;
}

function resolveCobolCopybook(
  member: string,
  fromFile: string,
  context: ResolutionContext
): string | null {
  let index = cobolCopybookIndexes.get(context);
  if (!index) {
    index = new Map();
    for (const fileNode of context.getNodesByKind('file')) {
      const normalized = fileNode.filePath.replace(/\\/g, '/');
      const base = normalized.split('/').pop() ?? '';
      const dot = base.lastIndexOf('.');
      const stem = (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
      const paths = index.get(stem);
      if (paths) paths.push(fileNode.filePath);
      else index.set(stem, [fileNode.filePath]);
    }
    cobolCopybookIndexes.set(context, index);
  }

  const candidates = index.get(member.toLowerCase());
  if (!candidates || candidates.length === 0) return null;

  const fromDir = fromFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  let best: string | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const normalized = candidate.replace(/\\/g, '/');
    const ext = normalized.slice(normalized.lastIndexOf('.')).toLowerCase();
    let score = 0;
    if (ext === '.cpy') score += 4;
    else if (ext === '.cbl' || ext === '.cob' || ext === '.cobol') score += 2;
    if (normalized.split('/').slice(0, -1).join('/') === fromDir) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/**
 * C and C++ standard library header names (without delimiters).
 * Used by isExternalImport to filter system includes from resolution.
 */
const C_CPP_STDLIB_HEADERS = new Set([
  // C standard library headers
  'assert.h', 'complex.h', 'ctype.h', 'errno.h', 'fenv.h', 'float.h',
  'inttypes.h', 'iso646.h', 'limits.h', 'locale.h', 'math.h', 'setjmp.h',
  'signal.h', 'stdalign.h', 'stdarg.h', 'stdatomic.h', 'stdbool.h',
  'stddef.h', 'stdint.h', 'stdio.h', 'stdlib.h', 'stdnoreturn.h',
  'string.h', 'tgmath.h', 'threads.h', 'time.h', 'uchar.h', 'wchar.h',
  'wctype.h',
  // C++ C-library wrappers (cname form)
  'cassert', 'ccomplex', 'cctype', 'cerrno', 'cfenv', 'cfloat',
  'cinttypes', 'ciso646', 'climits', 'clocale', 'cmath', 'csetjmp',
  'csignal', 'cstdalign', 'cstdarg', 'cstdbool', 'cstddef', 'cstdint',
  'cstdio', 'cstdlib', 'cstring', 'ctgmath', 'ctime', 'cuchar',
  'cwchar', 'cwctype',
  // C++ STL headers
  'algorithm', 'any', 'array', 'atomic', 'barrier', 'bit', 'bitset',
  'charconv', 'chrono', 'codecvt', 'compare', 'complex', 'concepts',
  'condition_variable', 'coroutine', 'deque', 'exception', 'execution',
  'expected', 'filesystem', 'format', 'forward_list', 'fstream',
  'functional', 'future', 'generator', 'initializer_list', 'iomanip',
  'ios', 'iosfwd', 'iostream', 'istream', 'iterator', 'latch',
  'limits', 'list', 'locale', 'map', 'mdspan', 'memory', 'memory_resource',
  'mutex', 'new', 'numbers', 'numeric', 'optional', 'ostream', 'print',
  'queue', 'random', 'ranges', 'ratio', 'regex', 'scoped_allocator',
  'semaphore', 'set', 'shared_mutex', 'source_location', 'span',
  'spanstream', 'sstream', 'stack', 'stacktrace', 'stdexcept',
  'stdfloat', 'stop_token', 'streambuf', 'string', 'string_view',
  'strstream', 'syncstream', 'system_error', 'thread', 'tuple',
  'type_traits', 'typeindex', 'typeinfo', 'unordered_map',
  'unordered_set', 'utility', 'valarray', 'variant', 'vector',
  'version',
]);

/**
 * Check if an import is external (npm package, etc.)
 *
 * `context` is consulted for project-defined path aliases
 * (tsconfig/jsconfig `paths`). Without that check, custom prefixes
 * like `@components/*` would fail the bare-specifier heuristic and
 * be classified as external before alias resolution can run.
 */
function isExternalImport(
  importPath: string,
  language: Language,
  context?: ResolutionContext
): boolean {
  // Relative imports are not external
  if (importPath.startsWith('.')) {
    return false;
  }

  // Workspace-member imports (`@scope/ui`, `@scope/ui/widgets`) are LOCAL to
  // a monorepo even though they look like bare npm specifiers. Consult the
  // workspace map first so they aren't misclassified as external (#629). The
  // map is null for single-package repos, so this is a no-op there.
  const workspaces = context?.getWorkspacePackages?.();
  if (workspaces && resolveWorkspaceImport(importPath, workspaces)) {
    return false;
  }

  // Common external patterns
  if (language === 'typescript' || language === 'javascript' || language === 'tsx' || language === 'jsx' || language === 'arkts') {
    // Node built-ins
    if (['fs', 'path', 'os', 'crypto', 'http', 'https', 'url', 'util', 'events', 'stream', 'child_process', 'buffer'].includes(importPath)) {
      return true;
    }
    // Project-defined alias prefix? Treat as local.
    const aliases = context?.getProjectAliases?.();
    if (aliases) {
      for (const pat of aliases.patterns) {
        if (importPath.startsWith(pat.prefix)) return false;
      }
    }
    // Scoped packages or bare specifiers that don't start with aliases
    if (!importPath.startsWith('@/') && !importPath.startsWith('~/') && !importPath.startsWith('src/')) {
      // Likely an npm package
      return true;
    }
  }

  if (language === 'python') {
    // Standard library modules
    const stdLibs = ['os', 'sys', 'json', 're', 'math', 'datetime', 'collections', 'typing', 'pathlib', 'logging'];
    if (stdLibs.includes(importPath.split('.')[0]!)) {
      return true;
    }
  }

  if (language === 'go') {
    // Relative imports (rare in idiomatic Go but the grammar allows them).
    if (importPath.startsWith('.')) {
      return false;
    }
    // In-module imports look like `<module-path>/sub/pkg` — local to
    // this project. Without the module-path check we'd flag every
    // cross-package call in a Go monorepo as external (issue #388).
    const mod = context?.getGoModule?.();
    if (mod && (importPath === mod.modulePath || importPath.startsWith(mod.modulePath + '/'))) {
      return false;
    }
    // `internal/` packages stay local even when go.mod is missing —
    // preserves the pre-#388 escape hatch for repos without a parsed module path.
    if (importPath.includes('/internal/')) {
      return false;
    }
    // Anything else is the Go standard library or a third-party module.
    return true;
  }

  if (language === 'c' || language === 'cpp') {
    // C/C++ standard library headers — both C-style (<stdio.h>) and
    // C++-style (<cstdio>, <vector>) forms. Checked against the import
    // path (which the extractor strips of <> or "" delimiters).
    if (C_CPP_STDLIB_HEADERS.has(importPath)) return true;
    // C++ headers without .h extension (e.g. "vector", "string")
    const withoutExt = importPath.replace(/\.h$/, '');
    if (C_CPP_STDLIB_HEADERS.has(withoutExt)) return true;
  }

  return false;
}

/**
 * Resolve a relative import
 */
function resolveRelativeImport(
  importPath: string,
  fromDir: string,
  language: Language,
  context: ResolutionContext
): string | null {
  const projectRoot = context.getProjectRoot();
  const extensions = EXTENSION_RESOLUTION[language] || [];

  // Python dotted-relative imports (`from .certs import x`, `from ..pkg.mod
  // import y`): leading dots are PACKAGE levels (1 = current package), and the
  // remainder is a dotted submodule path. `path.resolve(dir, '.certs')` would
  // treat `.certs` as a literal hidden filename, so translate the Python form
  // to a real filesystem-relative path before resolving.
  if (language === 'python' && importPath.startsWith('.')) {
    const dots = importPath.length - importPath.replace(/^\.+/, '').length;
    const up = '../'.repeat(Math.max(0, dots - 1));    // 1 dot = current dir
    const rest = importPath.slice(dots).replace(/\./g, '/'); // 'sub.mod' -> 'sub/mod'
    const pyBase = path.resolve(fromDir, up + rest);
    const pyRel = path.relative(projectRoot, pyBase).replace(/\\/g, '/');
    for (const ext of extensions) {
      if (context.fileExists(pyRel + ext)) return pyRel + ext;
    }
    if (pyRel && context.fileExists(pyRel)) return pyRel;
    return null;
  }

  // Try the path as-is first
  const basePath = path.resolve(fromDir, importPath);
  const relativePath = path.relative(projectRoot, basePath).replace(/\\/g, '/');

  // Try each extension
  for (const ext of extensions) {
    const candidatePath = relativePath + ext;
    if (context.fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  // Try without extension (might already have one)
  if (context.fileExists(relativePath)) {
    return relativePath;
  }

  return null;
}

/**
 * Resolve an aliased/absolute import.
 *
 * Tries, in order:
 *   1. Project-defined `compilerOptions.paths` (tsconfig/jsconfig).
 *      Each pattern can have multiple replacements; tried in tsconfig
 *      priority order with extension permutations.
 *   2. The legacy hard-coded fallback list (`@/`, `~/`, `src/`, ...)
 *      for projects that have aliases but no tsconfig paths block.
 *   3. Direct path lookup (with extensions).
 */
function resolveAliasedImport(
  importPath: string,
  projectRoot: string,
  language: Language,
  context: ResolutionContext
): string | null {
  const extensions = EXTENSION_RESOLUTION[language] || [];
  const tryWithExt = (basePath: string): string | null => {
    for (const ext of extensions) {
      const candidate = basePath + ext;
      if (context.fileExists(candidate)) return candidate;
    }
    if (context.fileExists(basePath)) return basePath;
    return null;
  };

  // 1. Project tsconfig/jsconfig paths.
  const aliasMap = context.getProjectAliases?.();
  if (aliasMap) {
    const candidates = applyAliases(importPath, aliasMap, projectRoot);
    for (const c of candidates) {
      const hit = tryWithExt(c);
      if (hit) return hit;
    }
  }

  // 1.5 Workspace packages (`@scope/ui/widgets` → `packages/ui/widgets`).
  //     Resolves a monorepo member import to the member's directory; the
  //     extension/index permutations below then find its barrel (#629).
  const workspaces = context.getWorkspacePackages?.();
  if (workspaces) {
    const base = resolveWorkspaceImport(importPath, workspaces);
    if (base) {
      const hit = tryWithExt(base);
      if (hit) return hit;
    }
  }

  // 2. Hard-coded fallback list. Kept for projects that use these
  //    conventional aliases without declaring them in tsconfig.
  const fallbackAliases: Record<string, string> = {
    '@/': 'src/',
    '~/': 'src/',
    '@src/': 'src/',
    'src/': 'src/',
    '@app/': 'app/',
    'app/': 'app/',
  };
  for (const [alias, replacement] of Object.entries(fallbackAliases)) {
    if (importPath.startsWith(alias)) {
      const hit = tryWithExt(importPath.replace(alias, replacement));
      if (hit) return hit;
    }
  }

  // 3. Direct path.
  return tryWithExt(importPath);
}

/**
 * Is this reference a PHP include/require PATH (vs a namespace `use` symbol)?
 *
 * include/require emit a file path ("lib.php", "inc/db.php", "../x.php"),
 * whereas namespace use is an FQN (App\Foo\Bar) or a bare class symbol
 * (Closure). PHP identifiers contain neither '/' nor '.', so a slash or dot
 * marks a path-shaped include. Such references resolve to files only — never
 * to a same-named symbol — so callers must not fall back to the name-matcher.
 */
export function isPhpIncludePathRef(ref: UnresolvedRef): boolean {
  return (
    ref.language === 'php' &&
    ref.referenceKind === 'imports' &&
    (ref.referenceName.includes('/') || ref.referenceName.includes('.'))
  );
}

/**
 * Is this a COBOL COPY / EXEC SQL INCLUDE copybook reference? These resolve
 * to files only (or stay unresolved for compiler-supplied members) — never
 * to a same-named symbol via the name-matcher.
 */
export function isCobolCopybookRef(ref: UnresolvedRef): boolean {
  return ref.language === 'cobol' && ref.referenceKind === 'imports';
}

/**
 * Resolve a PHP include/require path to a project-relative file path.
 *
 * PHP resolves includes relative to the including file's directory (the
 * common case for procedural codebases); php.ini `include_path` is not
 * modeled. Callers pass an already-extracted static literal path.
 */
export function resolvePhpIncludePath(
  includePath: string,
  fromFile: string,
  context: ResolutionContext
): string | null {
  const projectRoot = context.getProjectRoot();
  const fromDir = path.dirname(path.join(projectRoot, fromFile));
  const basePath = path.resolve(fromDir, includePath);
  const relativePath = path.relative(projectRoot, basePath).replace(/\\/g, '/');
  if (context.fileExists(relativePath)) return relativePath;
  // The literal may omit the .php extension (e.g. include "config").
  for (const ext of EXTENSION_RESOLUTION.php ?? []) {
    if (context.fileExists(relativePath + ext)) return relativePath + ext;
  }
  return null;
}

/**
 * Resolve a reference using import mappings
 */
/**
 * JVM (Java / Kotlin) imports use fully-qualified names (`import
 * com.example.foo.Bar`) decoupled from filenames, so the JS/Python
 * style filesystem path lookup misses them whenever the file isn't
 * named after its primary symbol (Kotlin `Utils.kt` exporting `Bar`,
 * top-level fns, extension fns). Resolve them through the
 * `qualifiedName` index instead — populated by the package_header /
 * package_declaration namespace wrappers in the extractor.
 */
export function resolveJvmImport(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.referenceKind !== 'imports') return null;
  if (ref.language !== 'java' && ref.language !== 'kotlin') return null;

  const fqn = ref.referenceName;
  const lastDot = fqn.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const pkg = fqn.substring(0, lastDot);
  const sym = fqn.substring(lastDot + 1);
  // Wildcard imports (`com.example.*`) deliberately punt to name-matcher.
  if (sym === '*') return null;

  const candidates = context.getNodesByQualifiedName(`${pkg}::${sym}`);
  if (candidates.length === 0) return null;

  // Kotlin Multiplatform: an `expect` declaration and its `actual`s share one
  // FQN across source sets (commonMain / androidMain / appleMain). Taking the
  // first candidate let a single platform `actual` absorb every common-side
  // import, so the `expect` (the canonical API a commonMain file imports)
  // looked unused. Prefer the candidate CLOSEST to the importing file by
  // directory proximity — a commonMain import resolves to the commonMain
  // declaration — with the `expect` side as a tiebreak.
  const best = candidates.length === 1 ? candidates[0]! : pickClosestJvmCandidate(candidates, ref.filePath);
  return {
    original: ref,
    targetNodeId: best.id,
    confidence: 0.95,
    resolvedBy: 'import',
  };
}

/**
 * Pick the same-FQN candidate closest to `fromPath` by shared directory
 * prefix, preferring an `expect` declaration on a tie. Used to keep a Kotlin
 * Multiplatform `expect`/`actual` import resolving within the importer's own
 * source set instead of an arbitrary platform `actual`.
 */
function pickClosestJvmCandidate(candidates: Node[], fromPath: string): Node {
  const fromDirs = fromPath.split('/').slice(0, -1);
  const sharedPrefix = (p: string): number => {
    const d = p.split('/').slice(0, -1);
    let shared = 0;
    for (let i = 0; i < Math.min(fromDirs.length, d.length); i++) {
      if (fromDirs[i] === d[i]) shared++;
      else break;
    }
    return shared;
  };
  const isExpect = (n: Node): boolean => Array.isArray(n.decorators) && n.decorators.includes('expect');
  let best = candidates[0]!;
  let bestProx = sharedPrefix(best.filePath);
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!;
    const prox = sharedPrefix(c.filePath);
    if (prox > bestProx || (prox === bestProx && isExpect(c) && !isExpect(best))) {
      best = c;
      bestProx = prox;
    }
  }
  return best;
}
