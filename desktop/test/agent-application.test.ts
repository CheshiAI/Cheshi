import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { candidateFixture } from '../../experiments/codex-specialists/src/candidate-verification-fixture.ts';
import { SpecialistAgent } from '../../experiments/codex-specialists/src/agent.ts';
import { WorkAgentModel } from './fixtures/work-agent-model.ts';
import { validateCandidateRequest, validateCandidateResult } from '../lib/agent-orchestration/candidate-verification.mts';
import { workDigest } from '../../experiments/codex-specialists/src/work-files.ts';
import { SCRATCH_PROFILE } from '../../experiments/codex-specialists/src/task-scratch.ts';
import { record } from '../../experiments/codex-specialists/src/protocol.ts';
import { WorkerIntegration } from '../../experiments/codex-specialists/src/integration.ts';
import { inspectAgentTasks } from '../lib/agent-management/task-inspection.mts';
import { parseAgentDetails } from '../shared/agent-management.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cheshi-apply-runtime-')); roots.push(root);
  return candidateFixture(root);
}
async function fails(operation: Promise<unknown>, text: string) {
  let error: unknown; try { await operation; } catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(text);
}
function owner(f: ReturnType<typeof fixture>, client: WorkAgentModel) {
  return new SpecialistAgent({ store: f.store, client, collaboration: f.owner, workspace: f.project, profile: 'Apply approved work',
    configuration: { profileId: 'owner', accountId: 'fixture', role: 'development', token: 'a'.repeat(64), instructions: 'Apply approved work',
      model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: true, commandExecution: false },
      applicationInspectionProtocol: 1, applicationProtocol: 1, candidateVerificationProtocol: 1, integrationProtocol: 1, workProtocol: 1, verificationProtocol: 1, decisionProtocol: 1 } });
}
const decision = (action: 'wait' | 'complete' | 'blocked') => ({ action, reason: 'Application and project verification', progress: 'Inspected actual evidence', nextAction: 'Check project',
  criteria: [{ criterion: 'Candidate is correct', met: action === 'complete', evidence: action === 'complete' ? 'Applied files and independent project receipts' : '' }] });

test('explicit application inspection survives worker replacement without model calls or changing completion judgment', () => {
  const f = fixture(), check = f.requestVerification(); f.observe(check.taskId); f.draft(check.taskId); f.deliver(check.taskId);
  new WorkerIntegration(f.store, f.project, 'owner', true, true).call(f.store.task('goal')!, 'apply_integration', { candidateId: f.candidate.id, hash: f.candidate.hash });
  f.store.update('goal', { status: 'interrupted', goal: { ...f.store.task('goal')!.goal!, phase: 'blocked' } });
  const prior = structuredClone(f.store.task('goal')!), client = new WorkAgentModel();
  for (let n = 0; n < 2; n++) {
    const worker = owner(f, client);
    const inspected = worker.inspectApplication('goal', 'room', f.candidate.id, f.candidate.hash);
    expect(inspected.integration?.application).toMatchObject({ status: 'applied', lockReleased: true });
    expect(inspected.goal).toEqual(prior.goal); expect(inspected.status).toBe(prior.status);
    expect(inspected.integration?.projectVerification?.status).not.toBe('pass');
  }
  expect(client.calls).toHaveLength(0);
  expect(readFileSync(join(f.project, f.paths[0]!), 'utf8')).toBe(`candidate ${f.paths[0]}`);
});

test('application inspection refuses mismatched scope and unknown or active executions', () => {
  const f = fixture(), client = new WorkAgentModel(), worker = owner(f, client);
  f.store.update('goal', { status: 'interrupted' });
  expect(() => worker.inspectApplication('goal', 'foreign', f.candidate.id, f.candidate.hash)).toThrow('unavailable');
  expect(() => worker.inspectApplication('goal', 'room', 'f'.repeat(64), f.candidate.hash)).toThrow('exact');
  f.store.create('other', 'Unconfirmed execution');
  for (const status of ['unknown', 'accepted', 'running'] as const) {
    f.store.update('other', { status });
    expect(() => worker.inspectApplication('goal', 'room', f.candidate.id, f.candidate.hash)).toThrow('unknown executions');
  }
  expect(client.calls).toHaveLength(0);
});

