import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecialistAgent } from './agent.ts';
import type { RpcClient } from './app-server-client.ts';
import { createDeferred, type JsonRecord, type Notification } from './protocol.ts';
import { AgentStore } from './store.ts';
import { WorkerHistoryQueue } from './history-queue.ts';

const directories: string[] = [];
function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-specialist-agent-'));
  directories.push(directory); return directory;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });

async function expectFailure(operation: Promise<unknown>, message: string): Promise<void> {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}

class FakeClient implements RpcClient {
  readonly calls: { method: string; params: JsonRecord }[] = [];
  readonly started = createDeferred<void>();
  toolHandler: ((params: JsonRecord) => Promise<JsonRecord>) | undefined;
  handleTools(handler: (params: JsonRecord) => Promise<JsonRecord>) { this.toolHandler = handler; }
  private readonly listeners = new Set<(event: Notification) => void>();
  private readonly failures = new Set<(error: Error) => void>();
  account: unknown = { type: 'chatgpt' };
  resumeId = 'thread';
  onInject: (params: JsonRecord) => Promise<JsonRecord> = async () => ({});
  onStart: (params: JsonRecord) => Promise<JsonRecord> = async () => {
    this.complete(); return { turn: { id: 'turn' } };
  };
  onInterrupt: () => Promise<JsonRecord> = async () => {
    this.complete('interrupted'); return {};
  };

  async request(method: string, params: JsonRecord): Promise<JsonRecord> {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: this.account };
    if (method === 'thread/start') return { thread: { id: 'thread' }, model: 'test-model' };
    if (method === 'thread/resume') return { thread: { id: this.resumeId }, model: 'test-model' };
    if (method === 'thread/inject_items') return await this.onInject(params);
    if (method === 'turn/start') { this.started.resolve(); return await this.onStart(params); }
    if (method === 'turn/interrupt') return await this.onInterrupt();
    throw new Error(`Unexpected request: ${method}`);
  }
  subscribe(listener: (event: Notification) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener); return () => { this.failures.delete(listener); };
  }
  disconnect(): void { for (const listener of this.failures) listener(new Error('transport lost')); }
  complete(status = 'completed', text = 'verification result'): void {
    const event = { method: 'turn/completed', params: { threadId: 'thread', turn: {
      id: 'turn', status, items: [{ id: 'answer', type: 'agentMessage', text }], error: null,
    } } };
    for (const listener of this.listeners) listener(event);
  }
}

function setup(store = new AgentStore(temporary()), timeoutMs = 1000) {
  const client = new FakeClient();
  const agent = new SpecialistAgent({ client, store, profile: 'verifier role', workspace: '/workspace', timeoutMs });
  return { agent, client, store };
}

test('records completion before acknowledgement with read-only role and policy', async () => {
  const { agent, client, store } = setup();
  agent.submit('review', 'inspect');
  await agent.settled();
  expect(store.task('review')?.status).toBe('completed');
  expect(store.task('review')?.output).toBe('verification result');
  expect(client.calls.find(call => call.method === 'thread/start')?.params).toMatchObject({
    sandbox: 'read-only', approvalPolicy: 'on-request', developerInstructions: 'verifier role',
  });
  expect(client.calls.find(call => call.method === 'turn/start')?.params.sandboxPolicy)
    .toEqual({ type: 'readOnly', networkAccess: false });
  expect(client.calls.some(call => call.method === 'thread/inject_items')).toBe(false);
});

