import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StickyNotesStore } from '../lib/sticky-notes-store.mts';
import { visibleStickyNoteBounds } from '../lib/sticky-notes-runtime.mts';
import { stickyNoteContent, stickyNoteId } from '../shared/sticky-notes';
import { StickyNoteDraft } from '../frontend/src/features/sticky-notes/stickyNoteDraft';

async function rejects(operation: Promise<unknown>, pattern: RegExp) {
  let rejected = false;
  try { await operation; } catch (error) { rejected = true; expect(String(error)).toMatch(pattern); }
  expect(rejected).toBe(true);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

test('notes survive restart with independent contents, bounds and pin state; deleting is explicit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-notes-'));
  try {
    const store = new StickyNotesStore(directory);
    const first = await store.create(), second = await store.create();
    const bounds = { x: -900, y: 50, width: 400, height: 500 };
    await Promise.all([store.save(first.id, { title: 'Idea', text: '한글 메모\nsecond line' }),
      store.move(first.id, bounds), store.pin(first.id, true), store.save(second.id, { title: '', text: 'Other note' })]);
    const restored = new StickyNotesStore(directory);
    expect(await restored.get(first.id)).toMatchObject({ title: 'Idea', text: '한글 메모\nsecond line', pinned: true, bounds });
    expect((await restored.list()).length).toBe(2);
    expect((await restored.get(second.id)).text).toBe('Other note');
    await restored.delete(first.id);
    await rejects(restored.save(first.id, { title: '', text: 'late save' }), /no longer exists/);
    expect((await restored.list()).map(note => note.id)).toEqual([second.id]);
    expect((await readdir(directory)).filter(file => file.endsWith('.tmp'))).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid content, path traversal and malformed persisted notes are not silently accepted', async () => {
  expect(() => stickyNoteId('../escape')).toThrow();
  expect(() => stickyNoteContent({ title: '', text: 'x'.repeat(200_001) })).toThrow();
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-notes-invalid-'));
  try {
    const store = new StickyNotesStore(directory);
    const note = await store.create();
    await rejects(store.pin(note.id, 'true'), /Invalid pin/);
    expect((await store.get(note.id)).pinned).toBe(false);
    await store.save(note.id, { title: '', text: 'saved' });
    await writeFile(path.join(directory, `${note.id}.json`), 'broken');
    await rejects(new StickyNotesStore(directory).list(), /JSON/);
    expect(await readFile(path.join(directory, `${note.id}.json`), 'utf8')).toBe('broken');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('empty drafts never reach disk or the list, including pin and position changes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-notes-empty-'));
  try {
    const store = new StickyNotesStore(directory);
    const note = await store.create();
    await store.pin(note.id, true);
    await store.move(note.id, { x: 1, y: 1, width: 360, height: 420 });
    await store.save(note.id, { title: '  ', text: '\n\t' });
    expect(await readdir(directory)).toEqual([]);
    expect(await store.list()).toEqual([]);
    await store.delete(note.id);
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('typing persists a draft and clearing both fields removes its saved copy', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-notes-cleared-'));
  try {
    const store = new StickyNotesStore(directory);
    const note = await store.create();
    await store.save(note.id, { title: 'Title only', text: '' });
    expect((await new StickyNotesStore(directory).list()).length).toBe(1);
    await store.save(note.id, { title: '', text: '' });
    expect(await readdir(directory)).toEqual([]);
    expect(await store.list()).toEqual([]);
    await store.save(note.id, { title: '', text: 'Write again' });
    expect((await new StickyNotesStore(directory).get(note.id)).text).toBe('Write again');
    const legacy = { ...note, id: '00000000-0000-4000-8000-000000000001' };
    await writeFile(path.join(directory, `${legacy.id}.json`), JSON.stringify(legacy));
    expect((await new StickyNotesStore(directory).list()).map(item => item.id)).toEqual([note.id]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('autosave coalesces edits during an in-flight write and close flush waits for the latest text', async () => {
  const gate = deferred();
  const writes: string[] = [];
  const draft = new StickyNoteDraft({ title: '', text: '' }, async value => {
    writes.push(value.text);
    if (writes.length === 1) await gate.promise;
  }, () => {});
  draft.update({ title: '', text: 'one' });
  const firstWrite = draft.flush();
  await Promise.resolve();
  draft.update({ title: '', text: 'two' });
  draft.update({ title: '', text: 'latest' });
  const close = draft.flush();
  expect(draft.dirty).toBe(true);
  gate.resolve();
  await Promise.all([firstWrite, close]);
  expect(writes).toEqual(['one', 'latest']);
  expect(draft.dirty).toBe(false);
});

test('a disk write failure does not publish unsaved content and a later write can recover', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-notes-write-'));
  const notes = path.join(directory, 'notes');
  try {
    const store = new StickyNotesStore(notes);
    const note = await store.create();
    await store.save(note.id, { title: '', text: 'original' });
    await rename(notes, path.join(directory, 'backup'));
    await writeFile(notes, 'blocks directory creation');
    await rejects(store.save(note.id, { title: '', text: 'latest' }), /EEXIST/);
    expect((await store.get(note.id)).text).toBe('original');
    await rm(notes);
    await rename(path.join(directory, 'backup'), notes);
    await store.save(note.id, { title: '', text: 'latest' });
    expect((await new StickyNotesStore(notes).get(note.id)).text).toBe('latest');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a failed save retains the draft for retry and prevents close flush from succeeding', async () => {
  let fail = true;
  const writes: string[] = [];
  const draft = new StickyNoteDraft({ title: '', text: '' }, async value => {
    if (fail) throw new Error('Disk unavailable');
    writes.push(value.text);
  }, () => {});
  draft.update({ title: '', text: 'keep me' });
  await rejects(draft.flush(), /Disk unavailable/);
  expect(draft.dirty).toBe(true);
  fail = false;
  await draft.flush();
  expect(writes).toEqual(['keep me']);
  expect(draft.dirty).toBe(false);
});

test('restored bounds fit the remaining monitor after a display disconnect', () => {
  expect(visibleStickyNoteBounds({ x: -1500, y: 1600, width: 1800, height: 1400 },
    { x: 0, y: 30, width: 1280, height: 720 })).toEqual({ x: 0, y: 30, width: 1280, height: 720 });
});

test('autosave waits until typing has stopped and sends one latest snapshot', async () => {
  const writes: string[] = [];
  const draft = new StickyNoteDraft({ title: '', text: '' }, async value => { writes.push(value.text); }, () => {});
  try {
    draft.update({ title: '', text: 'first' });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(writes).toEqual([]);
    draft.update({ title: '', text: 'latest' });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(writes).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(writes).toEqual(['latest']);
    expect(draft.dirty).toBe(false);
  } finally { draft.dispose(); }
});

test('selected deletion validates every id first and leaves unselected and failed notes intact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-notes-selected-'));
  try {
    const store = new StickyNotesStore(directory);
    const first = await store.create(), second = await store.create(), last = await store.create();
    for (const note of [first, second, last]) await store.save(note.id, { title: '', text: note.id });
    await rejects(store.deleteSelected([first.id, '../invalid']), /Invalid note ID/);
    expect((await store.list()).length).toBe(3);
    // A missing file is a failed delete, not permission to remove some other row.
    const secondPath = path.join(directory, `${second.id}.json`);
    await rename(secondPath, `${secondPath}.backup`);
    const result = await store.deleteSelected([second.id, first.id, first.id]);
    expect(result).toEqual({ deletedIds: [first.id], failedIds: [second.id] });
    expect(new Set((await store.list()).map(note => note.id))).toEqual(new Set([second.id, last.id]));
    await rename(`${secondPath}.backup`, secondPath);
    expect(await store.deleteSelected([second.id])).toEqual({ deletedIds: [second.id], failedIds: [] });
    expect((await new StickyNotesStore(directory).list()).map(note => note.id)).toEqual([last.id]);
    await rejects(store.save(first.id, { title: '', text: 'late debounce' }), /no longer exists/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
