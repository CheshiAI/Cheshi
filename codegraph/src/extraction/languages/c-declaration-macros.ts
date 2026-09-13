import { findOpeningParen, scanBalancedParenLine } from './cpp-macros';

/**
 * Blank the Linux-kernel/sparse declaration-annotation macros — `static int
 * __init audit_init(void)`, `void __user *buf`, `__bpf_kfunc void f(…)`,
 * `int x __ro_after_init;`. These lowercase double-underscore annotations sit
 * between storage/type tokens and the declarator, a position tree-sitter-c
 * can't reconcile, and they blanket the Linux tree: measured on the kernel's
 * own `kernel/` + `mm/` subtrees, they are the largest single deferral cause
 * (the `__init` family alone heads ~37% of erroring files).
 *
 * A structural match is IMPOSSIBLE here: `__u32 count` (a real typedef) and
 * `__init foo` (an annotation) are byte-shape identical — so unlike the
 * shape-keyed blanks above, this is a CURATED list (the CPP_INLINE_MACROS
 * precedent) of well-known sparse/section/compiler annotations that are
 * reserved-namespace macros in every codebase that spells them. Whole-word,
 * equal-length spaces, C-only (the C++ grammar's kernel exposure is
 * negligible and cpp keeps its narrower blank set).
 */
const C_KERNEL_ANNOTATIONS = [
  '__init', '__exit', '__initdata', '__initconst', '__exitdata',
  '__devinit', '__devexit', '__cpuinit', '__meminit', '__meminitdata',
  '__net_init', '__net_exit', '__net_initdata', '__init_or_module',
  '__user', '__kernel', '__iomem', '__percpu', '__rcu', '__force', '__nocast',
  '__must_check', '__maybe_unused', '__always_unused', '__used', '__cold',
  '__hot', '__weak', '__pure', '__sched', '__malloc', '__visible',
  '__deprecated', '__ro_after_init', '__read_mostly', '__refdata',
  '__latent_entropy', '__randomize_layout', '__no_randomize_layout',
  '__bpf_kfunc', '__function_aligned', '__always_inline', '__noreturn',
  // Round-2 additions, each measured heading first-error lines on the
  // v7.2-rc2 kernel/+mm/ census (2026-07-17): cacheline placement, sparse
  // lock/section markers, and bpf/typecheck annotations. Real dunder TYPES
  // (`__u32`, `__s64`) and operators (`__alignof__`) are deliberately absent.
  '__cacheline_aligned_in_smp', '__cacheline_aligned',
  '__cacheline_internodealigned_in_smp', '____cacheline_aligned_in_smp',
  '____cacheline_aligned', '____cacheline_internodealigned_in_smp',
  '__noclone', '__lockfunc', '__ref', '__private', '__bitwise',
  '__nosavedata', '__no_kcsan', '__cpuidle', '__ksym',
  '__initdata_memblock', '__initdata_or_meminfo',
] as const;

// `(?!\s*\()` keeps the parameterized annotations (`__printf(1, 2)`,
// `__aligned(8)`, `__section("x")`) intact — blanking just their name would
// strand the argument list as a floating parenthesis and CREATE an error.
const C_KERNEL_ANNOTATION_RE = new RegExp(
  `\\b(${[...C_KERNEL_ANNOTATIONS].sort((a, b) => b.length - a.length).join('|')})\\b(?!\\s*\\()`,
  'g'
);

