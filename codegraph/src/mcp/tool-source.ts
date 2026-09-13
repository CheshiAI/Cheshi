import { existsSync, readFileSync } from 'fs';
import type CodeGraph from '../index';
import type { Edge, Node } from '../types';
import {
  CONFIG_LEAF_LANGUAGES,
  isConfigLeafNode,
  validatePathWithinRoot
} from '../utils';
import {
  type ToolResult
} from './tool-definitions';
import type { ToolHandlerState } from './tool-handler-state';
import {
  STALE_WHOLE_FILE_MAX_CHARS,
  STALE_WHOLE_FILE_MAX_LINES
} from './tool-handler-state-constants';
import {
  numberSourceLines
} from './tool-messages';
import {
  CONTAINER_NODE_KINDS
} from './tool-symbol-utils';

/**
   * Handle codegraph_node
   */
export async function handleNode(this: ToolHandlerState, args: Record<string, unknown>): Promise<ToolResult> {
  const cg = this.getCodeGraph(args.projectPath as string | undefined);
  // Default to false to minimize context usage
  const includeCode = args.includeCode === true;
  const fileHint = typeof args.file === 'string' && args.file.trim() ? args.file.trim() : undefined;
  const lineHint = typeof args.line === 'number' && args.line > 0 ? args.line : undefined;
  const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : undefined;
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : undefined;
  const symbolsOnly = args.symbolsOnly === true;
  const symbolRaw = typeof args.symbol === 'string' ? args.symbol.trim() : '';

  // FILE READ MODE: a `file` with no `symbol` reads that file like the Read
  // tool — its current on-disk source with line numbers, narrowable with
  // `offset`/`limit` exactly as Read does — PLUS a one-line blast-radius
  // header (which files depend on it). `symbolsOnly` returns just the
  // structural map instead. Backed by the index: same bytes Read gives you.
  if (!symbolRaw && fileHint) {
    return this.handleFileView(cg, fileHint, { offset, limit, symbolsOnly });
  }

  const symbol = this.validateString(args.symbol, 'symbol');
  if (typeof symbol !== 'string') return symbol;

  let matches = this.findSymbolMatches(cg, symbol);
  if (matches.length === 0) {
    return this.textResult(`Symbol "${symbol}" not found in the codebase`);
  }

  // Disambiguate a heavily-overloaded name to a specific definition the caller
  // pinned by file/line (the `file:line` a trail or another tool showed it) —
  // so it can fetch e.g. `Harness::poll` at harness.rs:153 out of 50+ `poll`s
  // instead of Reading. file matches by path suffix/substring; line prefers the
  // def whose body contains it, else the nearest start. Only narrows (never
  // empties — if a hint matches nothing it's ignored).
  if (matches.length > 1 && (fileHint || lineHint !== undefined)) {
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    let narrowed = matches;
    if (fileHint) {
      const fh = norm(fileHint);
      const byFile = narrowed.filter((n) => norm(n.filePath).endsWith(fh) || norm(n.filePath).includes(fh));
      if (byFile.length > 0) narrowed = byFile;
    }
    if (lineHint !== undefined && narrowed.length > 1) {
      const containing = narrowed.filter((n) => n.startLine <= lineHint && (n.endLine ?? n.startLine) >= lineHint);
      narrowed = containing.length > 0
        ? containing
        : [...narrowed].sort((a, b) => Math.abs(a.startLine - lineHint) - Math.abs(b.startLine - lineHint)).slice(0, 1);
    }
    if (narrowed.length > 0) matches = narrowed;
  }

  // Single definition — the common case.
  if (matches.length === 1) {
    return this.textResult(this.truncateOutput(await this.renderNodeSection(cg, matches[0]!, includeCode)));
  }

  // Multiple definitions share this name — overloads, or same-named methods on
  // different types (Alamofire `didCompleteTask`/`task`/`validate`, gin
  // `reset`). Returning ONE forces the agent to guess, and when it guesses
  // wrong it READS the file to find the right overload — the dominant
  // codegraph_node read cause on Swift/Go. So return them ALL: pack as many
  // FULL bodies as fit a char budget (the agent gets the one it needs in this
  // one call, no follow-up parameter to learn), and list any remainder by
  // file:line so a large overload set can't overflow the per-tool cap.
  const header = `**${matches.length} definitions named "${symbol}"**`;
  if (!includeCode) {
    const list = matches.map((n) => `- \`${n.name}\` (${n.kind}) — ${n.filePath}:${n.startLine}`);
    return this.textResult(this.truncateOutput(
      [header, '', 'Re-query with `includeCode: true` to get every body in one call — no need to pick one first.', '', ...list].join('\n'),
    ));
  }

  const BODY_BUDGET = 12000; // leaves room under MAX_OUTPUT_LENGTH for the header + list
  // The CHAR budget is the real limiter — keep the count cap high so a set of
  // SHORT overloads (Alamofire's 10 `validate` variants, each a few lines) all
  // render in full rather than relegating the one the agent wanted to a
  // bodiless list. Only a set of many LARGE bodies hits the char budget first.
  const HARD_CAP = 16;
  const rendered: string[] = [];
  const listed: Node[] = [];
  let used = 0;
  for (const n of matches) {
    if (rendered.length >= HARD_CAP) { listed.push(n); continue; }
    const section = await this.renderNodeSection(cg, n, true);
    // Always emit the first; emit the rest only while within the char budget.
    if (rendered.length === 0 || used + section.length <= BODY_BUDGET) {
      rendered.push(section);
      used += section.length;
    } else {
      listed.push(n);
    }
  }

  const out: string[] = [
    header,
    `Returning ${rendered.length} in full${listed.length ? `; ${listed.length} more listed below` : ''} — pick the one you need (no Read required).`,
    '',
    rendered.join('\n\n---\n\n'),
  ];
  if (listed.length) {
    const LIST_CAP = 20;
    const shownList = listed.slice(0, LIST_CAP);
    out.push(
      '',
      '**Other definitions**',
      ...shownList.map((n) => `- \`${n.name}\` (${n.kind}) — ${n.filePath}:${n.startLine}`),
    );
    if (listed.length > LIST_CAP) out.push(`- … +${listed.length - LIST_CAP} more`);
    out.push(
      '',
      `> Need one of these in full? Call codegraph_node again with \`file\` (e.g. \`"${listed[0]!.filePath.split('/').pop()}"\`) or \`line\` — do NOT Read it.`,
    );
  }
  return this.textResult(this.truncateOutput(out.join('\n')));
}

