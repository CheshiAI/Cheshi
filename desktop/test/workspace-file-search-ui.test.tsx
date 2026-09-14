import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { installFileSearchShortcut } from '../frontend/src/shared/fileSearchShortcut';
import type { WorkspaceFileSearchResult } from '../shared/workspace-file-search';

interface Element { type: unknown; props: Record<string, unknown> }
interface Effect { deps: unknown[]; cleanup?: () => void }
function compile(name: string) {
  return ts.transpileModule(readFileSync(new URL(`../frontend/src/features/navigation/${name}`, import.meta.url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const hookSource = compile('useWorkspaceFileSearch.ts');
const dialogSource = compile('WorkspaceFileSearch.tsx');
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value) || !('type' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children), ...elements(element.props.trailingAction)];
}
function find(tree: unknown, type: string, property?: [string, unknown]) {
  const result = elements(tree).find(element => element.type === type && (!property || element.props[property[0]] === property[1]));
  assert.ok(result, `Missing ${type}`);
  return result;
}
function invoke(element: Element, property: string, ...args: unknown[]) {
  const callback = element.props[property];
  assert.equal(typeof callback, 'function');
  return (callback as (...values: unknown[]) => unknown)(...args);
}
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
async function settle() { await new Promise<void>(resolve => setImmediate(resolve)); }
const files: WorkspaceFileSearchResult = {
  files: [{ name: 'alpha.ts', path: 'src/alpha.ts' }, { name: 'beta.ts', path: 'src/beta.ts' }], truncated: false,
};
function harness(kind: 'hook' | 'dialog' | 'launcher' = 'dialog', available = true) {
  const state: unknown[] = [];
  const effects = new Map<number, Effect>();
  const pending: (() => void)[] = [];
  const timers = new Map<number, { due: number; callback: () => void }>();
  const requests: Array<{ query: string } & ReturnType<typeof createDeferred<WorkspaceFileSearchResult>>> = [];
  const calls = { opened: [] as string[], closed: 0, stateWrites: 0 };
  let index = 0;
  let clock = 0;
  let timerId = 0;
  let existingDialog = false;
  let dialogVisibility = 'visible';
  let dialogHasLayout = true;
  const window = Object.assign(new EventTarget(), {
    setTimeout(callback: () => void, delay: number) { timers.set(++timerId, { due: clock + delay, callback }); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  const react = {
    useState(initial: unknown) {
      const slot = index++;
      if (!(slot in state)) state[slot] = initial;
      return [state[slot], (value: unknown) => {
        state[slot] = typeof value === 'function' ? value(state[slot]) : value;
        calls.stateWrites++;
      }];
    },
    useRef(initial: unknown) {
      const slot = index++;
      if (!(slot in state)) state[slot] = { current: initial };
      return state[slot];
    },
    useId() { index++; return 'file-list'; },
    useEffect(callback: () => void | (() => void), deps: unknown[]) {
      const slot = index++;
      const previous = effects.get(slot);
      if (previous && previous.deps.length === deps.length && deps.every((value, offset) => Object.is(value, previous.deps[offset]))) return;
      pending.push(() => {
        previous?.cleanup?.();
        effects.set(slot, { deps, cleanup: callback() || undefined });
      });
    },
  };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const modules: Record<string, unknown> = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': { FileSearch: 'FileSearch', FileText: 'FileText', Search: 'Search' },
    '../../shared/ui': { Modal: 'Modal', NeumorphicButton: 'Button', NeumorphicTextField: 'Input', SearchClearButton: 'Clear' },
    '../../shared/fileSearchShortcut': {
      installFileSearchShortcut,
    },
    '../../cheshiDesktop': { cheshiDesktop: available ? { searchWorkspaceFiles(query: string) {
      const request = { query, ...createDeferred<WorkspaceFileSearchResult>() };
      requests.push(request); return request.promise;
    } } : undefined },
    './WorkspaceFileSearch.module.css': { default: new Proxy({}, { get: (_target, key) => String(key) }) },
  };
  function load(source: string) {
    const exports: Record<string, unknown> = {};
    vm.runInNewContext(source, {
      exports, Error, window,
      document: { querySelectorAll: () => existingDialog ? [{ getClientRects: () => dialogHasLayout ? [{}] : [] }] : [] },
      getComputedStyle: () => ({ visibility: dialogVisibility }),
      require(name: string) { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`); return modules[name]; },
    });
    return exports;
  }
  const hook = load(hookSource);
  modules['./useWorkspaceFileSearch'] = hook;
  const dialog = load(dialogSource);
  const component = kind === 'hook' ? hook.useWorkspaceFileSearch
    : kind === 'dialog' ? dialog.WorkspaceFileSearchDialog : dialog.WorkspaceFileSearch;
  assert.equal(typeof component, 'function');
  let query = '';
  let disabled = false;
  return {
    requests, calls,
    render() {
      index = 0;
      const result: unknown = (component as (props: unknown) => unknown)(kind === 'hook' ? query : {
        disabled, onClose: () => { calls.closed++; }, onOpenFile: (path: string) => { calls.opened.push(path); },
      });
      for (const callback of pending.splice(0)) callback();
      return result;
    },
    setQuery(value: string) { query = value; },
    setDisabled(value: boolean) { disabled = value; },
    setExistingDialog(value: boolean) { existingDialog = value; },
    setDialogVisibility(value: string) { dialogVisibility = value; },
    setDialogHasLayout(value: boolean) { dialogHasLayout = value; },
    async advance(ms = 150) {
      clock += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.callback(); }
      await settle();
    },
    shiftF() {
      const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'F', code: 'KeyF', shiftKey: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    },
    unmount() { for (const effect of effects.values()) effect.cleanup?.(); effects.clear(); },
  };
}
type SearchState = WorkspaceFileSearchResult & { loading: boolean; error: string | null; retry: () => void };
function searchState(app: ReturnType<typeof harness>) { return app.render() as SearchState; }
function key(tree: unknown, value: string, composing = false) {
  invoke(find(tree, 'Input'), 'onKeyDown', {
    key: value, nativeEvent: { isComposing: composing }, preventDefault() {}, stopPropagation() {},
  });
}
async function populated() {
  const app = harness(); app.render(); await app.advance();
  app.requests[0]!.resolve(files); await settle(); return app;
}

describe('workspace file search results', () => {
  test('debounces query changes and immediately hides outdated results', async () => {
    const app = harness('hook');
    searchState(app); await app.advance(100);
    app.setQuery('alpha'); searchState(app); await app.advance(149);
    expect(app.requests).toHaveLength(0);
    await app.advance(1); expect(app.requests.map(request => request.query)).toEqual(['alpha']);
    app.requests[0]!.resolve(files); await settle();
    expect(searchState(app).files).toEqual(files.files);
    app.setQuery('beta');
    expect(searchState(app)).toMatchObject({ files: [], loading: true });
    app.unmount();
  });

  test('late results and failures cannot overwrite a newer query or update after unmount', async () => {
    const app = harness('hook'); searchState(app); await app.advance();
    app.setQuery('latest'); searchState(app); await app.advance();
    app.requests[1]!.resolve(files); await settle();
    app.requests[0]!.reject(new Error('Old failure')); await settle();
    expect(searchState(app)).toMatchObject({ files: files.files, error: null, loading: false });
    app.setQuery('pending'); searchState(app); await app.advance();
    app.unmount(); const writes = app.calls.stateWrites;
    app.requests[2]!.resolve({ files: [], truncated: false }); await settle();
    expect(app.calls.stateWrites).toBe(writes);
  });

  test('unmount cancels the pending debounce and missing bridge explains restart', async () => {
    const app = harness('hook'); searchState(app); app.unmount(); await app.advance();
    expect(app.requests).toHaveLength(0);
    const missing = harness('hook', false); searchState(missing); await missing.advance();
    expect(searchState(missing)).toMatchObject({ loading: false, error: 'Restart Cheshi to enable file search.' });
    missing.unmount();
  });

  test('error exposes Retry and successful empty results show an empty state', async () => {
    const app = harness(); app.render(); await app.advance();
    app.requests[0]!.reject(new Error('Permission denied')); await settle();
    const error = app.render();
    expect(elements(find(error, 'div', ['role', 'alert'])).some(element => element.props.children === 'Permission denied')).toBe(true);
    invoke(find(error, 'Button'), 'onClick'); app.render(); await app.advance();
    expect(app.requests).toHaveLength(2);
    app.requests[1]!.resolve({ files: [], truncated: false }); await settle();
    expect(find(app.render(), 'p', ['role', 'status']).props.children).toBe('No files found.');
    app.unmount();
  });
});

describe('workspace file search navigation', () => {
  test('arrows wrap, composing Enter is ignored, and Enter opens the selected file once', async () => {
    const app = await populated();
    key(app.render(), 'ArrowUp');
    expect(find(app.render(), 'li', ['aria-selected', true]).props.title).toBe('src/beta.ts');
    key(app.render(), 'ArrowDown');
    expect(find(app.render(), 'li', ['aria-selected', true]).props.title).toBe('src/alpha.ts');
    key(app.render(), 'ArrowDown'); key(app.render(), 'Enter', true);
    expect(app.calls.opened).toEqual([]);
    const selected = app.render(); key(selected, 'Enter'); key(selected, 'Enter');
    expect(app.calls.opened).toEqual(['src/beta.ts']); expect(app.calls.closed).toBe(1);
    expect(invoke(find(app.render(), 'Modal'), 'restoreFocus')).toBe(false);
    app.unmount();
  });

  test('click opens its file and closing without selection retains focus restoration', async () => {
    const app = await populated();
    expect(invoke(find(app.render(), 'Modal'), 'restoreFocus')).toBe(true);
    invoke(find(app.render(), 'li', ['title', 'src/beta.ts']), 'onClick');
    expect(app.calls.opened).toEqual(['src/beta.ts']); expect(app.calls.closed).toBe(1);
    app.unmount();
  });

  test('changing and clearing the query resets selection and prevents opening stale files', async () => {
    const app = await populated(); key(app.render(), 'ArrowDown');
    invoke(find(app.render(), 'Input'), 'onChange', { target: { value: 'alpha' } });
    key(app.render(), 'Enter'); expect(app.calls.opened).toEqual([]);
    await app.advance(); app.requests[1]!.resolve(files); await settle();
    expect(find(app.render(), 'li', ['aria-selected', true]).props.title).toBe('src/alpha.ts');
    key(app.render(), 'ArrowDown'); invoke(find(app.render(), 'Clear'), 'onClick');
    expect(find(app.render(), 'Input').props.value).toBe('');
    await app.advance(); app.requests[2]!.resolve(files); await settle();
    expect(find(app.render(), 'li', ['aria-selected', true]).props.title).toBe('src/alpha.ts');
    app.unmount();
  });

  test('launcher respects disabled state and existing dialogs and removes its shortcut', () => {
    const app = harness('launcher'); app.setDisabled(true); expect(app.render()).toBeNull();
    expect(app.shiftF()).toBe(false); expect(app.render()).toBeNull();
    app.setDisabled(false); app.render(); app.setExistingDialog(true);
    expect(app.shiftF()).toBe(false); expect(app.render()).toBeNull();
    app.setExistingDialog(false); expect(app.shiftF()).toBe(true); expect(app.render()).not.toBeNull();
    app.setDisabled(true); expect(app.render()).toBeNull();
    app.setDisabled(false); expect(app.render()).toBeNull();
    app.unmount(); const writes = app.calls.stateWrites;
    expect(app.shiftF()).toBe(false); expect(app.calls.stateWrites).toBe(writes);
  });

  test('closed status popovers and CSS-hidden dialogs do not block file search', () => {
    for (const hiddenBy of ['layout', 'visibility']) {
      const app = harness('launcher');
      app.setExistingDialog(true);
      if (hiddenBy === 'layout') app.setDialogHasLayout(false);
      else app.setDialogVisibility('hidden');
      expect(app.render()).toBeNull();
      expect(app.shiftF()).toBe(true);
      expect(app.render()).not.toBeNull();
      app.unmount();
    }
  });
});
