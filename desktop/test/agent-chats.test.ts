import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentChats } from '../lib/agent-chats/service.mts';
import { ChatsStore } from '../lib/agent-chats/store.mts';
import { bindingFor, type Message } from '../lib/agent-orchestration/mailbox.mts';
import { specialistAgent } from './agent-registry-fixtures';
import type { AgentDetails } from '../shared/agent-management';
import type { ChatsRequest } from '../shared/agent-chats';
import type { AgentRuntimeRequest } from '../shared/agent-runtime';
import { parseChatsRequest, parseChatsSnapshot } from '../shared/agent-chats';
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
  const send = (id: string, patch: Partial<Extract<ChatsRequest, { action: 'send' }>> = {}) => request({ action: 'send', id, roomId: 'room', threadId: null, recipient: 'dev', text: 'Build login', goal: true, ...patch });
  return { workspace, filename, agents, details, sent, options, service, request, send, uncertain: () => { uncertain = true; } };
}
test('pin requests require literal booleans and legacy rooms load unpinned', () => {
  const f = fixture();
  expect(parseChatsRequest({ action: 'pin', roomId: 'room', pinned: false })).toEqual({ action: 'pin', roomId: 'room', pinned: false });
  for (const pinned of [undefined, null, 0, 1, 'true', 'false', {}, []]) {
    expect(() => f.service.request(f.workspace, { action: 'pin', roomId: 'room', pinned })).toThrow('pin state');
  }
  const legacy = new ChatsStore(f.filename).snapshot(f.workspace);
  expect(legacy.rooms[0]?.pinned).toBe(false);
  expect(() => parseChatsSnapshot({ ...legacy, rooms: [{ ...legacy.rooms[0], pinned: 'true' }] })).toThrow('pin state');
});
test('pin persists across service and store reloads without delivery or same-value writes', async () => {
  const f = fixture(), pin = (pinned: boolean) => f.request({ action: 'pin', roomId: 'room', pinned });
  const before = f.request({ action: 'list' });
  let events = 0;
  const unsubscribe = f.service.subscribe(f.workspace, () => { events++; });
  expect(pin(false).cursor).toEqual(before.cursor); expect(events).toBe(0);
  const acknowledged = pin(true);
  expect(acknowledged.rooms[0]?.pinned).toBe(true); expect(events).toBe(1);
  const saved = readFileSync(f.filename, 'utf8'), modified = statSync(f.filename).mtimeMs;
  expect(pin(true)).toEqual(acknowledged); expect(events).toBe(1);
  expect(readFileSync(f.filename, 'utf8')).toBe(saved); expect(statSync(f.filename).mtimeMs).toBe(modified);
  const restarted = createAgentChats(f.options);
  expect(restarted.request(f.workspace, { action: 'list' }).rooms[0]?.pinned).toBe(true);
  expect(new ChatsStore(f.filename).snapshot(f.workspace).rooms[0]?.pinned).toBe(true);
  expect(pin(false).rooms[0]?.pinned).toBe(false);
  expect(new ChatsStore(f.filename).snapshot(f.workspace).rooms[0]?.pinned).toBe(false);
  await f.service.tick(); expect(f.sent).toHaveLength(0);
  expect(f.request({ action: 'list' }).messages).toEqual(before.messages);
  expect(f.request({ action: 'list' }).rooms[0]?.members).toEqual(before.rooms[0]?.members);
  unsubscribe();
});
test('pin rejects foreign and missing rooms and preserves memory and journal on storage failure', () => {
  const f = fixture(), before = readFileSync(f.filename, 'utf8');
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-chats-pin-other-'))); directories.push(other);
  expect(() => f.service.request(other, { action: 'pin', roomId: 'room', pinned: true })).toThrow('project');
  expect(() => f.request({ action: 'pin', roomId: 'missing', pinned: true })).toThrow('project');
  mkdirSync(`${f.filename}.tmp`);
  expect(() => f.request({ action: 'pin', roomId: 'room', pinned: true })).toThrow();
  expect(f.request({ action: 'list' }).rooms[0]?.pinned).not.toBe(true);
  expect(readFileSync(f.filename, 'utf8')).toBe(before);
  expect(new ChatsStore(f.filename).snapshot(f.workspace).rooms[0]?.pinned).toBe(false);
});
test('unaddressed room messages persist without jobs, worker wakes or model requests', async () => {
  const f = fixture(); let wakes = 0;
  const service = createAgentChats({ ...f.options, wake: async () => { wakes++; return { details: f.details }; } });
  const input = { action: 'send', id: 'note', roomId: 'room', threadId: null, recipient: null, text: 'Hello everyone', goal: false, automatic: true } as const;
  service.request(f.workspace, input); service.request(f.workspace, input);
  await service.tick();
  expect(wakes).toBe(0); expect(f.sent).toHaveLength(0);
  const persisted = new ChatsStore(f.filename);
  expect(persisted.all().jobs).toHaveLength(0);
  expect(persisted.snapshot(f.workspace).messages).toMatchObject([{ id: 'note', recipient: null, text: 'Hello everyone' }]);
  expect(persisted.all().messages[0]?.taskId).toBeUndefined();
  expect(() => service.request(f.workspace, { ...input, recipient: 'dev' })).toThrow('identity');
});
test.each(['@planner Build login', 'planner 호출해서 로그인 만들어줘'])('calls only the addressed participant: %s', async text => {
  const f = fixture();
  f.send('call', { recipient: null, text, goal: false, automatic: true }); await f.service.tick();
  expect(f.sent).toMatchObject([{ agent: 'planner' }]);
  expect(f.details.tasks[0]?.prompt).toContain('request_work for bounded implementation');
  expect(f.details.tasks[0]?.prompt).toContain('If the user requests planning only, stop at planning');
  expect(f.details.tasks[0]?.prompt).toContain('not routine handoffs already covered by the request');
  expect(() => f.send('mismatch', { recipient: 'dev', text, goal: false })).toThrow('does not match');
});
test('reply to a directed user message retains its recipient; unknown calls never use the default', async () => {
  const f = fixture(); f.send('initial', { recipient: 'planner', goal: false });
  f.send('reply', { recipient: null, replyTo: 'initial', text: 'Use email', goal: false });
  expect(new ChatsStore(f.filename).all().jobs.map(j => j.agentId)).toEqual(['planner', 'planner']);
  expect(() => f.send('unknown', { recipient: null, text: '@stranger do it', goal: false })).toThrow('exact name');
  expect(() => f.send('no-target', { recipient: null })).toThrow('Choose a recipient');
});
test('application inspection routes only the existing owner and preserves queued work without automatic dispatch', async () => {
  const f = fixture(); f.send('goal'); await f.service.tick();
  f.details.tasks[0]!.status = 'interrupted';
  f.send('queued', { threadId: 'goal', goal: false });
  const calls: AgentRuntimeRequest[] = [];
  const service = createAgentChats({ ...f.options, recover: async (_workspace, request) => { calls.push(request); return { details: f.details }; } });
  const input = { action: 'application-inspect' as const, roomId: 'room', goalId: 'goal', candidateId: 'a'.repeat(64), hash: 'b'.repeat(64) };
  const result = await service.inspectApplication(f.workspace, input);
  expect(calls).toEqual([{ action: 'application-inspect', agentId: 'dev', engineId: 'docker:test', roomId: 'room',
    taskId: f.sent[0]!.task, candidateId: input.candidateId, hash: input.hash }]);
  expect(f.sent).toHaveLength(1); expect(result.messages.find(m => m.id === 'queued')?.status).toBe('queued');
  f.agents[0]!.accountId = 'replacement';
  let error: unknown;
  try { await service.inspectApplication(f.workspace, input); } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(Error); expect(calls).toHaveLength(1);
});
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
test('queued guidance follows worker availability and clears after a single dispatch', async () => {
  const f = fixture(); f.send('goal'); f.details.busy = true;
  const message = () => f.request({ action: 'list' }).messages[0]!;
  await f.service.tick();
  expect(message().status).toBe('queued');
  expect(message().error).toContain('when the current task finishes');
  expect(message().error).not.toContain('start the participant');
  f.details.ready = false; await f.service.tick();
  expect(message().error).toContain('Waiting for an available worker');
  f.details.ready = true; await f.service.tick();
  expect(message().error).toContain('when the current task finishes');
  expect(f.sent).toHaveLength(0);
  f.details.busy = false; await f.service.tick(); await f.service.tick();
  expect(f.sent).toHaveLength(1);
  expect(message().status).toBe('waiting'); expect(message().error).toBeNull();
});
test('authentication, runtime errors and unknown executions do not show busy guidance', async () => {
  const f = fixture(); f.send('goal'); f.details.busy = true;
  const message = () => f.request({ action: 'list' }).messages[0]!;
  f.details.authenticated = false; await f.service.tick();
  expect(message().error).toContain('worker authentication');
  f.details.authenticated = true; f.details.error = 'Worker connection lost'; await f.service.tick();
  expect(message().error).toBe('Worker connection lost');
  f.details.error = null;
  f.details.tasks.push({ id: 'uncertain', prompt: 'Earlier request', status: 'unknown', createdAt: new Date().toISOString(), output: '', error: null });
  await f.service.tick();
  expect(message().error).toContain('Execution outcome is unknown');
  expect(f.sent).toHaveLength(0); expect(message().status).toBe('queued');
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
  const next = f.send('normal', { goal: false, recipient: 'planner' });
  expect(next.messages.find(m => m.id === 'normal')?.recipient).toBe('planner');
});

