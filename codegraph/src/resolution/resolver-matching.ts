import { UnresolvedReference } from '../types';
import { isJavaScriptCall } from './name-match-candidates';
import {
  isCobolCopybookRef,
  isNixPathImportRef,
  isPhpIncludePathRef,
  resolveJvmImport,
  resolveViaImport
} from './import-resolver';
import {
  crossesKnownFamily,
  matchFunctionRef,
  matchReference,
  sameLanguageFamily
} from './name-matcher';
import {
  C_BUILT_INS,
  CHAIN_LANGUAGES,
  CHAIN_SHAPE,
  CPP_BUILT_INS,
  GO_BUILT_INS,
  GO_STDLIB_PACKAGES,
  JS_BUILT_INS,
  PASCAL_BUILT_INS,
  PASCAL_UNIT_PREFIXES,
  PHP_PROP_SHAPE,
  PYTHON_BUILT_IN_METHODS,
  PYTHON_BUILT_IN_TYPES,
  PYTHON_BUILT_INS,
  REACT_HOOKS
} from './resolver-rules';
import type { ResolverState } from './resolver-state';
import {
  ResolutionResult,
  ResolvedRef,
  UnresolvedRef
} from './types';


/**
   * Resolve all unresolved references
   */
export function resolveAll(this: ResolverState, unresolvedRefs: UnresolvedReference[], onProgress?: (current: number, total: number) => void): ResolutionResult {
  // Pre-load all nodes into memory for fast lookups
  this.owner.warmCaches();

  const resolved: ResolvedRef[] = [];
  const unresolved: UnresolvedRef[] = [];
  const byMethod: Record<string, number> = {};

  // Convert to our internal format, using denormalized fields when available
  const refs: UnresolvedRef[] = unresolvedRefs.map((ref) => ({
    fromNodeId: ref.fromNodeId,
    referenceName: ref.referenceName,
    referenceKind: ref.referenceKind,
    line: ref.line,
    column: ref.column,
    filePath: ref.filePath || this.getFilePathFromNodeId(ref.fromNodeId),
    language: ref.language || this.getLanguageFromNodeId(ref.fromNodeId),
    rowId: ref.rowId,
  }));

  const total = refs.length;
  let lastReportedPercent = -1;

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]!; // Array index is guaranteed to be in bounds
    const result = this.resolveOneTimed(ref);

    if (result) {
      resolved.push(result);
      byMethod[result.resolvedBy] = (byMethod[result.resolvedBy] || 0) + 1;
    } else {
      unresolved.push(ref);
    }

    // Report progress every 1% to avoid too many updates
    if (onProgress) {
      const currentPercent = Math.floor((i / total) * 100);
      if (currentPercent > lastReportedPercent) {
        lastReportedPercent = currentPercent;
        onProgress(i + 1, total);
      }
    }
  }

  // Final progress report
  if (onProgress && total > 0) {
    onProgress(total, total);
  }

  return {
    resolved,
    unresolved,
    stats: {
      total: refs.length,
      resolved: resolved.length,
      unresolved: unresolved.length,
      byMethod,
    },
  };
}

/**
   * Check if a reference name has any possible match in the codebase.
   * Uses the pre-built knownNames set to skip expensive resolution
   * for names that definitely don't exist as symbols.
   */
