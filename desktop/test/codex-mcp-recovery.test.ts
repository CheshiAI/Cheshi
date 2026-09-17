import { expect, spyOn, test } from 'bun:test';
import { CodexChatService } from '../lib/codex-chat-service.mts';
import { acquireCodexMcpTurnStart } from '../lib/codex-mcp-recovery.mts';
import { codexThread, createFakeCodexClient } from './codex-chat-test-helpers';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function status(runtimeStatus: string, name = 'cheshi_codegraph') {
  // A stale tool catalog can remain populated after the process exits.
  return { data: [{ name, runtimeStatus, tools: { codegraph_explore: {} } }], nextCursor: null };
}

function fixture(responses: Record<string, unknown> = {}) {
  const client = createFakeCodexClient({
    'thread/start': { thread: codexThread('thread') },
    'thread/resume': ({ threadId }: Record<string, unknown>) => ({ thread: codexThread(String(threadId)) }),
    'turn/start': { turn: { id: 'turn' } },
    ...responses,
  });
  const logs: { event: string; details: Record<string, unknown> }[] = [];
  const service = new CodexChatService({ client, cwd: '/workspace/cheshi', serviceName: 'cheshi',
    developerInstructions: 'Inspect the workspace.', log: (event, details) => { logs.push({ event, details }); } });
  return { client, service, logs, methods: () => client.requests.map(request => request.method) };
}

async function expectNotSent(promise: Promise<unknown>) {
  let caught: unknown;
  try { await promise; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).name).toBe('CodexMessageNotSent');
}

test('recovers a failed connection with cached tools before sending exactly one user turn', async () => {
  let reloaded = false;
  const f = fixture({
    'mcpServerStatus/list': () => status(reloaded ? 'connected' : 'failed'),
    'config/mcpServer/reload': () => { reloaded = true; return {}; },
  });
  try {
    expect(await f.service.sendMessage('Inspect CodeGraph', 'message')).toEqual({ threadId: 'thread', turnId: 'turn' });
    expect(f.methods().filter(method => method !== 'model/list')).toEqual([
      'thread/start', 'mcpServerStatus/list', 'config/mcpServer/reload', 'mcpServerStatus/list', 'turn/start',
    ]);
    expect(f.logs.some(log => log.event === 'codex-mcp-recovery-completed')).toBe(true);
  } finally { await f.service.stop(); }
});

test('leaves healthy, starting, disabled, authentication-required and other servers alone', async () => {
  for (const response of [status('connected'), status('starting'), status('notStarted'), status('disabled'),
    status('authenticationRequired'), status('cancelled'), status('failed', 'other'), { data: [] }]) {
    const f = fixture({ 'mcpServerStatus/list': response });
    try {
      await f.service.sendMessage('Hello', 'message');
      expect(f.methods().filter(method => method === 'turn/start')).toHaveLength(1);
      expect(f.methods()).not.toContain('config/mcpServer/reload');
    } finally { await f.service.stop(); }
  }
});

test('continues ordinary chat if status or reload is unsupported without logging raw errors', async () => {
  for (const phase of ['status', 'reload']) {
    const f = fixture({
      'mcpServerStatus/list': phase === 'status' ? new Error('private-provider-payload') : status('failed'),
      'config/mcpServer/reload': new Error('private-provider-payload'),
    });
    try {
      await f.service.sendMessage('Hello', 'message');
      expect(f.methods().filter(method => method === 'turn/start')).toHaveLength(1);
      expect(f.logs).toContainEqual({ event: 'codex-mcp-recovery-unavailable', details: { threadId: 'thread', phase } });
      expect(JSON.stringify(f.logs)).not.toContain('private-provider-payload');
    } finally { await f.service.stop(); }
  }
});

test('polls the queued reload until connected and follows status pagination', async () => {
  let reloaded = false;
  let polls = 0;
  const f = fixture({
    'mcpServerStatus/list': ({ cursor }: Record<string, unknown>) => {
      if (!cursor) return { ...status('connected', 'other'), nextCursor: 'second' };
      return status(!reloaded ? 'failed' : ++polls === 1 ? 'starting' : 'connected');
    },
    'config/mcpServer/reload': () => { reloaded = true; return {}; },
  });
  try {
    await f.service.sendMessage('Hello', 'message');
    expect(polls).toBe(2);
    expect(f.methods().filter(method => method === 'config/mcpServer/reload')).toHaveLength(1);
  } finally { await f.service.stop(); }
});

