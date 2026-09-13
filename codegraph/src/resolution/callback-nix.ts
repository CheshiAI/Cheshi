import type { QueryBuilder } from '../db/queries';
import type { Edge, NodeKind } from '../types';
import type { MaybeYield } from './cooperative-yield';

/**
 * Nix module-system option wiring. A NixOS/home-manager/nix-darwin option is
 * DECLARED in one module (`options.launchd.user.agents = mkOption { ... }`)
 * and SET in others (`launchd.user.agents.yabai = { ... }` inside a module's
 * config) — the connection happens by option-path unification inside the
 * module-system evaluator, so there is no static call/import edge to follow
 * and flow questions ("how does services.yabai.enable become a launchd
 * service?") go dark at the module boundary.
 *
 * This pass links each config-write binding to the option declaration whose
 * path is the longest static-segment prefix of the write path. Precision gates:
 *  - only STATIC segments participate: plain identifiers, plus quoted segments
 *    (`"git/config"`, `"com.apple.dock"`) as opaque verbatim tokens that match
 *    only quote-exactly; an interpolated (`${name}`) segment ends the prefix,
 *    so dynamic paths never match beyond their static head;
 *  - matched prefixes must be ≥2 segments: 1-segment paths would wrongly link
 *    every package's `meta = { ... }` attrset to nixos's `options.meta`;
 *  - a prefix declared in more than one file is ambiguous → no edge (a wrong
 *    edge is worse than none);
 *  - writes physically inside an options block are declaration internals
 *    (types, defaults, examples), never config writes → excluded.
 * Both declaration spellings register: flat (`options.a.b = ...`) by name, and
 * nested (`options = { a.b = ...; }`) by line-span containment.
 */