/**
   * FILE READ MODE: resolve `fileArg` (path or basename) to an indexed file and
   * read it like the Read tool — its current on-disk source with line numbers,
   * narrowable with `offset`/`limit` exactly as Read's are — preceded by a
   * one-line blast-radius header (which files depend on it). `symbolsOnly`
   * returns just the structural map (symbols + dependents) instead of source.
   *
   * Parity goal: the numbered source block is byte-for-byte the shape Read
   * returns (`<n>\t<line>`, no padding), so the agent treats it as a Read — only
   * faster (served from the index) and with the blast radius attached. Security:
   * yaml/properties files are summarized by key, never dumped (#383); reads go
   * through validatePathWithinRoot (#527).
   */
export async function handleFileView(this: ToolHandlerState, cg: CodeGraph, fileArg: string, opts: { offset?: number; limit?: number; symbolsOnly?: boolean } = {}): Promise<ToolResult> {
  const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^(?:\.?\/+)+/, '').replace(/\/+$/, '');
  const wantLower = normalize(fileArg).toLowerCase();
  const allFiles = cg.getFiles();
  if (allFiles.length === 0) return this.textResult('No files indexed. Run `codegraph index` first.');

  let resolved = allFiles.find((f) => f.path.toLowerCase() === wantLower);
  let candidates: typeof allFiles = [];
  if (!resolved) {
    candidates = allFiles.filter((f) => f.path.toLowerCase().endsWith('/' + wantLower));
    if (candidates.length === 1) resolved = candidates[0];
  }
  if (!resolved && candidates.length === 0) {
    candidates = allFiles.filter((f) => f.path.toLowerCase().includes(wantLower));
    if (candidates.length === 1) resolved = candidates[0];
  }
  if (!resolved && candidates.length > 1) {
    return this.textResult(
      [`"${fileArg}" matches ${candidates.length} indexed files — pass a longer path:`, '',
      ...candidates.slice(0, 25).map((f) => `- ${f.path}`)].join('\n'),
    );
  }
  if (!resolved) {
    return this.textResult(
      `No indexed file matches "${fileArg}". Codegraph indexes source files; configs/docs it doesn't parse won't appear — Read those directly.`,
    );
  }

  const filePath = resolved.path;
  const nodes = cg.getNodesInFile(filePath)
    .filter((n) => n.kind !== 'file' && n.kind !== 'import' && n.kind !== 'export')
    .sort((a, b) => a.startLine - b.startLine);
  const dependents = cg.getFileDependents(filePath);

  // Compact, one-line blast radius (codegraph's value-add over a plain Read).
  const depSummary = dependents.length
    ? `used by ${dependents.length} file${dependents.length === 1 ? '' : 's'}: ${dependents.slice(0, 8).join(', ')}${dependents.length > 8 ? `, +${dependents.length - 8} more` : ''}`
    : 'no other indexed file depends on it';

  // Symbol-map renderer — for symbolsOnly, the config fallback, and read errors.
  const symbolMap = (heading: string, limit = 200): string[] => {
    const lines: string[] = [heading];
    for (const n of nodes.slice(0, limit)) {
      const sig = n.signature ? ` ${n.signature.replace(/\s+/g, ' ').trim()}` : '';
      lines.push(`- \`${n.name}\` (${n.kind})${sig} — :${n.startLine}`);
    }
    if (nodes.length > limit) lines.push(`- … +${nodes.length - limit} more`);
    return lines;
  };

  // symbolsOnly → the cheap structural overview, no source.
  if (opts.symbolsOnly) {
    const out = [`**${filePath}** — ${nodes.length} symbol${nodes.length === 1 ? '' : 's'}, ${depSummary}`, ''];
    if (nodes.length) out.push(...symbolMap('**Symbols**'));
    else out.push('_No indexed symbols in this file._');
    out.push('', '> Drop `symbolsOnly` (or pass `offset`/`limit`) to read the source, like Read.');
    return this.textResult(this.truncateOutput(out.join('\n')));
  }

  // SECURITY (#383): never dump a raw config/data file — a yaml/properties
  // line is `key: <secret>`. Summarize by key and point to a real Read.
  if (CONFIG_LEAF_LANGUAGES.has(resolved.language)) {
    const out = [`**${filePath}** — configuration/data file, ${depSummary}`, ''];
    if (nodes.length) out.push(...symbolMap('**Keys (values withheld for safety)**'));
    out.push('', '> Values may be secrets, so codegraph indexes keys only. Read the file directly if you need a value.');
    return this.textResult(this.truncateOutput(out.join('\n')));
  }

  // Read the current bytes from disk through the security chokepoint
  // (validatePathWithinRoot: blocks `../` traversal and symlink escapes, #527).
  const abs = validatePathWithinRoot(cg.getProjectRoot(), filePath);
  let content: string | null = null;
  if (abs) {
    try { content = readFileSync(abs, 'utf-8'); } catch { content = null; }
  }
  if (content === null) {
    const out = [`**${filePath}** — could not read from disk (it may have moved since indexing). ${depSummary}`, ''];
    if (nodes.length) out.push(...symbolMap('**Symbols**'));
    out.push('', `> Read \`${filePath}\` directly for its current content.`);
    return this.textResult(this.truncateOutput(out.join('\n')));
  }

  // Split exactly as Read does — keep the trailing empty line a final newline
  // produces (Read numbers it too), so line numbers line up byte-for-byte.
  const fileLines = content.split('\n');
  const total = fileLines.length;

  // Read-parity windowing: `offset`/`limit` mean exactly what they do on Read
  // (1-based start line; max line count). Default: the whole file, capped like
  // Read at 2000 lines and bounded by a char budget that tracks explore's
  // proven-safe ~38k response ceiling. Overflow is stated explicitly (Read
  // paginates too) — never the silent 15k truncateOutput chop.
  const CHAR_BUDGET = 38000;
  const DEFAULT_LIMIT = 2000;
  const offset = Math.max(1, opts.offset ?? 1);
  if (offset > total) {
    return this.textResult(`**${filePath}** has ${total} line${total === 1 ? '' : 's'} — offset ${offset} is past the end. ${depSummary}`);
  }
  const maxLines = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const start = offset - 1; // 0-based
  const header = `**${filePath}** — ${total} lines, ${nodes.length} symbol${nodes.length === 1 ? '' : 's'} · ${depSummary}`;

  // Numbered lines, byte-for-byte Read's shape: `<n>\t<line>`, no left-pad.
  const numbered: string[] = [];
  let used = header.length + 8;
  let i = start;
  for (; i < total && numbered.length < maxLines; i++) {
    const ln = `${i + 1}\t${fileLines[i]}`;
    if (used + ln.length + 1 > CHAR_BUDGET && numbered.length > 0) break;
    numbered.push(ln);
    used += ln.length + 1;
  }
  const shownEnd = start + numbered.length;
  const complete = offset === 1 && shownEnd >= total;

  const out: string[] = [header, '', ...numbered];
  if (!complete) {
    out.push(
      '',
      `(lines ${offset}–${shownEnd} of ${total} — pass \`offset\`/\`limit\` for another range, or \`codegraph_node <symbol>\` for one symbol in full)`,
    );
  }
  // Self-bounded to CHAR_BUDGET — do NOT route through truncateOutput (15k).
  return this.textResult(out.join('\n'));
}

