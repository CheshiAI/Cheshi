export const C_CPP_EXT = /\.(c|h|cc|cpp|cxx|hpp|hh|hxx|cppm|ipp|inl|tcc)$/i;

export const FN_KINDS = new Set(['function', 'method']);

export const FANOUT_CAP = 300;

// a real command table (git ~150) is legitimate fan-out; this only stops pathological cases.

/** A struct field, in declaration order, flagged when it is a function pointer. */
export interface FieldInfo {
  name: string;
  index: number;
  isFnPtr: boolean;
  /** The field's declared type token (e.g. `redisCommand` for `struct redisCommand *cmd`),
   *  used to walk a chained receiver `c->cmd->proc`. Empty for fn-pointer fields. */
  type: string;
}

/** A struct field as parsed during the extraction sweep: structure only. The
 *  `(*name)(…)` pointer syntax is a local fact (`ptr`), but a typedef-typed
 *  field's fn-pointer-ness depends on the GLOBAL typedef sets, which aren't
 *  complete until the sweep ends — so classification into `FieldInfo.isFnPtr`
 *  is deferred to the linking stage. */
export interface RawFieldDecl {
  name: string | null;
  index: number;
  ptr: boolean;
  type: string;
}

/** A fn-pointer field looks like `… (*name)(…)` — capture `name`. A
 *  calling-convention / attribute macro may precede the `*`
 *  (`(ZEND_FASTCALL *name)`), so allow leading word tokens. */