export function blankCKernelAnnotations(source: string): string {
  if (source.indexOf('__') === -1) return source;
  C_KERNEL_ANNOTATION_RE.lastIndex = 0;
  if (!C_KERNEL_ANNOTATION_RE.test(source)) return source;
  let out = source.replace(C_KERNEL_ANNOTATION_RE, (m) => ' '.repeat(m.length));
  // `container_of(ptr, struct T, member)` — the type-keyword argument is the
  // one call shape tree-sitter-c cannot read (a macro taking a TYPE), and it
  // is pervasive across the Linux tree. Blanking just the `struct`/`union`
  // keyword leaves `container_of(ptr,        T, member)` — a plain
  // identifier argument the grammar parses natively. Keyed to the macro name
  // so no other `struct` keyword anywhere is ever touched.
  if (out.indexOf('container_of') !== -1) {
    out = out.replace(
      /(\bcontainer_of\s*\([^;()]*?,\s*)(struct|union)(\s+)/g,
      (_m, head: string, kw: string, ws: string) => head + ' '.repeat(kw.length) + ws
    );
  }
  return out;
}

/**
 * Blank the PARAMETERIZED sparse/compiler annotations whole — name AND
 * argument list — `struct file *f __free(fput) = NULL;`, `static void
 * __printf(4, 0) log_it(…)`, `} owners[] __counted_by(count);`,
 * `__bpf_md_ptr(struct bpf_iter_meta *, meta);`. The word-list blank above
 * deliberately skips these via `(?!\s*\()` because blanking just the NAME
 * strands `(args)` as a floating parenthesis — so every such file kept
 * deferring (the v7.2-rc2 kernel/+mm/ census puts `__free`/`__printf`/
 * `__counted_by`/`__aligned` at the head of 39 first-error lines). Blanking
 * the whole `__name(args)` span leaves an ordinary declaration.
 *
 * CURATED for the same reason as the word list: `__aligned(8)` (annotation)
 * and `__hash(key)` (a real static helper call) are byte-shape identical, so
 * only reserved-namespace names that are annotations in every codebase that
 * spells them are listed. One nesting level of parens is allowed
 * (`__aligned(sizeof(struct x))`); newlines inside the span survive so byte
 * offsets are preserved. C-only.
 */
const C_PARAMETERIZED_ANNOTATIONS = [
  '__free', '__printf', '__scanf', '__counted_by', '__counted_by_le',
  '__counted_by_be', '__guarded_by', '__pt_guarded_by', '__acquires',
  '__releases', '__must_hold', '__cleanup', '__aligned', '__section',
  '__bpf_md_ptr', '__assume_aligned',
] as const;

const C_PARAM_ANNOTATION_RE = new RegExp(
  `\\b(${[...C_PARAMETERIZED_ANNOTATIONS].sort((a, b) => b.length - a.length).join('|')})[ \\t]*\\((?:[^()]|\\([^()]*\\))*\\)`,
  'g'
);

export function blankCParameterizedAnnotationMacros(source: string): string {
  if (source.indexOf('__') === -1) return source;
  C_PARAM_ANNOTATION_RE.lastIndex = 0;
  if (!C_PARAM_ANNOTATION_RE.test(source)) return source;
  C_PARAM_ANNOTATION_RE.lastIndex = 0;
  let result = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = C_PARAM_ANNOTATION_RE.exec(source)) !== null) {
    const start = m.index;
    let end = start + (m[0] as string).length;
    // Field-position form — `__bpf_md_ptr(struct bpf_iter_meta *, meta);` as
    // the whole line: a lone `;` field is ITSELF a parse error (measured;
    // an empty struct body is fine), so the semicolon blanks with it. A
    // mid-line match (`… __free(fput) = NULL;`) keeps its statement tail.
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    if (/^[ \t]*$/.test(source.slice(lineStart, start))) {
      const after = /^[ \t]*;/.exec(source.slice(end));
      if (after) end += after[0].length;
    }
    result += source.slice(last, start) + source.slice(start, end).replace(/[^\n\r]/g, ' ');
    last = end;
  }
  return result + source.slice(last);
}

