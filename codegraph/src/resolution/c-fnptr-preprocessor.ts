/** Slice a node's body from a pre-split line array — the per-file sweeps
 *  call this once per NODE, and splitting the whole file per node was an
 *  O(nodes × file-size) term (~1.6M full-file splits on the Linux tree,
 *  §7a.3 cFnPtr round). Split once per file, slice many times. */
export function sliceLinesPre(lines: string[], startLine?: number, endLine?: number): string {
  if (!startLine) return '';
  return lines.slice(startLine - 1, endLine ?? startLine).join('\n');
}

/** Index of the `}` matching the `{` at `open` (which must point at a `{`). -1 if unbalanced. */
export function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split `body` on `sep` at brace/paren/bracket depth 0 (commas inside `{…}` / `(…)` stay together). */
export function splitTopLevel(body: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out;
}

/** Index of the `)` matching the `(` at `open` (which must point at a `(`). -1 if unbalanced. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** A function-like macro: `#define NAME(p0,p1,…) expansion`. */
export interface MacroDef {
  params: string[];
  expansion: string;
}

/**
 * Collect function-like macros from (comment-stripped) source, joining
 * `\`-continuations first. Only object/positional table macros matter here, so
 * variadic macros are skipped. Used to expand registration tables built through
 * a macro (redis' `MAKE_CMD(…)`) before reading the struct-field bindings.
 */
export function parseFunctionMacros(stripped: string): Map<string, MacroDef> {
  const out = new Map<string, MacroDef>();
  if (!stripped.includes('#define') && !stripped.includes('# define')) return out;
  const joined = stripped.replace(/\\\r?\n/g, ' ');
  const RE = /^[ \t]*#[ \t]*define[ \t]+(\w+)\(([^)]*)\)\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(joined))) {
    const params = m[2]!.split(',').map((p) => p.trim()).filter(Boolean);
    if (params.some((p) => p === '...' || p.endsWith('...'))) continue; // variadic — skip
    out.set(m[1]!, { params, expansion: m[3]!.trim() });
  }
  return out;
}

/**
 * Collect object-like macros `#define NAME value` (NAME not immediately followed
 * by `(`). redis aliases the table's struct type this way:
 * `#define COMMAND_STRUCT redisCommand`, used as `struct COMMAND_STRUCT table[]`.
 */
export function parseObjectMacros(stripped: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!stripped.includes('#define') && !stripped.includes('# define')) return out;
  const joined = stripped.replace(/\\\r?\n/g, ' ');
  const RE = /^[ \t]*#[ \t]*define[ \t]+(\w+)[ \t]+(\S[^\n]*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(joined))) out.set(m[1]!, m[2]!.trim());
  return out;
}

/** All macro names a file `#define`s (value-ful or not) — the "defined" set for #ifdef. */
export function parseDefinedNames(stripped: string): Set<string> {
  const out = new Set<string>();
  if (!stripped.includes('#define') && !stripped.includes('# define')) return out;
  const RE = /^[ \t]*#[ \t]*define[ \t]+(\w+)/gm;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(stripped))) out.add(m[1]!);
  return out;
}

/**
 * Drop the inactive arms of `#ifdef`/`#ifndef`/`#if defined(X)`/`#else`/`#elif`/
 * `#endif` given a set of defined macro names, keeping line offsets (inactive
 * lines are blanked, not removed). A conditional whose expression we can't
 * evaluate (`#if SOME_EXPR`) keeps its body — better to over-keep than to drop
 * live code. This is what makes a header included with a switch macro defined
 * (vim's `ex_cmds.h` under `DO_DECLARE_EXCMD`) expose only its active table.
 */
