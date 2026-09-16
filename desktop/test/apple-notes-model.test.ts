import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppleNote, AppleNotesApi, AppleNotesPage } from '../shared/apple-notes.ts';
import { appleNoteAttachment, createAppleNotesBrowser } from '../frontend/src/features/notes/appleNotesModel';
import { prepareChatAttachmentTransfers } from '../shared/chat-attachment-import.ts';
import { ChatAttachmentStore } from '../lib/chat-attachment-store.mts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

const first: AppleNote = { id: 'first', title: '메모 / <title>', modifiedAt: '2026-09-16T00:00:00Z', locked: false, plaintext: 'original\n  text 😀' };
const second: AppleNote = { ...first, id: 'second', title: 'Another', plaintext: 'another' };

function api(overrides: Partial<AppleNotesApi> = {}): AppleNotesApi {
  return { available: true,
    folders: async () => [{ id: 'folder', name: 'Notes', account: 'iCloud', path: 'Notes', isDefault: true }],
    list: async () => ({ notes: [first, second], nextOffset: null }),
    read: async id => id === first.id ? first : second,
    document: async () => ({ ...first, html: '<p>Text</p>', attachmentCount: 0 }),
    update: async () => ({ ok: false, error: { code: 'unavailable', message: 'Unavailable' } }),
    delete: async id => ({ ok: true, value: { id } }),
    create: async () => ({ ok: true, value: { id: 'created', title: 'New note' } }), ...overrides };
}

test('saving patches the selected preview and list title without reloading the folder', async () => {
  let lists = 0;
  const browser = createAppleNotesBrowser(api({ list: async () => { lists += 1; return { notes: [first, second], nextOffset: null }; } }), true);
  await browser.refresh();
  await browser.selectNote(first.id);
  const saved = { ...first, title: 'Changed', plaintext: 'Changed body', createdAt: '2026-09-15T00:00:00.000Z', modifiedAt: '2026-09-16T00:00:01.000Z' };
  browser.applyUpdated(saved);
  expect(browser.getSnapshot().note).toEqual(saved);
  expect(browser.getSnapshot().notes.map(item => item.title)).toEqual(['Changed', second.title]);
  expect(browser.getSnapshot().notes[0]).toMatchObject({ createdAt: saved.createdAt, modifiedAt: saved.modifiedAt });
  expect(lists).toBe(1);
  browser.dispose();
  browser.applyUpdated({ ...saved, title: 'Late response' });
  expect(browser.getSnapshot().note?.title).toBe('Changed');
});

test('folder revisits immediately restore loaded pages and empty lists without requesting them again', async () => {
  const calls: string[] = [];
  const browser = createAppleNotesBrowser(api({ list: async (folderId, offset = 0) => {
    calls.push(`${folderId}:${offset}`);
    return folderId === 'empty' ? { notes: [], nextOffset: null }
      : offset === 0 ? { notes: [first], nextOffset: 100 } : { notes: [second], nextOffset: 200 };
  } }), true);
  await browser.selectFolder('folder');
  await browser.loadMore();
  await browser.selectFolder('empty');
  const loadingStates: boolean[] = [];
  browser.subscribe(() => loadingStates.push(browser.getSnapshot().loadingNotes));
  const revisit = browser.selectFolder('folder');
  expect(browser.getSnapshot()).toMatchObject({ notes: [first, second], nextOffset: 200, loadingNotes: false, refreshingNotes: false });
  await revisit;
  await browser.selectFolder('empty');
  expect(browser.getSnapshot()).toMatchObject({ notes: [], nextOffset: null, loadingNotes: false });
  expect(calls).toEqual(['folder:0', 'folder:100', 'empty:0']);
  expect(loadingStates.every(value => value === false)).toBe(true);
});

test('expired folders retain all visible pages until background revalidation finishes', async () => {
  let time = 0;
  let revalidating = false;
  const lastPage = createDeferred<AppleNotesPage>();
  const calls: number[] = [];
  const changed = { ...first, title: 'Updated externally' };
  const browser = createAppleNotesBrowser(api({ list: async (folderId, offset = 0) => {
    if (folderId === 'empty') return { notes: [], nextOffset: null };
    calls.push(offset);
    if (offset === 0) return { notes: [revalidating ? changed : first], nextOffset: 100 };
    return revalidating ? lastPage.promise : { notes: [second], nextOffset: null };
  } }), true, () => time);
  await browser.selectFolder('folder');
  await browser.loadMore();
  await browser.selectFolder('empty');
  time = 30_001; revalidating = true;
  const revisit = browser.selectFolder('folder');
  expect(browser.getSnapshot()).toMatchObject({ notes: [first, second], loadingNotes: false, refreshingNotes: true });
  await browser.loadMore();
  expect(browser.getSnapshot().notes).toEqual([first, second]);
  lastPage.resolve({ notes: [], nextOffset: null });
  await revisit;
  expect(browser.getSnapshot()).toMatchObject({ notes: [changed], nextOffset: null, loadingNotes: false, refreshingNotes: false });
  expect(calls).toEqual([0, 100, 0, 100]);
});

