import { Language } from '../types';
import { ResolutionContext, UnresolvedRef } from './types';

// ── Local-variable receiver-type inference (#1108) ──────────────────────────
//
// Instance calls through a local variable (`const lg = new Logger(); lg.log()`)
// only resolved in C++ before this — no other language could learn the
// receiver's type. Local variables are not indexed as nodes (node-explosion),
// so, like the C++ inferrer above, we read the enclosing function's source and
// match the receiver's declaration/initializer to recover its type. The type is
// then handed to resolveMethodOnType, which VALIDATES that the type actually
// declares the method, so a mis-inference produces NO edge — the safety net
// that lets the patterns below stay simple. C++ keeps its dedicated inferrer
// (header scan + `auto`); this covers every other language.

// Tokens a loose pattern might capture that are never a user-defined type.
const NON_TYPE_RECEIVER_TOKENS = new Set([
  'this', 'self', 'super', 'new', 'return', 'await', 'yield', 'typeof',
  'null', 'nil', 'None', 'true', 'false', 'True', 'False', 'undefined',
]);

/**
 * Normalize a captured type expression to a simple type name: drop generic
 * args and pointer/ref markers, take the last `.`/`::`-qualified segment, and
 * reject obvious non-types.
 */
export function normalizeInferredTypeName(raw: string): string | null {
  const cleaned = raw.replace(/<[^>]*>/g, '').replace(/[&*]/g, '').trim();
  const seg = cleaned.split(/[.:]+/).filter(Boolean).pop();
  if (!seg) return null;
  if (NON_TYPE_RECEIVER_TOKENS.has(seg)) return null;
  return seg;
}

/**
 * Per-language patterns that recover a local variable's (or typed parameter's)
 * type from its declaration/initializer. Each regex captures the type in group
 * 1; `r` is the already-escaped receiver name. Ordered most-specific first.
 * PascalCase is required in the capture where the language convention allows,
 * as a cheap false-positive guard on top of resolveMethodOnType's validation.
 */
/**
 * Compiled-pattern memo for the receiver-type pattern builders below. They
 * run for EVERY `receiver.method()` ref the matcher attempts, compiling 2–4
 * fresh RegExp objects per call — and receivers repeat massively (`self`
 * alone accounts for tens of thousands of refs on a Lua repo, measured 41µs
 * per methodCall miss on kong with compilation a large slice). The patterns
 * are a pure function of (language, receiver) and non-global (`.match()`
 * never touches lastIndex), so shared instances are behavior-identical.
 * FIFO-capped with no per-get mutation (the §7a.6 LRU-churn lesson): a hit
 * costs one Map lookup, overflow evicts oldest, and an evicted entry simply
 * recompiles exactly as every call did before this memo.
 */
const PATTERN_MEMO = new Map<string, RegExp[]>();

const PATTERN_MEMO_CAP = 8192;

/**
 * Per-context incremental receiver-scan states for inferLocalReceiverType
 * (see the memo comment there). Keyed (file, scopeStart, language, receiver);
 * entries are a few dozen bytes, count is bounded by distinct receiver uses
 * (same order as the context's other per-file caches). MUST drop whenever the
 * context's file caches drop — the states are derived from file lines — so
 * ReferenceResolver.clearCaches calls clearNameMatcherMemos alongside
 * clearImportResolverMemos.
 */
type InferScanState = { hi: number; ansIdx: number; ansType: string | null };

const INFER_SCAN_STATES = new WeakMap<ResolutionContext, Map<string, InferScanState>>();

function getInferScanStates(context: ResolutionContext): Map<string, InferScanState> {
  let m = INFER_SCAN_STATES.get(context);
  if (!m) {
    m = new Map();
    INFER_SCAN_STATES.set(context, m);
  }
  return m;
}

/** Drop the per-context scan states (see ReferenceResolver.clearCaches). */
export function clearNameMatcherMemos(context: ResolutionContext): void {
  INFER_SCAN_STATES.delete(context);
}

