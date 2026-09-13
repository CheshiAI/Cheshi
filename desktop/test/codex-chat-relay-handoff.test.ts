import { expect, test } from 'bun:test';
import { runChatRelayTurn } from '../lib/codex-chat-relay-turn.mts';
import { createCodexChatService, createFakeCodexClient } from './codex-chat-test-helpers.ts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const client = createFakeCodexClient();
  const service = createCodexChatService(client);
  const ack = createDeferred<{ threadId: string; turnId: string }>();
  const abort = new AbortController();
  const cancellations: string[] = [];
  const remaps: string[] = [];
  service.viewedThreadId = 'old';
  service.sendMessage = async () => ack.promise;
  service.cancelResponse = async id => { cancellations.push(String(id)); return { requested: true }; };
  const running = runChatRelayTurn(service, 'old', 'Continue', 'client', abort.signal, id => remaps.push(id));
  // Observe rejection immediately while a test deliberately holds the acknowledgement.
  const outcome = running.then(text => ({ text }), error => ({ error }));
  return { service, client, ack, abort, cancellations, remaps, running, outcome,
    selected(previousThreadId = 'old', threadId = 'new') {
      service.emit({ type: 'session-selected', previousThreadId, threadId });
    },
    complete(threadId = 'new', turnId = 'turn', text = 'Expected output') {
      client.emit('turn/completed', { threadId, turn: { id: turnId, status: 'completed',
        items: [{ id: `answer-${threadId}-${turnId}`, type: 'agentMessage', text }] } });
    },
    async close() { abort.abort(); ack.resolve({ threadId: 'new', turnId: 'turn' }); await outcome; await service.stop(); },
  };
}

test('relay adopts acknowledgement-only handoffs and consumes early completion only for the accepted thread and turn', async () => {
  const f = fixture();
  try {
    f.complete('unrelated', 'turn', 'Wrong conversation');
    f.complete('new', 'stale', 'Wrong turn');
    f.complete();
    f.ack.resolve({ threadId: 'new', turnId: 'turn' });
    expect(await f.running).toBe('Expected output');
    expect(f.remaps).toEqual(['new']);
    expect(f.cancellations).toEqual([]);
  } finally { await f.close(); }
});

test('relay follows the matching selection before acknowledgement and ignores unrelated selection', async () => {
  const f = fixture();
  try {
    f.selected('unrelated', 'wrong');
    expect(f.remaps).toEqual([]);
    f.selected();
    expect(f.remaps).toEqual(['new']);
    f.abort.abort();
    expect(f.cancellations).toEqual(['new']);
    f.ack.resolve({ threadId: 'new', turnId: 'turn' });
    expect(await f.outcome).toMatchObject({ error: expect.any(Error) });
    expect(f.cancellations).toEqual(['new']);
  } finally { await f.close(); }
});

test('cancellation before a delayed handoff follows its selection and waits for the acknowledgement', async () => {
  const f = fixture();
  let settled = false;
  void f.outcome.then(() => { settled = true; });
  try {
    f.abort.abort();
    f.selected();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.cancellations).toEqual(['old', 'new']);
    f.ack.resolve({ threadId: 'new', turnId: 'turn' });
    await f.outcome;
    expect(f.remaps).toEqual(['new']);
    expect(f.cancellations).toEqual(['old', 'new']);
  } finally { await f.close(); }
});

test('cancellation before acknowledgement-only handoff also cancels the accepted destination', async () => {
  const f = fixture();
  try {
    f.abort.abort();
    f.ack.resolve({ threadId: 'new', turnId: 'turn' });
    await f.outcome;
    expect(f.cancellations).toEqual(['old', 'new']);
    expect(f.remaps).toEqual(['new']);
  } finally { await f.close(); }
});

test('cancellation after the acknowledgement targets the destination exactly once', async () => {
  const f = fixture();
  try {
    f.ack.resolve({ threadId: 'new', turnId: 'turn' });
    await f.ack.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(f.remaps).toEqual(['new']);
    f.abort.abort();
    await f.outcome;
    expect(f.cancellations).toEqual(['new']);
  } finally { await f.close(); }
});
