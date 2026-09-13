import { expect, test } from 'bun:test';
import { CodexConversationAgents } from '../lib/codex-conversation-agents.mts';
import { CodexChatService } from '../lib/codex-chat-service.mts';
import type { CodexConversationAccess } from '../lib/codex-chat-account-continuity.mts';
import type { JsonObject } from '../lib/codex-chat-types.mts';
import { recordValue } from '../lib/codex-service-utils.mts';
import { codexThread, createFakeCodexClient } from './codex-chat-test-helpers.ts';

async function failure(operation: Promise<unknown>, message: string) {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain(message);
}

function fixture() {
  const root = codexThread('root', { cwd: '/workspace', turns: [], sessionId: 'root' });
  const child = { ...codexThread('child'), cwd: '/workspace', parentThreadId: 'root', turns: [], sessionId: 'child' };
  const nested = { ...codexThread('nested'), cwd: '/workspace', parentThreadId: 'child', turns: [], sessionId: 'nested' };
  const calls: Array<{ account: string; method: string; params: JsonObject }> = [];
  let active = 'b';
  let currentRoot = 'root';
  let pages: ((params: JsonObject) => unknown) | null = null;
  const owner = async (id: string) => {
    if (id !== 'root' && id !== 'latest') throw new Error('Not a registered root');
    return { profileId: currentRoot === 'root' ? 'a' : 'b', threadId: currentRoot };
  };
  const request = async (account: string, method: string, value?: unknown): Promise<unknown> => {
    const params = recordValue(value) ?? {};
    calls.push({ account, method, params });
    if (method === 'thread/read') return { thread: [root, child, nested].find(thread => thread.id === params.threadId) };
    if (method === 'thread/list') return pages ? pages(params)
      : params.cursor ? { data: [nested] } : { data: [child], nextCursor: 'next' };
    if (method === 'thread/goal/get') return { goal: null };
    throw new Error('Unexpected history mutation');
  };
  const agents = new CodexConversationAgents({ cwd: '/workspace', owner, request, activeProfileId: () => active });
  const client = createFakeCodexClient({});
  const conversations: CodexConversationAccess = {
    agents, async list() { return { sessions: [] }; }, async resolve(id) { return id; },
    read: (id, method, params) => request('a', method, { ...params, threadId: id }),
    async locations() { return []; }, request, async forget() {},
  };
  const service = new CodexChatService({ client, cwd: '/workspace', serviceName: 'test', developerInstructions: 'Test', conversations });
  return { agents, service, client, calls, root, child, nested,
    account(id: string) { active = id; }, handoff() { currentRoot = 'latest'; },
    pages(handler: (params: JsonObject) => unknown) { pages = handler; } };
}

test('foreign agent list, child opening, goal and parent traversal all use the history account', async () => {
  const h = fixture();
  try {
    await h.service.openSession('root');
    const list = await h.service.listAgents();
    expect(list.agents.map(agent => agent.id)).toEqual(['root', 'child', 'nested']);
    expect((await h.service.openAgent('nested')).session.id).toBe('nested');
    expect(await h.service.getGoal()).toEqual({ goal: null });
    expect((await h.service.listAgents()).agents.find(agent => agent.id === 'nested')).toMatchObject({ current: true, depth: 2 });
    expect(h.calls.every(call => call.account === 'a')).toBe(true);
    expect(h.calls.filter(call => call.method === 'thread/list').every(call => call.params.ancestorThreadId === 'root')).toBe(true);
    expect(h.client.requests).toHaveLength(0);
  } finally { await h.service.stop(); }
});

test('foreign subagents cannot accidentally execute in the currently selected account', async () => {
  const h = fixture();
  try {
    await h.service.openSession('root');
    await h.service.listAgents();
    await h.service.openAgent('child');
    await failure(h.service.ensureWritableThread(), 'original account');
    expect(h.client.requests).toHaveLength(0);
    h.account('a');
    expect(() => h.agents.assertWritable('child')).not.toThrow();
  } finally { await h.service.stop(); }
});

test('a known historical agent tree retains its physical owner when the main conversation is handed off', async () => {
  const h = fixture();
  await h.agents.descendants('root');
  h.handoff();
  h.calls.length = 0;
  expect(recordValue(await h.agents.read('nested', 'thread/read'))?.thread).toEqual(h.nested);
  expect(recordValue(await h.agents.read('root', 'thread/read'))?.thread).toEqual(h.root);
  expect(h.calls.map(call => call.account)).toEqual(['a', 'a']);
  await h.service.stop();
});

test('an unlisted child cannot select an arbitrary account history', async () => {
  const h = fixture();
  await failure(h.agents.read('nested', 'thread/read'), 'registered root');
  expect(h.calls).toHaveLength(0);
  await h.service.stop();
});

test('invalid trees are rejected before descendant owners are cached', async () => {
  for (const data of [
    [{ ...codexThread('child'), parentThreadId: 'outside' }],
    [{ ...codexThread('child'), parentThreadId: 'nested' }, { ...codexThread('nested'), parentThreadId: 'child' }],
  ]) {
    const h = fixture();
    h.pages(() => ({ data }));
    await failure(h.agents.descendants('root'), 'agent history');
    await failure(h.agents.read('child', 'thread/read'), 'registered root');
    await h.service.stop();
  }
});

test('repeated or malformed pages fail instead of silently truncating the tree', async () => {
  for (const nextCursor of ['repeat', 42]) {
    const h = fixture();
    h.pages(() => ({ data: [h.child], nextCursor }));
    await failure(h.agents.descendants('root'), nextCursor === 'repeat' ? 'repeated' : 'invalid page');
    await h.service.stop();
  }
});

test('changed parents and foreign workspace roots are rejected during read', async () => {
  const h = fixture();
  await h.agents.descendants('root');
  h.child.parentThreadId = 'different';
  await failure(h.agents.read('child', 'thread/read'), 'changed its parent');
  h.root.cwd = '/another-workspace';
  await failure(h.agents.read('root', 'thread/read'), 'another workspace');
  await h.service.stop();
});
