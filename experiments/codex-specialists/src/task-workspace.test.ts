import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecialistAgent } from './agent.ts';
import { FakeClient } from './agent-test-client.ts';
import { AgentStore } from './store.ts';
import type { RuntimeConfiguration } from './runtime-config.ts';
import { TaskWorkspaceGate, parseWorkspaceRun } from './task-workspace.ts';
import { WorkerConversation } from './conversation.ts';
import { newGoal } from './decision.ts';
import { IdleLifecycle } from './idle-lifecycle.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { const path = mkdtempSync(join(tmpdir(), 'cheshi-task-workspace-')); directories.push(path); return path; }
function setup(path: string, key: string | null) {
  const store = new AgentStore(path), client = new FakeClient();
  const configuration: RuntimeConfiguration = { profileId: 'dev', accountId: 'account', role: 'developer',
    token: 'a'.repeat(64), instructions: 'test', model: null, reasoningEffort: null, serviceTier: null,
    permissions: { fileWrite: false, commandExecution: false }, taskWorkspace: { key }, decisionProtocol: 1, conversationProtocol: 1 };
  const agent = new SpecialistAgent({ client, store, profile: 'test', workspace: '/workspace', configuration });
  return { agent, store, client };
}
const baseline = `@intake:${'a'.repeat(40)}`;
const plain = (id: string) => ({ roomId: 'room', conversation: id, goal: false });
const intake = (id: string) => ({ roomId: 'room', conversation: id, goal: false, automatic: true as const, userText: 'request' });

