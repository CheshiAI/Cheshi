import type { Edge, Node } from '../types';
import { enclosingFn } from './callback-source';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import type { ResolutionContext } from './types';

// ── Laravel events (PHP) ──────────────────────────────────────────────────────
// Laravel decouples an event dispatch from its listener(s), linked by the EVENT CLASS:
//   // app/Events/PlaybackStarted.php  +  app/Listeners/UpdateLastfmNowPlaying.php
//   class UpdateLastfmNowPlaying { public function handle(PlaybackStarted $event) { … } }
//   // a controller / service — a DIFFERENT file
//   event(new PlaybackStarted($song, $user));
// Bridge it: link the enclosing method at each `event(new XEvent(...))` site → every listener's
// `handle` for XEvent. Listeners come from TWO registration mechanisms (both real, both needed):
//   (A) auto-discovery — a `handle(EventType $e)` typed first param (also splits a union A|B);
//   (B) the `protected $listen = [ XEvent::class => [Listener::class, …] ]` map in an
//       EventServiceProvider, which also covers a listener whose `handle()` is UNTYPED.
// Only `event(new X)` is matched — queued JOBS dispatch via `::dispatch()` and their `handle()`
// takes an injected service, never an event type, so jobs are excluded by construction.
const LARAVEL_DISPATCH_RE = /\bevent\s*\(\s*new\s+\\?([A-Za-z_][\w\\]*)/g;

const LARAVEL_PHP_EXT = /\.php$/;

const LARAVEL_FANOUT_CAP = 200;

// A `$listen` entry: `Event::class => [Listener::class, …]`, key/values as `::class` or strings.
const LISTEN_ENTRY_RE = /(?:([A-Za-z_\\][\w\\]*)::class|'([^']+)'|"([^"]+)")\s*=>\s*\[([^\x5D]*)\x5D/g;

const LISTEN_CLASS_RE = /(([A-Za-z_\\][\w\\]*)::class|'([^']+)'|"([^"]+)")/g;

/** Short class name from a PHP reference: `\App\Events\Foo` / `App\Events::Foo` → `Foo`. */
function phpSimpleName(s: string): string {
  return s.replace(/^\\/, '').split('\\').pop()!.split('::').pop()!.trim();
}

/** The first-parameter class type(s) of a `handle(...)` declaration — union-split, short-named,
 *  primitives dropped. `handle(A|B $e)` → [A, B]; `handle(string $x)` / `handle()` → []. */
function laravelHandleEventTypes(decl: string): string[] {
  const m = /function\s+handle\s*\(\s*(?:\.\.\.\s*)?(\??[A-Za-z_\\][\w\\|]*)\s+&?\s*(?:\.\.\.\s*)?\$/.exec(decl);
  if (!m) return [];
  return m[1]!
    .replace(/^\?/, '')
    .split('|')
    .map((t) => phpSimpleName(t))
    .filter((t) => /^[A-Z]\w*$/.test(t));
}

/** From an opening `[`, the bracket-balanced body up to its matching `]`. */
function phpArrayBody(src: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']' && --depth === 0) return src.slice(openIdx + 1, i);
  }
  return null;
}

export async function laravelEventEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scannedFiles = 0;
  // event short name → its listener `handle` methods (deduped by node id).
  const listeners = new Map<string, Map<string, Node>>();
  const add = (event: string, handle: Node) => {
    let m = listeners.get(event);
    if (!m) { m = new Map(); listeners.set(event, m); }
    m.set(handle.id, handle);
  };
  const handleOf = (cls: Node): Node | null =>
    ctx
      .getNodesInFile(cls.filePath)
      .find(
        (n) => n.kind === 'method' && n.name === 'handle'
          && n.startLine >= cls.startLine && n.startLine <= (cls.endLine ?? cls.startLine)
      ) ?? null;

  // Pass 1 — build the event→handle map from both registration mechanisms.
  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if (!LARAVEL_PHP_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content) continue;

    // (A) typed listener handles — node-driven, so a commented-out method can't leak in.
    if (content.includes('function handle')) {
      const lines = content.split('\n');
      for (const node of ctx.getNodesInFile(file)) {
        if (node.kind !== 'method' || node.name !== 'handle') continue;
        const decl = lines.slice(node.startLine - 1, node.startLine + 2).join('\n');
        for (const ev of laravelHandleEventTypes(decl)) add(ev, node);
      }
    }

    // (B) the EventServiceProvider `$listen` map — parsed from comment-stripped source so a
    // fully-commented map (firefly's, on auto-discovery) contributes nothing.
    if (content.includes('$listen')) {
      const safe = stripCommentsForRegex(content, 'php');
      const decl = safe.search(/\$listen\s*=\s*\[/);
      const body = decl >= 0 ? phpArrayBody(safe, safe.indexOf('[', decl)) : null;
      if (body) {
        LISTEN_ENTRY_RE.lastIndex = 0;
        let em: RegExpExecArray | null;
        while ((em = LISTEN_ENTRY_RE.exec(body))) {
          const event = phpSimpleName(em[1] ?? em[2] ?? em[3] ?? '');
          LISTEN_CLASS_RE.lastIndex = 0;
          let lm: RegExpExecArray | null;
          while ((lm = LISTEN_CLASS_RE.exec(em[4]!))) {
            const ln = phpSimpleName(lm[2] ?? lm[3] ?? lm[4] ?? lm[1] ?? '');
            const cls = ctx.getNodesByName(ln).find((n) => n.kind === 'class' && handleOf(n));
            if (cls) add(event, handleOf(cls)!);
          }
        }
      }
    }
  }
  if (!listeners.size) return [];

  // Pass 2 — link each event(new X(...)) site → every listener of X.
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if (!LARAVEL_PHP_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || !content.includes('event(')) continue;
    const safe = stripCommentsForRegex(content, 'php');
    const nodesInFile = ctx.getNodesInFile(file);
    LARAVEL_DISPATCH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let added = 0;
    while ((m = LARAVEL_DISPATCH_RE.exec(safe)) && added < LARAVEL_FANOUT_CAP) {
      const targets = listeners.get(phpSimpleName(m[1]!));
      if (!targets) continue;
      const line = safe.slice(0, m.index).split('\n').length;
      const disp = enclosingFn(nodesInFile, line);
      if (!disp) continue;
      for (const target of targets.values()) {
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
          metadata: { synthesizedBy: 'laravel-event', via: phpSimpleName(m[1]!), registeredAt: `${file}:${line}` },
        });
        added++;
      }
    }
  }
  return edges;
}
