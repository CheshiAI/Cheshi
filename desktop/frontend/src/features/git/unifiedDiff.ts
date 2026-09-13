export type UnifiedDiffLineKind = 'addition' | 'context' | 'deletion' | 'meta';

export interface UnifiedDiffLine {
  kind: UnifiedDiffLineKind;
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface UnifiedDiffFile {
  path: string;
  oldPath: string | null;
  additions: number;
  deletions: number;
  lines: UnifiedDiffLine[];
}

function normalizeDiffPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/dev/null') return null;
  let decoded = trimmed;
  if (decoded.startsWith('"') && decoded.endsWith('"')) {
    try {
      decoded = JSON.parse(decoded) as string;
    } catch {
      decoded = decoded.slice(1, -1);
    }
  }
  return decoded.replace(/^[ab]\//, '');
}

function createDiffFile(path: string | null): UnifiedDiffFile {
  return {
    path: path ?? '',
    oldPath: null,
    additions: 0,
    deletions: 0,
    lines: [],
  };
}

function mergeFilesByPath(files: UnifiedDiffFile[]): UnifiedDiffFile[] {
  const mergedFiles: UnifiedDiffFile[] = [];
  const filesByPath = new Map<string, UnifiedDiffFile>();

  for (const file of files) {
    if (!file.path || file.lines.length === 0) continue;
    const existing = filesByPath.get(file.path);
    if (!existing) {
      filesByPath.set(file.path, file);
      mergedFiles.push(file);
      continue;
    }
    existing.oldPath ??= file.oldPath;
    existing.additions += file.additions;
    existing.deletions += file.deletions;
    existing.lines.push(...file.lines);
  }

  return mergedFiles;
}

export function parseUnifiedDiff(patch: string): UnifiedDiffFile[] {
  if (!patch.trim()) return [];
  const files: UnifiedDiffFile[] = [];
  let current: UnifiedDiffFile | null = null;
  let oldLine: number | null = null;
  let newLine: number | null = null;

  for (const line of patch.replaceAll('\r\n', '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
      current = createDiffFile(normalizeDiffPath(match?.[2] ?? '') ?? normalizeDiffPath(match?.[1] ?? ''));
      current.oldPath = normalizeDiffPath(match?.[1] ?? '');
      files.push(current);
      oldLine = null;
      newLine = null;
      current.lines.push({ kind: 'meta', content: line, oldLine: null, newLine: null });
      continue;
    }

    if (!current) continue;
    const file = current;
    if (line.startsWith('--- ')) {
      file.oldPath = normalizeDiffPath(line.slice(4));
      file.lines.push({ kind: 'meta', content: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith('+++ ')) {
      file.path = normalizeDiffPath(line.slice(4)) ?? file.oldPath ?? file.path;
      file.lines.push({ kind: 'meta', content: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith('@@')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldLine = hunk ? Number.parseInt(hunk[1] ?? '0', 10) : null;
      newLine = hunk ? Number.parseInt(hunk[2] ?? '0', 10) : null;
      file.lines.push({ kind: 'meta', content: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      file.additions += 1;
      file.lines.push({ kind: 'addition', content: line.slice(1), oldLine: null, newLine });
      if (newLine !== null) newLine += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      file.deletions += 1;
      file.lines.push({ kind: 'deletion', content: line.slice(1), oldLine, newLine: null });
      if (oldLine !== null) oldLine += 1;
      continue;
    }
    if (line.startsWith(' ') && oldLine !== null && newLine !== null) {
      file.lines.push({ kind: 'context', content: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    file.lines.push({ kind: 'meta', content: line, oldLine: null, newLine: null });
  }

  return mergeFilesByPath(files);
}
