import { resolveMethodOnType } from './name-match-definitions';
import { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

// C++ keywords/control-flow tokens that can appear right before a receiver
// (e.g. `return ptr->m()`) and must NOT be treated as a type.
const CPP_NON_TYPE_TOKENS = new Set([
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'goto', 'throw', 'new', 'delete', 'co_await', 'co_yield',
  'co_return', 'static_cast', 'const_cast', 'dynamic_cast', 'reinterpret_cast',
  'sizeof', 'alignof', 'typeid', 'and', 'or', 'not', 'xor',
]);

function normalizeCppTypeName(typeName: string): string | null {
  const normalized = typeName
    .replace(/\b(const|volatile|mutable|typename|class|struct)\b/g, ' ')
    .replace(/[&*]+/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;
  const parts = normalized.split(/::/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return null;
  if (CPP_NON_TYPE_TOKENS.has(last)) return null;
  return last;
}

// Declarator regex: matches `Type receiver`, `Type* receiver`, `Type *receiver`,
// `Type*receiver`, `Type<X> receiver`, etc., REQUIRING a declarator terminator
// (`;`, `=`, `,`, `)`, `[`, `{`, `(`, or end-of-line) after the receiver. The
// terminator rules out uses like `return receiver->m()` where the preceding
// token is a keyword, not a type.
function buildDeclaratorRegex(escapedReceiver: string): RegExp {
  return new RegExp(
    `([A-Za-z_][\\w:]*(?:\\s*<[^;=(){}]+>)?(?:\\s*[*&]+)?)\\s*\\b${escapedReceiver}\\b\\s*(?=[;=,)\\[{(]|$)`,
  );
}

export function inferCppReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth = 0,
): string | null {
  // Per-file lines cache when available — this runs per `receiver->method()`
  // ref and re-splitting the file each time is the same quadratic as the
  // shared inferrer's (#1122).
  const lines = context.getFileLines
    ? context.getFileLines(ref.filePath)
    : (context.readFile(ref.filePath)?.split(/\r?\n/) ?? null);
  if (!lines || lines.length === 0) return null;

  const callLineIndex = Math.max(0, Math.min(lines.length - 1, ref.line - 1));
  const escapedReceiver = receiverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const receiverPattern = new RegExp(`\\b${escapedReceiver}\\b`);
  const declaratorRegex = buildDeclaratorRegex(escapedReceiver);

  for (let i = callLineIndex; i >= 0; i--) {
    const line = lines[i];
    if (!line || !receiverPattern.test(line)) continue;

    const declaratorMatch = line.match(declaratorRegex);
    if (declaratorMatch) {
      const normalized = normalizeCppTypeName(declaratorMatch[1] ?? '');
      if (normalized === 'auto') {
        // `auto x = Foo::instance();` — the declared type is deduced; recover it
        // from the initializer (call return type / construction) (#645).
        const initType = inferCppAutoInitializerType(line, receiverName, ref, context, depth);
        if (initType) return initType;
        // No usable initializer on this line — keep scanning earlier ones.
      } else if (normalized) {
        return normalized;
      }
    }
  }

  const headerCandidates = [
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.h'),
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.hpp'),
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.hxx'),
  ].filter((candidate, index, arr) => arr.indexOf(candidate) === index && candidate !== ref.filePath);

  for (const headerPath of headerCandidates) {
    if (!context.fileExists(headerPath)) continue;
    const headerLines = context.getFileLines
      ? context.getFileLines(headerPath)
      : (context.readFile(headerPath)?.split(/\r?\n/) ?? null);
    if (!headerLines) continue;

    for (const line of headerLines) {
      if (!receiverPattern.test(line)) continue;
      const declaratorMatch = line.match(declaratorRegex);
      if (!declaratorMatch) continue;
      const normalized = normalizeCppTypeName(declaratorMatch[1] ?? '');
      if (normalized && normalized !== 'auto') return normalized;
    }
  }

  return null;
}

/**
 * Last `::`-separated segment of a (possibly namespace-qualified) C++ name.
 */
function cppLastSegment(name: string): string {
  const parts = name.split('::').filter(Boolean);
  return parts[parts.length - 1] ?? name;
}

/**
 * Return type captured at extraction for `Class::method` (or a free function),
 * read off the indexed node's `returnType` — used by the C++ (#645) and PHP
 * (#608) chained-call resolvers. Language-filtered. Null when not indexed or no
 * return type was recorded (a `void`/primitive return).
 */
export function lookupCalleeReturnType(
  callee: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  let method = callee;
  let cls: string | null = null;
  if (callee.includes('::')) {
    const parts = callee.split('::').filter(Boolean);
    method = parts[parts.length - 1] ?? callee;
    cls = parts.slice(0, -1).join('::');
  }
  const candidates = context.getNodesByName(method).filter(
    (n) =>
      (n.kind === 'method' || n.kind === 'function') &&
      n.language === ref.language &&
      !!n.returnType,
  );
  if (cls) {
    const want = `${cls}::${method}`;
    // The call site may name the class with MORE namespace qualification than
    // the stored node (`details::registry::instance` at the call vs
    // `registry::instance` on the node — the receiver type only carries the
    // immediate class), or LESS. Accept an exact match or either being a
    // namespace-suffix of the other; the shared `::<class>::<method>` tail keeps
    // it specific.
    const m = candidates.find(
      (n) =>
        n.qualifiedName === want ||
        n.qualifiedName.endsWith(`::${want}`) ||
        want.endsWith(`::${n.qualifiedName}`),
    );
    return m?.returnType ?? null;
  }
  return candidates.find((n) => n.kind === 'function')?.returnType ?? null;
}

/** Does the graph contain a class/struct named `name`'s last segment? */
function cppClassExists(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const last = cppLastSegment(name);
  return context
    .getNodesByName(last)
    .some((n) => (n.kind === 'class' || n.kind === 'struct') && n.language === ref.language);
}

/**
 * Infer the class produced by a C++ call/construction expression, using return
 * types captured at extraction (#645). Handles, in order:
 *   - `make_unique<T>()` / `make_shared<T>()`        → T
 *   - single-level member call `recv.method()`       → recv's type, then method's return
 *   - `Class::method()` / free `func()`              → the callee's recorded return type
 *   - direct construction `Type()` / `ns::Type()`    → Type
 * Returns null when undeterminable. Callers MUST still validate the outer method
 * exists on the result before creating an edge, so a wrong guess stays silent.
 */
function resolveCppCallResultType(
  inner: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth = 0,
): string | null {
  if (depth > 3) return null; // guard against pathological mutual recursion
  const expr = inner.trim();

  const make = expr.match(/(?:^|::)(?:make_unique|make_shared)\s*<\s*([A-Za-z_]\w*)/);
  if (make) return make[1] ?? null;

  // Single-level member call `recv.method` (the `manager.view().render()` shape).
  const dotIdx = expr.lastIndexOf('.');
  if (dotIdx > 0) {
    const recv = expr.slice(0, dotIdx);
    const method = expr.slice(dotIdx + 1);
    if (recv.includes('.') || recv.includes('(') || recv.includes('::')) return null; // single level only
    const recvType = inferCppReceiverType(recv, ref, context, depth + 1);
    if (!recvType) return null;
    return lookupCalleeReturnType(`${recvType}::${method}`, ref, context);
  }

  const ret = lookupCalleeReturnType(expr, ref, context);
  if (ret) return ret;

  // Direct construction — the callee itself names a class/struct.
  if (cppClassExists(expr, ref, context)) return cppLastSegment(expr);

  return null;
}

/**
 * Recover the type of an `auto`-declared local from its initializer on the
 * declaration line — `auto x = Foo::instance();`, `auto w = make_unique<W>();`,
 * `auto p = new W();`, `auto w = Widget();` (#645).
 */
function inferCppAutoInitializerType(
  line: string,
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth: number,
): string | null {
  const escaped = receiverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = line.match(new RegExp(`\\b${escaped}\\b\\s*=\\s*([^;]+)`));
  if (!m || !m[1]) return null;
  const init = m[1].trim();

  const neu = init.match(/^new\s+([A-Za-z_][\w:]*)/);
  if (neu && neu[1]) return cppLastSegment(neu[1]);

  // A call or construction: `Foo(...)`, `A::b(...)`, `make_unique<T>(...)`.
  const call = init.match(/^([A-Za-z_][\w:]*(?:\s*<[^>;]*>)?)\s*\(/);
  if (call && call[1]) return resolveCppCallResultType(call[1].replace(/\s+/g, ''), ref, context, depth + 1);

  return null;
}

/**
 * Resolve a C++ chained call whose receiver is itself a call — encoded by the
 * extractor as `<innerCallee>().<method>` (#645). The receiver's type is what
 * the inner call returns; the outer method is then resolved and VALIDATED on it
 * (resolveMethodOnType requires `cls::method` to exist), so a wrong inference
 * produces no edge rather than a wrong one.
 */
export function matchCppCallChain(
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const m = ref.referenceName.match(/^(.+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const cls = resolveCppCallResultType(m[1], ref, context);
  if (!cls) return null;
  return resolveMethodOnType(cls, m[2], ref, context, 0.85, 'instance-method');
}

/**
 * Resolve a `::`-scoped factory chain whose receiver is a scoped/static call —
 * PHP `Cls::for($x)->method()` (#608, the per-credential Laravel client idiom) or
 * Rust `Foo::new().bar()` (an associated-function call) — both encoded by the
 * extractor as `Cls::factory().method`. The receiver's type is what `Cls::factory`
 * returns: a `self` marker (PHP `: self`/`: static`, Rust `-> Self`) resolves to
 * the factory's own type, a concrete return type to that type. The outer method is
 * then resolved and VALIDATED on it (resolveMethodOnType requires the method to
 * exist on the type or a supertype it conforms to), so a wrong inference yields no
 * edge rather than a wrong one. Shared by the `::`-receiver languages (PHP, Rust).
 */
export function matchScopedCallChain(
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const m = ref.referenceName.match(/^(.+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const inner = m[1];
  const method = m[2];
  if (!inner.includes('::')) return null; // only static-factory (`Cls::method`) chains
  const factoryClass = inner.slice(0, inner.lastIndexOf('::'));
  const ret = lookupCalleeReturnType(inner, ref, context);
  if (!ret) return null;
  // `self` (the extractor's marker for self/static/$this) → the factory's class.
  const resolvedClass = ret === 'self' ? factoryClass : ret;
  return resolveMethodOnType(resolvedClass, method, ref, context, 0.85, 'instance-method');
}
