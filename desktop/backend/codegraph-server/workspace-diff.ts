import { readWorkspaceFile, type WorkspaceFileKind } from './workspace';
import type {
  WorkspaceDiffFile,
  WorkspaceDiffFileStatus,
  WorkspaceDiffHunk,
  WorkspaceDiffLine,
  WorkspaceDiffLineKind,
  WorkspaceDiffMode,
  WorkspaceDiffResult,
} from '../../shared/viewer-types';

export type {
  WorkspaceDiffFile,
  WorkspaceDiffFileStatus,
  WorkspaceDiffHunk,
  WorkspaceDiffLine,
  WorkspaceDiffLineKind,
  WorkspaceDiffMode,
  WorkspaceDiffResult,
} from '../../shared/viewer-types';

const MAX_DIFF_BYTES = 8 * 1_048_576;
const MAX_DIFF_LINES_PER_FILE = 10_000;

interface RunningDiffFile extends WorkspaceDiffFile {
  oldPathFromHeader: string | null;
  newPathFromHeader: string | null;
  currentHunk: WorkspaceDiffHunk | null;
  lineCount: number;
  oldCursor: number;
  newCursor: number;
}

function gitPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/dev/null') return null;
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
    : trimmed;
  return unquoted.replace(/^[ab]\//, '');
}

function parseHunkHeader(value: string): WorkspaceDiffHunk | null {
  const match = value.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? 1),
    header: match[5]?.trim() ?? '',
    lines: [],
  };
}

function statusFromFile(file: RunningDiffFile): WorkspaceDiffFileStatus {
  if (file.binary) return 'binary';
  if (file.status === 'added' || file.status === 'deleted' || file.status === 'renamed') return file.status;
  if (file.oldPathFromHeader && file.newPathFromHeader && file.oldPathFromHeader !== file.newPathFromHeader) return 'renamed';
  return 'modified';
}

function finalizeFile(file: RunningDiffFile): WorkspaceDiffFile {
  if (file.currentHunk) file.hunks.push(file.currentHunk);
  const status = statusFromFile(file);
  const pathValue = file.newPathFromHeader ?? file.path;
  const oldPath = file.oldPathFromHeader && file.oldPathFromHeader !== pathValue ? file.oldPathFromHeader : null;
  return {
    path: pathValue,
    oldPath,
    status,
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
    hunks: file.hunks,
  };
}

export function parseUnifiedDiff(diff: string): WorkspaceDiffFile[] {
  const files: WorkspaceDiffFile[] = [];
  let current: RunningDiffFile | null = null;

  const finish = (): void => {
    if (!current) return;
    files.push(finalizeFile(current));
    current = null;
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finish();
      current = {
        path: gitPath(line.slice('diff --git '.length).split(' b/').at(-1) ?? '') ?? 'unknown',
        oldPath: null,
        status: 'modified',
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
        oldPathFromHeader: null,
        newPathFromHeader: null,
        currentHunk: null,
        lineCount: 0,
        oldCursor: 0,
        newCursor: 0,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode ')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      current.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.oldPathFromHeader = gitPath(line.slice('rename from '.length));
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.newPathFromHeader = gitPath(line.slice('rename to '.length));
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.binary = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      current.oldPathFromHeader = gitPath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      current.newPathFromHeader = gitPath(line.slice(4));
      continue;
    }
    if (line.startsWith('@@ ')) {
      if (current.currentHunk) current.hunks.push(current.currentHunk);
      current.currentHunk = parseHunkHeader(line);
      if (current.currentHunk) {
        current.oldCursor = current.currentHunk.oldStart;
        current.newCursor = current.currentHunk.newStart;
      }
      continue;
    }
    if (!current.currentHunk || line.startsWith('\\ No newline at end of file')) continue;
    if (current.lineCount >= MAX_DIFF_LINES_PER_FILE) continue;

    const marker = line[0];
    if (marker !== ' ' && marker !== '+' && marker !== '-') continue;
    const kind: WorkspaceDiffLineKind = marker === '+' ? 'add' : marker === '-' ? 'remove' : 'context';
    const diffLine: WorkspaceDiffLine = {
      kind,
      content: line.slice(1),
      oldLine: kind === 'add' ? null : current.oldCursor,
      newLine: kind === 'remove' ? null : current.newCursor,
    };
    current.currentHunk.lines.push(diffLine);
    if (kind !== 'add') current.oldCursor += 1;
    if (kind !== 'remove') current.newCursor += 1;
    current.lineCount += 1;
    if (kind === 'add') current.additions += 1;
    if (kind === 'remove') current.deletions += 1;
  }
  finish();
  return files;
}

