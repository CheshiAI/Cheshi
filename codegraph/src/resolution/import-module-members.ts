import { Node } from '../types';
import { luaBasenameIndex, resolveImportPath } from './import-paths';
import { ImportMapping, ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

/**
 * Resolve a Python qualified reference whose receiver is an imported MODULE:
 * `certs.where()` after `from . import certs`, `mod.func()` after `import mod`
 * or `from pkg import mod`. The receiver names a submodule (a file), not a
 * symbol, so the generic symbol lookup in `resolveViaImport` can't follow it —
 * it would search the *package* for `certs`/`mod` instead of looking inside the
 * module. This is the Python half of the cross-package qualified-call problem
 * (cf. `resolveGoCrossPackageReference` for Go's `pkg.Func`, issue #388).
 *
 * Builds the module's dotted import path from the binding — `from . import
 * certs` → `.certs`; `from pkg import mod` → `pkg.mod`; `import mod` → `mod` —
 * resolves it to the module file, and finds the member defined there. Returns
 * null when no module file exists at that path, so attribute access on an
 * imported *value* (`helper.attr` where `helper` is a function) falls through
 * to the other strategies untouched.
 */
export function resolvePythonModuleMember(
  ref: UnresolvedRef,
  imports: ImportMapping[],
  context: ResolutionContext
): ResolvedRef | null {
  const dotIdx = ref.referenceName.indexOf('.');
  if (dotIdx <= 0) return null;
  const receiver = ref.referenceName.substring(0, dotIdx);
  // The immediate member of the module (first segment after the receiver).
  const member = ref.referenceName.substring(dotIdx + 1).split('.')[0];
  if (!member) return null;

  for (const imp of imports) {
    if (imp.localName !== receiver) continue;

    // `import mod` / `import numpy as np` bind the module at `source` itself;
    // `from . import certs` / `from pkg import mod` bind a SUBMODULE whose
    // dotted path is the source joined with the imported name.
    const modulePath = imp.isNamespace
      ? imp.source
      : imp.source.endsWith('.')
        ? imp.source + imp.localName
        : imp.source + '.' + imp.localName;

    // resolveImportPath only maps RELATIVE dotted paths (`.mod`, `..pkg.mod`); an
    // ABSOLUTE package path (`pkg.module` from `from pkg import module`, or a bare
    // `import pkg.mod`) resolves to null there, so fall back to the dotted-module
    // file lookup — the same asymmetry resolveModuleImportToFile already handles
    // for the file→file import edge. Without this, a `module.func()` call after
    // `from pkg import module` dropped its `calls` edge even though the import
    // edge resolved (#578).
    let resolvedPath = resolveImportPath(modulePath, ref.filePath, ref.language, context);
    if (!resolvedPath) {
      resolvedPath = findPythonModuleFile(modulePath, context, ref.filePath)?.filePath ?? null;
    }
    if (!resolvedPath || resolvedPath === ref.filePath) continue;

    // Find the member as a top-level definition in the module file. Exclude
    // `method` so `mod.foo` never lands on a same-named class method.
    const target = context.getNodesInFile(resolvedPath).find(
      (n) =>
        n.name === member &&
        (n.kind === 'function' ||
          n.kind === 'class' ||
          n.kind === 'variable' ||
          n.kind === 'constant')
    );
    if (target) {
      return { original: ref, targetNodeId: target.id, confidence: 0.85, resolvedBy: 'import' };
    }
  }
  return null;
}

/**
 * Resolve a whole-MODULE import to that module's file (a file→file dependency).
 * The imported name is a module, not a symbol, so there's nothing to resolve to
 * — but importing a module IS a dependency on it. Covers:
 *   - Python submodule imports — `from . import certs`, `from pkg import sub`;
 *   - namespace imports — Python `import mod` / `import numpy as np`, and
 *     TS/JS `import * as ns from './x'`.
 *
 * It is also the robust backstop for {@link resolvePythonModuleMember} and for
 * TS namespace usage: it records the dependency even when the used member is
 * re-exported elsewhere (requests' `certs.where`, re-exported from `certifi`),
 * the usage is module-level code that isn't extracted as a call, or a TS
 * namespace is touched only via a value-member read (`ns.SOME_CONST`).
 *
 * Only fires for dot-free `imports`-kind refs whose module path resolves to a
 * real file. A NAMED TS/JS import (`import { widget }`) is not a module, so it
 * returns null and normal symbol resolution handles it.
 */
/**
 * Resolve a Lua/Luau `require(...)` to its module file. The reference name is
 * either a dotted module path (`telescope.config` → `telescope/config.lua`) or a
 * Roblox instance-path leaf (`Signal` from `require(script.Parent.Signal)` →
 * `Signal.luau`). We try `<path>.lua|.luau` and `<path>/init.lua|.luau`, matched
 * by path suffix (the module root — `lua/`, `src/`, … — is project-specific).
 * Among suffix matches, the one sharing the longest directory prefix with the
 * requiring file wins (instance-path requires resolve within the same package).
 */
export function resolveLuaRequire(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = ref.referenceName;
  if (!name) return null;
  const base = name.includes('.') ? name.replace(/\./g, '/') : name;
  const suffixes = [`${base}.lua`, `${base}.luau`, `${base}/init.lua`, `${base}/init.luau`];
  const byBasename = luaBasenameIndex(context);
  const shared = (a: string, b: string): number => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  for (const suffix of suffixes) {
    // Only files sharing the suffix's basename can match — the bucket is in
    // getAllFiles() order, so this filter yields exactly what the full-list
    // scan did.
    const candidates = byBasename.get(suffix.split('/').pop() ?? '') ?? [];
    const matches = candidates.filter((f) => f === suffix || f.endsWith('/' + suffix));
    if (matches.length === 0) continue;
    matches.sort((x, y) => shared(y, ref.filePath) - shared(x, ref.filePath));
    const best = matches[0]!;
    if (best === ref.filePath) continue;
    const fileNode = context.getNodesInFile(best).find((n) => n.kind === 'file');
    if (fileNode) {
      // Confidence ≥ 0.9 so this deterministic path/suffix match wins over
      // name-matching, which otherwise resolves the require to the import node
      // itself (a same-name self-match).
      return { original: ref, targetNodeId: fileNode.id, confidence: 0.9, resolvedBy: 'import' };
    }
  }
  return null;
}

export function resolveModuleImportToFile(
  ref: UnresolvedRef,
  imports: ImportMapping[],
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.referenceKind !== 'imports') return null;
  if (ref.referenceName.includes('.')) return null;

  for (const imp of imports) {
    if (imp.localName !== ref.referenceName) continue;

    let modulePath: string;
    if (imp.isNamespace || imp.isDefault) {
      // `import * as ns from './x'` (namespace) or `import x from './x'`
      // (default) — the dependency is on the MODULE FILE. A default import binds
      // a (possibly renamed) local to whatever the module's default export is
      // (`import articlesController from './article.controller'` ← `export
      // default router`), so the binding name can't be found as a symbol — link
      // the file the import resolves to instead. External modules don't resolve
      // (no file), so `import React from 'react'` creates no edge.
      modulePath = imp.source;
    } else if (ref.language === 'python') {
      // `from . import certs` — the imported NAME is a submodule of the source.
      modulePath = imp.source.endsWith('.')
        ? imp.source + imp.localName
        : imp.source + '.' + imp.localName;
    } else {
      // A named TS/JS import binds a symbol, not a module — leave it alone.
      continue;
    }

    const resolvedPath = resolveImportPath(modulePath, ref.filePath, ref.language, context);
    if (resolvedPath && resolvedPath !== ref.filePath) {
      const fileNode = context.getNodesInFile(resolvedPath).find((n) => n.kind === 'file');
      if (fileNode) {
        return { original: ref, targetNodeId: fileNode.id, confidence: 0.9, resolvedBy: 'import' };
      }
    }

    // Python absolute `from a.b import submodule` (a FastAPI router aggregator's
    // `from app.api.routes import authentication`): resolveImportPath only maps
    // RELATIVE dotted paths to a file, so resolve the absolute dotted module
    // directly to its file node.
    if (ref.language === 'python') {
      const modFile = findPythonModuleFile(modulePath, context, ref.filePath);
      if (modFile) {
        return { original: ref, targetNodeId: modFile.id, confidence: 0.9, resolvedBy: 'import' };
      }
    }
  }
  return null;
}