export function hasAnyPossibleMatch(this: ResolverState, name: string): boolean {
  if (!this.knownNames) return true; // no pre-filter available

  // Direct name match
  if (this.knownNames.has(name)) return true;

  // For qualified names like "obj.method" or "Class::method", check the parts
  const dotIdx = name.indexOf('.');
  if (dotIdx > 0) {
    const receiver = name.substring(0, dotIdx);
    const member = name.substring(dotIdx + 1);
    if (this.knownNames.has(receiver) || this.knownNames.has(member)) return true;
    // Also check capitalized receiver (instance-method resolution)
    const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
    if (this.knownNames.has(capitalized)) return true;
    // JVM FQN: `com.example.foo.Bar` — the only useful segment is the
    // last one (`Bar`); the earlier check finds `example.foo.Bar` which
    // never matches a node name.
    const lastDot = name.lastIndexOf('.');
    if (lastDot > dotIdx) {
      const tail = name.substring(lastDot + 1);
      if (tail && this.knownNames.has(tail)) return true;
    }
  }
  const colonIdx = name.indexOf('::');
  if (colonIdx > 0) {
    const receiver = name.substring(0, colonIdx);
    const member = name.substring(colonIdx + 2);
    if (this.knownNames.has(receiver) || this.knownNames.has(member)) return true;
    // Multi-segment path `a::b::c` (a Rust/C++ module call like
    // `database::profiles::find`) — the only segment that names a symbol is
    // the last (`c`); `member` above is `b::c`, which never matches a node
    // name, so without this the pre-filter drops the ref before the Rust path
    // resolver ever sees it. Mirror the dotted-name leaf check above.
    const lastColon = name.lastIndexOf('::');
    if (lastColon > colonIdx) {
      const tail = name.substring(lastColon + 2);
      if (tail && this.knownNames.has(tail)) return true;
    }
  }

  // Lua/Luau method calls use a single `:` (`lg:log`); R uses `$` (`lg$log`).
  // Check the member (and receiver) around these separators too, so the ref
  // isn't dropped here before the method-call resolver ever sees it. The `:`
  // case is skipped when the name actually contains `::` (handled above).
  for (const sep of [':', '$']) {
    if (sep === ':' && name.includes('::')) continue;
    const sepIdx = name.indexOf(sep);
    if (sepIdx > 0) {
      const receiver = name.substring(0, sepIdx);
      const member = name.substring(sepIdx + 1);
      if (this.knownNames.has(member) || this.knownNames.has(receiver)) return true;
      const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
      if (this.knownNames.has(capitalized)) return true;
    }
  }

  // For path-like references (e.g., "snippets/drawer-menu.liquid"), check the filename
  const slashIdx = name.lastIndexOf('/');
  if (slashIdx > 0) {
    const fileName = name.substring(slashIdx + 1);
    if (this.knownNames.has(fileName)) return true;
  }

  return false;
}

/**
   * Does `ref.referenceName` match an import declared in its containing
   * file? Used as a pre-filter escape so re-export chain resolution
   * still gets a chance when the name has no project-wide declaration.
   */
export function matchesAnyImport(this: ResolverState, ref: UnresolvedRef): boolean {
  const imports = this.context.getImportMappings(ref.filePath, ref.language);
  if (imports.length === 0) return false;
  for (const imp of imports) {
    if (
      imp.localName === ref.referenceName ||
      ref.referenceName.startsWith(imp.localName + '.')
    ) {
      return true;
    }
  }
  return false;
}

/**
   * Resolve a single reference
   */