function memoPatterns(key: string, build: () => RegExp[]): RegExp[] {
  const hit = PATTERN_MEMO.get(key);
  if (hit) return hit;
  const patterns = build();
  if (PATTERN_MEMO.size >= PATTERN_MEMO_CAP) {
    const oldest = PATTERN_MEMO.keys().next().value;
    if (oldest !== undefined) PATTERN_MEMO.delete(oldest);
  }
  PATTERN_MEMO.set(key, patterns);
  return patterns;
}

export function localReceiverTypePatterns(language: Language, r: string): RegExp[] {
  return memoPatterns(`${language}|${r}`, () => buildLocalReceiverTypePatterns(language, r));
}

function buildLocalReceiverTypePatterns(language: Language, r: string): RegExp[] {
  switch (language) {
    case 'typescript':
    case 'javascript':
    case 'tsx':
    case 'jsx':
    case 'arkts':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*new\\s+([A-Za-z_$][\\w.$]*)`), // = new Logger()
        // No keyword requirement, so this matches BOTH a local annotation
        // (`const lg: Logger`) and a typed parameter (`function use(lg: Logger)`
        // / `(lg: Logger) =>`) — the parameter case the old `const|let|var`
        // prefix excluded (#1125). Mirrors Kotlin/Swift/Scala; the capture stops
        // at `<` so a generic-typed param (`repo: Repository<User>`) still yields
        // `Repository`. resolveMethodOnType validates the type actually declares
        // the method, so the looser match produces no edge on a mis-inference.
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.$]*)`), // lg: Logger  (annotation or typed param)
      ];
    case 'python':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w.]*)\\s*\\(`), // lg = Logger(...)
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.]*)`), // lg: Logger  (PEP 526)
      ];
    case 'java':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*new\\s+([A-Za-z_][\\w.]*)`), // = new Logger()
        new RegExp(`\\b([A-Z][\\w.]*)\\s+${r}\\b\\s*[=;,)]`), // Logger lg;  / param
      ];
    case 'kotlin':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w.]*)\\s*\\(`), // val lg = Logger(...)
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.]*)`), // val lg: Logger  / param
      ];
    case 'csharp':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*new\\s+([A-Za-z_][\\w.]*)`), // = new Logger()
        new RegExp(`\\b([A-Z][\\w.]*)\\s+${r}\\b\\s*[=;,)]`), // Logger lg;  / param
      ];
    case 'swift':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w.]*)\\s*\\(`), // let lg = Logger(...)
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.]*)`), // let lg: Logger  / param
      ];
    case 'rust':
      return [
        new RegExp(`\\blet\\s+(?:mut\\s+)?${r}\\b(?:\\s*:[^=]+)?=\\s*&?(?:mut\\s+)?([A-Z]\\w*)`), // let lg = Logger::new()/Logger{}/Logger
        // No `let`, so this covers a `let lg: Logger` binding AND a typed
        // parameter (`fn use(lg: &Logger)`, a closure `|lg: Logger|`) — the
        // parameter case the old `let`-anchored pattern excluded (#1125).
        new RegExp(`\\b${r}\\s*:\\s*&?(?:mut\\s+)?([A-Z]\\w*)`), // lg: Logger  (binding or typed param)
      ];
    case 'go':
      return [
        new RegExp(`\\b${r}\\b\\s*:=\\s*&?([A-Za-z_][\\w.]*)\\s*{`), // lg := Logger{} / &Logger{}
        new RegExp(`\\bvar\\s+${r}\\s+\\*?([A-Za-z_][\\w.]*)`), // var lg Logger / *Logger
        // A typed parameter / method receiver (`func use(lg Logger)`,
        // `func (l Logger) M()`) — name-before-type with no `var`/`:=` (#1125).
        // PascalCase-guarded (unlike the anchored patterns above) to keep the
        // keyword-free `ident Type` shape from matching unrelated pairs; the
        // enclosing-scope bound already excludes package-level struct fields.
        new RegExp(`\\b${r}\\s+\\*?([A-Z][\\w.]*)`), // func use(lg Logger) / (l Logger)
      ];
    case 'ruby':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w:]*)\\.new\\b`), // lg = Logger.new
      ];
    case 'scala':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*(?:new\\s+)?([A-Z][\\w.]*)`), // val lg = new Logger / Logger(...)
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.]*)`), // val lg: Logger  / param
      ];
    case 'dart':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w.]*)\\s*\\(`), // var lg = Logger(...)
        // Trailing `[=;,)]` (not just `[=;]`) so a typed parameter — `Logger lg)`
        // / `Logger lg,` — matches too, not only `Logger lg = ...` / `Logger lg;`
        // (#1125). Mirrors Java/C#.
        new RegExp(`\\b([A-Z][\\w.]*)\\s+${r}\\b\\s*[=;,)]`), // Logger lg = ...  / param
      ];
    case 'php':
      return [
        new RegExp(`\\$?${r}\\b\\s*=\\s*new\\s+([A-Za-z_\\\\][\\w\\\\]*)`), // $lg = new Logger()
        // A typed parameter (`function use(Logger $lg)`, `?Logger $lg`,
        // `\\App\\Logger $lg`, `&$lg` by-ref) and a typed `catch (E $e)` — the
        // type sits before the `$`-variable (#1125). Namespace `\\` allowed.
        new RegExp(`\\b([A-Za-z_\\\\][\\w\\\\]*)\\s+&?\\$${r}\\b`), // Logger $lg  (typed param)
      ];
    case 'lua':
    case 'luau':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z]\\w*)\\.new\\b`), // local lg = Logger.new()
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z]\\w*)\\s*\\(`), // local lg = Logger(...)  (callable table)
        // Luau annotation (`local lg: Logger`) / typed param — but Lua's
        // method-call syntax is the IDENTICAL `receiver:Name` shape, and the
        // backward scan starts on the call's own line, so without a gate any
        // PascalCase method call (`lg:Log()`, the Roblox convention)
        // self-matches as "type = Log" before the scan reaches the real
        // declaration (#1124). The lookahead rejects a capture followed by
        // any of Lua's three call forms — `(args)`, `"s"`/`'s'`/`[[s]]`,
        // `{t}` — and its leading `[\w.]` alternative stops backtracking from
        // shrinking the capture to dodge the gate (`lg:Log()` would otherwise
        // still match, as `Lo`).
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.]*)(?![\\w.]|\\s*[({"'\\[])`), // local lg: Logger  / typed param
      ];
    case 'r':
      return [
        new RegExp(`\\b${r}\\b\\s*(?:<-|<<-|=)\\s*([A-Z][\\w.]*)\\$new\\b`), // lg <- Logger$new()  (R6)
      ];
    case 'pascal':
      return [
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z]\\w*)`), // var lg: TLogger  / param lg: TLogger
        new RegExp(`\\b${r}\\b\\s*:=\\s*([A-Z][\\w.]*)\\.Create\\b`), // lg := TLogger.Create
      ];
    case 'cfml':
    case 'cfscript':
      return [
        // svc = new UserService() / new path.to.UserService() — dotted component
        // paths reduce to their final segment via normalizeInferredTypeName.
        // Also matches inside tag markup (`<cfset svc = new UserService()>`)
        // since the scan reads raw source lines.
        new RegExp(`\\b${r}\\b\\s*=\\s*new\\s+([A-Za-z_][\\w.]*)`),
        // The classic form: svc = createObject("component", "path.to.UserService")
        // (casing of createObject varies in the wild), plus the modern
        // single-argument form createObject("path.to.UserService").
        new RegExp(`\\b${r}\\b\\s*=\\s*[Cc]reate[Oo]bject\\s*\\(\\s*["']component["']\\s*,\\s*["']([\\w.]+)["']`),
        new RegExp(`\\b${r}\\b\\s*=\\s*[Cc]reate[Oo]bject\\s*\\(\\s*["']([\\w.]+)["']\\s*\\)`),
        // Typed cfscript parameter: `function save(UserService svc)` /
        // `required UserService svc` — CFML's built-in types (string, numeric,
        // any, struct…) are lowercase by convention, so the PascalCase guard
        // excludes them.
        new RegExp(`\\b([A-Z][\\w.]*)\\s+${r}\\b\\s*[=;,)]`),
        // Tag-form typed argument, either attribute order:
        // <cfargument name="svc" type="path.to.UserService">
        new RegExp(`\\bcfargument[^>\\n]*\\bname\\s*=\\s*["']${r}["'][^>\\n]*\\btype\\s*=\\s*["']([\\w.]+)["']`, 'i'),
        new RegExp(`\\bcfargument[^>\\n]*\\btype\\s*=\\s*["']([\\w.]+)["'][^>\\n]*\\bname\\s*=\\s*["']${r}["']`, 'i'),
        // Component property (incl. WireBox DI): `property name="svc"
        // inject="UserService";` / `<cfproperty name="svc" type="UserService">`,
        // either attribute order. An inject DSL value with a namespace
        // (`inject="svc@core"`) captures only the leading name and simply
        // fails type-validation — no edge, never a wrong one.
        new RegExp(`\\b(?:cf)?property\\b[^;\\n]*\\bname\\s*=\\s*["']${r}["'][^;\\n]*\\b(?:type|inject)\\s*=\\s*["']([\\w.]+)["']`, 'i'),
        new RegExp(`\\b(?:cf)?property\\b[^;\\n]*\\b(?:type|inject)\\s*=\\s*["']([\\w.]+)["'][^;\\n]*\\bname\\s*=\\s*["']${r}["']`, 'i'),
      ];
    default:
      return [];
  }
}

/** 1-based start line of the tightest function/method enclosing the call. */
function enclosingScopeStartLine(ref: UnresolvedRef, context: ResolutionContext): number {
  let start = 1;
  for (const n of context.getNodesInFile(ref.filePath)) {
    if (n.kind !== 'function' && n.kind !== 'method') continue;
    if (n.language !== ref.language) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= ref.line && end >= ref.line && n.startLine >= start) {
      start = n.startLine;
    }
  }
  return start;
}