test.each(['deleted', 'unassigned', 'account-replaced'])('inviting after a participant is %s preserves history without transferring its identity', async reason => {
  const f = fixture(); f.send('goal');
  const before = f.request({ action: 'list' });
  const original = structuredClone(f.agents[1]!);
  const binding = bindingFor(f.workspace, 'docker:test', 'dev', 'account-0');
  const message: Message = { id: 'q', questionId: 'q', taskId: before.messages[0]!.taskId!, from: 'dev', to: 'planner', roomId: 'room', kind: 'question', text: 'Help' };
  if (reason === 'deleted') f.agents.splice(1, 1);
  else if (reason === 'unassigned') f.agents[1]!.assignments = [];
  else { f.agents[1]!.accountId = 'replacement'; f.agents[1]!.name = 'Replacement'; }

  const after = f.request({ action: 'invite', roomId: 'room', members: ['dev', 'planner', 'outside'], defaultAgentId: 'outside' });
  expect(after.rooms[0]!.members.slice(0, 2)).toEqual(before.rooms[0]!.members);
  expect(after.messages).toEqual(before.messages);
  expect(after.rooms[0]!.defaultAgentId).toBe('outside');
  expect(f.service.rooms.allowed(binding, message)).toBe(false);
  expect(f.service.rooms.allowed(binding, { ...message, to: 'outside' })).toBe(true);
  expect(() => f.send('unavailable', { recipient: 'planner' })).toThrow('participant');
  expect(() => f.request({ action: 'invite', roomId: 'room', members: ['dev', 'planner', 'outside'], defaultAgentId: 'planner' })).toThrow('identity is unavailable');
  expect(f.request({ action: 'list' })).toEqual(after);
  f.send('new-member', { goal: false, recipient: 'outside' }); await f.service.tick();
  expect(f.sent.some(s => s.agent === 'outside')).toBe(true);

  const index = f.agents.findIndex(a => a.id === original.id);
  if (index < 0) f.agents.push(original); else f.agents[index] = original;
  f.request({ action: 'invite', roomId: 'room', members: ['dev', 'planner', 'outside'], defaultAgentId: 'planner' });
  expect(f.service.rooms.allowed(binding, message)).toBe(true);
});