export function resolveOne(this: ResolverState, ref: UnresolvedRef): ResolvedRef | null {
  // Skip built-in/external references
  if (this.isBuiltInOrExternal(ref)) {
    return null;
  }

  if (isJavaScriptCall(ref) && /^(?:this|super)\.[$\w]+$/.test(ref.referenceName)) {
    return this.gateLanguage(this.resolveThisMemberFnRef(ref), ref);
  }

  // CFML component paths in inheritance (#1152): `extends="coldbox.system.web.
  // Controller"` names the supertype by its dot-separated path (or `extends=
  // "../base"` by relative file path) — the graph indexes the class under its
  // final segment only, so these die at the fast pre-filter below and never
  // resolved. Handled by a dedicated path-corroborated matcher, gated to
  // inheritance refs only (a dotted `calls` ref is a member-access chain, not
  // a component path). No fallthrough on miss: the full path string can only
  // ever mis-match downstream, and an unresolvable supertype usually lives in
  // an out-of-repo library (mxunit, testbox) — silent beats wrong.
  if (
    (ref.language === 'cfml' || ref.language === 'cfscript') &&
    (ref.referenceKind === 'extends' || ref.referenceKind === 'implements') &&
    (ref.referenceName.includes('.') || ref.referenceName.includes('/'))
  ) {
    return this.resolveCfmlComponentPath(ref);
  }

  // Fast pre-filter: skip if no symbol with this name exists anywhere
  // AND the name doesn't match a local import. The import escape is
  // necessary because re-export rename chains (`import { login }
  // from './barrel'` where the barrel has `export { signIn as login }
  // from './auth'`) intentionally call a name that has no
  // declaration anywhere — only the renamed upstream symbol does.
  // ArkTS chained-attribute refs carry a leading dot (`.titleStyle`) that
  // routes them to the decorator-gated matcher; the symbol itself is
  // indexed under the bare name, so the existence check strips the dot.
  // Nix static path imports (`import ./x.nix`) name a FILE, not a symbol —
  // they bypass the symbol-existence check and resolve via resolveViaImport.
  const existenceName =
    ref.language === 'arkts' && ref.referenceName.startsWith('.')
      ? ref.referenceName.slice(1)
      : ref.referenceName;
  const tPre = this.profileStages ? process.hrtime.bigint() : 0n;
  const preFilterPass =
    isNixPathImportRef(ref) ||
    this.hasAnyPossibleMatch(existenceName) ||
    this.matchesAnyImport(ref) ||
    this.frameworks.some((f) => f.claimsReference?.(ref.referenceName));
  if (this.profileStages) this.stageAdd('preFilter', ref, preFilterPass, tPre);
  if (!preFilterPass) {
    return null;
  }

  // Function-as-value refs (#756) get a dedicated, strictly-gated path:
  // import-based resolution first (an imported callback resolves through its
  // import, the most precise cross-file signal), then matchFunctionRef
  // (same-file first, unique-only cross-file, function/method targets only).
  // They never reach the framework or fuzzy strategies below.
  if (ref.referenceKind === 'function_ref') {
    // `this.<member>` values (TS/JS) resolve ONLY against the enclosing
    // class's own members — never a same-named symbol elsewhere.
    if (ref.referenceName.startsWith('this.')) {
      return this.gateLanguage(this.resolveThisMemberFnRef(ref), ref);
    }
    const viaImport = this.gateLanguage(resolveViaImport(ref, this.context), ref);
    if (viaImport) {
      const target = this.queries.getNodeById(viaImport.targetNodeId);
      if (
        target &&
        (target.kind === 'function' ||
          target.kind === 'method' ||
          // Python (#1478): an imported class used as a value (`return
          // OrgSerializerFull`) resolves through its import like any
          // callback — mirrors matchFunctionRef's bareClassOk.
          (ref.language === 'python' && target.kind === 'class'))
      ) {
        return viaImport;
      }
    }
    return this.gateLanguage(matchFunctionRef(ref, this.context), ref);
  }

  // JVM FQN imports skip framework/name-matcher: `import com.example.Bar`
  // resolves directly through the qualifiedName index, which is unambiguous
  // even when several `Bar` classes exist in different packages.
  const tJvm = this.profileStages ? process.hrtime.bigint() : 0n;
  const jvmImport = resolveJvmImport(ref, this.context);
  if (this.profileStages) this.stageAdd('jvmImport', ref, !!jvmImport, tJvm);
  if (jvmImport) return jvmImport;

  // Razor/Blazor: a markup or `@code` type ref resolves through the file's
  // `@using` namespaces (incl. folder `_Imports.razor`). This precisely
  // disambiguates a simple name that exists in several namespaces — e.g.
  // `CatalogBrand` resolving to `BlazorShared.Models::CatalogBrand` (the DTO,
  // which the `.razor` `@using`s) rather than the same-named domain entity.
  if (ref.language === 'razor') {
    const razorResult = this.resolveRazorUsing(ref);
    if (razorResult) return razorResult;
  }

  const candidates: ResolvedRef[] = [];

  // Strategy 1: Try framework-specific resolution. Cross-language bridges
  // are deliberately preserved (Drupal `routing.yml` → PHP controller, RN
  // JS → native `calls`) — `gateFrameworkLanguage` only drops a type/import
  // edge between two KNOWN families (see its doc), never a `calls` bridge or
  // a config↔code edge.
  const tFw = this.profileStages ? process.hrtime.bigint() : 0n;
  let fwEarly: ResolvedRef | null = null;
  for (const framework of this.frameworks) {
    const result = this.gateFrameworkLanguage(framework.resolve(ref, this.context), ref);
    if (result) {
      if (result.confidence >= 0.9) {
        fwEarly = result; // High confidence, return immediately (below)
        break;
      }
      candidates.push(result);
    }
  }
  if (this.profileStages) this.stageAdd('frameworks', ref, fwEarly !== null, tFw);
  if (fwEarly) return fwEarly;

  // Strategy 2: Try import-based resolution
  const tImp = this.profileStages ? process.hrtime.bigint() : 0n;
  const importResult = this.gateLanguage(resolveViaImport(ref, this.context), ref);
  if (this.profileStages) this.stageAdd('viaImport', ref, !!importResult, tImp);
  if (importResult) {
    if (importResult.confidence >= 0.9) return importResult;
    candidates.push(importResult);
  }

  // PHP include/require paths resolve to files via import resolution only.
  // If that didn't find the file, do NOT fall back to the symbol
  // name-matcher — it would mis-connect e.g. "inc/db.php" to an unrelated
  // db.php elsewhere in the tree (a wrong edge is worse than none, #660).
  // Terraform refs are directory-scoped by language semantics — the
  // framework resolver IS the whole rulebook (`var.X` can never legally
  // bind outside its module directory), so the name-matcher's
  // qualified-name fallback would only ever add wrong cross-module edges.
  // Nix static path imports are file references for the same reason —
  // falling through would let "./x.nix" name-match an unrelated node.
  if (isPhpIncludePathRef(ref) || isCobolCopybookRef(ref) || isNixPathImportRef(ref) || ref.language === 'terraform') {
    return candidates.length > 0
      ? candidates.reduce((best, curr) =>
        curr.confidence > best.confidence ? curr : best
      )
      : null;
  }

  // Strategy 3: Try name matching
  const tName = this.profileStages ? process.hrtime.bigint() : 0n;
  let nameResult = this.gateLanguage(matchReference(ref, this.context), ref);
  if (this.profileStages) this.stageAdd('nameMatch', ref, !!nameResult, tName);
  // Nix has no ambient cross-file namespace — a callee binds lexically
  // (same file) or through explicit import/callPackage wiring (the import
  // path above). A cross-file name match is wrong by construction: every
  // module `inherit (lib) mkOption`s the same nixpkgs helpers, so the
  // matcher would link each `mkOption` call to whichever file's inherit
  // binding it happened to pick. Same-file matches only.
  if (nameResult) {
    const target = this.queries.getNodeById(nameResult.targetNodeId);
    if (ref.language === 'nix') {
      if (!target || target.filePath !== ref.filePath) {
        nameResult = null;
      }
    } else if (target && target.language === 'nix') {
      // The reverse direction is just as impossible: no other language can
      // symbolically call into a .nix binding (interop is eval/CLI, never a
      // linkable symbol) — without this, a Python script's `split()` lands
      // on some module's `split = ...` binding as a low-confidence match.
      nameResult = null;
    }
  }
  if (nameResult) {
    candidates.push(nameResult);
  }

  if (candidates.length === 0) {
    // Defer a chained static-factory/fluent call the first pass couldn't
    // resolve — its method may live on a supertype the receiver conforms to,
    // resolvable once implements/extends edges exist (the conformance pass).
    if (
      ref.referenceKind === 'calls' &&
      CHAIN_LANGUAGES.has(ref.language) &&
      CHAIN_SHAPE.test(ref.referenceName)
    ) {
      this.deferredChainRefs.push(ref);
    } else if (
      // PHP `$this->prop->method()` (encoded `this->prop.method`): its method
      // may live on the property's declared supertype, resolvable only once
      // implements/extends edges exist — defer to the same conformance pass.
      ref.referenceKind === 'calls' &&
      ref.language === 'php' &&
      PHP_PROP_SHAPE.test(ref.referenceName)
    ) {
      this.deferredChainRefs.push(ref);
    }
    return null;
  }

  // Return highest confidence candidate
  return candidates.reduce((best, curr) =>
    curr.confidence > best.confidence ? curr : best
  );
}

