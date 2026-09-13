import { Node } from '../types';
import { createYielder } from './cooperative-yield';
import { thisMemberClassPrefix } from './this-member-scope';
import {
  sameLanguageFamily
} from './name-matcher';
import {
  SUPERTYPE_BEARING_KINDS
} from './resolver-rules';
import type { ResolverState } from './resolver-state';
import {
  ResolvedRef,
  UnresolvedRef
} from './types';


/**
   * Drop an import/name-strategy resolution that crosses a language family.
   * Two regimes (mirrors `applyLanguageGate`'s candidate filter):
   *  - `references` (type usage): STRICT — a `Type.member` static read names a
   *    same-family type, never a coincidentally same-named symbol in another
   *    language. Drops any non-same-family target.
   *  - `imports` (import binding / `#include`): both-known — a C++ `#include
   *    "X.h"` must not resolve to a same-named ObjC header on another platform
   *    (basename collision), but a singleton-family / SFC language (`vue` →
   *    `.ts`) importing across is left alone.
   * Applies to the import (strategy 2) + name-match (strategy 3) results.
   */
/**
 * Collect the `@using` namespaces in scope for a `.razor`/`.cshtml` file: its
 * own `@using` directives plus every `_Imports.razor` from the file's folder up
 * to the project root (Razor `_Imports` cascade). Cached per file.
 */
export function getRazorUsings(this: ResolverState, filePath: string): string[] {
  const cached = this.razorUsingsCache.get(filePath);
  if (cached) return cached;
  const usings = new Set<string>();
  const addFrom = (src: string | null): void => {
    if (!src) return;
    for (const m of src.matchAll(/^\s*@using\s+(?:static\s+)?([A-Za-z_][\w.]*)/gm)) usings.add(m[1]!);
  };
  addFrom(this.context.readFile(filePath));
  let dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  // Walk up to the project root, reading each level's _Imports.razor.
  for (; ;) {
    addFrom(this.context.readFile(dir ? `${dir}/_Imports.razor` : '_Imports.razor'));
    if (!dir) break;
    const slash = dir.lastIndexOf('/');
    dir = slash >= 0 ? dir.slice(0, slash) : '';
  }
  const arr = [...usings];
  this.razorUsingsCache.set(filePath, arr);
  return arr;
}

/**
   * Resolve a Razor/Blazor simple type ref through the file's `@using`
   * namespaces: `CatalogBrand` + `@using BlazorShared.Models` → the node whose
   * qualified name is `BlazorShared.Models::CatalogBrand`. Only resolves when the
   * `@using` set yields exactly ONE type (otherwise it stays ambiguous and falls
   * through to name-matching).
   */
export function resolveRazorUsing(this: ResolverState, ref: UnresolvedRef): ResolvedRef | null {
  if (ref.referenceName.includes('.') || ref.referenceName.includes('::')) return null;
  const usings = this.getRazorUsings(ref.filePath);
  if (usings.length === 0) return null;
  const found = new Map<string, Node>();
  for (const ns of usings) {
    for (const cand of this.context.getNodesByQualifiedName(`${ns}::${ref.referenceName}`)) {
      found.set(cand.id, cand);
    }
  }
  if (found.size !== 1) return null;
  const target = found.values().next().value!;
  return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'import' };
}

/**
   * Resolve a CFML inheritance reference written as a component path (#1152).
   * Two forms exist in real code:
   *
   * - Dotted: `extends="coldbox.system.web.Controller"` — dots are directory
   *   separators from the webroot or a CFML mapping. Mappings live in server
   *   config / Application.cfc, so the leading segments may not exist in the
   *   repo at all (in the coldbox repo itself the path is `system/web/
   *   Controller.cfc` — the `coldbox.` root IS the repo). Matched by final
   *   segment (the class), corroborated right-to-left against the candidate's
   *   parent directories.
   * - Relative: `extends="../base"` / `extends="./base"` (the FW/1 style) —
   *   resolved against the referencing file's own directory.
   *
   * Conservative by design: a candidate needs at least one corroborating
   * directory segment (a dotted path whose only same-named class sits in an
   * unrelated directory is almost always an out-of-repo library supertype —
   * mxunit/testbox/coldbox-as-dependency), and a corroboration tie yields no
   * edge. Directory comparison is case-insensitive (CFML path resolution is);
   * the class segment itself is matched exactly, which real code satisfies —
   * dotted paths are written to match the on-disk file name.
   */
