import type { Node as SyntaxNode } from '../../web-tree-sitter';
import { getChildByField } from '../tree-sitter-helpers';

/**
 * Detect tree-sitter's misparse of a macro-annotated class/struct, e.g.
 * `class MACRO Name { … }` or `class MACRO Name : public Base { … }` (#946).
 * Not knowing `MACRO` is a macro, tree-sitter reads `class MACRO` as an
 * *elaborated type specifier* (a bodyless `class_specifier`/`struct_specifier`
 * whose "type name" is the macro) and the rest as a function: `Name` becomes the
 * declarator and the `{ … }` a function body — so the whole declaration surfaces
 * as a `function_definition` named after the class, with a line range spanning
 * the entire class body. (A base clause, when present, additionally lands in an
 * `ERROR` node, but it isn't required — the leading macro alone triggers this.)
 *
 * Two structural signals pin it down with no risk to genuine code:
 *  - the `type` field is a *bodyless* class/struct specifier — an elaborated
 *    type, not a real inline-defined return type like
 *    `struct P { int x; } makeP() { … }` (which carries a field list); and
 *  - the declarator is not a `function_declarator` — a real function definition
 *    always has one, which also leaves the legal-but-rare `class Foo f() { … }`
 *    (an elaborated return type on a genuine function) alone.
 *
 * The class body is mangled by the same misparse and is unrecoverable, so —
 * matching how macro-prefixed C prototypes are handled — we drop the spurious
 * node rather than mint a misleading whole-body `function` that pollutes
 * callers/impact and skews kind statistics.
 */
export function isMacroMisparsedTypeDecl(node: SyntaxNode): boolean {
  const typeNode = getChildByField(node, 'type');
  if (!typeNode) return false;
  if (typeNode.type !== 'class_specifier' && typeNode.type !== 'struct_specifier') return false;
  if (typeNode.namedChildren.some((c: SyntaxNode) => c.type === 'field_declaration_list')) return false;
  const declarator = getChildByField(node, 'declarator');
  return !(declarator && declarator.type === 'function_declarator');
}

/**
 * Blank an export/visibility macro in a `class/struct EXPORT_MACRO Name …`
 * *definition* header before parsing. Not knowing the macro, tree-sitter reads
 * `class EXPORT_MACRO` as an elaborated type specifier and the rest as a
 * function, so the whole class — its name, base clause, and members — drops out
 * of the index (#946 catches the resulting phantom function but can't recover
 * the class), which silently breaks type-hierarchy / inheritance-impact queries
 * for effectively every Unreal-Engine (`*_API`), Qt/Boost (`*_EXPORT`), LLVM
 * (`*_ABI`), … class. Replacing the macro with equal-length spaces preserves
 * every byte offset (and thus line/column), so the declaration then parses as a
 * normal class_specifier and the existing extraction emits the node, members,
 * and `extends` edge. (#1061, follow-up to #946.)
 *
 * Matched tightly so it can't touch the same macro used as an ordinary value
 * elsewhere (`int x = SOME_API;`): the macro is the ALL-CAPS token sitting
 * *between* `class`/`struct` and the type name, and the trailing `[:{]`
 * definition-guard fires only when a base clause or body follows — the only
 * shape that misparses. That guard also leaves elaborated-type variable
 * declarations (`struct FOO var;`, `class FOO obj = …`) untouched, since those
 * end in `;` / `=` / `[`, never `:` / `{`. C++-only (wired into cppExtractor),
 * so C's heavier use of `struct TAG var;` never reaches it.
 */