/**
 * Find the file node for a Python dotted module path `a.b.c` — a module file
 * ending in `a/b/c.py`, or a package `a/b/c/__init__.py` (suffix-matched, so a
 * package rooted under `src/` etc. still resolves). Returns null for
 * stdlib/external modules (no matching repo file node), so `import os` creates
 * no edge. Shared by absolute `import a.b.c` and absolute `from a.b import c`
 * (where `c` is a submodule) resolution.
 */
function findPythonModuleFile(
  mod: string,
  context: ResolutionContext,
  excludeFilePath: string
): Node | null {
  if (!mod || mod.startsWith('.')) return null; // relative imports handled elsewhere
  const rel = mod.replace(/\./g, '/');
  const lastSeg = mod.split('.').pop()!;
  const endsWith = (p: string, want: string): boolean => p === want || p.endsWith('/' + want);
  const moduleFile = context
    .getNodesByName(`${lastSeg}.py`)
    .find((n) => n.kind === 'file' && n.filePath !== excludeFilePath && endsWith(n.filePath, `${rel}.py`));
  if (moduleFile) return moduleFile;
  const pkgFile = context
    .getNodesByName('__init__.py')
    .find((n) => n.kind === 'file' && n.filePath !== excludeFilePath && endsWith(n.filePath, `${rel}/__init__.py`));
  return pkgFile ?? null;
}

/**
 * Resolve a Python ABSOLUTE dotted module import (`import a.b.c`) to its file —
 * the Django `AppConfig.ready(): import myapp.signals` pattern and any
 * side-effect module import.
 */
export function resolvePythonAbsoluteModule(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.referenceKind !== 'imports') return null;
  // Only a DOTTED `import a.b.c` ref carries its full module path. A bare leaf
  // (`from app.api.routes import authentication`) is ambiguous on its own — three
  // `authentication.py` files may exist — so leave it to resolveModuleImportToFile,
  // which uses the import's source (`app.api.routes`) to build the full path.
  if (!ref.referenceName.includes('.')) return null;
  const hit = findPythonModuleFile(ref.referenceName, context, ref.filePath);
  return hit ? { original: ref, targetNodeId: hit.id, confidence: 0.9, resolvedBy: 'import' } : null;
}
