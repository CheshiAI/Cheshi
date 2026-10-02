import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecialistAgent } from './agent.ts';
import type { RpcClient } from './app-server-client.ts';
import { createDeferred, type JsonRecord, type Notification } from './protocol.ts';
import { AgentStore } from './store.ts';

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
  private readonly listeners = new Set<(event: Notification) => void>();
  private readonly failures = new Set<(error: Error) => void>();
  account: unknown = { type: 'chatgpt' };
  resumeId = 'thread';
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
