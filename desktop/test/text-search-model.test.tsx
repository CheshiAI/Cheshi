import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTextSearchController, initialTextSearchState, matchLineParts, selectedTextSearchMatch, textSearchStatus,
  type TextSearchState } from '../frontend/src/features/navigation/textSearchModel';
import { isTextSearchShortcut } from '../frontend/src/features/navigation/fileSearchShortcut';
import { WorkspaceTextSearchResults } from '../frontend/src/features/navigation/WorkspaceTextSearch';
import type { WorkspaceTextSearchRequest, WorkspaceTextSearchResult } from '../shared/workspace-text-search';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function result(...lines: `${string}:${number}`[]): WorkspaceTextSearchResult {
  return { matches: lines.map(entry => {
    const [path, line] = entry.split(':');
    return { path: path!, line: Number(line), column: 1, length: 5, text: 'hello' };
  }), searchedFiles: 3, truncated: false };
}

test('debounces queries, restarts on option changes, rejects stale responses and wraps selection', async () => {
  const requests: { request: WorkspaceTextSearchRequest; deferred: ReturnType<typeof createDeferred<WorkspaceTextSearchResult>> }[] = [];
  let state: TextSearchState = initialTextSearchState;
  const controller = createTextSearchController(request => {
    const deferred = createDeferred<WorkspaceTextSearchResult>(); requests.push({ request, deferred }); return deferred.promise;
  }, value => { state = value; }, 0);
  controller.changeQuery('a'); controller.changeQuery('ab');
  await tick(); expect(requests.map(entry => entry.request)).toEqual([{ query: 'ab', caseSensitive: false, regex: false }]);
  controller.changeOptions({ regex: true }); await tick();
  expect(requests).toHaveLength(1); expect(state.loading).toBe(true);
  requests[0]!.deferred.resolve(result('old.ts:1')); await tick();
  expect(requests[1]!.request).toEqual({ query: 'ab', caseSensitive: false, regex: true });
  expect(selectedTextSearchMatch(state)).toBeNull();
  requests[1]!.deferred.resolve(result('a.ts:1', 'a.ts:9', 'b.ts:2')); await tick();
  expect(selectedTextSearchMatch(state)?.line).toBe(1);
  controller.move(-1); expect(selectedTextSearchMatch(state)).toMatchObject({ path: 'b.ts', line: 2 });
  controller.move(1); expect(selectedTextSearchMatch(state)?.line).toBe(1);
  controller.select(1); expect(selectedTextSearchMatch(state)?.line).toBe(9);
  controller.select(7); expect(selectedTextSearchMatch(state)?.line).toBe(9);
  expect(textSearchStatus(state)).toBe('3 matches in 2 files · 3 files searched');
  controller.changeQuery('   '); await tick(); expect(requests).toHaveLength(2);
  expect(state.loading).toBe(false); expect(textSearchStatus(state)).toBe('Type text to search workspace files.');
  controller.changeQuery('fail'); await tick(); requests[2]!.deferred.reject(new Error('Pattern is invalid')); await tick();
  expect(textSearchStatus(state)).toBe('Pattern is invalid'); expect(selectedTextSearchMatch(state)).toBeNull();
  controller.changeQuery('none'); await tick(); requests[3]!.deferred.resolve(result()); await tick();
  expect(textSearchStatus(state)).toBe('No matches in 3 files.');
  controller.changeQuery('late'); await tick(); controller.dispose();
  const before = state; requests[4]!.deferred.resolve(result('late.ts:1')); await tick();
  expect(state).toBe(before);
});

test('reports partial results and splits match lines around the matched text after trimming indentation', () => {
  const truncated: TextSearchState = { ...initialTextSearchState, query: 'x', result: { ...result('a.ts:1'), truncated: true } };
  expect(textSearchStatus(truncated)).toBe('1+ matches in 1 files · 3 files searched · Showing partial results. Refine your search.');
  expect(textSearchStatus({ ...initialTextSearchState, query: 'x', loading: true })).toBe('Searching…');
  expect(matchLineParts({ text: '    const hello = 1;', column: 11, length: 5 }))
    .toEqual({ before: 'const ', matched: 'hello', after: ' = 1;' });
  expect(matchLineParts({ text: '  hi', column: 1, length: 1 })).toEqual({ before: '', matched: 'h', after: 'i' });
});

test('groups results by file with counts, marks the matched span and flags the selected option', () => {
  const matches = [
    { path: 'src/a.ts', line: 3, column: 7, length: 5, text: 'const hello = 1;' },
    { path: 'src/a.ts', line: 9, column: 1, length: 5, text: 'hello();' },
    { path: 'src/b.ts', line: 1, column: 1, length: 5, text: 'hello' },
  ];
  const markup = renderToStaticMarkup(<WorkspaceTextSearchResults matches={matches} selectedIndex={1} listId="text" loading={false}
    onSelect={() => {}} onOpen={() => {}} />);
  expect(markup.match(/role="presentation"/g)?.length).toBe(2);
  expect(markup).toContain('<strong>src/a.ts</strong><span>2</span>');
  expect(markup).toContain('id="text-1" role="option" aria-selected="true"');
  expect(markup).toContain('title="src/a.ts:9:1"');
  expect(markup).toContain('const <mark>hello</mark> = 1;');
});

test('uses Cmd or Ctrl with Shift+F and protects plain Shift+F, other modifiers, repeat and IME composition', () => {
  const event = { code: 'KeyF', shiftKey: true, metaKey: true, ctrlKey: false, altKey: false,
    repeat: false, isComposing: false, keyCode: 70, defaultPrevented: false };
  expect(isTextSearchShortcut(event)).toBe(true);
  expect(isTextSearchShortcut({ ...event, metaKey: false, ctrlKey: true })).toBe(true);
  for (const change of [{ metaKey: false }, { ctrlKey: true }, { shiftKey: false }, { code: 'KeyG' }, { altKey: true },
    { repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
    expect(isTextSearchShortcut({ ...event, ...change })).toBe(false);
  }
});

test('text search shortcut also fires inside editable targets but not over open dialogs, and cleans up', () => {
  class Element {
    constructor(readonly editable = false) {}
    closest() { return this.editable ? this : null; }
  }
  let listener: ((event: unknown) => void) | null = null;
  let opened = 0; let prevented = 0; let modal = false;
  const document = { activeElement: new Element(true), querySelector: () => modal ? {} : null,
    addEventListener: (_name: string, fn: typeof listener) => { listener = fn; },
    removeEventListener: () => { listener = null; } };
  const source = readFileSync(new URL('../frontend/src/features/navigation/fileSearchShortcut.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } });
  const exports: { installTextSearchShortcut?: (doc: unknown, open: () => void) => () => void } = {};
  vm.runInNewContext(output.outputText, { exports, Element, HTMLElement: Element });
  const close = exports.installTextSearchShortcut!(document, () => { opened++; });
  const send = (target: Element, modifiers = { metaKey: true, ctrlKey: false }) => listener?.({ code: 'KeyF', shiftKey: true, keyCode: 70,
    ...modifiers, composedPath: () => [target], preventDefault() { prevented++; }, stopPropagation() {} });
  send(new Element(true)); expect(opened).toBe(1);
  send(new Element(), { metaKey: false, ctrlKey: false }); expect(opened).toBe(1);
  modal = true; send(new Element()); expect(opened).toBe(1);
  expect(prevented).toBe(1); close(); expect(listener).toBeNull();
});