test('background errors retain cached results and retry when revisiting the expired folder', async () => {
  let time = 0;
  let failing = false;
  let calls = 0;
  const browser = createAppleNotesBrowser(api({ list: async () => {
    calls += 1;
    if (failing) throw new Error('Notes unavailable');
    return { notes: [first], nextOffset: null };
  } }), true, () => time);
  await browser.selectFolder('folder');
  time = 30_001; failing = true;
  await browser.selectFolder('folder');
  expect(browser.getSnapshot()).toMatchObject({ notes: [first], error: 'Notes unavailable', loadingNotes: false, refreshingNotes: false });
  failing = false;
  await browser.selectFolder('folder');
  expect(calls).toBe(3);
  expect(browser.getSnapshot().error).toBeNull();
});

test('creation reloads its target and manual refresh invalidates every cached folder', async () => {
  const calls: string[] = [];
  const browser = createAppleNotesBrowser(api({ list: async id => {
    calls.push(id); return { notes: [first], nextOffset: null };
  } }), true);
  await browser.refresh();
  await browser.selectFolder('other');
  await browser.selectFolder('folder', { forceRefresh: true });
  await browser.selectFolder('other');
  expect(calls).toEqual(['folder', 'other', 'folder']);
  await browser.refresh();
  await browser.selectFolder('other');
  expect(calls).toEqual(['folder', 'other', 'folder', 'folder', 'other']);
});

test('saved and deleted notes remain patched in cached lists after switching folders', async () => {
  let calls = 0;
  const browser = createAppleNotesBrowser(api({ list: async id => {
    calls += 1; return { notes: id === 'empty' ? [] : [first, second], nextOffset: null };
  } }), true);
  await browser.selectFolder('folder');
  browser.applyUpdated({ ...first, title: 'Saved title' });
  browser.removeDeleted('folder', second.id);
  await browser.selectFolder('empty');
  await browser.selectFolder('folder');
  expect(browser.getSnapshot().notes.map(note => note.title)).toEqual(['Saved title']);
  expect(calls).toBe(2);
});

test('late background results cannot overwrite a saved cache entry or repopulate it after refresh', async () => {
  let time = 0;
  let pendingPage: Promise<AppleNotesPage> | null = null;
  const browser = createAppleNotesBrowser(api({ list: async () => pendingPage ?? { notes: [first], nextOffset: null } }), true, () => time);
  await browser.refresh();
  time = 30_001;
  const stale = createDeferred<AppleNotesPage>(); pendingPage = stale.promise;
  const background = browser.selectFolder('folder');
  browser.applyUpdated({ ...first, title: 'Saved title' });
  stale.resolve({ notes: [first], nextOffset: null });
  await background;
  expect(browser.getSnapshot().notes[0]?.title).toBe('Saved title');
  const old = createDeferred<AppleNotesPage>(); pendingPage = old.promise;
  const older = browser.selectFolder('folder');
  pendingPage = null;
  await browser.refresh();
  old.resolve({ notes: [second], nextOffset: null });
  await older;
  await browser.selectFolder('folder');
  expect(browser.getSnapshot().notes).toEqual([first]);
});

test('only reads the selected note and ignores a late previous preview', async () => {
  const pending = createDeferred<AppleNote>();
  const calls: string[] = [];
  const browser = createAppleNotesBrowser(api({ read: async id => {
    calls.push(id);
    return id === 'first' ? pending.promise : second;
  } }), true);
  await browser.refresh();
  expect(calls).toEqual([]);
  const old = browser.selectNote('first');
  await browser.selectNote('second');
  pending.resolve(first);
  await old;
  expect(browser.getSnapshot().note?.id).toBe('second');
  expect(browser.getSnapshot().loadingNote).toBe(false);
});

