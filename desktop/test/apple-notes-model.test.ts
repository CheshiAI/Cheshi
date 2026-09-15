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
    create: async () => ({ ok: true, value: { id: 'created', title: 'New note' } }), ...overrides };
}

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