test('deduplicates task ids, blocks concurrent work, and cancels before acknowledgement', async () => {
  const { agent, client, store } = setup();
  const acknowledgement = createDeferred<JsonRecord>();
  client.onStart = () => acknowledgement.promise;
  agent.submit('review', 'inspect');
  await client.started.promise;
  expect(agent.submit('review', 'inspect').id).toBe('review');
  expect(() => agent.submit('review', 'different')).toThrow('different prompt');
  expect(() => agent.submit('other', 'inspect')).toThrow('active task');
  await agent.stop('review');
  acknowledgement.resolve({ turn: { id: 'turn' } });
  await agent.settled();
  expect(store.task('review')?.status).toBe('interrupted');
  expect(client.calls.filter(call => call.method === 'turn/start')).toHaveLength(1);
  expect(client.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(1);
});

test('does not overwrite known completion when a stop races with acknowledgement', async () => {
  const { agent, client, store } = setup();
  const acknowledgement = createDeferred<JsonRecord>();
  client.onStart = () => acknowledgement.promise;
  agent.submit('review', 'inspect');
  await client.started.promise;
  await agent.stop('review');
  client.complete();
  acknowledgement.resolve({ turn: { id: 'turn' } });
  await agent.settled();
  expect(store.task('review')?.status).toBe('completed');
  expect(client.calls.some(call => call.method === 'turn/interrupt')).toBe(false);
});

test('quarantines ambiguous submission failure and never automatically retries it', async () => {
  const directory = temporary();
  const { agent, client, store } = setup(new AgentStore(directory));
  client.onStart = async () => { throw new Error('acknowledgement lost'); };
  agent.submit('review', 'inspect');
  await agent.settled();
  expect(store.task('review')?.status).toBe('unknown');
  expect(() => agent.submit('next', 'inspect')).toThrow('outcome is unknown');
  const restored = setup(new AgentStore(directory));
  expect(() => restored.agent.submit('next', 'inspect')).toThrow('outcome is unknown');
  expect(restored.client.calls).toHaveLength(0);
});

test('resumes a persisted native thread and loads the saved successful summary', async () => {
  const directory = temporary();
  const first = setup(new AgentStore(directory));
  first.agent.submit('first', 'inspect');
  await first.agent.settled();
  const second = setup(new AgentStore(directory));
  second.agent.submit('second', 'recall');
  await second.agent.settled();
  expect(second.client.calls.find(call => call.method === 'thread/resume')?.params.threadId).toBe('thread');
  expect(second.client.calls.some(call => call.method === 'thread/start')).toBe(false);
  expect(JSON.stringify(second.client.calls.find(call => call.method === 'turn/start')?.params.input))
    .toContain('verification result');
  expect(second.store.task('second')?.status).toBe('completed');
});

test('cold resume acknowledges the latest developer snapshot before starting work and injects only once', async () => {
  const directory = temporary();
  const first = setup(new AgentStore(directory));
  first.agent.submit('first', 'inspect'); await first.agent.settled();
  const client = new FakeClient(), store = new AgentStore(directory);
  const agent = new SpecialistAgent({ client, store, profile: 'common V2\nproject V2', workspace: '/workspace' });
  const injected = createDeferred<void>(), acknowledgement = createDeferred<JsonRecord>();
  client.onInject = async () => { injected.resolve(); return await acknowledgement.promise; };
  agent.submit('second', 'recall');
  await injected.promise;
  expect(client.calls.map(call => call.method)).toEqual(['account/read', 'thread/resume', 'thread/inject_items']);
  const snapshot = client.calls.find(call => call.method === 'thread/inject_items')?.params;
  expect(JSON.stringify(snapshot)).toContain('common V2\\nproject V2');
  expect(JSON.stringify(snapshot)).toContain('Instructions omitted from this snapshot no longer apply');
  expect(snapshot).toMatchObject({ threadId: 'thread', items: [{ type: 'message', role: 'developer', content: [
    { type: 'input_text' },
  ] }] });
  acknowledgement.resolve({}); await agent.settled();
  expect(store.snapshot().threadId).toBe('thread');
  expect(store.task('first')?.output).toBe('verification result');
  expect(store.task('second')?.status).toBe('completed');
  agent.submit('third', 'continue'); await agent.settled();
  expect(client.calls.filter(call => call.method === 'thread/inject_items')).toHaveLength(1);
  expect(client.calls.some(call => call.method === 'thread/start')).toBe(false);
});

test('failed instruction injection blocks model work and retries the snapshot on the next task', async () => {
  const store = new AgentStore(temporary()); store.saveThread('thread', 'test-model');
  const { agent, client } = setup(store);
  client.onInject = async () => { throw new Error('instruction update rejected'); };
  agent.submit('failed', 'inspect'); await agent.settled();
  expect(store.task('failed')?.status).toBe('failed');
  expect(store.task('failed')?.error).toBe('instruction update rejected');
  expect(client.calls.some(call => call.method === 'turn/start')).toBe(false);
  expect(store.snapshot().threadId).toBe('thread');
  client.onInject = async () => ({});
  agent.submit('retry', 'inspect'); await agent.settled();
  expect(store.task('retry')?.status).toBe('completed');
  expect(client.calls.filter(call => call.method === 'thread/inject_items')).toHaveLength(2);
});

test('a mismatched resumed thread never receives instructions or model work', async () => {
  const store = new AgentStore(temporary()); store.saveThread('thread', 'test-model');
  const { agent, client } = setup(store); client.resumeId = 'different';
  agent.submit('review', 'inspect'); await agent.settled();
  expect(store.task('review')?.error).toBe('Resumed thread id changed.');
  expect(client.calls.some(call => ['thread/inject_items', 'turn/start'].includes(call.method))).toBe(false);
  expect(store.snapshot().threadId).toBe('thread');
});

test('reports missing authentication before submitting any model work', async () => {
  const { agent, client, store } = setup();
  client.account = null;
  agent.submit('review', 'inspect');
  await agent.settled();
  expect(store.task('review')?.status).toBe('failed');
  expect(store.task('review')?.error).toContain('Sign in');
  expect(client.calls.some(call => call.method === 'turn/start')).toBe(false);
});

test('transport loss after acknowledgement retains unknown execution status', async () => {
  const { agent, client, store } = setup();
  client.onStart = async () => { client.disconnect(); return { turn: { id: 'turn' } }; };
  agent.submit('review', 'inspect');
  await agent.settled();
  expect(store.task('review')?.status).toBe('unknown');
  expect(store.task('review')?.error).toBe('transport lost');
});

test('deadline requests interruption without claiming a completed or canceled outcome', async () => {
  const { agent, client, store } = setup(undefined, 10);
  client.onStart = async () => ({ turn: { id: 'turn' } });
  client.onInterrupt = async () => ({});
  agent.submit('review', 'inspect');
  await agent.settled();
  expect(store.task('review')?.status).toBe('unknown');
  expect(client.calls.some(call => call.method === 'turn/interrupt')).toBe(true);
});

test('exposes persistence failure to worker health instead of silently accepting more work', async () => {
  class BrokenStore extends AgentStore {
    override complete(): void { throw new Error('disk unavailable'); }
  }
  const { agent } = setup(new BrokenStore(temporary()));
  agent.submit('review', 'inspect');
  await expectFailure(agent.settled(), 'disk unavailable');
  expect(agent.error).toBe('Could not persist specialist task state.');
  expect(() => agent.submit('next', 'inspect')).toThrow('Could not persist');
});

test('registered profiles carry model, effort, tier and command restrictions into the native thread and turn', async () => {
  const client = new FakeClient(), store = new AgentStore(temporary());
  const agent = new SpecialistAgent({ client, store, profile: 'project instructions', workspace: '/workspace', configuration: {
    profileId: 'profile', accountId: 'default', role: 'development', token: 'a'.repeat(64), instructions: 'project instructions',
    model: 'gpt-6-astra', reasoningEffort: 'high', serviceTier: null, permissions: { fileWrite: false, commandExecution: false },
  } });
  agent.submit('model-check', 'test'); await agent.settled();
  expect(client.calls.find(call => call.method === 'thread/start')?.params).toMatchObject({ model: 'gpt-6-astra', serviceTier: null,
    sandbox: 'read-only', config: { model_reasoning_effort: 'high', 'features.shell_tool': false, 'features.unified_exec': false, 'features.multi_agent': false } });
  expect(client.calls.find(call => call.method === 'turn/start')?.params).toMatchObject({ model: 'gpt-6-astra', effort: 'high', serviceTier: null,
    sandboxPolicy: { type: 'readOnly', networkAccess: false } });
});


test('native history calls bind to the active task and stop cancels pending relay work', async () => {
  const directory = temporary(), store = new AgentStore(directory), historyQueue = new WorkerHistoryQueue(directory);
  const client = new FakeClient(); client.onStart = async () => ({ turn: { id: 'turn' } });
  const agent = new SpecialistAgent({ client, store, workspace: '/workspace', profile: 'Test', historyQueue });
  agent.submit('recall', 'Find the policy.'); await client.started.promise;
  await Bun.sleep(0);
  const tools = client.calls.find(c => c.method === 'thread/start')!.params.dynamicTools as { name: string }[];
  expect(tools.map(t => t.name)).toEqual(['history_search', 'history_read']);
  await expectFailure(client.toolHandler!({ threadId: 'foreign', turnId: 'turn', callId: 'bad', tool: 'history_search', arguments: { query: 'policy' } }), 'active task');
  await expectFailure(client.toolHandler!({ threadId: 'thread', turnId: 'wrong', callId: 'bad', tool: 'history_search', arguments: { query: 'policy' } }), 'active task');
  const pending = client.toolHandler!({ threadId: 'thread', turnId: 'turn', callId: 'call', tool: 'history_read', arguments: { threadId: 'past', turnId: 't', itemId: 'i' } });
  expect(historyQueue.exchange({ protocol: 1, enabled: true, results: [] }).requests[0]).toMatchObject({ taskId: 'recall', threadId: 'thread', tool: 'history_read' });
  await agent.stop('recall'); expect((await pending).status).toBe('error'); await agent.settled();
  expect(historyQueue.exchange({ protocol: 1, enabled: true, results: [] }).requests).toHaveLength(0);
});
