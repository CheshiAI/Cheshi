import type { QueryBuilder } from '../db/queries';
import { parseStructFieldsRaw } from './c-fnptr-fields';
import { createFnPointerSource } from './c-fnptr-source';
import { type CfnptrFactsOut, type CfnptrFileIn, getKernel } from '../extraction/kernel/loader';
import type { Edge, Node } from '../types';
import {
  ARRAY_DISPATCH_RE,
  ARRAY_TABLE_RE,
  C_CPP_EXT,
  C_TYPE_KEYWORDS,
  DISPATCH_RE,
  FANOUT_CAP,
  FIELD_ASSIGN_RE,
  type FieldInfo,
  type FileFacts,
  FN_KINDS,
  FNPTR_TYPEDEF_RE,
  FNTYPE_TYPEDEF_STMT_RE,
  INCLUDABLE_EXT,
  INCLUDE_RE,
  INIT_RE,
  INLINE_STRUCT_RE,
  NO_INCLUDES,
  OBJ_ALIAS_RE,
  type RawFieldDecl
} from './c-fnptr-facts';
import {
  evalConditionals,
  expandMacroCalls,
  type MacroDef,
  matchBrace,
  parseDefinedNames,
  parseFunctionMacros,
  parseObjectMacros,
  resolveTypeName,
  sliceLinesPre,
  splitTopLevel,
} from './c-fnptr-preprocessor';
import type { MaybeYield } from './cooperative-yield';
import { LRUCache } from './lru-cache';
import type { ResolutionContext } from './types';


