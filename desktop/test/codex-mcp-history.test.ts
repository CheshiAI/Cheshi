import { describe, expect, test } from 'bun:test';
import {
  codexThread, createCodexChatService, createFakeCodexClient, expectFailure,
} from './codex-chat-test-helpers';

function inventory(runtimeStatus: string | null = 'connected') {
  return {
    data: [{ name: 'codegraph', runtimeStatus, tools: { explore: {} }, resources: [], resourceTemplates: [], authStatus: 'unsupported' }],
    nextCursor: null,
  };
}

const probeStart = {
  method: 'thread/start',
  params: { cwd: '/workspace/cheshi', ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' },
};
const probeList = {
  method: 'mcpServerStatus/list', params: { limit: 100, detail: 'toolsAndAuthOnly', threadId: 'probe' },
};

function probeClient(overrides: Record<string, unknown> = {}) {
  const client = createFakeCodexClient({
    'thread/start': { thread: codexThread('probe', { ephemeral: true }) },
    'mcpServerStatus/list': inventory(),
    ...overrides,
  });
  let stops = 0;
  return {
    ...client,
    get stops() { return stops; },
    async stop() {
      stops++;
      if (overrides.stop instanceof Error) throw overrides.stop;
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function missingThread(id: string) {
  const error = new Error(`thread not found: ${id}`);
  error.name = 'CodexRequestRejectedError';
  return error;
}

describe('MCP status for pending, stored and loaded conversations', () => {
  test('runs pending diagnostics on a disposable client, leaving the chat transport untouched', async () => {
    const chat = createFakeCodexClient();
    const diagnostic = probeClient();
    const service = createCodexChatService(chat, () => diagnostic);
    const result = await service.listMcpServers();
    expect(result.servers[0]?.connected).toBe(true);
    expect(chat.requests).toEqual([]);
    expect(diagnostic.requests).toEqual([probeStart, probeList]);
    expect(diagnostic.stops).toBe(1);
    expect(service.viewedThreadId).toBeNull();
  });

  test('closing the pane cancels a pending start and never restarts the diagnostic client', async () => {
    const started = createDeferred<{ thread: ReturnType<typeof codexThread> }>();
    const client = probeClient({ 'thread/start': () => started.promise });
    const service = createCodexChatService(client);
    const operation = service.listMcpServers();
    const failure = expectFailure(() => operation, 'Temporary MCP diagnostic canceled.');
    await service.stop();
    started.resolve({ thread: codexThread('probe', { ephemeral: true }) });
    await failure;
    expect(client.requests).toEqual([probeStart]);
    expect(client.stops).toBe(1);
  });

  test('checks pending chat connections without selecting, saving, or running a model turn', async () => {
    const client = probeClient({
      'thread/start': () => {
        client.emit('thread/started', { thread: codexThread('probe', { ephemeral: true }) });
        client.emit('mcpServer/status/updated', { threadId: 'probe', name: 'codegraph', status: 'ready' });
        return { thread: codexThread('probe', { ephemeral: true }) };
      },
    });
    const service = createCodexChatService(client);
    const events: unknown[] = [];
    service.onEvent(event => events.push(event));
    const result = await service.listMcpServers();
    expect(result.servers[0]).toMatchObject({ name: 'codegraph', runtimeStatus: 'connected', connected: true });
    expect(client.requests).toEqual([probeStart, probeList]);
    expect(client.stops).toBe(1);
    expect(events).toEqual([]);
    expect(service.viewedThreadId).toBeNull();
    expect(service.subscribedThreadIds.size).toBe(0);
    expect(service.activeTurns.size).toBe(0);
  });

  test('checks stored history with a temporary thread without resuming the stored conversation', async () => {
    const client = probeClient({
      'thread/read': { thread: codexThread('history', { status: { type: 'notLoaded' } }) },
    });
    const service = createCodexChatService(client);
    await service.openThread('history', false, 'open-session');
    const result = await service.listMcpServers();
    expect(result.servers[0]?.connected).toBe(true);
    expect(client.requests).toEqual([
      { method: 'thread/read', params: { threadId: 'history', includeTurns: true } },
      probeStart, probeList,
    ]);
    expect(service.viewedThreadId).toBe('history');
    expect(service.subscribedThreadIds.size).toBe(0);
  });

  test('uses the loaded conversation without creating or closing a diagnostic thread', async () => {
    const client = createFakeCodexClient({ 'mcpServerStatus/list': inventory() });
    const service = createCodexChatService(client);
    service.viewedThreadId = 'live';
    service.subscribedThreadIds.add('live');
    await service.listMcpServers();
    expect(client.requests).toEqual([
      { method: 'mcpServerStatus/list', params: { limit: 100, detail: 'toolsAndAuthOnly', threadId: 'live' } },
    ]);
  });

  test('replaces a closed runtime with a probe and removes only its stale subscription', async () => {
    const client = probeClient({
      'mcpServerStatus/list': (params: Record<string, unknown>) => {
        if (params.threadId === 'closed') throw missingThread('closed');
        return inventory();
      },
    });
    const service = createCodexChatService(client);
    service.viewedThreadId = 'closed';
    service.subscribedThreadIds.add('closed');
    expect((await service.listMcpServers()).servers).toHaveLength(1);
    await service.listMcpServers();
    expect(client.requests.filter(request => request.method === 'mcpServerStatus/list').map(request => request.params.threadId))
      .toEqual(['closed', 'probe', 'probe']);
    expect(service.viewedThreadId).toBe('closed');
    expect(service.subscribedThreadIds.size).toBe(0);
    expect(client.stops).toBe(2);
  });

  test.each([
    new Error('MCP transport failed'), missingThread('another-thread'), new Error('thread not found: live'),
  ])('preserves unrelated live runtime failures: %s', async (error) => {
    const client = createFakeCodexClient({ 'mcpServerStatus/list': error });
    const service = createCodexChatService(client);
    service.viewedThreadId = 'live';
    service.subscribedThreadIds.add('live');
    await expectFailure(() => service.listMcpServers(), error.message);
    expect(client.requests).toHaveLength(1);
    expect(service.subscribedThreadIds.has('live')).toBe(true);
  });

  test('cleans up when diagnostic inventory fails, without retrying or masking the error', async () => {
    const client = probeClient({
      'mcpServerStatus/list': missingThread('missing'),
      stop: new Error('Cleanup failed'),
    });
    const service = createCodexChatService(client);
    await expectFailure(() => service.listMcpServers(), 'thread not found: missing');
    expect(client.requests).toEqual([probeStart, probeList]);
    expect(client.stops).toBe(1);
  });

  test('surfaces cleanup failure instead of silently leaking a diagnostic subscription', async () => {
    const client = probeClient({ stop: new Error('Cleanup failed') });
    await expectFailure(() => createCodexChatService(client).listMcpServers(), 'Cleanup failed');
    expect(client.requests).toEqual([probeStart, probeList]);
    expect(client.stops).toBe(1);
  });

  test('propagates startup failure without querying an unavailable runtime', async () => {
    const client = probeClient({ 'thread/start': new Error('MCP startup failed') });
    await expectFailure(() => createCodexChatService(client).listMcpServers(), 'MCP startup failed');
    expect(client.requests).toEqual([probeStart]);
    expect(client.stops).toBe(1);
  });

  test.each([false, undefined, 'true', 1])('requires literal ephemeral confirmation and still releases the thread: %s', async (ephemeral) => {
    const client = probeClient({ 'thread/start': { thread: codexThread('probe', { ephemeral }) } });
    await expectFailure(() => createCodexChatService(client).listMcpServers(), 'Codex did not confirm a temporary MCP diagnostic thread.');
    expect(client.requests).toEqual([probeStart]);
    expect(client.stops).toBe(1);
  });

  test('cleans up if the inventory format is malformed', async () => {
    const client = probeClient({ 'mcpServerStatus/list': { data: null } });
    await expectFailure(() => createCodexChatService(client).listMcpServers(), 'The Codex MCP server status response format is invalid.');
    expect(client.requests).toEqual([probeStart, probeList]);
    expect(client.stops).toBe(1);
  });

  test('waits for startup to settle before releasing the temporary thread', async () => {
    let calls = 0;
    const client = probeClient({
      'mcpServerStatus/list': () => inventory(calls++ === 0 ? 'starting' : 'connected'),
    });
    const result = await createCodexChatService(client).listMcpServers();
    expect(result.servers[0]?.connected).toBe(true);
    expect(client.requests).toEqual([probeStart, probeList, probeList]);
  });

  test.each(['failed', 'disabled', 'authenticationRequired', null])('preserves terminal or unknown status without inventing a connection: %s', async (status) => {
    const client = probeClient({ 'mcpServerStatus/list': inventory(status) });
    const result = await createCodexChatService(client).listMcpServers();
    expect(result.servers[0]).toMatchObject({ runtimeStatus: status, connected: false });
    expect(client.requests).toEqual([probeStart, probeList]);
    expect(client.stops).toBe(1);
  });

  test('shares concurrent probes and performs a fresh check after completion', async () => {
    const started = createDeferred<{ thread: ReturnType<typeof codexThread> }>();
    const client = probeClient({ 'thread/start': () => started.promise });
    const service = createCodexChatService(client);
    const first = service.listMcpServers();
    const second = service.listMcpServers();
    expect(client.requests).toEqual([probeStart]);
    expect(client.stops).toBe(0);
    started.resolve({ thread: codexThread('probe', { ephemeral: true }) });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(client.requests).toEqual([probeStart, probeList]);
    expect(client.stops).toBe(1);
    await service.listMcpServers();
    expect(client.requests).toEqual([probeStart, probeList, probeStart, probeList]);
  });

  test('a stale request cannot alter a newly selected conversation', async () => {
    const client = probeClient({
      'mcpServerStatus/list': (params: Record<string, unknown>) => {
        if (params.threadId === 'old') {
          service.viewedThreadId = 'new';
          service.subscribedThreadIds.add('new');
          throw missingThread('old');
        }
        return inventory();
      },
    });
    const service = createCodexChatService(client);
    service.viewedThreadId = 'old';
    service.subscribedThreadIds.add('old');
    await service.listMcpServers();
    expect(service.viewedThreadId).toBe('new');
    expect([...service.subscribedThreadIds]).toEqual(['new']);
    expect(client.requests.slice(1)).toEqual([probeStart, probeList]);
  });
});
