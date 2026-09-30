import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { AppleNotesApi, AppleNotesFolder, AppleNotesPage } from '../shared/apple-notes';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

async function withBrowser(run: (context: {
  container: HTMLDivElement;
  folders: ReturnType<typeof createDeferred<AppleNotesFolder[]>>;
  notes: ReturnType<typeof createDeferred<AppleNotesPage>>;
  folderReads: () => number;
  pointer: (type: string, y: number) => Promise<void>;
  wheel: (deltaY: number) => Promise<void>;
  restart: () => Promise<void>;
}) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator,
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement,
    DOMParser: window.DOMParser, MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { AppleNotesBrowser } = await import('../frontend/src/features/notes/AppleNotesBrowser');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let instance = 0;
  const folders = createDeferred<AppleNotesFolder[]>();
  const notes = createDeferred<AppleNotesPage>();
  let folderReads = 0;
  const api: AppleNotesApi = {
    available: true, open: async () => {}, folders: async () => { folderReads++; return folders.promise; }, list: async () => notes.promise,
    read: async () => { throw new Error('Unexpected read'); },
    document: async () => { throw new Error('Unexpected document'); },
    update: async () => { throw new Error('Unexpected save'); },
    create: async () => { throw new Error('Unexpected create'); },
    delete: async () => { throw new Error('Unexpected delete'); },
  };
  try {
    const render = async () => { await act(async () => root.render(<AppleNotesBrowser key={instance} api={api} onAttach={async () => false} />)); };
    await render();
    await run({ container, folders, notes, folderReads: () => folderReads,
      restart: async () => { instance++; await render(); },
      pointer: async (type, y) => { await act(async () => {
        const event = new window.PointerEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true,
          clientY: y, clientX: 10, button: 0, bubbles: true, cancelable: true });
        if (type === 'pointerdown') container.querySelector('[aria-label="iCloud / Notes"]')!.dispatchEvent(event as unknown as Event);
        else window.dispatchEvent(event);
      }); },
      wheel: async deltaY => { await act(async () => {
        container.querySelector('[aria-label="Memo folder list"]')!.dispatchEvent(
          new window.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }) as unknown as Event);
      }); },
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const folder: AppleNotesFolder = { id: 'folder', name: 'Notes', path: 'Notes', account: 'iCloud', isDefault: true };
const emptyPage: AppleNotesPage = { notes: [], nextOffset: null };
const loaderSelector = '[aria-label="Memo folders"] [role="status"]';

