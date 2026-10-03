import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMailbox, bindingFor, type Peer, type Message } from '../lib/agent-orchestration/mailbox.mts';
import { createAgentOrchestration } from '../lib/agent-orchestration/service.mts';
import { AgentStore } from '../../experiments/codex-specialists/src/store.ts';
import { WorkerCollaboration } from '../../experiments/codex-specialists/src/collaboration.ts';
import { SpecialistAgent } from '../../experiments/codex-specialists/src/agent.ts';
import type { RpcClient } from '../../experiments/codex-specialists/src/app-server-client.ts';
import type { JsonRecord, Notification } from '../../experiments/codex-specialists/src/protocol.ts';

const directories: string[] = [];
function temporary() { const directory = mkdtempSync(join(tmpdir(), 'cheshi-orchestration-')); directories.push(directory); return directory; }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

class ModelFixture implements RpcClient {
  calls: { method: string; params: JsonRecord }[] = [];
  private listeners = new Set<(event: Notification) => void>();
  private handler: ((params: JsonRecord) => Promise<JsonRecord>) | undefined;
  private sequence = 0;
  onTurn: (input: string, call: (tool: string, args: JsonRecord) => Promise<JsonRecord>) => Promise<string> = async () => 'Use email and password.';
  handleTools(handler: (params: JsonRecord) => Promise<JsonRecord>) { this.handler = handler; }
  subscribe(listener: (event: Notification) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onFailure() { return () => {}; }
  async request(method: string, params: JsonRecord): Promise<JsonRecord> {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'thread/start') return { thread: { id: `thread-${++this.sequence}` } };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'thread/inject_items') return {};
    if (method === 'turn/start') {
      const turnId = `turn-${++this.sequence}`;
      const text = await this.onTurn(JSON.stringify(params.input), (tool, args) => this.handler!({ threadId: params.threadId, turnId, tool, arguments: args }));
      for (const listener of this.listeners) listener({ method: 'turn/completed', params: { threadId: params.threadId,
        turn: { id: turnId, status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text }], error: null } } });
      return { turn: { id: turnId } };
    }
    throw new Error(`Unexpected method ${method}`);
  }
}
const roster: Peer[] = [{ id: 'dev', name: 'Developer', role: 'development' }, { id: 'planner', name: 'Planner', role: 'planning' }];

test.each([undefined, 'expired'] as const)('mailbox persists closure reason %s and late answers without accepting a forged closure', closureReason => {
  const filename = join(temporary(), 'closed.json'), box = new AgentMailbox(filename);
  const dev = bindingFor('/workspace', 'docker:test', 'dev', 'default'), peer = bindingFor('/workspace', 'docker:test', 'planner', 'default');
  box.register(dev); box.register(peer);
  const q: Message = { id: 'question', questionId: 'question', kind: 'question', from: 'dev', to: 'planner', taskId: 'goal', text: 'Credentials?' };
  const closed: Message = { ...q, id: 'closed', kind: 'question_closed', text: 'Closed', ...(closureReason ? { closureReason } : {}) };
  const accept = (b: typeof dev, messages: Message[]) => box.accept(b, { protocol: 1, received: [], outgoing: messages }, roster, []);
  accept(dev, [q]);
  expect(() => accept(peer, [{ ...closed, from: 'planner', to: 'dev' }])).toThrow('closure');
  accept(dev, [closed]); accept(dev, [closed]);
  accept(peer, [{ ...q, id: 'answer', kind: 'reply', from: 'planner', to: 'dev', text: 'Too late' }]);
  const restored = new AgentMailbox(filename);
  expect(restored.messages(dev.scope)).toHaveLength(3);
  expect(restored.messages(dev.scope)[1]?.closureReason).toBe(closureReason);
  expect(restored.request(peer, roster).messages.map(m => m.kind)).toEqual(['question', 'question_closed']);
  expect(restored.request(dev, roster).messages[0]?.text).toBe('Too late');
});
function worker(directory: string, id: string) {
  const store = new AgentStore(directory), client = new ModelFixture(), collaboration = new WorkerCollaboration(store, id);
  const agent = new SpecialistAgent({ client, store, workspace: '/workspace', profile: 'Follow the assigned goal.', collaboration,
    configuration: { profileId: id, accountId: 'default', role: 'development', token: 'a'.repeat(64), instructions: 'Follow the assigned goal.',
      model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: true, commandExecution: true } } });
  return { store, client, collaboration, agent };
}

