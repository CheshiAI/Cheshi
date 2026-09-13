import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createWorkspaceEntry,
  getWorkspaceEntryLocation,
  listWorkspaceDirectory,
  MAX_EDITABLE_FILE_BYTES,
  moveWorkspaceEntry,
  readWorkspaceFile,
  readWorkspaceFileExcerpt,
  renameWorkspaceEntry,
  watchWorkspaceFiles,
  WorkspaceRequestError,
  writeWorkspaceFile,
  writeWorkspaceFiles,
  type WorkspaceFilesChangedEvent,
  type WorkspaceFileWatchListener,
  type WorkspaceFileWatcher,
  type WorkspaceFileWatcherFactory,
} from '@cheshi/codegraph-server/workspace';

function failExpectedWorkspaceError(): never {
  throw new Error('Expected a workspace request error.');
}

function assertWorkspaceError(error: unknown, status: number): void {
  expect(error).toBeInstanceOf(WorkspaceRequestError);
  expect((error as WorkspaceRequestError).status).toBe(status);
}

async function expectWorkspaceError(action: () => Promise<unknown>, status: number): Promise<void> {
  try {
    await action();
  } catch (error) {
    assertWorkspaceError(error, status);
    return;
  }
  failExpectedWorkspaceError();
}

describe('workspace file service', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheshire-workspace-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cheshire-workspace-outside-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('first\r\nsecond\r\n', 'utf8'),
    ]));
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=not-a-secret\n', 'utf8');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n', 'utf8');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'outside-link.txt'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('lists safe entries and reads BOM and line-ending metadata', async () => {
    expect(fs.readFileSync(path.join(root, 'src', 'app.ts')).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const visible = await listWorkspaceDirectory(root);
    expect(visible.entries.map((entry) => entry.name)).toEqual(['src']);

    const withHidden = await listWorkspaceDirectory(root, '.', true);
    expect(withHidden.entries.map((entry) => entry.name)).toEqual(['src', '.env']);
    expect(withHidden.entries.some((entry) => entry.name === 'outside-link.txt')).toBe(false);

    const truthyIncludeHidden = 1 as unknown as boolean;
    const withoutLiteralTrue = await listWorkspaceDirectory(root, '.', truthyIncludeHidden);
    expect(withoutLiteralTrue.entries.map((entry) => entry.name)).toEqual(['src']);

    const file = await readWorkspaceFile(root, 'src/app.ts');
    expect(file.file.fileKind).toBe('text');
    expect(file.file.hasBom).toBe(true);
    expect(file.file.lineEnding).toBe('crlf');
    expect(file.content).toBe('first\r\nsecond\r\n');
    expect(file.dataUrl).toBeNull();
  });

  it('batches filesystem changes without polling', async () => {
    const events: WorkspaceFilesChangedEvent[] = [];
    let listener: WorkspaceFileWatchListener | null = null;
    let watcherClosed = false;
    const watcher: WorkspaceFileWatcher = {
      on(_event: 'error', _listener: (error: Error) => void): WorkspaceFileWatcher {
        return watcher;
      },
      close(): void {
        watcherClosed = true;
      },
    };
    const watcherFactory: WorkspaceFileWatcherFactory = (
      _directory: string,
      options: { recursive: true },
      nextListener: WorkspaceFileWatchListener,
    ): WorkspaceFileWatcher => {
      expect(options.recursive).toBe(true);
      listener = nextListener;
      return watcher;
    };
    const stopWatching = await watchWorkspaceFiles(
      root,
      (event) => events.push(event),
      { debounceMs: 10, pathLimit: 2, watcherFactory },
    );
    const emitChange = (eventType: string, filename: string | null): void => {
      if (!listener) throw new Error('Workspace file watcher listener is unavailable.');
      listener(eventType, filename);
    };

    try {
      emitChange('rename', 'src/created-in-src.ts');
      emitChange('change', 'created-at-root.ts');
      emitChange('change', '.git/index');
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(events).toEqual([{
        paths: ['created-at-root.ts', 'src/created-in-src.ts'],
        overflow: false,
      }]);

      emitChange('rename', 'one.ts');
      emitChange('rename', 'two.ts');
      emitChange('rename', 'three.ts');
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(events.at(-1)).toEqual({ paths: [], overflow: true });

      stopWatching();
      const eventCountAfterStop = events.length;
      emitChange('rename', 'created-after-stop.ts');
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(events).toHaveLength(eventCountAfterStop);
      expect(watcherClosed).toBe(true);
    } finally {
      stopWatching();
    }
  });

  it('rejects traversal and symlink escape attempts', async () => {
    await expectWorkspaceError(() => readWorkspaceFile(root, '../secret.txt'), 403);
    await expectWorkspaceError(() => readWorkspaceFile(root, 'outside-link.txt'), 403);
    await expectWorkspaceError(() => readWorkspaceFile(root, 'src'), 400);
  });

  it('resolves mutable entry locations without exposing the workspace root or symlinks', async () => {
    expect(await getWorkspaceEntryLocation(root, 'src/app.ts')).toEqual({
      path: 'src/app.ts',
      absolutePath: path.join(fs.realpathSync(root), 'src', 'app.ts'),
    });
    await expectWorkspaceError(() => getWorkspaceEntryLocation(root, '.'), 403);
    await expectWorkspaceError(() => getWorkspaceEntryLocation(root, '../secret.txt'), 403);
    await expectWorkspaceError(() => getWorkspaceEntryLocation(root, 'outside-link.txt'), 403);
  });

  it('renames files and directories without overwriting existing entries', async () => {
    expect(await renameWorkspaceEntry(root, { path: 'src/app.ts', newName: 'main.ts' })).toEqual({
      previousPath: 'src/app.ts',
      path: 'src/main.ts',
    });
    expect(fs.existsSync(path.join(root, 'src', 'app.ts'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src', 'main.ts'))).toBe(true);

    expect(await renameWorkspaceEntry(root, { path: 'src', newName: 'source' })).toEqual({
      previousPath: 'src',
      path: 'source',
    });
    expect(fs.existsSync(path.join(root, 'source', 'main.ts'))).toBe(true);

    fs.writeFileSync(path.join(root, 'occupied.txt'), 'occupied\n', 'utf8');
    fs.writeFileSync(path.join(root, 'rename-me.txt'), 'rename me\n', 'utf8');
    await expectWorkspaceError(
      () => renameWorkspaceEntry(root, { path: 'rename-me.txt', newName: 'occupied.txt' }),
      409,
    );
    await expectWorkspaceError(() => renameWorkspaceEntry(root, { path: '.', newName: 'other' }), 403);
    await expectWorkspaceError(
      () => renameWorkspaceEntry(root, { path: 'rename-me.txt', newName: '../outside.txt' }),
      400,
    );
  });

  it('creates empty files and folders without overwriting existing entries', async () => {
    expect(await createWorkspaceEntry(root, {
      directoryPath: 'src',
      name: 'new-file.ts',
      kind: 'file',
    })).toEqual({ path: 'src/new-file.ts', kind: 'file' });
    expect(fs.readFileSync(path.join(root, 'src', 'new-file.ts'), 'utf8')).toBe('');

    expect(await createWorkspaceEntry(root, {
      directoryPath: '.',
      name: 'components',
      kind: 'directory',
    })).toEqual({ path: 'components', kind: 'directory' });
    expect(fs.statSync(path.join(root, 'components')).isDirectory()).toBe(true);

    await expectWorkspaceError(
      () => createWorkspaceEntry(root, { directoryPath: 'src', name: 'new-file.ts', kind: 'file' }),
      409,
    );
    await expectWorkspaceError(
      () => createWorkspaceEntry(root, { directoryPath: 'src/app.ts', name: 'nested.txt', kind: 'file' }),
      400,
    );
    await expectWorkspaceError(
      () => createWorkspaceEntry(root, { directoryPath: '.', name: '../outside.txt', kind: 'file' }),
      400,
    );
  });

  it('moves files and folders without escaping or overwriting the workspace', async () => {
    fs.mkdirSync(path.join(root, 'target'));
    expect(await moveWorkspaceEntry(root, {
      path: 'src/app.ts',
      destinationDirectory: 'target',
    })).toEqual({ previousPath: 'src/app.ts', path: 'target/app.ts' });
    expect(fs.existsSync(path.join(root, 'src', 'app.ts'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'target', 'app.ts'))).toBe(true);

    expect(await moveWorkspaceEntry(root, {
      path: 'target/app.ts',
      destinationDirectory: 'target',
    })).toEqual({ previousPath: 'target/app.ts', path: 'target/app.ts' });

    fs.mkdirSync(path.join(root, 'target', 'src'));
    await expectWorkspaceError(
      () => moveWorkspaceEntry(root, { path: 'src', destinationDirectory: 'target' }),
      409,
    );
    await expectWorkspaceError(
      () => moveWorkspaceEntry(root, { path: '.', destinationDirectory: 'target' }),
      403,
    );
    await expectWorkspaceError(
      () => moveWorkspaceEntry(root, { path: 'target/app.ts', destinationDirectory: '../outside' }),
      403,
    );

    fs.mkdirSync(path.join(root, 'tree', 'child'), { recursive: true });
    await expectWorkspaceError(
      () => moveWorkspaceEntry(root, { path: 'tree', destinationDirectory: 'tree/child' }),
      400,
    );
  });

  it('classifies binary and oversized files without loading oversized content', async () => {
    fs.writeFileSync(path.join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([0x00, 0x01, 0x02]));
    fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(MAX_EDITABLE_FILE_BYTES + 1), 'utf8');

    const image = await readWorkspaceFile(root, 'image.png');
    expect(image.file.fileKind).toBe('image');
    expect(image.dataUrl).toBe('data:image/png;base64,iVBORw==');

    const binary = await readWorkspaceFile(root, 'binary.dat');
    expect(binary.file.fileKind).toBe('binary');
    expect(binary.content).toBeNull();

    const large = await readWorkspaceFile(root, 'large.txt');
    expect(large.file.fileKind).toBe('too_large');
    expect(large.content).toBeNull();
  });

  it('streams a bounded UTF-8 excerpt around a line in an oversized file', async () => {
    const sourceLines = Array.from({ length: 300 }, (_, index) => (
      `line ${index + 1} `.padEnd(4_096, String(index % 10))
    ));
    sourceLines[150] = 'export function target(): number { return 42; }';
    fs.writeFileSync(path.join(root, 'large-source.ts'), sourceLines.join('\n'), 'utf8');
    expect(fs.statSync(path.join(root, 'large-source.ts')).size).toBeGreaterThan(MAX_EDITABLE_FILE_BYTES);

    const excerpt = await readWorkspaceFileExcerpt(root, {
      path: 'large-source.ts',
      line: 151,
      contextLines: 2,
    });
    expect(excerpt.file.fileKind).toBe('too_large');
    expect(excerpt.startLine).toBe(149);
    expect(excerpt.endLine).toBe(153);
    expect(excerpt.targetLine).toBe(151);
    expect(excerpt.hasMoreBefore).toBe(true);
    expect(excerpt.hasMoreAfter).toBe(true);
    expect(excerpt.content.split('\n')).toEqual(sourceLines.slice(148, 153));

    await expectWorkspaceError(
      () => readWorkspaceFileExcerpt(root, { path: '../secret.txt', line: 1 }),
      403,
    );
    await expectWorkspaceError(
      () => readWorkspaceFileExcerpt(root, { path: 'large-source.ts', line: 301 }),
      416,
    );
    await expectWorkspaceError(
      () => readWorkspaceFileExcerpt(root, { path: 'large-source.ts', line: 151, contextLines: 201 }),
      400,
    );
  });

  it('writes atomically, preserves formatting metadata, and detects stale revisions', async () => {
    const original = await readWorkspaceFile(root, 'src/app.ts');
    const result = await writeWorkspaceFile(root, {
      path: 'src/app.ts',
      content: 'updated\ncontent\n',
      expectedRevision: original.file.revision,
      hasBom: original.file.hasBom,
      lineEnding: original.file.lineEnding,
    });
    expect(result.status).toBe('written');
    const raw = fs.readFileSync(path.join(root, 'src', 'app.ts'));
    expect(raw.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(raw.subarray(3).toString('utf8')).toBe('updated\r\ncontent\r\n');

    const stale = await writeWorkspaceFile(root, {
      path: 'src/app.ts',
      content: 'stale\n',
      expectedRevision: original.file.revision,
    });
    expect(stale.status).toBe('conflict');
    expect(stale.file.revision).not.toBe(original.file.revision);

    const temporaryFiles = fs.readdirSync(path.join(root, 'src')).filter((name) => name.includes('.cheshi-'));
    expect(temporaryFiles).toEqual([]);
  });

  it('rejects malformed write formatting metadata at the runtime boundary', async () => {
    const original = await readWorkspaceFile(root, 'src/app.ts');
    const malformedRequest = {
      path: 'src/app.ts',
      content: 'must not be written\n',
      expectedRevision: original.file.revision,
      hasBom: 'true',
    } as unknown as Parameters<typeof writeWorkspaceFile>[1];

    await expectWorkspaceError(() => writeWorkspaceFile(root, malformedRequest), 400);
    expect(fs.readFileSync(path.join(root, 'src', 'app.ts'), 'utf8')).toBe('\uFEFFfirst\r\nsecond\r\n');
  });

  it('preflights and writes a revision-safe batch of text files', async () => {
    fs.writeFileSync(path.join(root, 'first.ts'), 'export const first = 1;\n');
    fs.writeFileSync(path.join(root, 'second.ts'), 'export const second = 2;\n');
    const first = await readWorkspaceFile(root, 'first.ts');
    const second = await readWorkspaceFile(root, 'second.ts');

    const written = await writeWorkspaceFiles(root, {
      files: [
        { path: 'first.ts', content: 'export const first = 10;\n', expectedRevision: first.file.revision },
        { path: 'second.ts', content: 'export const second = 20;\n', expectedRevision: second.file.revision },
      ],
    });
    expect(written.status).toBe('written');
    expect(written.files.map((file) => file.path)).toEqual(['first.ts', 'second.ts']);
    expect(fs.readFileSync(path.join(root, 'first.ts'), 'utf8')).toBe('export const first = 10;\n');
    expect(fs.readFileSync(path.join(root, 'second.ts'), 'utf8')).toBe('export const second = 20;\n');

    const latestFirst = await readWorkspaceFile(root, 'first.ts');
    fs.writeFileSync(path.join(root, 'second.ts'), 'external change\n');
    const conflict = await writeWorkspaceFiles(root, {
      files: [
        { path: 'first.ts', content: 'must not be written\n', expectedRevision: latestFirst.file.revision },
        { path: 'second.ts', content: 'must not be written\n', expectedRevision: written.files[1]!.revision },
      ],
    });
    expect(conflict.status).toBe('conflict');
    expect(conflict.files.map((file) => file.path)).toEqual(['second.ts']);
    expect(fs.readFileSync(path.join(root, 'first.ts'), 'utf8')).toBe('export const first = 10;\n');
    expect(fs.readFileSync(path.join(root, 'second.ts'), 'utf8')).toBe('external change\n');

    await expectWorkspaceError(() => writeWorkspaceFiles(root, {
      files: [
        { path: 'first.ts', content: 'duplicate one\n', expectedRevision: latestFirst.file.revision },
        { path: './first.ts', content: 'duplicate two\n', expectedRevision: latestFirst.file.revision },
      ],
    }), 400);
    expect(fs.readFileSync(path.join(root, 'first.ts'), 'utf8')).toBe('export const first = 10;\n');
  });
});
