import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecialistAgent } from './agent.ts';
import { FakeClient } from './agent-test-client.ts';
import { parseConversation } from './conversation-contract.ts';
import { IdleLifecycle } from './idle-lifecycle.ts';
import { createDeferred, record, type JsonRecord } from './protocol.ts';
import { AgentStore } from './store.ts';
import { SCRATCH_PROFILE } from './task-scratch.ts';

const directories: string[] = [];
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-intake-'));
  directories.push(directory); return directory;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });
function setup(directory = temporary(), permissions = { fileWrite: true, commandExecution: true }) {
  const store = new AgentStore(directory), client = new FakeClient();
  const workspace = directory;
  const agent = new SpecialistAgent({ client, store, workspace, profile: 'Preserve the user scope.', configuration: {
    role: 'development', accountId: 'default', profileId: 'dev', token: 'a'.repeat(64),
    model: null, reasoningEffort: null, serviceTier: null, permissions, instructions: 'Preserve the user scope.',
    permissionProtocol: 1, conversationProtocol: 1, decisionProtocol: 1,
  } });
  const call = (tool: string, args: JsonRecord = {}) => client.toolHandler!({ threadId: 'thread', turnId: 'turn', tool, arguments: args });
  const confirm = () => call('request_execution_permissions', { fileWrite: true, commandExecution: true, reason: 'Create the requested file.' });
  const start = () => call('start_goal', { objective: 'Create the requested file.', criteria: ['File content verified.'] });
  const submit = (userText = 'Create the requested file.') => agent.submit('intake', userText,
    { roomId: 'room', conversation: 'intake', goal: false, automatic: true, userText });
  const finish = () => { client.complete(); return { turn: { id: 'turn' } }; };
  const lifecycle = new IdleLifecycle({ client, store, blocked: () => agent.busy });
  return { agent, client, store, workspace, directory, call, confirm, start, submit, finish, lifecycle };
}
async function queueRecovery(f: ReturnType<typeof setup>) {
  f.client.onStart = async () => { expect(await f.confirm()).toMatchObject({ status: 'already-allowed', phase: 'intake' }); return f.finish(); };
  f.submit(); await f.agent.settled();
  expect(f.store.task('intake')).toMatchObject({ status: 'waiting', dialogue: { intakeRecovery: 'queued' } });
}
function turns(f: ReturnType<typeof setup>) { return f.client.calls.filter(c => c.method === 'turn/start'); }

test('one intake recheck registers work while preserving read-only intake and saved execution permissions', async () => {
  const f = setup();
  await queueRecovery(f);
  expect(f.lifecycle.probe().idle).toBe(false);
  f.client.onStart = async () => { await f.start(); return f.finish(); };
  f.agent.pump(); f.agent.pump(); await f.agent.settled();
  expect(turns(f)).toHaveLength(2);
  expect(f.store.task('intake')).toMatchObject({ status: 'waiting', goal: { turns: 0, phase: 'ready' }, dialogue: { intakeRecovery: 'attempted' } });
  const intake = f.client.calls.filter(c => ['thread/start', 'thread/resume'].includes(c.method));
  for (const { params } of intake) {
    expect(record(params.config)['features.shell_tool']).toBe(false);
    expect(record(record(record(params.config)[`permissions.${SCRATCH_PROFILE}`]).filesystem)[f.workspace]).not.toBe('write');
  }
  f.client.onStart = async () => f.finish();
  f.agent.pump(); await f.agent.settled();
  const execution = f.client.calls.filter(c => c.method === 'thread/resume').at(-1)!.params;
  expect(record(execution.config)['features.shell_tool']).toBe(true);
  expect(record(record(record(execution.config)[`permissions.${SCRATCH_PROFILE}`]).filesystem)[f.workspace]).toBe('write');
  expect(f.store.task('intake')!.goal!.turns).toBe(1);
});

test('a second actionless response is interrupted without false completion or another retry after restart', async () => {
  let f = setup(); await queueRecovery(f);
  f.client.onStart = async () => f.finish();
  f.agent.pump(); await f.agent.settled();
  expect(f.store.task('intake')).toMatchObject({ status: 'interrupted', dialogue: { intakeRecovery: 'attempted' } });
  expect(f.store.task('intake')!.error).toContain('No work completion was established');
  f.agent.pump(); expect(turns(f)).toHaveLength(2);
  f = setup(f.directory); f.agent.pump();
  expect(turns(f)).toHaveLength(0);
  expect(f.lifecycle.probe().idle).toBe(true);
});

test('queued recheck survives restart but an ambiguous attempted turn is never replayed', async () => {
  let f = setup(); await queueRecovery(f);
  f = setup(f.directory);
  f.client.onStart = async () => { throw new Error('lost acknowledgement'); };
  f.agent.pump(); await f.agent.settled();
  expect(f.store.task('intake')).toMatchObject({ status: 'unknown', dialogue: { intakeRecovery: 'attempted' } });
  const restored = setup(f.directory); restored.agent.pump();
  expect(restored.store.task('intake')!.status).toBe('unknown');
  expect(turns(restored)).toHaveLength(0);
});

test('a crash after persisting the attempt is quarantined before model work can replay', async () => {
  const f = setup(); await queueRecovery(f);
  f.store.update('intake', { status: 'accepted', dialogue: { ...f.store.task('intake')!.dialogue!, intakeRecovery: 'attempted' } });
  const restored = setup(f.directory); restored.agent.pump();
  expect(restored.store.task('intake')!.status).toBe('unknown');
  expect(turns(restored)).toHaveLength(0);
});