test('a new Memo instance starts with every folder collapsed even if the previous instance had an open folder', async () => {
  await withBrowser(async ({ container, folders, notes, restart }) => {
    await act(async () => {
      folders.resolve([folder, { ...folder, id: 'other', path: 'Other', isDefault: false }]);
      notes.resolve(emptyPage);
    });
    const folderRows = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'));
    expect(folderRows()).toHaveLength(2);
    expect(folderRows().every(row => row.getAttribute('aria-expanded') === 'false')).toBe(true);
    await act(async () => folderRows()[1]!.click());
    expect(folderRows()[1]!.getAttribute('aria-expanded')).toBe('true');
    await restart();
    expect(folderRows()).toHaveLength(2);
    expect(folderRows().every(row => row.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(container.querySelector('[role="region"][aria-label="Notes"]')).toBeNull();
    await act(async () => folderRows()[0]!.click());
    expect(folderRows()[0]!.getAttribute('aria-expanded')).toBe('true');
  });
});

test('Memo keeps one shared loader above the folders from initial loading through note loading', async () => {
  await withBrowser(async ({ container, folders, notes }) => {
    expect(container.querySelectorAll(loaderSelector)).toHaveLength(1);
    const indicator = container.querySelector(loaderSelector)!;
    expect(indicator.nextElementSibling?.getAttribute('aria-label')).toBe('Folders and notes');
    await act(async () => folders.resolve([folder]));
    expect(container.querySelectorAll(loaderSelector)).toHaveLength(1);
    expect(container.querySelector(loaderSelector)).toBe(indicator);
    expect(indicator.closest('[aria-label="Notes"]')).toBeNull();
    await act(async () => notes.resolve(emptyPage));
    expect(container.querySelectorAll(loaderSelector)).toHaveLength(0);
    const folderButton = container.querySelector<HTMLButtonElement>('[aria-label="iCloud / Notes"]')!;
    expect(folderButton.getAttribute('aria-expanded')).toBe('false');
    await act(async () => folderButton.click());
    expect(container.textContent).toContain('This folder has no notes.');
  });
});

for (const expanded of [true, false]) {
  test(`Memo refresh retains one loader through both requests with the folder ${expanded ? 'open' : 'collapsed'}`, async () => {
    await withBrowser(async ({ container, folders, notes }) => {
      await act(async () => { folders.resolve([folder]); notes.resolve(emptyPage); });
      const folderButton = container.querySelector<HTMLButtonElement>('[aria-label="iCloud / Notes"]')!;
      if (expanded) await act(async () => folderButton.click());
      // Replace the fulfilled promises for the next refresh without changing the API identity.
      const nextFolders = createDeferred<AppleNotesFolder[]>();
      const nextNotes = createDeferred<AppleNotesPage>();
      folders.promise = nextFolders.promise;
      notes.promise = nextNotes.promise;
      const refresh = container.querySelector<HTMLButtonElement>('[aria-label="Refresh Apple Notes"]')!;
      await act(async () => refresh.click());
      const indicator = container.querySelector(loaderSelector)!;
      expect(indicator).not.toBeNull();
      expect(container.querySelectorAll(loaderSelector)).toHaveLength(1);
      expect(indicator.closest('[aria-label="Notes"]')).toBeNull();
      expect(indicator.nextElementSibling?.getAttribute('aria-label')).toBe('Folders and notes');
      expect(refresh.disabled).toBe(true);
      await act(async () => nextFolders.resolve([folder]));
      expect(container.querySelectorAll(loaderSelector)).toHaveLength(1);
      expect(container.querySelector(loaderSelector)).toBe(indicator);
      expect(refresh.disabled).toBe(true);
      await act(async () => nextNotes.resolve(emptyPage));
      expect(container.querySelectorAll(loaderSelector)).toHaveLength(0);
      expect(refresh.disabled).toBe(false);
      expect(folderButton.getAttribute('aria-expanded')).toBe(String(expanded));
    });
  });
}

test('Memo releases the loading indicator and enables retry after a folder refresh error', async () => {
  await withBrowser(async ({ container, folders }) => {
    await act(async () => folders.reject(new Error('Folder refresh failed')));
    expect(container.querySelectorAll(loaderSelector)).toHaveLength(0);
    expect(container.textContent).toContain('Folder refresh failed');
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Refresh Apple Notes"]')!.disabled).toBe(false);
  });
});

test('Memo pull refresh starts on release and keeps the same 36px indicator through both requests', async () => {
  await withBrowser(async ({ container, folders, notes, folderReads, pointer }) => {
    await act(async () => { folders.resolve([folder]); notes.resolve(emptyPage); });
    const nextFolders = createDeferred<AppleNotesFolder[]>();
    const nextNotes = createDeferred<AppleNotesPage>();
    folders.promise = nextFolders.promise;
    notes.promise = nextNotes.promise;
    await pointer('pointerdown', 10);
    await pointer('pointermove', 40);
    expect(container.querySelector(loaderSelector)?.textContent).toBe('Pull to refresh');
    await pointer('pointermove', 110);
    const indicator = container.querySelector<HTMLElement>(loaderSelector)!;
    expect(indicator.textContent).toBe('Release to refresh');
    expect(indicator.style.height).toBe('36px');
    expect(indicator.nextElementSibling?.getAttribute('aria-label')).toBe('Folders and notes');
    expect(folderReads()).toBe(1);
    await pointer('pointerup', 110);
    expect(folderReads()).toBe(2);
    expect(container.querySelectorAll(loaderSelector)).toHaveLength(1);
    expect(container.querySelector(loaderSelector)).toBe(indicator);
    const refresh = container.querySelector<HTMLButtonElement>('[aria-label="Refresh Apple Notes"]')!;
    expect(refresh.disabled).toBe(true);
    await act(async () => refresh.click());
    await pointer('pointerdown', 10);
    await pointer('pointermove', 110);
    await pointer('pointerup', 110);
    expect(folderReads()).toBe(2);
    await act(async () => nextFolders.resolve([folder]));
    expect(container.querySelectorAll(loaderSelector)).toHaveLength(1);
    expect(container.querySelector(loaderSelector)).toBe(indicator);
    expect(indicator.style.height).toBe('36px');
    await act(async () => nextNotes.resolve(emptyPage));
    expect(container.querySelectorAll(loaderSelector)).toHaveLength(0);
    expect(refresh.disabled).toBe(false);
  });
});

test('Memo cancels short or scrolled pulls and refreshes after a new trackpad gesture at the top', async () => {
  await withBrowser(async ({ container, folders, notes, folderReads, pointer, wheel }) => {
    await act(async () => { folders.resolve([folder]); notes.resolve(emptyPage); });
    await pointer('pointerdown', 10);
    await pointer('pointermove', 35);
    await pointer('pointerup', 35);
    expect(folderReads()).toBe(1);
    expect(container.querySelectorAll(loaderSelector)).toHaveLength(0);
    const viewport = container.querySelector<HTMLElement>('[aria-label="Memo folder list"]')!;
    viewport.scrollTop = 100;
    await pointer('pointerdown', 10);
    await pointer('pointermove', 110);
    await pointer('pointerup', 110);
    await wheel(-80);
    viewport.scrollTop = 0;
    await wheel(-80);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    expect(folderReads()).toBe(1);
    const nextFolders = createDeferred<AppleNotesFolder[]>();
    folders.promise = nextFolders.promise;
    await wheel(-80);
    expect(folderReads()).toBe(1);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    expect(folderReads()).toBe(2);
    expect(container.querySelectorAll(loaderSelector)).toHaveLength(1);
    await act(async () => nextFolders.reject(new Error('Refresh failed')));
    expect(container.querySelectorAll(loaderSelector)).toHaveLength(0);
    expect(container.textContent).toContain('Refresh failed');
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Refresh Apple Notes"]')!.disabled).toBe(false);
  });
});
