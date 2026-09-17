import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createFileSearchController, handleFileSearchKeyDown, initialFileSearchState, selectedFileSearchPath, type FileSearchState } from '../frontend/src/features/navigation/fileSearchModel';
import { isFileSearchShortcut } from '../frontend/src/features/navigation/fileSearchShortcut';
import type { WorkspaceFileSearchResult } from '../shared/workspace-file-search';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('result keyboard navigation opens or closes only outside IME composition and consumes its keys', () => {
  const actions: (number | string)[] = [];
  let prevented = 0; let stopped = 0;
  const send = (key: string, isComposing = false, keyCode = 0) => handleFileSearchKeyDown({
    key, nativeEvent: { isComposing, keyCode }, preventDefault() { prevented++; }, stopPropagation() { stopped++; },
  }, { move: direction => { actions.push(direction); }, open: () => { actions.push('open'); }, close: () => { actions.push('close'); } });
  send('ArrowDown'); send('ArrowUp'); send('Enter'); send('Escape');
  expect(actions).toEqual([1, -1, 'open', 'close']);
  send('Enter', true); send('Escape', true); send('Enter', false, 229); send('F');
  expect(actions).toHaveLength(4); expect(prevented).toBe(4); expect(stopped).toBe(4);
});
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function result(...paths: string[]): WorkspaceFileSearchResult {
  return { files: paths.map(path => ({ path, name: path.split('/').at(-1)! })), truncated: false };
}

test('debounces queries, coalesces reads, rejects stale responses and prevents opening stale results', async () => {
  const requests: { query: string; deferred: ReturnType<typeof createDeferred<WorkspaceFileSearchResult>> }[] = [];
  let state: FileSearchState = initialFileSearchState;
  const controller = createFileSearchController(query => {
    const deferred = createDeferred<WorkspaceFileSearchResult>(); requests.push({ query, deferred }); return deferred.promise;
  }, value => { state = value; }, 0);
  controller.changeQuery('a'); controller.changeQuery('ab');
  await tick(); expect(requests.map(entry => entry.query)).toEqual(['ab']);
  controller.changeQuery('latest'); await tick();
  expect(requests).toHaveLength(1);
  requests[0]!.deferred.resolve(result('old.txt')); await tick();
  expect(requests).toHaveLength(2);
  expect(selectedFileSearchPath(state)).toBeNull();
  requests[1]!.deferred.resolve(result('latest.txt', 'src/latest.txt')); await tick();
  expect(selectedFileSearchPath(state)).toBe('latest.txt');
  controller.move(1); expect(selectedFileSearchPath(state)).toBe('src/latest.txt');
  controller.move(1); expect(selectedFileSearchPath(state)).toBe('latest.txt');
  controller.move(-1); expect(selectedFileSearchPath(state)).toBe('src/latest.txt');
  controller.changeQuery('next'); expect(selectedFileSearchPath(state)).toBeNull();
  controller.changeQuery(''); await tick(); expect(requests).toHaveLength(2);
  expect(state.loading).toBe(false); expect(state.result.files).toEqual([]);
  controller.dispose();
});

test('refreshes open results, handles errors and empty results, and ignores responses after disposal', async () => {
  const requests: ReturnType<typeof createDeferred<WorkspaceFileSearchResult>>[] = [];
  let state: FileSearchState = initialFileSearchState;
  const controller = createFileSearchController(() => {
    const pending = createDeferred<WorkspaceFileSearchResult>(); requests.push(pending); return pending.promise;
  }, value => { state = value; }, 0);
  controller.changeQuery('note'); await tick(); requests[0]!.resolve(result('note.txt')); await tick();
  controller.refresh(); expect(selectedFileSearchPath(state)).toBeNull();
  await tick(); requests[1]!.reject(new Error('Unavailable')); await tick();
  expect(state.error).toBe('Unavailable'); expect(selectedFileSearchPath(state)).toBeNull();
  controller.refresh(); await tick(); requests[2]!.resolve(result()); await tick();
  controller.move(1); expect(state.selectedIndex).toBe(-1); expect(state.error).toBeNull();
  controller.refresh(); await tick(); controller.dispose();
  const before = state; requests[3]!.resolve(result('late.txt')); await tick();
  expect(state).toBe(before);
});

test('uses physical Command+Shift+F and protects modifiers, repeat and IME composition', () => {
  const event = { code: 'KeyF', shiftKey: true, metaKey: true, ctrlKey: false, altKey: false,
    repeat: false, isComposing: false, keyCode: 70, defaultPrevented: false };
  expect(isFileSearchShortcut(event)).toBe(true);
  for (const change of [{ shiftKey: false }, { code: 'KeyG' }, { metaKey: false }, { ctrlKey: true },
    { altKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
    expect(isFileSearchShortcut({ ...event, ...change })).toBe(false);
  }
});

test('shortcut leaves editable targets and open dialogs alone and cleans up its listener', () => {
  class Element {
    constructor(readonly editable = false, readonly isContentEditable = false) {}
    closest() { return this.editable ? this : null; }
  }
  let listener: ((event: unknown) => void) | null = null;
  let opened = 0; let prevented = 0; let modal = false;
  const document = { activeElement: new Element(), querySelector: () => modal ? {} : null,
    addEventListener: (_name: string, fn: typeof listener) => { listener = fn; },
    removeEventListener: () => { listener = null; } };
  const source = readFileSync(new URL('../frontend/src/features/navigation/fileSearchShortcut.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } });
  const exports: { installFileSearchShortcut?: (doc: unknown, open: () => void) => () => void } = {};
  vm.runInNewContext(output.outputText, { exports, Element, HTMLElement: Element });
  const close = exports.installFileSearchShortcut!(document, () => { opened++; });
  const send = (target: Element, metaKey = true) => listener?.({ code: 'KeyF', shiftKey: true, metaKey, keyCode: 70,
    composedPath: () => [target], preventDefault() { prevented++; }, stopPropagation() {} });
  send(new Element(), false); expect(opened).toBe(0); expect(prevented).toBe(0);
  send(new Element()); expect(opened).toBe(1);
  send(new Element(true)); send(new Element(false, true)); expect(opened).toBe(1);
  document.activeElement = new Element(true); send(new Element()); expect(opened).toBe(1);
  document.activeElement = new Element(); modal = true; send(new Element()); expect(opened).toBe(1);
  expect(prevented).toBe(1); close(); expect(listener).toBeNull();
});
