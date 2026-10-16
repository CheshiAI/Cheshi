import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore } from './store.ts';
import { recordTaskActivity } from './activity.ts';
import { TEXT_LIMIT } from './activity-contract.ts';
import { MESSAGE_STREAM_INTERVAL_MS } from './message-stream.ts';
import { TurnObserver } from './turn.ts';
import type { JsonRecord } from './protocol.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const nextBatch = () => new Promise(resolve => setTimeout(resolve, MESSAGE_STREAM_INTERVAL_MS + 30));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-text-stream-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new AgentStore(directory); store.create('task', 'Explain', { roomId: 'room' });
  store.update('task', { status: 'running' });
  const previews: JsonRecord[] = [];
  const observer = new TurnObserver((method, item, turn) => {
    if (method === 'item/updated') previews.push(item);
    recordTaskActivity(store, 'task', method, item, turn);
  });
  cleanups.push(() => observer.dispose());
  const emit = (method: string, params: JsonRecord) => observer.receive({ method, params: { threadId: 'thread', turnId: 'turn', ...params } });
  const start = (id = 'answer', phase = 'final_answer') => emit('item/started', { item: { id, type: 'agentMessage', phase, text: '' } });
  const delta = (text: string, itemId = 'answer', params: JsonRecord = {}) => emit('item/agentMessage/delta', { itemId, delta: text, ...params });
  const finish = (status = 'completed', items: JsonRecord[] = []) => emit('turn/completed', { turn: { id: 'turn', status, items } });
  const filename = join(directory, 'state/agent.json');
  return { store, directory, filename, previews, observer, emit, start, delta, finish };
}

test('batches scoped deltas before completion, keeps journals unchanged and replaces the same item with authoritative text', async () => {
  const f = fixture(), saved = readFileSync(f.filename, 'utf8'), inode = statSync(f.filename).ino;
  f.start(); f.delta('안녕'); // Notifications may precede turn/start acknowledgement.
  f.observer.identify('thread', 'turn');
  f.delta('FOREIGN', 'answer', { threadId: 'other' });
  f.delta('FOREIGN', 'answer', { turnId: 'other' });
  f.delta('UNSTARTED', 'other');
  f.emit('item/reasoning/textDelta', { itemId: 'answer', delta: 'PRIVATE' });
  for (let i = 0; i < 100; i++) f.delta('.');
  expect(f.previews).toHaveLength(0);
  await nextBatch();
  expect(f.previews).toHaveLength(1);
  const initial = f.store.task('task')!.activity![0]!;
  expect(initial).toMatchObject({ text: '안녕' + '.'.repeat(100), status: 'running' });
  f.delta(' 다음'); await nextBatch();
  expect(f.previews).toHaveLength(2);
  expect(f.store.snapshot().tasks[0]!.activity).toHaveLength(1);
  expect(readFileSync(f.filename, 'utf8')).toBe(saved);
  expect(statSync(f.filename).ino).toBe(inode);
  f.emit('item/completed', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '최종 답변' } });
  f.delta('LATE'); f.finish();
  expect((await f.observer.result).output).toBe('최종 답변');
  await nextBatch(); expect(f.previews).toHaveLength(2);
  const final = new AgentStore(f.directory).task('task')!.activity!;
  expect(final).toHaveLength(1);
  expect(final[0]).toMatchObject({ id: initial.id, createdAt: initial.createdAt, text: '최종 답변', status: 'completed' });
});

test.each(['completed', 'interrupted', 'failed'])('missing item completion on %s preserves partial text as unknown, not a final answer', async status => {
  const f = fixture(); f.observer.identify('thread', 'turn');
  f.start(); f.delta('일부 응답'); f.finish(status);
  const result = await f.observer.result;
  expect(result.output).toBe('');
  expect(f.store.task('task')!.activity![0]).toMatchObject({ text: '일부 응답', status: 'unknown' });
  const count = f.previews.length; await nextBatch(); expect(f.previews).toHaveLength(count);
  expect(new AgentStore(f.directory).task('task')!.activity![0]?.status).toBe('unknown');
});

test('connection failure flushes pending text and cancels delayed updates', async () => {
  const f = fixture(); f.observer.identify('thread', 'turn'); f.start(); f.delta('Partial');
  f.observer.fail(new Error('connection lost'));
  let failure: unknown;
  try { await f.observer.result; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toBe('connection lost');
  expect(f.store.task('task')!.activity![0]).toMatchObject({ text: 'Partial', status: 'unknown' });
  await nextBatch(); expect(f.previews).toHaveLength(1);
});

test('fast completion skips previews; commentary streams but is excluded from final output', async () => {
  const f = fixture(); f.observer.identify('thread', 'turn');
  f.start('progress', 'commentary'); f.delta('확인 중', 'progress'); await nextBatch();
  expect(f.store.task('task')!.activity![0]).toMatchObject({ text: '확인 중', final: false });
  f.emit('item/completed', { item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: '확인했어요' } });
  f.start(); f.delta('완');
  f.finish('completed', [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '완료' }]);
  expect((await f.observer.result).output).toBe('완료');
  await nextBatch(); expect(f.previews).toHaveLength(1);
  expect(f.store.task('task')!.activity!.map(item => item.text)).toEqual(['확인했어요', '완료']);
});

test('stream excerpts stop growing at the limit and disposal cancels pending publication', async () => {
  const f = fixture(); f.observer.identify('thread', 'turn'); f.start();
  f.delta('x'.repeat(TEXT_LIMIT * 10)); await nextBatch();
  expect(f.store.task('task')!.activity![0]).toMatchObject({ truncated: true, text: 'x'.repeat(TEXT_LIMIT) });
  f.delta('more'); await nextBatch(); expect(f.previews).toHaveLength(1);
  f.start('next'); f.delta('do not publish', 'next'); f.observer.dispose();
  await nextBatch(); expect(f.previews).toHaveLength(1);
});
