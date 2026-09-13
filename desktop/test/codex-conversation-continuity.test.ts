import { expect, test } from 'bun:test';
import type { IpcMainInvokeEvent } from 'electron';
import { CodexChatService } from '../lib/codex-chat-service.mts';
import type { CodexConversationAccess } from '../lib/codex-chat-account-continuity.mts';
import { registerCodexChatIpc } from '../lib/codex-chat-ipc.mts';
import { CodexChatContexts } from '../lib/codex-chat-contexts.mts';
import { CodexChatRelays } from '../lib/codex-chat-relay.mts';
import { CodexChatSessionDeletion } from '../lib/codex-chat-session-deletion.mts';
import { codexThread, createFakeCodexClient } from './codex-chat-test-helpers.ts';
import { INITIAL_CHAT_STATE, chatReducer, normalizeChatEvent } from '../frontend/src/features/chat/model.ts';
import { observeChatSendAttempt } from '../frontend/src/features/chat/chatSendAttempt.ts';
import { CodexAppServerClient, CodexAppServerStoppedError } from '../lib/codex-app-server-client.mts';

function fixture() {
  const client = createFakeCodexClient({
    'thread/start': { thread: codexThread('source') },
    'turn/start': { turn: { id: 'next-turn' } },
    'thread/read': (params: Record<string, unknown>) => ({ thread: codexThread(String(params.threadId), { turns: [] }) }),
    'thread/resume': (params: Record<string, unknown>) => ({ thread: codexThread(String(params.threadId)) }),
    'thread/unsubscribe': {},
    'thread/fork': { thread: codexThread('branch', { turns: [] }) },
  });
  let target = 'source';
  const loaded = new Set<string>();
  const conversations: CodexConversationAccess = {
    async list() { return { sessions: [] }; },
    async resolve() { return target; }, takeLoaded: id => loaded.delete(id),
    async locations() { return []; }, async request() { throw new Error('Unused'); }, async forget() {},
  };
  const options = { cwd: '/workspace/cheshi', serviceName: 'test', developerInstructions: 'Test.', conversations };
  const service = new CodexChatService({ ...options, client });
  const contexts = new CodexChatContexts({ service: options, createClient: () => ({ ...client, async stop() {} }), emit() {} });
  const relays = new CodexChatRelays({ contexts, emit() {} });
  const deletion = new CodexChatSessionDeletion({ service, contexts, relays });
  const events: Record<string, unknown>[] = [];
  service.onEvent(event => events.push(event));
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  let before: () => Promise<void> = async () => {};
  let prepared = 0;
  let destroyed = false;
  registerCodexChatIpc({ ipc: { handle(channel, handler) { handlers.set(channel, handler); } },
    service: () => service, relays, deletion,
    savedTurns: { async list() { return []; }, async save() { throw new Error('Unused'); }, async delete() { throw new Error('Unused'); } },
    assertSender() {}, beforeMessage: () => before(),
    async prepareMessage() { prepared += 1; return { text: 'Next request', clientMessageId: 'next', skill: null, attachments: [] }; },
  });
  return {
    client, service, conversations, events, deletion,
    target(id: string) { target = id; loaded.add(id); }, before(operation: () => Promise<void>) { before = operation; },
    get prepared() { return prepared; },
    destroyWindow() { destroyed = true; },
    list: () => handlers.get('cheshi:list-codex-chat-sessions')!({ sender: { id: 1, isDestroyed: () => destroyed } } as IpcMainInvokeEvent, 'pane'),
    invoke: () => handlers.get('cheshi:send-codex-chat-message')!({ sender: { id: 1 } } as IpcMainInvokeEvent, {}, 'pane'),
    async stop() { await service.stop(); await contexts.stop(); },
  };
}

test('closing the window cancels an in-flight account history read when its server stops', async () => {
  const h = fixture();
  const server = new CodexAppServerClient({ command: { executable: 'unused', args: [], environment: {} },
    cwd: '/workspace/cheshi', clientInfo: { name: 'test', title: 'Test', version: '1' } });
  h.conversations.list = async () => {
    await server.requests.request('thread/list', {}, 1_000, async () => {});
    return { sessions: [] };
  };
  try {
    const listing = h.list();
    h.destroyWindow();
    await server.stop();
    expect(await listing).toBeUndefined();
  } finally { await server.stop(); await h.stop(); }
});

test('live history reads preserve results and intentional server stop errors', async () => {
  const h = fixture();
  try {
    expect(await h.list()).toEqual({ sessions: [] });
    const error = new CodexAppServerStoppedError();
    h.conversations.list = async () => { throw error; };
    await expectHistoryFailure(h.list(), error);
  } finally { await h.stop(); }
});