export const FNPTR_DECL_RE = /\(\s*(?:\w+\s+)*\*\s*(\w+)\s*\)\s*\(/;

/** `typedef RET (*NAME)(…)` — a function-pointer typedef (CC/attr macro before
 *  the `*` allowed, as in php's `typedef void (ZEND_FASTCALL *fn_t)(…)`). */
export const FNPTR_TYPEDEF_RE = /\btypedef\b[^;{}]*?\(\s*(?:\w+\s+)*\*\s*(\w+)\s*\)\s*\(/g;

/** A whole brace-free `typedef … ;` statement — capture the guts to spot the
 *  function-TYPE form `typedef RET NAME(params)` (no `(*name)` pointer form). */
export const FNTYPE_TYPEDEF_STMT_RE = /\btypedef\b([^;{}]*);/g;

/** Return-type keywords that must never be mistaken for the typedef's name. */
export const C_TYPE_KEYWORDS = new Set([
  'void', 'int', 'char', 'short', 'long', 'unsigned', 'signed', 'float', 'double',
  'const', 'struct', 'union', 'enum', 'static', 'volatile', 'register', 'inline',
]);

/** `#include "local/header"` — captured from RAW source (string contents survive). */
export const INCLUDE_RE = /#[ \t]*include[ \t]+"([^"\n]+)"/g;

/** Included files worth scanning for registration tables (e.g. a generated `.def`). */
export const INCLUDABLE_EXT = /\.(def|inc|h|hh|hpp|hxx|c|cc|cpp|cxx|ipp|tcc|tbl)$/i;

/** `#define NAME single_identifier` (possibly `struct`-prefixed) — an
 *  object-macro that COULD alias a struct type name (`resolveTypeName`'s exact
 *  value shape). The extraction sweep collects every such NAME into a global
 *  set: an initializer type token that direct-misses the struct layouts still
 *  survives the registration filter when it is alias-SHAPED anywhere, so the
 *  per-file macro-env alias resolution (redis' `COMMAND_STRUCT`) keeps working
 *  without retaining per-file object-macro tables (6.1M `#define`s on the
 *  Linux tree — the amdgpu register headers — rule that out). Numeric values
 *  are excluded: `resolveTypeName` would rewrite to a dead-end token that can
 *  never name a struct, so skipping them is exact, and it drops the register
 *  flood. */
export const OBJ_ALIAS_RE = /^[ \t]*#[ \t]*define[ \t]+(\w+)[ \t]+(?:struct[ \t]+)*[A-Za-z_]\w*[ \t\r]*$/gm;

/** `(?:struct )?TYPE name[opt] = {` initializers, where TYPE is a struct that
 *  has ≥1 fn-pointer field. Handles both single (`= {…}`) and array
 *  (`[] = { {…}, {…} }`) forms. Macro calls inside an element are expanded first. */
export const INIT_RE =
  /(?:^|[;{}])\s*(?:(?:static|const|extern|register|volatile)\s+)*(?:struct\s+)?(\w+)\s+(\w+)\s*(\[[^\x5D]*\x5D)?\s*=\s*\{/g;

/** `struct TAG { … } var[opt] [= {…}]` — the struct is defined INLINE with the
 *  table (vim's `cmdname`/`nv_cmd`); its layout never became a node, so parse it
 *  here and register it before reading the entries. No leading anchor: a
 *  `struct TAG {` with a brace body is always a definition (it may be preceded
 *  by a `#define …` line ending in a digit, as in vim), and the trailing
 *  `var … = {` check below is what distinguishes a TABLE from a plain type. */
export const INLINE_STRUCT_RE = /\bstruct\s+(\w+)\s*\{/g;

/** `(?:static …)* ELEMTYPE [*] name[…] = { … }` — a bare array of function
 *  pointers (no struct wrapper). The optional `*` covers a function-TYPE
 *  typedef element (`opcode_t *opcodes[]`); a function-pointer typedef element
 *  (`zend_rc_dtor_func_t t[]`) needs none. The typedef-set membership gate
 *  is what separates this from a plain data/struct array. */
export const ARRAY_TABLE_RE =
  /(?:^|[;{}])\s*(?:(?:static|const|extern|register|volatile)\s+)*(\w+)\s+(\*\s*)?(\w+)\s*\[[^\x5D]*\x5D\s*=\s*\{/g;

/** Dispatch sites: `base->…->field(` or `base.…field(` where `field` is a known
 *  fn-pointer field. The base may be a chain (`c->cmd->proc`) or carry array
 *  subscripts (`cmdnames[i].cmd_func`). An optional `)` before the call covers
 *  the parenthesized form `(cmdnames[i].cmd_func)(&ea)` vim uses. */
export const DISPATCH_RE = /((?:\w+(?:\s*\[[^\x5B\x5D]*\x5D)?\s*(?:->|\.)\s*)+)(\w+)\s*\)?\s*\(/g;

/** Bare-array dispatch: `tbl[i](…)` or the explicit-deref `(*tbl[i])(…)`. The
 *  subscript may itself contain a call (`tbl[GC_TYPE(p)](…)`), so the index
 *  class excludes only brackets. Precision comes from the `arrayReg` gate —
 *  this fires only when `tbl` is a known fn-pointer array. */
export const ARRAY_DISPATCH_RE = /(?:\(\s*\*\s*)?\b(\w+)\s*\[[^\x5B\x5D]*\x5D\s*\)?\s*\(/g;

/** Field←field propagation sites: `a->f = b->g`. */
export const FIELD_ASSIGN_RE = /(\w+)\s*(?:->|\.)\s*(\w+)\s*=\s*(\w+)\s*(?:->|\.)\s*(\w+)/g;

/** Per-file facts the extraction sweep leaves behind for the linking stages.
 *  Everything here is a SURVIVAL FILTER (over-approximate by construction —
 *  collected with full-file, no-skip scans that match a superset of what the
 *  original pass bodies can act on) except `includes`, which is exact. */
export interface FileFacts {
  /** Distinct `INIT_RE` type tokens (registration filter). */
  initTokens: string[] | null;
  /** Distinct `ARRAY_TABLE_RE` element types, `*`-prefixed when the decl has
   *  the pointer star (registration filter). */
  arrayElems: string[] | null;
  /** Any inline-struct candidate with a `(*name)(…)` field (registration filter). */
  inlinePtr: boolean;
  /** Field type tokens across inline-struct candidates (registration filter —
   *  fn-pointer-ness via typedef is only decidable once the sweep completes). */
  inlineTypes: string[] | null;
  /** Distinct `FIELD_ASSIGN_RE` `lfield\0rfield` pairs (propagation filter). */
  dPairs: string[] | null;
  /** Distinct `DISPATCH_RE` field names (dispatch filter). */
  dispatchFields: string[] | null;
  /** Distinct `ARRAY_DISPATCH_RE` array names (dispatch filter). */
  arrayDispatchNames: string[] | null;
  /** Resolved local `#include` targets, in source order (exact, from raw text). */
  includes: string[];
}

export const NO_INCLUDES: string[] = [];
