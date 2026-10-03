import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecialistAgent } from './agent.ts';
import type { RpcClient } from './app-server-client.ts';
import { createDeferred, record, type JsonRecord, type Notification } from './protocol.ts';
import { SCRATCH_PROFILE } from './task-scratch.ts';
import { AgentStore } from './store.ts';
import { WorkerHistoryQueue } from './history-queue.ts';
import { WorkerCollaboration } from './collaboration.ts';
import { expireQuestions } from './question-control.ts';
import { newGoal } from './decision.ts';

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
  onRead: () => Promise<JsonRecord> = async () => ({ thread: { id: 'thread', cwd: '/workspace', turns: [{ id: 'turn', status: 'completed', items: [{ type: 'agentMessage', text: 'Recovered result' }] }] } });
  onInject: (params: JsonRecord) => Promise<JsonRecord> = async () => ({});
  onUnsubscribe: () => Promise<JsonRecord> = async () => ({ status: 'unsubscribed' });
  onStart: (params: JsonRecord) => Promise<JsonRecord> = async () => {
    this.complete(); return { turn: { id: 'turn' } };
  };
  onInterrupt: () => Promise<JsonRecord> = async () => {
    this.complete('interrupted'); return {};
  };

  async request(method: string, params: JsonRecord): Promise<JsonRecord> {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: this.account };
    if (method === 'thread/start' || method === 'thread/resume') {
      const scratch = params.permissions === SCRATCH_PROFILE
        ? { activePermissionProfile: { id: SCRATCH_PROFILE }, sandbox: { type: 'workspaceWrite',
          writableRoots: [record(record(params.config)['shell_environment_policy.set']).TMPDIR],
          networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } } : {};
      return { thread: { id: method === 'thread/start' ? 'thread' : this.resumeId }, model: 'test-model', ...scratch };
    }
    if (method === 'thread/read') return this.onRead();
    if (method === 'thread/unsubscribe') return this.onUnsubscribe();
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

function goalSetup(directory = temporary()) {
  const store = new AgentStore(directory), client = new FakeClient();
  const agent = new SpecialistAgent({ client, store, workspace: '/workspace', profile: 'Follow the user goal.',
    configuration: { decisionProtocol: 1, profileId: 'dev', accountId: 'fixture', role: 'development', token: 'a'.repeat(64),
      instructions: 'Follow the user goal.', model: null, reasoningEffort: null, serviceTier: null,
      permissions: { fileWrite: false, commandExecution: false } } });
  const decide = (action: string) => client.toolHandler!({ threadId: 'thread', turnId: 'turn', tool: 'record_decision', arguments: {
    action, reason: 'Verified the current progress.', progress: 'One step checked.', nextAction: action === 'continue' ? 'Check the remaining result.' : '',
    criteria: [{ criterion: 'Verify the requested result.', met: action === 'complete', evidence: action === 'complete' ? 'Observed the expected result.' : '' }],
  } });
  return { agent, client, store, decide, directory };
}