test('closed windows do not hide connection failures or request timeouts', async () => {
  const h = fixture();
  try {
    h.destroyWindow();
    for (const error of [new Error('Connection lost'), new Error('thread/list timed out'), new Error('Codex App Server stopped.')]) {
      h.conversations.list = async () => { throw error; };
      await expectHistoryFailure(h.list(), error);
    }
  } finally { await h.stop(); }
});

async function expectHistoryFailure(operation: unknown, expected: Error): Promise<void> {
  try { await operation; }
  catch (error) { expect(error).toBe(expected); return; }
  throw new Error('Expected the history request to reject.');
}

test('account preflight can switch under the exclusive gate before exactly one new turn', async () => {
  const h = fixture();
  try {
    await h.service.sendMessage('Previous request', 'previous');
    h.client.emit('turn/completed', { threadId: 'source', turn: { id: 'next-turn', status: 'completed', items: [] } });
    await h.service.configure({ model: 'test-model', effort: 'high' });
    h.service.setCollaborationMode('plan');
    h.before(() => h.deletion.exclusive(async () => {
      await h.service.resetForAccount(true);
      expect(h.service.viewedThreadId).toBe('source');
      h.target('destination');
    }));
    expect(await h.invoke()).toEqual({ threadId: 'destination', turnId: 'next-turn' });
    expect(h.service.viewedThreadId).toBe('destination');
    expect(h.client.requests.filter(item => item.method === 'turn/start')).toHaveLength(2);
    expect(h.client.requests.filter(item => item.method === 'thread/resume')).toHaveLength(0);
    expect(h.client.requests.at(-1)).toMatchObject({ method: 'turn/start', params: {
      threadId: 'destination', clientUserMessageId: 'next', effort: 'high',
      collaborationMode: { mode: 'plan' }, input: [{ type: 'text', text: 'Next request' }],
    } });
    expect(h.events).toContainEqual({ type: 'session-selected', threadId: 'destination', previousThreadId: 'source' });
  } finally { await h.stop(); }
});

test('exhaustion stops before attachments and turn submission without repeated switching', async () => {
  const h = fixture();
  let attempts = 0;
  try {
    h.before(async () => { attempts += 1; throw new Error('All accounts have exhausted their usage. Earliest reset: tomorrow.'); });
    expect(await h.invoke()).toMatchObject({ sendFailure: 'failed', message: expect.stringContaining('Earliest reset') });
    expect(attempts).toBe(1);
    expect(h.prepared).toBe(0);
    expect(h.client.requests).toHaveLength(0);
  } finally { await h.stop(); }
});

test('sending owns the handoff subscription and resumes normally after leaving it', async () => {
  const h = fixture();
  try {
    h.target('destination');
    await h.service.openSession('source');
    await h.service.sendMessage('First explicit request', 'first');
    h.client.emit('turn/completed', { threadId: 'destination', turn: { id: 'next-turn', status: 'completed', items: [] } });
    expect(h.service.subscribedThreadIds.has('destination')).toBe(true);
    await h.service.newSession();
    expect(h.client.requests.filter(item => item.method === 'thread/unsubscribe')).toHaveLength(1);
    await h.service.openSession('source');
    await h.service.sendMessage('New explicit request', 'new');
    expect(h.client.requests.filter(item => item.method === 'thread/resume')).toHaveLength(1);
    expect(h.client.requests.filter(item => item.method === 'turn/start')).toHaveLength(2);
  } finally { await h.stop(); }
});

test('opening foreign history reads its owner without creating a fork or starting work', async () => {
  const h = fixture();
  try {
    h.conversations.read = async (id, method, params) => {
      expect(id).toBe('source');
      expect(method).toBe('thread/read');
      expect(params).toEqual({ includeTurns: true });
      return { thread: codexThread('latest', { turns: [] }) };
    };
    h.conversations.resolve = async () => { throw new Error('Read-only opening must not hand off'); };
    expect((await h.service.openSession('source')).session.id).toBe('latest');
    expect(h.client.requests).toHaveLength(0);
    expect(h.service.subscribedThreadIds.size).toBe(0);
  } finally { await h.stop(); }
});

