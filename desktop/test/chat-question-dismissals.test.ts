import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatQuestionDismissals } from '../lib/chat-question-dismissals.mts';
import { createChatQuestionDismissalsIpc, registerChatQuestionDismissalsIpc } from '../lib/chat-question-dismissals-ipc.mts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-question-dismissals-'));
  directories.push(directory);
  return { directory, store: new ChatQuestionDismissals(directory) };
}
async function rejects(operation: () => unknown | Promise<unknown>) {
  let error: unknown;
  try { await operation(); } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(Error);
}

test('dismissals survive service recreation, are isolated by workspace and thread, and contain no conversation text', async () => {
  const { store, directory } = await fixture();
  const record = { questionId: 'question:["thread","turn","item"]', turnId: 'turn', itemId: 'item', action: 'skip' as const };
  expect(await store.list('thread')).toEqual([]);
  await store.save('thread', record);
  await store.flush();
  expect(await new ChatQuestionDismissals(directory).list('thread')).toEqual([record]);
  expect(await store.list('other')).toEqual([]);
  expect(await new ChatQuestionDismissals(join(directory, 'other-workspace')).list('thread')).toEqual([]);
  const [folder] = await readdir(directory);
  const [filename] = await readdir(join(directory, folder!));
  expect(JSON.parse(await readFile(join(directory, folder!, filename!), 'utf8'))).toEqual({ threadId: 'thread', ...record });
});

test('independent service instances save different questions without losing records or leaving temporary files', async () => {
  const { store, directory } = await fixture();
  const other = new ChatQuestionDismissals(directory);
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? store : other).save('thread', { questionId: `q${i}`, action: 'close' })));
  expect(await store.list('thread')).toHaveLength(20);
  const [folder] = await readdir(directory);
  expect((await readdir(join(directory, folder!))).every(name => name.endsWith('.json'))).toBe(true);
});

test('unrelated corrupt conversations are not read, and a corrupt current record fails visibly', async () => {
  const { store, directory } = await fixture();
  await store.save('broken', { questionId: 'q', action: 'skip' });
  const [folder] = await readdir(directory);
  const [filename] = await readdir(join(directory, folder!));
  await writeFile(join(directory, folder!, filename!), '{invalid');
  expect(await store.list('other')).toEqual([]);
  await rejects(() => store.list('broken'));
  expect(await readFile(join(directory, folder!, filename!), 'utf8')).toBe('{invalid');
});

test('invalid inputs reject, path-shaped identities stay beneath the store, and write failures are reported', async () => {
  const { store, directory } = await fixture();
  await rejects(() => store.list(''));
  await rejects(() => store.save('thread', { questionId: 'q', action: true }));
  await store.save('../outside', { questionId: '../../outside', action: 'answered' });
  expect((await readdir(directory)).every(name => /^[a-f0-9]{64}$/.test(name))).toBe(true);
  const file = join(directory, 'not-a-directory');
  await writeFile(file, 'keep');
  await rejects(() => new ChatQuestionDismissals(file).save('thread', { questionId: 'q', action: 'skip' }));
  expect(await readFile(file, 'utf8')).toBe('keep');
});

test('question persistence IPC rejects untrusted senders before reading or writing', async () => {
  type Options = Parameters<typeof registerChatQuestionDismissalsIpc>[0];
  type Handler = Parameters<Options['ipc']['handle']>[1];
  const handlers = new Map<string, Handler>();
  let allowed = true;
  const calls: unknown[][] = [];
  registerChatQuestionDismissalsIpc({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); } },
    assertSender: () => { if (!allowed) throw new Error('Untrusted sender'); },
    store: {
      async list(thread) { calls.push(['list', thread]); return []; },
      async save(thread, record) { calls.push(['save', thread, record]); return { questionId: 'q', action: 'skip' }; },
    },
  });
  const event = {} as Parameters<Handler>[0];
  await handlers.get('cheshi:list-chat-question-dismissals')!(event, 'thread');
  await handlers.get('cheshi:save-chat-question-dismissal')!(event, 'thread', { questionId: 'q', action: 'skip' });
  expect(calls).toHaveLength(2);
  allowed = false;
  await rejects(() => handlers.get('cheshi:list-chat-question-dismissals')!(event, 'thread'));
  await rejects(() => handlers.get('cheshi:save-chat-question-dismissal')!(event, 'thread', {}));
  expect(calls).toHaveLength(2);
});

test('workspace IPC startup restores records through a newly created service', async () => {
  const { directory } = await fixture();
  type Handler = Parameters<Parameters<typeof createChatQuestionDismissalsIpc>[0]['handle']>[1];
  const handlers = new Map<string, Handler>();
  const ipc = { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); } };
  const event = {} as Parameters<Handler>[0];
  const store = createChatQuestionDismissalsIpc(ipc, directory, () => {});
  const record = { questionId: 'q', action: 'skip' };
  await handlers.get('cheshi:save-chat-question-dismissal')!(event, 'thread', record);
  await store.flush();
  handlers.clear();
  createChatQuestionDismissalsIpc(ipc, directory, () => {});
  expect(await handlers.get('cheshi:list-chat-question-dismissals')!(event, 'thread')).toEqual([record]);
});
