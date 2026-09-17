import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ComponentProps } from 'react';
import type { AppleNotesApi } from '../shared/apple-notes';
import type { AppleNoteDocument } from '../shared/apple-notes-document';

const document: AppleNoteDocument = {
  id: 'note', title: 'Memo', plaintext: 'Memo body', html: '<p>Memo body</p>',
  modifiedAt: '2026-09-16T00:00:00Z', locked: false, attachmentCount: 0,
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

async function withEditor(run: (view: {
  render: (loadingNote: boolean, read: AppleNotesApi['document']) => Promise<void>;
  container: HTMLElement;
}) => Promise<void>) {
  const window = new Window();
  const globals: Record<string, unknown> = {
    window, document: window.document, navigator: window.navigator,
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement,
    DOMParser: window.DOMParser, MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let unmount: (() => Promise<void>) | undefined;
  try {
    const { createRoot } = await import('react-dom/client');
    const { AppleNotesEditor } = await import('../frontend/src/features/notes/AppleNotesEditor');
    const container = globalThis.document.createElement('div');
    globalThis.document.body.append(container);
    const root = createRoot(container);
    unmount = async () => { await act(async () => root.unmount()); };
    const api: AppleNotesApi = {
      available: true, folders: async () => [], list: async () => ({ notes: [], nextOffset: null }),
      read: async () => document, document: async () => document,
      create: async () => { throw new Error('Unexpected create'); },
      update: async () => { throw new Error('Unexpected update'); },
      delete: async () => { throw new Error('Unexpected delete'); },
    };
    const props: ComponentProps<typeof AppleNotesEditor> = {
      api, note: document, disabled: false, onSaved() {}, onBusyChange() {},
    };
    await run({ container, render: async (loadingNote, read) => {
      api.document = read;
      await act(async () => root.render(<AppleNotesEditor {...props} loadingNote={loadingNote} />));
    } });
  } finally {
    await unmount?.();
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function loading(container: HTMLElement) {
  const indicators = container.querySelectorAll('[role="status"][aria-label="Preparing..."]');
  expect(indicators.length).toBe(1);
  return indicators[0]!;
}

test('one shared loading instance spans the note read and document request until the editor is ready', async () => {
  await withEditor(async view => {
    const pending = createDeferred<AppleNoteDocument>();
    let reads = 0;
    const read = async () => { reads += 1; return pending.promise; };
    await view.render(true, read);
    const initial = loading(view.container);
    expect(reads).toBe(0);
    expect(view.container.textContent).not.toContain('Reading note');
    expect(view.container.textContent).not.toContain('편집할 메모를 불러오는 중');

    await view.render(false, read);
    expect(reads).toBe(1);
    expect(loading(view.container)).toBe(initial);
    await act(async () => pending.resolve(document));
    expect(view.container.contains(initial)).toBe(false);
    expect(view.container.querySelector('[role="textbox"]')?.textContent).toBe('Memo body');

    const reloading = createDeferred<AppleNoteDocument>();
    const reread = async () => reloading.promise;
    await view.render(true, reread);
    const next = loading(view.container);
    expect(view.container.querySelector('[role="textbox"]')).toBeNull();
    expect(next).not.toBe(initial);
    await view.render(false, reread);
    expect(loading(view.container)).toBe(next);
    await act(async () => reloading.resolve(document));
    expect(view.container.contains(next)).toBe(false);
  });
});

test('document errors replace loading with a retry action and retry restores one indicator', async () => {
  await withEditor(async view => {
    const failed = createDeferred<AppleNoteDocument>();
    const retry = createDeferred<AppleNoteDocument>();
    let reads = 0;
    const read = async () => ++reads === 1 ? failed.promise : retry.promise;
    await view.render(false, read);
    const initial = loading(view.container);
    await act(async () => failed.reject(new Error('Unavailable')));
    expect(view.container.contains(initial)).toBe(false);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('편집할 메모를 불러오지 못했습니다.');
    const button = view.container.querySelector('button');
    expect(button?.textContent).toBe('다시 시도');
    await act(async () => button?.click());
    expect(reads).toBe(2);
    loading(view.container);
    await act(async () => retry.resolve(document));
    expect(view.container.querySelector('[role="textbox"]')?.textContent).toBe('Memo body');
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });
});

test('a document response from an abandoned read cannot finish the next loading operation', async () => {
  await withEditor(async view => {
    const abandoned = createDeferred<AppleNoteDocument>();
    const current = createDeferred<AppleNoteDocument>();
    await view.render(false, async () => abandoned.promise);
    await view.render(true, async () => current.promise);
    const pending = loading(view.container);
    await act(async () => abandoned.resolve(document));
    expect(loading(view.container)).toBe(pending);
    await view.render(false, async () => current.promise);
    expect(loading(view.container)).toBe(pending);
    await act(async () => current.resolve(document));
    expect(view.container.querySelector('[role="textbox"]')?.textContent).toBe('Memo body');
  });
});
