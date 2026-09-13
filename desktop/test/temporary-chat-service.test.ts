import { describe, expect, test } from 'bun:test';
import { TemporaryChatService, type TemporaryChatClient } from '../lib/temporary-chat-service.mts';
import type { JsonObject } from '../lib/codex-chat-types.mts';
import { temporaryChatRequest } from '../shared/temporary-chat.ts';

const MODEL = 'gpt-test';
const REQUEST = { model: MODEL, effort: 'medium', text: 'Hello', attachments: [] };

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function rejected(operation: Promise<unknown>, message: RegExp) {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(message);
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Expected asynchronous event was not observed.');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function fixture(timeoutMs = 2_000) {
  const calls: { method: string; params: unknown }[] = [];
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  const notifications = new Set<(event: JsonObject) => void>();
  const requests = new Set<(event: JsonObject) => void>();
  const failures = new Set<(error: Error) => void>();
  let turnNumber = 0;
  let stops = 0;
  const client: TemporaryChatClient = {
    async request(method, params) {
      calls.push({ method, params });
      const handler = handlers.get(method);
      if (handler) return handler(params);
      if (method === 'model/list') return { data: [MODEL, 'second-model'].map((model) => ({
        id: model, model, displayName: model, defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
      })) };
      if (method === 'thread/start') return { thread: { id: 'memory-thread', ephemeral: true }, model: MODEL };
      if (method === 'turn/start') return { turn: { id: `turn-${++turnNumber}` } };
      throw new Error(`Unexpected request ${method}`);
    },
    async stop() { stops++; },
    async respond() {},
    onNotification(listener) { notifications.add(listener); return () => { notifications.delete(listener); }; },
    onRequest(listener) { requests.add(listener); return () => { requests.delete(listener); }; },
    onDidFail(listener) { failures.add(listener); return () => { failures.delete(listener); }; },
  };
  const service = new TemporaryChatService({ createClient: () => client, cwd: '/workspace', timeoutMs });
  const notify = (method: string, params: JsonObject) => {
    for (const listener of notifications) listener({ method, params });
  };
  const complete = (id = `turn-${turnNumber}`, text = 'Answer') => notify('turn/completed', {
    threadId: 'memory-thread', turn: { id, status: 'completed',
      items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text }] },
  });
  return { service, calls, handlers, notifications, requests, failures, notify, complete,
    stops: () => stops,
    started: (count = 1) => until(() => calls.filter((call) => call.method === 'turn/start').length >= count),
  };
}