export async function cFnPointerDispatchEdges(
  _queries: QueryBuilder,
  ctx: ResolutionContext,
  onYield: MaybeYield,
  onFraction?: (fraction: number) => void
): Promise<Edge[]> {
  let scannedFiles = 0;
  const files = ctx.getAllFiles().filter((f) => C_CPP_EXT.test(f));
  if (files.length === 0) return [];

  // CODEGRAPH_SYNTH_TIMINGS sub-attribution: this pass is 86% of kernel-scale
  // synthesis (306s, §7a.2/§7a.3) — per-stage walls + read/strip accounting
  // name which stage and which cost class owns it. Post-refactor mapping:
  // A = extraction sweep, B = struct-layout linking, C = registration,
  // D = propagation, E = dispatch.
  const prof = process.env.CODEGRAPH_SYNTH_TIMINGS
    ? { A: 0, B: 0, C: 0, D: 0, E: 0, readMs: 0, readN: 0, stripMs: 0, stripN: 0, nodesMs: 0, nodesN: 0 }
    : null;

  // Within-pass progress: this is the pass that parks the "Linking dynamic
  // dispatch" bar on C-heavy repos, so it reports a real fraction of its
  // dominant work. `files` is swept once per stage loop below (extraction,
  // registration, propagation, dispatch), reported at the same per-16-files
  // cadence as the cooperative yield.
  const FILE_SWEEPS = 4;
  const tick = async (): Promise<void> => {
    if ((++scannedFiles & 15) === 0) {
      onFraction?.(scannedFiles / (files.length * FILE_SWEEPS));
      await onYield();
    }
  };

  const { raw, src, resolveInclude, intern } = createFnPointerSource(files, ctx, prof);

  // ---- Global tables the extraction sweep fills ----
  //   fn-pointer:  typedef RET (*NAME)(…)        → a field `NAME f` is a fn ptr
  //   fn-type:     typedef RET NAME(params)       → a field `NAME *f` is a fn ptr
  // The fn-type form is redis' command idiom: `typedef void redisCommandProc(client*)`
  // declared as `redisCommandProc *proc;`. Without this, `proc` reads as data.
  const fnPtrTypedefs = new Set<string>();
  const fnTypeTypedefs = new Set<string>();
  /** Struct node id → its structurally-parsed fields (classified + registered
   *  in the linking stage, in kind-scan order). */
  const rawFieldsByNode = new Map<string, RawFieldDecl[]>();
  const factsByFile = new Map<string, FileFacts>();
  /** Every inline-struct candidate tag anywhere — an over-approximation of the
   *  tags the registration stage can add to `structLayout` mid-stage, folded
   *  into the registration filter's layout check. */
  const inlineTags = new Set<string>();
  /** Object-macro names with an alias-shaped value anywhere (see OBJ_ALIAS_RE). */
  const aliasNames = new Set<string>();

  // Classify deferred fields against the (now-complete) typedef sets.
  const classifyFields = (rawFields: RawFieldDecl[]): FieldInfo[] =>
    rawFields.map((f) => ({
      name: f.name ?? '',
      index: f.index,
      isFnPtr:
        !!f.name &&
        (f.ptr || (!!f.type && (fnPtrTypedefs.has(f.type) || fnTypeTypedefs.has(f.type)))),
      type: f.type,
    }));
  const parseStructFields = (inner: string): FieldInfo[] => classifyFields(parseStructFieldsRaw(inner));

  // Exact per-file include resolution (from RAW source — string contents survive).
  const scanIncludes = (file: string): string[] => {
    const rawText = raw(file);
    if (!rawText || !rawText.includes('include')) return NO_INCLUDES;
    const out: string[] = [];
    INCLUDE_RE.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = INCLUDE_RE.exec(rawText))) {
      if (!INCLUDABLE_EXT.test(im[1]!)) continue;
      const t = resolveInclude(file, im[1]!);
      if (t) out.push(intern(t));
    }
    return out.length ? out : NO_INCLUDES;
  };
  // Indexed files answer from their facts; non-indexed includes (reached by
  // buildEnv's depth-2 recursion) fall back to a bounded lazy scan.
  const includeCache = new LRUCache<string, string[]>(1024);
  const localIncludesOf = (file: string): string[] => {
    const f = factsByFile.get(file);
    if (f) return f.includes;
    let out = includeCache.get(file);
    if (out) return out;
    out = scanIncludes(file);
    includeCache.set(file, out);
    return out;
  };

  // ---- Stage A: the extraction sweep — ONE read + strip per file ----
  //
  // Two implementations, record-identical by the differential suite:
  //   • native (task #5 step 2): the kernel's `cfnptrScanFiles` strips and
  //     scans a BATCH of files per NAPI call (codegraph-kernel/src/cfnptr.rs —
  //     hand-rolled byte machines replicating the JS regex semantics), and the
  //     TS side only reads files, ships batches, and interns the returned
  //     facts. Include-path resolution stays here (it needs the filesystem).
  //   • JS: the original sweep, kept verbatim — the fallback for platforms
  //     without a kernel binary, older binaries (feature detection), the
  //     CODEGRAPH_KERNEL=0 kill switch, and CODEGRAPH_KERNEL_CFNPTR=0 (this
  //     scanner's own switch).
  const kernel =
    process.env.CODEGRAPH_KERNEL === '0' || process.env.CODEGRAPH_KERNEL_CFNPTR === '0'
      ? null
      : getKernel();
  const nativeSweep =
    kernel && typeof kernel.cfnptrScanFiles === 'function' ? kernel.cfnptrScanFiles.bind(kernel) : null;

  const mergeNativeFacts = (file: string, out: CfnptrFactsOut): void => {
    for (const t of out.fnPtrTypedefs) fnPtrTypedefs.add(intern(t));
    for (const t of out.fnTypeTypedefs) fnTypeTypedefs.add(intern(t));
    for (const so of out.structs) {
      if (!so.parsed) continue; // body never parsed — the JS sweep records nothing either
      rawFieldsByNode.set(
        so.id,
        so.fields.map((f) => ({ name: f.name || null, index: f.index, ptr: f.ptr, type: f.type }))
      );
    }
    for (const t of out.inlineTags) inlineTags.add(intern(t));
    for (const t of out.aliasNames) aliasNames.add(intern(t));
    const includes: string[] = [];
    for (const cap of out.includes) {
      if (!INCLUDABLE_EXT.test(cap)) continue;
      const t = resolveInclude(file, cap);
      if (t) includes.push(intern(t));
    }
    if (
      out.initTokens.length || out.arrayElems.length || out.inlinePtr || out.inlineTypes.length ||
      out.dPairs.length || out.dispatchFields.length || out.arrayDispatchNames.length || includes.length
    ) {
      factsByFile.set(file, {
        initTokens: out.initTokens.length ? out.initTokens.map(intern) : null,
        arrayElems: out.arrayElems.length ? out.arrayElems.map(intern) : null,
        inlinePtr: out.inlinePtr,
        inlineTypes: out.inlineTypes.length ? out.inlineTypes.map(intern) : null,
        dPairs: out.dPairs.length ? out.dPairs.map(intern) : null,
        dispatchFields: out.dispatchFields.length ? out.dispatchFields.map(intern) : null,
        arrayDispatchNames: out.arrayDispatchNames.length ? out.arrayDispatchNames.map(intern) : null,
        includes: includes.length ? includes : NO_INCLUDES,
      });
    }
  };

  let tPass = Date.now();
  if (nativeSweep) {
    // Batch of 16 = the tick/onFraction cadence, so yielding and progress
    // reporting keep their shape while the boundary crossing amortizes.
    const BATCH = 16;
    let batch: { file: string; input: CfnptrFileIn }[] = [];
    const flush = (): void => {
      if (batch.length === 0) return;
      const outs = nativeSweep(batch.map((b) => b.input));
      for (let bi = 0; bi < batch.length; bi++) mergeNativeFacts(batch[bi]!.file, outs[bi]!);
      batch = [];
    };
    for (const file of files) {
      await tick();
      const rawText = raw(file);
      if (!rawText) continue; // unreadable or empty — the JS sweep skips these too
      const tN = prof ? Date.now() : 0;
      const fileNodes = ctx.getNodesInFile(file);
      if (prof) { prof.nodesMs += Date.now() - tN; prof.nodesN++; }
      const structs: CfnptrFileIn['structs'] = [];
      for (const st of fileNodes) {
        if (st.kind !== 'struct') continue;
        // sliceLinesPre semantics ride along: falsy startLine never parses,
        // and `endLine ?? startLine` is applied here so the kernel sees the
        // exact slice bounds the JS sweep would use.
        structs.push({ id: st.id, startLine: st.startLine ?? 0, endLine: st.endLine ?? st.startLine ?? 0 });
      }
      batch.push({ file, input: { text: rawText, structs } });
      if (batch.length >= BATCH) flush();
    }
    flush();
  }
  // JS sweep (fallback path — see the stage comment above).
  if (!nativeSweep) for (const file of files) {
    await tick();
    const s = src(file);
    if (!s) continue;

    // Typedefs (cross-file).
    if (s.includes('typedef')) {
      FNPTR_TYPEDEF_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = FNPTR_TYPEDEF_RE.exec(s))) fnPtrTypedefs.add(intern(m[1]!));
      FNTYPE_TYPEDEF_STMT_RE.lastIndex = 0;
      while ((m = FNTYPE_TYPEDEF_STMT_RE.exec(s))) {
        const guts = m[1]!;
        if (guts.includes('(*') || guts.includes('( *')) continue; // pointer form — handled above
        const fm = guts.match(/\b(\w+)\s*\(/); // last identifier before the param list
        if (fm && !C_TYPE_KEYWORDS.has(fm[1]!)) fnTypeTypedefs.add(intern(fm[1]!));
      }
    }

    // Struct-node field declarations (registered later in kind-scan order).
    const tN = prof ? Date.now() : 0;
    const fileNodes = ctx.getNodesInFile(file);
    if (prof) { prof.nodesMs += Date.now() - tN; prof.nodesN++; }
    let lines: string[] | null = null;
    for (const st of fileNodes) {
      if (st.kind !== 'struct') continue;
      lines ??= s.split('\n');
      const body = sliceLinesPre(lines, st.startLine, st.endLine);
      const open = body.indexOf('{');
      const close = open >= 0 ? matchBrace(body, open) : -1;
      if (open < 0 || close < 0) continue;
      rawFieldsByNode.set(st.id, parseStructFieldsRaw(body.slice(open + 1, close)));
    }

    // Registration filters. These are full-file, NO-SKIP scans: the original
    // registration pass jumps its scan cursor past a processed initializer
    // body, so a no-skip scan finds a SUPERSET of its matches — exactly the
    // over-approximation the filter needs.
    const initTokens = new Set<string>();
    const arrayElems = new Set<string>();
    const inlineTypes = new Set<string>();
    let inlinePtr = false;
    if (s.includes('{')) {
      INLINE_STRUCT_RE.lastIndex = 0;
      let im: RegExpExecArray | null;
      while ((im = INLINE_STRUCT_RE.exec(s))) {
        const sOpen = im.index + im[0].length - 1;
        const sClose = matchBrace(s, sOpen);
        if (sClose < 0) continue;
        // After `}`, expect `var [opt] [= {…}]` to be a table candidate.
        const vm = s.slice(sClose + 1).match(/^\s*(\w+)\s*(\[[^\x5D]*\x5D)?\s*(=\s*\{)?/);
        if (!vm || !vm[1]) continue;
        inlineTags.add(intern(im[1]!));
        for (const f of parseStructFieldsRaw(s.slice(sOpen + 1, sClose))) {
          if (!f.name) continue;
          if (f.ptr) inlinePtr = true;
          else if (f.type) inlineTypes.add(intern(f.type));
        }
      }
      if (s.includes('=')) {
        INIT_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = INIT_RE.exec(s))) initTokens.add(intern(m[1]!));
        ARRAY_TABLE_RE.lastIndex = 0;
        while ((m = ARRAY_TABLE_RE.exec(s))) arrayElems.add(intern((m[2] ? '*' : '') + m[1]!));
      }
    }

    // Alias-shaped object macros (registration filter support).
    if (s.includes('#define') || s.includes('# define')) {
      const joined = s.replace(/\\\r?\n/g, ' ');
      OBJ_ALIAS_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = OBJ_ALIAS_RE.exec(joined))) aliasNames.add(intern(m[1]!));
    }

    // Propagation + dispatch filters (full-file scans ⊇ the per-function-body
    // scans the pass bodies run — a body slice is a substring of the file).
    const dPairs = new Set<string>();
    if (s.includes('=')) {
      FIELD_ASSIGN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = FIELD_ASSIGN_RE.exec(s))) dPairs.add(intern(m[2]! + '\0' + m[4]!));
    }
    const dispatchFields = new Set<string>();
    const arrayNames = new Set<string>();
    DISPATCH_RE.lastIndex = 0;
    let dm: RegExpExecArray | null;
    while ((dm = DISPATCH_RE.exec(s))) dispatchFields.add(intern(dm[2]!));
    ARRAY_DISPATCH_RE.lastIndex = 0;
    while ((dm = ARRAY_DISPATCH_RE.exec(s))) arrayNames.add(intern(dm[1]!));

    const includes = scanIncludes(file);
    if (
      initTokens.size || arrayElems.size || inlinePtr || inlineTypes.size ||
      dPairs.size || dispatchFields.size || arrayNames.size || includes.length
    ) {
      factsByFile.set(file, {
        initTokens: initTokens.size ? [...initTokens] : null,
        arrayElems: arrayElems.size ? [...arrayElems] : null,
        inlinePtr,
        inlineTypes: inlineTypes.size ? [...inlineTypes] : null,
        dPairs: dPairs.size ? [...dPairs] : null,
        dispatchFields: dispatchFields.size ? [...dispatchFields] : null,
        arrayDispatchNames: arrayNames.size ? [...arrayNames] : null,
        includes,
      });
    }
  }
  if (prof) { prof.A = Date.now() - tPass; tPass = Date.now(); }

  // ---- Stage B: struct field layouts (linking — text-free) ----
  // structLayout: struct name → ordered fields, for structs with ≥1 fn-pointer
  //   field (drives positional registration + dispatch).
  // allStructFields: EVERY struct name → ALL its field layouts (a name can be
  //   reused across files — e.g. redis has two unrelated `client` structs), used
  //   to walk a chained receiver's field types (`c->cmd->proc`: client.cmd →
  //   redisCommand). The walk searches every same-named layout for the field.
  // fieldToStructs: fn-pointer field name → set of struct names that declare it.
  // Registration REPLAYS the struct kind-scan (rowid order, ≠ the extraction
  // sweep's path order): same-name layout precedence — `structLayout.set`
  // last-wins, `allStructFields` first-match in the chain walk — depends on it.
  const structLayout = new Map<string, FieldInfo[]>();
  const allStructFields = new Map<string, FieldInfo[][]>();
  const fieldToStructs = new Map<string, Set<string>>();

  // Register a parsed struct under `name` into the three indexes.
  const registerStructLayout = (name: string, fields: FieldInfo[]): void => {
    if (!allStructFields.has(name)) allStructFields.set(name, []);
    allStructFields.get(name)!.push(fields);
    for (const f of fields) {
      if (f.name && f.isFnPtr) {
        if (!fieldToStructs.has(f.name)) fieldToStructs.set(f.name, new Set());
        fieldToStructs.get(f.name)!.add(name);
      }
    }
    if (fields.some((f) => f.isFnPtr)) structLayout.set(name, fields);
  };

  for (const st of (ctx.iterateNodesByKind?.('struct') ?? ctx.getNodesByKind('struct'))) {
    if ((++scannedFiles & 255) === 0) await onYield();
    if (!C_CPP_EXT.test(st.filePath)) continue;
    const rawFields = rawFieldsByNode.get(st.id);
    if (!rawFields) continue; // file unreadable or body unparsable at sweep time — the old pass skipped it too
    registerStructLayout(st.name, classifyFields(rawFields));
  }
  rawFieldsByNode.clear();
  if (prof) { prof.B = Date.now() - tPass; tPass = Date.now(); }
  // NB: no early return on an empty structLayout here — an inline `struct TAG
  // { … } var[]` table whose struct never became a node (vim's `cmdname`, broken
  // up by `#ifdef`) is discovered later during the unit scan. The `reg.size === 0`
  // guard after registration still short-circuits when nothing bridges.

  const fnPtrFieldOf = (struct: string, field: string): boolean =>
    !!structLayout.get(struct)?.some((f) => f.name === field && f.isFnPtr);

  // C/C++ function + method nodes are STREAMED per stage (see D/E) —
  // the old materialized `cFns` array held every function node on the repo
  // (O(nodes) memory, part of the #1212 kernel OOM).

  // ---- function-name → node resolution (prefer a function in the same file) ----
  const resolveFn = (name: string, preferFile?: string): Node | null => {
    const cands = ctx.getNodesByName(name).filter((n) => FN_KINDS.has(n.kind));
    if (cands.length === 0) return null;
    if (cands.length === 1) return cands[0]!;
    if (preferFile) {
      const same = cands.find((n) => n.filePath === preferFile);
      if (same) return same;
    }
    return cands[0]!;
  };

  // ---- Stage C: registrations — Map<"struct.field", Set<funcNodeId>> ----
  // Ids only — retaining the full Node per registration (the old `idToNode`)
  // was write-only dead weight at O(registrations) memory.
  const reg = new Map<string, Set<string>>();
  const addReg = (struct: string, field: string, fn: Node): void => {
    const key = `${struct}.${field}`;
    if (!reg.has(key)) reg.set(key, new Set());
    reg.get(key)!.add(fn.id);
  };

  // Bare arrays-of-fn-pointers (no struct): array VARIABLE name → per-file sets
  // of registered function ids. Multi-entry because a file-scope `static` table
  // name can recur across files (SameBoy declares `static opcode_t *opcodes[256]`
  // in BOTH sm83_cpu.c and sm83_disassembler.c), so dispatch resolves same-file.
  const arrayReg = new Map<string, { file: string; ids: Set<string> }[]>();
  const addArrayReg = (name: string, file: string, fn: Node): void => {
    let entries = arrayReg.get(name);
    if (!entries) { entries = []; arrayReg.set(name, entries); }
    let e = entries.find((x) => x.file === file);
    if (!e) { e = { file, ids: new Set() }; entries.push(e); }
    e.ids.add(fn.id);
  };

  // A struct value `{ … }` (one element) — register its function entries to the
  // struct's fields, by `.field = fn` designators or by positional slot.
  const registerStructValue = (
    struct: string,
    valueBody: string,
    file: string,
    env?: Map<string, MacroDef>,
  ): void => {
    const layout = structLayout.get(struct);
    if (!layout) return;
    if (env && env.size) valueBody = expandMacroCalls(valueBody, env);
    // A macro can expand to a whole brace-wrapped element (sqlite's
    // `FUNCTION(…)` → `{nArg, …, xFunc, …}`); peel one outer layer so the
    // positional slots are visible.
    valueBody = valueBody.trim();
    if (valueBody.startsWith('{')) {
      const e = matchBrace(valueBody, 0);
      if (e > 0 && valueBody.slice(e + 1).trim() === '') valueBody = valueBody.slice(1, e);
    }
    const items = splitTopLevel(valueBody, ',');
    let pos = 0;
    for (const rawItem of items) {
      const item = rawItem.trim();
      if (!item) continue;
      const des = item.match(/^\.\s*(\w+)\s*=\s*(?:&\s*)?(\w+)\s*$/);
      if (des) {
        const field = des[1]!;
        if (fnPtrFieldOf(struct, field)) {
          const fn = resolveFn(des[2]!, file);
          if (fn) addReg(struct, field, fn);
        }
        // a designated item does not advance positional counting
        continue;
      }
      const field = layout.find((f) => f.index === pos);
      if (field?.isFnPtr) {
        const id = item.match(/^&?\s*(\w+)\s*$/);
        if (id) {
          const fn = resolveFn(id[1]!, file);
          if (fn) addReg(struct, field.name, fn);
        }
      }
      pos++;
    }
  };

  // Collect the literal function entries of an array-of-fn-pointers initializer
  // and register them under the array's variable name. Entries may be positional
  // (`fn`, `&fn`), designated by index (`[OP] = fn`), or cast-wrapped
  // (`(handler_t)fn`, as in php's Zend dtor table). Non-identifier entries
  // (`NULL`, `0`, a nested expression) are skipped — a miss, never a wrong edge.
  // No index tracking: a runtime subscript fans the dispatch out to the whole
  // set, exactly like a command table reaches every command.
  const registerArrayValue = (
    name: string,
    body: string,
    file: string,
    env?: Map<string, MacroDef>,
  ): void => {
    if (env && env.size) body = expandMacroCalls(body, env);
    for (const rawItem of splitTopLevel(body, ',')) {
      let item = rawItem.trim();
      if (!item) continue;
      const des = item.match(/^\[[^\x5D]*\x5D\s*=\s*([\s\S]*)$/); // `[IDX] = …` designator
      if (des) item = des[1]!.trim();
      item = item.replace(/^\([\w\s*]+\)\s*/, '').replace(/^&\s*/, '').trim(); // (cast) / &
      const id = item.match(/^(\w+)$/);
      if (!id) continue;
      const fn = resolveFn(id[1]!, file);
      if (fn) addArrayReg(name, file, fn);
    }
  };

  // Per-file macro + include parsing (any file, indexed or not), cached.
  // Derived per-file caches, LRU-bounded like the content caches (#1212).
  // These stay LAZY (recompute-on-miss through `src`): retaining every file's
  // parsed tables is ruled out by the kernel's 6.1M `#define`s, and the
  // registration stage below only builds an env for files that survive its
  // filter or carry local includes, so most files never need one.
  const fnMacroCache = new LRUCache<string, Map<string, MacroDef>>(256);
  const fileFnMacros = (file: string): Map<string, MacroDef> => {
    let m = fnMacroCache.get(file);
    if (!m) { m = parseFunctionMacros(src(file) ?? ''); fnMacroCache.set(file, m); }
    return m;
  };
  const objMacroCache = new LRUCache<string, Map<string, string>>(256);
  const fileObjMacros = (file: string): Map<string, string> => {
    let m = objMacroCache.get(file);
    if (!m) { m = parseObjectMacros(src(file) ?? ''); objMacroCache.set(file, m); }
    return m;
  };
  const definedCache = new LRUCache<string, Set<string>>(256);
  const fileDefinedNames = (file: string): Set<string> => {
    let d = definedCache.get(file);
    if (!d) { d = parseDefinedNames(src(file) ?? ''); definedCache.set(file, d); }
    return d;
  };

  // A file's effective macro environment = its own #defines PLUS those of the
  // headers it #includes (redis' `MAKE_CMD` sits beside the table; sqlite's
  // `FUNCTION` lives in `sqliteInt.h`, included by the file with the table).
  // First writer wins, so the file's own defs override included ones; depth-2
  // covers a macro defined in a header-of-a-header.
  const buildEnv = (
    file: string,
    depth: number,
    seen: Set<string>,
    fn: Map<string, MacroDef>,
    obj: Map<string, string>,
    def: Set<string>,
  ): void => {
    if (depth < 0 || seen.has(file)) return;
    seen.add(file);
    for (const [k, v] of fileFnMacros(file)) if (!fn.has(k)) fn.set(k, v);
    for (const [k, v] of fileObjMacros(file)) if (!obj.has(k)) obj.set(k, v);
    for (const n of fileDefinedNames(file)) def.add(n);
    for (const inc of localIncludesOf(file)) buildEnv(inc, depth - 1, seen, fn, obj, def);
  };

  // Registration units: every indexed C file, plus the local headers/tables it
  // `#include`s. A non-indexed include (redis' generated `commands.def`) is
  // always scanned; an INDEXED header is re-scanned in an includer's context
  // ONLY when that includer switches on conditional code the header guards — it
  // `#define`s a name the header itself doesn't and the header has `#if` (vim's
  // `ex_cmds.h`, whose command table is behind `#ifdef DO_DECLARE_EXCMD` set by
  // `ex_docmd.c`). The include is scanned with the includer's effective macro
  // env (its `MAKE_CMD(…)` resolves there) and its conditionals evaluated
  // against the includer's defined set. `reg` is a Set, so unioning across
  // multiple includers is safe.
  interface Unit {
    text: string;
    file: string;
    env: Map<string, MacroDef>;
    objEnv: Map<string, string>;
  }
  const indexedSet = new Set(files);
  const seenInclude = new Set<string>();

  // Global variable → struct type, for resolving a dispatch through a file-scope
  // table by subscript (`cmdnames[i].cmd_func(…)`).
  const globalVarType = new Map<string, string>();

  // Process a `{ … }` initializer body (array of elements or a single struct).
  const processInit = (
    struct: string,
    body: string,
    isArray: boolean,
    file: string,
    env: Map<string, MacroDef>,
  ): void => {
    if (isArray) {
      for (const el of splitTopLevel(body, ',')) {
        const t = el.trim();
        if (t.startsWith('{')) {
          const e = matchBrace(t, 0);
          if (e > 0) registerStructValue(struct, t.slice(1, e), file, env);
        } else if (t) {
          // an element built by a macro (`MAKE_CMD(…)`/`FUNCTION(…)`) or a bare value
          registerStructValue(struct, t, file, env);
        }
      }
    } else {
      registerStructValue(struct, body, file, env);
    }
  };

  // Process ONE unit's text and discard it. The old shape built every unit up
  // front (`const units: Unit[]`) — the full text of every C file plus its
  // expanded includes held simultaneously, gigabytes on the kernel (#1212).
  const processUnit = (unit: Unit): void => {
    const s = unit.text;
    if (!s || !s.includes('{')) return;

    INLINE_STRUCT_RE.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = INLINE_STRUCT_RE.exec(s))) {
      const tag = im[1]!;
      const sOpen = im.index + im[0].length - 1; // the struct body's `{`
      const sClose = matchBrace(s, sOpen);
      if (sClose < 0) continue;
      // After `}`, expect `var [opt] [= {…}]` to be a table; else it's a plain type.
      const after = s.slice(sClose + 1);
      const vm = after.match(/^\s*(\w+)\s*(\[[^\x5D]*\x5D)?\s*(=\s*\{)?/);
      if (!vm || !vm[1]) continue;
      const fields = parseStructFields(s.slice(sOpen + 1, sClose));
      if (!fields.some((f) => f.isFnPtr)) continue; // only tables of fn pointers matter
      if (!structLayout.has(tag)) registerStructLayout(tag, fields);
      globalVarType.set(vm[1]!, tag);
      if (vm[3]) {
        const aOpen = sClose + 1 + after.indexOf('{', vm[0].length - 1);
        const aClose = matchBrace(s, aOpen);
        if (aClose > 0) {
          processInit(tag, s.slice(aOpen + 1, aClose), !!vm[2], unit.file, unit.env);
          INLINE_STRUCT_RE.lastIndex = aClose;
        }
      }
    }

    if (!s.includes('=')) return;
    INIT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INIT_RE.exec(s))) {
      let struct = m[1]!;
      if (!structLayout.has(struct)) struct = resolveTypeName(struct, unit.objEnv);
      if (!structLayout.has(struct)) continue;
      const isArray = !!m[3];
      const open = m.index + m[0].length - 1; // points at the `{`
      const close = matchBrace(s, open);
      if (close < 0) continue;
      globalVarType.set(m[2]!, struct);
      processInit(struct, s.slice(open + 1, close), isArray, unit.file, unit.env);
      INIT_RE.lastIndex = close;
    }

    // Bare arrays-of-function-pointers (no struct, no field). Gated on the
    // element type being a function typedef — a fn-TYPE typedef needs the `*`
    // (array of pointers to it), a fn-pointer typedef does not. A data or
    // struct array's element type is never in these sets, so it never fires.
    ARRAY_TABLE_RE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = ARRAY_TABLE_RE.exec(s))) {
      const elemType = am[1]!;
      const hasStar = !!am[2];
      if (!((fnTypeTypedefs.has(elemType) && hasStar) || fnPtrTypedefs.has(elemType))) continue;
      const open = am.index + am[0].length - 1; // the `{`
      const close = matchBrace(s, open);
      if (close < 0) continue;
      registerArrayValue(am[3]!, s.slice(open + 1, close), unit.file, unit.env);
      ARRAY_TABLE_RE.lastIndex = close;
    }
  };

  // Can this file's OWN unit have any side effect? Every check mirrors a gate
  // in processUnit, over-approximated to the filter's coarser knowledge:
  //   • inline structs — the fn-ptr-field gate, with per-candidate field types
  //     unioned per file;
  //   • initializers — `structLayout.has` against the layouts' SUPERSET
  //     (kind-scan layouts ∪ every inline tag — structLayout only grows during
  //     this stage), with alias-shaped tokens surviving in place of the
  //     per-file `resolveTypeName` walk;
  //   • bare arrays — the exact typedef-set gate.
  // A filtered-out file is one where every match fails its gate before any
  // side effect, so skipping the unit cannot change the outcome.
  const typedefHit = (t: string): boolean => fnPtrTypedefs.has(t) || fnTypeTypedefs.has(t);
  const regSurvives = (f: FileFacts): boolean =>
    f.inlinePtr ||
    (f.inlineTypes?.some(typedefHit) ?? false) ||
    (f.initTokens?.some((t) => structLayout.has(t) || inlineTags.has(t) || aliasNames.has(t)) ?? false) ||
    (f.arrayElems?.some((e) =>
      e.charCodeAt(0) === 42 /* '*' */ ? typedefHit(e.slice(1)) : fnPtrTypedefs.has(e)
    ) ?? false);

  // ---- Stage C: registrations — stream each surviving file (and every file's
  // qualifying local includes) through processUnit, one at a time.
  for (const file of files) {
    await tick();
    const facts = factsByFile.get(file);
    if (!facts) continue; // no facts ⇒ nothing matched at sweep time ⇒ the old pass would no-op here
    const survives = regSurvives(facts);
    if (!survives && facts.includes.length === 0) continue;
    const env = new Map<string, MacroDef>();
    const objEnv = new Map<string, string>();
    const defined = new Set<string>();
    buildEnv(file, 2, new Set(), env, objEnv, defined);
    if (survives) {
      const s = src(file);
      if (s) processUnit({ text: s, file, env, objEnv });
    }
    for (const target of facts.includes) {
      if (seenInclude.has(`${file}>${target}`)) continue;
      const incSrc = src(target);
      if (!incSrc) continue;
      if (indexedSet.has(target)) {
        // Re-scan an indexed header only when this includer unlocks guarded code.
        const ownDef = fileDefinedNames(target);
        const adds = [...defined].some((n) => !ownDef.has(n));
        if (!adds || !/#\s*if/.test(incSrc)) continue;
      }
      seenInclude.add(`${file}>${target}`);
      // The include is pasted into the includer — evaluate its conditionals in
      // the includer's defined set (a no-op when it has none). Re-parse the
      // included file's OWN macros from that resolved text so a macro it defines
      // conditionally (vim's `EXCMD`, whose plain last-wins parse picks the enum
      // arm) overrides with the ARM THAT IS ACTUALLY ACTIVE here.
      const text = evalConditionals(incSrc, defined);
      const incEnv = new Map(env);
      for (const [k, v] of parseFunctionMacros(text)) incEnv.set(k, v);
      const incObjEnv = new Map(objEnv);
      for (const [k, v] of parseObjectMacros(text)) incObjEnv.set(k, v);
      processUnit({ text, file: target, env: incEnv, objEnv: incObjEnv });
    }
  }
  if (prof) { prof.C = Date.now() - tPass; tPass = Date.now(); }

  // ---- receiver-type resolution within a function's source ----
  // `(?:struct )?TYPE [*]recv` declared in the params or body → TYPE (if a known
  //  fn-pointer-bearing struct).
  const recvReCache = new Map<string, RegExp>();
  const recvTypeIn = (fnSrc: string, recv: string): string | null => {
    let re = recvReCache.get(recv);
    if (!re) {
      re = new RegExp(`(?:struct\\s+)?(\\w+)\\s*\\*?\\s*\\b${recv}\\b\\s*(?:[,)=;]|\\[)`, 'g');
      recvReCache.set(recv, re);
    }
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(fnSrc))) {
      if (structLayout.has(m[1]!)) return m[1]!;
    }
    return null;
  };

  // Declared type of a local/param `v` — ANY type token, not just fn-pointer
  // structs (the base of a chained receiver needn't carry a fn pointer itself).
  // Falls back to a file-scope table variable (`cmdnames` in `cmdnames[i].fn()`).
  const escapeRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const varReCache = new Map<string, RegExp>();
  const varTypeIn = (fnSrc: string, v: string): string | null => {
    let re = varReCache.get(v);
    if (!re) {
      re = new RegExp(`(?:struct\\s+)?(\\w+)\\s*\\*?\\s*\\b${escapeRe(v)}\\b\\s*(?:[,)=;]|\\[)`, 'g');
      varReCache.set(v, re);
    }
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(fnSrc))) {
      if (!C_TYPE_KEYWORDS.has(m[1]!)) return m[1]!;
    }
    return globalVarType.get(v) ?? null;
  };

  // Resolve a member-access chain (`c->cmd`, or just `p`) to a struct type,
  // walking each segment's declared field type. `c->cmd->proc` dispatch:
  // base chain `c->cmd` → client.cmd's type `redisCommand`, the proc owner.
  // Array subscripts (`cmdnames[i]`) are stripped — an index yields one element.
  const resolveChainType = (fnSrc: string, chain: string): string | null => {
    const segs = chain.replace(/\s*\[[^\x5D]*\x5D/g, '').split(/\s*(?:->|\.)\s*/).filter(Boolean);
    if (segs.length === 0) return null;
    let t = varTypeIn(fnSrc, segs[0]!);
    for (let i = 1; t && i < segs.length; i++) {
      let next: string | null = null;
      for (const fields of allStructFields.get(t) ?? []) {
        const f = fields.find((fl) => fl.name === segs[i] && fl.type);
        if (f) { next = f.type; break; }
      }
      t = next;
    }
    return t;
  };

  // ---- Stage D: field←field propagation (`a->f = b->g`) ----
  // Collected as (targetStruct.field ← sourceStruct.field) pairs, then merged to
  // a fixpoint so a hook slot inherits a registry field's handlers.
  // Filter: a file matters only if SOME collected pair has BOTH fields known as
  // fn-pointer fields — the loop body's own pre-gate. A skipped file's matches
  // would all `continue` there, so skipping is side-effect-free.
  const propagations: { to: string; from: string }[] = [];
  for (const file of files) {
    await tick();
    const facts = factsByFile.get(file);
    if (
      !facts?.dPairs?.some((p) => {
        const i = p.indexOf('\0');
        return fieldToStructs.has(p.slice(0, i)) && fieldToStructs.has(p.slice(i + 1));
      })
    ) continue;
    const s = src(file);
    if (!s || !s.includes('=')) continue;
    const tN = prof ? Date.now() : 0;
    const fnsD = ctx.getNodesInFile(file);
    if (prof) { prof.nodesMs += Date.now() - tN; prof.nodesN++; }
    const dLines = s.split('\n');
    for (const fn of fnsD) {
      if (!FN_KINDS.has(fn.kind)) continue;
      const body = sliceLinesPre(dLines, fn.startLine, fn.endLine);
      if (!body.includes('=')) continue;
      FIELD_ASSIGN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = FIELD_ASSIGN_RE.exec(body))) {
        const [, lrecv, lfield, rrecv, rfield] = m;
        // Pre-gate on field NAMES: `a->f = b->g` matches every struct-field
        // assignment in the tree (millions on the kernel), but only fields
        // that are fn-pointer fields of SOME struct can pass fnPtrFieldOf —
        // skip the two regex type resolutions for the ~99% that can't.
        if (!fieldToStructs.has(lfield!) || !fieldToStructs.has(rfield!)) continue;
        const lt = recvTypeIn(body, lrecv!);
        const rt = recvTypeIn(body, rrecv!);
        if (lt && rt && fnPtrFieldOf(lt, lfield!) && fnPtrFieldOf(rt, rfield!)) {
          propagations.push({ to: `${lt}.${lfield}`, from: `${rt}.${rfield}` });
        }
      }
    }
  }
  for (let pass = 0; pass < 3 && propagations.length; pass++) {
    let changed = false;
    for (const { to, from } of propagations) {
      const fromSet = reg.get(from);
      if (!fromSet) continue;
      if (!reg.has(to)) reg.set(to, new Set());
      const toSet = reg.get(to)!;
      for (const id of fromSet) {
        if (!toSet.has(id)) {
          toSet.add(id);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  if (prof) { prof.D = Date.now() - tPass; tPass = Date.now(); }
  if (reg.size === 0 && arrayReg.size === 0) return [];

  // ---- Stage E: dispatch sites → edges ----
  // Filter: a file matters only if some dispatch field is a known fn-pointer
  // field, or some subscripted name is a registered fn-pointer array — the loop
  // body's own first gates (`owners` / `entries`), which a skipped file's
  // matches would all fail before touching `seen`/`added`/`edges`.
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    await tick();
    const facts = factsByFile.get(file);
    if (!facts) continue;
    const eSurvives =
      (facts.dispatchFields?.some((f) => fieldToStructs.has(f)) ?? false) ||
      (arrayReg.size > 0 && (facts.arrayDispatchNames?.some((n) => arrayReg.has(n)) ?? false));
    if (!eSurvives) continue;
    const s = src(file);
    if (!s) continue;
    const tN = prof ? Date.now() : 0;
    const fnsE = ctx.getNodesInFile(file);
    if (prof) { prof.nodesMs += Date.now() - tN; prof.nodesN++; }
    const eLines = s.split('\n');
    for (const fn of fnsE) {
      if (!FN_KINDS.has(fn.kind)) continue;
      const body = sliceLinesPre(eLines, fn.startLine, fn.endLine);
      DISPATCH_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      let added = 0;
      // Incremental line counting: matches arrive in ascending index order, so
      // count newlines since the previous match instead of re-splitting the
      // whole body prefix per match (O(body) each — real time on god-files).
      let lcIdx = 0;
      let lcLine = fn.startLine;
      const lineAt = (idx: number): number => {
        for (let i = lcIdx; i < idx; i++) if (body.charCodeAt(i) === 10) lcLine++;
        lcIdx = idx;
        return lcLine;
      };
      while ((m = DISPATCH_RE.exec(body)) && added < FANOUT_CAP) {
        const baseChain = m[1]!.replace(/\s*(?:->|\.)\s*$/, '').trim(); // receiver, minus the trailing arrow
        const field = m[2]!;
        const owners = fieldToStructs.get(field);
        if (!owners || owners.size === 0) continue;
        // 1) resolve the receiver chain's struct type precisely (handles c->cmd->proc);
        // 2) else the last segment as a simple local/param of a fn-pointer-bearing struct;
        // 3) else fall back to a field name that belongs to exactly one struct.
        let struct = resolveChainType(body, baseChain);
        if (!struct || !owners.has(struct)) {
          const lastSeg = baseChain.replace(/\s*\[[^\x5D]*\x5D/g, '').split(/\s*(?:->|\.)\s*/).pop()!;
          const t = recvTypeIn(body, lastSeg);
          struct = t && owners.has(t) ? t : null;
        }
        if (!struct || !owners.has(struct)) struct = owners.size === 1 ? [...owners][0]! : null;
        if (!struct) continue;
        const targets = reg.get(`${struct}.${field}`);
        if (!targets) continue;
        const line = lineAt(m.index);
        for (const tid of targets) {
          if (tid === fn.id) continue;
          const key = `${fn.id}>${tid}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({
            source: fn.id,
            target: tid,
            kind: 'calls',
            line,
            provenance: 'heuristic',
            metadata: {
              synthesizedBy: 'fn-pointer-dispatch',
              via: `${struct}.${field}`,
              registeredAt: `${fn.filePath}:${line}`,
            },
          });
          if (++added >= FANOUT_CAP) break;
        }
      }

      // ---- bare array-of-fn-pointers dispatch (`tbl[i](…)`) ----
      if (arrayReg.size && added < FANOUT_CAP) {
        // Fresh scan from the body's start — rewind the line-count cursor too.
        lcIdx = 0;
        lcLine = fn.startLine;
        ARRAY_DISPATCH_RE.lastIndex = 0;
        while ((m = ARRAY_DISPATCH_RE.exec(body)) && added < FANOUT_CAP) {
          const entries = arrayReg.get(m[1]!);
          if (!entries) continue;
          // Same-file table wins on a name collision (two file-local `opcodes`);
          // a unique name resolves cross-file; otherwise ambiguous — bail.
          const ids = entries.length === 1
            ? entries[0]!.ids
            : (entries.find((e) => e.file === fn.filePath)?.ids ?? null);
          if (!ids) continue;
          const line = lineAt(m.index);
          for (const tid of ids) {
            if (tid === fn.id) continue;
            const key = `${fn.id}>${tid}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({
              source: fn.id,
              target: tid,
              kind: 'calls',
              line,
              provenance: 'heuristic',
              metadata: {
                synthesizedBy: 'fn-pointer-dispatch',
                via: `${m[1]}[]`,
                registeredAt: `${fn.filePath}:${line}`,
              },
            });
            if (++added >= FANOUT_CAP) break;
          }
        }
      }
    }
  }
  if (prof) {
    prof.E = Date.now() - tPass;
    console.error(
      `[synth-timing] cFnPtr sub: A=${prof.A}ms B=${prof.B}ms C=${prof.C}ms D=${prof.D}ms E=${prof.E}ms | read n=${prof.readN} ${prof.readMs}ms strip n=${prof.stripN} ${prof.stripMs}ms nodesInFile n=${prof.nodesN} ${prof.nodesMs}ms`
    );
  }
  return edges;
}
