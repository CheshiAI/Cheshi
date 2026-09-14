import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import type { WorkspaceFileReadResult } from '../frontend/src/cheshiDesktop';
import type { WorkspaceTab } from '../frontend/src/features/editor/workspaceEditorModel';
import { captureWorkspaceEditorSession, restoreWorkspaceEditorSession } from '../frontend/src/features/editor/workspaceEditorSession';
import type { useWorkspaceEditorSession } from '../frontend/src/features/editor/useWorkspaceEditorSession';
import type { WorkspaceEditorSession } from '../shared/workspace-editor-session';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
async function settle() { await new Promise<void>(resolve => setImmediate(resolve)); }
function response(path: string, content = 'latest disk contents'): WorkspaceFileReadResult {
  return {
    file: { path, name: path, kind: 'file', fileKind: 'text', size: content.length,
      modifiedAt: 42, revision: 'latest', hasBom: false, lineEnding: 'lf' },
    content, dataUrl: null,
  };
}
function tab(path: string): WorkspaceTab {
  const read = response(path);
  return { path, file: read.file, previewDataUrl: null, sourceExcerpt: null,
    savedContent: 'old saved content', draftContent: 'unsaved draft', conflictMessage: null, loadGeneration: 1 };
}
function session(paths = ['a.ts', 'b.ts'], selectedPath: string | null = paths[0] ?? null): WorkspaceEditorSession {
  return { version: 1, paths, selectedPath };
}

describe('workspace editor session snapshots', () => {
  test('captures ordered paths and selection without persisting source text or unsaved drafts', () => {
    expect(captureWorkspaceEditorSession([tab('b.ts'), tab('a.ts')], 'a.ts')).toEqual(session(['b.ts', 'a.ts'], 'a.ts'));
    expect(captureWorkspaceEditorSession([tab('b.ts')], 'missing.ts')).toEqual(session(['b.ts']));
    expect(captureWorkspaceEditorSession([], 'missing.ts')).toEqual(session([]));
  });

  test('restores tab order and selected path despite out-of-order disk reads using current file contents', async () => {
    const first = createDeferred<WorkspaceFileReadResult>();
    const second = createDeferred<WorkspaceFileReadResult>();
    let generation = 8;
    const restored = restoreWorkspaceEditorSession(session(['a.ts', 'b.ts'], 'b.ts'),
      path => path === 'a.ts' ? first.promise : second.promise, () => ++generation);
    second.resolve(response('b.ts', 'new\r\ncontent\r'));
    first.resolve(response('a.ts', 'changed externally'));
    const result = await restored;
    expect(result.tabs.map(value => value.path)).toEqual(['a.ts', 'b.ts']);
    expect(result.selectedPath).toBe('b.ts');
    expect(result.tabs[1]).toMatchObject({ savedContent: 'new\ncontent\n', draftContent: 'new\ncontent\n', file: { revision: 'latest' } });
    expect(result.tabs[0]?.savedContent).toBe('changed externally');
    expect(new Set(result.tabs.map(value => value.loadGeneration)).size).toBe(2);
  });

  test('skips deleted or inaccessible files and falls back when the selected file disappeared', async () => {
    const result = await restoreWorkspaceEditorSession(session(['deleted.ts', 'kept.ts'], 'deleted.ts'), async path => {
      if (path === 'deleted.ts') throw new Error('ENOENT');
      return response(path);
    }, () => 1);
    expect(result.tabs.map(value => value.path)).toEqual(['kept.ts']);
    expect(result.selectedPath).toBe('kept.ts');
    const empty = await restoreWorkspaceEditorSession(session(['deleted.ts']), async () => { throw new Error('ENOENT'); }, () => 1);
    expect(empty).toEqual({ tabs: [], selectedPath: null });
  });

  test('restores image and binary metadata without treating them as editable text', async () => {
    const result = await restoreWorkspaceEditorSession(session(['photo.png', 'archive.zip']), async path => ({
      ...response(path), file: { ...response(path).file, fileKind: path.endsWith('.png') ? 'image' : 'binary' },
      content: null, dataUrl: path.endsWith('.png') ? 'data:image/png;base64,AA==' : null,
    }), () => 1);
    expect(result.tabs[0]).toMatchObject({ previewDataUrl: 'data:image/png;base64,AA==', draftContent: '', file: { fileKind: 'image' } });
    expect(result.tabs[1]).toMatchObject({ previewDataUrl: null, draftContent: '', file: { fileKind: 'binary' } });
  });
});