test('goal continues after cold restart and only explicit evidenced completion finishes it', async () => {
  let f = goalSetup();
  f.client.onStart = async () => { await f.decide('continue'); f.client.complete(); return { turn: { id: 'turn' } }; };
  f.agent.submit('goal', 'Verify the requested result.'); await f.agent.settled();
  expect(f.store.task('goal')).toMatchObject({ status: 'waiting', finishedAt: null, goal: { turns: 1, phase: 'ready' } });
  expect(f.store.memory()).toBe('');
  f = goalSetup(f.directory);
  expect(f.store.task('goal')?.goal?.decisions).toHaveLength(1);
  f.client.onStart = async params => {
    expect(JSON.stringify(params.input)).toContain('Check the remaining result.');
    await f.decide('complete'); f.client.complete(); return { turn: { id: 'turn' } };
  };
  f.agent.pump(); await f.agent.settled();
  expect(f.store.task('goal')).toMatchObject({ status: 'completed', goal: { turns: 2, phase: 'completed' } });
  expect(f.client.calls.some(c => c.method === 'thread/resume')).toBe(true);
  f.agent.pump(); expect(f.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
});

test('a successful model response without a decision cannot complete a goal', async () => {
  const f = goalSetup(); f.agent.submit('goal', 'Verify the requested result.'); await f.agent.settled();
  expect(f.store.task('goal')).toMatchObject({ status: 'interrupted', goal: { phase: 'blocked' } });
  expect(f.store.task('goal')?.error).toContain('No next-action decision');
  expect(f.store.memory()).toBe(''); f.agent.pump(); expect(f.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
});

test('goal decisions reject invented waiting and incomplete evidence, then permit explicit blocking', async () => {
  const f = goalSetup();
  f.client.onStart = async () => {
    await expectFailure(f.decide('wait'), 'outstanding');
    await expectFailure(f.client.toolHandler!({ threadId: 'thread', turnId: 'turn', tool: 'record_decision', arguments: {
      action: 'complete', reason: 'Done', progress: 'Done', nextAction: '', criteria: [{ criterion: 'Verify', met: true, evidence: '' }],
    } }), 'evidence');
    await f.decide('blocked');
    await expectFailure(f.client.toolHandler!({ threadId: 'thread', turnId: 'turn', tool: 'history_search', arguments: {} }), 'End the turn');
    f.client.complete(); return { turn: { id: 'turn' } };
  };
  f.agent.submit('goal', 'Verify the requested result.'); await f.agent.settled();
  expect(f.store.task('goal')).toMatchObject({ status: 'interrupted', goal: { phase: 'blocked' } });
});

test('persisted turn budget stops a repeatedly continuing goal', async () => {
  const f = goalSetup();
  f.client.onStart = async () => { await f.decide('continue'); f.client.complete(); return { turn: { id: 'turn' } }; };
  f.agent.submit('goal', 'Verify the requested result.'); await f.agent.settled();
  for (let i = 0; i < 12; i++) { f.agent.pump(); await f.agent.settled(); }
  expect(f.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(8);
  expect(f.store.task('goal')).toMatchObject({ status: 'interrupted', goal: { turns: 8, phase: 'blocked' } });
  expect(f.store.task('goal')?.error).toContain('turn limit');
});

test('canceling queued continuation prevents execution after restart', async () => {
  const f = goalSetup();
  f.client.onStart = async () => { await f.decide('continue'); f.client.complete(); return { turn: { id: 'turn' } }; };
  f.agent.submit('goal', 'Verify the requested result.'); await f.agent.settled(); await f.agent.stop('goal');
  const restored = goalSetup(f.directory); restored.agent.pump();
  expect(restored.agent.busy).toBe(false); expect(restored.store.task('goal')?.status).toBe('interrupted');
});

test('a recorded decision cannot cause continuation if transport fails before turn completion', async () => {
  const f = goalSetup();
  f.client.onStart = async () => { await f.decide('continue'); f.client.disconnect(); return { turn: { id: 'turn' } }; };
  f.agent.submit('goal', 'Verify the requested result.'); await f.agent.settled();
  const restored = goalSetup(f.directory); restored.agent.pump();
  expect(restored.store.task('goal')?.status).toBe('unknown'); expect(restored.agent.busy).toBe(false);
});

test('a confirmed evidenced completion survives a concurrent stop request', async () => {
  const f = goalSetup(), ready = createDeferred<void>(), acknowledgement = createDeferred<JsonRecord>();
  f.client.onStart = async () => { await f.decide('complete'); ready.resolve(); return acknowledgement.promise; };
  f.agent.submit('goal', 'Verify the requested result.'); await ready.promise;
  await f.agent.stop('goal'); f.client.complete(); acknowledgement.resolve({ turn: { id: 'turn' } });
  await f.agent.settled();
  expect(f.store.task('goal')).toMatchObject({ status: 'completed', goal: { phase: 'completed' } });
});

test('canceling during a recorded continuation never schedules its next turn', async () => {
  const f = goalSetup(), ready = createDeferred<void>(), acknowledgement = createDeferred<JsonRecord>();
  f.client.onStart = async () => { await f.decide('continue'); ready.resolve(); return acknowledgement.promise; };
  f.agent.submit('goal', 'Verify the requested result.'); await ready.promise;
  await f.agent.stop('goal'); f.client.complete(); acknowledgement.resolve({ turn: { id: 'turn' } }); await f.agent.settled();
  f.agent.pump();
  expect(f.store.task('goal')).toMatchObject({ status: 'interrupted', goal: { phase: 'blocked', pending: null } });
  expect(f.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
});

test('self-reported completion is refused when independent verification is required', async () => {
  const client = new FakeClient(), store = new AgentStore(temporary());
  const agent = new SpecialistAgent({ client, store, workspace: '/workspace', profile: 'Goal', configuration: {
    decisionProtocol: 1, verificationProtocol: 1, profileId: 'dev', accountId: 'fixture', role: 'development', token: 'a'.repeat(64),
    instructions: 'Goal', model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: false, commandExecution: false },
  } });
  client.onStart = async () => {
    await expectFailure(client.toolHandler!({ threadId: 'thread', turnId: 'turn', tool: 'record_decision', arguments: {
      action: 'complete', reason: 'I claim this is done', progress: 'Done', nextAction: '', criteria: [{ criterion: 'Original goal', met: true, evidence: 'Self-reported pass' }],
    } }), 'verification is unavailable');
    client.complete(); return { turn: { id: 'turn' } };
  };
  agent.submit('goal', 'Original goal'); await agent.settled();
  expect(store.task('goal')?.status).toBe('interrupted');
  expect(store.task('goal')?.goal?.verificationRequired).toBe(true);
  expect(store.memory()).toBe('');
});

test('verification keeps the project read-only and grants only command-enabled test scratch', async () => {
  for (const commandExecution of [false, true]) {
    const client = new FakeClient(), store = new AgentStore(temporary());
    const collaboration = new WorkerCollaboration(store, 'reviewer', '/workspace');
    collaboration.exchange({ peers: [{ id: 'dev', name: 'Developer', role: 'development' }], acknowledged: [], messages: [{
      id: 'request', questionId: 'request', kind: 'verification_request', from: 'dev', to: 'reviewer', taskId: 'goal',
      text: JSON.stringify({ goal: 'Original goal', criteria: ['Goal met'], artifacts: [{ path: 'login.ts', sha256: 'a'.repeat(64) }] }),
    }] });
    const agent = new SpecialistAgent({ client, store, collaboration, workspace: '/workspace', profile: 'Verify', configuration: {
      decisionProtocol: 1, verificationProtocol: 1, profileId: 'reviewer', accountId: 'fixture', role: 'verification', token: 'a'.repeat(64),
      instructions: 'Verify', model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: true, commandExecution },
    } });
    agent.pump(); await agent.settled();
    const start = client.calls.find(c => c.method === 'thread/start')!.params;
    expect(start).toMatchObject({
      config: { 'features.shell_tool': commandExecution, 'features.unified_exec': commandExecution } });
    const turn = client.calls.find(c => c.method === 'turn/start')!.params;
    if (commandExecution) {
      expect(start.permissions).toBe(SCRATCH_PROFILE); expect(turn.permissions).toBe(SCRATCH_PROFILE);
      expect(start).not.toHaveProperty('sandbox'); expect(turn).not.toHaveProperty('sandboxPolicy');
      const config = record(start.config), environment = record(config['shell_environment_policy.set']);
      expect(config.default_permissions).toBe(SCRATCH_PROFILE);
      const directory = String(environment.TMPDIR);
      expect(config[`permissions.${SCRATCH_PROFILE}`]).toEqual({
        filesystem: { ':root': 'read', '/workspace': 'read', [directory]: 'write' }, network: { enabled: false },
      });
      expect(existsSync(directory)).toBe(false);
    } else {
      expect(start.sandbox).toBe('read-only');
      expect(turn.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
    }
    expect(JSON.parse(store.snapshot().collaboration.outgoing[0]!.text).verdicts[0].verdict).toBe('inconclusive');
    expect(store.memory()).toBe('');
  }
});

test('read-only command turns get fresh scratch on warm and cold resumes and clean known outcomes', async () => {
  const store = new AgentStore(temporary());
  const configuration = { profileId: 'reviewer', accountId: 'fixture', role: 'verification', token: 'a'.repeat(64),
    instructions: 'Verify', model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: false, commandExecution: true } };
  const directories: string[] = [];
  const create = () => {
    const client = new FakeClient();
    client.onStart = async () => {
      const thread = [...client.calls].reverse().find(c => c.method === 'thread/start' || c.method === 'thread/resume')!;
      const directory = String(record(record(thread.params.config)['shell_environment_policy.set']).TMPDIR);
      expect(existsSync(directory)).toBe(true);
      writeFileSync(join(directory, 'test-output'), 'disposable'); directories.push(directory);
      client.complete(directories.length === 2 ? 'failed' : 'completed'); return { turn: { id: 'turn' } };
    };
    return { client, agent: new SpecialistAgent({ client, store, workspace: '/workspace', profile: 'Verify', configuration }) };
  };
  const first = create();
  first.agent.submit('first', 'Test'); await first.agent.settled();
  first.agent.submit('second', 'Retest'); await first.agent.settled();
  expect(first.client.calls.filter(c => c.method === 'thread/resume')).toHaveLength(1);
  expect(first.client.calls.findIndex(c => c.method === 'thread/unsubscribe'))
    .toBeLessThan(first.client.calls.findIndex(c => c.method === 'thread/resume'));
  const second = create();
  second.agent.submit('third', 'Restarted test'); await second.agent.settled();
  expect(second.client.calls.some(c => c.method === 'thread/resume')).toBe(true);
  expect(new Set(directories).size).toBe(3);
  expect(directories.every(directory => !existsSync(directory))).toBe(true);
  expect(store.task('second')?.status).toBe('failed');
});

test('unknown execution retains scratch until app-server shutdown cleanup and blocks further work', async () => {
  const client = new FakeClient(), store = new AgentStore(temporary());
  let directory = '';
  client.onStart = async () => {
    directory = String(record(record(client.calls.find(c => c.method === 'thread/start')!.params.config)['shell_environment_policy.set']).TMPDIR);
    throw new Error('transport lost');
  };
  const agent = new SpecialistAgent({ client, store, workspace: '/workspace', profile: 'Verify', configuration: {
    profileId: 'reviewer', accountId: 'fixture', role: 'verification', token: 'a'.repeat(64), instructions: 'Verify',
    model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: false, commandExecution: true },
  } });
  try {
    agent.submit('unknown', 'Test'); await agent.settled();
    expect(store.task('unknown')?.status).toBe('unknown');
    expect(existsSync(directory)).toBe(true);
    expect(() => agent.submit('other', 'Test')).toThrow('unknown');
  } finally { agent.disposeScratch(); }
  expect(existsSync(directory)).toBe(false);
});

test('failed execution-session cleanup retains scratch and stops further tasks', async () => {
  const client = new FakeClient(), store = new AgentStore(temporary());
  client.onUnsubscribe = async () => { throw new Error('transport lost'); };
  const agent = new SpecialistAgent({ client, store, workspace: '/workspace', profile: 'Verify', configuration: {
    profileId: 'reviewer', accountId: 'fixture', role: 'verification', token: 'a'.repeat(64), instructions: 'Verify',
    model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: false, commandExecution: true },
  } });
  let directory = '';
  try {
    agent.submit('test', 'Test'); await agent.settled();
    directory = String(record(record(client.calls.find(c => c.method === 'thread/start')!.params.config)['shell_environment_policy.set']).TMPDIR);
    expect(existsSync(directory)).toBe(true);
    expect(agent.error).toContain('Restart the worker');
    expect(() => agent.submit('another', 'Test')).toThrow('Restart the worker');
  } finally { agent.disposeScratch(); }
  expect(existsSync(directory)).toBe(false);
});

