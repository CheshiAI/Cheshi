import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentChats } from '../lib/agent-chats/service.mts';
import { ChatsStore } from '../lib/agent-chats/store.mts';
import { bindingFor, type Message } from '../lib/agent-orchestration/mailbox.mts';
import { specialistAgent } from './agent-registry-fixtures';
import type { AgentDetails } from '../shared/agent-management';
import type { ChatsRequest } from '../shared/agent-chats';
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-chats-'))); directories.push(workspace);
  const filename = join(workspace, 'chats.json');
  const agents = ['dev', 'planner', 'outside'].map((id, i) => ({ ...specialistAgent(), id, name: id, accountId: `account-${i}`, assignments: [{ workspaceRoot: workspace, instructions: '' }] }));
  const details: AgentDetails = { agent: { id: 'container', name: 'Dev', state: 'running', image: 'worker' }, ready: true, authenticated: true, busy: false, threadId: null, error: null, logs: '', tasks: [] };
  const sent: { agent: string; task: string; room: string; input?: string; goal: boolean }[] = [];
  let uncertain = false;
  const options = { filename, registry: () => ({ workspaceRoot: workspace, agents }), status: async () => ({ details }),
    dispatch: async (_workspace: string, input: import('../shared/agent-runtime').AgentRuntimeRequest, context: { roomId: string; conversation: string; goal: boolean; inputId?: string }) => {
      sent.push({ agent: input.agentId, task: input.taskId!, room: context.roomId, input: context.inputId, goal: context.goal });
      if (uncertain) throw Object.assign(new Error('lost acknowledgement'), { deliveryUncertain: true });
      let task = details.tasks.find(t => t.id === input.taskId);
      if (!task) { task = { id: input.taskId!, prompt: input.prompt!, status: 'waiting', createdAt: new Date().toISOString(), output: '', error: null, roomId: context.roomId, responses: [] }; details.tasks.push(task); }
      if (context.inputId) task.inputs = [...(task.inputs ?? []), { id: context.inputId, prompt: input.prompt! }];
      return { details };
    } };
  const service = createAgentChats(options);
  const request = (v: ChatsRequest) => service.request(workspace, v);
  request({ action: 'create', id: 'room', name: 'Login', engineId: 'docker:test', members: ['dev', 'planner'], defaultAgentId: 'dev' });
  const send = (id: string, patch: Partial<Extract<ChatsRequest, { action: 'send' }>> = {}) => request({ action: 'send', id, roomId: 'room', threadId: null, recipient: null, text: 'Build login', goal: true, ...patch });
  return { workspace, filename, agents, details, sent, options, service, request, send, uncertain: () => { uncertain = true; } };
}
test('room membership and messages survive restart; sends are idempotent and workspace scoped', async () => {
  const f = fixture();
  f.send('goal'); f.send('goal');
  expect(f.request({ action: 'list' }).messages).toHaveLength(1);
  expect(() => f.send('goal', { text: 'Different content' })).toThrow('identity');
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-chats-other-'))); directories.push(other);
  expect(() => f.service.request(other, { action: 'send', id: 'foreign', roomId: 'room', threadId: null, recipient: null, text: 'Access', goal: false })).toThrow('project');
  const restarted = createAgentChats(f.options);
  expect(restarted.request(f.workspace, { action: 'list' }).rooms[0]?.members).toHaveLength(2);
  await restarted.tick(); await restarted.tick();
  expect(f.sent).toHaveLength(1);
  expect(restarted.request(f.workspace, { action: 'list' }).messages[0]?.status).toBe('waiting');
});
test('goal owner receives thread follow-up; explicit recipient gets a separate task; results are deduplicated', async () => {
  const f = fixture(); f.send('goal'); await f.service.tick();
  const original = f.sent[0]!.task;
  f.send('followup', { threadId: 'goal', goal: false, text: 'Use email' });
  f.send('question', { threadId: 'goal', recipient: 'planner', goal: false, text: 'Review requirements' });
  await f.service.tick(); await f.service.tick();
  expect(f.sent.find(s => s.input === 'followup')).toMatchObject({ agent: 'dev', task: original });
  expect(f.sent.find(s => s.agent === 'planner')?.task).not.toBe(original);
  f.details.tasks[0]!.responses = [{ id: 'response_1', text: 'Working on it', status: 'waiting' }];
  await f.service.tick(); await f.service.tick();
  const results = f.request({ action: 'list' }).messages.filter(m => m.text === 'Working on it');
  expect(results).toHaveLength(1); expect(results[0]?.threadId).toBe('goal');
});
test('uninvited, removed and account-replaced identities cannot receive work or relay messages', async () => {
  const f = fixture(); f.send('goal');
  expect(() => f.send('bad', { recipient: 'outside' })).toThrow('participant');
  const taskId = f.request({ action: 'list' }).messages[0]!.taskId!;
  const binding = bindingFor(f.workspace, 'docker:test', 'dev', 'account-0');
  const m: Message = { id: 'q', kind: 'question', from: 'dev', to: 'planner', taskId, questionId: 'q', text: 'Help', roomId: 'room' };
  expect(f.service.rooms.allowed(binding, m)).toBe(true);
  expect(f.service.rooms.allowed(binding, { ...m, to: 'outside' })).toBe(false);
  expect(f.service.rooms.allowed(binding, { ...m, roomId: undefined })).toBe(false);
  expect(f.service.rooms.allowed({ ...binding, engineId: 'docker:other' }, m)).toBe(false);
  f.service.rooms.record(binding, [m]); f.service.rooms.record(binding, [m]);
  expect(f.request({ action: 'list' }).messages.filter(m => m.kind === 'question')).toHaveLength(1);
  f.agents[1]!.accountId = 'replacement';
  expect(f.service.rooms.allowed(binding, m)).toBe(false);
  expect(f.service.rooms.roster(binding).room).toEqual(['dev']);
  f.agents[0]!.assignments = [];
  await f.service.tick(); expect(f.sent).toHaveLength(0);
});
test('offline and busy workers retain queued requests; unknown acknowledgements are never replayed', async () => {
  const f = fixture(); f.send('goal'); f.details.busy = true;
  await f.service.tick(); expect(f.sent).toHaveLength(0);
  f.details.busy = false; f.uncertain(); await f.service.tick();
  expect(f.request({ action: 'list' }).messages[0]?.status).toBe('unknown');
  const restarted = createAgentChats(f.options); await restarted.tick(); await restarted.tick();
  expect(f.sent).toHaveLength(1);
});
test('interrupted host delivery reconciles an acknowledged task without sending it twice', async () => {
  const f = fixture(); f.send('goal'); await f.service.tick();
  const journal = JSON.parse(readFileSync(f.filename, 'utf8')); journal.jobs[0].state = 'sending';
  writeFileSync(f.filename, JSON.stringify(journal));
  const restarted = createAgentChats(f.options); await restarted.tick();
  expect(f.sent).toHaveLength(1);
  expect(restarted.request(f.workspace, { action: 'list' }).messages[0]?.status).toBe('waiting');
});
test('corrupt scope records fail closed without replacing the journal', () => {
  const f = fixture(); const original = '{broken'; writeFileSync(f.filename, original);
  expect(() => new ChatsStore(f.filename)).toThrow();
  expect(readFileSync(f.filename, 'utf8')).toBe(original);
});

