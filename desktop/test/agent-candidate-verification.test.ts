import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateFixture } from '../../experiments/codex-specialists/src/candidate-verification-fixture.ts';
import { AgentStore } from '../../experiments/codex-specialists/src/store.ts';
import { SpecialistAgent } from '../../experiments/codex-specialists/src/agent.ts';
import { WorkerCollaboration } from '../../experiments/codex-specialists/src/collaboration.ts';
import { record } from '../../experiments/codex-specialists/src/protocol.ts';
import { SCRATCH_PROFILE } from '../../experiments/codex-specialists/src/task-scratch.ts';
import { AgentMailbox, bindingFor, type Message } from '../lib/agent-orchestration/mailbox.mts';
import { WorkAgentModel } from './fixtures/work-agent-model.ts';
import { inspectAgentTasks } from '../lib/agent-management/task-inspection.mts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'cheshi-candidate-runtime-')); roots.push(root); return { root, ...candidateFixture(root) }; }
function agent(f: ReturnType<typeof fixture>, client: WorkAgentModel, store: AgentStore, commands: boolean, owner = false) {
  const id = owner ? 'owner' : 'verifier', collaboration = new WorkerCollaboration(store, id, f.project);
  return new SpecialistAgent({ store, client, collaboration, workspace: f.project, profile: 'Verify candidate', timeoutMs: 3000,
    configuration: { workProtocol: 1, integrationProtocol: 1, candidateVerificationProtocol: 1, verificationProtocol: 1, decisionProtocol: 1,
      profileId: id, accountId: 'test', role: owner ? 'development' : 'verification', token: 'a'.repeat(64), instructions: 'Verify',
      model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: owner, commandExecution: commands } } });
}

test('host persists only candidates from accepted same-room proposals and results with matching identity', () => {
  const f = fixture(), { message, taskId } = f.requestVerification();
  let mailbox = new AgentMailbox(join(f.root, 'mailbox.json'));
  const bindings = Object.fromEntries(f.roster.map(p => [p.id, bindingFor(f.project, 'docker:test', p.id, 'account')]));
  for (const b of Object.values(bindings)) mailbox.register(b);
  const accept = (item: Message) => mailbox.accept(bindings[item.from]!, { protocol: 1, outgoing: [item], received: [] }, f.roster, [], m => m.roomId === 'room');
  const state = f.store.snapshot().collaboration;
  accept(state.outgoing.find(m => m.kind === 'work_request')!);
  accept(state.incoming.find(m => m.kind === 'work_result')!);
  accept(state.outgoing.find(m => m.kind === 'work_review')!);
  expect(() => accept({ ...message, to: 'author' })).toThrow('authors');
  const forged = JSON.parse(message.text); forged.candidate.files[0].content = 'forged';
  expect(() => accept({ ...message, text: JSON.stringify(forged) })).toThrow();
  expect(() => accept({ ...message, taskId: 'foreign' })).toThrow('room goal');
  accept(message); accept(message);
  mailbox = new AgentMailbox(join(f.root, 'mailbox.json'));
  expect(mailbox.request(bindings.verifier!, f.roster).messages).toEqual([message]);
  f.observe(taskId); f.draft(taskId); const result = f.deliver(taskId);
  const wrong = JSON.parse(result.text); wrong.candidate.hash = '0'.repeat(64);
  expect(() => accept({ ...result, text: JSON.stringify(wrong) })).toThrow('another candidate');
  accept(result); accept(result);
  expect(mailbox.messages(bindings.owner!.scope)).toHaveLength(5);
  const inspected = inspectAgentTasks({ tasks: [f.store.task('goal')!], collaboration: f.store.snapshot().collaboration });
  expect(inspected[0]?.inspection?.messages.find(m => m.kind === 'verification_request')?.request?.candidate).toEqual({ id: f.candidate.id, hash: f.candidate.hash });
});

