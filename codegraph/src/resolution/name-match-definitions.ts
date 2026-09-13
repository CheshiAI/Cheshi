import { Node } from '../types';
import {
  AMBIGUOUS_NAME_CEILING,
  applyLanguageGate,
  findBestMatch,
  isLexicallyReachable,
  preferCallSiteFile,
  sameLanguageFamily,
} from './name-match-candidates';
import { computePathProximity } from './name-match-files';
import { nmTimedT } from './name-match-profile';
import { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

/**
 * Resolve a function-as-value reference (#756) — a function name used as a
 * callback/function-pointer value (`register(handler)`, `o->cb = handler`,
 * `{ .cb = handler }`, `signal(SIGINT, handler)`). The ONLY strategy allowed
 * for `function_ref` refs: exact name, function/method targets only, same
 * language family, same-file first, and cross-file only when the match is
 * UNIQUE. No fuzzy fallback, no qualified-name walking — a wrong callback
 * edge is worse than none.
 */
export function matchFunctionRef(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // `this.<member>` refs are resolved ONLY by the class-scoped resolver in
  // resolveOne (resolveThisMemberFnRef) — never by name matching here.
  if (ref.referenceName.startsWith('this.')) return null;

  // In JS/TS/Python a bare identifier can never be a method value (methods
  // are only reachable through a receiver — `this.m` / `self.m` /
  // `Cls.m`), so bare fn-refs match FUNCTIONS only. This also sidesteps the
  // pre-existing TS quirk of class fields extracting as method-kind nodes,
  // which otherwise soaked up local names passed as arguments (excalidraw
  // A/B finding; same pattern in vendored docopt.py). Python's `self.m`
  // form keeps method targets via its own capture shape. C++ likewise: a
  // bare identifier can only be a FREE function (member values need
  // `&Cls::method`). PHP string callables name global FUNCTIONS (methods
  // need the `[$obj, 'm']` array form, which carries its own shape). Other
  // languages keep method targets: C# method groups, Swift/Dart
  // implicit-self, Java/Kotlin method references.
  const bareFnOnly =
    ref.language === 'typescript' || ref.language === 'tsx' ||
    ref.language === 'javascript' || ref.language === 'jsx' ||
    ref.language === 'arkts' ||
    ref.language === 'cpp' || ref.language === 'python' ||
    ref.language === 'php';

  // Python additionally accepts CLASS targets for bare identifiers (#1478):
  // class-as-value is a core Python idiom (`return SomeSerializer`,
  // `Meta.model = Org`, registry dicts, `admin.site.register(Model, Admin)`)
  // and, unlike TS, Python has no type-annotation recovery path. The
  // false-positive mechanism behind the function-only rule was lowercase
  // locals colliding with same-named METHODS (docopt.py) — a candidate must
  // be an exact-name CLASS node here, and the extraction gate (same-file
  // class ∪ imports) plus unique-or-drop still apply. Methods stay excluded.
  const bareClassOk = ref.language === 'python';

  // Qualified member-pointer (`&Widget::on_click` → "Widget::on_click"):
  // resolve the member ON THAT SCOPE — exempt from bareFnOnly (the `&Cls::m`
  // shape is an explicit member reference). Unique-or-drop like everything else.
  if (ref.referenceName.includes('::')) {
    const memberName = ref.referenceName.slice(ref.referenceName.lastIndexOf('::') + 2);
    const scoped = context
      .getNodesByName(memberName)
      .filter(
        (n) =>
          (n.kind === 'function' || n.kind === 'method') &&
          sameLanguageFamily(n.language, ref.language) &&
          n.id !== ref.fromNodeId &&
          (n.qualifiedName === ref.referenceName ||
            n.qualifiedName.endsWith(`::${ref.referenceName}`))
      );
    if (scoped.length === 0) return null;
    const sameFileScoped = scoped.filter((n) => n.filePath === ref.filePath);
    const pool = sameFileScoped.length > 0 ? sameFileScoped : scoped;
    if (sameFileScoped.length === 0 && scoped.length > 1) return null;
    const target = pool.reduce((a, b) => (a.startLine <= b.startLine ? a : b));
    return {
      original: ref,
      targetNodeId: target.id,
      confidence: 0.9,
      resolvedBy: 'function-ref',
    };
  }

  let candidates = context
    .getNodesByName(ref.referenceName)
    .filter(
      (n) =>
        (n.kind === 'function' ||
          (!bareFnOnly && n.kind === 'method') ||
          (bareClassOk && n.kind === 'class')) &&
        sameLanguageFamily(n.language, ref.language) &&
        n.id !== ref.fromNodeId // a function registering itself is not a dependency edge
    );
  if (candidates.length === 0) return null;

  // Swift implicit-self: a bare identifier can name a METHOD only of the
  // ENCLOSING type (`Button(action: handleTap)` written inside that type) —
  // a same-named method on any OTHER class is a parameter collision
  // (Alamofire: a `request` parameter resolving to EventMonitor::request).
  // Scope method candidates to the from-symbol's type; top-level code has no
  // implicit self, so method targets are excluded there entirely. Free
  // functions are unaffected.
  if (ref.language === 'swift' && candidates.some((n) => n.kind === 'method')) {
    const fromNode = context.getNodeById?.(ref.fromNodeId);
    const sep = fromNode ? fromNode.qualifiedName.lastIndexOf('::') : -1;
    const classPrefix = fromNode && sep > 0 ? fromNode.qualifiedName.slice(0, sep) : null;
    candidates = candidates.filter((n) => {
      if (n.kind !== 'method') return true;
      if (!classPrefix) return false;
      const mSep = n.qualifiedName.lastIndexOf('::');
      if (mSep <= 0) return false;
      const methodPrefix = n.qualifiedName.slice(0, mSep);
      // Accept exact-scope matches plus suffix relationships either way, so
      // extension-declared members (`Holder::m`) still match a nested
      // from-scope (`Module::Holder::wire`) and vice versa.
      return (
        methodPrefix === classPrefix ||
        methodPrefix.endsWith(`::${classPrefix}`) ||
        classPrefix.endsWith(`::${methodPrefix}`)
      );
    });
    if (candidates.length === 0) return null;
  }

  // Same-file definition wins — the extraction gate guarantees most survivors
  // have one, and it's the dominant C pattern (static callback registered in
  // a same-file ops struct).
  const sameFile = candidates.filter((n) => n.filePath === ref.filePath);
  if (sameFile.length > 0) {
    // Swift: several same-named METHODS in one file is an API overload family
    // (`Session.request(...)` × N), and a bare identifier hitting it is almost
    // always a same-named parameter, not a method value (Alamofire A/B
    // finding) — refuse rather than guess. A single method (SwiftUI's
    // `action: handleTap`) still resolves.
    if (
      ref.language === 'swift' &&
      sameFile.length > 1 &&
      sameFile.every((n) => n.kind === 'method')
    ) {
      return null;
    }
    // Same-name overloads in one file are the same conceptual symbol; pick
    // the first by position for determinism.
    const target = sameFile.reduce((a, b) => (a.startLine <= b.startLine ? a : b));
    return {
      original: ref,
      targetNodeId: target.id,
      confidence: sameFile.length === 1 ? 0.95 : 0.9,
      resolvedBy: 'function-ref',
    };
  }

  // Cross-file (imported names the import resolver didn't already claim):
  // only an unambiguous match resolves.
  if (candidates.length === 1) {
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 0.8,
      resolvedBy: 'function-ref',
    };
  }
  return null;
}

