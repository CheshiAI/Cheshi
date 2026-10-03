import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecialistAgent } from './agent.ts';
import type { RpcClient } from './app-server-client.ts';
import { WorkerCollaboration } from './collaboration.ts';
import { newGoal } from './decision.ts';
import { createDeferred, type JsonRecord, type Notification } from './protocol.ts';
import { AgentStore } from './store.ts';
import { WorkerVerification } from './verification.ts';

const directories: string[] = [];
const peers = [{ id: 'dev', name: 'Developer', role: 'development' }, { id: 'reviewer', name: 'Reviewer', role: 'verification' }];
const rooms = { room: ['dev', 'reviewer'] };
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function fails(operation: Promise<unknown>, text: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(text);
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cheshi-verification-recovery-')); directories.push(root);
  writeFileSync(join(root, 'login.ts'), 'export const valid = true;');
  const ownerStore = new AgentStore(join(root, 'dev')), store = new AgentStore(join(root, 'reviewer'));
  const owner = new WorkerCollaboration(ownerStore, 'dev', root), peer = new WorkerCollaboration(store, 'reviewer', root);
  owner.exchange({ peers, rooms, messages: [], acknowledged: [] });
  ownerStore.create('goal', 'Verify login', { roomId: 'room', goal: newGoal(true) });
  const args = { agentId: 'reviewer', requestId: 'first', criteria: ['Login works'], paths: ['login.ts'] };
  owner.call(ownerStore.task('goal')!, 'request_verification', args);
  const request = ownerStore.snapshot().collaboration.outgoing[0]!;
  peer.exchange({ peers, rooms, messages: [request], acknowledged: [] });
  const next = peer.next()!;
  store.create(next.taskId, next.prompt, { verification: request.id, roomId: 'room', conversation: next.taskId });
  store.update(next.taskId, { status: 'unknown', threadId: 'thread', turnId: 'turn' });
  ownerStore.complete('goal', { status: 'waiting', output: 'Waiting for verification', error: null,
    goal: { ...ownerStore.task('goal')!.goal!, phase: 'waiting', turns: 2 } });
  const verifier = new WorkerVerification(store, root);
  const draft = (verdict: 'pass' | 'fail' = 'pass') => {
    verifier.call(store.task(next.taskId)!, 'verification_read', { path: 'login.ts' });
    const item = { id: 'command', type: 'commandExecution', command: 'bun test login', status: 'completed', exitCode: 0, aggregatedOutput: '1 pass' };
    verifier.observe(store.task(next.taskId)!, 'item/started', item);
    verifier.observe(store.task(next.taskId)!, 'item/completed', item);
    verifier.call(store.task(next.taskId)!, 'submit_verification', { verdicts: [{ criterion: 'Login works', verdict,
      reason: 'Observed file and check', evidenceIds: store.task(next.taskId)!.verificationEvidence!.map(e => e.id) }] });
  };
  const runtime = (saved = store, status = 'completed') => {
    const calls: string[] = [];
    const read = { thread: { id: 'thread', cwd: root, turns: [{ id: 'turn', status, items: [{ type: 'agentMessage', text: 'Native output' }] }] } };
    const transport = { read: async (): Promise<JsonRecord> => read, unsubscribe: async (): Promise<JsonRecord> => ({}) };
    const client: RpcClient = {
      request: async method => {
        calls.push(method);
        if (method === 'thread/read') return transport.read();
        if (method === 'thread/unsubscribe') return transport.unsubscribe();
        throw new Error(`Unexpected model request: ${method}`);
      },
      handleTools: () => {}, subscribe: () => () => {}, onFailure: () => () => {},
    };
    const collaboration = new WorkerCollaboration(saved, 'reviewer', root);
    const agent = new SpecialistAgent({ client, store: saved, collaboration, workspace: root, profile: 'Verification', configuration: {
      decisionProtocol: 1, verificationProtocol: 1, profileId: 'reviewer', accountId: 'fixture', role: 'verification', token: 'a'.repeat(64),
      instructions: 'Verify', model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: false, commandExecution: true },
    } });
    return { agent, calls, read, transport, collaboration };
  };
  return { root, store, ownerStore, owner, peer, verifier, draft, runtime, taskId: next.taskId, request, args };
}