test('Chats goal follow-up resumes its saved thread and deduplicates input after restart', async () => {
  let f = goalSetup();
  f.client.onStart = async () => { await f.decide('blocked'); f.client.complete(); return { turn: { id: 'turn' } }; };
  f.agent.submit('chats_goal', 'Verify the requested result.', { roomId: 'room', conversation: 'chats_goal', goal: true });
  await f.agent.settled();
  expect(f.store.task('chats_goal')?.responses).toHaveLength(1);
  f = goalSetup(f.directory);
  f.client.onStart = async () => { await f.decide('complete'); f.client.complete(); return { turn: { id: 'turn' } }; };
  expect(() => f.agent.input('chats_goal', 'input', 'New evidence', 'other')).toThrow('room');
  f.agent.input('chats_goal', 'input', 'New evidence', 'room'); await f.agent.settled();
  expect(f.client.calls.some(c => c.method === 'thread/resume')).toBe(true);
  expect(f.store.task('chats_goal')).toMatchObject({ status: 'completed', roomId: 'room', goal: { turns: 2 } });
  f = goalSetup(f.directory);
  f.agent.input('chats_goal', 'input', 'New evidence', 'room'); await f.agent.settled();
  expect(f.client.calls).toHaveLength(0);
  expect(f.store.task('chats_goal')?.responses).toHaveLength(2);
  expect(() => f.agent.input('chats_goal', 'input', 'Changed content', 'room')).toThrow('identity');
  expect(() => f.agent.input('chats_goal', 'new', 'More work', 'room')).toThrow('completed');
});

