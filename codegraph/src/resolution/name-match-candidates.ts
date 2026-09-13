import { Node } from '../types';
import { pathProximityFromDirs } from './name-match-files';
import { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

/**
 * Ceiling on how many same-named definitions a FUZZY name-match strategy will
 * score. A name defined more times than this is "ubiquitous" — a method/symbol
 * re-declared across a vendored theme or SDK (e.g. `init`/`update`/`render` on
 * every widget of a committed Metronic theme — #999). No directory-proximity or
 * receiver-word-overlap score can reliably pick THE one true target among
 * thousands, so the fuzzy strategies (matchByExactName's findBestMatch, and
 * matchMethodCall Strategy 3) decline above the ceiling instead of emitting a
 * low-confidence, almost-certainly-wrong edge. This also caps their per-ref cost
 * at O(ceiling): without it, K same-named refs each scored K candidates — the
 * O(K²) blow-up that pinned a core for 15-28 min at "Resolving refs … 94%" on a
 * repo vendoring a large JS/TS theme (#999). The PRECISE strategies are
 * unaffected: qualified-name, import-based, and class-name (Strategy 1/2)
 * resolution all still run and resolve a ubiquitous name when the context names
 * its exact target. Real repos top out near ~40 same-named methods, so a normal
 * codebase never reaches this; only bulk-vendored code does. Tune via
 * `CODEGRAPH_AMBIGUOUS_NAME_CEILING`.
 */
const DEFAULT_AMBIGUOUS_NAME_CEILING = 500;

function resolveAmbiguousNameCeiling(): number {
  const raw = process.env.CODEGRAPH_AMBIGUOUS_NAME_CEILING;
  if (!raw) return DEFAULT_AMBIGUOUS_NAME_CEILING;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AMBIGUOUS_NAME_CEILING;
}

export const AMBIGUOUS_NAME_CEILING = resolveAmbiguousNameCeiling();

/**
 * Language families that share a type system / runtime, so a same-language-only
 * reference may still resolve across them (a Kotlin `Foo.BAR` can name a Java
 * `Foo`). Anything not listed forms its own singleton family.
 */
const LANGUAGE_FAMILY: Record<string, string> = {
  java: 'jvm', kotlin: 'jvm', scala: 'jvm',
  swift: 'apple', objc: 'apple',
  // ArkTS is a TS superset — every HarmonyOS project mixes `.ets` UI with
  // `.ts` logic modules, so refs must cross freely between them.
  typescript: 'web', tsx: 'web', javascript: 'web', jsx: 'web', arkts: 'web',
  c: 'c', cpp: 'c',
  // Razor/Blazor markup names C# types — same family so `@model Foo` /
  // `<MyComponent/>` resolve to their `.cs` class through the cross-family gate.
  csharp: 'dotnet', razor: 'dotnet',
};

export function sameLanguageFamily(a: string, b: string): boolean {
  if (a === b) return true;
  const fa = LANGUAGE_FAMILY[a];
  return fa !== undefined && fa === LANGUAGE_FAMILY[b];
}

/**
 * True when `lang` belongs to a known multi-language family (jvm/apple/web/c).
 * Languages not listed (php, python, go, ruby, rust, dart, …) and config
 * formats (yaml/xml/blade) form their own singleton families and return
 * `false` — used to leave config↔code framework bridges (whose config side is
 * never a known programming-language family) out of the cross-family gate.
 */
export function isKnownLanguageFamily(lang: string): boolean {
  return LANGUAGE_FAMILY[lang] !== undefined;
}

/**
 * True when `a` and `b` are two DIFFERENT *known* language families — the
 * signature of a coincidental cross-language name collision (a TS `import
 * React` matching a Swift `import React`, a C++ `#include "X.h"` matching a
 * same-named ObjC header on another platform). The both-*known* test is
 * deliberately weaker than {@link sameLanguageFamily}'s negation: a
 * single-file-component language that carries its own tag (`vue`/`svelte`)
 * importing a `.ts` module, or any singleton-family language (php/go/ruby/…),
 * returns `false` here and is left alone.
 */
export function crossesKnownFamily(a: string, b: string): boolean {
  return isKnownLanguageFamily(a) && isKnownLanguageFamily(b) && !sameLanguageFamily(a, b);
}

export function isJavaScriptCall(ref: UnresolvedRef): boolean {
  return ref.referenceKind === 'calls' && (ref.language === 'typescript' || ref.language === 'tsx'
    || ref.language === 'javascript' || ref.language === 'jsx');
}

/**
 * Drop cross-language candidates from a name lookup. Two regimes:
 *  - `references` (type-usage): a type named in language X resolves to a
 *    SAME-family type, never a coincidentally same-named symbol in another
 *    language (the Android `BatteryManager` system class vs a JS one). Strict
 *    same-family filter — cross-language communication is `calls`, not refs.
 *  - `imports` (import binding): an `import`/`#include` never crosses two
 *    KNOWN families (TS `import React` ↮ Swift `import React`). Weaker
 *    both-known filter so `.vue`/`.svelte` (own tag) importing `.ts` survives.
 */
export function applyLanguageGate(candidates: Node[], ref: UnresolvedRef): Node[] {
  if (isJavaScriptCall(ref) && /^[$\w]+$/.test(ref.referenceName)) {
    // JS/TS class methods require a receiver. A bare local function call must
    // never bind to a same-named class method, including the fuzzy fallback.
    return candidates.filter(candidate => candidate.kind !== 'method');
  }
  if (ref.referenceKind === 'references' || ref.referenceKind === 'function_ref') {
    return candidates.filter((c) => sameLanguageFamily(c.language, ref.language));
  }
  if (ref.referenceKind === 'imports') {
    return candidates.filter((c) => !crossesKnownFamily(c.language, ref.language));
  }
  return candidates;
}

/**
 * A function nested inside another FUNCTION is only callable from within its
 * container — Python, JS/TS, and every closure language scope it lexically.
 * Resolving a bare name from elsewhere to a nested local fabricates an edge
 * scope already rules out: `join(...)` in one function must never bind to a
 * `join` defined inside a DIFFERENT function (#1230). A candidate whose
 * qualifiedName parent is a same-file function/method is kept only when the
 * ref originates inside that parent's line range. Class members are
 * unaffected (their parent resolves to a class-like node), as are top-level
 * symbols and C++ namespace-prefixed names (the prefix has no node).
 */
export function isLexicallyReachable(
  candidate: Node,
  ref: UnresolvedRef,
  context: ResolutionContext
): boolean {
  if (candidate.kind !== 'function') return true;
  const qn = candidate.qualifiedName;
  if (!qn || !qn.includes('::')) return true;
  const parentQn = qn.slice(0, qn.lastIndexOf('::'));
  const containers = context
    .getNodesByQualifiedName(parentQn)
    .filter(
      (p) =>
        p.filePath === candidate.filePath &&
        (p.kind === 'function' || p.kind === 'method') &&
        p.startLine <= candidate.startLine &&
        p.endLine >= candidate.endLine
    );
  if (containers.length === 0) return true;
  return (
    ref.filePath === candidate.filePath &&
    containers.some((p) => ref.line >= p.startLine && ref.line <= p.endLine)
  );
}

/**
 * When a symbol name is ambiguous across files, prefer the candidate(s) declared
 * in the call site's own file, keeping the rest in their original order (#1079).
 * A same-file definition is the strongest language-agnostic signal for which of
 * several same-named symbols a call means; without it, resolution collapses onto
 * whichever was indexed first, so a call in `b/svc` wrongly targets `a/svc`.
 * No-op when there are <2 candidates or none share the call site's file.
 */
export function preferCallSiteFile(nodes: Node[], callSiteFile: string): Node[] {
  if (nodes.length < 2) return nodes;
  const same: Node[] = [];
  const other: Node[] = [];
  for (const n of nodes) {
    if (n.filePath === callSiteFile) same.push(n);
    else other.push(n);
  }
  return same.length ? [...same, ...other] : nodes;
}

/**
 * Find the best matching node when there are multiple candidates
 */
export function findBestMatch(
  ref: UnresolvedRef,
  candidates: Node[],
  _context: ResolutionContext
): Node | null {
  // Prioritization rules:
  // 1. Same file > different file
  // 2. Directory proximity (same module/package > different module)
  // 3. Same language > different language
  // 4. Functions/methods > classes/types (for call references)
  // 5. Exported > non-exported

  let bestScore = -1;
  let bestNode: Node | null = null;

  // Split the ref's path once (it's the same across every candidate) instead of
  // re-splitting it inside computePathProximity per candidate (#915 hot spot).
  const refDirs = ref.filePath.split('/');
  refDirs.pop();

  // A same-language candidate ALWAYS outscores a cross-language one: same-language
  // scores at least +50 (language bonus), while a cross-language candidate maxes
  // out at +35 (−80 language, +80 proximity, +25 kind, +10 exported; it can never
  // be in the same file). So when any same-language candidate exists, skip the
  // cross-language ones — provably the same winner, without paying the per-candidate
  // scoring. Cuts the candidate set to same-language size on mixed front-end +
  // back-end repos (#915). When ALL candidates are cross-language (a legitimate
  // cross-language `calls` bridge), none are skipped and behavior is unchanged.
  const hasSameLanguage = candidates.some((c) => c.language === ref.language);

  for (const candidate of candidates) {
    if (hasSameLanguage && candidate.language !== ref.language) continue;

    let score = 0;

    // Same file bonus
    if (candidate.filePath === ref.filePath) {
      score += 100;
    }

    // Directory proximity bonus — strongly prefer same module/package
    score += pathProximityFromDirs(refDirs, candidate.filePath);

    // Language matching: strongly prefer same language, penalize cross-language
    if (candidate.language === ref.language) {
      score += 50;
    } else {
      score -= 80;
    }

    // For call references, prefer functions/methods
    if (ref.referenceKind === 'calls') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      }
    }

    // For instantiation references (`new Foo()`), prefer class-like
    // targets — without this, a function named `Foo` in another module
    // could outscore the actual class.
    if (ref.referenceKind === 'instantiates') {
      if (
        candidate.kind === 'class' ||
        candidate.kind === 'struct' ||
        candidate.kind === 'interface'
      ) {
        score += 25;
      }
    }

    // For decorator references (`@Foo`), prefer functions. Class
    // decorators (Python `@SomeClass`, Java annotation interfaces)
    // also resolve here, hence the smaller class bonus.
    if (ref.referenceKind === 'decorates') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      } else if (candidate.kind === 'class' || candidate.kind === 'interface') {
        score += 15;
      }
    }

    // Exported bonus
    if (candidate.isExported) {
      score += 10;
    }

    // Closer line number (within same file)
    if (candidate.filePath === ref.filePath && candidate.startLine) {
      const distance = Math.abs(candidate.startLine - ref.line);
      score += Math.max(0, 20 - distance / 10);
    }

    if (score > bestScore) {
      bestScore = score;
      bestNode = candidate;
    }
  }

  return bestNode;
}

/**
 * Fuzzy match - last resort with lower confidence
 */
export function matchFuzzy(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const lowerName = ref.referenceName.toLowerCase();

  // Use pre-built lowercase index for O(1) lookup instead of scanning all nodes
  const candidates = context.getNodesByLowerName(lowerName);

  // Filter to callable kinds only (function, method, class)
  const callableKinds = new Set(['function', 'method', 'class']);
  const callableCandidates = applyLanguageGate(candidates.filter((n) => callableKinds.has(n.kind)), ref);

  // Prefer same-language matches
  const sameLanguageCandidates = callableCandidates.filter(n => n.language === ref.language);
  const finalCandidates = sameLanguageCandidates.length > 0 ? sameLanguageCandidates : callableCandidates;

  if (finalCandidates.length === 1) {
    const isCrossLanguage = finalCandidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: finalCandidates[0]!.id,
      confidence: isCrossLanguage ? 0.3 : 0.5,
      resolvedBy: 'fuzzy',
    };
  }

  return null;
}