test('switching folders or closing a dialog invalidates pending reads', async () => {
  const pending = createDeferred<AppleNotesPage>();
  const browser = createAppleNotesBrowser(api({ list: async id => id === 'old' ? pending.promise : { notes: [second], nextOffset: null } }), true);
  const old = browser.selectFolder('old');
  await browser.selectFolder('new');
  pending.resolve({ notes: [first], nextOffset: null });
  await old;
  expect(browser.getSnapshot().notes).toEqual([second]);
  expect(browser.getSnapshot().folderId).toBe('new');

  const reading = createDeferred<AppleNote>();
  const another = createAppleNotesBrowser(api({ read: async () => reading.promise }), true);
  await another.refresh();
  const operation = another.selectNote('first');
  another.dispose();
  reading.resolve(first);
  await operation;
  expect(another.getSnapshot().note).toBeNull();
});

test('keeps protected notes unavailable and does not invoke their read operation', async () => {
  let calls = 0;
  const browser = createAppleNotesBrowser(api({
    list: async () => ({ notes: [{ ...first, locked: true }], nextOffset: null }),
    read: async () => { calls += 1; return first; },
  }), true);
  await browser.refresh();
  await browser.selectNote('first');
  expect(calls).toBe(0);
  expect(browser.getSnapshot().error).toContain('password protected');
  expect(browser.getSnapshot().note).toBeNull();
});

test('save folder selection does not load note metadata or content', async () => {
  let calls = 0;
  const browser = createAppleNotesBrowser(api({ list: async () => { calls += 1; throw new Error('Unexpected list'); } }), false);
  await browser.refresh();
  expect(browser.getSnapshot().folderId).toBe('folder');
  expect(calls).toBe(0);
});

test('load more merges duplicates and rejects a non-advancing page', async () => {
  const browser = createAppleNotesBrowser(api({ list: async (_id, offset) => offset === 100
    ? { notes: [first, second], nextOffset: null } : { notes: [first], nextOffset: 100 } }), true);
  await browser.refresh();
  await browser.loadMore();
  expect(browser.getSnapshot().notes).toEqual([first, second]);
  expect(browser.getSnapshot().nextOffset).toBeNull();
  const invalid = createAppleNotesBrowser(api({ list: async () => ({ notes: [], nextOffset: 0 }) }), true);
  await invalid.refresh();
  expect(invalid.getSnapshot().error).toContain('invalid page');
});

test('refresh clears the old preview and reports permission failures', async () => {
  let fail = false;
  const browser = createAppleNotesBrowser(api({ folders: async () => {
    if (fail) throw new Error('Allow Notes in Automation.');
    return [{ id: 'folder', name: 'Notes', account: 'iCloud', path: 'Notes', isDefault: true }];
  } }), true);
  await browser.refresh();
  await browser.selectNote('first');
  expect(browser.getSnapshot().note).toEqual(first);
  fail = true;
  await browser.refresh();
  expect(browser.getSnapshot().note).toBeNull();
  expect(browser.getSnapshot().folderId).toBe('');
  expect(browser.getSnapshot().error).toContain('Automation');
});

test('initial loading permits cached data while manual refresh requests fresh data', async () => {
  const requests: (boolean | undefined)[] = [];
  const browser = createAppleNotesBrowser(api({ folders: async forceRefresh => {
    requests.push(forceRefresh);
    return [{ id: 'folder', name: 'Notes', account: 'iCloud', path: 'Notes', isDefault: true }];
  } }), true);
  await browser.refresh(false);
  await browser.refresh();
  expect(requests).toEqual([false, true]);
});

test('deletion removes one row without fetching and adjusts the next page offset once', async () => {
  const third = { ...first, id: 'third' };
  const notes = [first, second, third];
  const offsets: number[] = [];
  const browser = createAppleNotesBrowser(api({ list: async (_folderId, offset = 0) => {
    offsets.push(offset);
    return { notes: notes.slice(offset, offset + 2), nextOffset: offset + 2 < notes.length ? offset + 2 : null };
  } }), true);
  await browser.refresh();
  await browser.selectNote(first.id);
  const folders = browser.getSnapshot().folders;
  notes.shift();
  browser.removeDeleted('folder', first.id);
  browser.removeDeleted('folder', first.id);
  expect(offsets).toEqual([0]);
  expect(browser.getSnapshot()).toMatchObject({ notes: [second], selectedId: '', note: null, nextOffset: 1, loadingNotes: false });
  expect(browser.getSnapshot().folders).toBe(folders);
  await browser.loadMore();
  expect(offsets).toEqual([0, 1]);
  expect(browser.getSnapshot().notes).toEqual([second, third]);
  expect(browser.getSnapshot().nextOffset).toBeNull();
});

