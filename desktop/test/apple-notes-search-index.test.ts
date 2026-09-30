import { afterEach, expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NotesSearchStore } from '../lib/apple-notes-search-store.mts';
import { AppleNotesSearch, type NotesSearchSource } from '../lib/apple-notes-search.mts';
import { AppleNotesService } from '../lib/apple-notes-service.mts';
import type { AppleNote } from '../shared/apple-notes.ts';

const folders = [{ id: 'folder', name: 'Notes', path: 'Notes', account: 'iCloud', isDefault: true }];
const note = (id: string, plaintext = '본문 읽기', title = 'Title'): AppleNote => ({ id, title, plaintext, locked: false, modifiedAt: '2026-09-30T00:00:00Z' });
const directories: string[] = [];
const stores: NotesSearchStore[] = [];
const searches: AppleNotesSearch[] = [];
afterEach(async () => {
  await Promise.all(searches.splice(0).map(search => search.stop()));
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function filename() { const dir = await mkdtemp(join(tmpdir(), 'cheshi-notes-index-')); directories.push(dir); return join(dir, 'search.sqlite'); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for note indexing.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('indexing creates no periodic timer and only mutations or explicit refresh rescan after startup', async () => {
  const interval = spyOn(globalThis, 'setInterval');
  let scans = 0;
  let current = note('one');
  const search = new AppleNotesSearch(await filename(), {
    folders: async () => { scans++; return folders; },
    list: async () => ({ notes: [current], nextOffset: null }), read: async () => current,
  });
  searches.push(search);
  try {
    await search.start(); await search.synchronize();
    expect(scans).toBe(1);
    for (let i = 0; i < 3; i++) {
      search.status(); await search.search({ query: '읽기' });
    }
    expect(scans).toBe(1);
    current = { ...current, plaintext: 'Changed', modifiedAt: '2026-10-01T00:00:00Z' };
    await search.invalidate(current.id); await search.synchronize();
    expect(scans).toBe(2);
    expect((await search.search({ query: 'Changed' })).total).toBe(1);
    await search.search({ query: '', refresh: true }); await search.synchronize();
    expect(scans).toBe(3);
    expect(interval).not.toHaveBeenCalled();
  } finally { interval.mockRestore(); }
});

test('returning from another app coalesces refreshes and shutdown removes activation work', async () => {
  const events = new EventEmitter();
  let scans = 0;
  const service = new AppleNotesService({ platform: 'darwin', activationEvents: events, searchFilename: await filename(),
    execute: async () => { scans++; return '{"ok":true,"value":[]}'; } });
  const ready = () => { const reply = service.searchStatus(); return reply.ok && reply.value.state === 'ready'; };
  try {
    await service.start(); await service.start(); await waitUntil(ready);
    expect(scans).toBe(1);
    expect(events.listenerCount('did-become-active')).toBe(1);
    events.emit('did-become-active'); // Initial activation and in-app focus do not rescan.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(scans).toBe(1);
    for (let i = 0; i < 3; i++) {
      events.emit('did-resign-active'); events.emit('did-become-active');
    }
    await waitUntil(() => scans === 2 && ready());
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(scans).toBe(2);
    events.emit('did-resign-active'); events.emit('did-become-active');
    await service.stop();
    expect(events.listenerCount('did-become-active')).toBe(0);
    expect(events.listenerCount('did-resign-active')).toBe(0);
    events.emit('did-resign-active'); events.emit('did-become-active');
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(scans).toBe(2);
  } finally { await service.stop(); }
});

test('startup indexes without a search, while status and normal queries never initiate a scan', async () => {
  const gate = deferred<AppleNote>();
  const reading = deferred<void>();
  let scans = 0;
  const search = new AppleNotesSearch(await filename(), {
    folders: async () => { scans++; return folders; },
    list: async () => ({ notes: [note('one')], nextOffset: null }),
    read: async () => { reading.resolve(); return gate.promise; },
  });
  searches.push(search);
  expect(search.status().state).toBe('idle');
  await search.search({ query: '' });
  expect(scans).toBe(0);
  await search.start(); await search.start(); await reading.promise;
  expect(scans).toBe(1);
  expect(search.status()).toMatchObject({ state: 'building', completed: 0, pending: 1 });
  await search.search({ query: '읽기' });
  expect(scans).toBe(1);
  gate.resolve(note('one')); await search.synchronize();
  expect(search.status()).toMatchObject({ state: 'ready', completed: 1, pending: 1 });
  expect((await search.search({ query: '읽기' })).total).toBe(1);
  expect(scans).toBe(1);
});

test('service startup runs the index without opening Memo and status reads do not touch Notes', async () => {
  const started = deferred<void>();
  const foldersReply = deferred<string>();
  let executions = 0;
  const service = new AppleNotesService({ platform: 'darwin', searchFilename: await filename(), execute: async () => {
    executions++; started.resolve(); return foldersReply.promise;
  } });
  try {
    expect(service.searchStatus()).toMatchObject({ ok: true, value: { state: 'idle' } });
    expect(executions).toBe(0);
    await service.start(); await started.promise;
    expect(service.searchStatus()).toMatchObject({ ok: true, value: { state: 'building' } });
    await service.start();
    expect(executions).toBe(1);
  } finally {
    foldersReply.resolve('{"ok":true,"value":[]}');
    await service.stop();
  }
});

test('persistent Unicode gram index verifies exact title/body matches, snippets and locked data removal', async () => {
  const path = await filename();
  let store = await NotesSearchStore.open(path);
  store.put('folder', note('one', 'KeepCase 읽기 한글 😀🙂 abc---bcd', 'Button'), true);
  store.complete(folders);
  for (const query of ['읽', '읽기', '한글', '😀🙂', 'BUTTON', 'button 읽기']) expect(store.query({ query }).total).toBe(1);
  expect(store.query({ query: 'abcd' }).total).toBe(0);
  expect(store.query({ query: "' OR 1=1 --" }).total).toBe(0);
  expect(store.query({ query: '읽기' }).hits[0]?.snippet).toContain('KeepCase');
  store.close();
  store = await NotesSearchStore.open(path); stores.push(store);
  expect(store.query({ query: '읽기' }).total).toBe(1);
  store.put('folder', { ...note('one'), title: 'Locked', locked: true }, true);
  expect(store.query({ query: '읽기' }).total).toBe(0);
  expect(store.query({ query: 'locked' }).hits[0]).toMatchObject({ locked: true });
  expect(store.query({ query: 'locked' }).hits[0]?.snippet).toBeUndefined();
  store.remove(['one']);
  expect(store.query({ query: 'locked' }).total).toBe(0);
});

test('results paginate beyond 100 and reject a cursor after indexed data changes', async () => {
  const store = await NotesSearchStore.open(await filename()); stores.push(store);
  for (let i = 0; i < 125; i++) store.put('folder', note(`note-${i}`, 'needle'), true);
  store.complete(folders);
  const first = store.query({ query: 'needle' });
  expect(first.total).toBe(125); expect(first.hits).toHaveLength(100); expect(first.nextOffset).toBe(100);
  const next = store.query({ query: 'needle', offset: 100, version: first.version });
  expect(next.hits).toHaveLength(25); expect(next.nextOffset).toBeNull();
  expect(new Set([...first.hits, ...next.hits].map(hit => hit.id)).size).toBe(125);
  store.remove([first.hits[0]!.id]);
  expect(() => store.query({ query: 'needle', offset: 100, version: first.version })).toThrow('changed');
});

test('incremental source sync follows all pages and rereads only changed notes, including moves and deletion', async () => {
  let currentFolder = folders[0]!;
  let notes = [note('one'), note('two', 'Other body'), { ...note('locked'), locked: true }];
  const reads: string[] = [];
  const offsets: number[] = [];
  const source: NotesSearchSource = {
    folders: async () => [currentFolder],
    list: async (_id, offset) => { offsets.push(offset); return { notes: notes.slice(offset, offset + 1), nextOffset: offset + 1 < notes.length ? offset + 1 : null }; },
    read: async id => { reads.push(id); return notes.find(note => note.id === id)!; },
  };
  const search = new AppleNotesSearch(await filename(), source); searches.push(search);
  await search.synchronize();
  expect(offsets).toEqual([0, 1, 2]); expect(reads).toEqual(['one', 'two']);
  expect((await search.search({ query: '읽기' })).total).toBe(1);
  await search.synchronize(); expect(reads).toHaveLength(2);
  notes = [{ ...notes[0]!, plaintext: 'Changed text', modifiedAt: '2026-10-01T00:00:00Z' }, notes[2]!];
  await search.synchronize();
  expect(reads).toEqual(['one', 'two', 'one']);
  expect((await search.search({ query: '읽기' })).total).toBe(0);
  expect((await search.search({ query: 'Changed' })).total).toBe(1);
  expect((await search.search({ query: 'Other' })).total).toBe(0);
  currentFolder = { ...currentFolder, id: 'moved', account: 'Local' };
  await search.synchronize();
  expect((await search.search({ query: 'Changed' })).hits[0]?.folderId).toBe('moved');
  expect(reads).toEqual(['one', 'two', 'one', 'one']);
});

test('queries keep working during a slow refresh and mutation invalidation ignores the obsolete read', async () => {
  const gate = deferred<AppleNote>();
  const started = deferred<void>();
  let original = note('one');
  let slow = false;
  const source: NotesSearchSource = { folders: async () => folders,
    list: async () => ({ notes: [original, note('keep', 'Retained')], nextOffset: null }),
    read: async id => { if (id === 'keep') return note('keep', 'Retained'); if (slow) { started.resolve(); return gate.promise; } return original; } };
  const search = new AppleNotesSearch(await filename(), source); searches.push(search);
  await search.synchronize();
  original = { ...original, modifiedAt: '2026-10-01T00:00:00Z' }; slow = true;
  const sync = search.synchronize(); await started.promise;
  expect((await search.search({ query: 'Retained' })).hits[0]?.id).toBe('keep');
  await search.invalidate('one');
  slow = false; original = { ...original, plaintext: 'Fresh body', modifiedAt: '2026-10-02T00:00:00Z' };
  gate.resolve({ ...note('one', 'Obsolete'), modifiedAt: '2026-10-01T00:00:00Z' }); await sync;
  await search.synchronize();
  expect((await search.search({ query: 'Obsolete' })).total).toBe(0);
  expect((await search.search({ query: 'Fresh' })).total).toBe(1);
});

test('persisted results reopen without rereading bodies and permission loss clears private search data', async () => {
  const path = await filename(); let reads = 0; let denied = false;
  const source: NotesSearchSource = { folders: async () => {
    if (denied) throw Object.assign(new Error('Permission denied'), { name: 'AppleNotes:permission' }); return folders;
  }, list: async () => ({ notes: [note('one')], nextOffset: null }), read: async () => { reads++; return note('one'); } };
  const first = new AppleNotesSearch(path, source); await first.synchronize(); await first.stop();
  const second = new AppleNotesSearch(path, source); searches.push(second);
  expect((await second.search({ query: '읽기' })).total).toBe(1);
  await second.synchronize(); expect(reads).toBe(1);
  denied = true; await second.synchronize();
  const result = await second.search({ query: '읽기' });
  expect(result.total).toBe(0); expect(result.state).toBe('error'); expect(result.error).toContain('Permission denied');
});

test('failed body reads expose incomplete search and discard outdated text', async () => {
  let failing = false;
  const source: NotesSearchSource = { folders: async () => folders,
    list: async () => ({ notes: [{ ...note('one'), modifiedAt: failing ? '' : note('one').modifiedAt }], nextOffset: null }),
    read: async () => { if (failing) throw new Error('Unavailable'); return note('one'); } };
  const search = new AppleNotesSearch(await filename(), source); searches.push(search);
  await search.synchronize(); failing = true; await search.synchronize();
  const result = await search.search({ query: '읽기' });
  expect(result.total).toBe(0); expect(result.state).toBe('error'); expect(result.error).toContain('incomplete');
});