export function evalConditionals(text: string, defined: Set<string>): string {
  if (!/#\s*if/.test(text)) return text;
  const lines = text.split('\n');
  // stack frame: parentActive = enclosing kept?; active = this arm kept?; taken = any arm taken yet
  const stack: { parentActive: boolean; active: boolean; taken: boolean }[] = [];
  const activeNow = (): boolean => (stack.length === 0 ? true : stack[stack.length - 1]!.active);
  const condDefined = (expr: string): boolean | null => {
    let mm = expr.match(/^defined\s*\(?\s*(\w+)\s*\)?$/);
    if (mm) return defined.has(mm[1]!);
    mm = expr.match(/^!\s*defined\s*\(?\s*(\w+)\s*\)?$/);
    if (mm) return !defined.has(mm[1]!);
    return null; // unevaluable
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    let mm: RegExpMatchArray | null;
    if ((mm = t.match(/^#\s*ifdef\s+(\w+)/))) {
      const pa = activeNow();
      const cond = defined.has(mm[1]!);
      stack.push({ parentActive: pa, active: pa && cond, taken: cond });
      lines[i] = '';
      continue;
    }
    if ((mm = t.match(/^#\s*ifndef\s+(\w+)/))) {
      const pa = activeNow();
      const cond = !defined.has(mm[1]!);
      stack.push({ parentActive: pa, active: pa && cond, taken: cond });
      lines[i] = '';
      continue;
    }
    if ((mm = t.match(/^#\s*if\s+(.+)$/))) {
      const pa = activeNow();
      const c = condDefined(mm[1]!.trim());
      const cond = c === null ? true : c; // unevaluable → keep
      stack.push({ parentActive: pa, active: pa && cond, taken: cond });
      lines[i] = '';
      continue;
    }
    if (/^#\s*elif\b/.test(t)) {
      const top = stack[stack.length - 1];
      if (top) { top.active = top.parentActive && !top.taken; top.taken = true; }
      lines[i] = '';
      continue;
    }
    if (/^#\s*else\b/.test(t)) {
      const top = stack[stack.length - 1];
      if (top) { top.active = top.parentActive && !top.taken; top.taken = true; }
      lines[i] = '';
      continue;
    }
    if (/^#\s*endif\b/.test(t)) {
      stack.pop();
      lines[i] = '';
      continue;
    }
    if (!activeNow()) lines[i] = ''; // blank an inactive line (keep the newline)
  }
  return lines.join('\n');
}

/** Resolve a type token through object-like macro aliases (transitive, capped). */
export function resolveTypeName(name: string, objEnv: Map<string, string> | undefined): string {
  let n = name;
  for (let i = 0; objEnv && i < 5; i++) {
    const v = objEnv.get(n);
    const t = v?.trim().match(/^(?:struct\s+)?(\w+)$/);
    if (!t) break;
    n = t[1]!;
  }
  return n;
}

/** Substitute call args for the macro's params (whole-token) in its expansion. */
function substituteMacro(def: MacroDef, args: string[]): string {
  const map = new Map<string, string>();
  def.params.forEach((p, i) => map.set(p, args[i] ?? ''));
  return def.expansion.replace(/\b\w+\b/g, (tok) => (map.has(tok) ? map.get(tok)! : tok));
}

/**
 * Expand known function-like macro calls in `text` to a fixpoint (depth-capped).
 * `MAKE_CMD("get",…,getCommand,…)` → the positional value list whose slots line
 * up with the struct's fields, so the existing positional registration can read
 * `getCommand` straight out of the `proc` slot.
 */
export function expandMacroCalls(text: string, env: Map<string, MacroDef>): string {
  if (env.size === 0) return text;
  let out = text;
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    const RE = /\b(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = RE.exec(out))) {
      const def = env.get(m[1]!);
      if (!def) continue;
      const open = m.index + m[0].length - 1; // index of the `(`
      const close = matchParen(out, open);
      if (close < 0) continue;
      const args = splitTopLevel(out.slice(open + 1, close), ',').map((a) => a.trim());
      out = out.slice(0, m.index) + substituteMacro(def, args) + out.slice(close + 1);
      changed = true;
      break; // restart scan — offsets shifted
    }
    if (!changed) break;
  }
  return out;
}
