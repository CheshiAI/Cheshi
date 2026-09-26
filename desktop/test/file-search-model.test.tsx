import { test, expect } from 'bun:test';
import { Window, type HTMLElement as TestElement } from 'happy-dom';
import { createFileSearchController, handleFileSearchKeyDown, initialFileSearchState, selectedFileSearchPath, type FileSearchState } from '../frontend/src/features/navigation/fileSearchModel';
import { installFileSearchShortcut, isFileSearchShortcut } from '../frontend/src/features/navigation/fileSearchShortcut';
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

async function withShortcut(run: (view: {
  document: Window['document'];
  create(markup: string): TestElement;
  send(target: TestElement, options?: { key?: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }): boolean;
  opened(): number;
  uninstall(): void;
}) => void) {
  const window = new Window();
  const document = window.document;
  const globals = { Element: window.Element, HTMLElement: window.HTMLElement };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let opened = 0;
  const uninstall = installFileSearchShortcut(document as unknown as Document, () => { opened++; });
  try {
    run({ document, opened: () => opened, uninstall,
      create(markup) {
        const host = document.createElement('div');
        host.innerHTML = markup;
        document.body.append(host);
        return host;
      },
      send(target, options = {}) {
        const event = new window.KeyboardEvent('keydown', {
          key: 'F', code: 'KeyF', keyCode: 70, shiftKey: true, metaKey: true,
          bubbles: true, cancelable: true, composed: true, ...options,
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      },
    });
  } finally {
    uninstall();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.abort();
  }
}

test('file search opens from editor content for English and Korean keys before editor handlers', async () => {
  await withShortcut(({ create, send, opened, uninstall }) => {
    const host = create('<div class="cm-editor"><div class="cm-content" contenteditable="true" role="textbox" tabindex="0"><span>code</span></div></div>');
    const content = host.querySelector<TestElement>('.cm-content')!;
    const text = host.querySelector<TestElement>('span')!;
    let editorEvents = 0;
    content.addEventListener('keydown', event => { editorEvents++; event.preventDefault(); });
    content.focus();
    expect(send(text, { key: 'F' })).toBe(true);
    expect(send(text, { key: 'ㄹ' })).toBe(true);
    expect(opened()).toBe(2);
    expect(editorEvents).toBe(0);
    send(text, { shiftKey: false });
    expect(opened()).toBe(2);
    expect(editorEvents).toBe(1);
    uninstall();
    send(text);
    expect(opened()).toBe(2);
    expect(editorEvents).toBe(2);
  });
});

test('shortcut protects native fields, non-editor textboxes and terminals including editor search', async () => {
  await withShortcut(({ create, send, opened }) => {
    for (const markup of [
      '<input>', '<textarea></textarea>', '<select></select>',
      '<div contenteditable="true" tabindex="0"></div>', '<div role="textbox" tabindex="0"></div>',
      '<div class="terminal-host" tabindex="0"></div>',
      '<div class="cm-editor"><input></div>',
      '<div class="cm-editor"><div contenteditable="true" tabindex="0"></div></div>',
      '<div class="cm-content" contenteditable="true" tabindex="0"></div>',
    ]) {
      const host = create(markup);
      const target = host.querySelector<TestElement>('input, textarea, select, [tabindex]')!;
      target.focus();
      expect(send(target)).toBe(false);
      expect(send(host)).toBe(false);
      expect(opened()).toBe(0);
      host.remove();
    }
    const host = create('<button>Workspace</button>');
    const button = host.querySelector('button')!;
    button.focus();
    expect(send(button)).toBe(true);
    expect(opened()).toBe(1);
  });
});

test('editor shortcut still respects IME composition and open modal dialogs', async () => {
  await withShortcut(({ create, send, opened }) => {
    const host = create('<div class="cm-editor"><div class="cm-content" contenteditable="true" role="textbox" tabindex="0"></div></div>');
    const content = host.querySelector<TestElement>('.cm-content')!;
    content.focus();
    expect(send(content, { key: 'ㄹ', isComposing: true })).toBe(false);
    expect(send(content, { key: 'ㄹ', keyCode: 229 })).toBe(false);
    for (const markup of ['<dialog open></dialog>', '<div role="dialog" aria-modal="true"></div>']) {
      const modal = create(markup);
      expect(send(content)).toBe(false);
      modal.remove();
    }
    expect(opened()).toBe(0);
    expect(send(content, { key: 'ㄹ' })).toBe(true);
    expect(opened()).toBe(1);
  });
});
