import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import type { useEditorSession } from '../frontend/src/features/editor/useEditorSession';
import type { useAppUpdateResume } from '../frontend/src/features/shell/useAppUpdateResume';
import type { EditorSession, EditorSessionMode } from '../shared/editor-session';
import type { WorkspaceFileReadResult } from '../frontend/src/cheshiDesktop';
import * as sessions from '../frontend/src/features/editor/workspaceEditorSession';
import { createUpdateResumeCoordinator, resumeRecord } from '../frontend/src/features/shell/updateWorkspaceResume';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function harness<T>(file: string, name: string, modules: Record<string, unknown>) {
  const slots: unknown[] = [];
  const dependencies: unknown[][] = [];
  const pending: (() => void)[] = [];
  let cursor = 0;
  let effectIndex = 0;
  const react = {
    useRef(current: unknown) { return slots[cursor++] ??= { current }; },
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: unknown) => { slots[index] = value; }];
    },
    useEffect(run: () => void, deps: unknown[]) {
      const index = effectIndex++;
      const previous = dependencies[index];
      if (previous && previous.length === deps.length && deps.every((value, i) => Object.is(value, previous[i]))) return;
      dependencies[index] = deps;
      pending.push(run);
    },
  };
  const exports: Record<string, unknown> = {};
  const source = readFileSync(new URL(`../frontend/src/features/${file}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } });
  vm.runInNewContext(compiled.outputText, { exports, require: (id: string) => {
    if (id === 'react') return react;
    if (!Object.hasOwn(modules, id)) throw new Error(`Unexpected dependency ${id}`);
    return modules[id];
  } });
  return { render<R>(run: (hook: T) => R) {
    cursor = 0; effectIndex = 0;
    const result = run(exports[name] as T);
    pending.splice(0).forEach(effect => effect());
    return result;
  } };
}

const file: WorkspaceFileReadResult = { file: { path: 'a.ts', name: 'a.ts', kind: 'file', fileKind: 'text',
  size: 1, modifiedAt: 1, revision: 'r', hasBom: false, lineEnding: 'lf' }, content: 'saved', dataUrl: null };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function sessionHarness(mode: EditorSessionMode = 'waiting') {
  const saved = createDeferred<EditorSession | null>();
  const saves: EditorSession[] = [];
  let reads = 0;
  let revealed = 0;
  const errors: string[] = [];
  const options: Parameters<typeof useEditorSession>[0] = {
    mode, tabs: [], selectedPath: null, nextTabGeneration: { current: 0 },
    replaceTabs(update) { options.tabs = update(options.tabs); },
    selectPath(path) { options.selectedPath = path; },
    onSessionRestored() { revealed++; }, onError(message) { errors.push(message); },
  };
  const hook = harness<typeof useEditorSession>('editor/useEditorSession.ts', 'useEditorSession', {
    '../../cheshiDesktop': { cheshiDesktop: {
      editorSession: { read() { reads++; return saved.promise; }, async save(value: EditorSession) { saves.push(value); } },
      async readWorkspaceFile() { return file; },
    } },
    './workspaceEditorSession': sessions,
  });
  return { options, saved, saves, errors, reads: () => reads, revealed: () => revealed,
    render: () => hook.render(use => use(options)) };
}

test('waits for update recovery and disk restoration before persisting any initial empty state', async () => {
  const app = sessionHarness();
  expect(app.render()).toBe(false);
  await tick();
  expect(app.reads()).toBe(0);
  expect(app.saves).toEqual([]);
  app.options.mode = 'restore';
  app.render();
  expect(app.reads()).toBe(1);
  app.render();
  expect(app.saves).toEqual([]);
  app.saved.resolve({ version: 1, paths: ['a.ts'], selectedPath: 'a.ts' });
  await tick();
  expect(app.render()).toBe(true);
  expect(app.options.tabs[0]?.path).toBe('a.ts');
  expect(app.revealed()).toBe(1);
  expect(app.saves).toEqual([{ version: 1, paths: ['a.ts'], selectedPath: 'a.ts' }]);
  app.options.tabs[0]!.draftContent = 'unsaved edits';
  app.render();
  expect(app.saves).toHaveLength(1);
  app.options.tabs = [];
  app.options.selectedPath = null;
  app.render();
  expect(app.saves.at(-1)).toEqual({ version: 1, paths: [], selectedPath: null });
  expect(app.errors).toEqual([]);
});

test('preserves update-restored drafts and an explicitly empty update session over older disk metadata', async () => {
  for (const hasTabs of [true, false]) {
    const app = sessionHarness('preserve');
    if (hasTabs) {
      app.options.tabs = (await sessions.restoreEditorSession({ version: 1, paths: ['a.ts'], selectedPath: 'a.ts' }, async () => file, () => 1)).tabs;
      app.options.tabs[0]!.draftContent = 'update draft';
      app.options.selectedPath = 'a.ts';
    }
    app.render();
    await tick();
    expect(app.render()).toBe(true);
    expect(app.reads()).toBe(0);
    expect(app.options.tabs[0]?.draftContent).toBe(hasTabs ? 'update draft' : undefined);
    expect(app.revealed()).toBe(hasTabs ? 1 : 0);
    expect(app.saves[0]?.paths).toEqual(hasTabs ? ['a.ts'] : []);
  }
});

test('a failed update recovery allows file use without overwriting saved metadata', async () => {
  const app = sessionHarness('blocked');
  app.render();
  expect(app.render()).toBe(true);
  await tick();
  expect(app.reads()).toBe(0);
  expect(app.saves).toEqual([]);
});

test('app update recovery selects normal restore or update preservation only after restoration completes', async () => {
  for (const update of [false, true]) {
    const coordinator = createUpdateResumeCoordinator();
    const restored = createDeferred<void>();
    coordinator.register('editor', { capture() {}, restore: () => restored.promise });
    const snapshot = update ? { schemaVersion: 1, workspaceRoot: '/workspace', createdAt: Date.now(), sections: { editor: {} } } : null;
    const hook = harness<typeof useAppUpdateResume>('shell/useAppUpdateResume.ts', 'useAppUpdateResume', {
      '../../cheshiDesktop': { cheshiDesktop: {
        workspaceRoot: '/workspace', async getUpdateResume() { return snapshot; }, async saveUpdateResume() {},
        onPrepareAppUpdate: () => () => {}, async acknowledgeAppUpdate() {}, onAppUpdateCommitted: () => () => {},
        onAppUpdatePreparationCancelled: () => () => {}, async clearUpdateResume() {},
      } },
      './updateWorkspaceResume': { updateResumeCoordinator: coordinator, resumeRecord },
    });
    const render = () => hook.render(use => use({ activeView: 'chat', rightSidebarOpen: true, blockedReason: null,
      setActiveView() {}, setRightSidebarOpen() {} }));
    expect(render().editorSessionMode).toBe('waiting');
    await tick();
    if (update) expect(render().editorSessionMode).toBe('waiting');
    restored.resolve();
    await tick();
    expect(render().editorSessionMode).toBe(update ? 'preserve' : 'restore');
  }
});