test.each(['pass', 'fail'] as const)('restores a confirmed %s after restart without replay and lets the owner resume judgment', async verdict => {
  const f = setup(); f.draft(verdict);
  const restored = new AgentStore(join(f.root, 'reviewer')), r = f.runtime(restored);
  const recovered = await r.agent.recover(f.taskId, 'room');
  expect(recovered).toMatchObject({ status: 'interrupted', output: 'Native output', recovery: { status: 'completed', turnId: 'turn' } });
  const result = restored.snapshot().collaboration.outgoing[0]!;
  expect(JSON.parse(result.text).verdicts[0].verdict).toBe(verdict);
  expect(restored.snapshot().collaboration.consumed).toContain(f.request.id);
  expect(await r.agent.recover(f.taskId, 'room')).toEqual(recovered);
  expect(r.calls).toEqual(['thread/read', 'thread/unsubscribe']);
  const again = new AgentStore(join(f.root, 'reviewer')), second = f.runtime(again);
  expect(await second.agent.recover(f.taskId, 'room')).toEqual(recovered);
  second.agent.pump(); expect(second.calls).toHaveLength(0);
  expect(again.snapshot().collaboration.outgoing).toEqual([result]);
  f.owner.exchange({ peers, rooms, messages: [result, result], acknowledged: [] });
  const next = f.owner.next()!;
  expect(next).toMatchObject({ taskId: 'goal', resume: true, messages: [result.id] });
  expect(f.ownerStore.task('goal')?.goal).toMatchObject({ phase: 'waiting', turns: 2 });
  expect(() => f.owner.assertVerified(f.ownerStore.task('goal')!)).toThrow('processed');
  if (verdict === 'pass') f.owner.assertVerified(f.ownerStore.task('goal')!, next.messages);
  else expect(() => f.owner.assertVerified(f.ownerStore.task('goal')!, next.messages)).toThrow('did not pass');
});

test.each(['interrupted', 'failed', 'no-draft', 'changed-file', 'missing-receipt', 'changed-receipt', 'invalid-draft'])('%s cannot become a pass and frees the pending round for re-verification', async reason => {
  const f = setup();
  if (reason !== 'no-draft') f.draft();
  if (reason === 'changed-file') writeFileSync(join(f.root, 'login.ts'), 'changed');
  if (reason === 'missing-receipt') f.store.update(f.taskId, { verificationEvidence: undefined });
  if (reason === 'changed-receipt') f.store.update(f.taskId, { verificationEvidence: f.store.task(f.taskId)!.verificationEvidence!.map(e => ({ ...e, output: 'changed' })) });
  if (reason === 'invalid-draft') {
    const draft = f.store.task(f.taskId)!.verificationDraft!;
    f.store.update(f.taskId, { verificationDraft: { ...draft, verdicts: draft.verdicts.map(v => ({ ...v, evidenceIds: ['invented'] })) } });
  }
  const r = f.runtime(f.store, ['interrupted', 'failed'].includes(reason) ? reason : 'completed');
  await r.agent.recover(f.taskId, 'room');
  const result = f.store.snapshot().collaboration.outgoing[0]!;
  expect(JSON.parse(result.text)).toMatchObject({ verdicts: [{ verdict: 'inconclusive', evidenceIds: [] }], evidence: [] });
  f.owner.exchange({ peers, rooms, messages: [result], acknowledged: [] });
  expect(f.owner.next()?.resume).toBe(true);
  expect(() => f.owner.assertVerified(f.ownerStore.task('goal')!, [result.id])).toThrow('did not pass');
  f.owner.call(f.ownerStore.task('goal')!, 'request_verification', { ...f.args, requestId: 'retry' });
  expect(f.ownerStore.snapshot().collaboration.outgoing).toHaveLength(2);
  expect(r.calls).toEqual(['thread/read', 'thread/unsubscribe']);
});

test('already published results survive recovery unchanged and stale evidence still prevents owner completion', async () => {
  const f = setup(); f.draft();
  f.peer.publishVerification(f.store.task(f.taskId)!, f.verifier.finish(f.store.task(f.taskId)!));
  const published = f.store.snapshot().collaboration.outgoing[0]!;
  f.peer.exchange({ peers, rooms, messages: [], acknowledged: [published.id] });
  writeFileSync(join(f.root, 'login.ts'), 'changed after publish');
  await f.runtime().agent.recover(f.taskId, 'room');
  expect(f.store.snapshot().collaboration.outgoing).toEqual([published]);
  expect(f.store.snapshot().collaboration.acknowledged).toEqual([published.id]);
  f.owner.exchange({ peers, rooms, messages: [published], acknowledged: [] });
  expect(() => f.owner.assertVerified(f.ownerStore.task('goal')!, [published.id])).toThrow('changed');
});