test.each([false, true])('candidate runtime uses isolated cwd and command permission %s without source writes', async commands => {
  const f = fixture(), client = new WorkAgentModel();
  client.acknowledgeFirst = true;
  f.owner.call(f.store.task('goal')!, 'request_verification', f.args, f.candidate);
  const message = f.store.snapshot().collaboration.outgoing.at(-1)!;
  f.peer.exchange({ peers: f.roster, rooms: f.rooms, messages: [message], acknowledged: [] });
  const worker = agent(f, client, f.reviewer, commands);
  client.onTurn = async call => {
    const evidenceIds: string[] = [];
    for (const path of f.paths) evidenceIds.push(String(record((await call('verification_read', { path })).receipt).id));
    if (commands) {
      const item = { id: 'native', type: 'commandExecution', command: 'test candidate', status: 'completed', exitCode: 0, aggregatedOutput: 'pass' };
      client.emit('item/started', item); client.emit('item/completed', item); evidenceIds.push('native');
    }
    await call('submit_verification', { verdicts: [{ criterion: f.args.criteria[0], verdict: commands ? 'pass' : 'inconclusive', reason: 'Observed candidate', evidenceIds }] });
    return 'Verification reported';
  };
  try {
    worker.pump(); await worker.settled();
    const task = f.reviewer.snapshot().tasks[0]!;
    expect(task.status).toBe('completed');
    const start = client.calls.find(c => c.method === 'thread/start')!.params;
    expect(String(start.cwd)).toContain(`/verification-candidates/${message.id}`);
    const turn = client.calls.find(c => c.method === 'turn/start')!.params;
    expect(turn.cwd).toBe(start.cwd);
    if (commands) { expect(start.permissions).toBe(SCRATCH_PROFILE); expect(turn.permissions).toBe(SCRATCH_PROFILE); }
    else { expect(start.sandbox).toBe('read-only'); expect(turn.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false }); }
    expect(task.verificationDraft?.verdicts[0]?.verdict).toBe(commands ? 'pass' : 'inconclusive');
    for (const path of f.paths) expect(readFileSync(join(f.project, path), 'utf8')).toBe(`original ${path}`);
  } finally { worker.disposeScratch(); }
});

test.each([false, true])('unknown recovery with missing copy %s checks the exact candidate cwd and never starts a turn', async missing => {
  const f = fixture(), { taskId, cwd } = f.requestVerification(); f.observe(taskId); f.draft(taskId);
  f.reviewer.update(taskId, { status: 'unknown', threadId: 'saved-thread', turnId: 'saved-turn' });
  if (missing) rmSync(cwd, { recursive: true });
  const client = new WorkAgentModel();
  client.history.directories.set('saved-thread', cwd);
  client.history.turns.set('saved-thread', { id: 'saved-turn', status: 'completed', items: [] });
  const store = new AgentStore(f.reviewer.directory), worker = agent(f, client, store, true);
  await worker.recover(taskId, 'room');
  expect(store.task(taskId)?.status).toBe('interrupted');
  expect(client.calls.map(c => c.method)).toEqual(['thread/read', 'thread/unsubscribe']);
  const result = JSON.parse(store.snapshot().collaboration.outgoing.at(-1)!.text);
  expect(result.verdicts[0].verdict).toBe(missing ? 'inconclusive' : 'pass');
  expect(result.candidate).toEqual({ id: f.candidate.id, hash: f.candidate.hash });
});

test('resumed owner routes request_verification to its candidate without adding dynamic tools', async () => {
  const f = fixture(), client = new WorkAgentModel();
  f.store.saveThread('saved-thread', null, 'goal', true);
  f.store.update('goal', { status: 'interrupted', integrationTools: true, goal: { ...f.store.task('goal')!.goal!, phase: 'blocked' } });
  const worker = agent(f, client, f.store, false, true);
  client.onTurn = async call => {
    await call('request_verification', f.args);
    await call('record_decision', { action: 'wait', reason: 'Independent verification pending', progress: 'Prepared candidate', nextAction: 'Inspect verdict', criteria: [{ criterion: f.args.criteria[0], met: false, evidence: '' }] });
    return 'Waiting';
  };
  worker.input('goal', 'continue', 'Verify the prepared candidate', 'room'); await worker.settled();
  expect(f.store.task('goal')?.status).toBe('waiting');
  const request = JSON.parse(f.store.snapshot().collaboration.outgoing.at(-1)!.text);
  expect(request.candidate).toEqual(f.candidate);
  expect(client.calls.find(c => c.method === 'thread/resume')?.params.dynamicTools).toBeUndefined();
});