test('Chats conversations resume independently of goals and do not share threads across rooms', async () => {
  const f = goalSetup();
  f.agent.submit('chats_first', 'Hello', { roomId: 'room', conversation: 'room_dev', goal: false }); await f.agent.settled();
  expect(f.store.task('chats_first')?.goal).toBeUndefined();
  expect(f.store.task('chats_first')?.status).toBe('completed');
  f.agent.submit('chats_second', 'Remember this?', { roomId: 'room', conversation: 'room_dev', goal: false }); await f.agent.settled();
  expect(f.client.calls.filter(c => c.method === 'thread/start')).toHaveLength(1);
  f.agent.submit('chats_other', 'Separate room', { roomId: 'other', conversation: 'other_dev', goal: false }); await f.agent.settled();
  expect(f.client.calls.filter(c => c.method === 'thread/start')).toHaveLength(2);
});

test('interrupted Chats input is quarantined after restart and never replayed', async () => {
  let f = goalSetup();
  f.client.onStart = async () => { await f.decide('blocked'); f.client.complete(); return { turn: { id: 'turn' } }; };
  f.agent.submit('chats_goal', 'Verify the requested result.', { roomId: 'room', conversation: 'chats_goal', goal: true }); await f.agent.settled();
  f.store.update('chats_goal', { status: 'accepted', inputs: [{ id: 'input', prompt: 'Answer' }] });
  f = goalSetup(f.directory);
  f.agent.input('chats_goal', 'input', 'Answer', 'room'); f.agent.pump(); await f.agent.settled();
  expect(f.store.task('chats_goal')?.status).toBe('unknown'); expect(f.client.calls).toHaveLength(0);
});