test('unknown new invitees are rejected without changing saved membership', () => {
  const f = fixture(), before = f.request({ action: 'list' });
  expect(() => f.request({ action: 'invite', roomId: 'room', members: ['dev', 'planner', 'unknown'], defaultAgentId: 'dev' })).toThrow('registered agent');
  expect(f.request({ action: 'list' })).toEqual(before);
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

async function blockedFixture() {
  const f = fixture(); f.send('goal'); await f.service.tick();
  const task = f.details.tasks[0]!;
  task.status = 'interrupted'; task.error = 'Which sign-in method?';
  task.inspection = { finishedAt: null, threadId: 'native-thread', conversation: task.id, messages: [], evidence: [], recall: [], error: null,
    goal: { phase: 'blocked', turns: 2, verificationRequired: true, criteria: [{ criterion: 'Login works', met: false, evidence: '' }], pending: null,
      decisions: [{ action: 'blocked', progress: 'Requirements reviewed', reason: 'Which sign-in method?', nextAction: 'Provide the sign-in method', criteria: [] }] } };
  await f.service.tick();
  return { ...f, task };
}

test('integration metadata and later stale checks survive Chats projection and restart', async () => {
  const f = await blockedFixture();
  const integration = { version: 1 as const, id: 'a'.repeat(64), taskId: f.task.id, roomId: 'room', requestIds: ['b'.repeat(64)],
    status: 'prepared' as const, candidateHash: 'c'.repeat(64), files: [{ path: 'login.ts', before: null, sha256: 'd'.repeat(64) }], issues: [],
    createdAt: '2026-10-04T00:00:00Z', checkedAt: '2026-10-04T00:00:00Z' };
  f.task.inspection!.integration = integration;
  await f.service.tick();
  expect(parseChatsSnapshot(f.request({ action: 'list' })).messages[0]?.goalProgress?.integration).toEqual(integration);
  const restarted = createAgentChats(f.options);
  expect(restarted.request(f.workspace, { action: 'list' }).messages[0]?.goalProgress?.integration).toBeUndefined();
  await restarted.tick();
  expect(restarted.request(f.workspace, { action: 'list' }).messages[0]?.goalProgress?.integration?.id).toBe(integration.id);
  f.task.inspection!.integration = { ...integration, status: 'stale', issues: [{ kind: 'source_changed', path: 'login.ts', requestIds: integration.requestIds }] };
  await restarted.tick();
  expect(parseChatsSnapshot(restarted.request(f.workspace, { action: 'list' })).messages[0]?.goalProgress?.integration?.status).toBe('stale');
});

test('blocked goal recovery retains task identity and evidence, deduplicates delivery, and refreshes after restart', async () => {
  const f = await blockedFixture(), before = structuredClone(f.task.inspection);
  const state = parseChatsSnapshot(f.request({ action: 'list' }));
  expect(state.messages[0]?.goalProgress).toMatchObject({ phase: 'blocked', turns: 2,
    reason: 'Which sign-in method?', progress: 'Requirements reviewed', nextAction: 'Provide the sign-in method', resumeBlocked: null });
  const followup = { action: 'send', id: 'answer', roomId: 'room', threadId: 'goal', recipient: 'dev', text: 'Use email', goal: false } as const;
  f.request(followup); f.request(followup);
  expect(() => f.request({ ...followup, id: 'double' })).toThrow('pending');
  const restarted = createAgentChats(f.options);
  expect(restarted.request(f.workspace, { action: 'list' }).messages[0]?.goalProgress?.resumeBlocked).not.toBeNull();
  await restarted.tick(); await restarted.tick();
  restarted.request(f.workspace, followup); await restarted.tick();
  expect(f.sent.filter(s => s.input === 'answer')).toEqual([{ agent: 'dev', task: f.task.id, room: 'room', input: 'answer', goal: false }]);
  expect(f.task.inspection).toEqual(before);
  expect(f.task.inputs).toEqual([{ id: 'answer', prompt: 'Use email' }]);
});

test.each(['unknown', 'offline', 'unavailable'])('blocked recovery rejects %s without saving or dispatching new work', async reason => {
  const f = await blockedFixture();
  if (reason === 'unknown') f.task.status = 'unknown';
  if (reason === 'offline') f.details.ready = false;
  if (reason === 'unavailable') f.agents[0]!.assignments = [];
  await f.service.tick();
  const state = f.request({ action: 'list' });
  expect(state.messages[0]?.goalProgress?.resumeBlocked).not.toBeNull();
  expect(() => f.send('resume', { threadId: 'goal', goal: false })).toThrow();
  expect(f.request({ action: 'list' }).messages).toHaveLength(1);
  expect(f.sent).toHaveLength(1);
});

test('dispatch rechecks unknown after an eligible recovery was queued', async () => {
  const f = await blockedFixture();
  f.send('resume', { threadId: 'goal', goal: false });
  f.task.status = 'unknown';
  await f.service.tick(); await f.service.tick();
  expect(f.sent).toHaveLength(1);
  expect(f.request({ action: 'list' }).messages.find(m => m.id === 'resume')?.error).toBeTruthy();
});

test('an offline blocked goal becomes resumable after the worker recovers', async () => {
  const f = await blockedFixture(); f.details.ready = false; await f.service.tick();
  expect(f.request({ action: 'list' }).messages[0]?.goalProgress?.resumeBlocked).toContain('available worker');
  f.details.ready = true; await f.service.tick();
  expect(f.request({ action: 'list' }).messages[0]?.goalProgress?.resumeBlocked).toBeNull();
  f.send('resume', { threadId: 'goal', goal: false }); await f.service.tick();
  expect(f.sent).toHaveLength(2);
});
test('blocked goal resume guidance distinguishes a busy worker and clears when idle', async () => {
  const f = await blockedFixture(); f.details.busy = true; await f.service.tick();
  const guidance = () => f.request({ action: 'list' }).messages[0]?.goalProgress?.resumeBlocked;
  expect(guidance()).toContain('Wait for the current task to finish before resuming');
  expect(guidance()).not.toContain('start the participant');
  expect(() => f.send('resume', { threadId: 'goal', goal: false })).toThrow('current task');
  expect(f.sent).toHaveLength(1);
  f.details.busy = false; await f.service.tick();
  expect(guidance()).toBeNull();
  f.send('resume', { threadId: 'goal', goal: false }); await f.service.tick();
  expect(f.sent).toHaveLength(2);
});

test('a restarted host requires a fresh worker observation before accepting blocked recovery', async () => {
  const f = await blockedFixture(), restarted = createAgentChats(f.options);
  const request = { action: 'send', id: 'resume', roomId: 'room', threadId: 'goal', recipient: 'dev', text: 'Use email', goal: false } as const;
  expect(() => restarted.request(f.workspace, request)).toThrow('Checking');
  await restarted.tick();
  restarted.request(f.workspace, request); await restarted.tick();
  expect(f.sent).toHaveLength(2);
});

test('goal summaries preserve compatibility and reject malformed turn counts and recovery flags', async () => {
  const f = await blockedFixture(), data = f.request({ action: 'list' });
  const raw = structuredClone(data) as unknown as { messages: { goalProgress: { turns: unknown; resumeBlocked: unknown } }[] };
  raw.messages[0]!.goalProgress.turns = '2';
  expect(() => parseChatsSnapshot(raw)).toThrow('turns');
  raw.messages[0]!.goalProgress.turns = 2; raw.messages[0]!.goalProgress.resumeBlocked = false;
  expect(() => parseChatsSnapshot(raw)).toThrow();
  delete data.messages[0]!.goalProgress;
  expect(parseChatsSnapshot(data).messages[0]?.goalProgress).toBeUndefined();
});

async function rejectsWith(operation: Promise<unknown>, message: string) {
  let error: unknown; try { await operation; } catch (e) { error = e; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(message);
}

test('question controls bind the original goal and participant identity and refresh durable question state', async () => {
  const f = await blockedFixture();
  f.task.status = 'waiting'; f.task.inspection!.goal!.phase = 'waiting'; f.task.error = null;
  const q = { id: 'question', kind: 'question' as const, from: 'dev', to: 'planner', fromName: 'dev', toName: 'planner', questionId: 'question',
    text: 'Which credentials?', delivery: 'delivered' as const, request: null, verification: null };
  f.task.inspection!.messages = [q];
  const controls: import('../shared/agent-runtime').AgentRuntimeRequest[] = [];
  const options = { ...f.options, question: async (_workspace: string, input: import('../shared/agent-runtime').AgentRuntimeRequest) => {
    controls.push(input);
    if (!f.task.inspection!.messages.some(m => m.kind === 'question_closed')) f.task.inspection!.messages.push({ ...q, id: 'closed', kind: 'question_closed', text: 'Cancelled' });
    return { details: f.details };
  } };
  const service = createAgentChats(options); await service.tick();
  const input = { action: 'question', roomId: 'room', goalId: 'goal', questionId: q.id, recipient: null } as const;
  expect(service.request(f.workspace, { action: 'list' }).messages[0]?.goalProgress?.questions?.[0]?.status).toBe('waiting');
  await rejectsWith(service.question(f.workspace, { ...input, recipient: 'outside' }), 'identity');
  await rejectsWith(service.question(f.workspace, { ...input, roomId: 'foreign' }), 'Unknown room');
  await rejectsWith(service.question(f.workspace, { ...input, questionId: 'foreign' }), 'Unknown goal question');
  await rejectsWith(service.question(f.workspace, { ...input, recipient: 'dev' }), 'different invited');
  expect(controls).toHaveLength(0);
  const result = parseChatsSnapshot(await service.question(f.workspace, input));
  expect(controls).toEqual([{ action: 'question', agentId: 'dev', engineId: 'docker:test', taskId: f.task.id, roomId: 'room', questionId: q.id, recipient: null }]);
  expect(result.messages[0]?.goalProgress?.questions?.[0]).toMatchObject({ status: 'closed', closure: 'Cancelled' });
  const restarted = createAgentChats(options); await restarted.tick();
  expect(restarted.request(f.workspace, { action: 'list' }).messages[0]?.goalProgress?.questions?.[0]?.status).toBe('closed');
  f.agents[1]!.accountId = 'replacement-account';
  await rejectsWith(restarted.question(f.workspace, { ...input, recipient: 'planner' }), 'identity');
  expect(controls).toHaveLength(1);
});

test('execution inspection holds queued inputs across restart and requires a fresh explicit follow-up', async () => {
  const f = await blockedFixture();
  f.send('old-input', { threadId: 'goal', goal: false, text: 'Old follow-up' });
  f.task.status = 'unknown'; await f.service.tick();
  const before = structuredClone(f.task.inspection);
  const recoveries: unknown[] = [];
  const options = { ...f.options, recover: async (workspace: string, input: import('../shared/agent-runtime').AgentRuntimeRequest) => {
    recoveries.push({ workspace, input });
    f.task.status = 'interrupted';
    f.task.recovery = { threadId: 'native-thread', turnId: 'native-turn', status: 'completed', checkedAt: '2026-10-03T00:00:00Z' };
    f.task.responses = [{ id: 'recovered', text: 'Recovered output', status: 'interrupted' }];
    return { details: f.details };
  } };
  const service = createAgentChats(options);
  const result = await service.recover(f.workspace, { action: 'recover', roomId: 'room', goalId: 'goal' });
  expect(recoveries).toEqual([{ workspace: f.workspace, input: { action: 'recover', agentId: 'dev', engineId: 'docker:test', taskId: f.task.id, roomId: 'room' } }]);
  expect(parseChatsSnapshot(result).messages[0]?.goalProgress).toMatchObject({ phase: 'blocked', resumeBlocked: null, recovery: f.task.recovery });
  expect(result.messages.find(m => m.id === 'old-input')?.status).toBe('held');
  expect(result.messages.filter(m => m.text === 'Recovered output')).toHaveLength(1);
  expect(f.task.inspection).toEqual(before); expect(f.sent).toHaveLength(1);
  const restarted = createAgentChats(options); await restarted.tick();
  expect(f.sent).toHaveLength(1);
  restarted.request(f.workspace, { action: 'send', roomId: 'room', threadId: 'goal', id: 'new-input', recipient: 'dev', text: 'Reviewed, use email', goal: false });
  await restarted.tick();
  expect(f.sent).toHaveLength(2); expect(f.sent[1]?.input).toBe('new-input');
  expect(restarted.request(f.workspace, { action: 'list' }).messages.find(m => m.id === 'old-input')?.status).toBe('held');
});

test('failed inspection and identity changes cannot clear unknown or replay queued work', async () => {
  const f = await blockedFixture(); f.task.status = 'unknown'; await f.service.tick();
  let calls = 0;
  const service = createAgentChats({ ...f.options, recover: async () => { calls++; throw new Error('Native turn is still running'); } });
  const request = { action: 'recover', roomId: 'room', goalId: 'goal' };
  await rejectsWith(service.recover(f.workspace, request), 'still running');
  expect(service.request(f.workspace, { action: 'list' }).messages[0]?.status).toBe('unknown');
  await service.tick(); expect(f.sent).toHaveLength(1);
  f.agents[0]!.accountId = 'replacement';
  await rejectsWith(service.recover(f.workspace, request), 'identity');
  await rejectsWith(service.recover(f.workspace, { ...request, roomId: 'foreign' }), 'project');
  expect(calls).toBe(1);
});

test('deadline controls retain goal scope, publish acknowledged dates and distinguish expiry from cancellation', async () => {
  const f = await blockedFixture();
  f.task.status = 'waiting'; f.task.inspection!.goal!.phase = 'waiting'; f.task.error = null;
  const q = { id: 'question', kind: 'question' as const, from: 'dev', to: 'planner', fromName: 'dev', toName: 'planner', questionId: 'question',
    text: 'Which credentials?', delivery: 'delivered' as const, request: null, verification: null, expiresAt: null as string | null };
  f.task.inspection!.messages = [q];
  const calls: import('../shared/agent-runtime').AgentRuntimeRequest[] = [];
  const options = { ...f.options, question: async (_workspace: string, input: import('../shared/agent-runtime').AgentRuntimeRequest) => {
    calls.push(input); q.expiresAt = input.expiresAt ?? null; return { details: f.details };
  } };
  const service = createAgentChats(options); await service.tick();
  const input = { action: 'question-deadline', roomId: 'room', goalId: 'goal', questionId: q.id, expiresAt: '2099-01-01T00:00:00.000Z' } as const;
  await rejectsWith(service.question(f.workspace, { ...input, questionId: 'foreign' }), 'Unknown goal question');
  await rejectsWith(service.question(f.workspace, { ...input, roomId: 'foreign' }), 'Unknown room');
  await rejectsWith(service.question(f.workspace, { ...input, expiresAt: false }), 'deadline');
  expect(calls).toHaveLength(0);
  const result = parseChatsSnapshot(await service.question(f.workspace, input));
  expect(calls).toEqual([{ action: 'question-deadline', agentId: 'dev', engineId: 'docker:test', taskId: f.task.id, roomId: 'room', questionId: q.id, expiresAt: input.expiresAt }]);
  expect(result.messages[0]?.goalProgress?.questions?.[0]).toMatchObject({ status: 'waiting', expiresAt: input.expiresAt });
  await service.question(f.workspace, { ...input, expiresAt: null });
  expect(q.expiresAt).toBeNull();
  q.expiresAt = input.expiresAt;
  f.task.inspection!.messages.push({ ...q, id: 'expired', kind: 'question_closed', closureReason: 'expired', text: 'Question expired.' });
  f.task.status = 'interrupted'; f.task.inspection!.goal!.phase = 'blocked';
  const restarted = createAgentChats(options); await restarted.tick();
  expect(parseChatsSnapshot(restarted.request(f.workspace, { action: 'list' })).messages[0]?.goalProgress?.questions?.[0])
    .toMatchObject({ status: 'expired', expiresAt: input.expiresAt, closure: 'Question expired.' });
  const binding = bindingFor(f.workspace, 'docker:test', 'dev', 'account-0');
  const original: Message = { id: 'question', questionId: 'question', taskId: f.task.id, roomId: 'room', kind: 'question', from: 'dev', to: 'planner', text: 'Policy?' };
  restarted.rooms.record(binding, [original, { ...original, id: 'expired', kind: 'question_closed', closureReason: 'expired', text: 'Question expired.' },
    { ...original, id: 'late', kind: 'reply', from: 'planner', to: 'dev', text: 'Too late' }]);
  const messages = restarted.request(f.workspace, { action: 'list' }).messages;
  expect(messages.find(m => m.id === 'peer_question')?.status).toBe('expired');
  expect(messages.find(m => m.id === 'peer_late')?.status).toBe('late reply · not applied');
  f.agents[0]!.accountId = 'changed';
  await rejectsWith(restarted.question(f.workspace, input), 'identity');
  expect(calls).toHaveLength(2);
});


test('Chats permits follow-up at high turn counts and reports known usage without a budget', async () => {
  const f = await blockedFixture();
  f.task.inspection!.goal!.turns = 1001;
  f.task.inspection!.goal!.usage = { reportedThroughTurn: 5, inputTokens: 10, outputTokens: 5, totalTokens: 15 };
  await f.service.tick();
  const progress = parseChatsSnapshot(f.request({ action: 'list' })).messages[0]!.goalProgress!;
  expect(progress).toMatchObject({ turns: 1001, resumeBlocked: null, usage: { reportedThroughTurn: 5, totalTokens: 15 } });
  expect('turnLimit' in progress).toBe(false);
  f.send('resume', { threadId: 'goal', goal: false });
  f.task.inspection!.goal!.turns = 1002;
  await f.service.tick();
  expect(f.sent).toHaveLength(2);
});

test('automatic intake becomes a goal only after worker judgment; promotion and questions survive host restart', async () => {
  const f = fixture(); f.send('intake', { goal: false, automatic: true }); await f.service.tick();
  const task = f.details.tasks[0]!;
  task.inspection = { finishedAt: null, threadId: 'native', conversation: task.id, goal: null, messages: [], evidence: [], recall: null, error: null,
    dialogue: { userText: 'Build login', questions: [{ id: 'method', text: 'Email or social?', answer: null }], revisions: [] } };
  await f.service.tick();
  expect(f.request({ action: 'list' }).messages[0]?.kind).toBe('message');
  const answer = { goal: false, automatic: true as const, answerTo: 'intake', questionId: 'method', text: 'Email only' };
  f.send('answer', answer); f.send('answer', answer);
  expect(() => f.send('bad', { ...answer, recipient: 'planner' })).toThrow('recipient');
  await f.service.tick();
  expect(f.sent.filter(s => s.input === 'answer')).toHaveLength(1);
  task.inspection.goal = { turns: 0, phase: 'ready', verificationRequired: true, criteria: [{ criterion: 'Email login works', met: false, evidence: '' }], decisions: [], pending: null };
  task.inspection.dialogue!.objective = 'Email login';
  await f.service.tick();
  const saved = new ChatsStore(f.filename).snapshot(f.workspace);
  expect(saved.messages.find(m => m.id === 'intake')).toMatchObject({ kind: 'goal', dialogue: { objective: 'Email login' } });
  f.send('intake', { goal: false, automatic: true }); // A lost acknowledgement after promotion is still idempotent.
  expect(saved.messages.filter(m => m.id === 'intake')).toHaveLength(1);
});

test('automatic dispatch preserves source text, isolates the native conversation and sends the exact question identity', async () => {
  const f = fixture();
  const contexts: unknown[] = [];
  const service = createAgentChats({ ...f.options, dispatch: async (workspace, request, context) => {
    contexts.push(context); return f.options.dispatch(workspace, request, context);
  } });
  service.request(f.workspace, { action: 'send', id: 'auto', roomId: 'room', threadId: null, recipient: 'dev', text: 'Login please', goal: false, automatic: true });
  await service.tick();
  const task = f.details.tasks[0]!;
  expect(contexts[0]).toMatchObject({ automatic: true, userText: 'Login please', conversation: task.id, goal: false });
  task.inspection = { finishedAt: null, threadId: 'native', conversation: task.id, goal: null, messages: [], evidence: [], recall: null, error: null,
    dialogue: { userText: 'Login please', questions: [{ id: 'scope', text: 'Email only?', answer: null }], revisions: [] } };
  await service.tick();
  service.request(f.workspace, { action: 'send', id: 'answer', roomId: 'room', threadId: null, recipient: null, text: 'Yes', goal: false, automatic: true, answerTo: 'auto', questionId: 'scope' });
  await service.tick();
  expect(contexts[1]).toMatchObject({ inputId: 'answer', questionId: 'scope', conversation: task.id });
});

test('queued room work wakes its recipient, newly invited peers are discoverable without startup, and retry preserves the task identity', async () => {
  const f = fixture(), wakes: { agent: string; retry: boolean }[] = [];
  let unavailable = true;
  const service = createAgentChats({ ...f.options, wake: async (_workspace, input, retry) => {
    wakes.push({ agent: input.agentId, retry: retry === true });
    if (unavailable) throw new Error('Engine unavailable');
    return { details: f.details };
  } });
  expect(service.rooms.bindings().map(b => b.agentId)).toEqual(['dev', 'planner']);
  expect(wakes).toHaveLength(0); service.request(f.workspace, { action: 'send', id: 'wake', roomId: 'room', threadId: null, recipient: 'dev', text: 'Build login', goal: true });
  await service.tick(); expect(f.sent).toHaveLength(0);
  const queued = service.request(f.workspace, { action: 'list' }).messages.find(m => m.id === 'wake')!;
  expect(queued.status).toBe('queued'); expect(queued.error).toBe('Engine unavailable');
  unavailable = false;
  await service.retry(f.workspace, { action: 'retry', roomId: 'room', messageId: 'wake' });
  await service.tick(); expect(f.sent).toHaveLength(1); expect(f.sent[0]?.task).toBe(queued.taskId);
  expect(wakes.some(w => w.retry)).toBe(true); expect(wakes.every(w => w.agent === 'dev')).toBe(true);
  let failure: unknown;
  try { await service.retry(f.workspace, { action: 'retry', roomId: 'room', messageId: 'wake' }); } catch (e) { failure = e; }
  expect((failure as Error).message).toContain('Only a queued');
});
test('unknown delivery never wakes or resends its saved job', async () => {
  const f = fixture(); f.uncertain(); f.send('uncertain'); await f.service.tick();
  let wakes = 0;
  const service = createAgentChats({ ...f.options, wake: async () => { wakes++; return { details: f.details }; } });
  await service.tick(); expect(wakes).toBe(0); expect(f.sent).toHaveLength(1);
});

test('started Chats delivers on request and worker events without periodic reads or duplicate submission', async () => {
  const f = fixture(); let reads = 0;
  const service = createAgentChats({ ...f.options, status: async () => { reads++; return { details: f.details }; } });
  const events: import('../shared/agent-chats').ChatsUpdate[] = [];
  const unsubscribe = service.subscribe(f.workspace, event => events.push(event));
  service.request(f.workspace, { action: 'list' });
  service.start(); await service.settled();
  try {
    service.request(f.workspace, { action: 'send', id: 'event-task', roomId: 'room', recipient: 'dev', threadId: null, text: 'Login', goal: false });
    await service.settled();
    expect(f.sent).toHaveLength(1);
    f.details.tasks[0]!.status = 'completed';
    f.details.tasks[0]!.responses = [{ id: 'answer', text: 'Login complete', status: 'completed' }];
    service.changed(bindingFor(f.workspace, 'docker:test', 'dev', 'account-0')); await service.settled();
    const saved = service.request(f.workspace, { action: 'list' });
    expect(saved.messages.some(m => m.text === 'Login complete')).toBe(true);
    expect(events.some(e => e.messages.some(m => m.text === 'Login complete'))).toBe(true);
    const settledReads = reads;
    // Exceed the old polling interval: an idle room performs no backend status reads.
    await new Promise(resolve => setTimeout(resolve, 3100));
    expect(reads).toBe(settledReads); expect(f.sent).toHaveLength(1);
  } finally { unsubscribe(); await service.dispose(); }
});

test('room execution timeline retains real timestamps, updates entries, suppresses duplicate finals and survives restart', async () => {
  const f = fixture(); f.send('goal'); await f.service.tick();
  const task = f.details.tasks[0]!;
  task.inspection = { finishedAt: null, threadId: 'native', conversation: 'task', goal: null, messages: [], evidence: [], recall: null, error: null,
    activity: [{ id: 'command', turnId: 'turn', kind: 'command', title: 'bun test', text: '', status: 'running', createdAt: '2026-10-05T01:00:00Z', final: false, truncated: false }] };
  await f.service.tick();
  const initial = f.request({ action: 'list' }).messages.find(m => m.activity)!;
  task.inspection.activity![0] = { ...task.inspection.activity![0]!, status: 'failed', text: 'Test failed' };
  task.inspection.activity!.push({ id: 'final', turnId: 'turn', kind: 'message', title: '', text: 'Fixing test', status: 'completed', createdAt: '2026-10-05T01:01:00Z', final: true, truncated: false });
  task.responses = [{ id: 'response_1', text: 'Fixing test', status: 'waiting' }];
  await f.service.tick(); await f.service.tick();
  const messages = f.request({ action: 'list' }).messages;
  expect(messages.find(m => m.id === initial.id)).toMatchObject({ createdAt: initial.createdAt, activity: { status: 'failed', text: 'Test failed' } });
  expect(messages.filter(m => m.text === 'Fixing test')).toHaveLength(1);
  const restarted = createAgentChats(f.options);
  const recovered = parseChatsSnapshot(restarted.request(f.workspace, { action: 'list' }));
  expect(recovered.messages.filter(m => m.activity)).toHaveLength(2);
  expect(recovered.messages.find(m => m.id === 'goal')?.inspection?.activity).toEqual([]);
});

test('peer worker execution is projected only into its invited room and unknown work is inspected inline', async () => {
  const f = fixture(); f.send('goal'); await f.service.tick();
  const taskId = f.details.tasks[0]!.id;
  const binding = bindingFor(f.workspace, 'docker:test', 'dev', 'account-0');
  f.service.rooms.record(binding, [{ id: 'question', kind: 'question', from: 'dev', to: 'planner', taskId, questionId: 'question', text: 'Plan login', roomId: 'room' }]);
  const peerTask = { id: 'q_question', roomId: 'room', prompt: 'Plan login', status: 'unknown', createdAt: '2026-10-05', output: '', error: null,
    inspection: { recoveryRoomId: 'room', recoveryKind: 'consultation' as const, finishedAt: null, threadId: 'native', conversation: 'question', goal: null, messages: [], evidence: [], recall: null, error: null,
      activity: [{ id: 'tool', turnId: 'turn', kind: 'command' as const, title: 'Read plan', text: 'Login plan', status: 'completed' as const, createdAt: '2026-10-05T00:00:00Z', final: false, truncated: false }] } };
  const calls: AgentRuntimeRequest[] = [];
  const peer = { ...f.details, tasks: [peerTask, { ...peerTask, id: 'private', roomId: 'other-room' }] };
  const service = createAgentChats({ ...f.options, status: async (_workspace, request) => ({ details: request.agentId === 'planner' ? peer : f.details }),
    recover: async (_workspace, request) => { calls.push(request); peerTask.status = 'interrupted'; return { details: peer }; } });
  await service.tick();
  const messages = service.request(f.workspace, { action: 'list' }).messages;
  expect(messages.filter(m => m.activity).map(m => m.sender)).toEqual(['planner']);
  expect(messages.find(m => m.id === 'peer_question')?.executionStatus).toBe('unknown');
  await service.recover(f.workspace, { action: 'recover', roomId: 'room', goalId: 'peer_question' });
  expect(calls).toEqual([{ action: 'recover', roomId: 'room', agentId: 'planner', engineId: 'docker:test', taskId: 'q_question' }]);
  f.agents[1]!.accountId = 'replacement';
  let rejected = false;
  try { await service.recover(f.workspace, { action: 'recover', roomId: 'room', goalId: 'peer_question' }); } catch { rejected = true; }
  expect(rejected).toBe(true); expect(calls).toHaveLength(1);
});

test('reply keeps the exact message context and queues a correction to the running owner', async () => {
  const f = fixture(); f.send('goal'); await f.service.tick();
  const task = f.details.tasks[0]!;
  task.status = 'running';
  task.inspection = { finishedAt: null, threadId: 'native', conversation: task.id, goal: null, messages: [], evidence: [], recall: null, error: null,
    dialogue: { userText: 'Build login', questions: [], revisions: [] },
    activity: [{ id: 'progress', turnId: 'turn', kind: 'message', title: '', text: 'I will use browser storage.', status: 'completed', createdAt: '2026-10-05T01:00:00Z', final: false, truncated: false }] };
  f.details.busy = true; await f.service.tick();
  const progress = f.request({ action: 'list' }).messages.find(m => m.activity)!;
  f.send('correction', { goal: false, automatic: true, threadId: 'goal', replyTo: progress.id, text: 'Use server sessions.' });
  await f.service.tick();
  expect(f.sent.at(-1)).toMatchObject({ agent: 'dev', task: task.id, input: 'correction' });
  expect(task.inputs?.at(-1)?.prompt).toContain('I will use browser storage.');
  expect(task.inputs?.at(-1)?.prompt).toContain('Use server sessions.');
  expect(new ChatsStore(f.filename).snapshot(f.workspace).messages.find(m => m.id === 'correction')?.replyTo).toBe(progress.id);
  expect(() => f.send('correction', { goal: false, automatic: true, threadId: 'goal', replyTo: 'goal', text: 'Use server sessions.' })).toThrow('identity');
  expect(() => f.send('bad', { goal: false, replyTo: 'missing' })).toThrow('reply message');
});

test('user questions are durable chronological messages with a stable receipt and answer state', async () => {
  const f = fixture(); f.send('goal'); await f.service.tick();
  const task = f.details.tasks[0]!;
  task.inspection = { finishedAt: null, threadId: 'native', conversation: task.id, goal: null, messages: [], evidence: [], recall: null, error: null,
    dialogue: { userText: 'Build login', questions: [{ id: 'method', text: 'Email or social?', answer: null }], revisions: [] } };
  await f.service.tick();
  const first = f.request({ action: 'list' }).messages.find(m => m.userQuestion)!;
  expect(first).toMatchObject({ sender: 'dev', recipient: 'user', text: 'Email or social?', userQuestion: { rootId: 'goal', id: 'method', answered: false } });
  task.inspection.dialogue!.questions[0]!.answer = { id: 'answer', text: 'Email' };
  await f.service.tick();
  const saved = new ChatsStore(f.filename).snapshot(f.workspace).messages.filter(m => m.userQuestion);
  expect(saved).toHaveLength(1); expect(saved[0]).toMatchObject({ id: first.id, createdAt: first.createdAt, userQuestion: { answered: true } });
});