describe('temporary multi-turn chat lifecycle', () => {
  test('keeps the same ephemeral thread across turns and changes model without writing history', async () => {
    const f = fixture();
    const first = f.service.send(REQUEST);
    await f.started();
    f.complete();
    expect(await first).toEqual({ text: 'Answer', model: MODEL });
    expect(f.stops()).toBe(0);
    const second = f.service.send({ ...REQUEST, model: 'second-model', text: 'Continue' });
    await f.started(2);
    f.complete('turn-1', 'stale answer');
    f.complete('turn-2', 'Second answer');
    expect(await second).toEqual({ text: 'Second answer', model: 'second-model' });
    const starts = f.calls.filter(({ method }) => method === 'thread/start');
    expect(starts).toHaveLength(1);
    expect(starts[0]?.params).toMatchObject({ ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
      allowProviderModelFallback: false, selectedCapabilityRoots: [], dynamicTools: [], environments: [] });
    expect(f.calls.filter(({ method }) => method === 'turn/start').map(({ params }) => (params as JsonObject).threadId))
      .toEqual(['memory-thread', 'memory-thread']);
    expect(f.calls.map(({ method }) => method)).toEqual(['model/list', 'thread/start', 'turn/start', 'turn/start']);
    await f.service.close();
    await f.service.close();
    expect(f.stops()).toBe(1);
    expect(f.notifications.size + f.requests.size + f.failures.size).toBe(0);
  });

  test('shares model loading and does not create a thread just to show models', async () => {
    const f = fixture();
    const results = await Promise.all([f.service.models(), f.service.models()]);
    expect(results[0]).toHaveLength(2);
    expect(f.calls.map(({ method }) => method)).toEqual(['model/list']);
    await f.service.close();
  });

  test('rejects concurrent sends without canceling the active turn', async () => {
    const f = fixture();
    const result = f.service.send(REQUEST);
    await f.started();
    await rejected(f.service.send(REQUEST), /already in progress/);
    f.complete();
    expect((await result).text).toBe('Answer');
    await f.service.close();
  });

  test.each(['model/list', 'thread/start', 'turn/start'])('closing during %s prevents late requests and releases the client', async (method) => {
    const f = fixture();
    const deferred = createDeferred<unknown>();
    f.handlers.set(method, () => deferred.promise);
    const failure = rejected(f.service.send(REQUEST), /closed/);
    await until(() => f.calls.some((call) => call.method === method));
    await f.service.close();
    await failure;
    const count = f.calls.length;
    deferred.resolve({ data: [], thread: { id: 'late-thread', ephemeral: true }, turn: { id: 'late-turn' }, model: MODEL });
    await new Promise((resolve) => setTimeout(resolve, 1));
    await rejected(f.service.send(REQUEST), /closed/);
    await rejected(f.service.models(), /closed/);
    expect(f.calls).toHaveLength(count);
    expect(f.stops()).toBe(1);
    expect(f.notifications.size + f.requests.size + f.failures.size).toBe(0);
  });

  test('closing an active response settles it without waiting for completion', async () => {
    const f = fixture();
    const failure = rejected(f.service.send(REQUEST), /closed/);
    await f.started();
    await f.service.close();
    await failure;
    f.complete();
    expect(f.stops()).toBe(1);
  });

  test('times out a stalled turn and closes its isolated client', async () => {
    const f = fixture(20);
    await rejected(f.service.send(REQUEST), /timed out/);
    await f.service.close();
    expect(f.stops()).toBe(1);
    expect(f.notifications.size).toBe(0);
  });

  test('times out model loading before a turn exists', async () => {
    const f = fixture(20);
    f.handlers.set('model/list', () => new Promise(() => {}));
    await rejected(f.service.models(), /timed out/);
    await f.service.close();
    expect(f.stops()).toBe(1);
    expect(f.calls.map(({ method }) => method)).toEqual(['model/list']);
  });

  test.each([false, 'true', undefined])('requires literal ephemeral confirmation: %s', async (ephemeral) => {
    const f = fixture();
    f.handlers.set('thread/start', async () => ({ thread: { id: 'wrong', ephemeral }, model: MODEL }));
    await rejected(f.service.send(REQUEST), /in-memory/);
    await f.service.close();
    expect(f.calls.some(({ method }) => method === 'turn/start')).toBe(false);
    expect(f.stops()).toBe(1);
  });

  test('rejects silent provider model fallback', async () => {
    const f = fixture();
    f.handlers.set('thread/start', async () => ({ thread: { id: 'wrong', ephemeral: true }, model: 'other' }));
    await rejected(f.service.send(REQUEST), /different model/);
    await f.service.close();
    expect(f.calls.some(({ method }) => method === 'turn/start')).toBe(false);
  });

  test('handles completion arriving before turn start acknowledgement', async () => {
    const f = fixture();
    f.handlers.set('turn/start', async () => {
      f.complete('early-turn', 'Early answer');
      return { turn: { id: 'early-turn' } };
    });
    expect((await f.service.send(REQUEST)).text).toBe('Early answer');
    await f.service.close();
  });

  test('ignores commentary and unrelated events, and deduplicates final messages', async () => {
    const f = fixture();
    const result = f.service.send(REQUEST);
    await f.started();
    f.notify('item/completed', { threadId: 'other-thread', turnId: 'turn-1',
      item: { id: 'other', type: 'agentMessage', text: 'Other conversation' } });
    f.notify('item/completed', { threadId: 'memory-thread', turnId: 'turn-1',
      item: { id: 'comment', type: 'agentMessage', text: 'Working', phase: 'commentary' } });
    f.notify('item/completed', { threadId: 'memory-thread', turnId: 'turn-1',
      item: { id: 'answer', type: 'agentMessage', text: 'Answer', phase: 'final_answer' } });
    f.complete();
    expect((await result).text).toBe('Answer');
    await f.service.close();
  });

  test('treats only literal true as a retryable error', async () => {
    const f = fixture();
    const failure = rejected(f.service.send(REQUEST), /Terminal failure/);
    await f.started();
    f.notify('error', { threadId: 'memory-thread', turnId: 'turn-1', willRetry: true,
      error: { message: 'Retrying' } });
    f.notify('error', { threadId: 'memory-thread', turnId: 'turn-1', willRetry: 'true',
      error: { message: 'Terminal failure' } });
    await failure;
    await f.service.close();
    expect(f.stops()).toBe(1);
  });

  test('references original files and images without archiving attachments', async () => {
    const f = fixture();
    const result = f.service.send({ ...REQUEST, attachments: [
      { kind: 'file', name: 'note.txt', path: '/tmp/note.txt' },
      { kind: 'image', name: 'photo.png', path: '/tmp/photo.png' },
    ] });
    await f.started();
    const params = f.calls.find(({ method }) => method === 'turn/start')?.params as JsonObject;
    expect(params.input).toEqual([
      { type: 'text', text: 'Hello\n\nAttached files:\n- "/tmp/note.txt"', text_elements: [] },
      { type: 'localImage', path: '/tmp/photo.png' },
    ]);
    f.complete();
    await result;
    await f.service.close();
  });

  test.each(['interactive', 'transport'])('closes on %s failure', async (kind) => {
    const f = fixture();
    const failure = rejected(f.service.send(REQUEST), /interactive tools|connection lost/);
    await f.started();
    if (kind === 'interactive') {
      for (const listener of f.requests) listener({ method: 'item/tool/requestUserInput', id: 7 });
    } else {
      for (const listener of f.failures) listener(new Error('connection lost'));
    }
    await failure;
    await f.service.close();
    expect(f.stops()).toBe(1);
  });
});

describe('temporary chat input validation', () => {
  test('supports attachment-only input but rejects empty and oversized messages', () => {
    expect(temporaryChatRequest({ ...REQUEST, text: '', attachments: [{ kind: 'file', name: 'x', path: '/tmp/x' }] }).text).toBe('');
    for (const value of [null, [], { ...REQUEST, text: '' }, { ...REQUEST, text: 'x'.repeat(128_001) },
      { ...REQUEST, model: true }, { ...REQUEST, attachments: 'file' },
      { ...REQUEST, attachments: [{ kind: 'file', name: 'x', path: '/tmp/\0x' }] }]) {
      expect(() => temporaryChatRequest(value)).toThrow(TypeError);
    }
  });
});