/** Render one symbol: details + (optional) body/outline + its caller/callee trail. */
export async function renderNodeSection(this: ToolHandlerState, cg: CodeGraph, node: Node, includeCode: boolean): Promise<string> {
  // Disk-drift gate (issue #1474): the body below is CURRENT bytes sliced at
  // INDEXED line ranges. If the file changed since its last index sync, that
  // slice can be a DIFFERENT symbol's code served under this node's name —
  // confidently wrong, with no watcher banner to catch it on a `projectPath`
  // (cross-project) target. Never emit a slice from a drifted file.
  if (this.isFileStaleOnDisk(cg, node.filePath)) {
    return this.renderStaleNodeSection(cg, node, includeCode);
  }
  let code: string | null = null;
  let outline: string | null = null;
  if (includeCode) {
    // For container symbols (class/interface/struct/…), the full body is the
    // sum of every method body — a wall of source. Return a structural outline
    // (members + signatures + line numbers) instead; leaf symbols return their
    // full body.
    if (CONTAINER_NODE_KINDS.has(node.kind)) {
      outline = this.buildContainerOutline(cg, node);
    }
    if (!outline) {
      code = await cg.getCode(node.id);
    }
  }
  return this.formatNodeDetails(node, code, outline) + this.formatTrail(cg, node);
}

