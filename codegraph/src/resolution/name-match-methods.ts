import { AMBIGUOUS_NAME_CEILING, isJavaScriptCall, preferCallSiteFile } from './name-match-candidates';
import { importedFqnOf, inferJavaFieldReceiverType } from './name-match-chains';
import { inferCppReceiverType } from './name-match-cpp';
import { resolveMethodOnType } from './name-match-definitions';
import { splitCamelCase } from './name-match-files';
import { nmTimedT } from './name-match-profile';
import { inferLocalReceiverType } from './name-match-receivers';
import { inferWebReceiverType } from './name-match-web-receivers';
import { hasWebReceiverBinding } from './web-receiver-shadowing';
import { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

/**
 * Try to resolve by method name on a class/object
 */
export function matchMethodCall(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Parse method call patterns like "obj.method" or "Class::method". The method
  // part allows trailing `:` keywords so Objective-C selectors resolve
  // (`SDImageCache.storeImage:`, `obj.setX:y:`); colons never appear in other
  // languages' method refs, so this is a no-op for them.
  // The receiver allows dots (`builder.Services.AddCoreServices`) so a CHAINED
  // call resolves by its last segment — Strategy 3 below name-matches the method
  // (with its existing single-candidate / receiver-overlap guards). Without this
  // a multi-dot extension-method call (C# DI `builder.Services.AddCoreServices()`,
  // `Guard.Against.X()`) matched no pattern and never resolved.
  // C++ explicit operator call `a.operator+(b)` reaches the resolver as
  // `a.operator+` (#1247) — the operator's symbol chars (`+`, `==`, `[]`, `()`)
  // fail the \w method part of the plain pattern, so admit them explicitly.
  // Names like `operatorTable` stay on the plain pattern (tried first); the
  // operator form requires at least one non-word char after `operator`, and
  // every downstream strategy compares the method part by exact string
  // equality, so a stray match can't invent an edge.
  const dotMatch =
    ref.referenceName.match(/^([\w.]+)\.(\w+:?(?:\w+:)*)$/) ??
    (ref.language === 'cpp'
      ? ref.referenceName.match(/^([\w.]+)\.(operator[^\w\s.]+)$/)
      : null);
  const colonMatch = ref.referenceName.match(/^(\w+)::(\w+)$/);
  // Lua/Luau method calls use a single colon (`lg:log`); R uses `$` (`lg$log`).
  // Recognize these receiver/method separators so local-variable receiver-type
  // inference (#1108) applies to them too — extraction already emits the ref in
  // this shape, but the resolver otherwise only understood `.` and `::`.
  const luaColonMatch = (ref.language === 'lua' || ref.language === 'luau')
    ? ref.referenceName.match(/^([\w.]+):(\w+)$/)
    : null;
  const rDollarMatch = ref.language === 'r'
    ? ref.referenceName.match(/^([\w.]+)\$(\w+)$/)
    : null;

  // PHP property receiver: `$this->prop->method()` reaches the resolver as
  // `this->prop.method` (the extractor records the receiver's raw text with the
  // leading `$` stripped). Resolve it EXCLUSIVELY through declared-type
  // inference + resolveMethodOnType validation — the name-similarity strategies
  // below must never see this shape, so a property whose type can't be
  // recovered stays unlinked rather than guessed (a wrong inference produces no
  // edge rather than a wrong one). Deeper chains (`this->a->b.method`) don't
  // match the single-property pattern and stay unlinked, same as before.
  const phpThisPropMatch = ref.language === 'php'
    ? ref.referenceName.match(/^(this->\w+)\.(\w+)$/)
    : null;
  if (phpThisPropMatch) {
    const [, receiver, phpMethodName] = phpThisPropMatch;
    const inferredType = inferLocalReceiverType(receiver!, ref, context);
    if (!inferredType) return null;
    return resolveMethodOnType(
      inferredType,
      phpMethodName!,
      ref,
      context,
      0.9,
      'instance-method',
      importedFqnOf(inferredType, ref, context),
    );
  }

  const match = dotMatch || colonMatch || luaColonMatch || rDollarMatch;
  if (!match) {
    return null;
  }

  const [, objectOrClass, methodName] = match;
  const webCall = isJavaScriptCall(ref);
  // A simple `receiver.method` / `receiver:method` / `receiver$method` shape whose
  // receiver type we can try to infer from its local declaration.
  const inferableReceiver = dotMatch || luaColonMatch || rDollarMatch;

  // Infer the receiver's type from its local declaration/initializer in the
  // enclosing scope, then resolve the method on that type (#1108). C++ keeps its
  // dedicated inferrer (header scan + `auto`); every other language uses the
  // shared source-based inferrer. resolveMethodOnType validates the method
  // exists on the inferred type, so a mis-inference produces no edge.
  if (inferableReceiver) {
    const inferredType = nmTimedT('mc-infer', ref, () =>
      ref.language === 'cpp'
        ? inferCppReceiverType(objectOrClass!, ref, context)
        : webCall ? inferWebReceiverType(objectOrClass!, ref, context)
          : inferLocalReceiverType(objectOrClass!, ref, context));
    if (inferredType) {
      // Java/Kotlin: when two classes share the simple name, the file's import
      // pins WHICH one (#314). Other languages disambiguate by call-site file.
      const importedFqn =
        ref.language === 'java' || ref.language === 'kotlin'
          ? context
            .getImportMappings(ref.filePath, ref.language)
            .find((i) => i.localName === inferredType)?.source
          : undefined;
      const typedMatch = nmTimedT('mc-rmot', ref, () => resolveMethodOnType(
        inferredType,
        methodName!,
        ref,
        context,
        0.9,
        'instance-method',
        importedFqn,
      ));
      if (typedMatch) {
        return typedMatch;
      }
      if (webCall) return null;
    }
  }

  // Go 2-hop field chain `base.field.Method` (#1276): the base's type comes
  // from the enclosing scope (typed parameter / method receiver / local var),
  // the field's declared type from that struct's own declaration lines, and
  // the method is VALIDATED on the field's type by resolveMethodOnType. This
  // branch is EXCLUSIVE for chained Go receivers: when the hop can't be
  // inferred or the field's type is external (`conn *sql.DB` — no project
  // node), the ref stays unresolved rather than falling through to the
  // bare-name strategies below, which is exactly how `target.conn.Exec(...)`
  // fabricated a dependency on an unrelated local interface's same-named
  // method. Chained Go receivers were never emitted before #1276, so there
  // is no prior recall to preserve on the fallback path.
  if (ref.language === 'go' && dotMatch && objectOrClass!.includes('.')) {
    return matchGoFieldChainCall(objectOrClass!, methodName!, ref, context);
  }

  // Java/Kotlin: receiver may be a field whose name doesn't match the type by
  // Java naming convention (`userbo` → class `UserBO`, abbreviated). Look up
  // the field in the enclosing class to get its declared type, then resolve
  // the method on that type. Covers Spring `@Resource`/`@Autowired` field
  // injection where the field type is the concrete bean class.
  if ((ref.language === 'java' || ref.language === 'kotlin') && dotMatch) {
    const inferredType = inferJavaFieldReceiverType(objectOrClass!, ref, context);
    if (inferredType) {
      // When two classes share the same simple name, the caller file's
      // import is the only signal that names WHICH one — pass the
      // imported FQN so resolveMethodOnType can disambiguate (#314).
      const imports = context.getImportMappings(ref.filePath, ref.language);
      const importedFqn = imports.find((i) => i.localName === inferredType)?.source;
      const typedMatch = nmTimedT('mc-rmot', ref, () => resolveMethodOnType(
        inferredType,
        methodName!,
        ref,
        context,
        0.9,
        'instance-method',
        importedFqn,
      ));
      if (typedMatch) {
        return typedMatch;
      }
    }
  }

  // Strategy 1: Direct class name match (existing logic). When the receiver
  // names a class that exists in several files (`Logger.log()` / `Logger::log()`
  // with a `Logger` in both `a/` and `b/`), try the class in the call site's
  // own file first — otherwise the first-indexed class wins and a call in `b/`
  // resolves to `a/`'s method (#1079).
  const strat1 = nmTimedT('mc-class', ref, (): ResolvedRef | null => {
    const classCandidates = preferCallSiteFile(
      context.getNodesByName(objectOrClass!),
      ref.filePath,
    );

    for (const classNode of classCandidates) {
      if (classNode.kind === 'class' || classNode.kind === 'struct' || classNode.kind === 'interface') {
        // Skip cross-language class matches
        if (classNode.language !== ref.language) continue;
        if (webCall && hasWebReceiverBinding(objectOrClass!, ref, context)) return null;

        const nodesInFile = context.getNodesInFile(classNode.filePath);
        const methodNode = nodesInFile.find(
          (n) =>
            n.kind === 'method' &&
            n.name === methodName &&
            n.qualifiedName.includes(classNode.name)
        );

        if (methodNode) {
          return {
            original: ref,
            targetNodeId: methodNode.id,
            confidence: 0.85,
            resolvedBy: 'qualified-name',
          };
        }
      }
    }
    return null;
  });
  if (strat1) return strat1;

  // JS/TS receivers have no implicit relationship to a similarly named class.
  // Even a unique method elsewhere (often a test double) is not type evidence.
  if (webCall) return null;

  // Strategy 2: Instance variable receiver - try capitalized form to find class
  // e.g., "permissionEngine" → look for classes containing "PermissionEngine"
  const capitalizedReceiver = objectOrClass!.charAt(0).toUpperCase() + objectOrClass!.slice(1);
  if (capitalizedReceiver !== objectOrClass) {
    const strat2 = nmTimedT('mc-capital', ref, (): ResolvedRef | null => {
      const fuzzyClassCandidates = preferCallSiteFile(
        context.getNodesByName(capitalizedReceiver),
        ref.filePath,
      );
      for (const classNode of fuzzyClassCandidates) {
        if (classNode.kind === 'class' || classNode.kind === 'struct' || classNode.kind === 'interface') {
          // Skip cross-language class matches
          if (classNode.language !== ref.language) continue;

          const nodesInFile = context.getNodesInFile(classNode.filePath);
          const methodNode = nodesInFile.find(
            (n) =>
              n.kind === 'method' &&
              n.name === methodName &&
              n.qualifiedName.includes(classNode.name)
          );

          if (methodNode) {
            return {
              original: ref,
              targetNodeId: methodNode.id,
              confidence: 0.8,
              resolvedBy: 'instance-method',
            };
          }
        }
      }
      return null;
    });
    if (strat2) return strat2;
  }

  // Strategy 3: Find methods by name across the codebase, match by receiver
  // name similarity with the containing class. Handles abbreviated variable
  // names like permissionEngine → PermissionRuleEngine.
  if (methodName) {
    const strat3 = nmTimedT('mc-byname', ref, (): ResolvedRef | null => {
      const methodCandidates = context.getNodesByName(methodName!);
      // Ubiquitous-method ceiling (#999): a method name re-declared across a
      // vendored theme/SDK (Metronic's `init`/`update`/… on every widget) yields
      // K candidates that receiver-word overlap can't reliably disambiguate —
      // and filtering + scoring all K per call is the O(K²) cost that wedged
      // "Resolving refs" for 15-28 min. Bail before the O(K) work; Strategy 1/2
      // (class-name match) already had their precise shot above.
      if (methodCandidates.length > AMBIGUOUS_NAME_CEILING) {
        return null;
      }
      const methods = methodCandidates.filter(
        (n) => n.kind === 'method' && n.name === methodName
      );

      // Filter to same-language candidates first
      const sameLanguageMethods = methods.filter(m => m.language === ref.language);
      const targetMethods = sameLanguageMethods.length > 0 ? sameLanguageMethods : methods;

      // If only one same-language method with this name exists, use it
      if (targetMethods.length === 1 && targetMethods[0]!.language === ref.language) {
        return {
          original: ref,
          targetNodeId: targetMethods[0]!.id,
          confidence: 0.7,
          resolvedBy: 'instance-method',
        };
      }

      // Multiple methods: score by receiver name word overlap with class name
      if (targetMethods.length > 1) {
        const receiverWords = splitCamelCase(objectOrClass!);
        let bestMatch: typeof targetMethods[0] | undefined;
        let bestScore = 0;

        // Same-file candidates first, so a score tie (`score > bestScore` keeps
        // the first seen) resolves to the call site's own file rather than the
        // first-indexed duplicate (#1079).
        for (const method of preferCallSiteFile(targetMethods, ref.filePath)) {
          const classWords = splitCamelCase(method.qualifiedName);
          let score = receiverWords.filter(w =>
            classWords.some(cw => cw.toLowerCase() === w.toLowerCase())
          ).length;
          // Bonus for same language
          if (method.language === ref.language) score += 1;
          if (score > bestScore) {
            bestScore = score;
            bestMatch = method;
          }
        }

        if (bestMatch && bestScore >= 2) {
          return {
            original: ref,
            targetNodeId: bestMatch.id,
            confidence: 0.65,
            resolvedBy: 'instance-method',
          };
        }
      }
      return null;
    });
    if (strat3) return strat3;
  }

  return null;
}

/** Go builtin/primitive field types that can never carry a project method. */
const GO_BUILTIN_FIELD_TYPES = new Set([
  'string', 'bool', 'byte', 'rune', 'error', 'any',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128',
  'chan', 'map', 'func', 'struct', 'interface',
]);

/**
 * Resolve a Go 2-hop field-chain call `base.field.Method(...)` (#1276):
 * `target.conn.Exec("insert")` where `func (target *Target) Write()` and
 * `type Target struct { conn *sql.DB }`. Two inference hops, both read from
 * source the same way #1108 does:
 *   1. `base`'s type from the enclosing scope (method receiver, typed
 *      parameter, or local declaration) via inferLocalReceiverType;
 *   2. `field`'s declared type from the struct's own declaration lines.
 * The method is then resolved AND VALIDATED on the field's type. A field
 * whose type has no project node (`sql.DB`, any external dependency) yields
 * null — the caller treats this branch as exclusive for chained Go
 * receivers, so the ref stays unresolved instead of name-guessing.
 */
function matchGoFieldChainCall(
  receiverChain: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const segs = receiverChain.split('.');
  if (segs.length !== 2 || !segs[0] || !segs[1]) return null;
  const [base, field] = segs;

  const baseType = inferLocalReceiverType(base!, ref, context);
  if (!baseType) return null;

  const fieldEsc = field!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fieldTypeRe = new RegExp(`\\b${fieldEsc}\\s+\\*?\\[?\\x5D?([A-Za-z_][\\w.]*)`);

  const structs = preferCallSiteFile(context.getNodesByName(baseType), ref.filePath).filter(
    (n) => (n.kind === 'struct' || n.kind === 'class') && n.language === 'go'
  );
  for (const s of structs) {
    const source = context.readFile(s.filePath);
    if (!source) continue;
    // Only the struct's own declaration lines — a same-named identifier
    // elsewhere in the file can't donate a type. Matched LINE BY LINE with
    // comments stripped: chi's `Mux` has a doc comment reading "the tree
    // router" right above `tree *node`, and a whole-block match captured
    // `router` from the prose instead of `node` from the field.
    const declLines = source.split('\n').slice(Math.max(0, s.startLine - 1), s.endLine);
    for (const rawLine of declLines) {
      const line = rawLine.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      const m = line.match(fieldTypeRe);
      if (!m || !m[1]) continue;
      const rawType = m[1];
      // A package-qualified field type (`http.Handler`, `sql.DB`) is only
      // followed when the package is IN-MODULE: stripping the qualifier and
      // matching the bare name would conflate a stdlib/third-party type with
      // any same-named project type — on chi, `handler http.Handler` bound
      // to an example app's unrelated local `Handler`. That is the exact
      // fabrication this matcher exists to prevent (#1276).
      if (rawType.includes('.')) {
        const pkg = rawType.split('.')[0]!;
        const mod = context.getGoModule?.();
        const imp = context
          .getImportMappings(s.filePath, 'go')
          .find((i) => i.localName === pkg);
        const inModule =
          !!mod &&
          !!imp &&
          (imp.source === mod.modulePath || imp.source.startsWith(mod.modulePath + '/'));
        if (!inModule) continue;
      }
      // Unexported (lowercase) types are idiomatic Go and stay eligible —
      // chi's `mx.tree.FindRoute()` chains through `tree *node`. A
      // mis-capture is harmless: resolveMethodOnType only returns a
      // validated `<type>::<method>` match.
      const fieldType = rawType.split('.').pop();
      if (!fieldType || !/^[A-Za-z_]/.test(fieldType) || GO_BUILTIN_FIELD_TYPES.has(fieldType)) continue;
      const resolved = resolveMethodOnType(fieldType, methodName, ref, context, 0.85, 'instance-method');
      if (resolved) return resolved;
    }
  }
  return null;
}