test('deletion preserves another preview and ignores acknowledgements for another folder or disposed view', async () => {
  const browser = createAppleNotesBrowser(api(), true);
  await browser.refresh();
  await browser.selectNote(second.id);
  const preview = browser.getSnapshot().note;
  browser.removeDeleted('folder', first.id);
  expect(browser.getSnapshot().note).toBe(preview);
  expect(browser.getSnapshot().selectedId).toBe(second.id);
  const snapshot = browser.getSnapshot();
  browser.removeDeleted('another-folder', second.id);
  expect(browser.getSnapshot()).toBe(snapshot);
  browser.dispose();
  browser.removeDeleted('folder', second.id);
  expect(browser.getSnapshot()).toBe(snapshot);
});

test('late list and preview responses cannot restore a deleted note', async () => {
  const page = createDeferred<AppleNotesPage>();
  const read = createDeferred<AppleNote>();
  const browser = createAppleNotesBrowser(api({
    list: async (_folderId, offset = 0) => offset === 0 ? { notes: [first, second], nextOffset: 2 } : page.promise,
    read: async () => read.promise,
  }), true);
  await browser.refresh();
  const reading = browser.selectNote(first.id);
  const loading = browser.loadMore();
  browser.removeDeleted('folder', first.id);
  page.resolve({ notes: [first], nextOffset: null });
  read.resolve(first);
  await Promise.all([reading, loading]);
  expect(browser.getSnapshot()).toMatchObject({ notes: [second], note: null, selectedId: '', nextOffset: 1, loadingNotes: false, loadingNote: false });
});

test('deleting the final row leaves an empty completed list without loading', async () => {
  let calls = 0;
  const browser = createAppleNotesBrowser(api({ list: async () => { calls += 1; return { notes: [first], nextOffset: null }; } }), true);
  await browser.refresh();
  browser.removeDeleted('folder', first.id);
  expect(browser.getSnapshot()).toMatchObject({ notes: [], nextOffset: null, loadingNotes: false });
  expect(calls).toBe(1);
});

test('attaches the preview snapshot through the existing byte transfer and private attachment store', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cheshi-apple-note-'));
  try {
    const file = appleNoteAttachment(first);
    expect(file.name).not.toMatch(/[\/\\<>]/);
    expect(file.name.endsWith('.txt')).toBe(true);
    const transfers = await prepareChatAttachmentTransfers([file], () => '');
    const store = new ChatAttachmentStore({ directory });
    const attachments = await store.importTransferredFiles(transfers);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.kind).toBe('file');
    expect(await readFile(attachments[0]!.path, 'utf8')).toBe(first.plaintext);
    expect(() => appleNoteAttachment({ ...first, locked: true })).toThrow('Password-protected');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('created notes become selected immediately and invalidate late folder loads', async () => {
  const pending = createDeferred<AppleNotesPage>();
  let calls = 0;
  const created = { ...first, id: 'created', title: 'Created', createdAt: first.modifiedAt };
  const browser = createAppleNotesBrowser(api({ list: async () => { calls += 1; return calls === 1
    ? { notes: [first], nextOffset: 100 } : pending.promise; } }), true);
  await browser.selectFolder('folder');
  const loading = browser.loadMore();
  browser.applyCreated('folder', created);
  expect(browser.getSnapshot()).toMatchObject({ folderId: 'folder', selectedId: 'created', note: created,
    nextOffset: 101, loadingNotes: false });
  browser.applyCreated('folder', created);
  expect(browser.getSnapshot().nextOffset).toBe(101);
  pending.resolve({ notes: [second], nextOffset: null });
  await loading;
  expect(browser.getSnapshot().notes.map(note => note.id)).toEqual(['created', 'first']);
  browser.dispose();
  browser.applyCreated('other', second);
  expect(browser.getSnapshot().selectedId).toBe('created');
});

test('a completed creation during remount keeps its selection while folder metadata finishes loading', async () => {
  const pending = createDeferred<Awaited<ReturnType<AppleNotesApi['folders']>>>();
  const notesApi = api({ folders: async () => pending.promise });
  const browser = createAppleNotesBrowser(notesApi, true);
  const refreshing = browser.refresh(false);
  browser.applyCreated('folder', first);
  expect(browser.getSnapshot()).toMatchObject({ selectedId: first.id, note: first, loadingFolders: true });
  const folders = await api().folders();
  pending.resolve(folders);
  await refreshing;
  await Promise.resolve();
  expect(browser.getSnapshot()).toMatchObject({ folders, selectedId: first.id, note: first, loadingFolders: false });
});
