import { expect, test } from 'bun:test';
import type { AppleNote, AppleNotesApi, AppleNotesPage } from '../shared/apple-notes';
import { createAppleNotesBrowser, LOCKED_NOTE_MESSAGE } from '../frontend/src/features/notes/appleNotesModel';

const folders = [
  { id: 'icloud', name: 'Notes', path: 'Notes', account: 'iCloud', isDefault: true },
  { id: 'google', name: 'Notes', path: 'Work / Notes', account: 'Google', isDefault: false },
  { id: 'empty', name: 'Empty', path: 'Empty', account: 'Google', isDefault: false },
];
const note = (id: string, title: string, locked = false): AppleNote => ({
  id, title, locked, plaintext: 'Body is not part of search', modifiedAt: '2026-09-29T00:00:00Z',
});
function api(overrides: Partial<AppleNotesApi> = {}): AppleNotesApi {
  return { available: true, folders: async () => folders, list: async () => ({ notes: [], nextOffset: null }),
    read: async () => { throw new Error('Unexpected body read'); },
    open: async () => { throw new Error('Unexpected open'); },
    document: async () => { throw new Error('Unexpected document read'); },
    create: async () => { throw new Error('Unexpected create'); },
    update: async () => { throw new Error('Unexpected update'); },
    delete: async () => { throw new Error('Unexpected delete'); }, ...overrides };
}
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

test('search includes closed folders, other accounts and every page using metadata only', async () => {
  const calls: string[] = [];
  const first = note('first', 'Unrelated');
  const later = note('later', '벤치 marking');
  const protectedNote = note('protected', '벤치 locked', true);
  const browser = createAppleNotesBrowser(api({ list: async (folderId, offset = 0) => {
    calls.push(`${folderId}:${offset}`);
    if (folderId === 'icloud') return offset === 0
      ? { notes: [first], nextOffset: 100 } : { notes: [later], nextOffset: null };
    return { notes: folderId === 'google' ? [protectedNote] : [], nextOffset: null };
  } }), true);
  await browser.refresh();
  await browser.search(' 벤치 ');
  expect(browser.getSnapshot().searchResults).toEqual([
    { folderId: 'icloud', notes: [later] }, { folderId: 'google', notes: [protectedNote] },
  ]);
  expect(calls).toEqual(['icloud:0', 'icloud:100', 'google:0', 'empty:0']);
  expect(browser.getSnapshot()).toMatchObject({ searching: false, folderId: 'icloud', notes: [first] });
  await browser.selectNote('protected', 'google');
  expect(browser.getSnapshot()).toMatchObject({ folderId: 'google', selectedId: 'protected', note: null, error: LOCKED_NOTE_MESSAGE });
  await browser.search('BODY');
  expect(browser.getSnapshot().searchResults).toEqual([]);
  expect(calls).toHaveLength(4);
  browser.dispose();
});

test('a later-page search result opens in its own folder and remains selected after clearing search', async () => {
  const later = note('later', 'Find me');
  const reads: string[] = [];
  const browser = createAppleNotesBrowser(api({
    list: async (folderId, offset = 0) => folderId !== 'google' ? { notes: [], nextOffset: null }
      : offset === 0 ? { notes: [note('other', 'Other')], nextOffset: 100 } : { notes: [later], nextOffset: null },
    read: async id => { reads.push(id); return later; },
  }), true);
  await browser.refresh();
  await browser.search('FIND');
  await browser.selectNote('later', 'google');
  expect(browser.getSnapshot()).toMatchObject({ folderId: 'google', selectedId: 'later', note: later, nextOffset: null });
  await browser.search('');
  expect(browser.getSnapshot()).toMatchObject({ searchResults: [], searching: false, searchError: null, note: later });
  expect(browser.getSnapshot().notes.map(item => item.id)).toEqual(['other', 'later']);
  expect(reads).toEqual(['later']);
  browser.dispose();
});

test('changing the query ignores older responses and stops their remaining folder requests', async () => {
  const pending = createDeferred<AppleNotesPage>();
  let googleCalls = 0;
  const browser = createAppleNotesBrowser(api({ list: async folderId => {
    if (folderId === 'google') return ++googleCalls === 1 ? pending.promise
      : { notes: [note('new', 'New match')], nextOffset: null };
    return { notes: [], nextOffset: null };
  } }), true);
  await browser.refresh();
  const oldSearch = browser.search('old');
  await browser.search('new');
  pending.resolve({ notes: [note('old', 'Old match')], nextOffset: 100 });
  await oldSearch;
  expect(browser.getSnapshot()).toMatchObject({ searchQuery: 'new', searching: false, searchError: null });
  expect(browser.getSnapshot().searchResults[0]?.notes[0]?.id).toBe('new');
  expect(googleCalls).toBe(2);
  browser.dispose();
});

