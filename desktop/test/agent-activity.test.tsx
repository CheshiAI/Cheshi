import { expect, mock, test } from 'bun:test';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { agentCacheRate, createAgentDetailsLoader, normalizeAgentDetails, type AgentDetails } from '../frontend/src/features/chat/agentDetailsModel';
import type { ChatActivityItem } from '../frontend/src/features/chat/model';

const requests: Array<{ threadId: string; ids: string[]; contextId?: string }> = [];
let response: (threadId: string) => Promise<unknown> = async () => ({ agents: [] });
mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: {
  readCodexAgentDetails(threadId: string, ids: string[], contextId?: string) {
    requests.push({ threadId, ids, contextId });
    return response(threadId);
  },
} }));
const { AgentActivity, AgentActivityProvider, AgentDetailsContent } = await import('../frontend/src/features/chat/AgentActivity');

const agent: AgentDetails = {
  id: 'child', title: 'cheshi-luna-max', status: 'idle', model: 'gpt-5.6-luna', reasoningEffort: 'max',
  usage: { inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: null,
    outputTokens: 100, reasoningOutputTokens: 40, totalTokens: 1100 },
  items: [{ id: 'command', kind: 'activity', activity: 'command', label: 'Command', detail: 'git status',
    output: 'working tree clean', status: 'completed', exitCode: 0 }], omittedItems: 0,
};
const item: ChatActivityItem = { id: 'collab', kind: 'activity', activity: 'agent', label: 'Collaboration', detail: 'Coordinating agents',
  status: 'completed', agent: { threadIds: ['child'], tool: 'spawnAgent', prompt: 'Commit the changes.', model: 'gpt-5.6-luna',
    reasoningEffort: 'max', agentPath: '/root/cheshi_luna_max' } };

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

test('agent details show actual cache share, model, effort and expandable command output', () => {
  const html = renderToStaticMarkup(<AgentDetailsContent agents={[agent]} />);
  expect(html).toContain('80.0%');
  expect(html).toContain('gpt-5.6-luna');
  expect(html).toContain('max');
  expect(html).toContain('working tree clean');
  expect(html).toContain('Agent cumulative usage');
  expect(html).toContain('<details>');
  const absent = renderToStaticMarkup(<AgentDetailsContent agents={[{ ...agent, usage: null }]} />);
  expect(absent).toContain('Usage information unavailable.');
  expect(absent).not.toContain('0.0%');
  expect(agentCacheRate({ ...agent.usage!, cachedInputTokens: null })).toBe('Not available');
  expect(agentCacheRate({ ...agent.usage!, inputTokens: 0, cachedInputTokens: 0 })).toBe('Not available');
  expect(agentCacheRate({ ...agent.usage!, cachedInputTokens: 0 })).toBe('0.0%');
});

test('response validation rejects unrelated or missing agents and preserves activity metadata', () => {
  expect(() => normalizeAgentDetails({ agents: [agent] }, ['another'])).toThrow('does not match');
  expect(() => normalizeAgentDetails({ agents: [] }, ['child'])).toThrow('missing');
  const parsed = normalizeAgentDetails({ agents: [{ ...agent, items: [item] }] }, ['child']);
  expect(parsed[0]?.items[0]).toMatchObject({ agent: item.agent });
});

test('concurrent cards share one read, expire snapshots and keep conversation caches separate', async () => {
  const gate = createDeferred<unknown>();
  let calls = 0;
  let time = 0;
  const load = createAgentDetailsLoader(async () => { calls++; return gate.promise; }, () => time);
  const first = load(['child']);
  const second = load(['child', 'child']);
  expect(first).toBe(second);
  gate.resolve({ agents: [agent] });
  expect(await first).toEqual([agent]);
  expect(await load(['child'])).toEqual([agent]);
  expect(calls).toBe(1);
  time = 2001;
  await load(['child']);
  expect(calls).toBe(2);
  const otherConversation = createAgentDetailsLoader(async () => ({ agents: [{ ...agent, title: 'Other owner' }] }));
  expect((await otherConversation(['child']))[0]?.title).toBe('Other owner');
});

test('failed reads can be retried instead of caching an error forever', async () => {
  let attempts = 0;
  const load = createAgentDetailsLoader(async () => {
    if (++attempts === 1) throw new Error('Temporary error');
    return { agents: [agent] };
  });
  let error: unknown;
  try { await load(['child']); } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(Error);
  expect(await load(['child'])).toEqual([agent]);
});

test('cards fetch only when expanded and ignore a previous conversation response', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  const gate = createDeferred<unknown>();
  response = async threadId => threadId === 'root' ? gate.promise : { agents: [{ ...agent, title: 'New conversation agent' }] };
  requests.length = 0;
  const render = (threadId: string) => <AgentActivityProvider key={threadId} contextId="pane-b" threadId={threadId} active streaming={false}>
    <AgentActivity item={item} />
  </AgentActivityProvider>;
  const expand = async () => {
    await act(async () => {
      const details = container.querySelector('details')!;
      details.open = true;
      details.dispatchEvent(new window.Event('toggle'));
    });
  };
  try {
    await act(async () => root.render(render('root')));
    expect(requests).toHaveLength(0);
    await expand();
    expect(requests).toEqual([{ threadId: 'root', ids: ['child'], contextId: 'pane-b' }]);
    await act(async () => root.render(render('next')));
    await expand();
    expect(container.textContent).toContain('New conversation agent');
    await act(async () => gate.resolve({ agents: [{ ...agent, title: 'Stale agent' }] }));
    expect(container.textContent).not.toContain('Stale agent');
    expect(container.textContent).toContain('80.0%');
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