/**
 * Try to resolve a reference by exact name match
 */
export function matchByExactName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // `import`-kind nodes are import STATEMENTS, not definitions, so a reference
  // resolving to a sibling file's `import` is a meaningless edge — the real
  // import→definition resolution is the import resolver's job (resolveViaImport),
  // never name-matching here. Excluding them also removes a quadratic blow-up:
  // a ubiquitous package (`react`, `@superset-ui/core`, Python `logging`/`typing`)
  // is re-declared as an `import` node in every file that imports it, so K
  // unresolved import refs each scored K same-named import candidates through
  // findBestMatch — O(K²) per package, the dominant cost of "Resolving refs" on
  // large import-heavy (front-end + back-end) repos (#915).
  const candidates = applyLanguageGate(context.getNodesByName(ref.referenceName), ref)
    .filter((n) => n.kind !== 'import')
    // Nested locals are only reachable from inside their container (#1230).
    .filter((n) => isLexicallyReachable(n, ref, context));

  if (candidates.length === 0) {
    return null;
  }

  // If only one match, use it — but penalize cross-language matches
  if (candidates.length === 1) {
    const isCrossLanguage = candidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: isCrossLanguage ? 0.5 : 0.9,
      resolvedBy: 'exact-match',
    };
  }

  // Ubiquitous-name ceiling (#999): above it, picking one target among K
  // same-named defs by directory proximity is unreliable AND O(K) per ref — the
  // quadratic behind the "Resolving refs" wedge on theme/SDK-vendoring repos.
  // Decline; the precise strategies (qualified-name, import, class-name) already
  // ran. Falls through to fuzzy, which itself only resolves a UNIQUE candidate.
  if (candidates.length > AMBIGUOUS_NAME_CEILING) {
    return null;
  }

  // Multiple matches - try to narrow down
  const bestMatch = findBestMatch(ref, candidates, context);
  if (bestMatch) {
    // Lower confidence when the match is from a distant/unrelated module
    const proximity = computePathProximity(ref.filePath, bestMatch.filePath);
    const confidence = proximity >= 30 ? 0.7 : 0.4;
    return {
      original: ref,
      targetNodeId: bestMatch.id,
      confidence,
      resolvedBy: 'exact-match',
    };
  }

  return null;
}

