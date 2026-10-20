import { describe, expect, test } from 'bun:test';

import type { WorkspaceFileReadResult, WorkspaceFileWriteResult } from '../frontend/src/cheshiDesktop';
import { localHistoryDiff } from '../frontend/src/features/editor/localHistoryDiff';
import { LocalHistoryModel, type LocalHistoryState } from '../frontend/src/features/editor/localHistoryModel';
import type { LocalHistoryEntry, LocalHistoryRestoreRequest, LocalHistorySnapshot } from '../shared/local-history';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

const entry = (id: string): LocalHistoryEntry => ({
  id, path: 'file.txt', createdAt: 1_700_000_000_000, reason: 'saved', size: 3,
});
const snapshot = (id: string): LocalHistorySnapshot => ({
  entry: entry(id), content: id, hasBom: false, lineEnding: 'lf',
});
const currentFile = (revision = 'disk-v1'): WorkspaceFileReadResult => ({
  file: {
    path: 'file.txt', name: 'file.txt', kind: 'file', fileKind: 'text', size: 3,
    modifiedAt: 1_700_000_000_001, revision, hasBom: false, lineEnding: 'lf',
  },
  content: revision, dataUrl: null,
});

function fixture() {
  const restoreCalls: LocalHistoryRestoreRequest[] = [];
  const api = {
    localHistory: {
      list: async (_path: string): Promise<LocalHistoryEntry[]> => [entry('newer'), entry('older')],
      read: async (_path: string, id: string): Promise<LocalHistorySnapshot> => snapshot(id),
      restore: async (request: LocalHistoryRestoreRequest): Promise<WorkspaceFileWriteResult> => {
        restoreCalls.push(request);
        return { status: 'written', file: currentFile('restored').file };
      },
    },
    readWorkspaceFile: async (_path: string): Promise<WorkspaceFileReadResult> => currentFile(),
  };
  return { api, restoreCalls, model: new LocalHistoryModel('file.txt', api) };
}

