import type { Edge, Node } from '../types';
import { enclosingFn } from './callback-source';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import type { ResolutionContext } from './types';

// ── Spring application events (Java) ──────────────────────────────────────────
// Spring decouples an event PUBLISHER from its LISTENER(s) through the application
// event bus, linked by the EVENT TYPE (not a name):
//   // SomeService.java
//   eventPublisher.publishEvent(new PasswordChangedEvent(this, username));   // publish
//   // RememberMeTokenRevoker.java — a DIFFERENT file
//   @EventListener(PasswordChangedEvent.class)                              // listen
//   public void onPasswordChanged(PasswordChangedEvent event) { ... }
// Bridge it: link the enclosing method at each `publishEvent(new XEvent(...))` site →
// every listener method of XEvent. Listeners are `@EventListener` / `@TransactionalEventListener`
// methods (event type = the first param type, or the `@EventListener(X.class)` value form) and
// the older `class … implements ApplicationListener<X> { void onApplicationEvent(X e) }`. Keyed
// by exact type name, usually cross-file. A repo with no `@EventListener`/`publishEvent` yields 0.
// (Java method nodes INCLUDE their leading annotations in the range — startLine is the first
// `@…` line — so the annotation block is scanned DOWNWARD from startLine, bounded to consecutive
// `@`-lines so it can't bleed into an adjacent method.)
const SPRING_PUBLISH_RE = /\.publishEvent\s*\(\s*new\s+([A-Z][A-Za-z0-9_]*)/g;

const SPRING_LISTENER_ANNO_RE = /@(?:EventListener|TransactionalEventListener)\b/;

const SPRING_ANNO_TYPE_RE = /@(?:EventListener|TransactionalEventListener)\s*\(\s*([A-Z][A-Za-z0-9_]*)\.class/;

const SPRING_APP_LISTENER_RE = /\bApplicationListener\s*</;

const SPRING_JAVA_EXT = /\.java$/;

const SPRING_FANOUT_CAP = 80;

/** The first parameter's type from a Java method `signature` (`"void (XEvent e)"` → `XEvent`).
 *  Skips a leading `final`/`@Anno`, strips generics, and requires a PascalCase class name (event
 *  types are classes) — so a no-arg or primitive-param method yields null. */
function springFirstParamType(sig: string | undefined): string | null {
  if (!sig) return null;
  const open = sig.indexOf('(');
  if (open < 0) return null;
  const close = sig.indexOf(')', open);
  const inner = sig.slice(open + 1, close < 0 ? sig.length : close).trim();
  if (!inner) return null;
  const first = inner.split(',')[0]!.trim();
  const toks = first.split(/\s+/).filter((t) => t && t !== 'final' && !t.startsWith('@'));
  if (toks.length < 2) return null; // need `Type name`
  const type = toks[toks.length - 2]!.replace(/<.*$/, ''); // drop generic args
  return /^[A-Z][A-Za-z0-9_]*$/.test(type) ? type : null;
}

export async function springEventEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scannedFiles = 0;
  // Pass 1 — event-type → listener methods, scanning only event-relevant files.
  // This is the ONLY full read sweep: publisher files are recorded here so
  // pass 2 re-reads just those instead of every .java file again (#1212 —
  // the double full-repo read was one of the tail's longest unyielded spans).
  const listeners = new Map<string, Node[]>();
  const publisherFiles: string[] = [];
  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if (!SPRING_JAVA_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content) continue;
    if (content.includes('.publishEvent(')) publisherFiles.push(file);
    const hasAnno = content.includes('@EventListener') || content.includes('@TransactionalEventListener');
    const hasAppListener = SPRING_APP_LISTENER_RE.test(content);
    if (!hasAnno && !hasAppListener) continue;
    const lines = content.split('\n');
    for (const node of ctx.getNodesInFile(file)) {
      if (node.kind !== 'method') continue;
      // Collect this method's own leading annotation block (consecutive `@`-lines from startLine).
      const annoLines: string[] = [];
      for (let i = node.startLine - 1; i < lines.length && i < node.startLine + 7; i++) {
        const t = (lines[i] ?? '').trim();
        if (!t.startsWith('@')) break; // reached the declaration → stop (no bleed into next method)
        annoLines.push(t);
      }
      const head = annoLines.join('\n');
      const annotated = hasAnno && SPRING_LISTENER_ANNO_RE.test(head);
      const isAppListener = hasAppListener && node.name === 'onApplicationEvent';
      if (!annotated && !isAppListener) continue;
      let type = springFirstParamType(node.signature);
      if (!type && annotated) {
        const m = SPRING_ANNO_TYPE_RE.exec(head);
        if (m) type = m[1]!;
      }
      if (!type) continue;
      let arr = listeners.get(type);
      if (!arr) { arr = []; listeners.set(type, arr); }
      arr.push(node);
    }
  }
  if (!listeners.size) return [];

  // Pass 2 — link each publishEvent(new XEvent(...)) site → every listener of
  // XEvent. Only the publisher files recorded in pass 1 are (re-)read.
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of publisherFiles) {
    if ((++scannedFiles & 15) === 0) await onYield();
    const content = ctx.readFile(file);
    if (!content || !content.includes('.publishEvent(')) continue;
    const safe = stripCommentsForRegex(content, 'java');
    const nodesInFile = ctx.getNodesInFile(file);
    SPRING_PUBLISH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let added = 0;
    while ((m = SPRING_PUBLISH_RE.exec(safe)) && added < SPRING_FANOUT_CAP) {
      const targets = listeners.get(m[1]!);
      if (!targets || !targets.length) continue;
      const line = safe.slice(0, m.index).split('\n').length;
      const disp = enclosingFn(nodesInFile, line);
      if (!disp) continue;
      for (const target of targets) {
        if (target.id === disp.id) continue;
        const key = `${disp.id}>${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: disp.id,
          target: target.id,
          kind: 'calls',
          line,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'spring-event', via: m[1]!, registeredAt: `${file}:${line}` },
        });
        added++;
      }
    }
  }
  return edges;
}
