import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink as createSymbolicLink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalHistoryService } from '../lib/local-history-service.mts';
import { readWorkspaceFile } from '../lib/workspace-file-reads.mts';
import type { LocalHistoryRestoreRequest } from '../shared/local-history';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: { maxBytes?: number; invalidDirectory?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cheshi-local-history-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const workspaceRoot = path.join(directory, 'workspace');
  const historyDirectory = path.join(directory, 'history');
  await mkdir(workspaceRoot);
  if (options.invalidDirectory) await writeFile(historyDirectory, 'occupied');
  const errors: Error[] = [];
  const service = new LocalHistoryService({
    workspaceRoot, directory: historyDirectory, maxBytes: options.maxBytes,
    onError: (error) => errors.push(error),
  });
  cleanups.push(() => service.dispose());
  return { directory, workspaceRoot, historyDirectory, service, errors };
}

async function expectFailure(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(pattern);
}

describe('local history service', () => {
  test('records original and saved text without an initial read or Git writes', async () => {
    const { workspaceRoot, service } = await fixture();
    await mkdir(path.join(workspaceRoot, '.git'));
    await writeFile(path.join(workspaceRoot, '.git', 'index'), 'untouched');
    await writeFile(path.join(workspaceRoot, 'draft.txt'), 'original\n');
    const original = await readWorkspaceFile(workspaceRoot, 'draft.txt');
    const written = await service.writeFile({ path: 'draft.txt', content: 'updated\n', expectedRevision: original.file.revision });
    expect(written.status).toBe('written');
    const entries = await service.list('draft.txt');
    expect(entries.map((entry) => entry.reason)).toEqual(['saved', 'opened']);
    expect((await service.read('draft.txt', entries[1]!.id)).content).toBe('original\n');
    expect((await service.read('draft.txt', entries[0]!.id)).content).toBe('updated\n');
    expect(await readFile(path.join(workspaceRoot, '.git', 'index'), 'utf8')).toBe('untouched');
    expect((await readdir(workspaceRoot)).sort()).toEqual(['.git', 'draft.txt']);
  });

  test('deduplicates opening, identical saves, and the watcher event from our save', async () => {
    const { workspaceRoot, service } = await fixture();
    await writeFile(path.join(workspaceRoot, 'draft.txt'), 'same');
    const first = await service.readFile('draft.txt');
    await service.readFile('draft.txt');
    await service.writeFile({ path: 'draft.txt', content: 'same', expectedRevision: first.file.revision });
    await service.captureChanged({ paths: ['draft.txt'], overflow: false });
    expect((await service.list('draft.txt')).length).toBe(1);
  });

  test('restore preserves BOM and CRLF, records the predecessor, and allows undo', async () => {
    const { workspaceRoot, service } = await fixture();
    await writeFile(path.join(workspaceRoot, 'draft.txt'), '\uFEFFone\r\ntwo\r\n');
    await service.readFile('draft.txt');
    const originalEntry = (await service.list('draft.txt'))[0]!;
    // An unobserved external edit must be captured immediately before restoration.
    await writeFile(path.join(workspaceRoot, 'draft.txt'), 'external\nedit\n');
    const external = await readWorkspaceFile(workspaceRoot, 'draft.txt');
    const restored = await service.restore({ path: 'draft.txt', id: originalEntry.id, expectedRevision: external.file.revision });
    expect(restored.status).toBe('written');
    expect(await readFile(path.join(workspaceRoot, 'draft.txt'), 'utf8')).toBe('\uFEFFone\r\ntwo\r\n');
    const entries = await service.list('draft.txt');
    expect(entries.map((entry) => entry.reason)).toEqual(['restored', 'before-restore', 'opened']);
    const predecessor = entries[1]!;
    const undone = await service.restore({ path: 'draft.txt', id: predecessor.id, expectedRevision: restored.file.revision });
    expect(undone.status).toBe('written');
    expect(await readFile(path.join(workspaceRoot, 'draft.txt'), 'utf8')).toBe('external\nedit\n');
  });

  test('rejects a stale revision for saves and restores without overwriting external edits', async () => {
    const { workspaceRoot, service } = await fixture();
    await writeFile(path.join(workspaceRoot, 'draft.txt'), 'first');
    const original = await service.readFile('draft.txt');
    const entry = (await service.list('draft.txt'))[0]!;
    await writeFile(path.join(workspaceRoot, 'draft.txt'), 'external edit');
    const save = await service.writeFile({ path: 'draft.txt', expectedRevision: original.file.revision, content: 'stale edit' });
    expect(save.status).toBe('conflict');
    const restored = await service.restore({ path: 'draft.txt', expectedRevision: original.file.revision, id: entry.id });
    expect(restored.status).toBe('conflict');
    expect(await readFile(path.join(workspaceRoot, 'draft.txt'), 'utf8')).toBe('external edit');
    expect((await service.list('draft.txt')).some((item) => item.reason === 'restored')).toBe(false);
  });

  test('captures batch originals and writes only after the whole batch passes its revision guards', async () => {
    const { workspaceRoot, service } = await fixture();
    await writeFile(path.join(workspaceRoot, 'one.txt'), 'one');
    await writeFile(path.join(workspaceRoot, 'two.txt'), 'two');
    const first = await service.readFile('one.txt');
    const second = await service.readFile('two.txt');
    const request = { files: [
      { path: 'one.txt', expectedRevision: first.file.revision, content: 'ONE' },
      { path: 'two.txt', expectedRevision: second.file.revision, content: 'TWO' },
    ] };
    const written = await service.writeFiles(request);
    expect(written.status).toBe('written');
    for (const name of ['one.txt', 'two.txt']) expect((await service.list(name)).length).toBe(2);
    expect((await service.writeFiles(request)).status).toBe('conflict');
    for (const name of ['one.txt', 'two.txt']) expect((await service.list(name)).length).toBe(2);
  });

  test('coalesces external events, ignores dependency churn, and rechecks tracked paths on overflow', async () => {
    const { workspaceRoot, service } = await fixture();
    await mkdir(path.join(workspaceRoot, 'node_modules'));
    await writeFile(path.join(workspaceRoot, 'node_modules', 'package.txt'), 'dependency');
    await writeFile(path.join(workspaceRoot, 'known.txt'), 'baseline');
    await service.readFile('known.txt');
    await writeFile(path.join(workspaceRoot, 'known.txt'), 'changed externally');
    await writeFile(path.join(workspaceRoot, 'new.txt'), 'new external file');
    const events = Array.from({ length: 10 }, () => service.captureChanged({
      paths: ['new.txt', 'node_modules/package.txt', 'missing.txt'], overflow: true,
    }));
    await Promise.all(events);
    expect((await service.list('new.txt')).map((entry) => entry.reason)).toEqual(['external']);
    expect((await service.list('known.txt')).map((entry) => entry.reason)).toEqual(['external', 'opened']);
    expect(await service.list('node_modules/package.txt')).toEqual([]);
  });

  test('captures explicitly opened dependency files but excludes their passive changes', async () => {
    const { workspaceRoot, service } = await fixture();
    await mkdir(path.join(workspaceRoot, 'node_modules'));
    await writeFile(path.join(workspaceRoot, 'node_modules', 'example.txt'), 'first');
    await service.readFile('node_modules/example.txt');
    await writeFile(path.join(workspaceRoot, 'node_modules', 'example.txt'), 'external');
    await service.captureChanged({ paths: ['node_modules/example.txt'], overflow: true });
    expect((await service.list('node_modules/example.txt')).length).toBe(1);
  });

  test('unsupported files can be opened without creating unusable history snapshots', async () => {
    const { workspaceRoot, service } = await fixture();
    await writeFile(path.join(workspaceRoot, 'binary.bin'), Buffer.from([0, 1, 2]));
    await writeFile(path.join(workspaceRoot, 'large.txt'), 'a'.repeat(1_048_577));
    await writeFile(path.join(workspaceRoot, 'image.svg'), '<svg/>');
    for (const name of ['binary.bin', 'large.txt', 'image.svg']) {
      expect((await service.readFile(name)).content).toBeNull();
      expect(await service.list(name)).toEqual([]);
    }
  });

  test('rejects traversal, Git metadata, cross-file IDs, and escaped symbolic links', async () => {
    const { directory, workspaceRoot, service } = await fixture();
    await writeFile(path.join(workspaceRoot, 'one.txt'), 'one');
    await writeFile(path.join(workspaceRoot, 'two.txt'), 'two');
    await service.readFile('one.txt');
    const entry = (await service.list('one.txt'))[0]!;
    await writeFile(path.join(directory, 'outside.txt'), 'outside');
    await createSymbolicLink(path.join(directory, 'outside.txt'), path.join(workspaceRoot, 'escape.txt'));
    await expectFailure(service.list('../outside.txt'), /escapes/);
    await expectFailure(service.list('.git/config'), /Git metadata/);
    await expectFailure(service.read('one.txt', '../../outside'), /ID/);
    await expectFailure(service.read('two.txt', entry.id), /no longer available/);
    await expectFailure(service.readFile('escape.txt'), /Symbolic links/);
    await expectFailure(service.restore({ path: 'one.txt', id: entry.id } as LocalHistoryRestoreRequest), /request is invalid/);
  });

  test('ordinary saves still succeed when history storage fails, and history view reports the failure', async () => {
    const { workspaceRoot, service, errors } = await fixture({ invalidDirectory: true });
    await writeFile(path.join(workspaceRoot, 'draft.txt'), 'original');
    const original = await service.readFile('draft.txt');
    const written = await service.writeFile({ path: 'draft.txt', expectedRevision: original.file.revision, content: 'saved' });
    expect(written.status).toBe('written');
    expect(await readFile(path.join(workspaceRoot, 'draft.txt'), 'utf8')).toBe('saved');
    expect(errors.length).toBeGreaterThan(0);
    await expectFailure(service.list('draft.txt'), /ENOTDIR|EEXIST/);
  });

  test('restoration is refused when its predecessor cannot fit in history', async () => {
    const { workspaceRoot, service, errors } = await fixture({ maxBytes: 600 });
    await writeFile(path.join(workspaceRoot, 'draft.txt'), 'original');
    await service.readFile('draft.txt');
    const entry = (await service.list('draft.txt'))[0]!;
    const large = 'replacement'.repeat(100);
    await writeFile(path.join(workspaceRoot, 'draft.txt'), large);
    const current = await readWorkspaceFile(workspaceRoot, 'draft.txt');
    await expectFailure(service.restore({ path: 'draft.txt', id: entry.id, expectedRevision: current.file.revision }), /storage budget/);
    expect(await readFile(path.join(workspaceRoot, 'draft.txt'), 'utf8')).toBe(large);
    expect(errors.length).toBe(1);
  });

  test('refuses restore when each version fits separately but retaining undo alongside it exceeds quota', async () => {
    const { workspaceRoot, service } = await fixture({ maxBytes: 450 });
    await writeFile(path.join(workspaceRoot, 'draft.txt'), 'original');
    await service.readFile('draft.txt');
    const entry = (await service.list('draft.txt'))[0]!;
    await writeFile(path.join(workspaceRoot, 'draft.txt'), 'current');
    const current = await readWorkspaceFile(workspaceRoot, 'draft.txt');
    await expectFailure(service.restore({ path: 'draft.txt', id: entry.id, expectedRevision: current.file.revision }), /recovery version.*storage budget/);
    expect(await readFile(path.join(workspaceRoot, 'draft.txt'), 'utf8')).toBe('current');
  });

  test('drains queued capture on dispose and reopens durable history', async () => {
    const { workspaceRoot, historyDirectory, service } = await fixture();
    await writeFile(path.join(workspaceRoot, 'draft.txt'), 'external');
    const pending = service.captureChanged({ paths: ['draft.txt'], overflow: false });
    await service.dispose();
    await pending;
    const reopened = new LocalHistoryService({ workspaceRoot, directory: historyDirectory });
    cleanups.push(() => reopened.dispose());
    const entries = await reopened.list('draft.txt');
    expect(entries.length).toBe(1);
    expect((await reopened.read('draft.txt', entries[0]!.id)).content).toBe('external');
    await expectFailure(service.readFile('draft.txt'), /closed/);
  });
});
