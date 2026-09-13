import type { Node } from '../types';

type RequestedDefinition = Pick<Node, 'filePath' | 'name' | 'qualifiedName' | 'startLine' | 'endLine'>;

/** Serializable source metadata carried from a query worker to the final response. */
export interface ExploreSourceContext {
  maxChars: number;
  targets: RequestedDefinition[];
  staleFiles: string[];
  projectPath: string;
  lineNumbers: boolean;
  summaryPlaceholder: string;
  fallbackSummary: string;
  files: Array<{ path: string; symbolCount: number }>;
}

interface SourceRange {
  start: number;
  end: number;
}

const GAP = '\n\n... (gap) ...\n\n';

/** Keep requested definitions separate from enclosing classes and nearby methods. */
export function requestedSourceRanges(nodes: Node[]): SourceRange[] {
  const ranges: SourceRange[] = [];
  for (const node of [...nodes].sort((a, b) => a.startLine - b.startLine)) {
    if (node.startLine < 1 || node.endLine < node.startLine) continue;
    const previous = ranges.at(-1);
    if (previous && node.startLine <= previous.end) {
      previous.end = Math.max(previous.end, node.endLine);
    } else {
      ranges.push({ start: node.startLine, end: node.endLine });
    }
  }
  return ranges;
}

function numberedLines(lines: string[], range: SourceRange): string[] {
  const result: string[] = [];
  for (let line = range.start; line <= Math.min(range.end, lines.length); line++) {
    result.push(`${line}\t${lines[line - 1]}`);
  }
  return result;
}

export function requestedSourceSize(lines: string[], nodes: Node[]): number {
  return requestedSourceRanges(nodes).map((range) => numberedLines(lines, range).join('\n')).join(GAP).length;
}

/** Fit complete definitions first; oversized bodies end only at source-line boundaries. */
export function renderRequestedSource(lines: string[], nodes: Node[], maxChars: number, contextNodes: Node[] = []): string {
  const requestedRanges = requestedSourceRanges(nodes);
  const bodies = requestedRanges.map((range) => numberedLines(lines, range));
  const sizes = bodies.map((body) => body.join('\n').length);
  const parts: string[] = [];
  let remaining = Math.max(0, maxChars);
  for (let i = 0; i < bodies.length; i++) {
    const separator = parts.length ? GAP.length : 0;
    const share = Math.floor(Math.max(0, remaining - separator) / (bodies.length - i));
    const reserved = sizes.slice(i + 1).reduce((sum, size) => sum + Math.min(size + GAP.length, share), 0);
    const allowance = Math.max(0, remaining - separator - reserved);
    const chosen: string[] = [];
    let used = 0;
    for (const line of bodies[i]!) {
      const cost = line.length + (chosen.length ? 1 : 0);
      if (used + cost > allowance) break;
      chosen.push(line);
      used += cost;
    }
    if (chosen.length) {
      parts.push(chosen.join('\n'));
      remaining -= used + separator;
    }
  }
  // Once requested bodies have their allocation, spend only spare space on the
  // connecting call path. Never re-emit a containing/overlapping definition.
  const contextRanges = requestedSourceRanges(contextNodes).filter((range) =>
    !requestedRanges.some((requested) => range.start <= requested.end && requested.start <= range.end),
  );
  for (const range of contextRanges) {
    const body = numberedLines(lines, range).join('\n');
    const cost = body.length + (parts.length ? GAP.length : 0);
    if (cost > remaining) continue;
    parts.push(body);
    remaining -= cost;
  }
  return parts.join(GAP);
}

function displayedLines(text: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) {
      const header = /^\*\*`([^`]+)`\*\*/.exec(line);
      if (header) {
        current = files.get(header[1]!) ?? new Set<number>();
        files.set(header[1]!, current);
      }
    } else {
      const source = /^(\d+)\t/.exec(line);
      if (source) current?.add(Number(source[1]));
    }
  }
  return files;
}

function continuationNotes(text: string, targets: RequestedDefinition[], staleFiles: Set<string>, projectPath: string, maxChars: number): string {
  const shown = displayedLines(text);
  const notes: string[] = [];
  const reportedStaleFiles = new Set<string>();
  let used = 0;
  let remaining = 0;
  for (const node of targets) {
    let note: string;
    if (staleFiles.has(node.filePath)) {
      if (reportedStaleFiles.has(node.filePath)) continue;
      reportedStaleFiles.add(node.filePath);
      // Keep this notice inside the final budget too: a preceding drift warning
      // may have been clipped, and indexed offsets are unsafe for changed files.
      const args = { projectPath, file: node.filePath };
      note = `> Source changed on disk: \`${node.filePath}\`; indexed line numbers may be shifted. Retrieve current source with \`codegraph_node\` ${JSON.stringify(args)}.`;
    } else {
      const lines = shown.get(node.filePath);
      let first = node.startLine;
      while (first <= node.endLine && lines?.has(first)) first++;
      if (first > node.endLine) continue;
      let last = first;
      while (last < node.endLine && !lines?.has(last + 1)) last++;
      const args = { projectPath, file: node.filePath, offset: first, limit: Math.min(200, last - first + 1) };
      note = `> Source incomplete: \`${node.qualifiedName || node.name}\` in \`${node.filePath}\`; next missing lines ${first}–${last}. Continue with \`codegraph_node\` ${JSON.stringify(args)}.`;
    }
    if (used + note.length + 2 <= maxChars - 160) {
      notes.push(note);
      used += note.length + 2;
    } else {
      remaining++;
    }
  }
  if (remaining) notes.push(`> ${remaining} more requested definitions are not fully shown. Use codegraph_node with their symbol and file names for the remaining source.`);
  return notes.join('\n\n');
}