export function blankCppExportMacros(source: string): string {
  if (source.indexOf('class') === -1 && source.indexOf('struct') === -1) return source;
  return source.replace(
    /\b(class|struct)(\s+)([A-Z][A-Z0-9_]+)(?=\s+[A-Za-z_]\w*(?:\s+final)?\s*[:{])/g,
    (_m, kw, ws, macro) => kw + ws + ' '.repeat(macro.length)
  );
}

/**
 * Blank a known inline-specifier macro sitting in front of a function's return
 * type (`FORCEINLINE FString GetName(…)`), before parsing. Not knowing the
 * macro, tree-sitter can't reconcile `MACRO <return-type> <name>(` — an extra
 * type-like token before the name — and drops into error recovery: the macro
 * becomes the return type and, for a non-primitive return, the return type gets
 * glued onto the name (`GetName` → `"FString GetName"`), so the function can't
 * be found by name and its callers don't link. This is pervasive in Unreal
 * Engine (`FORCEINLINE <ret> <name>(…)`) and in vendored third-party libraries
 * that define their own inline macro (pugixml's `PUGI__FN`, Godot's
 * `_FORCE_INLINE_`, Boost's `BOOST_FORCEINLINE`, …). Replacing the macro with
 * equal-length spaces preserves every byte offset (so line/column stay exact)
 * and the declaration then parses as an ordinary function — recovering the real
 * name AND the return type — mirroring how `blankCppExportMacros` recovers
 * macro-annotated classes (#946/#1061).
 *
 * Matched tightly so it can't touch an ordinary identifier: only the exact,
 * curated inline-specifier tokens below (never an arbitrary all-caps token, so a
 * real return type like `HRESULT DoIt()` is untouched), and only in specifier
 * position — immediately followed by whitespace and the identifier that starts
 * the return type or name. That lookahead leaves value/expression uses
 * (`x = FORCEINLINE ? …`), string literals, and longer words
 * (`FORCEINLINE_SOMETHINGELSE`, word-boundary) alone. To cover a new codebase's
 * inline macro, add its exact token to the list.
 */
const CPP_INLINE_MACROS = [
  // Unreal Engine
  'FORCEINLINE_DEBUGGABLE', 'FORCENOINLINE', 'FORCEINLINE',
  // pugixml (ubiquitous vendored XML parser): `#define PUGI__FN inline` before
  // the return type, plus `PUGIXML_FUNCTION` (linkage macro) between the return
  // type and the name — the blank mechanism handles both positions.
  'PUGI__FN_NO_INLINE', 'PUGI__FN', 'PUGIXML_FUNCTION',
  // Godot
  '_ALWAYS_INLINE_', '_FORCE_INLINE_',
  // Boost
  'BOOST_FORCEINLINE', 'BOOST_NOINLINE',
  // Qt (per-method markers + inline)
  'Q_INVOKABLE', 'Q_SCRIPTABLE', 'Q_ALWAYS_INLINE', 'Q_SLOT', 'Q_SIGNAL',
  // Folly / Abseil / LLVM / V8 / Eigen / rapidjson
  'FOLLY_ALWAYS_INLINE', 'FOLLY_NOINLINE',
  'ABSL_ATTRIBUTE_ALWAYS_INLINE', 'ABSL_ATTRIBUTE_NOINLINE',
  'LLVM_ATTRIBUTE_ALWAYS_INLINE', 'LLVM_ATTRIBUTE_NOINLINE',
  'V8_INLINE', 'V8_NOINLINE',
  'EIGEN_STRONG_INLINE', 'EIGEN_ALWAYS_INLINE', 'EIGEN_DEVICE_FUNC',
  'RAPIDJSON_FORCEINLINE',
  // Mozilla / SpiderMonkey
  'MOZ_ALWAYS_INLINE', 'MOZ_NEVER_INLINE',
  // Protocol Buffers
  'PROTOBUF_ALWAYS_INLINE', 'PROTOBUF_NOINLINE',
  // {fmt} / spdlog
  'FMT_CONSTEXPR20', 'FMT_CONSTEXPR', 'FMT_INLINE',
  // Hedley + nlohmann/json (bundles Hedley)
  'JSON_HEDLEY_ALWAYS_INLINE', 'JSON_HEDLEY_NEVER_INLINE',
  'HEDLEY_ALWAYS_INLINE', 'HEDLEY_NEVER_INLINE',
  // GLM (graphics math — pervasive in games/rendering)
  'GLM_FUNC_QUALIFIER', 'GLM_FUNC_DECL', 'GLM_CONSTEXPR', 'GLM_INLINE',
  // Bullet Physics / Skia / OpenCV / EASTL / Cocos2d-x / Chromium-WebKit
  'SIMD_FORCE_INLINE',
  'SK_ALWAYS_INLINE',
  'CV_ALWAYS_INLINE', 'CV_INLINE',
  'EA_FORCE_INLINE', 'EA_NOINLINE',
  'CC_INLINE',
  'NEVER_INLINE',
  // C libraries: GLib, SQLite (internal linkage)
  'G_INLINE_FUNC', 'SQLITE_PRIVATE', 'SQLITE_API',
  // Windows calling conventions (linkage position — recover the return type; the
  // name is salvaged regardless). Only the unambiguous, non-word-like ones.
  'STDMETHODCALLTYPE', 'WINAPIV', 'WINAPI', 'APIENTRY',
  // Common cross-ecosystem inline/attribute hints
  'ALWAYS_INLINE', 'FORCE_INLINE', 'NOINLINE',
] as const;

// One alternation, longest token first so a longer macro wins over a prefix.
const CPP_INLINE_MACRO_RE = new RegExp(
  `\\b(${[...CPP_INLINE_MACROS].sort((a, b) => b.length - a.length).join('|')})\\b(?=\\s+[A-Za-z_])`,
  'g'
);

export function blankCppInlineMacros(source: string): string {
  if (!CPP_INLINE_MACROS.some((m) => source.indexOf(m) !== -1)) return source;
  return source.replace(CPP_INLINE_MACRO_RE, (m) => ' '.repeat(m.length));
}

// Bare C/C++ type/qualifier tokens that must never be taken as a recovered
// function name (guards `recoverMangledCppName` against the `Ret (name)` idiom,
// where the token before the params is the return type, not the name).
const CPP_PRIMITIVE_NAMES = new Set([
  'bool', 'void', 'int', 'char', 'short', 'long', 'float', 'double', 'unsigned',
  'signed', 'wchar_t', 'char8_t', 'char16_t', 'char32_t', 'char_t', 'size_t',
  'auto', 'const', 'struct', 'class', 'enum', 'union', 'typename',
]);

/**
 * Universal fallback (any macro, no list) for a C/C++ function name still mangled
 * because a macro we don't blank sat in front of the return type: `MACRO Ret
 * name(…)` / `Ret MACRO name(…)` misparse so the return type is glued onto the
 * name ("Ret name", "char_t* to_str(double v)"). Recover the real identifier —
 * the token immediately before the parameter list (or the last token). This runs
 * AFTER the curated pre-parse blank, so it only ever sees the residual tail that
 * blanking didn't already fix cleanly (which also recovers the return type).
 *
 * Safe by construction: only touches an ALREADY-mangled name — one with an
 * internal space that isn't a legit `operator …`/destructor — so a well-formed
 * name is returned unchanged. Guarded against the two ways it could mis-pick:
 * the `Ret (name)` parenthesized-name idiom (left as-is, ambiguous), and a token
 * that is a bare primitive/keyword rather than a real identifier.
 */
export function recoverMangledCppName(name: string): string {
  if (!/\s/.test(name) || name.startsWith('operator') || name.startsWith('~')) return name;
  if (/^\S+\s+\([A-Za-z_]\w*\)/.test(name)) return name; // `Ret (name)` idiom — leave alone
  const beforeParams = name.includes('(') ? name.slice(0, name.indexOf('(')) : name;
  const tokens = beforeParams.trim().split(/\s+/);
  const candidate = tokens[tokens.length - 1];
  if (!candidate || !/^[A-Za-z_]\w*$/.test(candidate) || CPP_PRIMITIVE_NAMES.has(candidate)) return name;
  return candidate;
}

/**
 * Blank Metal Shading Language `[[attribute]]` annotations before parsing.
 * MSL (≈ C++14) puts attributes AFTER the declarator — `float4 position
 * [[position]];`, `constant Uniforms &u [[buffer(0)]]` — a position
 * tree-sitter-cpp can't reconcile: a struct field with a trailing attribute
 * misparses into a shape that emits a spurious `extends` reference from the
 * struct to the field's *type* (`VertexIn extends float3`), which becomes a
 * wrong inheritance edge whenever the repo defines that type itself (simd
 * typedefs in a shared ShaderTypes.h are common). Replacing the attribute with
 * equal-length spaces preserves every byte offset and lets fields and
 * parameters parse as ordinary declarations, mirroring the macro blanks above.
 *
 * Matched tightly to the attribute shape — `[[ident]]`, `[[ident(args)]]`, and
 * comma-separated lists (`[[buffer(0), raster_order_group(0)]]`) — so a
 * subscripted lambda call (`arr[[]{ … }()]`, the only other way `[[` appears in
 * C++-family source) can never match: after `[[` a lambda continues with `]`,
 * never an identifier followed by `]]`. Applied ONLY to `.metal` files — in
 * regular C++ the pre-declarator attribute position (`[[nodiscard]] int f()`)
 * is legal syntax the grammar parses natively, and blanking it would be pure
 * blast radius. (#1121)
 */
const METAL_ATTRIBUTE_RE =
  /\[\[\s*[A-Za-z_]\w*(?:\s*\([^()\n]*\))?(?:\s*,\s*[A-Za-z_]\w*(?:\s*\([^()\n]*\))?)*\s*\x5D\x5D/g;

export function blankMetalAttributes(source: string): string {
  if (source.indexOf('[[') === -1) return source;
  return source.replace(METAL_ATTRIBUTE_RE, (m) => ' '.repeat(m.length));
}

/**
 * Blank annotation-style macro invocations that decorate a declaration but carry
 * NO terminating semicolon — the pervasive Unreal-Engine reflection markup
 * (`UPROPERTY(...)`, `UFUNCTION(...)`, `UCLASS(...)`, `GENERATED_BODY()`,
 * `UE_DEPRECATED_FORGAME(...)`, `DECLARE_DELEGATE_*(...)`, …) that sits on its
 * own line right before a member/type. tree-sitter's C++ grammar doesn't know
 * these are macros, so each one drops into error recovery; in a big reflected
 * class (`CharacterMovementComponent.h` has ~240 of them) the errors accumulate
 * until the enclosing `class_specifier` can't close and collapses into an ERROR
 * node — the whole class definition, its members, and its `extends` edges vanish
 * from the graph. Neither `blankCppExportMacros` (class-header export macros) nor
 * `blankCppInlineMacros` (return-type inline specifiers) touches these in-body
 * markup macros. Replacing each with equal-length spaces preserves every byte
 * offset (so line/column stay exact) and the class then parses normally.
 *
 * Deliberately name-list-FREE — UE alone has hundreds of such macros and projects
 * add their own — so it keys on structure, not a curated list, matched tightly to
 * avoid touching legitimate C++:
 *  - the macro must be the FIRST non-whitespace token on its line (`^[ \t]*`),
 *    which is where declaration markup lives — so a macro used inside an
 *    expression or condition (`if (CHECK(x))`, `x = MACRO(a) + b`) is never
 *    matched (it isn't line-leading);
 *  - the name must be ALL-CAPS (`[A-Z][A-Z0-9_]{2,}`), since ordinary
 *    function/type names called at line start are lower/mixed case;
 *  - the char after the balanced `(...)` must START A DECLARATION — a letter,
 *    `_`, `~` (destructor), or `#` (a following directive). Declaration markup is
 *    always followed by the thing it decorates (`UPROPERTY(...)\n float X;`,
 *    `UE_DEPRECATED(...) UPROPERTY(...)`), whereas a statement call is followed by
 *    `;` (`FOO(x);`), an init-list item by `,`/`{`, and an expression fragment by
 *    an operator (`MAKE(a) + 1`) — all rejected. String/char literals inside the
 *    args are skipped so an embedded `)` can't mis-close the balance.
 *
 * C++-only (wired into cppExtractor). A blanked macro inside a block comment is
 * harmless (comments don't parse), and the rare line-leading no-semicolon
 * ALL-CAPS call that isn't markup only loses that one annotation, never a whole
 * class.
 */
function findBalancedParenEnd(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

export function findOpeningParen(line: string, matchLength: number): number {
  return line.indexOf('(', matchLength - 1);
}

export function scanBalancedParenLine(line: string, open: number): { close: number; depth: number } {
  let depth = 0;
  for (let index = open; index < line.length; index++) {
    const ch = line[index];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      index++;
      while (index < line.length && line[index] !== quote) {
        if (line[index] === '\\') index++;
        index++;
      }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return { close: index, depth };
  }
  return { close: -1, depth };
}

export function blankCppAnnotationMacroCalls(source: string): string {
  if (!/^[ \t]*[A-Z][A-Z0-9_]{2,}\s*\(/m.test(source)) return source;
  const chars = source.split('');
  const re = /^([ \t]*)([A-Z][A-Z0-9_]{2,})(\s*)\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const macroStart = m.index + (m[1] ?? '').length; // skip leading indent
    const end = findBalancedParenEnd(source, m.index + m[0].length - 1);
    if (end < 0) continue;
    let j = end;
    while (j < source.length && /\s/.test(source[j] as string)) j++;
    const after = source[j];
    // Only markup is followed by the declaration it decorates; a statement call
    // (`;`), init-list item (`,`/`{`), or expression fragment (operator) is not.
    if (!after || !/[A-Za-z_~#]/.test(after)) continue;
    for (let k = macroStart; k < end; k++) {
      if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' ';
    }
    re.lastIndex = end;
  }
  return chars.join('');
}

/**
 * Blank a macro that is the ONLY token on its line — no parens, no semicolon:
 * namespace-management macros (`FMT_BEGIN_NAMESPACE`, `FMT_END_EXPORT`,
 * `JEMALLOC_DIAGNOSTIC_DISABLE_SPURIOUS`), Qt's `Q_OBJECT`, and friends. A
 * bare identifier is not a statement or declaration in C or C++, so
 * tree-sitter drops into error recovery at every one — and since the kernel
 * path defers ANY erroring file to wasm, this single idiom deferred 13/73 fmt
 * files and a comparable share of jemalloc, forfeiting the native-parse win
 * on exactly the header-heavy trees it targets (the wasm path also mis-nests
 * scopes around them today). Replacing the token with equal-length spaces
 * preserves every byte offset and the surrounding declarations parse clean.
 *
 * Matched tightly so a real identifier can never be touched — ALL of:
 *  - the line consists of ONE ALL-CAPS token (≥4 chars, with `_`), optionally
 *    followed by a same-line comment — a lone lowercase identifier or any
 *    second token disqualifies;
 *  - the PREVIOUS non-blank line does not end in a continuation character
 *    (`=`, an operator, `,`, `(`, `?`, `:`, or a `\` macro-definition
 *    continuation) — so an ALL-CAPS operand split onto its own line inside a
 *    multi-line expression (`int x =\n  SOME_CONST\n  | OTHER;`) is left
 *    alone; and
 *  - the NEXT non-blank line starts like a declaration/scope token
 *    (letter, `_`, `#`, `{`, `}`, or `~`) or the file ends — an operator,
 *    string literal, or `;` continuation rejects the match.
 * Shared by C and C++ (the idiom is identical in both).
 */
const LONE_MACRO_LINE_RE = /^[ \t]*([A-Z][A-Z0-9_]{3,})[ \t]*(?:\/\/[^\n\r]*|\/\*[^\n\r]*\*\/[ \t]*)?\r?$/;

const LONE_MACRO_CONTINUATION_END_RE = /[=+\-*/%&|^<>?:,(\\]$/;

export function blankLoneMacroLines(source: string): string {
  if (!/^[ \t]*[A-Z][A-Z0-9_]{3,}[ \t]*\r?$/m.test(source)) return source;
  const lines = source.split('\n');
  const content = (l: string): string => l.replace(/\r$/, '').trim();
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = LONE_MACRO_LINE_RE.exec(line);
    if (!m) continue;
    // Underscore requirement rides the macro convention (FMT_BEGIN_NAMESPACE,
    // Q_OBJECT); a solid all-caps word (`NDEBUG`-style) alone is too risky.
    if (!(m[1] as string).includes('_')) continue;
    let prev = i - 1;
    while (prev >= 0 && content(lines[prev] as string) === '') prev--;
    if (prev >= 0 && LONE_MACRO_CONTINUATION_END_RE.test(content(lines[prev] as string))) continue;
    let next = i + 1;
    while (next < lines.length && content(lines[next] as string) === '') next++;
    if (next < lines.length) {
      const first = content(lines[next] as string)[0];
      if (!first || !/[A-Za-z_#{}~]/.test(first)) continue;
    }
    const start = line.indexOf(m[1] as string);
    lines[i] =
      line.slice(0, start) + ' '.repeat((m[1] as string).length) + line.slice(start + (m[1] as string).length);
    changed = true;
  }
  return changed ? lines.join('\n') : source;
}

/**
 * Blank an export/visibility macro sitting in front of a *member* or *method*
 * declaration inside a class/namespace (`ENGINE_API virtual void Tick(…)`,
 * `static ENGINE_API void AddReferencedObjects(…)`, `UE_API FVector GetVel()
 * const`), before parsing. `blankCppExportMacros` only recovers the macro in a
 * `class MACRO Name` *header*; the very same macro also prefixes almost every
 * exported member of a big Unreal-Engine class, and tree-sitter — not knowing
 * it's a macro — reads `MACRO <return-type> <name>(` as an extra type token and
 * drops each such declaration into error recovery. In a heavily-exported header
 * (`Actor.h`, `World.h`, …) hundreds of these accumulate: the return types pile
 * up as orphan ERROR tokens and, combined with other markup, can still tip the
 * enclosing class into collapse. Replacing the macro with equal-length spaces
 * preserves every byte offset (line/column stay exact) and each member parses
 * as an ordinary declaration.
 *
 * Matched tightly so it can't touch the same token used as a value
 * (`int x = SOME_API;`, `if (mode == FOO_API)`): the token must be ALL-CAPS AND
 * end in the conventional visibility-macro suffix `_API` / `_EXPORT` / `_ABI`
 * (Unreal `*_API`, Qt/Boost `*_EXPORT`, LLVM `*_ABI`) — ordinary identifiers
 * effectively never carry these suffixes — and must be immediately followed by
 * whitespace then a declaration token (`\s+[A-Za-z_]`: a type, `virtual`,
 * `static`, or the name). A value use is instead followed by `;`, `)`, `,`,
 * `=`, `::`, or an operator, all of which fail the look-ahead. C++-only (wired
 * into cppExtractor).
 */
const CPP_API_PREFIX_RE = /\b[A-Z][A-Z0-9_]*(?:_API|_EXPORT|_ABI)\b(?=\s+[A-Za-z_])/g;

export function blankCppApiPrefixMacros(source: string): string {
  if (!/_(?:API|EXPORT|ABI)\b/.test(source)) return source;
  return source.replace(CPP_API_PREFIX_RE, (m) => ' '.repeat(m.length));
}

/**
 * Blank an Unreal-Engine annotation macro that appears MID-LINE (not
 * line-leading, so `blankCppAnnotationMacroCalls` never sees it) inside a
 * declaration: an enum value's `UMETA(DisplayName="…")`, a parameter's
 * `UPARAM(ref)`, or a deprecation tag wedged into a `using`/member declaration
 * (`using FOnNetTick UE_DEPRECATED(5.5, "…") = TMulticastDelegate<void(float)>;`
 * in `World.h`, which otherwise collapses `UWorld`). tree-sitter can't reconcile
 * these embedded macro calls and drops into error recovery, and a mid-line one
 * inside a big enum or a class-scope `using` can cascade into the whole enum /
 * class being lost. Replacing the entire `MACRO(...)` (balanced parens, string
 * literals skipped so an embedded `)` can't mis-close) with equal-length spaces
 * preserves every byte offset and the declaration parses normally.
 *
 * Keyed on an explicit UE-only name list (`UMETA`, `UPARAM`, and the
 * `UE_DEPRECATED*` family) — these identifiers are exclusive to Unreal's
 * reflection layer and appear in no standard-C++ or other-library code, so
 * blanking them is zero-risk to non-UE sources. (The line-LEADING forms of
 * `UE_DEPRECATED(...)` are already handled by `blankCppAnnotationMacroCalls`;
 * this covers the mid-line forms it structurally can't.) C++-only.
 */
const CPP_INLINE_ANNOTATION_RE = /\b(?:UMETA|UPARAM|UE_DEPRECATED\w*)\s*\(/g;

export function blankCppInlineAnnotationMacros(source: string): string {
  if (!/\b(?:UMETA|UPARAM|UE_DEPRECATED)/.test(source)) return source;
  const chars = source.split('');
  const re = new RegExp(CPP_INLINE_ANNOTATION_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const end = findBalancedParenEnd(source, m.index + m[0].length - 1);
    if (end < 0) continue;
    for (let k = m.index; k < end; k++) {
      if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' ';
    }
    re.lastIndex = end;
  }
  return chars.join('');
}

/**
 * Blank CUDA-specific constructs before parsing `.cu`/`.cuh` files (parsed with
 * the C++ grammar). Three shapes tree-sitter-cpp can't reconcile, each replaced
 * with equal-length whitespace so every byte offset survives (#387):
 *
 * 1. Execution-space / storage specifiers: in `__global__ void step(…)` or
 *    `__shared__ float tile[256]` the specifier parses as the declaration's
 *    TYPE and shunts the real return/value type into an ERROR node — mangling
 *    signatures and, for `__shared__` arrays, the declared name itself. Blanked
 *    unconditionally (no following-token lookahead) so extended lambdas
 *    (`[=] __device__ (int i) { … }`) recover too. `__restrict__` is deliberately
 *    absent: the grammar already parses it natively as a type_qualifier.
 * 2. `__launch_bounds__(…)` between specifier and declarator — same misparse.
 *    The parenthesized form is blanked first; a bare leftover token is caught
 *    by the specifier list.
 * 3. Kernel-launch configs `step<<<grid, block, smem, stream>>>(args)`: the
 *    chevrons lex as shift operators around an empty-named template, so no
 *    call_expression exists and the host→kernel call edge — the main reason to
 *    index CUDA at all — is lost. Blanking the `<<<…>>>` span leaves
 *    `step                              (args)`, a plain call the grammar
 *    parses natively (templated launches `k<T, 256><<<…>>>(…)` included).
 *
 * The launch-config match is deliberately bounded — statement/brace characters
 * excluded, span capped, newlines preserved by the replacer — so a stray `<<<`
 * (a committed merge-conflict marker, a string literal) can never blank a run
 * of real code: an unmatched launch degrades to the status quo for that call
 * site (no call edge), never to corruption. Applied to `.cu`/`.cuh` files and —
 * because much real CUDA lives in extension-less headers (cutlass launches the
 * majority of its kernels from `.h`; flash-attention's launch templates are
 * `.h`; llm.c keeps device helpers in C-detected `.h`) — to any C/C++-family
 * file whose CONTENT carries a strong CUDA marker (`looksLikeCudaSource`).
 * Unlike Metal's `[[attribute]]` (legal C++ syntax elsewhere, hence Metal's
 * strict extension gate), no CUDA marker is valid C++ anywhere: `<<<` isn't
 * legal syntax and the dunder specifiers are implementation-reserved names no
 * real codebase defines — so a content-triggered blank on a non-CUDA file can
 * only ever whitespace tokens inside comments or strings, which parse the same.
 */
const CUDA_LAUNCH_BOUNDS_RE = /\b__launch_bounds__\s*\([^()\n]*\)/g;

const CUDA_SPECIFIER_RE =
  /\b__(?:global|device|host|constant|shared|managed|grid_constant|forceinline|noinline|launch_bounds)__\b/g;

// `;` stays excluded (launch configs are expressions; a stray `<<<` spanning
// real statements always crosses one) and the span is capped. Braces are
// allowed through the regex — `k<<<dim3{1,1,1}, dim3{256,1,1}>>>(…)` is a real
// launch shape — but the replacer only blanks a BALANCED match: a merge
// conflict's `<<<<<<< … >>>>>>>` region that dodges every `;` still opens
// braces it never closes, so it fails the balance check and stays untouched.
const CUDA_LAUNCH_CONFIG_RE = /<<<[^;]{0,400}?>>>/g;

export function blankCudaConstructs(source: string): string {
  let out = source;
  if (out.indexOf('__') !== -1) {
    out = out
      .replace(CUDA_LAUNCH_BOUNDS_RE, (m) => ' '.repeat(m.length))
      .replace(CUDA_SPECIFIER_RE, (m) => ' '.repeat(m.length));
  }
  if (out.indexOf('<<<') !== -1) {
    out = out.replace(CUDA_LAUNCH_CONFIG_RE, (m) => {
      let depth = 0;
      for (let i = 0; i < m.length; i++) {
        const ch = m.charCodeAt(i);
        if (ch === 0x7b /* { */) depth++;
        else if (ch === 0x7d /* } */ && --depth < 0) return m;
      }
      return depth === 0 ? m.replace(/[^\n]/g, ' ') : m;
    });
  }
  return out;
}

/** Strong content markers for CUDA source in files without a CUDA extension
 * (headers). The dunders are execution-space specifiers that only nvcc defines;
 * `cudaStream_t` is the runtime's stream handle, pervasive in launcher headers
 * that themselves declare no kernel. Deliberately excludes weak markers (`dim3`,
 * `<<<`) that could plausibly appear in non-CUDA text. */
export function looksLikeCudaSource(source: string): boolean {
  return (
    source.indexOf('__global__') !== -1 ||
    source.indexOf('__device__') !== -1 ||
    source.indexOf('__constant__') !== -1 ||
    source.indexOf('cudaStream_t') !== -1
  );
}
