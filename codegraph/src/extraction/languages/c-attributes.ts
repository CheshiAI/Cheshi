import { findOpeningParen, scanBalancedParenLine } from './cpp-macros';

/**
 * Blank an unknown attribute macro sitting in front of a C function
 * definition's return type: `SEC_ATTR UINT32 LostName(VOID) { … }` (macro
 * wrapping `__attribute__((…))`, common in embedded/kernel C). tree-sitter's
 * C grammar reads the macro as the declaration's type, the real return type
 * as the declarator, and stores the PARAMETER LIST as the function name —
 * `LostName` indexes as `"(VOID)"` and is unfindable (#1211). The C++ grammar
 * recovers this shape differently (glued name, salvaged post-hoc by
 * `recoverMangledCppName`), but in C the real name never reaches the mangled
 * string, so only a pre-parse blank can recover it.
 *
 * Attribute macros are project-specific (`SEC_ATTR`, `INIT_TEXT`, …), so this
 * keys on structure, not a curated list, matched tightly:
 *  - line-leading (`^[ \t]*`) — declaration position, never an expression use;
 *  - ALL-CAPS token of ≥3 chars (`[A-Z][A-Z0-9_]{2,}`) — ordinary C types in
 *    definitions are rarely spelled this way, and when they are (`UINT32 f()`)
 *    they're followed by ONE identifier + `(`, which the lookahead rejects;
 *  - followed by TWO identifier tokens (return type, then name — `*` allowed
 *    for pointer returns) and then `(` — i.e. exactly the
 *    `MACRO Ret name(` definition shape. `MACRO name(` calls, `#define`
 *    lines (start with `#`), and multi-word builtin returns
 *    (`MACRO unsigned int f(` — where the C grammar already keeps the name)
 *    are all left untouched.
 * Equal-length spaces preserve every byte offset, like the C++ blanks above.
 */
const C_LEADING_ATTR_MACRO_RE =
  /^([ \t]*)([A-Z][A-Z0-9_]{2,})(?=\s+[A-Za-z_]\w*[\s*]+[A-Za-z_]\w*\s*\()/gm;

export function blankCLeadingAttrMacros(source: string): string {
  return source.replace(
    C_LEADING_ATTR_MACRO_RE,
    (_m, ws: string, macro: string) => ws + ' '.repeat(macro.length)
  );
}

/**
 * Blank the body of `#ifdef __cplusplus … #endif` guard regions in C sources.
 * The ubiquitous C-header compatibility idiom
 *
 *   #ifdef __cplusplus
 *   extern "C" {
 *   #endif
 *
 * is NOT valid C — `extern "C" {` (and any other C++-only line under the
 * guard) drops tree-sitter-c into error recovery, so effectively every public
 * C header carries parse errors. The wasm path shrugs (recovery keeps the
 * rest); the kernel path defers EVERY erroring file to wasm by policy — so
 * this one idiom pushed C-header deferral to ~32% on redis (vs the <10%
 * gate) and forfeited the native-parse win exactly where C repos have the
 * most files. A C compiler never sees the guarded lines (`__cplusplus` is
 * only defined for C++), so blanking the region BODY mirrors the
 * preprocessor's own view of the file.
 *
 * Matched conservatively, line-based and offset-preserving:
 *  - the opener must be `#ifdef __cplusplus` / `#if defined(__cplusplus)`;
 *  - the body may contain NO other preprocessor directive (a nested `#if`,
 *    `#else`, or `#define` bails the whole region — those need real
 *    preprocessing, so the file keeps its current behavior);
 *  - the region must close with `#endif` within a few lines (guards are
 *    tiny; a giant region is something else).
 * The `#ifdef`/`#endif` directive lines themselves are kept — an empty
 * preproc_ifdef parses clean — and every blanked byte becomes a space with
 * `\r` preserved, so offsets, lines, and columns survive on CRLF checkouts.
 */
const C_CPLUSPLUS_GUARD_OPEN_RE =
  /^[ \t]*#[ \t]*(?:ifdef[ \t]+__cplusplus\b|if[ \t]+defined[ \t]*\(?[ \t]*__cplusplus[ \t]*\)?)/;

const C_PREPROC_DIRECTIVE_RE = /^[ \t]*#/;

const C_PREPROC_ENDIF_RE = /^[ \t]*#[ \t]*endif\b/;

const C_CPLUSPLUS_GUARD_MAX_BODY_LINES = 40;

export function blankCCplusplusGuardBodies(source: string): string {
  if (source.indexOf('__cplusplus') === -1) return source;
  const lines = source.split('\n');
  const stripCr = (l: string): string => (l.endsWith('\r') ? l.slice(0, -1) : l);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!C_CPLUSPLUS_GUARD_OPEN_RE.test(stripCr(lines[i] as string))) continue;
    let end = -1;
    for (let j = i + 1; j < lines.length && j - i - 1 <= C_CPLUSPLUS_GUARD_MAX_BODY_LINES; j++) {
      const line = stripCr(lines[j] as string);
      if (C_PREPROC_ENDIF_RE.test(line)) {
        end = j;
        break;
      }
      if (C_PREPROC_DIRECTIVE_RE.test(line)) break; // nested directive — bail
    }
    if (end < 0) continue;
    for (let k = i + 1; k < end; k++) {
      lines[k] = (lines[k] as string).replace(/[^\r]/g, ' ');
    }
    changed = true;
    i = end;
  }
  return changed ? lines.join('\n') : source;
}