export function resolveCfmlComponentPath(this: ResolverState, ref: UnresolvedRef): ResolvedRef | null {
  const cfmlCandidates = (name: string): Node[] =>
    this.context
      .getNodesByName(name)
      .filter(
        (n) =>
          (n.kind === 'class' || n.kind === 'interface') &&
          (n.language === 'cfml' || n.language === 'cfscript')
      );
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

  // Relative-path form: `../base`, `./base`, `sub/thing` — resolve against
  // the referencing file's directory and require an exact (case-insensitive)
  // file match.
  if (ref.referenceName.includes('/')) {
    const rel = ref.referenceName.replace(/\.cfc$/i, '');
    const fromDir = ref.filePath.replace(/\\/g, '/').split('/').slice(0, -1);
    const parts = [...fromDir];
    for (const seg of rel.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (parts.length === 0) return null; // escapes the project root
        parts.pop();
      } else {
        parts.push(seg);
      }
    }
    const wantPath = norm(parts.join('/') + '.cfc');
    const className = parts[parts.length - 1];
    if (!className) return null;
    const target = cfmlCandidates(className).find((c) => norm(c.filePath) === wantPath);
    return target
      ? { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'file-path' }
      : null;
  }

  // Dotted form.
  const segments = ref.referenceName.split('.').map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return null;
  const className = segments[segments.length - 1]!;
  const dirSegments = segments.slice(0, -1);

  let best: Node | null = null;
  let bestScore = 0;
  let tie = false;
  for (const cand of cfmlCandidates(className)) {
    const dirs = cand.filePath.replace(/\\/g, '/').split('/').slice(0, -1);
    // Count matching directory segments right-to-left: for
    // `coldbox.system.web.Controller` vs `system/web/Controller.cfc`,
    // `web` and `system` match, then the repo root ends the run → score 2.
    let score = 0;
    while (
      score < dirSegments.length &&
      score < dirs.length &&
      dirSegments[dirSegments.length - 1 - score]!.toLowerCase() ===
      dirs[dirs.length - 1 - score]!.toLowerCase()
    ) {
      score++;
    }
    if (score > bestScore) {
      best = cand;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0) {
      tie = true;
    }
  }
  if (!best || bestScore === 0 || tie) return null;
  return { original: ref, targetNodeId: best.id, confidence: 0.9, resolvedBy: 'qualified-name' };
}

/**
   * Resolve a `this.<member>` function-as-value reference (#756/#808) to the
   * ENCLOSING CLASS's own member — never a same-named symbol elsewhere. The
   * registration idiom (`btn.on('click', this.handleClick)`) names a member
   * of the class being defined, so the only valid target shares the
   * from-symbol's qualified-name scope. Function/method targets only — a
   * property (a data field, post-#808 classification) yields no edge — same
   * file required, no fallback of any kind.
   */
export function resolveThisMemberFnRef(this: ResolverState, ref: UnresolvedRef): ResolvedRef | null {
  const member = ref.referenceName.slice(ref.referenceName.indexOf('.') + 1);
  if (!member) return null;
  const fromNode = this.queries.getNodeById(ref.fromNodeId);
  if (!fromNode) return null;
  const classPrefix = thisMemberClassPrefix(fromNode, this.context);
  if (!classPrefix) return null;
  if (ref.referenceKind === 'calls' && ref.referenceName.startsWith('super.')) {
    this.deferredThisMemberRefs.push(ref);
    return null;
  }
  const candidates = this.context
    .getNodesByQualifiedName(`${classPrefix}::${member}`)
    .filter(
      (n) =>
        (n.kind === 'function' || n.kind === 'method') &&
        n.filePath === ref.filePath &&
        (ref.referenceKind === 'calls' || n.id !== ref.fromNodeId)
    );
  if (candidates.length === 0) {
    // Not on the class itself — possibly INHERITED. implements/extends
    // edges don't exist yet in this pass, so retry in the supertype pass
    // (resolveDeferredThisMemberRefs) instead of giving up.
    this.deferredThisMemberRefs.push(ref);
    return null;
  }
  const target = candidates.reduce((a, b) => (a.startLine <= b.startLine ? a : b));
  return {
    original: ref,
    targetNodeId: target.id,
    confidence: 0.95,
    resolvedBy: 'function-ref',
  };
}