/**
 * Blank a bare `struct`/`union`/`enum` TYPE-keyword argument inside a macro
 * call — `kzalloc_obj(struct bpf_mount_opts)`, `alloc_percpu(struct irqstat)`,
 * `list_first_entry(&pending,\n\t\tstruct async_entry, domain_list)` — the
 * `container_of` disease generalized (that blank stays as the keyed
 * precedent). A bare type is never a valid C expression argument, so
 * tree-sitter drops into error recovery at every such call; removing just the
 * keyword leaves a plain identifier argument the grammar parses natively.
 * This single shape heads ~35 first-error lines on the kernel/+mm/ census
 * (kzalloc_obj/list_entry/alloc_percpu + multi-line continuations).
 *
 * Guarded three ways, because `f(struct T)` has VALID look-alikes:
 *  - head exclusions: `sizeof(struct T)` / `offsetof(struct T, m)` /
 *    `_Generic(x, struct T *: …)` all parse natively (probed) and must keep
 *    their keyword; `va_arg` gets its own dedicated blank below.
 *  - call-vs-declaration: in `int wf(struct a, struct b);` (a wrapped
 *    prototype — valid C) the head is preceded by a TYPE, so any identifier
 *    or `*` before the head rejects the match — except the word `return`,
 *    which precedes real calls. Newline/`=`/`,`/`(`/`;`/`{`/`>` etc. accept.
 *  - the keyword must OPEN a top-level argument and the argument must be
 *    exactly `struct T` (optionally `struct T *`, whose stars blank too —
 *    `DEFINE_PER_CPU(struct task_struct *, ksoftirqd)` leaves two plain
 *    identifier arguments): a cast (`f((struct T *)p)`) opens a nested
 *    group, and a declaration argument (`TP_PROTO(struct foo *bar)`) trails
 *    an extra identifier — neither matches.
 * A hand-rolled bounded scanner rather than a nested-alternation regex:
 * preceding args may themselves contain calls
 * (`hlist_entry_safe(rcu_dereference_raw(hlist_next_rcu(&d->h)),\n
 * struct bpf_dtab_netdev, index_hlist)`), and lazy nested regex groups over
 * untrusted repo text invite catastrophic backtracking. C-only.
 */
const C_TYPE_ARG_HEAD_EXCLUSIONS = new Set([
  'sizeof', 'alignof', '_Alignof', 'typeof', '__typeof__', '__typeof',
  'offsetof', '_Generic', 'va_arg', 'if', 'while', 'for', 'switch', 'case',
]);

const C_TYPE_ARG_HEAD_RE = /\b([A-Za-z_]\w*)[ \t]*\(/g;

const C_TYPE_ARG_OPENER_RE = /^(struct|union|enum)([ \t\r\n]+)([A-Za-z_]\w*)([ \t\r\n]*\*+)?(?=[ \t\r\n]*[,)])/;

const C_TYPE_ARG_SCAN_CAP = 600;

export function blankCTypeKeywordArgs(source: string): string {
  if (!/\b(?:struct|union|enum)[ \t\r\n]/.test(source)) return source;
  let chars: string[] | null = null;
  C_TYPE_ARG_HEAD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = C_TYPE_ARG_HEAD_RE.exec(source)) !== null) {
    const head = m[1] as string;
    if (C_TYPE_ARG_HEAD_EXCLUSIONS.has(head)) continue;
    // Reject declaration shapes: an identifier or `*` (a return/field type)
    // immediately before the head — unless that word is `return`.
    let j = m.index - 1;
    while (j >= 0 && (source[j] === ' ' || source[j] === '\t')) j--;
    const prev = j >= 0 ? (source[j] as string) : '';
    if (/[\w*]/.test(prev)) {
      let w = j;
      while (w >= 0 && /\w/.test(source[w] as string)) w--;
      if (source.slice(w + 1, j + 1) !== 'return') continue;
    }
    const open = m.index + (m[0] as string).length - 1;
    let depth = 1;
    let atArgStart = true;
    for (let k = open + 1; k < source.length && k - open <= C_TYPE_ARG_SCAN_CAP; k++) {
      const ch = source[k] as string;
      if (ch === '"' || ch === "'") {
        const quote = ch;
        k++;
        while (k < source.length && source[k] !== quote) {
          if (source[k] === '\\') k++;
          k++;
        }
        atArgStart = false;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
      if (ch === '(') {
        depth++;
        atArgStart = false;
        continue;
      }
      if (ch === ')') {
        depth--;
        if (depth === 0) break;
        atArgStart = false;
        continue;
      }
      if (ch === ';' || ch === '{' || ch === '}') break; // not an argument list
      if (ch === ',') {
        if (depth === 1) atArgStart = true;
        continue;
      }
      if (depth === 1 && atArgStart) {
        const opener = C_TYPE_ARG_OPENER_RE.exec(source.slice(k, k + 160));
        if (opener) {
          chars ??= [...source];
          const kw = opener[1] as string;
          for (let b = k; b < k + kw.length; b++) chars[b] = ' ';
          if (opener[4]) {
            const tail = opener[4] as string;
            const stars = (/\*+$/.exec(tail) as RegExpExecArray)[0].length;
            const starsStart =
              k + kw.length + (opener[2] as string).length + (opener[3] as string).length + (tail.length - stars);
            for (let b = starsStart; b < starsStart + stars; b++) chars[b] = ' ';
          }
          k += (opener[0] as string).length - 1;
        }
      }
      atArgStart = false;
    }
  }
  return chars ? chars.join('') : source;
}

