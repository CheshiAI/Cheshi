import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMailbox, bindingFor, type Message, type Peer } from '../lib/agent-orchestration/mailbox.mts';
import { createAgentOrchestration } from '../lib/agent-orchestration/service.mts';
import { AgentStore } from '../../experiments/codex-specialists/src/store.ts';
import { WorkerCollaboration } from '../../experiments/codex-specialists/src/collaboration.ts';
import { SpecialistAgent } from '../../experiments/codex-specialists/src/agent.ts';
import { SCRATCH_PROFILE } from '../../experiments/codex-specialists/src/task-scratch.ts';
import { captureWork, workDigest } from '../../experiments/codex-specialists/src/work-files.ts';
import { parseWorkResult } from '../shared/agent-work.ts';
import { inspectAgentTasks } from '../lib/agent-management/task-inspection.mts';
import { WorkAgentModel as Model } from './fixtures/work-agent-model.ts';
import { record, type JsonRecord } from '../../experiments/codex-specialists/src/protocol.ts';

const directories: string[] = [];
function temporary() { const path = mkdtempSync(join(tmpdir(), 'cheshi-work-integration-')); directories.push(path); return path; }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
async function fails(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toContain(message);
}

const roster: Peer[] = ['owner', 'peer'].map(id => ({ id, name: id, role: 'development', fileWrite: true, workProtocol: 1 }));
const requestArgs = { agentId: 'peer', requestId: 'implementation', objective: 'Implement greeting', criteria: ['Greeting returns hello'],
  paths: ['greet.ts', 'context.txt'], writePaths: ['greet.ts', 'new.ts'], previousRequestId: null };
function setup() {
  const directory = temporary(), project = join(directory, 'project'); mkdirSync(project);
  writeFileSync(join(project, 'greet.ts'), 'old'); writeFileSync(join(project, 'context.txt'), 'reference');
  const worker = (id: string, client = new Model(), fileWrite = true, integration = true) => {
    const store = new AgentStore(join(directory, id)), collaboration = new WorkerCollaboration(store, id, project);
    const agent = new SpecialistAgent({ store, client, collaboration, workspace: project, profile: 'Implement only approved work.', timeoutMs: 3000,
      configuration: { ...(integration ? { integrationProtocol: 1 as const } : {}), workProtocol: 1, decisionProtocol: 1, profileId: id, accountId: 'fixture', role: 'development', token: 'a'.repeat(64),
        instructions: 'Implement only approved work.', model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite, commandExecution: false } } });
    return { store, client, collaboration, agent };
  };
  let owner = worker('owner'), peer = worker('peer');
  const bindings = roster.map(p => bindingFor(project, 'docker:test', p.id, 'fixture'));
  let drop = false;
  const relay = () => createAgentOrchestration({ filename: join(directory, 'journal.json'), peer: b => roster.find(p => p.id === b.agentId) ?? null,
    connect: async b => ({ endpoint: b.agentId, token: 'fixture' }), rooms: { roster: () => ({ room: ['owner', 'peer'] }), allowed: (_b, m) => m.roomId === 'room', record: () => {} },
    exchange: async (connection, body) => {
      const target = connection.endpoint === 'owner' ? owner : peer, result = target.collaboration.exchange(body);
      if (drop && connection.endpoint === 'peer' && result.received.length) { drop = false; throw new Error('Acknowledgement lost'); }
      return result;
    } });
  let coordinator = relay(); bindings.forEach(b => coordinator.register(b));
  return { directory, project, worker, bindings, get owner() { return owner; }, get peer() { return peer; }, get coordinator() { return coordinator; },
    dropReceipt() { drop = true; },
    async restart() { await coordinator.dispose(); owner = worker('owner', owner.client); peer.agent.disposeScratch(); peer = worker('peer', peer.client); coordinator = relay(); },
  };
}
const decide = (action: string) => ({ action, reason: 'Waiting for proposal or integration', progress: 'Proposal workflow', nextAction: 'Review submitted files',
  criteria: [{ criterion: 'Greeting integrated and verified', met: false, evidence: '' }] });

test('upgraded native conversations preserve their tools and history while new goals acquire integration tools', async () => {
  const f = setup(), old = f.worker('legacy', new Model(), true, false);
  old.client.onTurn = async call => { await call('record_decision', decide('blocked')); return 'Awaiting input'; };
  try {
    old.agent.submit('legacy-goal', 'Existing goal', { roomId: 'room', conversation: 'legacy-goal', goal: true });
    await old.agent.settled();
    const thread = old.store.snapshot().threads['legacy-goal'];
    const upgraded = f.worker('legacy', old.client);
    upgraded.agent.input('legacy-goal', 'continue', 'Continue existing work', 'room'); await upgraded.agent.settled();
    const resume = old.client.calls.find(c => c.method === 'thread/resume')!.params;
    expect(resume.threadId).toBe(thread); expect(resume.dynamicTools).toBeUndefined();
    expect(String(resume.developerInstructions)).not.toContain('use prepare_integration');
    expect(upgraded.store.task('legacy-goal')?.integrationTools).toBeUndefined();
    upgraded.agent.submit('new-goal', 'New goal', { roomId: 'room', conversation: 'new-goal', goal: true }); await upgraded.agent.settled();
    const start = old.client.calls.filter(c => c.method === 'thread/start').at(-1)!.params;
    expect((start.dynamicTools as JsonRecord[]).map(t => t.name)).toContain('prepare_integration');
    expect(String(start.developerInstructions)).toContain('use prepare_integration');
    expect(upgraded.store.task('new-goal')?.integrationTools).toBe(true);
    upgraded.agent.disposeScratch();
  } finally { await f.coordinator.dispose(); old.agent.disposeScratch(); f.owner.agent.disposeScratch(); f.peer.agent.disposeScratch(); }
});