/**
   * codegraph_node render for a symbol whose file changed on disk after the
   * last index sync (issue #1474). The indexed line range is no longer
   * trustworthy, so no slice is emitted: a small file gets its full CURRENT
   * source (Read-parity — sufficiency preserved, the agent still doesn't need
   * Read); a large one gets an explicit notice steering to the tool's own
   * file-read mode (or Read) — honest absence instead of confident wrongness.
   * Location/signature stay (they're the index's answer) but are flagged as
   * possibly shifted.
   */
export function renderStaleNodeSection(this: ToolHandlerState, cg: CodeGraph, node: Node, includeCode: boolean): string {
  const lines: string[] = [
    `**${node.name}** (${node.kind})`,
    '',
    `**Location:** ${node.filePath}${node.startLine ? `:${node.startLine}` : ''} — ⚠ as of the last index sync; the file has changed on disk since, so this line may be shifted`,
  ];
  if (node.signature) {
    lines.push(`**Signature:** \`${node.signature}\``);
  }
  lines.push('');
  let embedded = false;
  if (includeCode) {
    try {
      const absPath = validatePathWithinRoot(cg.getProjectRoot(), node.filePath);
      if (absPath && existsSync(absPath) && !isConfigLeafNode(node)) {
        const content = readFileSync(absPath, 'utf-8');
        const body = content.replace(/\n+$/, '');
        if (
          body.length <= STALE_WHOLE_FILE_MAX_CHARS &&
          body.split('\n').length <= STALE_WHOLE_FILE_MAX_LINES
        ) {
          lines.push(
            `> ⚠ \`${node.filePath}\` changed on disk after it was last indexed, so the indexed line range for this symbol may no longer match. Showing the file's full CURRENT source instead (Read-parity — treat it as already Read):`,
            '',
            '```' + (node.language || ''),
            numberSourceLines(body, 1),
            '```',
          );
          embedded = true;
        }
      }
    } catch {
      /* fall through to the notice */
    }
  }
  if (!embedded) {
    lines.push(
      `> ⚠ \`${node.filePath}\` changed on disk after it was last indexed — the indexed line range for this symbol no longer reliably matches, so its body is omitted rather than risk showing a different symbol's code. For current content, call codegraph_node with \`file: "${node.filePath}"\` (no symbol; \`offset\`/\`limit\` narrow it like Read), or Read the file. The change is picked up automatically on that project's next index sync.`,
    );
  }
  return lines.join('\n') + this.formatTrail(cg, node);
}