test('opening a stale internal history entry explains the restriction and preserves the current chat', async () => {
  const h = fixture();
  try {
    h.service.viewedThreadId = 'source';
    for (const parentThreadId of [null, 'source']) {
      h.conversations.read = async () => ({ thread: codexThread('guardian', {
        parentThreadId, source: { subAgent: { other: 'guardian' } }, turns: [],
      }) });
      let message: string | undefined;
      try { await h.service.openSession('guardian'); }
      catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message).toBe('This is a Codex internal or subagent session. Open the main conversation instead.');
      expect(h.service.viewedThreadId).toBe('source');
      expect(h.client.requests).toHaveLength(0);
    }
  } finally { await h.stop(); }
});

test('explicit branching prepares foreign history in the selected account without running a goal', async () => {
  const h = fixture();
  try {
    h.service.viewedThreadId = 'source';
    h.target('destination');
    expect((await h.service.forkSession()).session.id).toBe('branch');
    expect(h.client.requests.find(item => item.method === 'thread/fork')?.params).toMatchObject({
      threadId: 'destination', deferGoalContinuation: true,
    });
    expect(h.client.requests.filter(item => item.method === 'turn/start' || item.method === 'thread/resume')).toHaveLength(0);
    expect(h.service.subscribedThreadIds.has('destination')).toBe(false);
  } finally { await h.stop(); }
});

test('lost turn acknowledgement stays unknown and is never automatically resubmitted', async () => {
  const h = fixture();
  try {
    const original = h.client.request;
    h.client.request = async (method, params) => {
      const response = await original(method, params);
      if (method === 'turn/start') throw new Error('Connection lost after sending');
      return response;
    };
    expect(await h.invoke()).toEqual({ sendFailure: 'unknown', message: 'Connection lost after sending' });
    expect(h.client.requests.filter(item => item.method === 'turn/start')).toHaveLength(1);
  } finally { await h.stop(); }
});

test('history handoff failure remains not sent and retains the viewed conversation', async () => {
  const h = fixture();
  try {
    h.service.viewedThreadId = 'source';
    h.conversations.resolve = async () => { throw new Error('Uncertain handoff'); };
    expect(await h.invoke()).toEqual({ sendFailure: 'failed', message: 'Uncertain handoff' });
    expect(h.service.viewedThreadId).toBe('source');
    expect(h.client.requests.filter(item => item.method === 'turn/start')).toHaveLength(0);
  } finally { await h.stop(); }
});

test('same-account subagent turns retain their original resume path', async () => {
  const h = fixture();
  try {
    h.service.viewedThreadId = 'agent';
    h.service.viewedThreadIsSubagent = true;
    h.service.threadIsSubagent.set('agent', true);
    h.conversations.resolve = async () => { throw new Error('Root handoff must not run for a subagent'); };
    expect(await h.service.sendMessage('Continue agent', 'agent-next')).toEqual({ threadId: 'agent', turnId: 'next-turn' });
    expect(h.client.requests.find(item => item.method === 'thread/resume')?.params.threadId).toBe('agent');
  } finally { await h.stop(); }
});

test('reading the retained goal uses its history owner without resuming a thread', async () => {
  const h = fixture();
  try {
    h.service.viewedThreadId = 'source';
    h.conversations.read = async (id, method) => {
      expect(id).toBe('source');
      expect(method).toBe('thread/goal/get');
      return { goal: null };
    };
    expect(await h.service.getGoal()).toEqual({ goal: null });
    expect(h.client.requests).toHaveLength(0);
  } finally { await h.stop(); }
});

test('handoff remaps the pending response and failure target without clearing transcript or claiming acceptance', () => {
  const opened = { ...INITIAL_CHAT_STATE, activeSessionId: 'source', activeTitle: 'History' };
  const pending = chatReducer(opened, { type: 'optimistic-user', id: 'client:next', text: 'Continue', title: 'Continue', createdAt: 1 });
  const event = normalizeChatEvent({ type: 'session-selected', threadId: 'destination', previousThreadId: 'source' });
  if (!event) throw new Error('Expected selection event');
  const switched = chatReducer(pending, { type: 'event', event });
  expect(switched.items).toEqual(pending.items);
  expect(switched.activeSessionId).toBe('destination');
  expect(switched.responseThreadIds).toEqual(['destination']);
  const attempt = { clientMessageId: 'next', threadId: 'source', accepted: false };
  observeChatSendAttempt(attempt, event);
  expect(attempt).toEqual({ clientMessageId: 'next', threadId: 'destination', accepted: false });
  const failed = chatReducer(switched, { type: 'send-failed', clientMessageId: 'next', threadId: attempt.threadId,
    message: 'Unknown delivery', uncertain: true, steering: false });
  expect(failed.responseThreadIds).toEqual([]);
});