function nixLeadingPlainSegments(name: string): string[] {
  const segs: string[] = [];
  let i = 0;
  const n = name.length;
  while (i < n) {
    if (name[i] === '"') {
      // Quoted segment — an opaque verbatim token (quotes kept, so it can
      // never collide with a plain identifier). `NSGlobalDomain."com.apple.
      // mouse.tapBehavior"` must match ITS OWN quoted declaration, not
      // whichever sibling registered the shared plain prefix first.
      let j = i + 1;
      while (j < n && name[j] !== '"') {
        if (name[j] === '\\') j++;
        j++;
      }
      if (j >= n) return segs; // unterminated — stop at the static head
      const tok = name.slice(i, j + 1);
      if (tok.includes('${')) return segs; // interpolated → dynamic → stop
      segs.push(tok);
      i = j + 1;
      if (i >= n) break;
      if (name[i] !== '.') return segs;
      i++;
      continue;
    }
    let j = i;
    while (j < n && name[j] !== '.') {
      if (name[j] === '"' || (name[j] === '$' && name[j + 1] === '{')) return segs;
      j++;
    }
    const seg = name.slice(i, j);
    if (!/^[A-Za-z_][A-Za-z0-9_'-]*$/.test(seg)) return segs;
    segs.push(seg);
    i = j + 1;
  }
  return segs;
}

export async function nixOptionPathEdges(queries: QueryBuilder, onYield: MaybeYield): Promise<Edge[]> {
  let scanned255 = 0;
  type Rec = { id: string; filePath: string; startLine: number; endLine: number; segs: string[] };

  // One streaming pass over nix bindings (variables + the odd function-valued
  // option); memory stays O(bindings-kept), not O(all nodes) (#610).
  const byFile = new Map<string, Rec[]>();
  let scanned = 0;
  for (const kind of ['variable', 'function'] as NodeKind[]) {
    for (const node of queries.iterateNodesByKind(kind)) {
      if ((++scanned255 & 63) === 0) await onYield();
      if ((++scanned & 0x3fff) === 0 && onYield) await onYield();
      if (node.language !== 'nix') continue;
      const segs = nixLeadingPlainSegments(node.name);
      if (segs.length === 0) continue;
      const rec: Rec = {
        id: node.id,
        filePath: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
        segs,
      };
      const arr = byFile.get(node.filePath);
      if (arr) arr.push(rec);
      else byFile.set(node.filePath, [rec]);
    }
  }

  // Per file: walk bindings outermost-first with a stack of active option
  // spans, composing nested declaration paths (`options = { services.foo = {
  // enable = mkOption ...; }; }` registers services.foo AND services.foo.enable).
  // An `options` binding nested inside another option span is a SUBMODULE's
  // own namespace (`attrsOf (submodule { options = ...; })`) — its internals
  // are not globally addressable, so the sentinel blocks registration below it
  // while still excluding the region from write candidates.
  const SUBMODULE = '\0submodule';
  const decls = new Map<string, Rec[]>();
  const writes: Rec[] = [];
  const register = (path: string[], rec: Rec) => {
    if (path.length < 2 || path.includes(SUBMODULE)) return;
    const key = path.join('.');
    const arr = decls.get(key);
    if (arr) arr.push(rec);
    else decls.set(key, [rec]);
  };
  for (const recs of byFile.values()) {
    recs.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
    const stack: Array<{ start: number; end: number; prefix: string[] }> = [];
    for (const rec of recs) {
      while (stack.length > 0 && stack[stack.length - 1]!.end < rec.startLine) stack.pop();
      // Strict containment at line granularity: a one-line nested binding is
      // indistinguishable from its container, so it stays unclassified (rare
      // in module code, where option blocks are multi-line).
      const enclosing =
        stack.length > 0 &&
          rec.startLine >= stack[stack.length - 1]!.start &&
          rec.endLine <= stack[stack.length - 1]!.end &&
          !(rec.startLine === stack[stack.length - 1]!.start && rec.endLine === stack[stack.length - 1]!.end)
          ? stack[stack.length - 1]!
          : null;

      if (rec.segs[0] === 'options') {
        const ownPath = rec.segs.slice(1); // [] for the bare `options = { ... }` spelling
        const prefix = enclosing ? [SUBMODULE] : ownPath;
        register(prefix, rec);
        stack.push({ start: rec.startLine, end: rec.endLine, prefix });
        continue;
      }
      if (enclosing) {
        const composed = [...enclosing.prefix, ...rec.segs];
        register(composed, rec);
        stack.push({ start: rec.startLine, end: rec.endLine, prefix: composed });
        continue;
      }
      if (rec.segs.length >= 2) {
        writes.push(rec);
      }
    }
  }
  if (decls.size === 0 || writes.length === 0) return [];

  const edges: Edge[] = [];
  for (const w of writes) {
    // `config.services.x = ...` spells the same write with an explicit prefix.
    const segs = w.segs[0] === 'config' ? w.segs.slice(1) : w.segs;
    if (segs.length < 2) continue;
    // Longest prefix wins; an ambiguous longest match does NOT fall back to a
    // shorter one (that would link `services.nginx.virtualHosts.x` to
    // `options.services.nginx` when virtualHosts is the contested path).
    for (let len = Math.min(segs.length, 6); len >= 2; len--) {
      const candidates = decls.get(segs.slice(0, len).join('.'));
      if (!candidates || candidates.length === 0) continue;
      const files = new Set(candidates.map((c) => c.filePath));
      if (files.size === 1) {
        const target = candidates[0]!;
        if (target.id !== w.id) {
          edges.push({
            source: w.id,
            target: target.id,
            kind: 'references',
            line: w.startLine,
            provenance: 'heuristic',
            metadata: {
              synthesizedBy: 'nix-option-path',
              optionPath: segs.slice(0, len).join('.'),
              registeredAt: `${target.filePath}:${target.startLine}`,
            },
          });
        }
      }
      break; // longest hit decides, matched or ambiguous
    }
  }
  return edges;
}
