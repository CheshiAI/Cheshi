import { describe, expect, test } from 'bun:test';
import { createChatMessageQueue } from '../frontend/src/features/chat/chatMessageQueue';
import type { ChatDraftSnapshot, ChatSendResult } from '../frontend/src/features/chat/chatDraftRecovery';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function itemAt<T>(values: readonly T[], index = 0): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing item at index ${index}`);
  return value;
}

const draft = (text: string): ChatDraftSnapshot => ({ draft: text, selectedSkill: null, attachments: [] });
const completed = (threadId = 'main') => ({ type: 'turn-completed', threadId, status: 'completed' });

function createSender() {
  const calls: { input: ChatDraftSnapshot; threadId: string }[] = [];
  const send = async (input: ChatDraftSnapshot, threadId: string): Promise<ChatSendResult> => {
    calls.push({ input, threadId });
    return { status: 'accepted' };
  };
  return { calls, send };
}

describe('chat instruction queue', () => {
  test('waits for completion and sends FIFO, releasing only one item per completed turn', async () => {
    const queue = createChatMessageQueue();
    const { calls, send } = createSender();
    queue.enqueue('main', draft('First'));
    queue.enqueue('main', draft('Second'));
    await queue.drain('main', send);
    expect(calls).toHaveLength(0);
    queue.observe(completed());
    await queue.drain('main', send);
    await queue.drain('main', send);
    expect(calls.map(call => call.input.draft)).toEqual(['First']);
    expect(queue.getSnapshot().map(item => item.input.draft)).toEqual(['Second']);
    queue.observe({ type: 'turn-started', threadId: 'main' });
    await queue.drain('main', send);
    expect(calls).toHaveLength(1);
    queue.observe(completed());
    await queue.drain('main', send);
    expect(calls.map(call => call.input.draft)).toEqual(['First', 'Second']);
    expect(queue.getSnapshot()).toHaveLength(0);
  });

  test('prevents concurrent drains while a send acknowledgement is pending', async () => {
    const queue = createChatMessageQueue();
    const pending = createDeferred<ChatSendResult>();
    let calls = 0;
    const send = () => { calls += 1; return pending.promise; };
    queue.enqueue('main', draft('First'));
    queue.enqueue('main', draft('Second'));
    queue.observe(completed());
    const sending = queue.drain('main', send);
    await queue.drain('main', send);
    expect(calls).toBe(1);
    expect(queue.getSnapshot().map(item => item.status)).toEqual(['sending', 'queued']);
    pending.resolve({ status: 'accepted' });
    await sending;
    await queue.drain('main', send);
    expect(calls).toBe(1);
  });

  test('isolates readiness and input destinations between threads', async () => {
    const queue = createChatMessageQueue();
    const { calls, send } = createSender();
    queue.enqueue('main', draft('Main instruction'));
    queue.enqueue('child', draft('Child instruction'));
    queue.observe(completed('child'));
    await queue.drain('main', send);
    expect(calls).toHaveLength(0);
    await queue.drain('child', send);
    expect(calls).toEqual([{ input: draft('Child instruction'), threadId: 'child' }]);
    queue.observe(completed('unrelated'));
    queue.observe({ type: 'error', threadId: 'child', message: 'Child failed' });
    expect(itemAt(queue.getSnapshot())).toMatchObject({ threadId: 'main', status: 'queued' });
    queue.observe(completed('main'));
    await queue.drain('main', send);
    expect(calls[1]).toEqual({ input: draft('Main instruction'), threadId: 'main' });
  });

  test('rejects empty submissions and snapshots draft, skill, and attachments', async () => {
    const queue = createChatMessageQueue();
    expect(queue.enqueue('', draft('Text'))).toBe(false);
    expect(queue.enqueue('main', draft(' \n '))).toBe(false);
    const input: ChatDraftSnapshot = {
      draft: '  Review this\n',
      selectedSkill: { name: 'review', displayName: 'Review', description: '', scope: 'repo', path: '/skills/review' },
      attachments: [{ kind: 'image', name: 'Screenshot', path: '/tmp/screenshot.png', previewUrl: 'data:image/png;base64,a' }],
    };
    const original = structuredClone(input);
    expect(queue.enqueue('main', input)).toBe(true);
    input.draft = 'Changed';
    input.selectedSkill!.path = '/skills/other';
    itemAt(input.attachments).path = '/tmp/other.png';
    input.attachments.push({ kind: 'file', name: 'Extra', path: '/tmp/extra.txt' });
    const { calls, send } = createSender();
    queue.observe(completed());
    await queue.drain('main', send);
    expect(itemAt(calls).input).toEqual(original);
  });

  test('allows cancellation of queued items but preserves an in-flight send', async () => {
    const queue = createChatMessageQueue();
    const pending = createDeferred<ChatSendResult>();
    queue.enqueue('main', draft('Sending'));
    queue.enqueue('main', draft('Cancel me'));
    const first = itemAt(queue.getSnapshot());
    const second = itemAt(queue.getSnapshot(), 1);
    queue.observe(completed());
    const sending = queue.drain('main', () => pending.promise);
    queue.remove(first.id);
    queue.remove(second.id);
    expect(queue.getSnapshot()).toMatchObject([{ id: first.id, status: 'sending' }]);
    pending.resolve({ status: 'accepted' });
    await sending;
    expect(queue.getSnapshot()).toEqual([]);
  });

  for (const event of [
    { type: 'turn-completed', threadId: 'main', status: 'interrupted', message: 'Stopped by user' },
    { type: 'turn-completed', threadId: 'main', status: 'failed', message: 'Turn failed' },
    { type: 'error', threadId: 'main', message: 'Connection failed' },
  ]) {
    test(`pauses after ${event.status ?? event.type} until explicitly resumed`, async () => {
      const queue = createChatMessageQueue();
      const { calls, send } = createSender();
      queue.enqueue('main', draft('First'));
      queue.enqueue('main', draft('Second'));
      queue.observe(event);
      expect(queue.getSnapshot().map(item => item.status)).toEqual(['paused', 'paused']);
      expect(itemAt(queue.getSnapshot()).message).toBe(event.message);
      queue.observe(completed());
      await queue.drain('main', send);
      expect(calls).toHaveLength(0);
      queue.retry(itemAt(queue.getSnapshot()).id);
      await queue.drain('main', send);
      await queue.drain('main', send);
      expect(calls.map(call => call.input.draft)).toEqual(['First']);
    });
  }

  test('confirmed send rejection remains paused until explicit retry', async () => {
    const queue = createChatMessageQueue();
    queue.enqueue('main', draft('Retry safely'));
    queue.observe(completed());
    let calls = 0;
    const send = async (): Promise<ChatSendResult> => {
      calls += 1;
      return calls === 1 ? { status: 'failed', message: 'Rejected' } : { status: 'accepted' };
    };
    await queue.drain('main', send);
    queue.observe(completed());
    await queue.drain('main', send);
    expect(calls).toBe(1);
    expect(itemAt(queue.getSnapshot())).toMatchObject({ status: 'paused', message: 'Rejected' });
    queue.retry(itemAt(queue.getSnapshot()).id);
    await queue.drain('main', send);
    expect(calls).toBe(2);
    expect(queue.getSnapshot()).toEqual([]);
  });

  for (const throws of [false, true]) {
    test(`uncertain delivery cannot be automatically or explicitly retried (${throws ? 'throw' : 'result'})`, async () => {
      const queue = createChatMessageQueue();
      queue.enqueue('main', draft('Do not duplicate'));
      queue.enqueue('main', draft('Wait behind it'));
      queue.observe(completed());
      let calls = 0;
      const send = async (): Promise<ChatSendResult> => {
        calls += 1;
        if (throws) throw new Error('Disconnected');
        return { status: 'unknown', message: 'Disconnected' };
      };
      await queue.drain('main', send);
      const first = itemAt(queue.getSnapshot());
      expect(first).toMatchObject({ status: 'unknown', message: 'Disconnected' });
      queue.retry(first.id);
      queue.observe(completed());
      await queue.drain('main', send);
      expect(calls).toBe(1);
      expect(queue.getSnapshot()).toHaveLength(2);
    });
  }

  for (const status of ['failed', 'unknown'] as const) {
    test(`canceling a ${status} head leaves subsequent instructions explicitly resumable`, async () => {
      const queue = createChatMessageQueue();
      queue.enqueue('main', draft('Unsent head'));
      queue.enqueue('main', draft('Continue with this'));
      queue.observe(completed());
      await queue.drain('main', async () => ({ status }));
      const first = itemAt(queue.getSnapshot());
      const second = itemAt(queue.getSnapshot(), 1);
      expect(second.status).toBe('paused');
      queue.remove(first.id);
      const { calls, send } = createSender();
      await queue.drain('main', send);
      expect(calls).toHaveLength(0);
      queue.retry(second.id);
      await queue.drain('main', send);
      expect(calls.map(call => call.input.draft)).toEqual(['Continue with this']);
    });
  }

  test('a threadless connection error pauses every pending thread', async () => {
    const queue = createChatMessageQueue();
    const { calls, send } = createSender();
    queue.enqueue('main', draft('Main'));
    queue.enqueue('child', draft('Child'));
    queue.observe(completed('main'));
    queue.observe(completed('child'));
    queue.observe({ type: 'error', message: 'Connection lost' });
    await queue.drain('main', send);
    await queue.drain('child', send);
    expect(calls).toHaveLength(0);
    expect(queue.getSnapshot().map(item => [item.status, item.message])).toEqual([
      ['paused', 'Connection lost'], ['paused', 'Connection lost'],
    ]);
    queue.retry(itemAt(queue.getSnapshot(), 1).id);
    await queue.drain('child', send);
    expect(calls.map(call => call.threadId)).toEqual(['child']);
    expect(itemAt(queue.getSnapshot()).status).toBe('paused');
  });

  for (const status of ['accepted', 'failed', 'unknown'] as const) {
    test(`forgetting a thread during a send prevents resurrection after ${status}`, async () => {
      const queue = createChatMessageQueue();
      const pending = createDeferred<ChatSendResult>();
      queue.enqueue('main', draft('Old session'));
      queue.enqueue('child', draft('Retained session'));
      queue.observe(completed());
      const sending = queue.drain('main', () => pending.promise);
      queue.forget(['main']);
      pending.resolve({ status, message: 'Late response' });
      await sending;
      expect(queue.getSnapshot()).toMatchObject([{ threadId: 'child', input: { draft: 'Retained session' } }]);
    });
  }

  test('completion before send acknowledgement releases the next instruction exactly once', async () => {
    const queue = createChatMessageQueue();
    const pending = createDeferred<ChatSendResult>();
    const { calls, send } = createSender();
    queue.enqueue('main', draft('First'));
    queue.enqueue('main', draft('Second'));
    queue.enqueue('main', draft('Third'));
    queue.observe(completed());
    const sending = queue.drain('main', () => pending.promise);
    queue.observe({ type: 'turn-started', threadId: 'main' });
    queue.observe(completed());
    await queue.drain('main', send);
    expect(calls).toHaveLength(0);
    pending.resolve({ status: 'accepted' });
    await sending;
    await queue.drain('main', send);
    await queue.drain('main', send);
    expect(calls.map(call => call.input.draft)).toEqual(['Second']);
    expect(queue.getSnapshot().map(item => item.input.draft)).toEqual(['Third']);
  });
});
