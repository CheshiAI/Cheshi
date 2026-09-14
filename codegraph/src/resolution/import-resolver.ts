import { Language, Node } from '../types';
import { exportedSymbolMemos, fileExportIndexes, findExportedSymbol } from './import-exports';
import { resolveGoCrossPackageReference, resolveJavaImportedReference } from './import-jvm-go';
import {
  resolveLuaRequire,
  resolveModuleImportToFile,
  resolvePythonAbsoluteModule,
  resolvePythonModuleMember,
} from './import-module-members';
import {
  cobolCopybookIndexes,
  importPathMemos,
  isCobolCopybookRef,
  isNixPathImportRef,
  isPhpIncludePathRef,
  luaFileBasenameIndexes,
  resolveImportPath,
  resolvePhpIncludePath,
} from './import-paths';
import { resolveRustPathReference } from './import-rust';
import { localReceiverTypePatterns, normalizeInferredTypeName, resolveMethodOnType } from './name-matcher';
import { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { clearStoreActionMemos, resolveImportedStoreAction } from './store-action-calls';
import * as path from 'path';

export { isNixPathImportRef } from './import-paths';

export { resolveImportPath } from './import-paths';

export { clearCppIncludeDirCache } from './import-cpp-paths';

export { loadCppIncludeDirs } from './import-cpp-paths';

export { isPhpIncludePathRef } from './import-paths';

export { isCobolCopybookRef } from './import-paths';

export { extractImportMappings } from './import-bindings';

export { clearImportMappingCache } from './import-bindings';

export { extractReExports } from './import-exports';

export { resolveJvmImport } from './import-paths';

/** Drop the per-context memo tables (see ReferenceResolver.clearCaches). */
export function clearImportResolverMemos(context: ResolutionContext): void {
  clearStoreActionMemos(context);
  importPathMemos.delete(context);
  exportedSymbolMemos.delete(context);
  fileExportIndexes.delete(context);
  luaFileBasenameIndexes.delete(context);
  cobolCopybookIndexes.delete(context);
}

function resolveFileReference(
  ref: UnresolvedRef,
  context: ResolutionContext,
  resolvedPath: string | null,
): ResolvedRef | null {
  if (!resolvedPath) return null;
  const basename = resolvedPath.split('/').pop()!;
  const fileNode = context
    .getNodesByName(basename)
    .find((n) => n.kind === 'file' && n.filePath === resolvedPath);
  return fileNode
    ? { original: ref, targetNodeId: fileNode.id, confidence: 0.9, resolvedBy: 'import' }
    : null;
}

export function resolveViaImport(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // C/C++ #include references — resolve directly to the included file
  // (file→file edge), bypassing symbol lookup. The extractor emits these
  // with `referenceKind: 'imports'` and `referenceName: <include path>`
  // (e.g. "uint256.h" or "common/args.h"). Without this branch the
  // include-dir scan path inside resolveImportPath never produces an
  // edge — resolveViaImport's symbol lookup below would search the
  // resolved file for a symbol named like the file extension and fail.
  if ((ref.language === 'c' || ref.language === 'cpp') && ref.referenceKind === 'imports') {
    // C/C++ quoted includes (`#include "X.h"`) resolve relative to the
    // INCLUDING file's own directory first (the C standard's quoted-include
    // search order). Prefer a same-directory header over an -I directory or a
    // same-named header on another platform (windows/code/RNCAsyncStorage.h vs
    // apple/.../RNCAsyncStorage.h) — the include-dir heuristic below would
    // otherwise pick an arbitrary same-named header, leaving the real local one
    // with no dependents.
    const slash = ref.filePath.lastIndexOf('/');
    const fromDir = slash >= 0 ? ref.filePath.slice(0, slash) : '';
    const siblingPath = path.posix.normalize(fromDir ? `${fromDir}/${ref.referenceName}` : ref.referenceName);
    const siblingBase = siblingPath.split('/').pop()!;
    const sibling = context
      .getNodesByName(siblingBase)
      .find((n) => n.kind === 'file' && n.filePath === siblingPath);
    if (sibling) {
      return { original: ref, targetNodeId: sibling.id, confidence: 0.92, resolvedBy: 'import' };
    }
    return resolveFileReference(
      ref,
      context,
      resolveImportPath(ref.referenceName, ref.filePath, ref.language, context),
    );
  }

  // COBOL COPY / EXEC SQL INCLUDE — resolve the copybook member to a
  // file→file edge, mirroring the C/C++ include branch above. A member that
  // matches no indexed file (compiler-supplied copybooks like SQLCA/DFHAID)
  // stays unresolved — callers must not fall back to the symbol name-matcher,
  // which would connect it to a same-named import symbol elsewhere.
  if (isCobolCopybookRef(ref)) {
    return resolveFileReference(
      ref,
      context,
      resolveImportPath(ref.referenceName, ref.filePath, ref.language!, context),
    );
  }

  // PHP include/require — resolve the static string path to a file→file
  // edge, mirroring the C/C++ branch above. Distinguish include PATHS from
  // namespace `use` symbols by shape: an include path contains a slash or a
  // file extension ("lib.php", "inc/db.php", "../x.php"), whereas a namespace
  // use is an FQN (App\Foo\Bar) or a bare class symbol (Closure) — PHP
  // identifiers contain neither '/' nor '.'. Only path-shaped references are
  // includes; symbol references fall through to the namespace resolution.
  if (isPhpIncludePathRef(ref)) {
    const fileReference = resolveFileReference(
      ref,
      context,
      resolvePhpIncludePath(ref.referenceName, ref.filePath, context),
    );
    if (fileReference) return fileReference;
    // A path-shaped include that doesn't resolve to a known project file is a
    // dead end. Return unresolved rather than falling through to the symbol
    // name-matcher, which would mis-connect e.g. "inc/db.php" to an unrelated
    // db.php elsewhere in the tree — a wrong edge is worse than a missing one.
    return null;
  }

  // Nix static project-path imports (`import ./x.nix`, `builtins.import ./dir`,
  // `import ./x.nix {}`) resolve to file nodes only. Do not resolve
  // angle-bracket channels, attribute expressions, variables, or other dynamic
  // expressions as project files.
  if (isNixPathImportRef(ref)) {
    return resolveFileReference(
      ref,
      context,
      resolveImportPath(ref.referenceName, ref.filePath, ref.language, context),
    );
  }

  // Use cached import mappings (avoids re-reading and re-parsing per ref)
  const imports = context.getImportMappings(ref.filePath, ref.language);
  if (imports.length === 0 && !context.readFile(ref.filePath)) {
    return null;
  }

  // Go cross-package calls: `pkga.FuncX(...)` extracts to referenceName
  // `pkga.FuncX` and the import `github.com/example/myproject/pkga`
  // maps to a *package directory* containing one or more .go files.
  // The generic file-based lookup below can't follow that — issue #388.
  if (ref.language === 'go') {
    const goResult = resolveGoCrossPackageReference(ref, imports, context);
    if (goResult) return goResult;
  }

  // Java / Kotlin: imports are FQNs (`import com.example.Foo;`) — no
  // resolvable file path the JS/TS-style chain below could follow. Look
  // up the symbol by name and filter to the candidate whose file path
  // matches the imported FQN. This is the disambiguation signal that
  // breaks the same-name class collision the path-proximity matcher
  // can't resolve (issue #314).
  if (ref.language === 'java' || ref.language === 'kotlin') {
    const javaResult = resolveJavaImportedReference(ref, imports, context);
    if (javaResult) return javaResult;
  }

  // Python qualified access through an imported MODULE: `certs.where()` after
  // `from . import certs`, `mod.func()` after `import mod`. The receiver names a
  // submodule (a file), not a symbol, so the generic symbol lookup below would
  // search the *package* for `certs` instead of looking inside the module.
  if (ref.language === 'python') {
    const pyResult = resolvePythonModuleMember(ref, imports, context);
    if (pyResult) return pyResult;
    // Absolute dotted module import: `import conduit.apps.articles.signals`
    // (the standard Django AppConfig.ready() signal-registration pattern, and
    // any side-effect `import pkg.mod`). Map the dotted path to its file.
    const pyModResult = resolvePythonAbsoluteModule(ref, context);
    if (pyModResult) return pyModResult;
  }

  // Rust qualified path: resolve the module prefix of `crate::m::Item` /
  // `self::sub::Item` / `super::m::func` to a file, then find the leaf symbol in
  // it. Disambiguates common-name `pub use self::read::read` re-exports that
  // name-matching would land on the wrong same-named symbol.
  if (ref.language === 'rust' && ref.referenceName.includes('::')) {
    const rustResult = resolveRustPathReference(ref, context);
    if (rustResult) return rustResult;
  }

  // Lua / Luau `require(...)`: a dotted module path (`a.b.c` from
  // `require("a.b.c")`) or an instance-path leaf (`Signal` from
  // `require(script.Parent.Signal)`) — map it to a module file. There's no static
  // import statement, so the generic path-matcher can't bridge the dot↔slash /
  // leaf↔basename gap; resolve it explicitly to the module file.
  if ((ref.language === 'lua' || ref.language === 'luau') && ref.referenceKind === 'imports') {
    const luaResult = resolveLuaRequire(ref, context);
    if (luaResult) return luaResult;
  }

  // Whole-module / namespace imports → link the importing file to the module
  // file. Python `from . import certs` / `import mod`, and TS/JS `import * as ns
  // from './x'` (so a namespace touched only via a value-member read still
  // records the dependency). A named TS/JS import returns null here and falls
  // through to symbol resolution below.
  if (
    ref.language === 'python' ||
    ref.language === 'typescript' ||
    ref.language === 'tsx' ||
    ref.language === 'javascript' ||
    ref.language === 'jsx' ||
    ref.language === 'arkts'
  ) {
    const moduleFile = resolveModuleImportToFile(ref, imports, context);
    if (moduleFile) return moduleFile;
  }

  // Check if the reference name matches any import
  for (const imp of imports) {
    if (imp.localName === ref.referenceName || ref.referenceName.startsWith(imp.localName + '.')) {
      // Resolve the import path
      const resolvedPath = resolveImportPath(
        imp.source,
        ref.filePath,
        ref.language,
        context
      );

      if (resolvedPath) {
        const exportedName = imp.isDefault ? 'default' : imp.exportedName;
        const memberName = imp.isNamespace
          ? ref.referenceName.replace(imp.localName + '.', '')
          : null;

        const targetNode = findExportedSymbol(
          resolvedPath,
          { isDefault: imp.isDefault, isNamespace: imp.isNamespace, exportedName, memberName },
          ref.language,
          context,
          new Set()
        );

        if (targetNode) {
          const storeAction = resolveImportedStoreAction(targetNode, imp.localName, ref, context);
          if (storeAction) return storeAction;
          // `Foo.bar()` / `Foo.CONST` — a NAMED (non-namespace) class import
          // accessed through a member. `findExportedSymbol` resolved `Foo` to
          // the class itself; descend into it so the reference links to the
          // member `bar`, not the class. Without this the edge points at the
          // class and `createEdges` then mis-promotes the call to an
          // `instantiates` edge, so the static method shows zero callers and a
          // hollow impact radius. (#825)
          if (!imp.isNamespace && ref.referenceName.startsWith(imp.localName + '.')) {
            const memberNode = resolveStaticMember(targetNode, ref, imp.localName, context);
            if (memberNode) {
              return {
                original: ref,
                targetNodeId: memberNode.id,
                confidence: 0.9,
                resolvedBy: 'import',
              };
            }
            // An imported VALUE (singleton constant / shared instance) called
            // through a member: `reproStore.notifyJoinGuildStatus()` after
            // `import { reproStore } from './store'`. findExportedSymbol
            // resolved the CONSTANT itself; linking the CALL there hides the
            // real callee — callers of the method miss every cross-file use
            // and the method can look unused (#1292). Infer the value's type
            // from its own declaration in the exporting file and resolve the
            // member on that type. resolveMethodOnType VALIDATES the type
            // declares the method, so a mis-inference falls through to the
            // constant edge below rather than fabricating a wrong one.
            const instanceMember = resolveImportedInstanceMember(targetNode, ref, imp.localName, context);
            if (instanceMember) return instanceMember;
          }

          return {
            original: ref,
            targetNodeId: targetNode.id,
            confidence: 0.9,
            resolvedBy: 'import',
          };
        }
      }
    }
  }

  return null;
}

/** Node kinds that own static members reachable as `Container.member`. */
const STATIC_MEMBER_CONTAINERS = new Set<Node['kind']>([
  'class', 'struct', 'interface', 'enum', 'trait', 'protocol',
]);

/**
 * Resolve `Container.member` — a static method/property access on a NAMED class
 * import (`import { Foo } …; Foo.bar()`) — to the member node, given the
 * already-resolved container class.
 *
 * Members carry a `Container::member` qualifiedName, so we look up
 * `${container.qualifiedName}::${member}` within the container's own file (the
 * file filter disambiguates same-named classes in other modules). Returns
 * undefined when the container isn't a member-owning kind or the member isn't
 * found, so the caller falls back to the container itself (prior behavior) —
 * languages whose members aren't `::`-qualified, and genuine class references,
 * are unaffected. See #825.
 */
/**
 * Resolve a CALL through an imported value to the method on the value's own
 * type: `reproStore.notifyJoinGuildStatus()` where `reproStore` is
 * `export const reproStore = new ReproStore()` in the imported file (#1292).
 * The same-file form of this call already resolves via local-variable
 * receiver inference (#1108); this is the cross-file/import half. The type is
 * recovered from the VALUE'S OWN declaration lines in the exporting file
 * (initializer `= new T(...)` or a type annotation, per the shared #1108
 * pattern table), then the member is resolved AND VALIDATED on that type by
 * resolveMethodOnType — a failed inference or validation returns null so the
 * caller keeps its existing constant-edge behavior.
 */
function resolveImportedInstanceMember(
  value: Node,
  ref: UnresolvedRef,
  localName: string,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.referenceKind !== 'calls') return null;
  if (value.kind !== 'constant' && value.kind !== 'variable') return null;
  const member = ref.referenceName.slice(localName.length + 1).split('.')[0];
  if (!member) return null;

  const source = context.readFile(value.filePath);
  if (!source) return null;
  // Only the value's own declaration lines — never the whole file, so a
  // same-named identifier elsewhere can't donate a type.
  const lines = source.split('\n');
  const declSlice = lines.slice(Math.max(0, value.startLine - 1), value.endLine).join('\n');

  const receiver = value.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const pattern of localReceiverTypePatterns(value.language as Language, receiver)) {
    const m = declSlice.match(pattern);
    if (!m || !m[1]) continue;
    const typeName = normalizeInferredTypeName(m[1]);
    if (!typeName) continue;
    const resolved = resolveMethodOnType(typeName, member, ref, context, 0.85, 'instance-method');
    if (resolved) return resolved;
  }
  return null;
}

function resolveStaticMember(
  container: Node,
  ref: UnresolvedRef,
  localName: string,
  context: ResolutionContext
): Node | undefined {
  if (!STATIC_MEMBER_CONTAINERS.has(container.kind)) return undefined;
  // First segment after the receiver: `Foo.bar.baz` → `bar`.
  const member = ref.referenceName.slice(localName.length + 1).split('.')[0];
  if (!member) return undefined;

  const candidates = context
    .getNodesByQualifiedName(`${container.qualifiedName}::${member}`)
    .filter((n) => n.filePath === container.filePath);
  if (candidates.length === 0) return undefined;

  // When the reference is a call, prefer a callable member if several nodes
  // share the qualifiedName (e.g. a static property and a method).
  if (ref.referenceKind === 'calls') {
    const callable = candidates.find((n) => n.kind === 'method' || n.kind === 'function');
    if (callable) return callable;
  }
  return candidates[0];
}