/**
 * Blank a file-scope `static`/`extern`-prefixed ALL-CAPS declaration macro —
 * `static DEFINE_PER_CPU(struct llist_head, rstat_backlog_list);`,
 * `static DECLARE_WORK(init_free_wq, do_free_init);`,
 * `static DEFINE_RATELIMIT_STATE(ratelimit, 5 * HZ, 5);` — the single
 * largest deferral family on the kernel/+mm/ census (~45 first-error lines
 * across the DEFINE_/DECLARE_ variants). A storage-class specifier followed
 * by a call expression is never valid C, so every one errors; the whole line
 * blanks to spaces (the macro-declared variable was invisible to extraction
 * anyway, and the file's remaining symbols recover).
 *
 * The UNPREFIXED form (`EXPORT_SYMBOL(x);`, `DEFINE_MUTEX(lock);` at column
 * 0) parses natively as a K&R implicit-int declaration (probed) — extraction
 * ignores declarations, so those lines are left alone; the type-keyword-arg
 * blank above already recovers the `DEFINE_PER_CPU(struct T, x);` bare form.
 * Matched tightly: `static`/`extern` first on the line (indentation allowed —
 * `static DEFINE_RATELIMIT_STATE(…)` appears at BLOCK scope too, and the
 * storage-class-plus-call shape is invalid at every scope), CAPS macro name,
 * parens balancing ON the line (string literals skipped), then exactly `;`
 * to end of line. Initializer forms (`… ) = { …`) are deliberately not
 * matched — blanking the head would strand the brace block. C-only.
 */
const C_PREFIXED_DECL_MACRO_RE = /^[ \t]*(?:static|extern)[ \t]+[A-Z][A-Z0-9_]{2,}[ \t]*\(/;

export function blankCFileScopePrefixedDeclMacros(source: string): string {
  if (!/^[ \t]*(?:static|extern)[ \t]+[A-Z]/m.test(source)) return source;
  const lines = source.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = C_PREFIXED_DECL_MACRO_RE.exec(line);
    if (!m) continue;
    const open = findOpeningParen(line, m[0].length);
    const { close } = scanBalancedParenLine(line, open);
    if (close < 0) continue; // spans lines — leave for a future round
    if (line.slice(close + 1).replace(/\r$/, '').trim() !== ';') continue;
    lines[i] = line.replace(/[^\n\r]/g, ' ');
    changed = true;
  }
  return changed ? lines.join('\n') : source;
}

/**
 * REWRITE (the one non-blank pass in this family — it moves a token) a
 * 2-argument `static CAPS_MACRO(type, name) = {`-style initialized
 * declaration macro into the declaration it expands to — `static
 * DEFINE_PER_CPU(struct cpuhp_cpu_state, cpuhp_state) = {` becomes `static
 * struct cpuhp_cpu_state       cpuhp_state) …` → `static struct
 * cpuhp_cpu_state` + padding + `cpuhp_state` + padding + `= {`. The blank
 * family can't help here: blanking the head strands the brace block, and
 * dropping the whole span would discard the initializer's function
 * references (`.startup.single = bringup_cpu` — real cFnPtr wiring). The
 * NAME keeps its exact original column and the `= {` tail keeps its exact
 * offsets (`d`-flag group indices); only the TYPE token sits left of where
 * the macro name was, and type tokens contribute strings, not positions.
 * Only the two-argument `(<type-ish>, <ident>)` form with an `=` tail
 * matches; three-argument macros and `;`-terminated forms (the blank above)
 * never do. C-only.
 */