test.each(['aborted', 'interrupted'] as const)('unfinished %s application survives worker activity and desktop detail parsing without false warnings', status => {
  const f = fixture(), check = f.requestVerification(); f.observe(check.taskId); f.draft(check.taskId); f.deliver(check.taskId);
  const integration = new WorkerIntegration(f.store, f.project, 'owner', true, true);
  integration.call(f.store.task('goal')!, 'apply_integration', { candidateId: f.candidate.id, hash: f.candidate.hash });
  const paths = status === 'aborted' ? f.paths : f.paths.slice(0, 1);
  for (const path of paths) writeFileSync(join(f.project, path), `original ${path}`);
  f.store.update('goal', { status: 'interrupted', goal: { ...f.store.task('goal')!.goal!, phase: 'blocked' } });
  const prior = structuredClone(f.store.task('goal')!.goal), client = new WorkAgentModel(), worker = owner(f, client);
  worker.inspectApplication('goal', 'room', f.candidate.id, f.candidate.hash);
  const details = parseAgentDetails({ agent: { id: 'worker', name: 'Fixture', state: 'running', image: 'fixture' }, ready: true,
    busy: false, authenticated: true, threadId: null, error: null, logs: '', tasks: inspectAgentTasks(JSON.parse(JSON.stringify(worker.activity()))) });
  const task = details.tasks.find(task => task.id === 'goal')!;
  expect(task.inspection?.error).toBeNull();
  expect(task.inspection?.integration).toMatchObject({ status: 'stale', issues: [], application: { status }, verification: { status: 'stale' } });
  expect(task.inspection?.integration?.projectVerification).toBeUndefined();
  expect(f.store.task('goal')!.goal).toEqual(prior);
  expect(task.inspection?.goal).toMatchObject({ phase: prior!.phase, turns: prior!.turns, criteria: prior!.criteria, verificationRequired: true });
  expect(() => integration.assertComplete(f.store.task('goal')!)).toThrow('independently verified');
  expect(client.calls).toHaveLength(0);
});

test.each([false, true])('owner applies, waits for project verification, and completes only while the result stays current (edit=%s)', async edit => {
  const f = fixture(), check = f.requestVerification(); f.observe(check.taskId); f.draft(check.taskId); f.deliver(check.taskId);
  const client = new WorkAgentModel();
  f.store.saveThread('owner-thread', null, 'goal', true);
  f.store.update('goal', { status: 'interrupted', integrationTools: true, applicationTools: true, goal: { ...f.store.task('goal')!.goal!, phase: 'blocked' } });
  const worker = owner(f, client);
  client.onTurn = async call => {
    const applied = await call('apply_integration', { candidateId: f.candidate.id, hash: f.candidate.hash });
    expect(applied.appliedToProject).toBe(true);
    await fails(call('record_decision', decision('complete')), 'independently verified');
    await call('request_verification', { ...f.args, requestId: 'project-round' });
    await call('record_decision', decision('wait')); return 'Applied; waiting for project verification';
  };
  worker.input('goal', 'apply-now', 'Apply within approved scope', 'room'); await worker.settled();
  expect(f.store.task('goal')?.status).toBe('waiting');
  const message = f.store.snapshot().collaboration.outgoing.at(-1)!;
  const state = f.store.snapshot().collaboration;
  validateCandidateRequest(message, [...state.outgoing.filter(m => m.id !== message.id), ...state.incoming]);
  const noPass = state.incoming.filter(m => m.kind !== 'verification_result');
  expect(() => validateCandidateRequest(message, [...state.outgoing, ...noPass])).toThrow('prior');
  const changed = JSON.parse(message.text); changed.candidate.applicationId = 'f'.repeat(64);
  expect(() => validateCandidateRequest({ ...message, text: JSON.stringify(changed) }, [...state.outgoing, ...state.incoming])).toThrow('identity');
  f.peer.exchange({ peers: f.roster, rooms: f.rooms, messages: [message], acknowledged: [] });
  const next = f.peer.next()!;
  f.reviewer.create(next.taskId, next.prompt, { verification: next.verification, roomId: 'room', conversation: next.taskId });
  expect(f.verifier.workspaceFor(f.reviewer.task(next.taskId)!, false)).toBe(f.project);
  f.observe(next.taskId); f.draft(next.taskId); const reply = f.deliver(next.taskId);
  validateCandidateResult(message, reply);
  const prior = state.incoming.find(m => m.kind === 'verification_result')!;
  expect(() => validateCandidateResult(message, prior)).toThrow('another candidate');
  client.onTurn = async call => {
    await call('record_decision', decision('complete'));
    if (edit) writeFileSync(join(f.project, f.paths[0]!), 'external edit after decision');
    return 'Verified project';
  };
  worker.pump(); await worker.settled();
  expect(f.store.task('goal')?.goal?.phase === 'completed').toBe(!edit);
  if (!edit) expect(readFileSync(join(f.project, f.paths[0]!), 'utf8')).toBe(`candidate ${f.paths[0]}`);
});