async function unknownRoomGoal() {
  const f = goalSetup();
  f.client.onStart = async () => { await f.decide('blocked'); f.client.complete(); return { turn: { id: 'turn' } }; };
  f.agent.submit('goal', 'Verify login', { roomId: 'room', conversation: 'goal', goal: true });
  await f.agent.settled();
  const task = f.store.task('goal')!;
  f.store.update('goal', { status: 'unknown', goal: { ...task.goal!, verificationRequired: true } });
  return f;
}

test('native terminal result recovery survives restart, preserves verification and never runs a model or completes the goal', async () => {
  const original = await unknownRoomGoal(), f = goalSetup(original.directory), before = f.store.task('goal')!.goal!;
  const recovered = await f.agent.recover('goal', 'room');
  expect(recovered).toMatchObject({ status: 'interrupted', output: 'Recovered result', recovery: { threadId: 'thread', turnId: 'turn', status: 'completed' },
    goal: { phase: 'blocked', turns: before.turns, criteria: before.criteria, verificationRequired: true, pending: null } });
  expect(f.client.calls.map(c => c.method)).toEqual(['thread/read', 'thread/unsubscribe']);
  expect(f.store.memory()).toBe('');
  const restarted = goalSetup(f.directory);
  expect(await restarted.agent.recover('goal', 'room')).toEqual(recovered);
  expect(restarted.client.calls).toHaveLength(0);
  expect(restarted.store.task('goal')!.responses).toEqual(recovered.responses);
});