/**
 * Infer a receiver's type from its local declaration/initializer in the
 * enclosing function body. Language-dispatched; returns null for languages
 * without patterns or when no declaration is found. Bounded to the enclosing
 * scope so a same-named variable in another function can't leak in.
 */
export function inferLocalReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  // CFML scope prefixes: `variables.svc` / `this.svc` name a COMPONENT-scoped
  // field whose assignment or `property` declaration usually lives outside the
  // calling function (the init-pseudoconstructor / WireBox-injection pattern),
  // and `local.svc` is an explicit function-local. Strip the prefix so the
  // declaration patterns match (`variables.svc = new X()`, `property
  // name="svc" …`, `var svc = …` all bind the bare name), and widen the scan
  // to the whole file for the component-scoped forms — nearest-declaration-
  // backward still wins, so a function-local shadowing the field is preferred.
  let scanReceiver = receiverName;
  let componentScoped = false;
  if (ref.language === 'cfml' || ref.language === 'cfscript') {
    const scoped = receiverName.match(/^(variables|this|local|arguments)\.(.+)$/i);
    if (scoped) {
      scanReceiver = scoped[2]!;
      const scope = scoped[1]!.toLowerCase();
      componentScoped = scope === 'variables' || scope === 'this';
    }
  }
  // PHP `$this->prop` receiver — the property's declaration lives outside the
  // calling method (a promoted constructor parameter `private readonly Foo $prop`,
  // a typed property `private Foo $prop;`, or a classic constructor parameter
  // `Foo $prop` assigned in __construct). Strip the prefix and widen the scan to
  // the whole file (the constructor may sit below the calling method), but —
  // unlike CFML's scopes above — switch to PROPERTY-shaped patterns: a plain
  // `$prop` local or parameter lives in a different namespace than `$this->prop`
  // and can never shadow it, so the generic local patterns would type the
  // property from unrelated same-named variables in other methods (a wrong
  // 0.9-confidence edge, not a missing one).
  let phpProperty = false;
  if (ref.language === 'php') {
    const scoped = receiverName.match(/^this->(.+)$/);
    if (scoped) {
      scanReceiver = scoped[1]!;
      componentScoped = true;
      phpProperty = true;
    }
  }

  const escapedReceiver = scanReceiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = phpProperty
    ? phpPropertyTypePatterns(escapedReceiver)
    : localReceiverTypePatterns(ref.language, escapedReceiver);
  if (patterns.length === 0) return null;

  // Split through the context's per-file lines cache when available: this runs
  // for EVERY `receiver.method()` ref, and re-splitting the whole file per ref
  // was ~20% of total index CPU on Java-heavy repos (#1122).
  const lines = context.getFileLines
    ? context.getFileLines(ref.filePath)
    : (context.readFile(ref.filePath)?.split(/\r?\n/) ?? null);
  if (!lines || lines.length === 0) return null;

  const callIdx = Math.max(0, Math.min(lines.length - 1, ref.line - 1));
  const startIdx = componentScoped
    ? 0
    : Math.max(0, enclosingScopeStartLine(ref, context) - 1);

  const matchLine = (i: number): string | null => {
    const line = lines[i];
    if (!line) return null;
    // A generated/minified line (one multi-KB statement) is not something a
    // human-written local declaration lives on, and regexing it per ref is
    // pure waste — skip it rather than scan it.
    if (line.length > 10_000) return null;
    for (const re of patterns) {
      const m = line.match(re);
      if (m && m[1]) {
        const type = normalizeInferredTypeName(m[1]);
        if (type) return type;
      }
    }
    return null;
  };

  // Incremental-scan memo (INFER_SCAN_STATES): this scan runs for EVERY
  // `receiver.method()` ref and was measured at 61µs/ref on kong (2.4s of
  // worker time, 99% misses — `self:` calls hunting a declaration Lua never
  // writes). Refs for the same (file, scope, receiver) arrive in ~ascending
  // line order, and the scan is a pure function of the file's immutable
  // lines, so each line pays its regex matches ONCE per key instead of once
  // per ref: query(c) = highest matching line in [startIdx..c]; a monotonic
  // call extends the stored watermark by scanning only (hi..c] (the region
  // at-or-below the previous answer is already proven empty above it); a
  // non-monotonic call (rare — refs are rowid-ordered) falls back to the
  // plain bounded scan and leaves the state alone. componentScoped is keyed
  // out — its position-independent whole-file sweep below has different
  // semantics.
  if (!componentScoped) {
    const states = getInferScanStates(context);
    const key = `${ref.filePath}|${startIdx}|${ref.language}|${scanReceiver}`;
    const state = states.get(key);
    if (!state) {
      for (let i = callIdx; i >= startIdx; i--) {
        const type = matchLine(i);
        if (type) {
          states.set(key, { hi: callIdx, ansIdx: i, ansType: type });
          return type;
        }
      }
      states.set(key, { hi: callIdx, ansIdx: -1, ansType: null });
      return null;
    }
    if (callIdx >= state.hi) {
      for (let i = callIdx; i > state.hi; i--) {
        const type = matchLine(i);
        if (type) {
          state.ansIdx = i;
          state.ansType = type;
          break;
        }
      }
      state.hi = callIdx;
      return state.ansIdx >= startIdx ? state.ansType : null;
    }
    for (let i = callIdx; i >= startIdx; i--) {
      const type = matchLine(i);
      if (type) return type;
    }
    return null;
  }

  // Nearest declaration wins: scan backward from the call to the scope start.
  for (let i = callIdx; i >= startIdx; i--) {
    const type = matchLine(i);
    if (type) return type;
  }
  // A component-scoped field's declaration is position-independent — the
  // `variables.svc = new X()` pseudoconstructor assignment or `property`
  // declaration may sit BELOW the calling function in the file — so when the
  // backward pass finds nothing, sweep the remainder of the file too.
  if (componentScoped) {
    for (let i = callIdx + 1; i < lines.length; i++) {
      const type = matchLine(i);
      if (type) return type;
    }
  }
  // A PHP property with no statically-typed declaration (classic pre-7.4
  // style) may still be typed by what gets ASSIGNED to it — follow the
  // `$this->prop = $var` assignment to the assigned variable's own typed
  // declaration (a classic or multi-line constructor parameter, or a typed
  // setter's parameter).
  if (phpProperty) {
    return inferPhpAssignedPropertyType(escapedReceiver, lines, callIdx);
  }
  return null;
}