test('invitation is additive and permits the newly invited collaborator without broadening other rooms', () => {
  const f = fixture(); f.send('goal');
  const taskId = f.request({ action: 'list' }).messages[0]!.taskId!;
  const binding = bindingFor(f.workspace, 'docker:test', 'dev', 'account-0');
  f.request({ action: 'invite', roomId: 'room', members: ['dev', 'planner', 'outside'], defaultAgentId: 'planner' });
  expect(f.service.rooms.allowed(binding, { id: 'q', questionId: 'q', taskId, from: 'dev', to: 'outside', roomId: 'room', kind: 'question', text: 'Help' })).toBe(true);
  expect(() => f.request({ action: 'invite', roomId: 'room', members: ['dev'], defaultAgentId: 'dev' })).toThrow('retained');
  const next = f.send('normal', { goal: false });
  expect(next.messages.find(m => m.id === 'normal')?.recipient).toBe('planner');
});

test('discussion after completion does not reopen the verified goal, including a send/completion race', async () => {
  const f = fixture(); f.send('goal'); await f.service.tick();
  f.send('late', { threadId: 'goal', goal: false, text: 'Explain the result' });
  f.details.tasks[0]!.status = 'completed';
  await f.service.tick(); await f.service.tick();
  expect(f.sent).toHaveLength(2);
  expect(f.sent[1]?.input).toBeUndefined();
  expect(f.sent[1]?.task).not.toBe(f.sent[0]?.task);
  expect(f.sent[1]?.goal).toBe(false);
});
