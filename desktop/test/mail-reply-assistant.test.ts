import { expect, test } from 'bun:test';
import { MailReplyAssistant } from '../lib/mail-reply-assistant.mts';
import type { CodexChatClient, JsonObject } from '../lib/codex-chat-types.mts';
import { recordValue } from '../lib/codex-service-utils.mts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const draft = () => ({ requestId: 'mail-test-1', originalMessage: '금요일 미팅 가능하신가요?',
  segments: [{ id: 'text-0', text: '금요일 가능해요' }, { id: 'text-1', text: '\n' }] });
const edited = [{ id: 'text-0', text: '금요일에 가능합니다.' }, { id: 'text-1', text: '\n' }];

function fixture(timeoutMs = 1000) {
  const notifications = new Set<(event: JsonObject) => void>();
  const requests = new Set<(event: JsonObject) => void>();
  const failures = new Set<(error: Error) => void>();
  const calls: { method: string; params: JsonObject }[] = [];
  const started = createDeferred<void>();
  const handlers = new Map<string, () => unknown>();
  let stops = 0, created = 0;
  const emit = (method: string, params: JsonObject) => {
    for (const listener of notifications) listener({ method, params });
  };
  const client: CodexChatClient & { stop(): Promise<void> } = {
    async request(method, value) {
      const params = recordValue(value) ?? {};
      calls.push({ method, params });
      if (handlers.has(method)) return handlers.get(method)!();
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'config/read') return { config: { mcp_servers: { mail: { url: 'http://localhost/mcp', tool_timeout_sec: null, startup_timeout_sec: null } } } };
      if (method === 'model/list') return { data: [{ id: 'test-mail-model', model: 'test-mail-model',
        displayName: 'Test', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] };
      if (method === 'thread/start') return { thread: { id: 'mail-thread', ephemeral: true },
        model: 'test-mail-model', modelProvider: 'openai', serviceTier: 'default' };
      if (method === 'turn/start') { started.resolve(); return { turn: { id: 'mail-turn' } }; }
      return {};
    },
    async respond() {},
    async stop() { stops++; await handlers.get('stop')?.(); },
    onNotification(listener) { notifications.add(listener); return () => { notifications.delete(listener); }; },
    onRequest(listener) { requests.add(listener); return () => { requests.delete(listener); }; },
    onDidFail(listener) { failures.add(listener); return () => { failures.delete(listener); }; },
  };
  const assistant = new MailReplyAssistant({ cwd: '/workspace', model: 'test-mail-model', effort: 'low', timeoutMs,
    createClient: () => { created++; return client; } });
  return { assistant, calls, started: started.promise, handlers, emit,
    created: () => created, stops: () => stops,
    listeners: () => notifications.size + requests.size + failures.size,
    complete(value: unknown = { segments: edited }) {
      emit('turn/completed', { threadId: 'mail-thread', turn: { id: 'mail-turn', status: 'completed',
        items: [{ id: 'result', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(value) }] } });
    } };
}

async function failure(operation: Promise<unknown>, pattern: RegExp) {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(pattern);
}

