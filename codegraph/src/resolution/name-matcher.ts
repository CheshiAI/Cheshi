import { matchFuzzy, preferCallSiteFile } from './name-match-candidates';
import { matchDottedCallChain } from './name-match-chains';
import { matchCppCallChain, matchScopedCallChain } from './name-match-cpp';
import { matchByExactName, matchByQualifiedName, matchFunctionRef } from './name-match-definitions';
import { matchByFilePath } from './name-match-files';
import { matchMethodCall } from './name-match-methods';
import { nmTimed } from './name-match-profile';
import { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

export { matchByFilePath } from './name-match-files';

export { sameLanguageFamily } from './name-match-candidates';

export { isKnownLanguageFamily } from './name-match-candidates';

export { crossesKnownFamily } from './name-match-candidates';

export { matchFunctionRef } from './name-match-definitions';

export { matchByExactName } from './name-match-definitions';

export { matchByQualifiedName } from './name-match-definitions';

export { preferCallSiteFile } from './name-match-candidates';

export { resolveMethodOnType } from './name-match-definitions';

export { matchCppCallChain } from './name-match-cpp';

export { matchScopedCallChain } from './name-match-cpp';

export { matchDottedCallChain } from './name-match-chains';

export { normalizeInferredTypeName } from './name-match-receivers';

export { clearNameMatcherMemos } from './name-match-receivers';

export { localReceiverTypePatterns } from './name-match-receivers';

export { matchMethodCall } from './name-match-methods';

export { matchFuzzy } from './name-match-candidates';

export { dumpNameMatcherProfile } from './name-match-profile';

/**
 * Match all strategies in order of confidence
 */
/** ArkUI attribute-helper decorators a `.attr(...)` chain may resolve to. */
const ARKUI_ATTRIBUTE_DECORATORS = new Set(['Extend', 'Styles', 'AnimatableExtend', 'Builder']);

export function matchReference(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Function-as-value refs (#756) resolve ONLY through the dedicated matcher —
  // never the fuzzy/qualified fallthrough below (a wrong callback edge is
  // worse than none).
  if (ref.referenceKind === 'function_ref') {
    return matchFunctionRef(ref, context);
  }

  // ArkTS chained UI attributes — emitted with a leading dot (`.titleStyle`,
  // `.width`) by the extractor — resolve ONLY to decorator-marked attribute
  // helpers: `@Extend`/`@Styles`/`@AnimatableExtend` functions (and global
  // `@Builder`s used attribute-position). Framework attributes (`.width`,
  // `.fontSize` — on nearly every UI line) match no such helper and stay
  // unresolved, NEVER falling through to bare-name matching: on a samples
  // monorepo that fallthrough manufactured 36k wrong edges, giving single
  // same-named properties thousands of false callers. Ambiguity rule matches
  // the rest of the file: several same-named helpers → prefer the call-site
  // file, still ambiguous → drop the ref rather than guess.
  if (ref.language === 'arkts' && ref.referenceName.startsWith('.')) {
    const base = ref.referenceName.slice(1);
    const candidates = context
      .getNodesByName(base)
      .filter(
        (n) =>
          n.language === 'arkts' &&
          n.kind === 'function' &&
          (n.decorators ?? []).some((d) => ARKUI_ATTRIBUTE_DECORATORS.has(d))
      );
    const chosen =
      candidates.length > 1 ? preferCallSiteFile(candidates, ref.filePath) : candidates;
    if (chosen.length !== 1) return null;
    return {
      original: ref,
      targetNodeId: chosen[0]!.id,
      confidence: 0.85,
      resolvedBy: 'exact-match',
    };
  }

  // Erlang `-behaviour(m)` refs target a MODULE. Letting them fall through to
  // bare-name matching grabs any same-named symbol — on emqx,
  // `-behaviour(supervisor)` resolved to a `-define(supervisor, …)` macro
  // constant in an unrelated app. Resolve only to the behaviour module's
  // namespace; an out-of-repo behaviour (OTP's gen_server/supervisor) stays
  // unresolved rather than guessed. The same module-only rule applies to every
  // ref an `.app`/`.app.src` resource file emits — its `{mod, …}` callback and
  // `{applications, …}` dependency names can only mean modules, and on emqx
  // the `ssl` OTP app otherwise resolved to a test helper FUNCTION named ssl.
  if (
    ref.language === 'erlang' &&
    (ref.referenceKind === 'implements' || /\.app(?:\.src)?$/i.test(ref.filePath))
  ) {
    const modules = context
      .getNodesByName(ref.referenceName)
      .filter((n) => n.language === 'erlang' && n.kind === 'namespace');
    const chosen = preferCallSiteFile(modules, ref.filePath)[0];
    if (!chosen) return null;
    return {
      original: ref,
      targetNodeId: chosen.id,
      confidence: 0.9,
      resolvedBy: 'exact-match',
    };
  }

  // Try strategies in order of confidence
  let result: ResolvedRef | null;

  // 0. File path match (e.g., "snippets/drawer-menu.liquid" → file node)
  result = nmTimed('filePath', ref, () => matchByFilePath(ref, context));
  if (result) return result;

  // 1. Qualified name match (highest confidence)
  result = nmTimed('qualifiedName', ref, () => matchByQualifiedName(ref, context));
  if (result) return result;

  // 1b. C++ chained call whose receiver is another call — `Foo::instance().bar()`
  // encoded as `Foo::instance().bar` by the extractor (#645). Resolve the
  // receiver's type from what the inner call returns, then the method on it.
  if (ref.language === 'cpp' || ref.language === 'c') {
    result = nmTimed('cppChain', ref, () => matchCppCallChain(ref, context));
    if (result) return result;
  }

  // 1c. `::`-scoped factory chain — PHP `Cls::for($x)->method()` (#608) or Rust
  // `Foo::new().bar()`, both encoded as `Cls::factory().method`. The receiver's
  // type is the factory's `self` (PHP `: self`/`: static`, Rust `-> Self`) or
  // concrete return type.
  if (ref.language === 'php' || ref.language === 'rust') {
    result = nmTimed('scopedChain', ref, () => matchScopedCallChain(ref, context));
    if (result) return result;
  }

  // 1d. Dotted chained static-factory / fluent call (Java / Kotlin / C# / Swift /
  // Go / Scala / Dart / Objective-C) — `Foo.getInstance().bar()` encoded as
  // `Foo.getInstance().bar`, Go's bare-factory `New().Method()` as `New().Method`,
  // Scala's companion factory, Dart's static factory / factory-constructor, or
  // ObjC's chained message send `[[Foo create] doIt]` encoded as `Foo.create().doIt`
  // (#645/#608 mechanism). Resolve the method's class from the inner call's
  // declared return type, then validate it.
  if (
    ref.language === 'java' ||
    ref.language === 'kotlin' ||
    ref.language === 'csharp' ||
    ref.language === 'swift' ||
    ref.language === 'go' ||
    ref.language === 'scala' ||
    ref.language === 'dart' ||
    ref.language === 'objc' ||
    ref.language === 'pascal'
  ) {
    result = nmTimed('dottedChain', ref, () => matchDottedCallChain(ref, context));
    if (result) return result;
  }

  // 2. Method call pattern
  result = nmTimed('methodCall', ref, () => matchMethodCall(ref, context));
  if (result) return result;

  // 3. Exact name match
  result = nmTimed('exactName', ref, () => matchByExactName(ref, context));
  if (result) return result;

  // 4. Fuzzy match (lowest confidence)
  result = nmTimed('fuzzy', ref, () => matchFuzzy(ref, context));
  if (result) return result;

  return null;
}