const source = ts.transpileModule(readFileSync(new URL('../frontend/src/features/editor/useWorkspaceEditorSession.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
type Options = Parameters<typeof useWorkspaceEditorSession>[0];
interface Effect { deps: unknown[]; cleanup?: () => void }
function harness(initial: WorkspaceTab[] = [], initialRatio?: number) {
  const split = initialRatio === undefined ? null : { ratio: initialRatio, restore: (ratio: number) => { split!.ratio = ratio; } };
  const state: unknown[] = [];
  const effects = new Map<number, Effect>();
  const pending: (() => void)[] = [];
  const startup = createDeferred<WorkspaceEditorSession | null>();
  const disk = new Map<string, ReturnType<typeof createDeferred<WorkspaceFileReadResult>>>();
  const calls = { writes: [] as WorkspaceEditorSession[], errors: [] as string[], replacements: 0, selections: 0, stateWrites: 0 };
  let index = 0;
  const options: Options = {
    tabs: initial, selectedPath: initial[0]?.path ?? null, tabsRef: { current: initial },
    selectedPathRef: { current: initial[0]?.path ?? null }, nextTabGeneration: { current: 1 },
    replaceTabs(update) { options.tabsRef.current = update(options.tabsRef.current); calls.replacements++; },
    selectPath(path) { options.selectedPathRef.current = path; calls.selections++; },
    onError(message) { calls.errors.push(message); },
  };
  const react = {
    useContext: () => split,
    useState(initialValue: unknown) {
      const slot = index++;
      if (!(slot in state)) state[slot] = initialValue;
      return [state[slot], (value: unknown) => { state[slot] = value; calls.stateWrites++; }];
    },
    useRef(initialValue: unknown) {
      const slot = index++;
      if (!(slot in state)) state[slot] = { current: initialValue };
      return state[slot];
    },
    useEffect(callback: () => void | (() => void), deps: unknown[]) {
      const slot = index++;
      const previous = effects.get(slot);
      if (previous && deps.length === previous.deps.length && deps.every((value, offset) => Object.is(value, previous.deps[offset]))) return;
      pending.push(() => { previous?.cleanup?.(); effects.set(slot, { deps, cleanup: callback() || undefined }); });
    },
  };
  const modules: Record<string, unknown> = {
    react,
    '../../cheshiDesktop': { cheshiDesktop: {
      editorSession: { read: () => startup.promise, write: async (value: WorkspaceEditorSession) => { calls.writes.push(value); } },
      readWorkspaceFile(path: string) { const read = createDeferred<WorkspaceFileReadResult>(); disk.set(path, read); return read.promise; },
    } },
    '../../shared/errorMessage': { errorMessage: (reason: Error) => reason.message },
    './workspaceEditorSession': { captureWorkspaceEditorSession, restoreWorkspaceEditorSession },
    '../../shared/ui/workspaceSplitRatioContext': { WorkspaceSplitRatioContext: {} },
  };
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(source, { exports, require(name: string) { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; } });
  const hook = exports.useWorkspaceEditorSession as typeof useWorkspaceEditorSession;
  return {
    calls, startup, disk, options, split,
    render() {
      index = 0;
      options.tabs = options.tabsRef.current;
      options.selectedPath = options.selectedPathRef.current;
      hook(options);
      for (const effect of pending.splice(0)) effect();
    },
    unmount() { for (const effect of effects.values()) effect.cleanup?.(); effects.clear(); },
  };
}

describe('workspace editor startup persistence', () => {
  test('restores the split preference before saving and saves subsequent resizing with the tabs', async () => {
    const app = harness([], 0.5);
    app.render();
    expect(app.calls.writes).toEqual([]);
    app.startup.resolve({ ...session(['a.ts']), splitRatio: 0.67 });
    await settle();
    app.disk.get('a.ts')!.resolve(response('a.ts'));
    await settle(); app.render();
    expect(app.split?.ratio).toBe(0.67);
    expect(app.calls.writes).toEqual([{ ...session(['a.ts']), splitRatio: 0.67 }]);
    app.split!.ratio = 0.73;
    app.render();
    expect(app.calls.writes.at(-1)).toEqual({ ...session(['a.ts']), splitRatio: 0.73 });
    app.options.tabsRef.current = [];
    app.options.selectedPathRef.current = null;
    app.render();
    expect(app.calls.writes.at(-1)).toEqual({ ...session([]), splitRatio: 0.73 });
    app.unmount();
  });

  test('restores legacy sessions at half width and does not restore after unmount', async () => {
    const app = harness([], 0.5);
    app.render(); app.startup.resolve(session([])); await settle(); app.render();
    expect(app.split?.ratio).toBe(0.5);
    expect(app.calls.writes.at(-1)?.splitRatio).toBe(0.5);
    app.unmount();
    const closed = harness([], 0.5);
    closed.render(); closed.unmount();
    closed.startup.resolve({ ...session([]), splitRatio: 0.8 });
    await settle();
    expect(closed.split?.ratio).toBe(0.5);
    expect(closed.calls.writes).toEqual([]);
  });

  test('waits for restoration before saving so the initially empty UI cannot erase saved tabs', async () => {
    const app = harness(); app.render(); app.render();
    expect(app.calls.writes).toEqual([]);
    app.startup.resolve(session(['a.ts'])); await settle(); app.render();
    expect(app.calls.writes).toEqual([]);
    app.disk.get('a.ts')!.resolve(response('a.ts')); await settle(); app.render();
    expect(app.options.tabsRef.current.map(value => value.path)).toEqual(['a.ts']);
    expect(app.calls.writes).toEqual([session(['a.ts'])]);
    app.unmount();
  });

  for (const change of ['navigation', 'new tab', 'closed tabs', 'update recovery'] as const) {
    test(`late startup does not overwrite ${change}`, async () => {
      const app = harness([tab('current.ts'), tab('other.ts')]); app.render();
      app.startup.resolve(session(['old.ts'])); await settle();
      if (change === 'navigation') app.options.selectedPathRef.current = 'other.ts';
      else {
        app.options.tabsRef.current = change === 'closed tabs' ? [] : [tab(change === 'new tab' ? 'new.ts' : 'recovered.ts')];
        app.options.selectedPathRef.current = app.options.tabsRef.current[0]?.path ?? null;
      }
      const expected = captureWorkspaceEditorSession(app.options.tabsRef.current, app.options.selectedPathRef.current);
      app.render(); app.disk.get('old.ts')!.resolve(response('old.ts')); await settle(); app.render();
      expect(app.calls.replacements).toBe(0);
      expect(app.calls.selections).toBe(0);
      expect(app.calls.writes).toEqual([expected]);
      app.unmount();
    });
  }

  test('closing the last tab persists an empty session', async () => {
    const app = harness(); app.render(); app.startup.resolve(session([])); await settle(); app.render();
    expect(app.calls.writes).toEqual([session([])]);
    app.options.tabsRef.current = [tab('a.ts')]; app.options.selectedPathRef.current = 'a.ts'; app.render();
    app.options.tabsRef.current = []; app.options.selectedPathRef.current = null; app.render();
    expect(app.calls.writes.at(-1)).toEqual(session([]));
    app.unmount();
  });

  test('cleanup ignores pending disk reads and does not update state or save', async () => {
    const app = harness(); app.render(); app.startup.resolve(session(['a.ts'])); await settle();
    app.unmount(); app.disk.get('a.ts')!.resolve(response('a.ts')); await settle();
    expect(app.calls).toEqual({ writes: [], errors: [], replacements: 0, selections: 0, stateWrites: 0 });
  });

  test('a failed session read reports the error without overwriting saved state', async () => {
    const app = harness(); app.render(); app.startup.reject(new Error('Permission denied')); await settle(); app.render();
    expect(app.calls.errors).toEqual(['Could not restore editor tabs: Permission denied']);
    expect(app.calls.writes).toEqual([]);
    app.unmount();
  });
});