test('bounds failed recovery and still sends once after the deadline', async () => {
  const clock = spyOn(Date, 'now');
  const start = Date.now();
  clock.mockReturnValue(start);
  let reads = 0;
  const f = fixture({
    'mcpServerStatus/list': () => {
      if (++reads === 2) clock.mockReturnValue(start + 10_001);
      return status('failed');
    },
    'config/mcpServer/reload': {},
  });
  try {
    await f.service.sendMessage('Hello', 'message');
    expect(reads).toBe(2);
    expect(f.methods().filter(method => method === 'config/mcpServer/reload')).toHaveLength(1);
    expect(f.methods().filter(method => method === 'turn/start')).toHaveLength(1);
    expect(f.logs).toContainEqual({ event: 'codex-mcp-recovery-unavailable', details: { threadId: 'thread', phase: 'ready' } });
  } finally { clock.mockRestore(); await f.service.stop(); }
});

test('serializes concurrent starts so a reload cannot overlap a newly submitted turn', async () => {
  const reloadStarted = createDeferred<void>();
  const reloadFinished = createDeferred<unknown>();
  let reloaded = false;
  const f = fixture({
    'mcpServerStatus/list': () => status(reloaded ? 'connected' : 'failed'),
    'config/mcpServer/reload': async () => {
      reloadStarted.resolve();
      await reloadFinished.promise;
      reloaded = true;
      return {};
    },
  });
  try {
    const first = f.service.sendMessage('First', 'one', null, [], 'first');
    await reloadStarted.promise;
    const second = f.service.sendMessage('Second', 'two', null, [], 'second');
    expect(f.methods()).not.toContain('turn/start');
    reloadFinished.resolve({});
    await Promise.all([first, second]);
    expect(f.methods().filter(method => method === 'config/mcpServer/reload')).toHaveLength(1);
    expect(f.client.requests.filter(request => request.method === 'turn/start')
      .map(request => request.params.clientUserMessageId)).toEqual(['one', 'two']);
  } finally { reloadFinished.resolve({}); await f.service.stop(); }
});

test('does not reload while a response is active in another thread', async () => {
  const f = fixture({ 'mcpServerStatus/list': status('failed') });
  f.service.beginActiveTurn('other', 'other-message');
  try {
    await f.service.sendMessage('Hello', 'message');
    expect(f.methods()).not.toContain('mcpServerStatus/list');
    expect(f.methods()).not.toContain('config/mcpServer/reload');
  } finally { await f.service.stop(); }
});

test('review and compact commands wait for an in-flight reload', async () => {
  for (const command of ['review', 'compact']) {
    const reloadStarted = createDeferred<void>();
    const reloadFinished = createDeferred<unknown>();
    let reloaded = false;
    const method = command === 'review' ? 'review/start' : 'thread/compact/start';
    const f = fixture({
      'mcpServerStatus/list': () => status(reloaded ? 'connected' : 'failed'),
      'config/mcpServer/reload': async () => {
        reloadStarted.resolve();
        await reloadFinished.promise;
        reloaded = true;
        return {};
      },
      [method]: { turn: { id: 'command-turn' } },
    });
    try {
      const sending = f.service.sendMessage('Hello', 'message', null, [], 'message-thread');
      await reloadStarted.promise;
      f.service.viewedThreadId = 'command-thread';
      const commanding = command === 'review' ? f.service.reviewSession() : f.service.compactSession();
      await Promise.resolve();
      expect(f.methods()).not.toContain(method);
      reloadFinished.resolve({});
      await Promise.all([sending, commanding]);
      expect(f.methods().indexOf(method)).toBeGreaterThan(f.methods().indexOf('turn/start'));
    } finally { reloadFinished.resolve({}); await f.service.stop(); }
  }
});

test('a canceled queued send releases the gate for subsequent messages', async () => {
  const f = fixture({ 'mcpServerStatus/list': status('connected') });
  const controller = new AbortController();
  const held = await acquireCodexMcpTurnStart(f.service, 'thread', new AbortController().signal);
  try {
    const canceled = expectNotSent(f.service.sendMessage('Canceled', 'canceled', null, [], 'canceled-thread', controller.signal));
    controller.abort();
    held();
    await canceled;
    await f.service.sendMessage('Next', 'next', null, [], 'next-thread');
    expect(f.client.requests.filter(request => request.method === 'turn/start')
      .map(request => request.params.clientUserMessageId)).toEqual(['next']);
  } finally { held(); await f.service.stop(); }
});

