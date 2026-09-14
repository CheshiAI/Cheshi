import { describe, expect, test } from 'bun:test';
import { createCodexMcpRecovery, codexMcpRecovery } from '../lib/codex-mcp-recovery.mts';
import type { CodexChatClient, JsonObject } from '../lib/codex-chat-types.mts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function inventory(runtimeStatus = 'connected', overrides: JsonObject = {}) {
  return { data: [{ name: 'cheshi_codegraph', runtimeStatus, ...overrides }], nextCursor: null };
}

function completed(server = 'cheshi_codegraph', message = 'Transport closed'): JsonObject {
  return { method: 'item/completed', params: { threadId: 'thread-a', item: {
    type: 'mcpToolCall', server, error: { message },
  } } };
}

function harness(handle: (method: string, params: unknown) => unknown = () => inventory()) {
  const requests: { method: string; params: unknown }[] = [];
  const logs: { event: string; details: JsonObject }[] = [];
  let time = 1_000;
  const client: CodexChatClient = {
    async request(method, params) {
      requests.push({ method, params });
      // The recovery path may only inspect connections and refresh runtimes.
      expect(['mcpServerStatus/list', 'config/mcpServer/reload']).toContain(method);
      return handle(method, params);
    },
    async respond() {},
    onNotification: () => () => {},
    onRequest: () => () => {},
    onDidFail: () => () => {},
  };
  const log = (event: string, details: JsonObject) => { logs.push({ event, details }); };
  return {
    client, log, requests, logs,
    recovery: createCodexMcpRecovery(client, log, () => time),
    advance: (milliseconds: number) => { time += milliseconds; },
    methods: () => requests.map(request => request.method),
  };
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

describe('CodeGraph MCP connection recovery', () => {
  test('leaves healthy connections intact', async () => {
    const state = harness();
    expect(await state.recovery.read('thread-a')).toEqual(inventory());
    expect(state.requests).toEqual([{ method: 'mcpServerStatus/list', params: {
      threadId: 'thread-a', limit: 100, detail: 'toolsAndAuthOnly',
    } }]);
    expect(state.logs).toEqual([]);
  });

  test.each(['failed', 'cancelled'])('reloads %s connections and returns fresh status', async status => {
    let reads = 0;
    const state = harness(method => method === 'mcpServerStatus/list'
      ? inventory(reads++ === 0 ? status : 'connected', { tools: { codegraph_explore: {} }, toolsError: null })
      : {});
    const result = await state.recovery.read('thread-a');
    expect(result).toEqual(inventory('connected', { tools: { codegraph_explore: {} }, toolsError: null }));
    expect(state.methods()).toEqual(['mcpServerStatus/list', 'config/mcpServer/reload', 'mcpServerStatus/list']);
    expect(state.requests[1]?.params).toBeUndefined();
    expect(state.logs[0]?.event).toBe('codex-mcp-reload-requested');
  });

  test.each([
    { runtimeStatus: 'failed', name: 'unrelated_server' },
    { runtimeStatus: 'disabled' },
    { runtimeStatus: 'starting' },
    { runtimeStatus: 'authenticationRequired' },
    { runtimeStatus: 'failed', failureReason: 'reauthenticationRequired', error: 'Transport closed' },
    { runtimeStatus: 'failed', error: 'OAuth credentials expired' },
    { runtimeStatus: 'failed', toolsError: 'Invalid server configuration' },
  ])('does not reload unrelated, unavailable or invalid configuration: %j', async server => {
    const response = inventory('connected', server);
    const state = harness(() => response);
    expect(await state.recovery.read('thread-a')).toEqual(response);
    expect(state.methods()).toEqual(['mcpServerStatus/list']);
  });

  test('shares simultaneous reads for the same thread', async () => {
    const initial = createDeferred<unknown>();
    const state = harness(() => initial.promise);
    const first = state.recovery.read('thread-a');
    const second = state.recovery.read('thread-a');
    expect(first).toBe(second);
    await settle();
    expect(state.methods()).toEqual(['mcpServerStatus/list']);
    initial.resolve(inventory());
    expect(await first).toEqual(await second);
    await state.recovery.read('thread-a');
    expect(state.methods()).toEqual(['mcpServerStatus/list', 'mcpServerStatus/list']);
  });

  test('shares one reload across concurrently failing threads', async () => {
    const refreshed = createDeferred<unknown>();
    let connected = false;
    const state = harness(method => method === 'config/mcpServer/reload'
      ? refreshed.promise
      : inventory(connected ? 'connected' : 'failed'));
    const first = state.recovery.read('thread-a');
    const second = state.recovery.read('thread-b');
    await settle();
    expect(state.methods().filter(method => method === 'config/mcpServer/reload')).toHaveLength(1);
    connected = true;
    refreshed.resolve({});
    const results = await Promise.all([first, second]);
    expect(results).toEqual([inventory(), inventory()]);
    expect(state.methods().filter(method => method === 'mcpServerStatus/list')).toHaveLength(4);
  });

  test('waits for event-triggered reload before checking status', async () => {
    const refreshed = createDeferred<unknown>();
    const state = harness(method => method === 'config/mcpServer/reload' ? refreshed.promise : inventory());
    state.recovery.observe(completed());
    const result = state.recovery.read('thread-a');
    await settle();
    expect(state.methods()).toEqual(['config/mcpServer/reload']);
    refreshed.resolve({});
    expect(await result).toEqual(inventory());
    expect(state.methods()).toEqual(['config/mcpServer/reload', 'mcpServerStatus/list']);
  });

  test.each(['Transport closed', 'Connection reset', 'Broken pipe', 'Unexpected EOF'])(
    'recovers targeted tool transport failure: %s', async message => {
      const state = harness();
      state.recovery.observe(completed('cheshi_codegraph', message));
      await settle();
      expect(state.methods()).toEqual(['config/mcpServer/reload']);
    },
  );

  test('recovers targeted startup transport failure', async () => {
    const state = harness();
    state.recovery.observe({ method: 'mcpServer/startupStatus/updated', params: {
      threadId: 'thread-a', name: 'cheshi_codegraph', status: 'failed', error: 'Transport closed',
    } });
    await settle();
    expect(state.methods()).toEqual(['config/mcpServer/reload']);
  });

  test('recovers an MCP error result but not normal text that mentions a closed transport', async () => {
    const state = harness();
    const resultEvent = (isError: unknown): JsonObject => ({ method: 'item/completed', params: {
      threadId: 'thread-a', item: { type: 'mcpToolCall', server: 'cheshi_codegraph', result: {
        isError, content: [{ type: 'text', text: 'Transport closed' }],
      } },
    } });
    for (const flag of [false, undefined, 'true', 1]) state.recovery.observe(resultEvent(flag));
    await settle();
    expect(state.requests).toEqual([]);
    state.recovery.observe(resultEvent(true));
    await settle();
    expect(state.methods()).toEqual(['config/mcpServer/reload']);
  });

  test('ignores other server errors, application errors, incomplete and malformed events', async () => {
    const state = harness();
    for (const event of [
      completed('another_server'),
      completed('cheshi_codegraph', 'File not found'),
      { ...completed(), method: 'item/started' },
      { method: 'item/completed', params: { item: { type: 'mcpToolCall', server: 'cheshi_codegraph' } } },
      { method: 'item/completed', params: null },
      { method: 'mcpServer/startupStatus/updated', params: {
        threadId: 'thread-a', name: 'cheshi_codegraph', status: 'failed', error: 'Invalid configuration',
      } },
    ]) state.recovery.observe(event);
    await settle();
    expect(state.requests).toEqual([]);
  });

  test('throttles failed reloads for 30 seconds, then permits a later event to retry', async () => {
    const state = harness(method => {
      if (method === 'config/mcpServer/reload') throw new Error('Refresh unavailable');
      return inventory('failed');
    });
    state.recovery.observe(completed());
    await settle();
    state.advance(29_999);
    state.recovery.observe(completed());
    expect(await state.recovery.read('thread-a')).toEqual(inventory('failed'));
    expect(state.methods()).toEqual(['config/mcpServer/reload', 'mcpServerStatus/list']);
    state.advance(1);
    state.recovery.observe(completed());
    await settle();
    expect(state.methods()).toEqual(['config/mcpServer/reload', 'mcpServerStatus/list', 'config/mcpServer/reload']);
    expect(state.logs.map(entry => entry.event)).toEqual(['codex-mcp-reload-failed', 'codex-mcp-reload-failed']);
  });

  test('does not throw or replay user messages when the pre-send health check fails', async () => {
    const state = harness(() => { throw new Error('Status unavailable'); });
    expect(await state.recovery.prepare('thread-a')).toBeUndefined();
    expect(state.methods()).toEqual(['mcpServerStatus/list']);
    expect(state.logs).toEqual([{ event: 'codex-mcp-health-check-failed', details: {
      threadId: 'thread-a', message: 'Status unavailable',
    } }]);
  });

  test('shares the coordinator for one client, while keeping separate transports independent', () => {
    const first = harness();
    const second = harness();
    const recovery = codexMcpRecovery(first.client, first.log);
    expect(codexMcpRecovery(first.client, first.log)).toBe(recovery);
    expect(codexMcpRecovery(second.client, second.log)).not.toBe(recovery);
  });
});
