import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecialistAgent } from './agent.ts';
import { FakeClient } from './agent-test-client.ts';
import { AgentStore, BEFORE_SUBMISSION_RECOVERED, WORKER_RESTART_ERROR } from './store.ts';
import { createDeferred, type JsonRecord } from './protocol.ts';
import { newGoal } from './decision.ts';

const directories: string[] = [];
function fixture(directory = mkdtempSync(join(tmpdir(), 'cheshi-pre-submit-'))) {
  if (!directories.includes(directory)) directories.push(directory);
  const store = new AgentStore(directory), client = new FakeClient();
  const agent = new SpecialistAgent({ store, client, workspace: '/workspace', profile: 'Inspect only.',
    configuration: { conversationProtocol: 1, decisionProtocol: 1, profileId: 'dev', accountId: 'fixture',
      role: 'development', token: 'a'.repeat(64), instructions: 'Inspect only.', model: null,
      reasoningEffort: null, serviceTier: null, permissions: { fileWrite: false, commandExecution: false } } });
  return { directory, store, client, agent };
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true }); });

async function rejected(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}

test('restart during preparation recovers without execution and resumes only on new input', async () => {
  const first = fixture(), preparing = createDeferred<void>(), release = createDeferred<JsonRecord>();
  first.store.saveThread('thread', 'test-model', 'task');
  first.client.onInject = async () => { preparing.resolve(); return release.promise; };
  first.agent.submit('task', 'Inspect the cart', { roomId: 'room', conversation: 'task', goal: false,
    userText: 'Inspect the cart', automatic: true });
  await preparing.promise;
  expect(first.store.task('task')).toMatchObject({ status: 'accepted', threadId: null, turnId: null });
  expect(first.client.calls.some(c => c.method === 'turn/start')).toBe(false);
  const restarted = fixture(first.directory);
  expect(restarted.store.task('task')).toMatchObject({ status: 'unknown', error: WORKER_RESTART_ERROR });
  await rejected(restarted.agent.recover('task', 'other'), 'Unknown room');
  const recovered = await restarted.agent.recover('task', 'room');
  expect(recovered).toMatchObject({ status: 'interrupted', error: BEFORE_SUBMISSION_RECOVERED, threadId: null, turnId: null });
  expect(recovered.recovery).toBeUndefined();
  restarted.agent.pump(); await restarted.agent.settled();
  expect(restarted.client.calls).toHaveLength(0);
  expect(restarted.store.memory()).toBe('');
  const again = fixture(first.directory);
  expect(await again.agent.recover('task', 'room')).toEqual(recovered);
  expect(again.client.calls).toHaveLength(0);
  // End the simulated old process without executing its prepared input.
  await first.agent.stop('task'); release.resolve({}); await first.agent.settled();
  again.agent.input('task', 'explicit-resume', 'Continue with the cart only', 'room');
  await again.agent.settled();
  expect(again.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
});

test.each([
  { threadId: 'thread', turnId: null, error: WORKER_RESTART_ERROR },
  { threadId: null, turnId: 'turn', error: WORKER_RESTART_ERROR },
  { threadId: null, turnId: null, error: 'Transport acknowledgement lost' },
])('missing IDs do not authorize recovery for $error / $threadId / $turnId', async patch => {
  const f = fixture();
  f.store.create('task', 'Inspect', { roomId: 'room', conversation: 'task',
    dialogue: { userText: 'Inspect', questions: [], revisions: [] } });
  f.store.update('task', { status: 'unknown', ...patch });
  const before = f.store.task('task');
  await rejected(f.agent.recover('task', 'room'), 'no acknowledged turn ID');
  expect(f.store.task('task')).toEqual(before);
  expect(f.client.calls).toHaveLength(0);
});

test('pre-submission recovery preserves unfinished criteria and verification requirements', async () => {
  const f = fixture();
  const goal = { ...newGoal(true), criteria: [{ criterion: 'Inspect checkout', met: false, evidence: '' }] };
  f.store.create('task', 'Inspect checkout', { roomId: 'room', conversation: 'task', goal });
  f.store.update('task', { status: 'unknown', error: WORKER_RESTART_ERROR, output: 'Cart already observed' });
  const recovered = await f.agent.recover('task', 'room');
  expect(recovered).toMatchObject({ status: 'interrupted', output: 'Cart already observed',
    goal: { phase: 'blocked', pending: null, criteria: goal.criteria, verificationRequired: true } });
  expect(f.client.calls).toHaveLength(0);
  expect(f.store.memory()).toBe('');
});

test('submission boundary is durable before an acknowledgement can be lost', async () => {
  const f = fixture();
  f.client.onStart = async () => {
    const durable = new AgentStore(f.directory).task('task');
    expect(durable).toMatchObject({ threadId: 'thread', turnId: null });
    throw new Error('acknowledgement lost');
  };
  f.agent.submit('task', 'Inspect', { roomId: 'room', conversation: 'task', goal: false,
    userText: 'Inspect', automatic: true });
  await f.agent.settled();
  const restarted = fixture(f.directory);
  await rejected(restarted.agent.recover('task', 'room'), 'no acknowledged turn ID');
  expect(restarted.store.task('task')?.status).toBe('unknown');
  expect(restarted.client.calls).toHaveLength(0);
});
