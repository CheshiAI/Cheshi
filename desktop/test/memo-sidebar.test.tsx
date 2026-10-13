import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { MemoSidebar } from '../frontend/src/features/sticky-notes/MemoSidebar';
import type { StickyNotesLibraryApi, StickyNoteSummary } from '../shared/sticky-notes';

test('Memo sidebar searches, renames inline, refreshes and deletes only the confirmed note', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator,
    Event: window.Event, KeyboardEvent: window.KeyboardEvent,
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement,
    DOMParser: window.DOMParser, MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const sidebar = document.createElement('aside');
  const content = document.createElement('div');
  document.body.append(sidebar, content);
  const root = createRoot(content);

  let notes: StickyNoteSummary[] = [{ id: 'one', title: 'First', preview: 'Preview', createdAt: 1_700_000_000_000, updatedAt: Date.now() },
    { id: 'two', title: 'Second', preview: 'Other', createdAt: 1_700_000_000_000, updatedAt: Date.now() }];
  let changed = () => {};
  let created = 0, unsubscribed = false;
  const opened: string[] = [], deleted: string[][] = [];
  const queries: (string | undefined)[] = [];
  let failingRename = true, failingDelete = true;
  const api: StickyNotesLibraryApi = {
    list: async query => { queries.push(query); return query?.trim() ? notes.filter(note => note.id === 'two') : notes; },
    rename: async (id, title) => {
      if (failingRename) throw new Error('Rename fixture failure');
      notes = notes.map(note => note.id === id ? { ...note, title } : note);
    },
    create: async () => { created++; },
    open: async id => { opened.push(id); },
    deleteSelected: async ids => { if (failingDelete) return { deletedIds: [], failedIds: ids }; deleted.push(ids); notes = notes.filter(note => !ids.includes(note.id)); return { deletedIds: ids, failedIds: [] }; },
    onChanged: listener => { changed = listener; return () => { unsubscribed = true; }; },
  };
  const click = async (selector: string, scope: ParentNode = sidebar) => {
    const button = scope.querySelector<HTMLElement>(selector);
    if (!button) throw new Error(`Missing ${selector}`);
    await act(async () => button.click());
  };
  const clickText = async (text: string) => {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent === text);
    if (!button) throw new Error(`Missing button ${text}`);
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(<MemoSidebar api={api} target={null} />));
    expect(content.textContent).toBe('');
    await act(async () => root.render(<MemoSidebar api={api} target={sidebar} />));
    expect(content.textContent).toBe('');
    expect(sidebar.querySelectorAll('[data-note-id]')).toHaveLength(2);
    await click('[data-note-id="one"] button');
    expect(opened).toEqual(['one']);
    await click('[aria-label="New note"]');
    expect(created).toBe(1);
    expect(sidebar.querySelector('input[type="checkbox"]')).toBeNull();
    expect(sidebar.textContent).not.toContain('Preview');
    const createdAt = sidebar.querySelector('[data-note-id="one"] time')!.getAttribute('datetime');
    await click('[aria-label="Rename note: First"]');
    const input = sidebar.querySelector<HTMLInputElement>('[aria-label="Note title"]')!;
    expect(document.activeElement).toBe(input);
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Renamed'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(sidebar.textContent).toContain('Rename fixture failure');
    expect(sidebar.querySelector('[aria-label="Note title"]')).toBe(input);
    failingRename = false;
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(sidebar.querySelector('[aria-label="Note title"]')).toBeNull();
    expect(sidebar.querySelector('[data-note-id="one"] time')!.getAttribute('datetime')).toBe(createdAt);
    await click('[aria-label="Rename note: Renamed"]');
    await act(async () => sidebar.querySelector('[aria-label="Note title"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(sidebar.querySelector('[aria-label="Note title"]')).toBeNull();
    const search = sidebar.querySelector<HTMLInputElement>('[aria-label="Search notes"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'Full body query'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(queries.at(-1)).toBe('Full body query');
    expect(sidebar.querySelectorAll('[data-note-id]')).toHaveLength(1);
    await click('[aria-label="Clear note search"]');
    expect(sidebar.querySelectorAll('[data-note-id]')).toHaveLength(2);
    const reads = queries.length;
    await click('[aria-label="Refresh notes"]');
    expect(queries.length).toBeGreaterThan(reads);
    await act(async () => changed());
    await click('[aria-label="Delete note: Renamed"]');
    await clickText('Cancel');
    expect(deleted).toEqual([]);
    await click('[aria-label="Delete note: Renamed"]');
    await clickText('Delete');
    expect(document.querySelector('dialog[open]')?.textContent).toContain('could not be deleted');
    expect(deleted).toEqual([]);
    failingDelete = false;
    await clickText('Delete');
    expect(deleted).toEqual([['one']]);
    expect(sidebar.querySelectorAll('[data-note-id]')).toHaveLength(1);
    expect(sidebar.textContent).toContain('Second');
  } finally {
    await act(async () => root.unmount());
    expect(unsubscribed).toBe(true);
    expect(sidebar.childNodes).toHaveLength(0);
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