test('clearing or disposing a search ignores late failures without replacing the preview', async () => {
  for (const dispose of [false, true]) {
    const pending = createDeferred<AppleNotesPage>();
    const selected = note('selected', 'Keep preview');
    const browser = createAppleNotesBrowser(api({ read: async () => selected,
      list: async folderId => folderId === 'google' ? pending.promise : { notes: [selected], nextOffset: null },
    }), true);
    await browser.refresh();
    await browser.selectNote(selected.id);
    const search = browser.search('keep');
    if (dispose) browser.dispose(); else await browser.search('   ');
    const snapshot = browser.getSnapshot();
    pending.reject(new Error('Late failure'));
    await search;
    expect(browser.getSnapshot()).toBe(snapshot);
    expect(browser.getSnapshot().note).toEqual(selected);
    expect(browser.getSnapshot().searchError).toBeNull();
    browser.dispose();
  }
});

test('one failing folder reports incomplete results while other accounts remain searchable', async () => {
  const match = note('match', 'Match');
  const browser = createAppleNotesBrowser(api({ list: async folderId => {
    if (folderId === 'google') throw new Error('Permission denied');
    return { notes: folderId === 'empty' ? [match] : [], nextOffset: null };
  } }), true);
  await browser.refresh();
  await browser.search('match');
  expect(browser.getSnapshot().searchResults).toEqual([{ folderId: 'empty', notes: [match] }]);
  expect(browser.getSnapshot().searchError).toContain('Google / Work / Notes: Permission denied');
  expect(browser.getSnapshot().searching).toBe(false);
  browser.dispose();
});

test('invalid pagination stops a folder and duplicate note ids are not repeated', async () => {
  const match = note('match', 'Match');
  const offsets: number[] = [];
  const browser = createAppleNotesBrowser(api({ list: async (folderId, offset = 0) => {
    if (folderId !== 'google') return { notes: [], nextOffset: null };
    offsets.push(offset);
    return { notes: [match, match], nextOffset: 100 };
  } }), true);
  await browser.refresh();
  await browser.search('match');
  expect(offsets).toEqual([0, 100]);
  expect(browser.getSnapshot().searchResults).toEqual([{ folderId: 'google', notes: [match] }]);
  expect(browser.getSnapshot().searchError).toContain('invalid page');
  browser.dispose();
});

test('refresh reruns the active search and edits or deletions update its results', async () => {
  let title = 'Before';
  const browser = createAppleNotesBrowser(api({ list: async folderId => ({
    notes: folderId === 'google' ? [note('match', title)] : [], nextOffset: null,
  }) }), true);
  await browser.refresh();
  await browser.search('after');
  expect(browser.getSnapshot().searchResults).toEqual([]);
  title = 'After';
  await browser.refresh();
  expect(browser.getSnapshot().searchResults[0]?.notes[0]?.title).toBe('After');
  browser.applyUpdated(note('match', 'Changed'));
  expect(browser.getSnapshot().searchResults).toEqual([]);
  await browser.search('changed');
  expect(browser.getSnapshot().searchResults[0]?.notes[0]?.title).toBe('Changed');
  browser.removeDeleted('google', 'match');
  expect(browser.getSnapshot().searchResults).toEqual([]);
  browser.dispose();
});

test('typing is debounced and clearing before the delay avoids scanning folders', async () => {
  let lists = 0;
  const browser = createAppleNotesBrowser(api({ list: async () => {
    lists += 1;
    return { notes: [note('match', 'Match')], nextOffset: null };
  } }), true);
  await browser.refresh();
  const old = browser.search('ma', { debounce: true });
  const current = browser.search('match', { debounce: true });
  expect(lists).toBe(1);
  await Promise.all([old, current]);
  expect(lists).toBe(3);
  expect(browser.getSnapshot().searchResults).toHaveLength(3);
  const pending = browser.search('match', { debounce: true });
  await browser.search('');
  await pending;
  expect(browser.getSnapshot()).toMatchObject({ searchQuery: '', searchResults: [], searching: false });
  expect(lists).toBe(3);
  browser.dispose();
});