/**
 * Blank a C iterator-macro call in STATEMENT position — `ql_foreach(iter,
 * &arena->tcache_ql, link) { … }` (jemalloc), `for_each_string_list_item(item,
 * &list) { … }` (git), `list_for_each_entry(pos, head, member) { … }` (the
 * Linux kernel's core iteration idiom). A call followed by a brace block is
 * not a C statement, so tree-sitter-c drops into error recovery at every use —
 * these macros are the single largest source of parse errors in macro-heavy C
 * trees (git: ~39% of files error; the kernel path defers each one to wasm).
 * Blanking JUST the macro call leaves the brace block as a bare compound
 * statement — valid C — so the body's calls/locals extract normally on both
 * arms instead of riding error recovery.
 *
 * C-ONLY, and matched tightly:
 *  - the call must be INDENTED (statement position; file-scope definitions
 *    start at column 0, and an unbraced file-scope `name(args) { }` is a
 *    valid implicit-int function definition that must not be touched);
 *  - lowercase-led identifier (iterator macros are lowercase by convention;
 *    this also excludes constructors if the file is really C++) that is not a
 *    control keyword;
 *  - the parens balance ON the line (string literals skipped), and after
 *    them only `{` or end-of-line may follow — a `;` (a real call statement),
 *    an operator, or any other token disqualifies;
 *  - when the line ends at `)`, the NEXT non-blank line must begin with `{`.
 * C++ deliberately does NOT get this pass: an indented snake_case
 * constructor (`basic_string_view(const Char* s) : … {`) is exactly this
 * shape, and blanking it would corrupt every STL-style class.
 */
const C_STMT_MACRO_KEYWORDS = new Set([
  'if', 'while', 'for', 'switch', 'return', 'do', 'else', 'sizeof',
]);