/**
   * Check if reference is to a built-in or external symbol
   */
export function isBuiltInOrExternal(this: ResolverState, ref: UnresolvedRef): boolean {
  const name = ref.referenceName;
  const isJsTs = ref.language === 'typescript' || ref.language === 'javascript'
    || ref.language === 'tsx' || ref.language === 'jsx' || ref.language === 'arkts';

  // JavaScript/TypeScript built-ins
  if (isJsTs && JS_BUILT_INS.has(name)) {
    return true;
  }

  // ArkTS resource-reference intrinsics — `$r('app.string.x')` /
  // `$rawfile('x.png')` are framework-provided and appear dozens of times
  // per UI file; without this they can resolve to a stray same-named
  // symbol (e.g. a checked-in hvigor wrapper's `$r`).
  if (ref.language === 'arkts' && (name === '$r' || name === '$rawfile')) {
    return true;
  }

  // Common JS/TS library calls (console.log, Math.floor, JSON.parse)
  if (isJsTs && (name.startsWith('console.') || name.startsWith('Math.') || name.startsWith('JSON.'))) {
    return true;
  }

  // React hooks from React itself
  if (isJsTs && REACT_HOOKS.has(name)) {
    return true;
  }

  // Python built-ins (bare calls only — dotted calls like console.print are method calls)
  if (ref.language === 'python' && PYTHON_BUILT_INS.has(name)) {
    return true;
  }

  // Python built-in method calls (e.g., list.extend, dict.update)
  if (ref.language === 'python') {
    const dotIdx = name.indexOf('.');
    if (dotIdx > 0) {
      const receiver = name.substring(0, dotIdx);
      const method = name.substring(dotIdx + 1);
      // Filter calls on built-in types (list.append, dict.update, etc.)
      if (PYTHON_BUILT_IN_TYPES.has(receiver)) {
        return true;
      }
      // Filter built-in methods on non-class receivers
      // (e.g., items.append where items is a local list variable)
      // But allow if the capitalized receiver matches a known codebase class
      if (PYTHON_BUILT_IN_METHODS.has(method)) {
        const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
        if (!this.knownNames?.has(capitalized)) {
          return true;
        }
      }
    }
    // A bare name colliding with a builtin method (index, get, update, count…)
    // is only a builtin when NOTHING in the codebase declares it. A declared
    // symbol with that exact name — e.g. a Flask/FastAPI view `def index()` or
    // `def get()` — is a real reference target. Mirrors the knownNames guard on
    // the dotted branch above; without it, every handler named after a builtin
    // method silently loses its route→handler edge.
    if (PYTHON_BUILT_IN_METHODS.has(name) && !this.knownNames?.has(name)) {
      return true;
    }
  }

  // Go standard library packages — refs like "fmt.Println", "http.ListenAndServe", etc.
  if (ref.language === 'go') {
    const dotIdx = name.indexOf('.');
    if (dotIdx > 0) {
      const pkg = name.substring(0, dotIdx);
      if (GO_STDLIB_PACKAGES.has(pkg)) {
        return true;
      }
    }
    if (GO_BUILT_INS.has(name)) {
      return true;
    }
  }

  // Pascal/Delphi built-ins and standard library units
  if (ref.language === 'pascal') {
    if (PASCAL_UNIT_PREFIXES.some((p) => name.startsWith(p))) {
      return true;
    }
    if (PASCAL_BUILT_INS.has(name)) {
      return true;
    }
  }

  // C/C++ standard library symbols (printf, malloc, std::vector, etc.).
  // Names that collide with user-defined symbols are NOT filtered —
  // C and C++ projects routinely shadow stdlib names (custom allocators
  // define `malloc`/`free`, stream wrappers define `read`/`write`/`open`,
  // containers define `move`/`swap`, logging libs wrap `printf`). Killing
  // those resolutions makes the graph wrong, not cleaner. We only filter
  // when there's no user node with this name — then name-matching would
  // produce zero edges anyway and the filter just short-circuits work.
  if (ref.language === 'c' || ref.language === 'cpp') {
    // C++ std:: namespace prefix — safe to filter unconditionally,
    // since `std::foo` is never a user-defined qualified name in
    // tree-sitter output.
    if (name.startsWith('std::')) return true;
    if (C_BUILT_INS.has(name) || CPP_BUILT_INS.has(name)) {
      return !this.hasAnyPossibleMatch(name);
    }
  }

  return false;
}

