import { expect, test } from 'bun:test';
import type { AppleNote, AppleNotesApi } from '../shared/apple-notes';
import type { NotesSearchHit, NotesSearchRequest, NotesSearchResponse } from '../shared/apple-notes-search';
import { createAppleNotesBrowser, LOCKED_NOTE_MESSAGE } from '../frontend/src/features/notes/appleNotesModel';

const folders = [
  { id: 'icloud', name: 'Notes', path: 'Notes', account: 'iCloud', isDefault: true },
  { id: 'google', name: 'Notes', path: 'Work / Notes', account: 'Google', isDefault: false },
];
const note = (id: string, title: string, locked = false): AppleNote => ({
  id, title, locked, plaintext: 'Body', modifiedAt: '2026-09-29T00:00:00Z',
});
const reply = (hits: NotesSearchHit[] = [], extra: Partial<NotesSearchResponse> = {}): NotesSearchResponse => ({
  hits, folders, total: hits.length, nextOffset: null, version: 'one', state: 'ready', completed: 1, pending: 1, error: null, ...extra,
});
function api(overrides: Partial<AppleNotesApi> = {}): AppleNotesApi {
  return { available: true, folders: async () => folders, list: async () => ({ notes: [], nextOffset: null }),
    search: async () => reply(), read: async id => note(id, 'Chosen'), open: async () => {},
    document: async () => { throw new Error('Unexpected document read'); },
    create: async () => { throw new Error('Unexpected create'); }, update: async () => { throw new Error('Unexpected update'); },
    delete: async () => { throw new Error('Unexpected delete'); }, ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

test('indexed search uses its API without scanning folders and exposes body snippets across accounts', async () => {
  let lists = 0; const queries: NotesSearchRequest[] = [];
  const hit = { ...note('body', 'Unrelated title'), folderId: 'google', snippet: '본문 버튼 일치' };
  const browser = createAppleNotesBrowser(api({ list: async () => { lists++; return { notes: [], nextOffset: null }; },
    search: async request => { queries.push(request); return request.query ? reply([hit]) : reply(); } }), true);
  await browser.refresh(); await browser.search('버튼');
  expect(lists).toBe(1);
  expect(queries.map(item => item.query)).toEqual(['', '버튼']);
  expect(browser.getSnapshot().searchResults).toEqual([{ folderId: 'google', notes: [hit] }]);
  await browser.selectNote(hit.id, hit.folderId);
  expect(browser.getSnapshot()).toMatchObject({ folderId: 'google', selectedId: hit.id, note: note(hit.id, 'Chosen') });
  await browser.search('');
  expect(browser.getSnapshot()).toMatchObject({ searchResults: [], searching: false, searchError: null, selectedId: hit.id });
  browser.dispose();
});

test('locked title hits open a locked notice without reading their bodies', async () => {
  const hit = { ...note('locked', 'Locked title', true), folderId: 'google' };
  let reads = 0;
  const browser = createAppleNotesBrowser(api({ search: async () => reply([hit]), read: async () => { reads++; return hit; } }), true);
  await browser.refresh(); await browser.search('locked'); await browser.selectNote(hit.id, hit.folderId);
  expect(browser.getSnapshot()).toMatchObject({ error: LOCKED_NOTE_MESSAGE, note: null }); expect(reads).toBe(0);
  browser.dispose();
});

test('a slow indexed-result folder load cannot replace a later selection', async () => {
  const delayed = deferred<{ notes: AppleNote[]; nextOffset: null }>();
  const hit = { ...note('old', 'Old'), folderId: 'google' };
  const browser = createAppleNotesBrowser(api({ search: async () => reply([hit]),
    list: async folderId => folderId === 'google' ? delayed.promise : { notes: [], nextOffset: null } }), true);
  await browser.refresh(); await browser.search('old');
  const selection = browser.selectNote(hit.id, hit.folderId);
  await browser.selectFolder('icloud');
  delayed.resolve({ notes: [hit], nextOffset: null }); await selection;
  expect(browser.getSnapshot()).toMatchObject({ folderId: 'icloud', selectedId: '', notes: [], note: null });
  browser.dispose();
});

test('background progress polling retains pages already expanded by the user', async () => {
  const browser = createAppleNotesBrowser(api({ search: async request => request.offset
    ? reply([{ ...note('two', 'Two'), folderId: 'google' }], { state: 'updating', total: 2 })
    : reply([{ ...note('one', 'One'), folderId: 'icloud' }], { state: 'updating', total: 2, nextOffset: 1 }) }), true);
  await browser.search('query'); await browser.loadMoreSearch();
  await new Promise(resolve => setTimeout(resolve, 550));
  expect(browser.getSnapshot().searchResults.flatMap(group => group.notes).map(note => note.id)).toEqual(['one', 'two']);
  browser.dispose();
});

test('query changes, clearing and disposal ignore obsolete search replies and failures', async () => {
  for (const action of ['change', 'clear', 'dispose']) {
    const pending = deferred<NotesSearchResponse>();
    const browser = createAppleNotesBrowser(api({ search: async request => request.query === 'old' ? pending.promise : reply() }), true);
    await browser.refresh(); const old = browser.search('old');
    if (action === 'dispose') browser.dispose(); else await browser.search(action === 'clear' ? '' : 'new');
    const state = browser.getSnapshot();
    if (action === 'clear') pending.reject(new Error('Late error')); else pending.resolve(reply([{ ...note('old', 'Old'), folderId: 'icloud' }]));
    await old; expect(browser.getSnapshot()).toBe(state); browser.dispose();
  }
});

test('build progress refreshes results and completes without claiming an empty search early', async () => {
  let building = true;
  const browser = createAppleNotesBrowser(api({ search: async request => request.query
    ? reply([], building ? { state: 'building', completed: 2, pending: 10 } : {}) : reply() }), true);
  await browser.refresh(); await browser.search('body');
  expect(browser.getSnapshot()).toMatchObject({ searching: true, searchStatus: 'Preparing note search… 2/10' });
  building = false;
  await new Promise(resolve => setTimeout(resolve, 550));
  expect(browser.getSnapshot()).toMatchObject({ searching: false, searchStatus: '' }); browser.dispose();
});

test('pagination appends results and reports index changes instead of silently losing matches', async () => {
  const requests: NotesSearchRequest[] = [];
  let changed = false;
  const browser = createAppleNotesBrowser(api({ search: async request => {
    requests.push(request);
    if (changed) throw new Error('Search results changed. Search again to continue.');
    return request.offset ? reply([{ ...note('two', 'Two'), folderId: 'google' }])
      : reply([{ ...note('one', 'One'), folderId: 'icloud' }], { total: 2, nextOffset: 1 });
  } }), true);
  await browser.refresh(); await browser.search('query'); await browser.loadMoreSearch();
  expect(requests.at(-1)).toMatchObject({ offset: 1, version: 'one' });
  expect(browser.getSnapshot().searchResults.flatMap(group => group.notes).map(note => note.id)).toEqual(['one', 'two']);
  await browser.search('query'); changed = true; await browser.loadMoreSearch();
  expect(browser.getSnapshot().searchError).toContain('changed'); browser.dispose();
});

test('refresh and local mutations request updated index results; typing remains debounced', async () => {
  const requests: NotesSearchRequest[] = [];
  const browser = createAppleNotesBrowser(api({ search: async request => { requests.push(request); return reply(); } }), true);
  await browser.refresh();
  expect(requests[0]).toMatchObject({ query: '', refresh: true });
  const first = browser.search('rea', { debounce: true }); const second = browser.search('read', { debounce: true });
  await Promise.all([first, second]);
  expect(requests.map(request => request.query)).toEqual(['', 'read']);
  browser.applyUpdated(note('one', 'Changed'));
  await Promise.resolve();
  expect(requests.at(-1)?.query).toBe('read');
  await browser.refresh(); expect(requests.at(-1)).toMatchObject({ query: 'read', refresh: true });
  const old = browser.search('late', { debounce: true }); await browser.search(''); await old;
  expect(requests.map(request => request.query)).not.toContain('late'); browser.dispose();
});
