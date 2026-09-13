import { describe, expect, it } from 'bun:test';

export function registerCCKernelPortPreparseBlanksR7aTests(): void {


  // R7a preParse additions — the blanking passes added so macro-heavy C/C++
  // parses clean enough for the kernel route (each also improves the wasm
  // path's own graphs). Offset preservation is load-bearing everywhere.
  describe('C/C++ kernel-port preParse blanks (R7a)', () => {
    it('blankCCplusplusGuardBodies blanks extern-C guard bodies, keeps directives', async () => {
      const { blankCCplusplusGuardBodies } = await import('../src/extraction/languages/c-cpp');
      const src = [
        '#ifdef __cplusplus',
        'extern "C" {',
        '#endif',
        'int real_decl(void);',
        '#ifdef __cplusplus',
        '}',
        '#endif',
        '',
      ].join('\n');
      const out = blankCCplusplusGuardBodies(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('extern "C"');
      expect(out).toContain('#ifdef __cplusplus'); // directives stay
      expect(out).toContain('int real_decl(void);');
      // A guard with a nested directive bails (needs real preprocessing).
      const nested = [
        '#ifdef __cplusplus',
        '#define EXTERNC extern "C"',
        '#endif',
        '',
      ].join('\n');
      expect(blankCCplusplusGuardBodies(nested)).toBe(nested);
      // The `#ifndef` inverse guard is C-visible and must be untouched.
      const inverse = ['#ifndef __cplusplus', 'int c_only(void);', '#endif', ''].join('\n');
      expect(blankCCplusplusGuardBodies(inverse)).toBe(inverse);
    });

    it('blankLoneMacroLines blanks namespace-management macros, spares expression operands', async () => {
      const { blankLoneMacroLines } = await import('../src/extraction/languages/c-cpp');
      const src = ['FMT_BEGIN_NAMESPACE', 'struct S { int x; };', 'FMT_END_NAMESPACE', ''].join('\n');
      const out = blankLoneMacroLines(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('FMT_BEGIN_NAMESPACE');
      expect(out).toContain('struct S { int x; };');
      // An ALL-CAPS operand alone on a line inside a multi-line expression is
      // NOT a lone macro — the next line starts with an operator.
      const expr = ['int x = 0', '  | FLAG_ONE', '  | FLAG_TWO;', ''].join('\n');
      expect(blankLoneMacroLines(expr)).toBe(expr);
      const cont = ['int y =', 'SOME_FLAG', '| OTHER;', ''].join('\n');
      expect(blankLoneMacroLines(cont)).toBe(cont);
      // Underscore-free solid words are too risky and stay.
      const bare = ['NDEBUG', 'int z;', ''].join('\n');
      expect(blankLoneMacroLines(bare)).toBe(bare);
    });

    it('blankCStatementMacroCalls blanks indented iterator macros, keeps the block', async () => {
      const { blankCStatementMacroCalls } = await import('../src/extraction/languages/c-cpp');
      const src = [
        'static void walk(struct list *head) {',
        '\tlist_for_each_entry(pos, head, member) {',
        '\t\tuse(pos);',
        '\t}',
        '}',
        '',
      ].join('\n');
      const out = blankCStatementMacroCalls(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('list_for_each_entry');
      expect(out).toContain('use(pos);');
      // A real call statement ends with `;` — untouched.
      expect(out).toContain('use(pos);');
      const call = ['void f(void) {', '\tdo_thing(a, b);', '}', ''].join('\n');
      expect(blankCStatementMacroCalls(call)).toBe(call);
      // Column-0 `name(args) {` is an implicit-int function definition — untouched.
      const kandr = ['main(argc, argv)', '{', '\treturn 0;', '}', ''].join('\n');
      expect(blankCStatementMacroCalls(kandr)).toBe(kandr);
      // Control-flow keywords are never macros.
      const ctrl = ['void g(int x) {', '\twhile (x) {', '\t\tx--;', '\t}', '}', ''].join('\n');
      expect(blankCStatementMacroCalls(ctrl)).toBe(ctrl);
    });

    it('blankCTrailingParamAttrMacros blanks `name UNUSED` params, spares call args', async () => {
      const { blankCTrailingParamAttrMacros } = await import('../src/extraction/languages/c-cpp');
      const src = 'static int run(int argc UNUSED, const char **argv UNUSED)\n{\n\treturn 0;\n}\n';
      const out = blankCTrailingParamAttrMacros(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('UNUSED');
      expect(out).toContain('int argc ');
      // A macro CONSTANT as a call argument is preceded by `,`/`(`, never by a
      // bare identifier — untouched.
      const call = 'void f(void) {\n\tconnect(sock, DEFAULT_TIMEOUT);\n}\n';
      expect(blankCTrailingParamAttrMacros(call)).toBe(call);
    });

    it('blankCKernelAnnotations blanks sparse/section dunders, spares parameterized ones and real types', async () => {
      const { blankCKernelAnnotations } = await import('../src/extraction/languages/c-cpp');
      const src = [
        'static int __init audit_init(void) { return 0; }',
        'void copy(void __user *dst, const char *src);',
        '__bpf_kfunc void bpf_iter_destroy(struct bpf_iter_num *it);',
        '__printf(1, 2) void log_fmt(const char *fmt, ...);',
        'struct e *entry = container_of(r, struct audit_entry, rule);',
        '__u32 count = 0;',
        '',
      ].join('\n');
      const out = blankCKernelAnnotations(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('__init');
      expect(out).not.toContain('__user');
      expect(out).not.toContain('__bpf_kfunc');
      // Parameterized annotations keep their name — blanking it would strand
      // the argument list as a floating parenthesis.
      expect(out).toContain('__printf(1, 2)');
      // container_of's type-keyword argument blanks; other `struct` keywords stay.
      expect(out).toContain('container_of(r,        audit_entry, rule)');
      expect(out).toContain('struct e *entry');
      // Real dunder TYPES are not annotations.
      expect(out).toContain('__u32 count');
    });

    it('blankCParameterizedAnnotationMacros blanks name+args whole, eats a stranded field semicolon', async () => {
      const { blankCParameterizedAnnotationMacros } = await import('../src/extraction/languages/c-cpp');
      const src = [
        'struct file *f __free(fput) = NULL;',
        'static void __printf(4, 0) log_it(int a, const char *fmt, ...);',
        'struct ctx {',
        '\t__bpf_md_ptr(struct bpf_iter_meta *, meta);',
        '};',
        'int keep = __hash(key);',
        '',
      ].join('\n');
      const out = blankCParameterizedAnnotationMacros(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('__free');
      expect(out).not.toContain('__printf');
      // Mid-line match keeps its statement tail…
      expect(out).toContain('= NULL;');
      // …but a whole-line FIELD match eats the `;` too — a lone `;` field is
      // itself a parse error while an empty struct body is not.
      expect(out).not.toContain('__bpf_md_ptr');
      expect(out.split('\n')[3]?.trim()).toBe('');
      // Non-curated dunder calls are real code.
      expect(out).toContain('__hash(key)');
    });

    it('blankCTypeKeywordArgs blanks bare type-keyword call args, spares valid look-alikes', async () => {
      const { blankCTypeKeywordArgs } = await import('../src/extraction/languages/c-cpp');
      const src = [
        'void j(void *head, void *map) {',
        '\tvoid *p = kzalloc_obj(struct bpf_mount_opts);',
        '\tvoid *e = list_first_entry(head,',
        '\t\t\tstruct async_entry, domain_list);',
        '\tvoid *n = hlist_entry_safe(rcu_dereference_raw(hlist_next_rcu(head)),',
        '\t\t\tstruct bpf_dtab_netdev, index_hlist);',
        '\treturn container_of(map, struct bpf_map, inner);',
        '}',
        'DEFINE_PER_CPU(struct task_struct *, ksoftirqd);',
        '',
      ].join('\n');
      const out = blankCTypeKeywordArgs(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('struct bpf_mount_opts');
      expect(out).toContain('       bpf_mount_opts'); // keyword → spaces, ident stays
      expect(out).toContain('       async_entry, domain_list');
      expect(out).toContain('       bpf_dtab_netdev'); // nested-paren predecessor arg
      expect(out).toContain('       bpf_map, inner'); // `return` precedes real calls
      // Pointer form blanks the stars too — two plain identifier args remain.
      expect(out).toContain('       task_struct  , ksoftirqd');
      // Valid look-alikes stay byte-identical.
      for (const valid of [
        'int a = sizeof(struct point);',
        'int b = offsetof(struct point, y);',
        'int c = _Generic(x, struct foo *: 1, default: 0);',
        'int wf(struct a,\n\tstruct b);',
        'void cast(void *p) { use((struct foo *)p); }',
        'struct ops { int (*probe)(struct device *dev); };',
      ]) {
        expect(blankCTypeKeywordArgs(valid)).toBe(valid);
      }
    });

    it('blankCFileScopePrefixedDeclMacros blanks static/extern CAPS-macro lines at any scope', async () => {
      const { blankCFileScopePrefixedDeclMacros } = await import('../src/extraction/languages/c-cpp');
      const src = [
        'static DEFINE_PER_CPU(struct llist_head, rstat_backlog_list);',
        'void f(void) {',
        '\tstatic DEFINE_RATELIMIT_STATE(ratelimit, 5 * HZ, 5);',
        '}',
        'EXPORT_SYMBOL(vmalloc);',
        'static DEFINE_PER_CPU(struct cpuhp_cpu_state, cpuhp_state) = {',
        '',
      ].join('\n');
      const out = blankCFileScopePrefixedDeclMacros(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('DEFINE_PER_CPU(struct llist_head');
      expect(out).not.toContain('DEFINE_RATELIMIT_STATE'); // block scope blanks too
      // Bare CAPS lines parse natively as K&R declarations — untouched.
      expect(out).toContain('EXPORT_SYMBOL(vmalloc);');
      // Initializer forms belong to the rewrite, not the blank.
      expect(out).toContain('cpuhp_state) = {');
    });

    it('rewriteCPrefixedDeclMacroInitializers rewrites `static CAPS(type, name) = {` into the declaration', async () => {
      const { rewriteCPrefixedDeclMacroInitializers } = await import('../src/extraction/languages/c-cpp');
      const line = 'static DEFINE_PER_CPU(struct cpuhp_cpu_state, cpuhp_state) = {';
      const src = [line, '\t.fail = CPUHP_INVALID,', '};', ''].join('\n');
      const out = rewriteCPrefixedDeclMacroInitializers(src);
      expect(out.length).toBe(src.length);
      const rewritten = out.split('\n')[0] as string;
      expect(rewritten).toContain('static struct cpuhp_cpu_state');
      expect(rewritten).not.toContain('DEFINE_PER_CPU');
      // The NAME keeps its exact original column, and the tail its offsets.
      expect(rewritten.indexOf('cpuhp_state')).not.toBe(-1);
      expect(rewritten.indexOf('cpuhp_state', 30)).toBe(line.indexOf('cpuhp_state', 30));
      expect(rewritten.indexOf('= {')).toBe(line.indexOf('= {'));
      // Three-argument macros never match.
      const threeArg = 'static DEFINE_TIMER(t, fn, 0) = {\n};\n';
      expect(rewriteCPrefixedDeclMacroInitializers(threeArg)).toBe(threeArg);
    });

    it('blankCVaArgQualifiedTypeArgs blanks multi-token va_arg types, spares single tokens', async () => {
      const { blankCVaArgQualifiedTypeArgs } = await import('../src/extraction/languages/c-cpp');
      const src = 'void f(va_list ap) {\n\tconst char *s = va_arg(ap, const char *);\n\tint n = va_arg(ap, int);\n}\n';
      const out = blankCVaArgQualifiedTypeArgs(src);
      expect(out.length).toBe(src.length);
      expect(out).toContain('va_arg(ap              );');
      expect(out).toContain('va_arg(ap, int);'); // parses natively — untouched
    });

    it('blankCNamedVariadicDefineDots blanks only the dots of GNU named-variadic params', async () => {
      const { blankCNamedVariadicDefineDots } = await import('../src/extraction/languages/c-cpp');
      const named = '#define verbose(env, fmt, args...) log_write(env, fmt, ##args)\nint x;\n';
      const out = blankCNamedVariadicDefineDots(named);
      expect(out.length).toBe(named.length);
      expect(out).toContain('args   )'); // dots → spaces
      expect(out).toContain('##args'); // body untouched
      const std = '#define pr(fmt, ...) printk(fmt, __VA_ARGS__)\nint y;\n';
      expect(blankCNamedVariadicDefineDots(std)).toBe(std);
    });

    it('blankCSandwichedAnnotations and blankCAutoInference: sandwich and C23-auto guards', async () => {
      const { blankCSandwichedAnnotations, blankCAutoInference } = await import(
        '../src/extraction/languages/c-cpp'
      );
      const src = 'static notrace void tick_do(void) { }\nstatic nokprobe_inline void arm(void) { }\n';
      const out = blankCSandwichedAnnotations(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('notrace');
      expect(out).not.toContain('nokprobe_inline');
      // As a variable name (no following word) it survives.
      const varUse = 'void f(void) { int notrace = 1; use(notrace); }\n';
      expect(blankCSandwichedAnnotations(varUse)).toBe(varUse);
      const c23 = 'void q(void) { auto hb = get_hb(); }\n';
      const autoOut = blankCAutoInference(c23);
      expect(autoOut.length).toBe(c23.length);
      expect(autoOut).toContain('     hb = get_hb();');
      // The storage-class reading has a TYPE after `auto` — untouched.
      const storage = 'void s(void) { auto int x = 1; }\n';
      expect(blankCAutoInference(storage)).toBe(storage);
    });

    it('blankCStatementMacroCalls spans wrapped iterator macros, spares wrapped real calls', async () => {
      const { blankCStatementMacroCalls } = await import('../src/extraction/languages/c-cpp');
      const src = [
        'static void walk(void *head) {',
        '\thlist_for_each_entry_rcu(p, head, hlist,',
        '\t\t\t\t lockdep_is_held(&kprobe_mutex)) {',
        '\t\tuse(p);',
        '\t}',
        '}',
        '',
      ].join('\n');
      const out = blankCStatementMacroCalls(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('hlist_for_each_entry_rcu');
      expect(out).not.toContain('lockdep_is_held');
      expect(out).toContain('use(p);');
      // A wrapped REAL call ends in `;` — untouched.
      const call = 'void f(void) {\n\tdo_thing(a,\n\t\t b);\n}\n';
      expect(blankCStatementMacroCalls(call)).toBe(call);
      // A wrapped condition is keyword-led — untouched.
      const cond = 'void g(int a) {\n\tif (check(a,\n\t\t  a)) {\n\t\tuse(a);\n\t}\n}\n';
      expect(blankCStatementMacroCalls(cond)).toBe(cond);
    });

    it('restoreDirectiveLines keeps #define lines out of the blanking blast radius', async () => {
      const { extractFromSource } = await import('../src/extraction');
      // FMT_API matches the _API-suffix member blank; without the directive
      // restore the #define loses its NAME and the file gains a parse error.
      const src = [
        '#define FMT_API FMT_VISIBILITY("default")',
        'class Widget {',
        ' public:',
        '  int size() const { return 1; }',
        '};',
        '',
      ].join('\n');
      const result = extractFromSource('lib.hpp', src, 'cpp');
      expect(result.errors).toEqual([]);
      expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'Widget')).toBe(true);
      expect(result.nodes.some((n) => n.kind === 'method' && n.name === 'size')).toBe(true);
    });
  });
}
