import { logWarn } from '../errors';
import { loadExcludePatterns, loadIncludeIgnoredPatterns, loadIncludePatterns } from '../project-config';
import * as fs from 'fs';
import ignore from 'ignore';
import { Ignore } from 'ignore';
import * as path from 'path';

/**
 * Directory names that are dependency, build, cache, or tooling output across the
 * languages/frameworks CodeGraph supports — curated from the canonical
 * github/gitignore templates. Excluded by default so the graph reflects your code,
 * not third-party noise, without requiring a `.gitignore` (issue #407). The
 * exclusion applies uniformly (git or not, tracked or not); the only opt-in is an
 * explicit `.gitignore` negation (e.g. `!vendor/`). First-party-prone or generic
 * names (`packages`, `lib`, `app`, `bin`, `src`, `deps`, `env`, `tmp`, `storage`,
 * `Library`) are deliberately NOT listed, to avoid ever hiding real source.
 *
 * Only dirs that actually contain *indexable source* (or are enormous) earn a slot
 * — IDE/state dirs like `.idea`/`.vs` are omitted because CodeGraph indexes only
 * recognized source extensions, so they produce no symbols regardless.
 */
const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  // JS / TS — dependency directories
  'node_modules', 'bower_components', 'jspm_packages', 'web_modules',
  '.yarn', '.pnpm-store',
  // JS / TS — framework & bundler build / cache / deploy output
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.vite', '.parcel-cache', '.angular',
  '.docusaurus', 'storybook-static', '.vinxi', '.nitro', 'out-tsc',
  '.vercel', '.netlify', '.wrangler',
  // Build output (common across ecosystems)
  'dist', 'build', 'out', '.output',
  // Test / coverage
  'coverage', '.nyc_output',
  // Python
  '__pycache__', '__pypackages__', '.venv', 'venv', '.pixi', '.pdm-build',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.nox', '.hypothesis',
  '.ipynb_checkpoints', '.eggs',
  // Rust / JVM (Maven, Gradle, Scala)
  'target', '.gradle',
  // .NET
  'obj',
  // Vendored deps (Go, PHP/Composer, Ruby/Bundler)
  'vendor',
  // Swift / iOS
  '.build', 'Pods', 'Carthage', 'DerivedData', '.swiftpm',
  // Dart / Flutter
  '.dart_tool', '.pub-cache',
  // Native (Android NDK, C/C++ deps)
  '.cxx', '.externalNativeBuild', 'vcpkg_installed',
  // Scala tooling
  '.bloop', '.metals',
  // Lua / Luau (LuaRocks)
  'lua_modules', '.luarocks',
  // Delphi / RAD Studio IDE backups (duplicate .pas source — would double-count)
  '__history', '__recovery',
  // Generic cache
  '.cache',
]);

/**
 * Android resource directory types. A `res/` tree holds ONLY non-code resources —
 * layouts, drawables, value bags (strings/colors/styles), menus, navigation
 * graphs — split into one typed subdirectory per kind, optionally density/locale/
 * version-qualified (`values-es`, `drawable-hdpi`, `layout-v21`, …). None of it
 * yields an extractable code symbol, yet on an Android app it DOMINATES the tree
 * (one report: 26k XML files = 97% of the project, 0 symbols), bloating the DB,
 * slowing indexing, and skewing both the file count and `codegraph_explore`
 * results (#1047). So these are excluded by default. The structure is
 * self-identifying — a non-Android project has no `res/layout/` etc., so it's
 * untouched — and the only XML that DOES produce symbols (MyBatis mappers) lives
 * under `src/main/resources/`, never `res/`, so nothing useful is dropped.
 * `res/raw/` is deliberately NOT here: it holds arbitrary bundled assets that can
 * be code-ish (a `.sql` schema, a `.js`), so we leave it indexed. Override any of
 * these with a `.gitignore` negation (e.g. `!res/values/`).
 */
const ANDROID_RES_TYPES: readonly string[] = [
  'anim', 'animator', 'color', 'drawable', 'font', 'layout',
  'menu', 'mipmap', 'navigation', 'transition', 'values', 'xml',
];

/** Gitignore-style patterns for the `ignore` matcher: the dirs above plus a few globs. */
const DEFAULT_IGNORE_PATTERNS: string[] = [
  ...Array.from(DEFAULT_IGNORE_DIRS, (d) => `${d}/`),
  '*.egg-info/',     // Python packaging metadata
  'cmake-build-*/',  // CLion / CMake build trees
  'bazel-*/',        // Bazel output symlink trees
  // Android resource dirs at any depth, with their qualifier variants (#1047).
  ...ANDROID_RES_TYPES.map((t) => `**/res/${t}*/`),
];