export function blankCStatementMacroCalls(source: string): string {
  const lines = source.split('\n');
  let changed = false;
  const content = (l: string): string => l.replace(/\r$/, '').trim();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = /^[ \t]+([a-z_][a-z0-9_]*)[ \t]*\(/.exec(line);
    if (!m || C_STMT_MACRO_KEYWORDS.has(m[1] as string)) continue;
    const open = findOpeningParen(line, m[0].length);
    const scan = scanBalancedParenLine(line, open);
    let close = scan.close;
    let depth = scan.depth;
    let endLine = i;
    if (close < 0) {
      // Parens don't balance on the head line — the kernel wraps iterator
      // macros (`hlist_for_each_entry_rcu(p, head, hlist,\n\t\t
      // lockdep_is_held(&kprobe_mutex)) {`). Continue the same
      // string-skipping paren scan over a few continuation lines. A `;` or
      // a brace anywhere in the span means a real statement or compound
      // literal — bail (missing a blank is safe; corrupting one is not).
      if (line.indexOf(';') !== -1) continue;
      for (let j = i + 1; j <= i + 5 && j < lines.length && close < 0; j++) {
        const cont = lines[j] as string;
        let bail = false;
        for (let k = 0; k < cont.length; k++) {
          const ch = cont[k];
          if (ch === '"' || ch === "'") {
            const quote = ch;
            k++;
            while (k < cont.length && cont[k] !== quote) {
              if (cont[k] === '\\') k++;
              k++;
            }
            continue;
          }
          if (ch === ';' || ch === '{' || ch === '}') {
            bail = true;
            break;
          }
          if (ch === '(') depth++;
          else if (ch === ')') {
            depth--;
            if (depth === 0) {
              close = k;
              endLine = j;
              break;
            }
          }
        }
        if (bail) break;
      }
      if (close < 0) continue;
    }
    const endLineStr = lines[endLine] as string;
    const after = endLineStr.slice(close + 1).replace(/\r$/, '').trim();
    if (after === '') {
      // Brace on the next line (`ql_foreach(…)\n{`) or a brace-less
      // single-statement body (`for_each_subsys(ss, i)\n\tstmt;` — blanking
      // leaves the bare statement, valid C). A next line starting with an
      // operator/string/`;` is an expression continuation — bail.
      let next = endLine + 1;
      while (next < lines.length && content(lines[next] as string) === '') next++;
      if (next >= lines.length) continue;
      const first = content(lines[next] as string)[0];
      if (!first || !/[A-Za-z_{]/.test(first)) continue;
    } else if (after !== '{') {
      continue;
    }
    const identStart = line.indexOf(m[1] as string);
    if (endLine === i) {
      lines[i] =
        line.slice(0, identStart) +
        ' '.repeat(close + 1 - identStart) +
        line.slice(close + 1);
    } else {
      lines[i] = line.slice(0, identStart) + line.slice(identStart).replace(/[^\r]/g, ' ');
      for (let j = i + 1; j < endLine; j++) {
        lines[j] = (lines[j] as string).replace(/[^\r]/g, ' ');
      }
      lines[endLine] =
        endLineStr.slice(0, close + 1).replace(/[^\r]/g, ' ') + endLineStr.slice(close + 1);
      i = endLine; // the blanked span can't host another head
    }
    changed = true;
  }
  return changed ? lines.join('\n') : source;
}

/**
 * Blank a lowercase compiler-annotation word SANDWICHED between a storage
 * class and the rest of a declaration — `static notrace void tick(…)`,
 * `static nokprobe_inline void arm(…)` (kernel compiler.h markers). The
 * dunder word-list can't carry these bare-word forms: `notrace` is a
 * plausible identifier. The sandwich IS the guard — the token counts only
 * when directly preceded by `static`/`extern`/`inline` AND followed by
 * another word, a position where it cannot be a variable name (an archaic
 * implicit-int `static notrace = 1;` fails the following-word requirement).
 * C-only.
 */
const C_SANDWICHED_ANNOTATIONS = [
  'noinline_for_stack', 'nokprobe_inline', 'noinline', 'notrace', 'noinstr',
] as const;

const C_SANDWICH_RE = new RegExp(
  `\\b(static|extern|inline)([ \\t]+)(${C_SANDWICHED_ANNOTATIONS.join('|')})\\b(?=[ \\t]+[A-Za-z_])`,
  'g'
);

export function blankCSandwichedAnnotations(source: string): string {
  C_SANDWICH_RE.lastIndex = 0;
  if (!C_SANDWICH_RE.test(source)) return source;
  C_SANDWICH_RE.lastIndex = 0;
  return source.replace(
    C_SANDWICH_RE,
    (_m, storage: string, ws: string, ann: string) => storage + ws + ' '.repeat(ann.length)
  );
}

/**
 * Blank a C23 `auto` type-inference keyword — `auto hb = hbr.hb;` (the
 * futex code; tree-sitter-c predates C23 auto and errors the enclosing
 * function). The old storage-class reading (`auto int x = 1;`) has a TYPE
 * between `auto` and the `=` and is untouched — the match requires
 * `auto IDENT =` directly, which only the C23 form exhibits. Blanking
 * leaves a plain assignment statement. C-only.
 */
const C_AUTO_INFER_RE = /\bauto(?=[ \t]+[A-Za-z_]\w*[ \t]*=)/g;

export function blankCAutoInference(source: string): string {
  C_AUTO_INFER_RE.lastIndex = 0;
  if (!C_AUTO_INFER_RE.test(source)) return source;
  C_AUTO_INFER_RE.lastIndex = 0;
  return source.replace(C_AUTO_INFER_RE, () => '    ');
}

/**
 * Blank a trailing parameter-attribute macro — `int argc UNUSED,` /
 * `struct repository *repo UNUSED)` — git's house style for
 * `__attribute__((unused))` on nearly every callback parameter (and the same
 * shape as `MAYBE_UNUSED`/`G_GNUC_UNUSED` elsewhere). tree-sitter-c can't
 * parse a second identifier after the parameter name, so every such
 * SIGNATURE drops into error recovery — the single largest deferral bucket
 * on git (~150 files). Blanking the macro leaves an ordinary parameter.
 *
 * Matched tightly: an identifier, whitespace, then an ALL-CAPS ≥3-char token
 * immediately before `,` or `)`. Two juxtaposed identifiers in that position
 * have no other valid-C reading — in a CALL the would-be macro is preceded
 * by `,`/`(`, an operator, or a literal, never by a bare identifier. C-only:
 * C++ grammars accept more juxtapositions (user-defined suffixes, macro'd
 * `final`/`override`), so cpp keeps its existing recovery there.
 */
const C_TRAILING_PARAM_ATTR_RE = /\b([A-Za-z_]\w*)([ \t]+)([A-Z][A-Z0-9_]{2,})(?=[ \t]*[,)])/g;

export function blankCTrailingParamAttrMacros(source: string): string {
  if (!C_TRAILING_PARAM_ATTR_RE.test(source)) {
    C_TRAILING_PARAM_ATTR_RE.lastIndex = 0;
    return source;
  }
  C_TRAILING_PARAM_ATTR_RE.lastIndex = 0;
  return source.replace(
    C_TRAILING_PARAM_ATTR_RE,
    (_m, name: string, ws: string, macro: string) => name + ws + ' '.repeat(macro.length)
  );
}
