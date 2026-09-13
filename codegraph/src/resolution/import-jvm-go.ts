import { ImportMapping, ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

/**
 * Resolve a Java/Kotlin reference whose receiver is the simple name of
 * an imported FQN: `Foo.bar(...)` where `import com.example.Foo;`. The
 * imported FQN converts to a file-path suffix (`com/example/Foo.java`
 * or `.kt`) which uniquely identifies the right symbol when multiple
 * classes share the same simple name.
 *
 * Also handles bare references to the imported class itself
 * (`new Foo()` extraction emits `Foo` as a `references`/`instantiates`
 * ref) and `import static <Foo>.bar` style imports of a single member.
 */
export function resolveJavaImportedReference(
  ref: UnresolvedRef,
  imports: ImportMapping[],
  context: ResolutionContext
): ResolvedRef | null {
  if (imports.length === 0) return null;

  const ext = ref.language === 'kotlin' ? '.kt' : '.java';

  for (const imp of imports) {
    const matchesBare = imp.localName === ref.referenceName;
    const matchesQualified = ref.referenceName.startsWith(imp.localName + '.');
    if (!matchesBare && !matchesQualified) continue;

    // Convert FQN to a file-path suffix. `com.example.Foo` ->
    // `com/example/Foo.java` (or `.kt`). The actual file may live
    // under any source root (`src/main/java/`, `src/`, etc.), so match
    // by suffix rather than exact path.
    const fqnPath = imp.source.replace(/\./g, '/') + ext;

    // Which symbol name to look up: the class itself, or a member.
    const memberName = matchesBare
      ? imp.localName
      : ref.referenceName.substring(imp.localName.length + 1);

    const candidates = context.getNodesByName(memberName);
    for (const node of candidates) {
      if (node.language !== ref.language) continue;
      const fp = node.filePath.replace(/\\/g, '/');
      if (fp.endsWith(fqnPath) || fp.endsWith('/' + fqnPath)) {
        return {
          original: ref,
          targetNodeId: node.id,
          confidence: 0.9,
          resolvedBy: 'import',
        };
      }
    }

    // `import static com.example.Foo.bar;` — the FQN's tail is the
    // member name, the part before is the owner class. Look up the
    // member named `<imp.localName>` (e.g. `bar`) and prefer the
    // candidate whose file matches the parent FQN's path.
    if (matchesBare) {
      const dot = imp.source.lastIndexOf('.');
      if (dot > 0) {
        const ownerFqn = imp.source.substring(0, dot);
        const ownerPath = ownerFqn.replace(/\./g, '/') + ext;
        for (const node of candidates) {
          if (node.language !== ref.language) continue;
          const fp = node.filePath.replace(/\\/g, '/');
          if (fp.endsWith(ownerPath) || fp.endsWith('/' + ownerPath)) {
            return {
              original: ref,
              targetNodeId: node.id,
              confidence: 0.9,
              resolvedBy: 'import',
            };
          }
        }
      }
    }
  }
  return null;
}

/**
 * Resolve a Go cross-package qualified reference (`pkga.FuncX`) by matching
 * the package alias against an in-module import, stripping the module prefix
 * to a project-relative directory, and locating the exported symbol in any
 * `.go` file under that directory. Returns `null` for stdlib / third-party
 * imports (no `go.mod`-relative match) so the rest of `resolveViaImport`
 * can still try the file-based path.
 */
export function resolveGoCrossPackageReference(
  ref: UnresolvedRef,
  imports: ImportMapping[],
  context: ResolutionContext
): ResolvedRef | null {
  const mod = context.getGoModule?.();
  if (!mod) return null;

  // Qualified call: receiver before `.`, member after. A bare reference
  // (no dot) is a same-file/in-package call — handled elsewhere.
  const dotIdx = ref.referenceName.indexOf('.');
  if (dotIdx <= 0) return null;
  const receiver = ref.referenceName.substring(0, dotIdx);
  const memberName = ref.referenceName.substring(dotIdx + 1);
  if (!memberName) return null;

  for (const imp of imports) {
    if (imp.localName !== receiver) continue;
    // Only in-module imports map to a known directory.
    if (imp.source !== mod.modulePath && !imp.source.startsWith(mod.modulePath + '/')) {
      continue;
    }
    const pkgDir = imp.source === mod.modulePath
      ? ''
      : imp.source.substring(mod.modulePath.length + 1);

    // Look up the member by name and pick the candidate whose file lives
    // directly in the package directory. Match the immediate parent dir
    // exactly so a call to `pkga.FuncX` doesn't accidentally land on a
    // `FuncX` declared in `pkga/subpkg/`.
    const candidates = context.getNodesByName(memberName);
    for (const node of candidates) {
      if (node.language !== 'go') continue;
      if (!node.isExported) continue;
      const fp = node.filePath.replace(/\\/g, '/');
      const lastSlash = fp.lastIndexOf('/');
      const fileDir = lastSlash >= 0 ? fp.substring(0, lastSlash) : '';
      if (fileDir === pkgDir) {
        return {
          original: ref,
          targetNodeId: node.id,
          confidence: 0.9,
          resolvedBy: 'import',
        };
      }
    }
  }
  return null;
}