test('application tools are added only to new native conversations; existing goals retain their tool set', async () => {
  const f = fixture(), client = new WorkAgentModel(), worker = owner(f, client);
  f.store.saveThread('legacy-thread', null, 'goal', true);
  f.store.update('goal', { status: 'interrupted', integrationTools: true, goal: { ...f.store.task('goal')!.goal!, phase: 'blocked' } });
  client.onTurn = async call => {
    await fails(call('apply_integration', { candidateId: f.candidate.id, hash: f.candidate.hash }), 'new goal');
    await call('record_decision', decision('blocked')); return 'New goal required';
  };
  worker.input('goal', 'resume', 'Continue', 'room'); await worker.settled();
  const resume = client.calls.find(c => c.method === 'thread/resume')!.params;
  expect(resume.dynamicTools).toBeUndefined(); expect(String(resume.developerInstructions)).not.toContain('use apply_integration');
  client.onTurn = async call => { await call('record_decision', decision('blocked')); return 'Ready for approved scope'; };
  worker.submit('new', 'New approved goal', { roomId: 'room', conversation: 'new', goal: true }); await worker.settled();
  const start = client.calls.find(c => c.method === 'thread/start')!.params;
  expect((start.dynamicTools as { name: string }[]).map(t => t.name)).toContain('apply_integration');
  expect(f.store.task('new')?.applicationTools).toBe(true);
});

test('applied-project verifier receives the original cwd with read-only source and isolated scratch', async () => {
  const f = fixture(), client = new WorkAgentModel(); client.acknowledgeFirst = true;
  const snapshot = { ...f.candidate, applicationId: workDigest(`application/owner/${f.candidate.id}/${f.candidate.hash}`) };
  // A mismatched project must fail before creating a native thread.
  f.owner.call(f.store.task('goal')!, 'request_verification', f.args, snapshot);
  const message = f.store.snapshot().collaboration.outgoing.at(-1)!;
  f.peer.exchange({ peers: f.roster, rooms: f.rooms, messages: [message], acknowledged: [] });
  const worker = new SpecialistAgent({ store: f.reviewer, client, collaboration: f.peer, workspace: f.project, profile: 'Verify project',
    configuration: { profileId: 'verifier', accountId: 'fixture', role: 'verification', token: 'a'.repeat(64), instructions: 'Verify project', model: null, reasoningEffort: null, serviceTier: null,
      permissions: { fileWrite: false, commandExecution: true }, applicationProtocol: 1, candidateVerificationProtocol: 1, integrationProtocol: 1, workProtocol: 1, verificationProtocol: 1, decisionProtocol: 1 } });
  worker.pump(); await worker.settled();
  expect(client.calls.some(c => c.method === 'thread/start')).toBe(false);
  const task = f.reviewer.snapshot().tasks[0]!;
  expect(task.status).toBe('failed');
  for (const file of snapshot.files) { if (file.content === null) rmSync(join(f.project, file.path)); else writeFileSync(join(f.project, file.path), file.content); }
  f.reviewer.update(task.id, { status: 'unknown', threadId: 'unused', turnId: 'unused' });
  // Use another request to exercise a fresh verifier turn, not replay the failed one.
  const second = { ...message, id: 'b'.repeat(64), questionId: 'b'.repeat(64) };
  f.reviewer.update(task.id, { status: 'failed' }); f.peer.exchange({ peers: f.roster, rooms: f.rooms, messages: [second], acknowledged: [] });
  client.onTurn = async () => 'No claimed verdict';
  try {
    worker.pump(); await worker.settled();
    const start = client.calls.find(c => c.method === 'thread/start')!.params;
    expect(start.cwd).toBe(f.project); expect(start.permissions).toBe(SCRATCH_PROFILE);
    expect(record(record(record(start.config)[`permissions.${SCRATCH_PROFILE}`]).filesystem)[f.project]).toBe('read');
  } finally { worker.disposeScratch(); }
});