/**
   * Get file path from node ID
   */
export function getFilePathFromNodeId(this: ResolverState, nodeId: string): string {
  const node = this.queries.getNodeById(nodeId);
  return node?.filePath || '';
}

/**
   * Get language from node ID
   */
export function getLanguageFromNodeId(this: ResolverState, nodeId: string): UnresolvedRef['language'] {
  const node = this.queries.getNodeById(nodeId);
  return node?.language || 'unknown';
}

export function gateLanguage(this: ResolverState, result: ResolvedRef | null, ref: UnresolvedRef): ResolvedRef | null {
  if (!result) return result;
  const tgt = this.getLanguageFromNodeId(result.targetNodeId);
  if (!tgt || !ref.language) return result;
  if ((ref.referenceKind === 'references' || ref.referenceKind === 'function_ref') && !sameLanguageFamily(tgt, ref.language)) return null;
  if (ref.referenceKind === 'imports' && crossesKnownFamily(tgt, ref.language)) return null;
  return result;
}

/**
   * Drop a FRAMEWORK-strategy resolution that crosses two *known* language
   * families for a type-usage (`references`) or import-binding (`imports`)
   * edge. The framework strategy is intentionally ungated for cross-language
   * bridges, but those legitimate bridges are either `calls` edges (RN/Expo
   * JS → native) or config↔code edges whose config side (`yaml`/`blade`/…) is
   * not a known programming-language family. A `references`/`imports` edge
   * between two *known* families is always a coincidental name collision — the
   * React/Svelte/Vue PascalCase component resolvers name-match `getNodesByName`
   * without a language check, so a TS `<TestRunner>` ref happily matched a
   * Kotlin `class TestRunner`. Gating only the both-known-cross-family case
   * lets config bridges and `calls` bridges through untouched.
   */
export function gateFrameworkLanguage(this: ResolverState, result: ResolvedRef | null, ref: UnresolvedRef): ResolvedRef | null {
  if (!result) return result;
  if (ref.referenceKind !== 'references' && ref.referenceKind !== 'imports') return result;
  const tgt = this.getLanguageFromNodeId(result.targetNodeId);
  if (tgt && ref.language && crossesKnownFamily(tgt, ref.language)) return null;
  return result;
}