test('ordinary answers complete without a goal or recheck', async () => {
  const f = setup(); f.submit('Explain what a worktree is.'); await f.agent.settled();
  f.agent.pump();
  expect(f.store.task('intake')!.status).toBe('completed');
  expect(f.store.task('intake')!.goal).toBeUndefined();
  expect(f.store.task('intake')!.dialogue!.intakeRecovery).toBeUndefined();
  expect(turns(f)).toHaveLength(1);
});

test('missing or denied project permissions never trigger an automatic recheck or grant', async () => {
  const f = setup(undefined, { fileWrite: false, commandExecution: false });
  f.client.onStart = async () => { expect(await f.confirm()).toMatchObject({ status: 'pending' }); return f.finish(); };
  f.submit(); await f.agent.settled(); f.agent.pump();
  const task = f.store.task('intake')!;
  expect(task).toMatchObject({ status: 'waiting', permissionRequest: { status: 'pending' } });
  expect(task.dialogue!.intakeRecovery).toBeUndefined();
  f.store.update(task.id, { permissionRequest: { ...task.permissionRequest!, status: 'denied' } });
  const restored = setup(f.directory, { fileWrite: false, commandExecution: false }); restored.agent.pump();
  expect(turns(restored)).toHaveLength(0);
  expect(turns(f)).toHaveLength(1);
});

test.each(['start_goal', 'ask_user', 'continue_goal'])('already allowed followed by %s needs no recovery', async action => {
  const f = setup();
  if (action === 'continue_goal') {
    f.store.create('target', 'Choose a filename', { roomId: 'room', conversation: 'target',
      dialogue: { userText: 'Choose a filename', questions: [{ id: 'name', text: 'Which name?', answer: null }], revisions: [] } });
    f.store.complete('target', { status: 'waiting', output: '', error: null });
  }
  f.client.onStart = async () => {
    await f.confirm();
    if (action === 'start_goal') await f.start();
    else if (action === 'ask_user') await f.call(action, { id: 'name', question: 'Which name?' });
    else await f.call(action, { taskId: 'target', reason: 'User answered the filename question.' });
    return f.finish();
  };
  f.submit(); await f.agent.settled();
  expect(f.store.task('intake')!.dialogue!.intakeRecovery).toBeUndefined();
  expect(f.store.task('intake')!.status).toBe(action === 'continue_goal' ? 'completed' : 'waiting');
});

test('a user correction supersedes a queued recheck without injecting the old request again', async () => {
  const f = setup(); await queueRecovery(f);
  f.client.onStart = async () => f.finish();
  f.agent.input('intake', 'correction', 'Just explain the plan.', 'room'); await f.agent.settled();
  f.agent.pump();
  expect(f.store.task('intake')!.status).toBe('completed');
  expect(f.store.task('intake')!.dialogue!.intakeRecovery).toBeUndefined();
  expect(turns(f)).toHaveLength(2);
  expect(JSON.stringify(turns(f)[1]!.params.input)).not.toContain('Reassess the previous intake once');
});

test('user input arriving during the first turn is handled before automatic recovery', async () => {
  const f = setup(), confirmed = createDeferred<void>(), release = createDeferred<void>();
  f.client.onStart = async () => { await f.confirm(); confirmed.resolve(); await release.promise; return f.finish(); };
  f.submit(); await confirmed.promise;
  f.agent.input('intake', 'correction', 'Only explain.', 'room'); release.resolve(); await f.agent.settled();
  expect(f.store.task('intake')!.dialogue!.intakeRecovery).toBeUndefined();
  f.client.onStart = async () => f.finish();
  f.agent.pump(); await f.agent.settled();
  expect(f.store.task('intake')!.status).toBe('completed');
  expect(JSON.stringify(turns(f)[1]!.params.input)).toContain('Only explain.');
});

test('stopping a queued or active recheck prevents further automatic work', async () => {
  const queued = setup(); await queueRecovery(queued);
  await queued.agent.stop('intake'); queued.agent.pump();
  expect(queued.store.task('intake')!.status).toBe('interrupted');
  expect(turns(queued)).toHaveLength(1);
  const active = setup(); await queueRecovery(active);
  const started = createDeferred<void>();
  active.client.onStart = async () => { started.resolve(); return { turn: { id: 'turn' } }; };
  active.agent.pump(); await started.promise;
  await active.agent.stop('intake'); await active.agent.settled(); active.agent.pump();
  expect(active.store.task('intake')!.status).toBe('interrupted');
  expect(turns(active)).toHaveLength(2);
});

test('conversation persistence accepts legacy records and rejects invalid recovery values', () => {
  const legacy = { userText: 'Create a file.', questions: [], revisions: [] };
  expect(parseConversation(legacy)).toEqual(legacy);
  for (const intakeRecovery of ['queued', 'attempted'] as const) expect(parseConversation({ ...legacy, intakeRecovery }).intakeRecovery).toBe(intakeRecovery);
  for (const intakeRecovery of [true, null, 'true', 'retry', 1]) expect(() => parseConversation({ ...legacy, intakeRecovery })).toThrow('Invalid intake recovery state');
});