test('task handoff survives restart without a model call in the wrong mount or duplicate execution', async () => {
  const path = directory(), first = setup(path, null);
  first.agent.submit('first', 'request', plain('first'));
  expect(first.store.task('first')).toMatchObject({ status: 'waiting', workspaceKey: 'first', workspaceRun: { input: 'request' } });
  expect(first.client.calls).toHaveLength(0);
  expect(first.agent.prepareWorkspace()).toEqual({ taskId: 'first', key: 'first' });
  expect(() => first.agent.submit('second', 'request', plain('second'))).toThrow('active task');
  first.agent.pump(); expect(first.client.calls).toHaveLength(0);
  const wrong = setup(path, 'second'); wrong.agent.pump(); expect(wrong.client.calls).toHaveLength(0);
  const restored = setup(path, 'first'); restored.agent.pump(); await restored.agent.settled();
  expect(restored.store.task('first')?.status).toBe('completed');
  expect(restored.store.task('first')?.workspaceRun).toBeUndefined();
  restored.agent.pump(); await restored.agent.settled();
  expect(restored.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
  restored.agent.submit('second', 'independent', plain('second'));
  expect(restored.agent.prepareWorkspace()).toEqual({ taskId: 'second', key: 'second' });
  const independent = setup(path, 'second'); independent.agent.pump(); await independent.agent.settled();
  expect(independent.client.calls.some(c => c.method === 'thread/start')).toBe(true);
  expect(independent.client.calls.some(c => c.method === 'thread/resume')).toBe(false);
});

test('automatic follow-up routing queues the original task workspace and native conversation', async () => {
  const path = directory(), first = setup(path, 'goal');
  first.agent.submit('goal', 'original', plain('goal')); await first.agent.settled();
  first.store.update('goal', { status: 'waiting', goal: { ...newGoal(false), phase: 'blocked', turns: 1 } });
  first.agent.submit('followup', 'continue original', intake('followup'));
  expect(first.agent.prepareWorkspace()).toEqual({ taskId: 'followup', key: '@intake' });
  const routed = setup(path, baseline), control = new WorkerConversation(routed.store, false);
  routed.client.onStart = async () => {
    control.call(routed.store.task('followup')!, 'continue_goal', { taskId: 'goal', reason: 'Same requested work' });
    routed.client.complete(); return { turn: { id: 'turn' } };
  };
  routed.agent.pump(); await routed.agent.settled(); routed.agent.pump();
  expect(routed.agent.prepareWorkspace()).toEqual({ taskId: 'goal', key: 'goal' });
  expect(routed.store.task('goal')?.workspaceRun?.input).toContain('User input (followup)');
  expect(routed.store.task('followup')?.dialogue?.route?.delivered).toBe(true);
  const resumed = setup(path, 'goal'); resumed.agent.pump(); await resumed.agent.settled();
  expect(resumed.client.calls.some(c => c.method === 'thread/resume')).toBe(true);
  expect(resumed.store.task('goal')?.inputs?.map(i => i.id)).toEqual(['followup']);
  expect(resumed.store.task('goal')?.workspaceKey).toBe('goal');
});

test('stopping a pending workspace does not execute it after restart and pending work cannot sleep', async () => {
  const path = directory(), f = setup(path, null);
  f.agent.submit('queued', 'request', plain('queued'));
  const lifecycle = new IdleLifecycle({ store: f.store, client: f.client, blocked: () => f.agent.busy });
  expect(lifecycle.probe().idle).toBe(false);
  expect(f.agent.prepareWorkspace()).toEqual({ taskId: 'queued', key: 'queued' });
  await f.agent.stop('queued');
  expect(() => f.agent.submit('next', 'request', plain('next'))).not.toThrow();
  const restored = setup(path, 'queued'); restored.agent.pump(); await restored.agent.settled();
  expect(restored.client.calls).toHaveLength(0);
  expect(restored.store.task('queued')?.status).toBe('interrupted');
  expect(restored.store.task('queued')?.workspaceRun).toBeUndefined();
});

test('legacy tasks retain null workspace identity while new tasks never inherit it', async () => {
  const path = directory(), old = new AgentStore(path);
  old.create('old', 'old work', { roomId: 'room', goal: { ...newGoal(false), phase: 'blocked' } });
  old.update('old', { status: 'waiting' });
  const f = setup(path, null);
  expect(f.store.task('old')?.workspaceKey).toBeNull();
  f.agent.input('old', 'answer', 'continue', 'room'); await f.agent.settled();
  expect(f.client.calls.some(c => c.method === 'turn/start')).toBe(true);
  f.agent.submit('fresh', 'new work', plain('fresh'));
  expect(f.agent.prepareWorkspace()).toEqual({ taskId: 'fresh', key: 'fresh' });
});

test('unknown execution and malformed pending state fail closed', () => {
  const store = new AgentStore(directory()), gate = new TaskWorkspaceGate(store, null);
  const task = store.create('task', 'work');
  gate.defer(task, { input: 'work', messages: [], intakeRetry: false });
  store.update('task', { status: 'unknown' });
  expect(() => gate.prepare(false)).toThrow('during execution');
  expect(() => parseWorkspaceRun({ input: 'work', messages: [], intakeRetry: 'true' })).toThrow();
});


test('read-only intake shares a baseline; only a new goal requests a task-specific workspace', async () => {
  const path = directory(), f = setup(path, baseline);
  const conversation = new WorkerConversation(f.store, false);
  f.client.onStart = async () => {
    conversation.call(f.store.task('work')!, 'start_goal', { objective: 'Implement requested work', criteria: ['works'] });
    f.client.complete(); return { turn: { id: 'turn' } };
  };
  f.agent.submit('work', 'implement', intake('work')); await f.agent.settled();
  expect(f.store.task('work')?.workspaceRun).toBeUndefined();
  expect(f.store.task('work')?.goal?.turns).toBe(0);
  f.agent.pump();
  expect(f.agent.prepareWorkspace()).toEqual({ taskId: 'work', key: 'work' });
  expect(f.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
  await f.agent.stop('work'); f.agent.resumeWorkspace();
  f.client.onStart = async () => { f.client.complete(); return { turn: { id: 'turn' } }; };
  f.agent.submit('question', 'ordinary question', intake('question')); await f.agent.settled();
  expect(f.agent.prepareWorkspace()).toBeNull();
  expect(f.store.task('question')?.goal).toBeUndefined();
});
