import { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import * as path from 'path';

/**
 * Resolve a Rust qualified reference `A::B::C` by mapping the MODULE prefix
 * (`A::B`) to a file and finding the leaf symbol (`C`) in it. This is the Rust
 * analog of {@link resolvePythonModuleMember} / {@link resolveGoCrossPackageReference}
 * and the precise answer to common-name re-exports (`pub use self::read::read`)
 * that name-matching can't disambiguate. Returns null when the prefix isn't a
 * real module path (e.g. `Widget::new` — `Widget` is a struct, not a module),
 * so associated-function calls and enum-variant paths fall through untouched.
 */
export function resolveRustPathReference(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const segments = ref.referenceName.split('::').filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const leaf = segments[segments.length - 1]!;
  const modSegs = segments.slice(0, -1);

  const file = resolveRustModuleFile(modSegs, ref.filePath, context);
  if (!file || file === ref.filePath) return null;

  const target = context.getNodesInFile(file).find(
    (n) =>
      n.name === leaf &&
      (n.kind === 'function' ||
        n.kind === 'struct' ||
        n.kind === 'enum' ||
        n.kind === 'trait' ||
        n.kind === 'type_alias' ||
        n.kind === 'constant' ||
        n.kind === 'method' ||
        n.kind === 'class' ||
        n.kind === 'interface')
  );
  if (target) {
    return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'import' };
  }
  return null;
}

/** The crate-root directory (holds `lib.rs`/`main.rs`), walking up from a file. */
function rustCrateRootDir(fromFileAbs: string, context: ResolutionContext): string | null {
  const projectRoot = context.getProjectRoot();
  const toRel = (p: string) => path.relative(projectRoot, p).replace(/\\/g, '/');
  let dir = path.dirname(fromFileAbs);
  for (let i = 0; i < 64; i++) {
    if (context.fileExists(toRel(path.join(dir, 'lib.rs'))) ||
      context.fileExists(toRel(path.join(dir, 'main.rs')))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Directory under which the current file's module declares its SUBMODULES. */
function rustSelfModuleDir(fromFileAbs: string): string {
  const base = path.basename(fromFileAbs);
  const dir = path.dirname(fromFileAbs);
  // mod.rs / lib.rs / main.rs own their directory; `foo.rs`'s submodules live in `foo/`.
  if (base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs') return dir;
  return path.join(dir, base.replace(/\.rs$/, ''));
}

/**
 * Resolve a Rust module path (segments WITHOUT the leaf symbol) to the file of
 * the last module segment — `crate::a::b` → `<crate>/a/b.rs` (or `.../b/mod.rs`).
 * Anchors on `crate` / `self` / `super`; a bare path is tried crate-relative.
 */
function resolveRustModuleFile(
  segments: string[],
  fromFile: string,
  context: ResolutionContext
): string | null {
  if (segments.length === 0) return null;
  const projectRoot = context.getProjectRoot();
  const fromAbs = path.join(projectRoot, fromFile);
  const toRel = (p: string) => path.relative(projectRoot, p).replace(/\\/g, '/');

  // Walk a sequence of module segments down from `startDir`, mapping each to a
  // `<seg>.rs` or `<seg>/mod.rs` file. Returns the leaf module's file, or null
  // if `startDir` is null or any segment has no file on disk.
  const resolveUnder = (startDir: string | null, rest: string[]): string | null => {
    if (!startDir) return null;
    let dir = startDir;
    let targetFile: string | null = null;
    for (const seg of rest) {
      if (seg === 'self' || seg === 'crate' || seg === 'super') continue;
      const asFile = toRel(path.join(dir, seg + '.rs'));
      const asMod = toRel(path.join(dir, seg, 'mod.rs'));
      if (context.fileExists(asFile)) targetFile = asFile;
      else if (context.fileExists(asMod)) targetFile = asMod;
      else return null;
      dir = path.join(dir, seg);
    }
    return targetFile;
  };

  const first = segments[0]!;
  if (first === 'crate') {
    return resolveUnder(rustCrateRootDir(fromAbs, context), segments.slice(1));
  }
  if (first === 'self') {
    return resolveUnder(rustSelfModuleDir(fromAbs), segments.slice(1));
  }
  if (first === 'super') {
    let supers = 0;
    while (segments[supers] === 'super') supers++;
    let dir: string | null = rustSelfModuleDir(fromAbs);
    for (let s = 0; s < supers && dir; s++) dir = path.dirname(dir);
    return resolveUnder(dir, segments.slice(supers));
  }
  // Bare path. In expression position (`submodule::item()` — the router-assembly
  // and general cross-module-call pattern) the prefix is a SUBMODULE of the
  // current module, i.e. 2018 `self::`-relative — so try self-relative FIRST.
  // Fall back to crate-relative for 2015-edition / crate-root items. External
  // crate paths (`serde::de::Error`) miss both and fall through to name-matching.
  return (
    resolveUnder(rustSelfModuleDir(fromAbs), segments) ??
    resolveUnder(rustCrateRootDir(fromAbs, context), segments)
  );
}