test.each(['running', 'missing-turn', 'later-turn', 'wrong-workspace', 'wrong-room', 'unsubscribe', 'changed-task', 'request-scope', 'conflicting-result'])('unsafe %s recovery leaves state and outgoing messages untouched', async reason => {
  const f = setup(); f.draft(); const r = f.runtime();
  if (reason === 'running') r.read.thread.turns[0]!.status = 'inProgress';
  if (reason === 'missing-turn') r.read.thread.turns = [];
  if (reason === 'later-turn') r.read.thread.turns.push({ id: 'later', status: 'completed', items: [] });
  if (reason === 'wrong-workspace') r.read.thread.cwd = '/foreign';
  if (reason === 'unsubscribe') r.transport.unsubscribe = async () => { throw new Error('Cannot close session'); };
  if (reason === 'request-scope') f.store.transaction(s => { s.collaboration.incoming[0]!.roomId = 'other'; });
  if (reason === 'conflicting-result') {
    f.peer.publishVerification(f.store.task(f.taskId)!, f.verifier.finish(f.store.task(f.taskId)!));
    f.store.transaction(s => { s.collaboration.outgoing[0]!.to = 'foreign'; });
  }
  if (reason === 'changed-task') r.transport.read = async () => {
    f.store.update(f.taskId, { error: 'Concurrent change' }); return r.read;
  };
  const before = f.store.snapshot();
  await fails(r.agent.recover(f.taskId, reason === 'wrong-room' ? 'other' : 'room'), '');
  if (reason === 'changed-task') before.tasks[0]!.error = 'Concurrent change';
  expect(f.store.snapshot()).toEqual(before);
});

test('recovery is exclusive and failed persistence cannot release the task without its result', async () => {
  const f = setup(); f.draft(); const r = f.runtime(), gate = createDeferred<JsonRecord>();
  r.transport.read = () => gate.promise;
  const pending = r.agent.recover(f.taskId, 'room');
  await fails(r.agent.recover(f.taskId, 'room'), 'cannot safely inspect');
  expect(() => r.agent.submit('other', 'Work')).toThrow();
  const original = f.store.transaction.bind(f.store), before = f.store.snapshot();
  const fault = spyOn(f.store, 'transaction').mockImplementationOnce(mutate => original(state => {
    mutate(state); throw new Error('Simulated state commit failure');
  }));
  gate.resolve(r.read);
  await fails(pending, 'state commit failure'); fault.mockRestore();
  expect(f.store.snapshot()).toEqual(before);
  const restored = new AgentStore(join(f.root, 'reviewer'));
  expect(restored.task(f.taskId)?.status).toBe('unknown');
  expect(restored.snapshot().collaboration.outgoing).toHaveLength(0);
  await f.runtime(restored).agent.recover(f.taskId, 'room');
  expect(restored.snapshot().collaboration.outgoing).toHaveLength(1);
});

test.each([true, false])('owner processes recovered evidence before deciding completion (confirmed=%s)', async confirmed => {
  const f = setup();
  if (confirmed) f.draft();
  await f.runtime().agent.recover(f.taskId, 'room');
  const result = f.store.snapshot().collaboration.outgoing[0]!;
  f.owner.exchange({ peers, rooms, messages: [result], acknowledged: [] });
  const listeners = new Set<(event: Notification) => void>();
  let handler: ((params: JsonRecord) => Promise<JsonRecord>) | undefined;
  let turns = 0;
  const client: RpcClient = {
    handleTools: h => { handler = h; },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onFailure: () => () => {},
    request: async (method, params) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'thread/start') return { thread: { id: 'owner-thread' } };
      if (method !== 'turn/start') throw new Error(`Unexpected request: ${method}`);
      turns++;
      expect(JSON.stringify(params.input)).toContain(result.id);
      const call = (tool: string, args: JsonRecord) => handler!({ threadId: 'owner-thread', turnId: 'owner-turn', tool, arguments: args });
      const decision = { action: 'complete', reason: 'Independent verification passed', progress: 'Checked', nextAction: '',
        criteria: [{ criterion: 'Login works', met: true, evidence: result.id }] };
      if (confirmed) await call('record_decision', decision);
      else {
        await fails(call('record_decision', decision), 'did not pass');
        await call('request_verification', { ...f.args, requestId: 'retry' });
        await call('record_decision', { ...decision, action: 'wait', reason: 'Need confirmed evidence',
          criteria: [{ criterion: 'Login works', met: false, evidence: 'Inconclusive verification' }] });
      }
      for (const listener of listeners) listener({ method: 'turn/completed', params: { threadId: 'owner-thread',
        turn: { id: 'owner-turn', status: 'completed', items: [{ type: 'agentMessage', text: 'Judgment recorded' }], error: null } } });
      return { turn: { id: 'owner-turn' } };
    },
  };
  const agent = new SpecialistAgent({ client, store: f.ownerStore, collaboration: f.owner, workspace: f.root, profile: 'Development', configuration: {
    decisionProtocol: 1, verificationProtocol: 1, profileId: 'dev', accountId: 'fixture', role: 'development', token: 'a'.repeat(64),
    instructions: 'Develop', model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: false, commandExecution: false },
  } });
  agent.pump(); await agent.settled();
  expect(turns).toBe(1);
  expect(f.ownerStore.task('goal')).toMatchObject({ status: confirmed ? 'completed' : 'waiting',
    goal: { phase: confirmed ? 'completed' : 'waiting', turns: 3 } });
  expect(f.ownerStore.snapshot().collaboration.consumed).toContain(result.id);
  expect(f.ownerStore.snapshot().collaboration.outgoing).toHaveLength(confirmed ? 1 : 2);
});