/**
   * Second pass for `this.<member>` refs whose member wasn't on the enclosing
   * class itself (#808): once implements/extends edges exist, walk the
   * class's supertypes (transitively, depth-capped) and resolve the member on
   * the nearest one that declares it — `this.handleSubmit` registered in a
   * subclass resolves to `FormBase::handleSubmit`. Validated targets only
   * (function/method kind, same language family); no match → no edge.
   * Mirrors resolveChainedCallsViaConformance's lifecycle. Returns the number
   * of newly-created edges.
   */
export async function resolveDeferredThisMemberRefs(this: ResolverState): Promise<number> {
  const deferred = this.deferredThisMemberRefs;
  this.deferredThisMemberRefs = [];
  if (deferred.length === 0) return 0;

  this.owner.clearCaches();
  // Synchronous main-thread post-pass with a per-ref supertype BFS — yield
  // periodically so the #850 liveness watchdog heartbeat can fire (#1091).
  const maybeYield = createYielder();
  const resolved: ResolvedRef[] = [];
  for (const ref of deferred) {
    await maybeYield();
    const member = ref.referenceName.slice(ref.referenceName.indexOf('.') + 1);
    const fromNode = this.queries.getNodeById(ref.fromNodeId);
    if (!fromNode || !member) continue;
    const classPrefix = thisMemberClassPrefix(fromNode, this.context);
    if (!classPrefix) continue;
    const className = classPrefix.split('::').at(-1)!;

    // NODE-anchored BFS up the supertype graph: start from the class node
    // in the ref's own file (never a same-named class elsewhere — rails has
    // a dozen `Engine`s), follow implements/extends EDGES to supertype
    // NODES, and look members up through `contains` edges. No name-based
    // unions anywhere — a name-keyed getSupertypes('Engine') merged every
    // Engine's parents and produced a cross-class wrong edge on rails.
    let frontierNodes = this.context
      .getNodesByQualifiedName(classPrefix)
      .filter(
        (n) =>
          SUPERTYPE_BEARING_KINDS.has(n.kind) &&
          n.filePath === ref.filePath
      );
    if (frontierNodes.length === 0) {
      // The class itself may be declared in another file (partial/reopened
      // classes); fall back to same-family nodes of that name.
      frontierNodes = this.context
        .getNodesByName(className)
        .filter(
          (n) =>
            SUPERTYPE_BEARING_KINDS.has(n.kind) &&
            sameLanguageFamily(n.language, ref.language)
        );
    }
    const seenNodes = new Set<string>(frontierNodes.map((n) => n.id));
    let target: Node | null = null;
    for (let depth = 0; depth < 5 && frontierNodes.length > 0 && !target; depth++) {
      const next: Node[] = [];
      for (const typeNode of frontierNodes) {
        for (const edge of this.queries.getOutgoingEdges(typeNode.id, ['implements', 'extends'])) {
          const superNode = this.queries.getNodeById(edge.target);
          if (!superNode || seenNodes.has(superNode.id)) continue;
          seenNodes.add(superNode.id);
          if (!SUPERTYPE_BEARING_KINDS.has(superNode.kind)) continue;
          // Member lookup anchored on the supertype's contains edges.
          for (const c of this.queries.getOutgoingEdges(superNode.id, ['contains'])) {
            const m = this.queries.getNodeById(c.target);
            if (
              m &&
              m.name === member &&
              (m.kind === 'function' || m.kind === 'method') &&
              sameLanguageFamily(m.language, ref.language)
            ) {
              target = m;
              break;
            }
          }
          if (target) break;
          next.push(superNode);
        }
        if (target) break;
      }
      frontierNodes = next;
    }

    if (target) {
      resolved.push({
        original: ref,
        targetNodeId: target.id,
        confidence: 0.85,
        resolvedBy: 'function-ref',
      });
    }
  }
  if (resolved.length === 0) return 0;

  const edges = this.owner.createEdges(resolved);
  if (edges.length > 0) {
    this.queries.insertEdges(edges);
    this.owner.clearCaches();
  }
  return edges.length;
}