/**
   * Build the "trail" for a symbol: its direct callees (what it calls) and
   * callers (what calls it), each with file:line — so codegraph_node doubles as
   * the structural Grep→Read→expand primitive: a spot PLUS where to go next.
   * Capped to stay cheap. Walk the graph by calling codegraph_node on a trail
   * entry; no Read needed for covered hops. Empty edges on a non-leaf often mean
   * dynamic dispatch the static graph couldn't resolve — that absence is itself
   * a signal (read that one hop) rather than a dead end.
   */
export function formatTrail(this: ToolHandlerState, cg: CodeGraph, node: Node): string {
  const TRAIL_CAP = 12;
  const fmt = (e: { node: Node; edge: Edge }) => {
    const base = `${e.node.name} (${e.node.filePath}:${e.node.startLine})`;
    const synth = this.synthEdgeNote(e.edge);
    return synth ? `${base} [${synth.compact}]` : base;
  };
  const collect = (edges: Array<{ node: Node; edge: Edge }>): Array<{ node: Node; edge: Edge }> => {
    const seen = new Set<string>([node.id]);
    const out: Array<{ node: Node; edge: Edge }> = [];
    for (const e of edges) {
      if (seen.has(e.node.id)) continue;
      seen.add(e.node.id);
      out.push(e);
    }
    return out;
  };
  const callees = collect(cg.getCallees(node.id));
  const callers = collect(cg.getCallers(node.id));
  if (callees.length === 0 && callers.length === 0) return '';
  const lines: string[] = ['', '**Trail — codegraph_node any of these to follow it (no Read needed)**'];
  if (callees.length > 0) {
    lines.push(`**Calls →** ${callees.slice(0, TRAIL_CAP).map(fmt).join(', ')}${callees.length > TRAIL_CAP ? `, +${callees.length - TRAIL_CAP} more` : ''}`);
  }
  if (callers.length > 0) {
    lines.push(`**Called by ←** ${callers.slice(0, TRAIL_CAP).map(fmt).join(', ')}${callers.length > TRAIL_CAP ? `, +${callers.length - TRAIL_CAP} more` : ''}`);
  }
  return lines.join('\n');
}
