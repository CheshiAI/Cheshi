import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexChatSavedTurns } from '../lib/codex-chat-saved-turns.mts';
import { CHAT_SAVED_TURN_MAX_TEXT, chatSavedTurnInput } from '../shared/chat-saved-turns.ts';

const directories: string[] = [];
const input = { threadId: 'thread', itemId: 'answer', sessionTitle: 'A conversation', userText: 'Question?',
  assistantText: '**Answer**\n\n```ts\nconst value = 1;\n```', createdAt: 1_778_000_000_000 };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cheshi-saved-turns-'));
  directories.push(root);
  const directory = join(root, 'saved-chat-turns');
  return { directory, store: new CodexChatSavedTurns(directory) };
}

async function expectFailure(operation: Promise<unknown>, message: RegExp) {
  let rejected = false;
  try { await operation; }
  catch (error) { rejected = true; expect(String(error)).toMatch(message); }
  expect(rejected).toBe(true);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('saves full turn snapshots and reloads them after restart', async () => {
  const { store, directory } = await fixture();
  expect(await store.list()).toEqual([]);
  const record = await store.save(input);
  expect(record).toMatchObject(input);
  expect(await new CodexChatSavedTurns(directory).list()).toEqual([record]);
  expect(await readdir(directory)).toEqual([`${record.id}.json`]);
});

test('deduplicates simultaneous saves and preserves the first saved snapshot', async () => {
  const { store } = await fixture();
  const [first, duplicate] = await Promise.all([store.save(input), store.save({ ...input, assistantText: 'Changed' })]);
  expect(duplicate).toEqual(first);
  expect(await store.list()).toEqual([first]);
  const other = await store.save({ ...input, threadId: 'another-thread' });
  expect(other.id).not.toBe(first.id);
  expect(await store.list()).toHaveLength(2);
});

test('captures input before the queue and keeps workspaces independent', async () => {
  const first = await fixture();
  const second = await fixture();
  const value = { ...input };
  const saving = first.store.save(value);
  value.assistantText = 'Later mutation';
  expect((await saving).assistantText).toBe(input.assistantText);
  expect(await second.store.list()).toEqual([]);
});

test('validates boundaries while allowing empty questions and long complete answers', () => {
  expect(chatSavedTurnInput({ ...input, userText: '', assistantText: 'x'.repeat(100_000) }).assistantText).toHaveLength(100_000);
  for (const value of [null, [], { ...input, threadId: '' }, { ...input, createdAt: NaN },
    { ...input, assistantText: '' }, { ...input, assistantText: 'x'.repeat(CHAT_SAVED_TURN_MAX_TEXT + 1) }]) {
    expect(() => chatSavedTurnInput(value)).toThrow('Invalid saved turn');
  }
});

test('preserves corrupt records and retries successfully after the file is repaired', async () => {
  const { store, directory } = await fixture();
  const record = await store.save(input);
  const path = join(directory, `${record.id}.json`);
  await writeFile(path, '{invalid');
  await expectFailure(store.list(), /invalid JSON/);
  await expectFailure(store.save(input), /invalid JSON/);
  expect(await readFile(path, 'utf8')).toBe('{invalid');
  await writeFile(path, JSON.stringify(record));
  expect(await store.list()).toEqual([record]);
});

test('rejects mismatched identities without overwriting the saved file', async () => {
  const { store, directory } = await fixture();
  const record = await store.save(input);
  const path = join(directory, `${record.id}.json`);
  const malformed = JSON.stringify({ ...record, threadId: 'other-thread' });
  await writeFile(path, malformed);
  await expectFailure(store.save(input), /Invalid saved turn identity/);
  expect(await readFile(path, 'utf8')).toBe(malformed);
});

test('deletes only the selected snapshot, survives restart, and allows an explicit save again', async () => {
  const { store, directory } = await fixture();
  const first = await store.save(input);
  const other = await store.save({ ...input, itemId: 'another-answer' });
  const queuedSave = store.save(input);
  const deleting = store.delete(first.id);
  expect(await queuedSave).toEqual(first);
  expect(await deleting).toEqual({ id: first.id });
  expect(await store.delete(first.id)).toEqual({ id: first.id });
  expect(await new CodexChatSavedTurns(directory).list()).toEqual([other]);
  expect(await store.save(input)).toMatchObject(input);
  expect(await store.list()).toHaveLength(2);
});

test('rejects unsafe deletion ids without touching saved records', async () => {
  const { store } = await fixture();
  const saved = await store.save(input);
  for (const id of [null, 1, '', '../outside', `${saved.id}/..`, `${saved.id}\n`, 'a'.repeat(63)]) {
    expect(() => store.delete(id)).toThrow('Invalid saved turn id');
  }
  expect(await store.list()).toEqual([saved]);
});

test('failed deletion preserves the record and permits retry', async () => {
  const { store, directory } = await fixture();
  const saved = await store.save(input);
  const source = await readFile(join(directory, `${saved.id}.json`), 'utf8');
  const blocked = join(directory, 'blocked');
  await rename(join(directory, `${saved.id}.json`), blocked);
  await mkdir(join(directory, `${saved.id}.json`));
  await expectFailure(store.delete(saved.id), /rm/);
  expect(await readFile(blocked, 'utf8')).toBe(source);
  await rm(join(directory, `${saved.id}.json`), { recursive: true });
  await rename(blocked, join(directory, `${saved.id}.json`));
  expect(await store.list()).toEqual([saved]);
  await store.delete(saved.id);
  expect(await store.list()).toEqual([]);
});
