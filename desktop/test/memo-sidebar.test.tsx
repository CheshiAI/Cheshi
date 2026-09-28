import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { AppleNotesApi } from '../shared/apple-notes';
import type { AppleNoteDocument } from '../shared/apple-notes-document';

test('Memo sidebar portals the search and folders while retaining the selected editor across scene changes', async () => {
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
  const sidebar = document.createElement('aside');
  const content = document.createElement('div');
  document.body.append(sidebar, content);
  const root = createRoot(content);
  const note: AppleNoteDocument = { id: 'note', title: 'Selected memo', plaintext: 'Memo body', html: '<p>Memo body</p>',
    modifiedAt: '2026-09-16T00:00:00Z', locked: false, attachmentCount: 0 };
  let folderReads = 0, opened = 0;
  const api: AppleNotesApi = {
    available: true,
    open: async () => {},
    folders: async () => { folderReads++; return [{ id: 'folder', name: 'Notes', path: 'Notes', account: 'iCloud', isDefault: true }]; },
    list: async () => ({ notes: [note], nextOffset: null }), read: async () => note, document: async () => note,
    update: async () => { throw new Error('Unexpected save'); },
    create: async () => { throw new Error('Unexpected create'); },
    delete: async () => { throw new Error('Unexpected delete'); },
  };
  const render = async (active: boolean) => {
    await act(async () => root.render(<main hidden={!active}>
      <AppleNotesBrowser api={api} sidebarTarget={sidebar} onAttach={async () => false}
        onOpen={() => { opened++; }} renderHeader={() => <header>Memo editor</header>} />
    </main>));
  };
  try {
    await render(false);
    const folders = sidebar.querySelector('[aria-label="Memo folders"]')!;
    const input = sidebar.querySelector<HTMLInputElement>('[aria-label="Search all notes"]')!;
    expect(input.placeholder).toBe('Search…');
    expect(folders.textContent).toContain('MEMO');
    expect(folders.querySelector('[role="search"]')).not.toBeNull();
    expect(content.querySelector('[role="search"]')).toBeNull();
    expect(content.querySelector('[aria-label="Memo folders"]')).toBeNull();
    expect(sidebar.querySelector('[aria-label="Refresh Apple Notes"]')).not.toBeNull();
    const row = sidebar.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
    expect(row.hasAttribute('title')).toBe(false);
    await act(async () => row.click());
    expect(opened).toBe(1);
    await render(true);
    const editor = content.querySelector('[role="textbox"]')!;
    expect(editor.textContent).toBe('Memo body');
    expect(row.getAttribute('aria-pressed')).toBe('true');
    await render(false);
    await render(true);
    expect(sidebar.querySelector('[aria-label="Search all notes"]')).toBe(input);
    expect(content.querySelector('[role="textbox"]')).toBe(editor);
    expect(folderReads).toBe(1);
  } finally {
    await act(async () => root.unmount());
    expect(sidebar.childNodes).toHaveLength(0);
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