describe('local history dialog model', () => {
  test('late refreshes cannot replace a newer current file or history selection', async () => {
    const { api, model } = fixture();
    const oldFile = createDeferred<WorkspaceFileReadResult>();
    let fileCalls = 0;
    api.localHistory.list = async () => [entry('latest')];
    api.readWorkspaceFile = async () => ++fileCalls === 1 ? oldFile.promise : currentFile('disk-v2');
    const first = model.refresh();
    await model.refresh();
    oldFile.resolve(currentFile('disk-v1'));
    await first;
    expect(model.getSnapshot().selectedId).toBe('latest');
    expect(model.getSnapshot().snapshot?.entry.id).toBe('latest');
    expect(model.getSnapshot().current?.file.revision).toBe('disk-v2');
  });

  test('reading the baseline finishes before listing versions of an unopened file', async () => {
    const { api, model } = fixture();
    let recorded = false;
    api.readWorkspaceFile = async () => {
      recorded = true;
      return currentFile();
    };
    api.localHistory.list = async () => recorded ? [entry('baseline')] : [];
    await model.refresh();
    expect(model.getSnapshot().snapshot?.entry.id).toBe('baseline');
  });

  test('a stale history listing cannot overwrite a completed refresh', async () => {
    const { api, model } = fixture();
    const oldList = createDeferred<LocalHistoryEntry[]>();
    const listStarted = createDeferred<void>();
    let calls = 0;
    api.localHistory.list = async () => {
      if (++calls !== 1) return [entry('latest')];
      listStarted.resolve();
      return oldList.promise;
    };
    const first = model.refresh();
    await listStarted.promise;
    await model.refresh();
    oldList.resolve([entry('obsolete')]);
    await first;
    expect(model.getSnapshot().snapshot?.entry.id).toBe('latest');
  });

  test('rapid selection keeps the latest requested snapshot', async () => {
    const { api, model } = fixture();
    await model.refresh();
    const oldRead = createDeferred<LocalHistorySnapshot>();
    api.localHistory.read = async (_path, id) => id === 'older' ? oldRead.promise : snapshot(id);
    const older = model.select('older');
    await model.select('newer');
    oldRead.resolve(snapshot('older'));
    await older;
    expect(model.getSnapshot().snapshot?.entry.id).toBe('newer');
  });

  test('refresh retains the selected version and falls back if retention removes it', async () => {
    const { api, model } = fixture();
    await model.refresh();
    await model.select('older');
    await model.refresh();
    expect(model.getSnapshot().selectedId).toBe('older');
    api.localHistory.list = async () => [entry('newer')];
    await model.refresh();
    expect(model.getSnapshot().selectedId).toBe('newer');
    expect(model.getSnapshot().snapshot?.entry.id).toBe('newer');
  });

  test('refresh keeps the selected snapshot visible without rereading it and updates the disk comparison', async () => {
    const { api, model, restoreCalls } = fixture();
    await model.refresh();
    await model.select('older');
    const cached = model.getSnapshot().snapshot;
    const disk = createDeferred<WorkspaceFileReadResult>();
    const listing = createDeferred<LocalHistoryEntry[]>();
    const listStarted = createDeferred<void>();
    let reads = 0;
    api.localHistory.read = async (_path, id) => { reads += 1; return snapshot(id); };
    api.readWorkspaceFile = async () => disk.promise;
    api.localHistory.list = async () => { listStarted.resolve(); return listing.promise; };
    const observed: LocalHistoryState[] = [];
    const unsubscribe = model.subscribe(() => observed.push(model.getSnapshot()));
    const refresh = model.refresh();
    expect(model.getSnapshot().loading).toBe(true);
    expect(model.getSnapshot().snapshot).toBe(cached);
    expect(await model.restore(false)).toBeNull();
    disk.resolve(currentFile('disk-v2'));
    await listStarted.promise;
    expect(model.getSnapshot().snapshot).toBe(cached);
    listing.resolve([entry('latest'), entry('newer'), entry('older')]);
    await refresh;
    unsubscribe();
    expect(reads).toBe(0);
    expect(observed.every(state => state.snapshot === cached && !state.loadingSnapshot)).toBe(true);
    expect(model.getSnapshot().selectedId).toBe('older');
    expect(model.getSnapshot().entries[0]?.id).toBe('latest');
    expect(model.getSnapshot().current?.content).toBe('disk-v2');
    await model.restore(false);
    expect(restoreCalls[0]?.expectedRevision).toBe('disk-v2');
  });

  test('a removed selected snapshot is cleared while its replacement loads', async () => {
    const { api, model } = fixture();
    await model.refresh();
    await model.select('older');
    const pending = createDeferred<LocalHistorySnapshot>();
    const readStarted = createDeferred<void>();
    api.localHistory.list = async () => [entry('newer')];
    api.localHistory.read = async () => { readStarted.resolve(); return pending.promise; };
    const refresh = model.refresh();
    await readStarted.promise;
    expect(model.getSnapshot().selectedId).toBe('newer');
    expect(model.getSnapshot().snapshot).toBeNull();
    expect(model.getSnapshot().loadingSnapshot).toBe(true);
    expect(await model.restore(false)).toBeNull();
    pending.resolve(snapshot('newer'));
    await refresh;
    expect(model.getSnapshot().snapshot?.entry.id).toBe('newer');
    api.localHistory.list = async () => [];
    await model.refresh();
    expect(model.getSnapshot().selectedId).toBeNull();
    expect(model.getSnapshot().snapshot).toBeNull();
    expect(model.getSnapshot().loadingSnapshot).toBe(false);
  });

  test('refresh invalidates a pending selection before reloading that version', async () => {
    const { api, model } = fixture();
    await model.refresh();
    const pending = createDeferred<LocalHistorySnapshot>();
    let reads = 0;
    api.localHistory.read = async (_path, id) => ++reads === 1 ? pending.promise : snapshot(id);
    const selection = model.select('older');
    await model.refresh();
    const refreshed = model.getSnapshot().snapshot;
    expect(refreshed?.entry.id).toBe('older');
    pending.resolve({ ...snapshot('older'), content: 'stale response' });
    await selection;
    expect(model.getSnapshot().snapshot).toBe(refreshed);
    expect(model.getSnapshot().loadingSnapshot).toBe(false);
  });

  test('unsaved drafts prevent restore and saved files use the compared revision', async () => {
    const { model, restoreCalls } = fixture();
    await model.refresh();
    await model.select('older');
    expect(await model.restore(true)).toBeNull();
    expect(restoreCalls).toEqual([]);
    expect((await model.restore(false))?.status).toBe('written');
    expect(restoreCalls).toEqual([{ path: 'file.txt', id: 'older', expectedRevision: 'disk-v1' }]);
    expect(model.getSnapshot().notice).toContain('Version restored');
  });

  test('revision conflict refreshes disk contents without automatically retrying', async () => {
    const { api, model } = fixture();
    let calls = 0;
    api.localHistory.restore = async () => {
      calls += 1;
      api.readWorkspaceFile = async () => currentFile('external-v2');
      return { status: 'conflict', file: currentFile('external-v2').file };
    };
    await model.refresh();
    expect((await model.restore(false))?.status).toBe('conflict');
    expect(calls).toBe(1);
    expect(model.getSnapshot().current?.file.revision).toBe('external-v2');
    expect(model.getSnapshot().error).toContain('file changed');
  });

  test('a missing current file keeps readable history but cannot be restored', async () => {
    const { api, model, restoreCalls } = fixture();
    api.readWorkspaceFile = async () => { throw new Error('File missing'); };
    await model.refresh();
    expect(model.getSnapshot().snapshot?.entry.id).toBe('newer');
    expect(model.getSnapshot().error).toContain('File missing');
    expect(await model.restore(false)).toBeNull();
    expect(restoreCalls).toEqual([]);
  });

  test('duplicate restore clicks are serialized and failed restores leave the dialog usable', async () => {
    const { api, model } = fixture();
    const pending = createDeferred<WorkspaceFileWriteResult>();
    let calls = 0;
    api.localHistory.restore = async () => { calls += 1; return pending.promise; };
    await model.refresh();
    const first = model.restore(false);
    expect(await model.restore(false)).toBeNull();
    pending.reject(new Error('Unable to write file'));
    expect(await first).toBeNull();
    expect(calls).toBe(1);
    expect(model.getSnapshot().restoring).toBe(false);
    expect(model.getSnapshot().error).toBe('Unable to write file');
  });

  test('closing during a pending read stops updates and disposal invalidates responses', async () => {
    const { api, model } = fixture();
    const pending = createDeferred<LocalHistoryEntry[]>();
    const listStarted = createDeferred<void>();
    api.localHistory.list = async () => {
      listStarted.resolve();
      return pending.promise;
    };
    const refresh = model.refresh();
    await listStarted.promise;
    model.dispose();
    const closedState = model.getSnapshot();
    pending.resolve([entry('late')]);
    await refresh;
    expect(model.getSnapshot()).toBe(closedState);
  });
});