/** True if `buf` decodes as strict UTF-8 (no invalid byte sequences). */
function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a `.gitignore` and return patterns safe to hand to the `ignore` matcher —
 * never throwing, even when the file isn't real gitignore text. Two failure
 * modes, both seen in the wild (issue #682):
 *
 *  - The file isn't valid UTF-8 — e.g. transparently encrypted in place by
 *    corporate DLP / endpoint-security software, leaving a UTF-16 header plus
 *    ciphertext. None of it is meaningful patterns, so the whole file is skipped.
 *  - The file is text but a single line can't be compiled to a regex by the
 *    `ignore` library — `\\[` and friends throw "Unterminated character class".
 *    Crucially the throw is LAZY (at match time, not `.add()`), so it would
 *    otherwise escape mid-scan. That one pattern is dropped; the rest are kept.
 *
 * Either way a warning that NAMES the file is logged (the reporter couldn't tell
 * which `.gitignore` was at fault) and indexing continues instead of aborting.
 * Returns '' when there's nothing usable.
 */
export function readGitignorePatterns(giPath: string): string {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(giPath);
  } catch {
    return ''; // unreadable (permissions / race) — treat as absent
  }
  // A NUL byte never appears in real gitignore text, and a fatal UTF-8 decode
  // catches the rest. Such a file isn't ignore patterns at all.
  if (buf.includes(0) || !isValidUtf8(buf)) {
    logWarn(
      'Ignoring a .gitignore that is not valid UTF-8 text — it may have been encrypted ' +
      'in place by endpoint-security software. Indexing continues without it.',
      { file: giPath },
    );
    return '';
  }
  const content = buf.toString('utf-8');
  // Fast path: one `.ignores()` call forces the library to compile EVERY rule,
  // so if it doesn't throw, the whole file is safe to use verbatim.
  try {
    ignore().add(content).ignores('.codegraph-probe');
    return content;
  } catch {
    // Fall through: a line is uncompilable — keep the good ones, drop the bad.
  }
  const kept: string[] = [];
  let dropped = 0;
  for (const line of content.split(/\r?\n/)) {
    try {
      ignore().add(line).ignores('.codegraph-probe');
      kept.push(line);
    } catch {
      dropped++;
    }
  }
  if (dropped > 0) {
    logWarn(
      `Skipped ${dropped} unparseable pattern(s) in a .gitignore; the rest are applied.`,
      { file: giPath },
    );
  }
  return kept.join('\n');
}

/**
 * An `ignore` matcher seeded with the built-in defaults, merged with the project's
 * root .gitignore so a negation there (e.g. `!vendor/`) overrides a default. Shared
 * by both enumeration paths so behavior is identical with or without git — and so
 * the defaults apply to tracked files too (committing a dependency dir doesn't make
 * it project code; the explicit `.gitignore` negation is the only opt-in).
 */
export function buildDefaultIgnore(rootDir: string): Ignore {
  const ig = ignore().add(DEFAULT_IGNORE_PATTERNS);
  const rootGitignore = path.join(rootDir, '.gitignore');
  if (fs.existsSync(rootGitignore)) ig.add(readGitignorePatterns(rootGitignore));
  return ig;
}

/**
 * Defaults-only ignore matcher (no root `.gitignore` merged). Used wherever the
 * parent repo's own ignore rules must NOT apply — inside embedded child repos,
 * whose gitignore semantics their own `git ls-files` already enforced (#514).
 */
export function defaultsOnlyIgnore(): Ignore {
  return ignore().add(DEFAULT_IGNORE_PATTERNS);
}

/**
 * Matcher for the project's `codegraph.json` `includeIgnored` patterns — the
 * explicit opt-in to index embedded git repos living inside gitignored
 * directories (#622, #699). Returns `null` when the project opted in nothing,
 * which is the zero-config DEFAULT: `.gitignore` is then fully respected and a
 * gitignored directory (even one holding nested repos) is never walked or
 * indexed (#970, #976). Built once per scan/sync/scope operation from the scan
 * root and threaded down — never global, so multi-project daemons stay isolated.
 */
export function loadIncludeIgnoredMatcher(rootDir: string): Ignore | null {
  const patterns = loadIncludeIgnoredPatterns(rootDir);
  return patterns.length > 0 ? ignore().add(patterns) : null;
}

/**
 * Matcher for the project's `codegraph.json` `exclude` patterns — paths to keep
 * OUT of the index even when git-tracked, which `.gitignore` cannot do (#999).
 * The escape hatch for a committed vendor/theme/SDK directory. Returns `null`
 * when nothing is excluded (the zero-config default → no overhead). Matched
 * against project-root-relative paths, so it applies uniformly across the whole
 * workspace, including inside embedded repos (excluding `static/` means gone
 * everywhere). Built once per scan/sync/scope operation from the scan root.
 */
export function loadExcludeMatcher(rootDir: string): Ignore | null {
  const patterns = loadExcludePatterns(rootDir);
  return patterns.length > 0 ? ignore().add(patterns) : null;
}

/**
 * Matcher for the project's `codegraph.json` `include` patterns — first-party
 * source to force INTO the index even when `.gitignore` drops it (the general
 * whitelist `includeIgnored` never was — that one only revives *embedded git
 * repos*). The case it exists for: a project under a second VCS (SVN/Perforce)
 * `.gitignore`s its own real source so it stays out of Git, yet we still want it
 * indexed. Returns `null` when nothing is force-included (the zero-config
 * default → no overhead, no extra walk). Built once per scan/sync/scope
 * operation from the scan root.
 */
export function loadIncludeMatcher(rootDir: string): Ignore | null {
  const patterns = loadIncludePatterns(rootDir);
  return patterns.length > 0 ? ignore().add(patterns) : null;
}

/** Glob metacharacters that end the static (literal) prefix of an `include` pattern. */
export const GLOB_META = /[*?[\]{}!]/;