test('two agents consult, continue independent work, and resume the same task after worker and coordinator restart', async () => {
  const directory = temporary(), devPath = join(directory, 'dev');
  let developer = worker(devPath, 'dev');
  const planner = worker(join(directory, 'planner'), 'planner');
  const bindings = roster.map(p => bindingFor('/workspace', 'docker:test', p.id, 'default'));
  let losePlannerReceipt = true;
  const relay = () => createAgentOrchestration({ filename: join(directory, 'central.json'),
    peer: b => roster.find(p => p.id === b.agentId) ?? null,
    connect: async b => ({ endpoint: b.agentId, token: 'fixture' }),
    exchange: async (connection, input) => {
      const target = connection.endpoint === 'dev' ? developer : planner;
      const result = target.collaboration.exchange(input);
      if (connection.endpoint === 'planner' && result.received.length && losePlannerReceipt) {
        losePlannerReceipt = false; throw new Error('Acknowledgement lost after durable receipt.');
      }
      return result;
    },
  });
  let coordinator = relay();
  bindings.forEach(b => coordinator.register(b));
  await coordinator.tick();
  let independentWork = false;
  developer.client.onTurn = async (_input, call) => {
    const peers = await call('list_agents', {});
    expect(peers.agents).toEqual([roster[1]!]);
    const first = await call('ask_agent', { agentId: 'planner', requestId: 'login-policy', question: 'Which login credentials?' });
    const retry = await call('ask_agent', { agentId: 'planner', requestId: 'login-policy', question: 'Which login credentials?' });
    expect(retry.questionId).toBe(first.questionId);
    independentWork = true; // The tool returned before the peer was executed.
    return 'Input validation is ready; waiting for credential policy.';
  };
  developer.agent.submit('login', 'Complete login.'); await developer.agent.settled();
  expect(independentWork).toBe(true);
  expect(developer.store.task('login')?.status).toBe('waiting');
  const originalThread = developer.store.task('login')!.threadId;
  await coordinator.tick(); // planner persisted the question, acknowledgement was lost
  await coordinator.tick(); // redelivery must not create a second consultation
  planner.agent.pump(); await planner.agent.settled();
  expect(planner.store.snapshot().tasks).toHaveLength(1);
  const consultation = planner.client.calls.find(c => c.method === 'thread/start')!.params;
  expect(consultation.sandbox).toBe('read-only');
  expect(consultation.config).toMatchObject({ 'features.shell_tool': false, 'features.unified_exec': false });
  expect(planner.client.calls.find(c => c.method === 'turn/start')!.params.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
  await coordinator.dispose();
  developer = worker(devPath, 'dev'); coordinator = relay();
  developer.client.onTurn = async input => {
    expect(input).toContain('Use email and password.');
    expect(input).toContain('Input validation is ready');
    return 'Login is implemented and checked.';
  };
  expect(developer.store.task('login')?.status).toBe('waiting');
  await coordinator.tick(); await coordinator.tick();
  developer.agent.pump(); await developer.agent.settled();
  expect(developer.store.task('login')?.status).toBe('completed');
  expect(developer.store.task('login')?.threadId).toBe(originalThread);
  expect(developer.client.calls.some(c => c.method === 'thread/start')).toBe(false);
  expect(developer.client.calls.find(c => c.method === 'thread/resume')!.params.threadId).toBe(originalThread);
  await coordinator.tick(); developer.agent.pump();
  expect(developer.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
  await coordinator.dispose();
});

test('central journal rejects impersonation, foreign recipients, conflicting retries and unsolicited replies atomically', () => {
  const mailbox = new AgentMailbox(join(temporary(), 'journal.json'));
  const binding = bindingFor('/workspace', 'docker:test', 'dev', 'default'); mailbox.register(binding);
  const question = { id: 'q1', kind: 'question', from: 'dev', to: 'planner', taskId: 'login', questionId: 'q1', text: 'Which credentials?' };
  const accept = (messages: unknown[]) => mailbox.accept(binding, { protocol: 1, received: [], outgoing: messages }, roster, []);
  expect(() => accept([{ ...question, from: 'other' }])).toThrow('sender');
  expect(() => accept([{ ...question, to: 'foreign-project' }])).toThrow('Recipient');
  expect(() => accept([{ ...question, kind: 'reply' }])).toThrow('Reply');
  accept([question]); accept([question]);
  expect(() => accept([{ ...question, text: 'changed' }])).toThrow('conflict');
  const planner = bindingFor('/workspace', 'docker:test', 'planner', 'default');
  expect(mailbox.request(planner, roster).messages).toHaveLength(1);
  const foreign = bindingFor('/other-project', 'docker:test', 'planner', 'default');
  expect(mailbox.request(foreign, roster).messages).toHaveLength(0);
  expect(() => mailbox.register({ ...binding, accountId: 'different' })).toThrow('another account');
});

test('canceled waiting tasks retain late replies without restarting model work', async () => {
  const dev = worker(temporary(), 'dev');
  dev.collaboration.exchange({ peers: roster, messages: [], acknowledged: [] });
  dev.client.onTurn = async (_input, call) => { await call('ask_agent', { agentId: 'planner', requestId: 'q', question: 'Policy?' }); return 'Waiting'; };
  dev.agent.submit('login', 'Implement login'); await dev.agent.settled(); await dev.agent.stop('login');
  const q = dev.store.snapshot().collaboration.outgoing[0]!;
  dev.collaboration.exchange({ peers: roster, messages: [{ id: 'reply', kind: 'reply', from: 'planner', to: 'dev', taskId: 'login', questionId: q.id, text: 'Answer' }], acknowledged: [] });
  dev.agent.pump();
  expect(dev.store.task('login')?.status).toBe('interrupted');
  expect(dev.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
});

test('an unreadable journal surfaces an error without crashing startup or replacing saved evidence', async () => {
  const filename = join(temporary(), 'journal.json');
  writeFileSync(filename, 'damaged journal');
  const coordinator = createAgentOrchestration({ filename, peer: () => null, connect: async () => null });
  await coordinator.tick();
  expect(coordinator.error('binding')).not.toBeNull();
  expect(readFileSync(filename, 'utf8')).toBe('damaged journal');
  await coordinator.dispose();
});

test('verification messages bind the reviewer role, task, request and project across journal restart', () => {
  const filename = join(temporary(), 'verification.json');
  let mailbox = new AgentMailbox(filename);
  const peers = [...roster, { id: 'reviewer', name: 'Verifier', role: 'verification' }];
  const owner = bindingFor('/workspace', 'docker:test', 'dev', 'default');
  const reviewer = bindingFor('/workspace', 'docker:test', 'reviewer', 'default');
  const request: Message = { id: 'v1', kind: 'verification_request', from: 'dev', to: 'reviewer', taskId: 'login', questionId: 'v1', text: '{"criteria":["Login"]}' };
  const accept = (binding: typeof owner, messages: unknown[]) => mailbox.accept(binding, { protocol: 1, received: [], outgoing: messages }, peers, []);
  expect(() => accept(owner, [{ ...request, to: 'planner' }])).toThrow('verification agent');
  accept(owner, [request]); mailbox = new AgentMailbox(filename);
  expect(mailbox.request(reviewer, peers).messages).toEqual([request]);
  const result: Message = { id: 'r1', kind: 'verification_result', from: 'reviewer', to: 'dev', taskId: 'login', questionId: 'v1', text: '{"verdicts":[]}' };
  expect(() => accept(reviewer, [{ ...result, taskId: 'foreign' }])).toThrow('peer and task');
  expect(() => accept(bindingFor('/elsewhere', 'docker:test', 'reviewer', 'default'), [result])).toThrow('peer and task');
  expect(() => accept(bindingFor('/workspace', 'docker:test', 'planner', 'default'), [{ ...result, from: 'planner' }])).toThrow('verification agent');
  accept(reviewer, [result]); accept(reviewer, [result]);
  expect(() => accept(reviewer, [{ ...result, id: 'r2' }])).toThrow('already has');
  expect(mailbox.request(owner, peers).messages).toEqual([result]);
});