test.each(['running', 'wrong-thread', 'wrong-workspace', 'missing-turn', 'later-turn', 'fork', 'ephemeral', 'read-failure', 'unsubscribe-failure'])('unknown recovery refuses %s without changing the task', async reason => {
  const f = await unknownRoomGoal(), before = f.store.task('goal');
  f.client.onRead = async () => {
    if (reason === 'read-failure') throw new Error('read failed');
    return { thread: { id: reason === 'wrong-thread' ? 'other' : 'thread', cwd: reason === 'wrong-workspace' ? '/other' : '/workspace',
      parentThreadId: reason === 'fork' ? 'parent' : null, ephemeral: reason === 'ephemeral',
      turns: [{ id: reason === 'missing-turn' ? 'missing' : 'turn', status: reason === 'running' ? 'inProgress' : 'completed', items: [] },
        ...(reason === 'later-turn' ? [{ id: 'later', status: 'completed', items: [] }] : [])] } };
  };
  if (reason === 'unsubscribe-failure') f.client.onUnsubscribe = async () => { throw new Error('unsubscribe failed'); };
  let failed = false; try { await f.agent.recover('goal', 'room'); } catch { failed = true; }
  expect(failed).toBe(true); expect(f.store.task('goal')).toEqual(before); expect(f.agent.busy).toBe(false);
});

test('inspection locks execution and rejects duplicate inspection and wrong rooms', async () => {
  const f = await unknownRoomGoal(), gate = createDeferred<JsonRecord>();
  await expectFailure(f.agent.recover('goal', 'foreign'), 'Unknown room');
  f.client.onRead = () => gate.promise;
  const inspection = f.agent.recover('goal', 'room');
  expect(f.agent.busy).toBe(true);
  await expectFailure(f.agent.recover('goal', 'room'), 'cannot safely inspect');
  expect(() => f.agent.submit('another', 'Run another')).toThrow();
  gate.resolve({ thread: { id: 'thread', cwd: '/workspace', turns: [{ id: 'turn', status: 'failed', items: [] }] } });
  expect((await inspection).recovery?.status).toBe('failed');
  expect(f.store.task('goal')?.status).toBe('interrupted');
});

test('lost acknowledgement on a follow-up cannot reuse its preceding turn id', async () => {
  const f = await unknownRoomGoal(); await f.agent.recover('goal', 'room');
  f.client.onStart = async () => { throw new Error('lost acknowledgement'); };
  f.agent.input('goal', 'followup', 'Use email', 'room'); await f.agent.settled();
  expect(f.store.task('goal')).toMatchObject({ status: 'unknown', threadId: 'thread', turnId: null });
  expect(f.store.task('goal')?.recovery).toBeUndefined();
  await expectFailure(f.agent.recover('goal', 'room'), 'no acknowledged turn ID');
});

test('recovered pending completion cannot commit itself or reset the exhausted budget', async () => {
  const f = await unknownRoomGoal(), goal = f.store.task('goal')!.goal!;
  f.store.update('goal', { goal: { ...goal, turns: 8, phase: 'active', pending: { action: 'complete', reason: 'Claimed complete', progress: 'Claimed done', nextAction: '',
    criteria: goal.criteria.map(c => ({ ...c, met: true, evidence: 'Claimed evidence' })) } } });
  const result = await f.agent.recover('goal', 'room');
  expect(result.goal).toMatchObject({ phase: 'blocked', turns: 8, pending: null, criteria: goal.criteria, decisions: goal.decisions, verificationRequired: true });
  expect(() => f.agent.input('goal', 'extra', 'Continue', 'room')).toThrow('turn limit');
  const before = f.client.calls.length; f.agent.pump(); await f.agent.settled();
  expect(f.client.calls).toHaveLength(before);
});