/**
 * Try to resolve by qualified name
 */
export function matchByQualifiedName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Check if the reference name looks qualified (contains :: or .)
  if (!ref.referenceName.includes('::') && !ref.referenceName.includes('.')) {
    return null;
  }

  // A method call `receiver.method()` can share an exact qualified name with a
  // config-file key: `service.process()` (a `calls` ref named `service.process`)
  // vs the yaml key `service.process`. Config keys are bound to their code refs
  // upstream by the framework resolvers (`@Value` → `references`); a `calls` ref
  // must never resolve to a yaml/properties config node — that's a wrong edge
  // AND it hides the real callee. Drop those from both the exact and the partial
  // candidate sets so resolution falls through to method resolution below (#1180).
  const keepForRef = (nodes: Node[]): Node[] =>
    ref.referenceKind === 'calls'
      ? nodes.filter(
        (n) => !(n.kind === 'constant' && (n.language === 'yaml' || n.language === 'properties')),
      )
      : nodes;

  const candidates = keepForRef(context.getNodesByQualifiedName(ref.referenceName));

  if (candidates.length === 1) {
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 0.95,
      resolvedBy: 'qualified-name',
    };
  }

  // Several symbols share this exact qualified name (e.g. `Logger::log` declared
  // in two files — an ODR clash or separate translation units): prefer the one
  // in the call site's own file before the partial-match fallback below, else
  // the first-indexed def wins and a call in `b/svc` targets `a/svc` (#1079).
  if (candidates.length > 1) {
    const ordered = preferCallSiteFile(candidates, ref.filePath);
    if (ordered[0]!.filePath === ref.filePath) {
      return {
        original: ref,
        targetNodeId: ordered[0]!.id,
        confidence: 0.95,
        resolvedBy: 'qualified-name',
      };
    }
  }

  // Try partial qualified name match — again preferring the call site's own
  // file when more than one symbol's qualifiedName ends with the reference.
  const parts = ref.referenceName.split(/[:.]/);
  const lastName = parts[parts.length - 1];
  if (lastName) {
    const partialCandidates = keepForRef(context.getNodesByName(lastName))
      .filter((candidate) => candidate.qualifiedName.endsWith(ref.referenceName));
    const chosen = preferCallSiteFile(partialCandidates, ref.filePath)[0];
    if (chosen) {
      return {
        original: ref,
        targetNodeId: chosen.id,
        confidence: 0.85,
        resolvedBy: 'qualified-name',
      };
    }
  }

  return null;
}

