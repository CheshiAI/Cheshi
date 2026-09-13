import type { Edge, Node } from '../types';
import { enclosingFn } from './callback-source';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import type { ResolutionContext } from './types';

// ── MediatR request/notification dispatch (C#/.NET) ───────────────────────────
// MediatR decouples a Send/Publish call site from its Handle method through a mediator,
// linked by the request/notification TYPE (the IRequestHandler<T,…> generic):
//   // CancelOrderCommandHandler.cs — the handler
//   public class CancelOrderCommandHandler : IRequestHandler<CancelOrderCommand, bool> {
//       public async Task<bool> Handle(CancelOrderCommand request, CancellationToken ct) { … }
//   // some controller — the dispatch (usually a DIFFERENT file)
//   var command = new CancelOrderCommand(orderId);   await _mediator.Send(command);
// Bridge it: link the enclosing method at each mediator `.Send(x)`/`.Publish(x)` site → the
// `Handle` method of the handler for x's type. The sent type is resolved from the argument —
// inline `new X(…)`, a local `var v = new X(…)`, or a parameter/local declared `X v` — bounded
// to the enclosing method. Precision rests on TWO gates: the receiver must be mediator-ish
// (`mediator`/`sender`/`publisher`, so MAUI `MessagingCenter.Send` is ignored) AND the resolved
// type must be a known handler request type (so a same-named non-request DTO is never bridged).
// C# has no `signature` on method nodes, so the handler's request type is read from the class
// base-list source (`: IRequestHandler<X,…>`), not a param signature.
const MEDIATR_HANDLER_BASE_RE = /(?:IRequestHandler|INotificationHandler)\s*<\s*([A-Za-z_]\w*)/;

const MEDIATR_DISPATCH_RE = /([A-Za-z_][\w.]*)\s*\.\s*(?:Send|Publish)\s*\(\s*(new\s+[A-Z]\w*|[A-Za-z_]\w*)/g;

const MEDIATR_RECEIVER_RE = /(mediator|sender|publisher)/i;

const MEDIATR_CS_EXT = /\.cs$/;

const MEDIATR_FANOUT_CAP = 80;

const MEDIATR_HANDLER_DECL_LOOKAHEAD = 4;

// lines from a class startLine to find a wrapped base list

/** The type sent at a MediatR `.Send(arg)`/`.Publish(arg)` site: an inline `new X(…)`, else
 *  `arg` as an identifier resolved within the enclosing method — a `… arg = new X(…)` assignment
 *  (wins), or a parameter/local declared `X arg`. Returns null when the type can't be seen. */
function resolveMediatrArgType(arg: string, lines: string[], methodStart: number, dispatchLine: number): string | null {
  const inl = /^new\s+([A-Z]\w*)/.exec(arg);
  if (inl) return inl[1]!;
  if (!/^[A-Za-z_]\w*$/.test(arg)) return null;
  const assignRe = new RegExp(`\\b${arg}\\b\\s*=\\s*new\\s+([A-Z]\\w*)`);
  const declRe = new RegExp(`\\b([A-Z]\\w*)\\b\\s+${arg}\\b`);
  let declType: string | null = null;
  for (let i = Math.max(0, methodStart - 1); i < dispatchLine && i < lines.length; i++) {
    const ln = lines[i] ?? '';
    const a = assignRe.exec(ln);
    if (a) return a[1]!; // an explicit `arg = new X` is the most specific — take it
    if (!declType) {
      const d = declRe.exec(ln);
      if (d) declType = d[1]!; // a `X arg` declaration — remember, but keep scanning for an assignment
    }
  }
  return declType;
}

export async function mediatrDispatchEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scannedFiles = 0;
  // Pass 1 — request/notification type → the Handle method of each handler class.
  const handlers = new Map<string, Node[]>();
  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if (!MEDIATR_CS_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || (!content.includes('IRequestHandler<') && !content.includes('INotificationHandler<'))) continue;
    const lines = content.split('\n');
    const nodesInFile = ctx.getNodesInFile(file);
    for (const cls of nodesInFile) {
      if (cls.kind !== 'class') continue;
      const decl = lines.slice(cls.startLine - 1, cls.startLine - 1 + MEDIATR_HANDLER_DECL_LOOKAHEAD).join('\n');
      const m = MEDIATR_HANDLER_BASE_RE.exec(decl);
      if (!m) continue;
      const type = m[1]!;
      const end = cls.endLine ?? cls.startLine;
      const handle = nodesInFile.find(
        (n) => n.kind === 'method' && n.name === 'Handle' && n.startLine >= cls.startLine && n.startLine <= end
      );
      if (!handle) continue;
      let arr = handlers.get(type);
      if (!arr) { arr = []; handlers.set(type, arr); }
      arr.push(handle);
    }
  }
  if (!handlers.size) return [];

  // Pass 2 — link each mediator-ish .Send(x)/.Publish(x) → the handler of x's type.
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if ((++scannedFiles & 15) === 0) await onYield();
    if (!MEDIATR_CS_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || (!content.includes('.Send(') && !content.includes('.Publish('))) continue;
    const safe = stripCommentsForRegex(content, 'csharp');
    const safeLines = safe.split('\n');
    const nodesInFile = ctx.getNodesInFile(file);
    MEDIATR_DISPATCH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let added = 0;
    while ((m = MEDIATR_DISPATCH_RE.exec(safe)) && added < MEDIATR_FANOUT_CAP) {
      if (!MEDIATR_RECEIVER_RE.test(m[1]!)) continue; // not a mediator (MessagingCenter, HttpClient, …)
      const line = safe.slice(0, m.index).split('\n').length;
      const disp = enclosingFn(nodesInFile, line);
      if (!disp) continue;
      const type = resolveMediatrArgType(m[2]!, safeLines, disp.startLine, line);
      if (!type) continue;
      const targets = handlers.get(type);
      if (!targets) continue;
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
          metadata: { synthesizedBy: 'mediatr-dispatch', via: type, registeredAt: `${file}:${line}` },
        });
        added++;
      }
    }
  }
  return edges;
}
