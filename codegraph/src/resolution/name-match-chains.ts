import { Node } from '../types';
import { matchFuzzy } from './name-match-candidates';
import { lookupCalleeReturnType } from './name-match-cpp';
import { matchByExactName, resolveMethodOnType } from './name-match-definitions';
import { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

/**
 * Languages where an unprefixed capitalized call `Foo(args)` constructs the
 * class (so a `Foo(args).method()` receiver's type is `Foo`). Java/C# need `new`,
 * so a bare `Foo()` there is a method call, not construction — excluded. Scala's
 * `Foo(args)` is a case-class / companion `apply`, which conventionally returns
 * `Foo` — and resolveMethodOnType validates, so a non-conventional `apply` that
 * returns another type simply yields no edge rather than a wrong one. Pascal/Delphi:
 * a `TFoo(x)` is a TYPECAST whose result is a `TFoo`, so `TFoo(x).method()` resolves
 * the method on `TFoo` — same shape, same validation.
 */
const CONSTRUCTS_VIA_BARE_CALL = new Set(['kotlin', 'swift', 'scala', 'dart', 'pascal']);

/**
 * Resolve a dotted chained call whose receiver is a static factory / fluent call —
 * `Foo.getInstance().bar()`, encoded by the extractor as `Foo.getInstance().bar`
 * (#645/#608 mechanism). The receiver's type is what `Foo.getInstance` returns
 * (its declared return type); the outer method is then resolved and VALIDATED on
 * it (resolveMethodOnType requires `Type::method` to exist), so a wrong inference
 * yields no edge rather than a wrong one (e.g. a same-named `bar()` on an
 * unrelated class is never matched). Shared by the dot-notation languages
 * (Java, Kotlin, C#, Swift) — same receiver shape, same `Class::method` qualified names.
 */
export function matchDottedCallChain(
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const m = ref.referenceName.match(/^(.+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const inner = m[1]; // `Foo.getInstance`
  const method = m[2]; // `bar`
  const lastDot = inner.lastIndexOf('.');

  if (lastDot <= 0) {
    // Go: bare package-level factory FUNCTION `New().method()` — the receiver's
    // type is what `New` returns; resolve the method on that.
    if (ref.language === 'go') {
      const ret = lookupCalleeReturnType(inner, ref, context);
      if (ret) {
        return resolveMethodOnType(ret, method, ref, context, 0.85, 'instance-method', importedFqnOf(ret, ref, context));
      }
      // `inner` isn't a function with a captured return type — typically a
      // package-level VARIABLE holding a function value (e.g. gin's `engine()`),
      // whose type we can't recover. Fall back to bare-name resolution of the
      // method so we don't DROP an edge the un-re-encoded bare path would have
      // found. (When `inner` IS a real factory function but the method doesn't
      // exist on its return type, `ret` is truthy and we returned no edge above —
      // the absent-method safety guarantee is preserved.)
      //
      // CRITICAL: resolve the TARGET via a synthetic bare-name ref, but return the
      // match tied to the ORIGINAL `ref` (referenceName `inner().method`). The
      // batched resolver (resolveAndPersistBatched) reads unresolved rows from
      // offset 0 every pass and relies on the post-batch cleanup (row-id delete
      // for DB-loaded refs, referenceName-keyed delete otherwise, #1269) to
      // clear each resolved row so the batch empties. If we propagated the
      // synthetic ref's bare `method` as `.original`, a key-based delete
      // would never match the stored `inner().method` row, the batch would
      // never drain, and the loop would re-resolve + re-insert forever (a runaway
      // that grew gin's graph to 5M edges / 1.4 GB before this fix).
      const bareRef = { ...ref, referenceName: method };
      const bareMatch = matchByExactName(bareRef, context) ?? matchFuzzy(bareRef, context);
      return bareMatch ? { ...bareMatch, original: ref } : null;
    }
    // Constructor receiver `Foo(args).method()` (encoded `Foo().method`): a bare,
    // capitalized inner is a class construction, so the receiver's type is the
    // class itself — resolve the method on it. Only in languages where an
    // unprefixed capitalized call constructs the class (Kotlin, Swift); in Java/C#
    // a bare `Foo()` is a method call (constructors need `new`), so we must not
    // assume construction. A lowercase bare inner is a top-level `factory().method()`
    // whose type we can't recover — bail.
    if (!CONSTRUCTS_VIA_BARE_CALL.has(ref.language) || !/^[A-Z]/.test(inner)) return null;
    return resolveMethodOnType(inner, method, ref, context, 0.85, 'instance-method', importedFqnOf(inner, ref, context));
  }

  // Factory/fluent receiver `Receiver.factory(args).method()`: the receiver's
  // type is what `Receiver.factory` returns (its declared return type).
  const factoryClass = inner.slice(0, lastDot).split('.').pop(); // simple class name
  const factoryMethod = inner.slice(lastDot + 1);
  if (!factoryClass || !factoryMethod) return null;
  const ret = lookupCalleeReturnType(`${factoryClass}::${factoryMethod}`, ref, context);
  if (!ret) {
    // Objective-C: a class-message factory — `[X alloc]`, `[X new]`,
    // `[X sharedFoo]` — returns an instance of the RECEIVER class `X` by
    // convention (`instancetype`). So when the factory's own return type isn't
    // recoverable (its selector returns `instancetype`, or `alloc`/`new` aren't
    // user-defined nodes at all), the receiver's type is the class `X` itself.
    // This resolves the ubiquitous `[[X alloc] init]` and singleton chains.
    // resolveMethodOnType validates against X (and its supertypes), so a class
    // whose method actually lives elsewhere yields NO edge, not a wrong one — and
    // crucially this does NOT fire when a concrete return type WAS captured but
    // simply lacks the method (that already returned null above: absent-method
    // safety, so a same-named decoy is still never matched).
    if (ref.language === 'objc' && /^[A-Z]/.test(factoryClass)) {
      return resolveMethodOnType(factoryClass, method, ref, context, 0.8, 'instance-method', importedFqnOf(factoryClass, ref, context));
    }
    // Pascal/Delphi: the extractor only re-encodes a `TFoo`/`IFoo`-prefixed chain
    // (the type-naming convention), so `factoryClass` is always a real class here.
    // A factory whose return type wasn't captured is a CONSTRUCTOR
    // (`TFileMem.Create().SetCachePerformance` — `constructor Create` has no `:
    // TBar` annotation but returns its own class) or an unannotated function. In
    // both cases the receiver's type is the class itself, so resolve the method on
    // `factoryClass`. resolveMethodOnType validates against it (and its
    // supertypes), so a wrong inference yields no edge — and this never fires when
    // a return type WAS captured but lacks the method (absent-method safety above).
    if (ref.language === 'pascal' && /^[TI]/.test(factoryClass)) {
      return resolveMethodOnType(factoryClass, method, ref, context, 0.8, 'instance-method', importedFqnOf(factoryClass, ref, context));
    }
    return null;
  }
  return resolveMethodOnType(ret, method, ref, context, 0.85, 'instance-method', importedFqnOf(ret, ref, context));
}

/**
 * When several classes share a simple type name, the caller file's import of
 * that type is the only signal that names WHICH one (#314). Returns the imported
 * FQN for `typeName` in the ref's file, or undefined.
 */
export function importedFqnOf(
  typeName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | undefined {
  const imports = context.getImportMappings(ref.filePath, ref.language);
  return imports.find((i) => i.localName === typeName)?.source;
}

/**
 * Java/Kotlin: infer a receiver's declared type by walking field declarations
 * in the class enclosing the call site. The field's `signature` is already in
 * the form "<TypeName> <fieldName>" (set by tree-sitter.ts extractField), so we
 * pull the type from there. Handles Spring `@Resource UserBO userbo;` /
 * `@Autowired private UserService userService;` where the receiver field name
 * doesn't match the class name by Java naming convention.
 *
 * Returns the bare type name (generics stripped, dotted package stripped) or
 * null when no matching field is in the enclosing class.
 */
export function inferJavaFieldReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  const inFile = context.getNodesInFile(ref.filePath);
  if (inFile.length === 0) return null;

  // Find the class enclosing the call line (tightest match by latest start).
  let enclosing: Node | null = null;
  for (const n of inFile) {
    if (n.kind !== 'class' && n.kind !== 'interface') continue;
    if (n.language !== ref.language) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= ref.line && end >= ref.line) {
      if (!enclosing || n.startLine >= enclosing.startLine) enclosing = n;
    }
  }
  if (!enclosing) return null;

  const enclosingEnd = enclosing.endLine ?? enclosing.startLine;
  const field = inFile.find(
    (n) =>
      n.kind === 'field' &&
      n.name === receiverName &&
      n.language === ref.language &&
      n.startLine >= enclosing.startLine &&
      (n.endLine ?? n.startLine) <= enclosingEnd,
  );
  if (!field || !field.signature) return null;

  // Signature shape: "<TypeName> <fieldName>" (extractField). Pull the type,
  // strip generics + dotted package, drop array/varargs markers.
  const beforeName = field.signature.slice(
    0,
    field.signature.lastIndexOf(field.name),
  );
  const typeRaw = beforeName.trim();
  if (!typeRaw) return null;

  const typeNoGenerics = typeRaw.replace(/<[^>]*>/g, '').trim();
  const typeNoArray = typeNoGenerics.replace(/\[\s*\x5D/g, '').replace(/\.\.\.$/, '').trim();
  const parts = typeNoArray.split(/[.\s]+/).filter(Boolean);
  const lastPart = parts[parts.length - 1];
  if (!lastPart) return null;
  if (!/^[A-Z]/.test(lastPart)) return null; // primitives / lowercase → skip
  return lastPart;
}