async function runGit(projectRoot: string, args: string[]): Promise<string> {
  const processHandle = Bun.spawn(['git', '-C', projectRoot, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git exited with code ${exitCode}`);
  }
  return stdout;
}

function safeBaseRef(value: string | null): string | null {
  const baseRef = value?.trim() ?? '';
  if (!baseRef) return null;
  if (baseRef.startsWith('-') || !/^[A-Za-z0-9_./:@-]+$/.test(baseRef)) {
    throw new Error('Invalid base ref.');
  }
  return baseRef;
}

async function untrackedFiles(projectRoot: string): Promise<string[]> {
  const status = await runGit(projectRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--']);
  return status
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3).trim())
    .filter((value) => value.length > 0);
}

async function untrackedDiffFile(projectRoot: string, relativePath: string): Promise<WorkspaceDiffFile> {
  const result = await readWorkspaceFile(projectRoot, relativePath);
  const fileKind: WorkspaceFileKind | undefined = result.file.fileKind;
  if (fileKind !== 'text' || result.content === null) {
    return {
      path: relativePath,
      oldPath: null,
      status: 'binary',
      additions: 0,
      deletions: 0,
      binary: true,
      hunks: [],
    };
  }

  const normalizedContent = result.content.endsWith('\n') ? result.content.slice(0, -1) : result.content;
  const contentLines = normalizedContent.length === 0 ? [] : normalizedContent.split('\n');
  const lines: WorkspaceDiffLine[] = contentLines.slice(0, MAX_DIFF_LINES_PER_FILE).map((content, index) => ({
    kind: 'add',
    content,
    oldLine: null,
    newLine: index + 1,
  }));
  return {
    path: relativePath,
    oldPath: null,
    status: 'added',
    additions: lines.length,
    deletions: 0,
    binary: false,
    hunks: [{
      oldStart: 0,
      oldCount: 0,
      newStart: 1,
      newCount: lines.length,
      header: 'untracked file',
      lines,
    }],
  };
}

export async function getWorkspaceDiff(
  projectRoot: string,
  mode: WorkspaceDiffMode = 'uncommitted',
  baseRef: string | null = null,
  ignoreWhitespace = false,
): Promise<WorkspaceDiffResult> {
  const safeRef = safeBaseRef(baseRef);
  const args = ['diff', '--no-ext-diff', '--no-color', '--unified=80'];
  if (ignoreWhitespace) args.push('-w');
  if (mode === 'base' && safeRef) args.push(`${safeRef}...HEAD`);
  else args.push('HEAD');
  args.push('--');

  const raw = await runGit(projectRoot, args);
  if (Buffer.byteLength(raw, 'utf8') > MAX_DIFF_BYTES) {
    return { mode, baseRef: safeRef, files: [], tooLarge: true };
  }
  const files = parseUnifiedDiff(raw);
  if (mode === 'uncommitted') {
    const tracked = new Set(files.map((file) => file.path));
    for (const relativePath of await untrackedFiles(projectRoot)) {
      if (tracked.has(relativePath)) continue;
      files.push(await untrackedDiffFile(projectRoot, relativePath));
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { mode, baseRef: safeRef, files, tooLarge: false };
}