/**
 * Patterns that recover a PHP class property's declared type for a
 * `$this->prop` receiver. Deliberately NOT localReceiverTypePatterns: only
 * property-shaped declarations qualify —
 *   1. a modifier-prefixed typed declaration, which covers both a typed
 *      property (`private ?Foo $prop;`) and a promoted constructor parameter
 *      (`private readonly Foo $prop`), and
 *   2. the pseudoconstructor assignment (`$this->prop = new Foo(...)`).
 * A bare `X $prop` parameter or `$prop = new X()` local elsewhere in the
 * file must NOT match: those variables can never alias `$this->prop`.
 * Union-typed properties (`Foo|Bar $prop`) yield no match and thus no edge —
 * silent beats wrong. The classic untyped-property-assigned-in-constructor
 * shape is handled by inferPhpAssignedPropertyType instead.
 */
function phpPropertyTypePatterns(r: string): RegExp[] {
  return memoPatterns(`php-prop|${r}`, () => buildPhpPropertyTypePatterns(r));
}

function buildPhpPropertyTypePatterns(r: string): RegExp[] {
  return [
    new RegExp(
      `\\b(?:(?:private|protected|public|readonly|static|final)(?:\\(set\\))?\\s+)+\\??([A-Za-z_\\\\][\\w\\\\]*)\\s+&?\\$${r}\\b`,
    ), // private readonly ?Foo $prop  (typed property / promoted param)
    new RegExp(`\\$this->${r}\\b\\s*=\\s*new\\s+([A-Za-z_\\\\][\\w\\\\]*)`), // $this->prop = new Foo()
  ];
}