test('inspection does not overwrite a task changed during its native read', async () => {
  const f = await unknownRoomGoal(), gate = createDeferred<JsonRecord>(); f.client.onRead = () => gate.promise;
  const recovery = f.agent.recover('goal', 'room');
  f.store.update('goal', { error: 'Updated during inspection' });
  const before = f.store.task('goal');
  gate.resolve({ thread: { id: 'thread', cwd: '/workspace', turns: [{ id: 'turn', status: 'interrupted', items: [] }] } });
  await expectFailure(recovery, 'changed during inspection');
  expect(f.store.task('goal')).toEqual(before);
});

test('explicit follow-up after expiry resumes the same conversation without dropping criteria or independent verification', async () => {
  const directory = temporary(), store = new AgentStore(directory);
  const collaboration = new WorkerCollaboration(store, 'dev');
  collaboration.exchange({ peers: [{ id: 'planner', name: 'Planning', role: 'planning' }], rooms: { room: ['dev', 'planner'] }, messages: [], acknowledged: [] });
  const criteria = [{ criterion: 'Verify login.', met: false, evidence: '' }];
  const goal = { ...newGoal(true), criteria, phase: 'waiting' as const, turns: 2 };
  const task = store.create('goal', 'Implement login.', { roomId: 'room', conversation: 'goal', goal });
  store.saveThread('thread', null, 'goal'); store.update('goal', { status: 'waiting' });
  collaboration.call(task, 'ask_agent', { agentId: 'planner', requestId: 'policy', question: 'Which credentials?' });
  const question = store.snapshot().collaboration.outgoing[0]!;
  const client = new FakeClient();
  const agent = new SpecialistAgent({ store, client, collaboration, profile: '', workspace: '/workspace' });
  const deadline = new Date(Date.now() + 60_000).toISOString();
  agent.questionDeadline('goal', 'room', question.id, deadline);
  expect(collaboration.call(task, 'collaboration_status', {}).questions).toEqual([{ ...question, expiresAt: deadline }]);
  store.transaction(state => { expireQuestions(state, 'dev', Date.parse(deadline)); });
  const restored = new AgentStore(directory), resumedClient = new FakeClient();
  const resumed = new SpecialistAgent({ store: restored, client: resumedClient, collaboration: new WorkerCollaboration(restored, 'dev'), profile: '', workspace: '/workspace' });
  resumed.pump(); expect(resumedClient.calls).toHaveLength(0);
  resumedClient.onStart = async () => {
    const base = { threadId: 'thread', turnId: 'turn', tool: 'record_decision' };
    await expectFailure(resumedClient.toolHandler!({ ...base, arguments: { action: 'complete', reason: 'Done', progress: 'Done', nextAction: '',
      criteria: [{ ...criteria[0]!, met: true, evidence: 'Reported done' }] } }), 'independent verification');
    await resumedClient.toolHandler!({ ...base, arguments: { action: 'blocked', reason: 'Independent verification is still required.', progress: 'User supplied the missing policy.', nextAction: '', criteria } });
    resumedClient.complete(); return { turn: { id: 'turn' } };
  };
  resumed.input('goal', 'followup', 'Use email; continue within the original scope.', 'room'); await resumed.settled();
  resumed.input('goal', 'followup', 'Use email; continue within the original scope.', 'room'); await resumed.settled();
  expect(resumedClient.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
  expect(resumedClient.calls.find(c => c.method === 'thread/resume')?.params.threadId).toBe('thread');
  expect(restored.task('goal')).toMatchObject({ status: 'interrupted', goal: { phase: 'blocked', turns: 3, criteria, verificationRequired: true } });
  expect(restored.snapshot().collaboration.outgoing.filter(m => m.closureReason === 'expired')).toHaveLength(1);
});

function unknownConsultation(directory = temporary(), existingReply = false) {
  const store = new AgentStore(directory), client = new FakeClient();
  const collaboration = new WorkerCollaboration(store, 'planner');
  if (!store.task('q_question')) {
    collaboration.exchange({ peers: [{ id: 'dev', name: 'Developer', role: 'development' }], rooms: { room: ['dev', 'planner'] },
      messages: [{ id: 'question', questionId: 'question', kind: 'question', from: 'dev', to: 'planner', taskId: 'goal', roomId: 'room', text: 'Which login?' }], acknowledged: [] });
    store.create('q_question', 'Which login?', { roomId: 'room', conversation: 'q_question', consultation: 'question' });
    store.update('q_question', { status: 'unknown', threadId: 'thread', turnId: 'turn', inputs: [], responses: [] });
    store.transaction(state => { state.collaboration.questionDeadlines = {}; });
    if (existingReply) collaboration.reply(store.task('q_question')!, 'Already sent');
  }
  const agent = new SpecialistAgent({ client, store, collaboration, workspace: '/workspace', profile: 'Planning' });
  return { store, client, agent, directory };
}

test.each(['completed', 'interrupted', 'failed'])('consultation recovery confirms native %s without sending a reply or replaying work', async status => {
  for (const existingReply of [false, true]) {
    const f = unknownConsultation(undefined, existingReply), before = f.store.snapshot().collaboration;
    f.client.onRead = async () => ({ thread: { id: 'thread', cwd: '/workspace', turns: [{ id: 'turn', status,
      items: [{ type: 'agentMessage', text: 'Recovered consultation' }] }] } });
    const result = await f.agent.recover('q_question', 'room');
    expect(result).toMatchObject({ status: 'interrupted', output: 'Recovered consultation', recovery: { status, threadId: 'thread', turnId: 'turn' } });
    expect(result.goal).toBeUndefined();
    expect(f.store.snapshot().collaboration).toEqual(before);
    expect(f.store.memory()).toBe('');
    expect(f.client.calls.map(c => c.method)).toEqual(['thread/read', 'thread/unsubscribe']);
    const restarted = unknownConsultation(f.directory);
    expect(await restarted.agent.recover('q_question', 'room')).toEqual(result);
    restarted.agent.pump(); await restarted.agent.settled();
    expect(restarted.client.calls).toHaveLength(0);
    expect(restarted.store.snapshot().collaboration).toEqual(before);
  }
});

test.each(['running', 'wrong-thread', 'wrong-workspace', 'missing-turn', 'later-turn', 'read-failure', 'unsubscribe-failure', 'wrong-room', 'missing-id'])('consultation recovery preserves unknown on %s', async reason => {
  const f = unknownConsultation();
  if (reason === 'missing-id') f.store.update('q_question', { turnId: null });
  const before = f.store.snapshot();
  f.client.onRead = async () => {
    if (reason === 'read-failure') throw new Error('read failed');
    return { thread: { id: reason === 'wrong-thread' ? 'other' : 'thread', cwd: reason === 'wrong-workspace' ? '/other' : '/workspace',
      turns: [{ id: reason === 'missing-turn' ? 'missing' : 'turn', status: reason === 'running' ? 'inProgress' : 'completed', items: [] },
        ...(reason === 'later-turn' ? [{ id: 'later', status: 'completed', items: [] }] : [])] } };
  };
  if (reason === 'unsubscribe-failure') f.client.onUnsubscribe = async () => { throw new Error('unsubscribe failed'); };
  await expectFailure(f.agent.recover('q_question', reason === 'wrong-room' ? 'foreign' : 'room'), '');
  expect(f.store.snapshot()).toEqual(before);
});

test('consultation inspection remains exclusive and leaves verification executions quarantined', async () => {
  const f = unknownConsultation(), gate = createDeferred<JsonRecord>();
  f.client.onRead = () => gate.promise;
  const operation = f.agent.recover('q_question', 'room');
  await expectFailure(f.agent.recover('q_question', 'room'), 'cannot safely inspect');
  expect(() => f.agent.submit('other', 'Work')).toThrow();
  f.store.update('q_question', { error: 'Changed during read' });
  gate.resolve({ thread: { id: 'thread', cwd: '/workspace', turns: [{ id: 'turn', status: 'interrupted', items: [] }] } });
  await expectFailure(operation, 'changed during inspection');
  f.store.create('verifier', 'Verify', { roomId: 'room', verification: 'request' });
  f.store.update('verifier', { status: 'unknown', threadId: 'thread', turnId: 'turn' });
  await expectFailure(f.agent.recover('verifier', 'room'), 'Unknown room');
  expect(f.store.task('verifier')?.status).toBe('unknown');
});
