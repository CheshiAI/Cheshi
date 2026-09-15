import { expect, test } from 'bun:test';
import { createFallbackQuestionStore } from '../frontend/src/features/chat/chatFallbackQuestionStore';
import type { ChatQuestionDismissalsApi, ChatQuestionDismissal } from '../shared/chat-question-dismissals';
import type { ChatUserInputRequest } from '../shared/chat-user-input';
import { fallbackQuestionRequest } from '../frontend/src/features/chat/chatQuestionChoices';

const question = (threadId = 'thread', id = 'q'): ChatUserInputRequest => ({
  id, threadId, turnId: null, kind: 'questions', isBlocking: false,
  questions: [{ id: 'answer', header: '', question: 'Which fruit?', isOther: true, isSecret: false, options: null }],
});
const answer = { action: 'accept' as const, answers: { answer: ['apple'] } };
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const disk = new Map<string, ChatQuestionDismissal[]>();
  const reads: string[] = [];
  let writeFails = false;
  let readFails = false;
  let sends = 0;
  const api: ChatQuestionDismissalsApi = {
    async list(thread) { reads.push(thread); if (readFails) throw new Error('read'); return disk.get(thread) ?? []; },
    async save(thread, record) {
      if (writeFails) throw new Error('write');
      disk.set(thread, [...(disk.get(thread) ?? []).filter(item => item.questionId !== record.questionId), record]);
      return record;
    },
  };
  return { disk, reads, api, sends: () => sends,
    failWrite: (value: boolean) => { writeFails = value; }, failRead: (value: boolean) => { readFails = value; },
    create: () => createFallbackQuestionStore(async () => { sends++; return { status: 'accepted' }; }, api),
  };
}

test('new dismissal records contain turn and item identities, remain isolated by turn, and read legacy saves', async () => {
  const candidate = (turnId: string) => fallbackQuestionRequest([
    { id: 'item', turnId, kind: 'assistant', createdAt: 1, text: 'Which fruit?\n\n- Apple\n- Strawberry' },
  ], 'thread')!;
  const f = fixture();
  let store = f.create();
  store.sync('thread', candidate('turn'), false); await settle();
  expect(await store.respond(candidate('turn').id, { action: 'decline' })).toBe(true);
  expect(f.disk.get('thread')).toEqual([{ questionId: candidate('turn').id, action: 'skip', turnId: 'turn', itemId: 'item' }]);
  store.setActive(false);
  store = f.create(); store.sync('thread', candidate('turn'), false); await settle();
  expect(store.getSnapshot().request).toBeNull();
  store.sync('thread', candidate('next-turn'), false);
  expect(store.getSnapshot().request?.turnId).toBe('next-turn');
  store.setActive(false);
  f.disk.set('thread', [{ questionId: 'question:thread:item', action: 'skip' }]);
  store = f.create(); store.sync('thread', candidate('turn'), false); await settle();
  expect(store.getSnapshot().request).toBeNull();
});

test.each(['decline', 'cancel'] as const)('%s survives reopening the store and still permits new questions', async action => {
  const f = fixture();
  let store = f.create();
  store.sync('thread', question(), false);
  expect(store.getSnapshot().request).toBeNull();
  await settle();
  expect(store.getSnapshot().request?.id).toBe('q');
  expect(await store.respond('q', { action })).toBe(true);
  store.setActive(false);
  store = f.create();
  store.sync('thread', question(), false);
  await settle();
  expect(store.getSnapshot().request).toBeNull();
  store.sync('thread', question('thread', 'new'), false);
  expect(store.getSnapshot().request?.id).toBe('new');
  expect(f.sends()).toBe(0);
});

test('switching conversations releases old records and reloads only the selected thread', async () => {
  const f = fixture();
  f.disk.set('thread', [{ questionId: 'q', action: 'skip' }]);
  const store = f.create();
  store.sync('thread', question(), false); await settle();
  store.sync('other', question('other'), false); await settle();
  expect(store.getSnapshot().request?.threadId).toBe('other');
  f.disk.set('thread', []);
  store.sync('thread', question(), false); await settle();
  expect(store.getSnapshot().request?.id).toBe('q');
  expect(f.reads).toEqual(['thread', 'other', 'thread']);
  store.setActive(false);
  expect(store.getSnapshot().request).toBeNull();
});

test('late restore results cannot hide a different thread or revive an unmounted card', async () => {
  const first = createDeferred<ChatQuestionDismissal[]>();
  const second = createDeferred<ChatQuestionDismissal[]>();
  const f = fixture();
  f.api.list = thread => thread === 'thread' ? first.promise : second.promise;
  const store = f.create();
  store.sync('thread', question(), false);
  store.sync('other', question('other'), false);
  second.resolve([]); await settle();
  first.resolve([{ questionId: 'q', action: 'skip' }]); await settle();
  expect(store.getSnapshot().request?.threadId).toBe('other');
  store.setActive(false);
  await settle();
  expect(store.getSnapshot().request).toBeNull();
});

test('failed restoration hides unverified cards until an explicit retry succeeds', async () => {
  const f = fixture(); f.failRead(true);
  const store = f.create();
  store.sync('thread', question(), false); await settle();
  expect(store.getSnapshot().request).toBeNull();
  expect(store.getSnapshot().restoreError).toContain('restore');
  f.failRead(false);
  await store.retryRestore();
  expect(store.getSnapshot().request?.id).toBe('q');
});

test('unmounting discards a pending restore and reopening reloads from disk', async () => {
  const deferred = createDeferred<ChatQuestionDismissal[]>();
  const f = fixture();
  f.api.list = () => deferred.promise;
  const store = f.create();
  store.sync('thread', question(), false);
  store.setActive(false);
  deferred.resolve([{ questionId: 'q', action: 'skip' }]); await settle();
  expect(store.getSnapshot().request).toBeNull();
  f.api.list = async () => [];
  store.setActive(true);
  store.sync('thread', question(), false); await settle();
  expect(store.getSnapshot().request?.id).toBe('q');
});

test('failed dismissal remains visible for retry and does not claim the record was saved', async () => {
  const f = fixture();
  const store = f.create(); store.sync('thread', question(), false); await settle();
  f.failWrite(true);
  expect(await store.respond('q', { action: 'decline' })).toBe(false);
  expect(store.getSnapshot()).toMatchObject({ pending: false, request: { id: 'q' } });
  expect(store.getSnapshot().error).toContain('save');
  expect(f.disk.size).toBe(0);
  f.failWrite(false);
  expect(await store.respond('q', { action: 'decline' })).toBe(true);
  expect(store.getSnapshot().request).toBeNull();
});

test('a successful send followed by a failed save cannot send again; Close retries only persistence', async () => {
  const f = fixture();
  const store = f.create(); store.sync('thread', question(), false); await settle();
  f.failWrite(true);
  expect(await store.respond('q', answer)).toBe(false);
  expect(store.getSnapshot().uncertain).toBe(true);
  expect(await store.respond('q', answer)).toBe(false);
  f.failWrite(false);
  expect(await store.respond('q', { action: 'cancel' })).toBe(true);
  expect(f.sends()).toBe(1);
});
