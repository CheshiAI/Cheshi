import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentChats } from '../lib/agent-chats/service.mts';
import { ChatsStore } from '../lib/agent-chats/store.mts';
import { parseChatsRequest } from '../shared/agent-chats';
import type { AgentDetails } from '../shared/agent-management';
import { specialistAgent } from './agent-registry-fixtures';

const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function fixture() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-room-delete-'))); directories.push(workspace);
  const filename = join(workspace, 'chats.json');
  const agents = [{ ...specialistAgent(), id: 'dev', accountId: 'account', assignments: [{ workspaceRoot: workspace, instructions: '' }] }];
  const details: AgentDetails = { agent: { id: 'worker', name: 'Dev', state: 'running', image: 'worker' },
    ready: true, authenticated: true, busy: false, threadId: null, error: null, logs: '', tasks: [] };
  const options = { filename, registry: () => ({ workspaceRoot: workspace, agents }), status: async () => ({ details }),
    dispatch: async () => ({ details }) };
  const service = createAgentChats(options);
  for (const id of ['room', 'other']) {
    service.request(workspace, { action: 'create', id, name: id, engineId: 'docker:test', members: ['dev'], defaultAgentId: 'dev' });
    service.request(workspace, { action: 'send', id: `note-${id}`, roomId: id, threadId: null, recipient: null, text: id, goal: false });
  }
  const remove = () => service.deleteRoom(workspace, { action: 'delete', roomId: 'room' });
  const completed = () => {
    const saved = new ChatsStore(filename);
    saved.update(state => {
      state.messages.push({ id: 'work', roomId: 'room', threadId: null, sender: 'user', recipient: 'dev', kind: 'message',
        text: 'done', createdAt: new Date().toISOString(), taskId: 'task', status: 'completed' });
      state.jobs.push({ id: 'work', roomId: 'room', threadId: null, agentId: 'dev', taskId: 'task', prompt: 'done', goal: false, state: 'sent', error: null });
    });
    details.tasks.push({ id: 'task', roomId: 'room', prompt: 'done', status: 'completed', createdAt: new Date().toISOString(), output: 'done', error: null });
    return createAgentChats(options);
  };
  return { workspace, filename, agents, details, options, service, remove, completed };
}
async function fails(operation: Promise<unknown>, message?: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  if (message) expect((failure as Error).message).toContain(message);
}
test('delete removes only the selected room journal and reloads without changing profiles, files or audit tasks', async () => {
  const f = fixture(), service = f.completed();
  const before = service.request(f.workspace, { action: 'list' });
  const agents = structuredClone(f.agents), tasks = structuredClone(f.details.tasks);
  f.details.tasks.push({ ...tasks[0]!, id: 'other-task', roomId: 'other', status: 'running' });
  tasks.push(structuredClone(f.details.tasks[1]!));
  const projectFile = join(f.workspace, 'source.ts'); writeFileSync(projectFile, 'export const keep = true;');
  const result = await service.deleteRoom(f.workspace, { action: 'delete', roomId: 'room' });
  expect(result.rooms).toEqual(before.rooms.filter(room => room.id === 'other'));
  expect(result.messages).toEqual(before.messages.filter(message => message.roomId === 'other'));
  const saved = new ChatsStore(f.filename);
  expect(saved.all().jobs).toEqual([]);
  expect(saved.snapshot(f.workspace).rooms.map(room => room.id)).toEqual(['other']);
  expect(createAgentChats(f.options).request(f.workspace, { action: 'list' }).messages).toEqual(result.messages);
  expect(f.agents).toEqual(agents); expect(f.details.tasks).toEqual(tasks);
  expect(readFileSync(projectFile, 'utf8')).toBe('export const keep = true;');
});
test.each(['queued', 'sending', 'unknown'] as const)('delete blocks %s delivery and preserves the journal', async state => {
  const f = fixture();
  f.service.request(f.workspace, { action: 'send', id: 'work', roomId: 'room', threadId: null, recipient: 'dev', text: 'work', goal: false });
  const saved = new ChatsStore(f.filename); saved.update(s => { s.jobs[0]!.state = state; s.messages.find(m => m.id === 'work')!.status = state; });
  const service = createAgentChats(f.options); service.request(f.workspace, { action: 'list' });
  const before = readFileSync(f.filename, 'utf8');
  await fails(service.deleteRoom(f.workspace, { action: 'delete', roomId: 'room' }), 'pending or unresolved');
  expect(readFileSync(f.filename, 'utf8')).toBe(before);
});
test.each(['accepted', 'running', 'waiting', 'unknown'])('delete blocks worker %s including peer tasks', async status => {
  const f = fixture();
  f.details.tasks.push({ id: 'peer-task', roomId: 'room', prompt: 'peer work', status, output: '', error: null, createdAt: new Date().toISOString() });
  const before = readFileSync(f.filename, 'utf8');
  await fails(f.remove(), 'active or unresolved'); expect(readFileSync(f.filename, 'utf8')).toBe(before);
});
test('delete blocks pending worker inputs and missing execution evidence', async () => {
  const f = fixture(), service = f.completed();
  f.details.tasks[0]!.inputs = [{ id: 'follow-up', prompt: 'continue', pending: true }];
  await fails(service.deleteRoom(f.workspace, { action: 'delete', roomId: 'room' }), 'active or unresolved');
  f.details.tasks = [];
  await fails(service.deleteRoom(f.workspace, { action: 'delete', roomId: 'room' }), 'unavailable');
});
test('storage and status failures preserve the room and allow a safe retry', async () => {
  const f = fixture(), before = readFileSync(f.filename, 'utf8');
  f.details.error = 'worker offline'; await fails(f.remove(), 'unavailable'); f.details.error = null;
  mkdirSync(`${f.filename}.tmp`); await fails(f.remove());
  expect(readFileSync(f.filename, 'utf8')).toBe(before);
  expect(f.service.request(f.workspace, { action: 'list' }).rooms).toHaveLength(2);
  rmSync(`${f.filename}.tmp`, { recursive: true });
  expect((await f.remove()).rooms.map(room => room.id)).toEqual(['other']);
});
test('delete refuses unresolved peer references even when the worker omits their tasks', async () => {
  const f = fixture();
  const saved = new ChatsStore(f.filename);
  saved.update(state => { Object.assign(state.messages[0]!, { sender: 'dev', status: 'delivered', relatedTask: { agentId: 'dev', taskId: 'missing-peer' } }); });
  const service = createAgentChats(f.options);
  await fails(service.deleteRoom(f.workspace, { action: 'delete', roomId: 'room' }), 'unavailable');
  expect(new ChatsStore(f.filename).snapshot(f.workspace).rooms).toHaveLength(2);
});
test('delete rejects foreign rooms and blocks new sends and duplicate deletion during worker inspection', async () => {
  const f = fixture();
  const foreign = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-room-foreign-'))); directories.push(foreign);
  await fails(f.service.deleteRoom(foreign, { action: 'delete', roomId: 'room' }), 'project');
  await fails(f.service.deleteRoom(f.workspace, { action: 'delete', roomId: 'missing' }), 'project');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = createAgentChats({ ...f.options, status: async () => { await gate; return { details: f.details }; } });
  const removing = service.deleteRoom(f.workspace, { action: 'delete', roomId: 'room' });
  expect(() => service.request(f.workspace, { action: 'send', id: 'race', roomId: 'room', threadId: null, recipient: null, text: 'race', goal: false })).toThrow('deletion');
  await fails(service.deleteRoom(f.workspace, { action: 'delete', roomId: 'room' }), 'deletion');
  release(); expect((await removing).rooms.map(room => room.id)).toEqual(['other']);
  expect(parseChatsRequest({ action: 'delete', roomId: 'room' })).toEqual({ action: 'delete', roomId: 'room' });
  expect(() => parseChatsRequest({ action: 'delete', roomId: '../room' })).toThrow();
});