// Exported for the precedence unit tests (#1079): they assert the
// preferredFqn → same-file → matches[0] ordering directly.
export function resolveMethodOnType(
  typeName: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  confidence: number,
  resolvedBy: ResolvedRef['resolvedBy'],
  /**
   * Optional FQN that identifies WHICH class declaration `typeName`
   * refers to in the caller's file. When multiple candidates share
   * the same qualifiedName (`FooConverter::convert` in both
   * `dao/converter/` and `service/converter/`), the FQN's
   * file-path-suffix picks the right one — the disambiguation
   * signal Java imports carry but the call site doesn't (#314).
   */
  preferredFqn?: string,
  /** Recursion guard for the supertype/conformance walk. */
  depth = 0,
): ResolvedRef | null {
  // Look up methods by name and match by qualifiedName ending in
  // `<typeName>::<methodName>`. This works whether the method is defined
  // in-class (`class Foo { int bar() { ... } }`) or out-of-line in a separate
  // file (`int Foo::bar() { ... }` in foo.cpp while class Foo is in foo.hpp).
  // The previous same-file approach missed the latter — the typical C++ layout.
  // Prefer the context's per-(type, method) memo: the raw name lookup fetches
  // EVERY node sharing the method name — tens of thousands of rows for a
  // collision-heavy Java name like `execute` — and re-filtering that per ref
  // was a dominant term in the #1122 watchdog kill on large repos. Only the
  // ref-independent filter is memoized; per-ref disambiguation stays below.
  let matches: Node[];
  if (context.getMethodMatches) {
    matches = context.getMethodMatches(typeName, methodName, ref.language);
  } else {
    const methodCandidates = context.getNodesByName(methodName);
    const want = `${typeName}::${methodName}`;
    matches = [];
    for (const m of methodCandidates) {
      if (m.kind !== 'method') continue;
      if (m.language !== ref.language) continue;
      const qn = m.qualifiedName;
      if (qn === want || qn.endsWith(`::${want}`)) {
        matches.push(m);
      }
    }
  }
  if (matches.length === 0) {
    // Conformance fallback: the method may be defined on a supertype `typeName`
    // extends, or on a protocol / trait it conforms to (e.g. a Swift protocol-
    // extension method, a C# default-interface or extension method, a Kotlin
    // extension on a supertype). Walk supertypes transitively (depth-capped) via
    // the resolved implements/extends edges — empty in the first resolution pass,
    // populated in the conformance pass. Still VALIDATED (the method must exist on
    // a supertype), so a wrong inference produces no edge.
    if (depth < 4 && context.getSupertypes) {
      const viaSupers = nmTimedT('rmot-supers', ref, (): ResolvedRef | null => {
        for (const supertype of context.getSupertypes!(typeName, ref.language)) {
          const via = resolveMethodOnType(
            supertype, methodName, ref, context, confidence, resolvedBy, preferredFqn, depth + 1,
          );
          if (via) return via;
        }
        return null;
      });
      if (viaSupers) return viaSupers;
    }
    return null;
  }

  if (matches.length > 1 && preferredFqn) {
    const ext = ref.language === 'kotlin' ? '.kt' : '.java';
    const fqnPath = preferredFqn.replace(/\./g, '/') + ext;
    const chosen = matches.find((m) => {
      const fp = m.filePath.replace(/\\/g, '/');
      return fp.endsWith(fqnPath) || fp.endsWith('/' + fqnPath);
    });
    if (chosen) {
      return {
        original: ref,
        targetNodeId: chosen.id,
        confidence,
        resolvedBy,
      };
    }
  }

  // Language-agnostic disambiguation: when several same-named methods survive
  // (e.g. two files each declaring `class Logger { void log(); }` — an ODR
  // clash, an anonymous-namespace type, or separate translation units), prefer
  // the definition in the CALL SITE's own file. Without this, every ambiguous
  // call collapses onto the first-indexed definition, so a call in `b/svc.cpp`
  // wrongly points at `a/svc.cpp` (#1079). This runs AFTER the `preferredFqn`
  // block, so Java/Kotlin import disambiguation — whose target is intentionally
  // in ANOTHER file (#314) — is unaffected: that block returns early whenever
  // an import FQN pins the class.
  const ordered = preferCallSiteFile(matches, ref.filePath);
  return {
    original: ref,
    targetNodeId: ordered[0]!.id,
    confidence,
    resolvedBy,
  };
}
