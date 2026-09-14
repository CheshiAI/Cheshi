import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { formatWorkspaceStorage, workspaceStorageLabels, STORAGE_REFRESH_MS } from '../frontend/src/features/shell/workspaceStorageModel';
import type { observeWorkspaceStorage } from '../frontend/src/features/shell/workspaceStorageModel';
import type { WorkspaceDiskUsage } from '../shared/workspace-disk-usage';

const usage: WorkspaceDiskUsage = { workspaceBytes: 2_450_000_000, totalBytes: 2_000_000_000_000, measuredAt: 1 };

test('uses decimal MB below one GB and GB from one GB', () => {
  expect(formatWorkspaceStorage(512_000_000)).toBe('512 MB');
  expect(formatWorkspaceStorage(999_000_000)).toBe('999 MB');
  expect(formatWorkspaceStorage(1_000_000_000)).toBe('1 GB');
  expect(formatWorkspaceStorage(2_450_000_000)).toBe('2.45 GB');
  expect(formatWorkspaceStorage(0)).toBe('0 MB');
  expect(formatWorkspaceStorage(512)).toBe('0.01 MB');
});

test('percentage uses the whole drive, and small nonzero values never display zero', () => {
  expect(workspaceStorageLabels(usage).percent).toBe('0.12%');
  expect(workspaceStorageLabels({ ...usage, workspaceBytes: 1_000_000 }).percent).toBe('0.01%');
  expect(workspaceStorageLabels({ ...usage, workspaceBytes: 0 }).percent).toBe('0%');
  expect(workspaceStorageLabels(usage).title).toContain('2,000 GB');
});

function observerHarness(read: () => Promise<WorkspaceDiskUsage>) {
  let now = 0;
  let next = 0;
  const timers = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  const listeners = new Set<() => void>();
  const document = { visibilityState: 'visible',
    addEventListener: (_name: string, callback: () => void) => listeners.add(callback),
    removeEventListener: (_name: string, callback: () => void) => listeners.delete(callback) };
  const window = {
    setTimeout: (callback: () => void) => { timers.set(++next, callback); return next; },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (callback: () => void) => { intervals.set(++next, callback); return next; },
    clearInterval: (id: number) => intervals.delete(id),
  };
  const source = readFileSync(new URL('../frontend/src/features/shell/workspaceStorageModel.ts', import.meta.url), 'utf8');
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } }).outputText, { exports, window, document, Date: { now: () => now } });
  const values: Array<WorkspaceDiskUsage | null> = [];
  const close = (exports.observeWorkspaceStorage as typeof observeWorkspaceStorage)(read, value => values.push(value));
  return { values, close, timers, intervals, listeners,
    setTime: (value: number) => { now = value; },
    setHidden: (hidden: boolean) => { document.visibilityState = hidden ? 'hidden' : 'visible'; },
    tick: () => { for (const callback of intervals.values()) callback(); },
    visible: () => { for (const callback of listeners) callback(); },
    start: () => { for (const callback of timers.values()) callback(); timers.clear(); },
  };
}

function createDeferred() {
  let resolve!: (value: WorkspaceDiskUsage) => void;
  const promise = new Promise<WorkspaceDiskUsage>(done => { resolve = done; });
  return { promise, resolve };
}

test('delays the first scan, throttles refreshes and ignores results after disposal', async () => {
  let calls = 0;
  const deferred = createDeferred();
  const h = observerHarness(() => { calls++; return deferred.promise; });
  expect(calls).toBe(0);
  h.start(); h.visible(); h.tick();
  expect(calls).toBe(1);
  h.setTime(STORAGE_REFRESH_MS * 2); h.tick();
  expect(calls).toBe(1);
  h.close(); deferred.resolve(usage); await deferred.promise;
  expect(h.values).toEqual([]);
  expect(h.intervals.size + h.timers.size + h.listeners.size).toBe(0);
});

test('skips hidden windows and refreshes stale data when visible again', async () => {
  let calls = 0;
  const h = observerHarness(async () => { calls++; return usage; });
  h.setHidden(true); h.start();
  expect(calls).toBe(0);
  h.setHidden(false); h.visible(); await Promise.resolve();
  expect(h.values).toEqual([usage]);
  h.visible(); h.tick(); expect(calls).toBe(1);
  h.setTime(STORAGE_REFRESH_MS); h.setHidden(true); h.tick(); expect(calls).toBe(1);
  h.setHidden(false); h.visible(); await Promise.resolve(); expect(calls).toBe(2);
  h.close();
});

test('reports scan failure as unavailable and allows a later retry', async () => {
  let calls = 0;
  const h = observerHarness(async () => { if (++calls === 1) throw new Error('Drive disconnected'); return usage; });
  h.start(); await Promise.resolve(); expect(h.values).toEqual([null]);
  h.setTime(STORAGE_REFRESH_MS); h.tick(); await Promise.resolve(); expect(h.values).toEqual([null, usage]);
  h.close();
});