/**
 * Second-chance typing for a PHP `$this->prop` receiver whose property
 * declaration carries no static type (classic pre-7.4 style): find the
 * `$this->prop = $var` assignment, then recover `$var`'s type from its own
 * declaration WITHIN the assignment's function — the constructor's (possibly
 * multi-line) parameter list, a typed setter's parameter, or a `= new X()`
 * local. The backward scan stops at the enclosing `function` line (checked
 * for a match first — a single-line `__construct(Foo $var) { ... }` carries
 * the typed parameter itself), so a same-named variable in another method
 * can never type the property.
 */
function inferPhpAssignedPropertyType(
  escapedProp: string,
  lines: string[],
  callIdx: number,
): string | null {
  const assignRe = new RegExp(`\\$this->${escapedProp}\\b\\s*=\\s*\\$(\\w+)\\b`);
  const assignAt = (i: number): RegExpMatchArray | null => {
    const line = lines[i];
    if (!line || line.length > 10_000) return null;
    return line.match(assignRe);
  };
  // The assignment is position-independent relative to the call — nearest-
  // backward first, then sweep forward, same order as the componentScoped scan.
  let assignIdx = -1;
  let varName: string | null = null;
  for (let i = callIdx; i >= 0; i--) {
    const m = assignAt(i);
    if (m) { assignIdx = i; varName = m[1]!; break; }
  }
  if (varName === null) {
    for (let i = callIdx + 1; i < lines.length; i++) {
      const m = assignAt(i);
      if (m) { assignIdx = i; varName = m[1]!; break; }
    }
  }
  if (varName === null) return null;

  const varPatterns = localReceiverTypePatterns(
    'php',
    varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  for (let i = assignIdx; i >= 0; i--) {
    const line = lines[i];
    if (line && line.length <= 10_000) {
      for (const re of varPatterns) {
        const m = line.match(re);
        if (m && m[1]) {
          const type = normalizeInferredTypeName(m[1]);
          if (type) return type;
        }
      }
    }
    if (line && /\bfunction\b/.test(line)) break;
  }
  return null;
}