test('real host and worker stores deliver isolated work once, survive lost receipts and restart, then resume the owner for review', async () => {
  const f = setup();
  try {
    await f.coordinator.tick();
    let requestId = '', ownerTurns = 0;
    f.owner.client.onTurn = async call => {
      if (++ownerTurns === 1) {
        const request = await call('request_work', requestArgs); requestId = String(request.requestId);
        expect((await call('request_work', requestArgs)).requestId).toBe(requestId);
        await call('record_decision', decide('wait')); return 'Waiting for implementation';
      }
      const status = await call('work_status', {});
      expect(record((status.results as unknown[])[0]).status).toBe('submitted');
      await call('review_work', { requestId, decision: 'accepted', feedback: 'Proposal reviewed. Integration still required.' });
      const candidate = await call('prepare_integration', { requestId: 'combine', requestIds: [requestId] });
      expect(record(candidate.integration).status).toBe('prepared');
      expect(candidate.appliedToProject).toBe(false);
      await fails(call('record_decision', { ...decide('complete'), criteria: [{ criterion: 'Greeting integrated and verified', met: true, evidence: 'Candidate prepared' }] }), 'not applied');
      await call('record_decision', decide('blocked')); return 'Proposal accepted, not integrated';
    };
    f.owner.agent.submit('goal', 'Implement greeting', { roomId: 'room', conversation: 'goal', goal: true }); await f.owner.agent.settled();
    f.dropReceipt(); await f.coordinator.tick(); await f.restart(); await f.coordinator.tick();
    f.peer.client.onTurn = async call => {
      expect((await call('work_read', { path: 'greet.ts' })).content).toBe('old');
      await fails(call('work_write', { path: 'context.txt', content: 'wrong' }), 'scope');
      await fails(call('ask_agent', { agentId: 'owner', requestId: 'nested', question: 'Delegate again' }), 'cannot delegate');
      await call('work_write', { path: 'greet.ts', content: 'export const greeting = "hello";' });
      await call('work_write', { path: 'new.ts', content: 'export const created = true;' });
      await call('submit_work', { summary: 'Greeting proposal' }); return 'Submitted';
    };
    f.peer.agent.pump(); await f.peer.agent.settled();
    const task = f.peer.store.snapshot().tasks[0]!;
    expect(task.status).toBe('completed'); expect(task.workDraft?.summary).toBe('Greeting proposal');
    const start = f.peer.client.calls.find(c => c.method === 'thread/start')!.params;
    expect(start.cwd).not.toBe(f.project); expect(start.permissions).toBe(SCRATCH_PROFILE);
    expect(record(start.config)['features.shell_tool']).toBe(false);
    expect(record(record(record(start.config)[`permissions.${SCRATCH_PROFILE}`]).filesystem)[String(start.cwd)]).toBe('read');
    await f.coordinator.tick(); await f.coordinator.tick();
    f.owner.agent.pump(); await f.owner.agent.settled();
    expect(ownerTurns).toBe(2); expect(f.owner.store.task('goal')?.goal?.phase).toBe('blocked');
    expect(readFileSync(join(f.project, 'greet.ts'), 'utf8')).toBe('old');
    const detail = inspectAgentTasks(f.peer.store.snapshot())[0]!.inspection!;
    expect(detail.error).toBeNull(); expect(detail.work?.draft?.digest).toMatch(/^[a-f0-9]{64}$/);
    for (let i = 0; i < 3; i++) { await f.coordinator.tick(); f.peer.agent.pump(); await f.peer.agent.settled(); }
    expect(f.peer.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
    expect(f.owner.store.snapshot().collaboration.outgoing.filter(m => m.kind === 'work_review')).toHaveLength(1);
    const integration = inspectAgentTasks(f.owner.agent.activity())[0]!.inspection!.integration!;
    expect(integration.status).toBe('prepared');
    expect(integration.files.map(file => file.path)).toEqual(['greet.ts', 'new.ts']);
    expect(f.owner.store.task('goal')?.integrationTools).toBe(true);
    await f.restart();
    expect(inspectAgentTasks(f.owner.agent.activity())[0]!.inspection!.integration?.id).toBe(integration.id);
    writeFileSync(join(f.project, 'context.txt'), 'changed by user');
    expect(inspectAgentTasks(f.owner.agent.activity())[0]!.inspection!.integration).toMatchObject({ status: 'stale', issues: [{ kind: 'source_changed', path: 'context.txt' }] });
  } finally { await f.coordinator.dispose(); f.owner.agent.disposeScratch(); f.peer.agent.disposeScratch(); }
});

test('unknown delegated execution is not replayed; exact native inspection recovers collected changes after restart', async () => {
  const f = setup();
  try {
    await f.coordinator.tick();
    f.owner.client.onTurn = async call => { await call('request_work', requestArgs); await call('record_decision', decide('wait')); return 'Waiting'; };
    f.owner.agent.submit('goal', 'Implement greeting', { roomId: 'room', conversation: 'goal', goal: true }); await f.owner.agent.settled(); await f.coordinator.tick();
    f.peer.client.deliver = false;
    f.peer.client.onTurn = async call => { await call('work_write', { path: 'greet.ts', content: 'hello' }); await call('submit_work', { summary: 'Ready' }); return 'Submitted'; };
    f.peer.agent.pump(); await new Promise<void>(resolve => setImmediate(resolve));
    f.peer.client.disconnect(); await f.peer.agent.settled();
    const task = f.peer.store.snapshot().tasks[0]!;
    expect(task.status).toBe('unknown');
    expect(inspectAgentTasks(f.peer.store.snapshot())[0]!.inspection).toMatchObject({ recoveryKind: 'delegation', recoveryRoomId: 'room' });
    await fails(f.peer.agent.recover(task.id, 'room'), 'Restart');
    await f.restart();
    const calls = f.peer.client.calls.filter(c => c.method === 'turn/start').length;
    f.peer.agent.pump(); await f.peer.agent.settled();
    const recovered = await f.peer.agent.recover(task.id, 'room');
    expect(recovered.status).toBe('interrupted'); expect(recovered.recovery?.status).toBe('completed');
    expect(f.peer.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(calls);
    expect(await f.peer.agent.recover(task.id, 'room')).toEqual(recovered);
    const result = f.peer.store.snapshot().collaboration.outgoing.find(m => m.kind === 'work_result')!;
    expect(parseWorkResult(JSON.parse(result.text)).changes[0]?.sha256).toBe(workDigest('hello'));
    expect(readFileSync(join(f.project, 'greet.ts'), 'utf8')).toBe('old');
  } finally { await f.coordinator.dispose(); f.owner.agent.disposeScratch(); f.peer.agent.disposeScratch(); }
});

test('host rejects forged work permissions, paths, hashes, result senders and acceptance of failed work atomically', () => {
  const root = temporary(), project = join(root, 'project'); mkdirSync(project); writeFileSync(join(project, 'file'), 'old');
  const box = new AgentMailbox(join(root, 'journal.json')), owner = bindingFor(project, 'docker:test', 'owner', 'fixture'), peer = bindingFor(project, 'docker:test', 'peer', 'fixture');
  box.register(owner); box.register(peer);
  const request = captureWork(project, { objective: 'Change file', criteria: ['Changed'], paths: ['file'], writePaths: ['file'], previousRequestId: null });
  const msg: Message = { id: 'a'.repeat(64), questionId: 'a'.repeat(64), kind: 'work_request', from: 'owner', to: 'peer', roomId: 'room', taskId: 'goal', text: JSON.stringify(request) };
  const accept = (binding: typeof owner, outgoing: Message[], peers = roster) => box.accept(binding, { protocol: 1, received: [], outgoing }, peers, [], m => m.roomId === 'room');
  expect(() => accept(owner, [msg], roster.map(p => ({ ...p, fileWrite: false })))).toThrow('writable');
  expect(() => accept(owner, [{ ...msg, text: JSON.stringify({ ...request, snapshot: '0'.repeat(64) }) }])).toThrow('changed');
  expect(box.messages(owner.scope)).toHaveLength(0);
  accept(owner, [msg]); accept(owner, [msg]);
  const result = { version: 1, snapshot: request.snapshot, status: 'submitted', summary: 'Done', changes: [{ path: 'outside', before: null, content: 'new', sha256: workDigest('new') }] };
  const reply: Message = { ...msg, id: 'result', kind: 'work_result', from: 'peer', to: 'owner', text: JSON.stringify(result) };
  expect(() => accept(peer, [reply])).toThrow('authorized');
  const failed = { ...reply, text: JSON.stringify({ ...result, status: 'failed', changes: [] }) };
  accept(peer, [failed]);
  expect(() => accept(owner, [{ ...msg, id: 'review', kind: 'work_review', text: JSON.stringify({ version: 1, decision: 'accepted', feedback: 'Great' }) }])).toThrow('unsuccessful');
  expect(new AgentMailbox(join(root, 'journal.json')).messages(owner.scope)).toHaveLength(2);
});