test('polishes a snapshot through an isolated subscription session without tools or delivery authority', async () => {
  const f = fixture(), input = draft();
  const pending = f.assistant.polish(input);
  input.segments[0]!.text = 'changed after Send';
  await f.started;
  const start = f.calls.find(call => call.method === 'thread/start')!.params;
  expect(start).toMatchObject({ model: 'test-mail-model', ephemeral: true, allowProviderModelFallback: false,
    modelProvider: 'openai', serviceTier: 'default', sandbox: 'read-only', approvalPolicy: 'never', dynamicTools: [],
    config: { mcp_servers: { mail: { enabled: false } }, 'features.shell_tool': false,
      'features.multi_agent': false, web_search: 'disabled' } });
  expect(JSON.stringify(start.config)).not.toContain('timeout_sec');
  const turn = f.calls.find(call => call.method === 'turn/start')!.params;
  const content = (turn.input as { text: string }[])[0]!.text;
  expect(JSON.parse(content)).toEqual({ originalMessage: input.originalMessage, segments: draft().segments });
  expect(turn).toMatchObject({ outputSchema: { type: 'object', additionalProperties: false },
    effort: 'low', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
  f.complete();
  expect(await pending).toEqual({ requestId: input.requestId, model: 'test-mail-model', segments: edited });
  expect(f.assistant.busy).toBe(false);
  expect(f.stops()).toBe(1);
  expect(f.listeners()).toBe(0);
});

test.each([
  { segments: edited.slice(1) },
  { segments: [...edited].reverse() },
  { segments: [edited[0], edited[0]] },
  { segments: [{ id: 'text-0', text: '' }, edited[1]] },
  { segments: [edited[0], { id: 'text-1', text: 'new promise' }] },
  { segments: edited, send: true },
  { segments: [{ ...edited[0], html: '<img>' }, edited[1]] },
  { segments: [{ id: 'text-0', text: 'a'.repeat(48_001) }, edited[1]] },
])('rejects incomplete, reordered or extended model output %#', async output => {
  const f = fixture();
  const rejected = failure(f.assistant.polish(draft()), /reply|text|segments/);
  await f.started;
  f.complete(output);
  await rejected;
  expect(f.stops()).toBe(1);
  expect(f.assistant.busy).toBe(false);
});

test.each([
  { ...draft(), segments: [] },
  { ...draft(), segments: [{ id: 'a', text: ' ' }] },
  { ...draft(), segments: [edited[0], edited[0]] },
  { ...draft(), originalMessage: 'x'.repeat(48_001) },
])('rejects invalid input before creating a model client %#', async input => {
  const f = fixture();
  await failure(f.assistant.polish(input), /reply|Reply|segments/);
  expect(f.created()).toBe(0);
});

test('rejects a second run and cancels the active one without returning a late draft', async () => {
  const f = fixture(), controller = new AbortController();
  const rejected = failure(f.assistant.polish(draft(), controller.signal), /user canceled/);
  await f.started;
  await failure(f.assistant.polish({ ...draft(), requestId: 'other' }), /busy/);
  expect(f.created()).toBe(1);
  controller.abort(new Error('user canceled'));
  f.complete();
  await rejected;
  expect(f.stops()).toBe(1);
  expect(f.listeners()).toBe(0);
});

test('stop cancels editing and forbids further runs', async () => {
  const f = fixture();
  const rejected = failure(f.assistant.polish(draft()), /canceled/);
  await f.started;
  f.assistant.stop();
  await rejected;
  await failure(f.assistant.polish(draft()), /stopped/);
  expect(f.created()).toBe(1);
});

test('cancellation during client cleanup suppresses an already prepared result', async () => {
  const f = fixture(), cleaning = createDeferred<void>(), release = createDeferred<void>();
  f.handlers.set('stop', () => { cleaning.resolve(); return release.promise; });
  const rejected = failure(f.assistant.polish(draft()), /canceled/);
  await f.started;
  f.complete();
  await cleaning.promise;
  f.assistant.cancel();
  release.resolve();
  await rejected;
  expect(f.assistant.busy).toBe(false);
});

test('an already canceled request does not create a client', async () => {
  const f = fixture();
  await failure(f.assistant.polish(draft(), AbortSignal.abort(new Error('canceled'))), /canceled/);
  expect(f.created()).toBe(0);
});

test('timeout releases the isolated client', async () => {
  const f = fixture(20);
  await failure(f.assistant.polish(draft()), /timed out/);
  expect(f.stops()).toBe(1);
  expect(f.assistant.busy).toBe(false);
});

test.each(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'fileChange'])(
  'unexpected tool activity aborts the editor: %s', async type => {
    const f = fixture();
    const rejected = failure(f.assistant.polish(draft()), /cannot use/);
    await f.started;
    f.emit('item/started', { threadId: 'mail-thread', item: { type } });
    await rejected;
    expect(f.stops()).toBe(1);
  });

test('unavailable model fails without selecting a different model', async () => {
  const f = fixture();
  f.handlers.set('model/list', () => ({ data: [] }));
  await failure(f.assistant.polish(draft()), /not available/);
  expect(f.calls.some(call => call.method === 'turn/start')).toBe(false);
  expect(f.stops()).toBe(1);
});