test('queued commands cannot replace the response that just started in the same thread', async () => {
  for (const command of ['review', 'compact']) {
    const reloadStarted = createDeferred<void>();
    const reloadFinished = createDeferred<unknown>();
    let reloaded = false;
    const f = fixture({
      'mcpServerStatus/list': () => status(reloaded ? 'connected' : 'failed'),
      'config/mcpServer/reload': async () => {
        reloadStarted.resolve();
        await reloadFinished.promise;
        reloaded = true;
        return {};
      },
    });
    try {
      const sending = f.service.sendMessage('Hello', 'message');
      await reloadStarted.promise;
      const commanding = command === 'review' ? f.service.reviewSession() : f.service.compactSession();
      const rejected = commanding.then(() => null, (error: unknown) => error);
      reloadFinished.resolve({});
      await sending;
      expect(await rejected).toBeInstanceOf(Error);
      expect(f.service.activeTurns.get('thread')?.clientMessageId).toBe('message');
      expect(f.methods()).not.toContain('review/start');
      expect(f.methods()).not.toContain('thread/compact/start');
    } finally { reloadFinished.resolve({}); await f.service.stop(); }
  }
});

test('checks for a response that became active while querying status', async () => {
  const f = fixture({ 'mcpServerStatus/list': () => {
    f.service.beginActiveTurn('other', 'other-message');
    return status('failed');
  } });
  try {
    await f.service.sendMessage('Hello', 'message');
    expect(f.methods()).not.toContain('config/mcpServer/reload');
  } finally { await f.service.stop(); }
});

test('canceling, stopping or resetting the service during preflight never sends the pending message', async () => {
  for (const action of ['cancel', 'stop', 'reset', 'failure']) {
    const statusStarted = createDeferred<void>();
    const statusFinished = createDeferred<unknown>();
    const f = fixture({ 'mcpServerStatus/list': () => { statusStarted.resolve(); return statusFinished.promise; } });
    const controller = new AbortController();
    try {
      const send = expectNotSent(f.service.sendMessage('Hello', 'message', null, [], null, controller.signal));
      await statusStarted.promise;
      if (action === 'cancel') controller.abort();
      if (action === 'stop') await f.service.stop();
      if (action === 'reset') await f.service.resetForAccount();
      if (action === 'failure') f.service.handleFailure(new Error('Transport closed'));
      statusFinished.resolve(status('failed'));
      await send;
      expect(f.methods()).not.toContain('config/mcpServer/reload');
      expect(f.methods()).not.toContain('turn/start');
    } finally { statusFinished.resolve(status('failed')); await f.service.stop(); }
  }
});

test('canceling during reload prevents polling and submission', async () => {
  const controller = new AbortController();
  const f = fixture({
    'mcpServerStatus/list': status('failed'),
    'config/mcpServer/reload': () => { controller.abort(); return {}; },
  });
  try {
    await expectNotSent(f.service.sendMessage('Hello', 'message', null, [], null, controller.signal));
    expect(f.methods().filter(method => method === 'mcpServerStatus/list')).toHaveLength(1);
    expect(f.methods()).not.toContain('turn/start');
  } finally { await f.service.stop(); }
});

test('a rejected turn start releases the gate without resending the failed message', async () => {
  let submissions = 0;
  const f = fixture({ 'mcpServerStatus/list': status('connected'), 'turn/start': () => {
    if (++submissions === 1) throw new Error('Lost acknowledgement');
    return { turn: { id: 'next-turn' } };
  } });
  try {
    let caught: unknown;
    try { await f.service.sendMessage('First', 'one'); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    await f.service.sendMessage('Second', 'two');
    expect(submissions).toBe(2);
  } finally { await f.service.stop(); }
});

test('passes null reload params and limits RPC timeouts to the recovery budget', async () => {
  const f = fixture();
  const requests: { method: string; params: unknown; timeout: number | undefined }[] = [];
  let reloaded = false;
  f.client.request = async (method: string, params?: unknown, timeout?: number) => {
    requests.push({ method, params, timeout });
    if (method === 'config/mcpServer/reload') { reloaded = true; return {}; }
    return status(reloaded ? 'connected' : 'failed');
  };
  try {
    const release = await acquireCodexMcpTurnStart(f.service, 'thread', new AbortController().signal);
    release();
    expect(requests.find(request => request.method === 'config/mcpServer/reload')?.params).toBeNull();
    expect(requests.every(request => request.timeout !== undefined && request.timeout > 0 && request.timeout <= 10_000)).toBe(true);
  } finally { await f.service.stop(); }
});