const C_PREFIXED_DECL_MACRO_INIT_RE = /^([ \t]*)static[ \t]+[A-Z][A-Z0-9_]{2,}[ \t]*\(([^();'"]*?),[ \t]*([A-Za-z_]\w*)[ \t]*\)([ \t]*=[ \t]*\{?[ \t]*\r?)$/d;

export function rewriteCPrefixedDeclMacroInitializers(source: string): string {
  if (!/^[ \t]*static[ \t]+[A-Z]/m.test(source)) return source;
  const lines = source.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = C_PREFIXED_DECL_MACRO_INIT_RE.exec(line);
    if (!m) continue;
    const indices = (m as RegExpExecArray & { indices: Array<[number, number]> }).indices;
    const arg1 = (m[2] as string).trim().replace(/[ \t]+/g, ' ');
    if (!/^[A-Za-z_][\w \t*]*$/.test(arg1)) continue; // a type-token run only
    const name = m[3] as string;
    const nameStart = (indices[3] as [number, number])[0];
    const tailStart = (indices[4] as [number, number])[0];
    const prefix = (m[1] as string) + 'static ' + arg1;
    if (prefix.length + 1 > nameStart) continue; // rewrite must fit left of the name
    lines[i] =
      prefix +
      ' '.repeat(nameStart - prefix.length) +
      name +
      ' '.repeat(tailStart - nameStart - name.length) +
      line.slice(tailStart);
    changed = true;
  }
  return changed ? lines.join('\n') : source;
}

/**
 * Blank a QUALIFIED/POINTER type argument of `va_arg` — `va_arg(ap, const
 * char *)`, `va_arg(args, unsigned long)`. tree-sitter-c parses the
 * single-token forms (`va_arg(ap, int)`, `va_arg(ap, foo_t)`) natively
 * (probed), but multi-token type descriptors error the whole enclosing
 * function. Blanking the comma and the entire second argument leaves
 * `va_arg(ap              )` — a one-argument call the grammar accepts.
 * Function-pointer types (`va_arg(ap, void (*)(int))`) contain parens and
 * are deliberately unmatched. C-only.
 */
const C_VA_ARG_RE = /\bva_arg[ \t]*\(([^(),]+)(,[^()]*)\)/g;

export function blankCVaArgQualifiedTypeArgs(source: string): string {
  if (source.indexOf('va_arg') === -1) return source;
  C_VA_ARG_RE.lastIndex = 0;
  return source.replace(C_VA_ARG_RE, (m, arg1: string, rest: string) => {
    if (/^,[ \t]*[A-Za-z_]\w*[ \t]*$/.test(rest)) return m; // single token — parses natively
    return `va_arg(${arg1}${rest.replace(/[^\n\r]/g, ' ')})`;
  });
}

/**
 * Blank the DOTS of a GNU NAMED-variadic function-like `#define` parameter —
 * `#define verbose(env, fmt, args...) …` → `#define verbose(env, fmt,
 * args   ) …`. The `ident...` parameter form (unlike standard `...`) errors
 * the DIRECTIVE itself (measured — and so does trailing whitespace after a
 * bare `#define NAME`, which is why the tail is NOT blanked wholesale); with
 * just the dots blanked the params parse as ordinary identifiers and the
 * body (`##args` included — the preproc body is opaque to the grammar) is
 * untouched. `restoreDirectiveLines` exists to keep directives out of the
 * other blanks' blast radius, so this pass runs AFTER the restore and edits
 * the directive deliberately. Multi-line bodies are fine — the params always
 * sit on the `#define` line. C-only (the census hits are the kernel's bpf
 * verifier headers).
 */
const C_NAMED_VARIADIC_DEFINE_RE = /^([ \t]*#[ \t]*define[ \t]+[A-Za-z_]\w*\([^()\n]*?\b\w+)\.\.\./;

export function blankCNamedVariadicDefineDots(source: string): string {
  if (source.indexOf('...') === -1) return source;
  const lines = source.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = C_NAMED_VARIADIC_DEFINE_RE.exec(line);
    if (!m) continue;
    const keep = m[1] as string;
    lines[i] = keep + '   ' + line.slice(keep.length + 3);
    changed = true;
  }
  return changed ? lines.join('\n') : source;
}