describe('local history comparison', () => {
  test('aligns unchanged lines after an insertion and pairs replacement lines', () => {
    const result = localHistoryDiff('first\nold\nlast', 'inserted\nfirst\nnew\nlast');
    expect(result.rows.map((row) => [row.previous?.text, row.current?.text, row.changed])).toEqual([
      [undefined, 'inserted', true], ['first', 'first', false], ['old', 'new', true], ['last', 'last', false],
    ]);
    expect(result.rows.at(-1)?.previous?.number).toBe(3);
    expect(result.rows.at(-1)?.current?.number).toBe(4);
  });

  test('represents deletion, empty files, and a changed final newline', () => {
    expect(localHistoryDiff('', '').rows).toEqual([]);
    expect(localHistoryDiff('removed', '').rows[0]?.current).toBeNull();
    expect(localHistoryDiff('line\n', 'line').rows.at(-1)).toEqual({
      previous: { text: '', number: 2 }, current: null, changed: true,
    });
    expect(localHistoryDiff('a\r\nb\r\n', 'a\nb\n').rows.every((row) => !row.changed)).toBe(true);
  });

  test('bounds heavily changed comparisons while preserving unchanged ends', () => {
    const previous = ['start', ...Array.from({ length: 1100 }, (_, index) => `old-${index}`), 'end'].join('\n');
    const current = ['start', ...Array.from({ length: 1100 }, (_, index) => `new-${index}`), 'end'].join('\n');
    const result = localHistoryDiff(previous, current);
    expect(result.simplified).toBe(true);
    expect(result.rows[0]?.changed).toBe(false);
    expect(result.rows.at(-1)?.changed).toBe(false);
    expect(result.rows.filter((row) => row.changed)).toHaveLength(1100);
  });

  test('caps rendered rows independently from the number of file lines', () => {
    const contents = Array.from({ length: 10_050 }, (_, index) => String(index)).join('\n');
    const result = localHistoryDiff(contents, contents);
    expect(result.rows).toHaveLength(10_000);
    expect(result.truncated).toBe(true);
  });
});