/** Shorten on line boundaries and close any open source fence. */
function clipSource(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, Math.max(0, maxChars - 5));
  const boundary = cut.lastIndexOf('\n');
  const result = boundary < 0 ? '' : cut.slice(0, boundary);
  const open = result.split('\n').filter((line) => /^```/.test(line)).length % 2 === 1;
  return result + (open ? '\n```' : '');
}

/** Audit the final, capped response, not the larger set of candidate definitions. */
export function finalizeExploreSource(
  output: string,
  options: { maxChars: number; targets: RequestedDefinition[]; staleFiles: Set<string>; projectPath: string; lineNumbers: boolean },
): string {
  const { maxChars, targets, staleFiles, projectPath, lineNumbers } = options;
  const shorteningNote = '\n\n> Output shortened to its budget. Only the displayed source ranges are included.';
  const noteBudget = Math.min(4000, Math.floor(maxChars / 3));
  // Reserving notices up front makes the cap include the continuation itself.
  // Usually this reserve is unused: full bodies need no continuation note.
  let limit = maxChars;
  let text = output;
  let notes = '';
  for (let attempt = 0; attempt <= targets.length + 2; attempt++) {
    text = clipSource(output, limit);
    notes = continuationNotes(text, targets, staleFiles, projectPath, noteBudget);
    const suffix = (notes ? `\n\n${notes}` : '') + (text !== output ? shorteningNote : '');
    if (text.length + suffix.length <= maxChars) {
      const result = text + suffix;
      return lineNumbers ? result : result.replace(/^(\d+)\t/gm, '');
    }
    limit = Math.min(limit - 1, Math.max(0, maxChars - suffix.length));
  }
  // A very broad query can introduce more omissions each time the source shrinks.
  // The bounded fallback reserves the entire note allowance and stays honest.
  text = clipSource(output, Math.max(0, maxChars - noteBudget - shorteningNote.length - 2));
  notes = continuationNotes(text, targets, staleFiles, projectPath, noteBudget);
  const result = text + (notes ? `\n\n${notes}` : '') + shorteningNote;
  return lineNumbers ? result : result.replace(/^(\d+)\t/gm, '');
}

function limitStatusNotice(notice: string): string {
  const maxChars = 2000;
  if (notice.length <= maxChars) return notice;
  const suffix = '\n\n> More index status details omitted. Check codegraph_status before relying on indexed locations.\n\n';
  const head = notice.slice(0, maxChars - suffix.length);
  const boundary = head.lastIndexOf('\n');
  return (boundary >= 0 ? head.slice(0, boundary) : '') + suffix;
}

/** Apply the cap after main-thread status notices, preserving their reserved space. */
export function finalizeExploreResponse(source: string, decorated: string, context: ExploreSourceContext): string {
  const start = decorated.indexOf(source);
  if (start < 0) throw new Error('Explore status notices must preserve the source response');
  const prefix = limitStatusNotice(decorated.slice(0, start));
  const suffix = limitStatusNotice(decorated.slice(start + source.length));
  let text = finalizeExploreSource(source, {
    maxChars: context.maxChars - prefix.length - suffix.length,
    targets: context.targets,
    staleFiles: new Set(context.staleFiles),
    projectPath: context.projectPath,
    lineNumbers: context.lineNumbers,
  });
  const survivors = context.files.filter((file) => text.includes(`**\`${file.path}\`**`));
  const symbols = survivors.reduce((total, file) => total + file.symbolCount, 0);
  const summary = survivors.length
    ? `Found ${symbols} symbol${symbols === 1 ? '' : 's'} across ${survivors.length} file${survivors.length === 1 ? '' : 's'}.`
    : context.fallbackSummary;
  text = text.replace(context.summaryPlaceholder, summary);
  return prefix + text + suffix;
}
