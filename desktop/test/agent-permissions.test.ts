import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRegistry } from '../lib/agent-management/registry.mts';
import { createAgentChats } from '../lib/agent-chats/service.mts';
import { ChatsStore } from '../lib/agent-chats/store.mts';
import { recordRoomTasks } from '../lib/agent-chats/records.mts';
import { EXECUTION_PRESETS, parseSaveSpecialistAgent, projectPermissions } from '../shared/agent-registry.ts';
import { parseChatsRequest, parseChatsSnapshot, type AgentRoom, type RoomMessage } from '../shared/agent-chats.ts';
import { specialistInput } from './agent-registry-fixtures';
import type { AgentDetails } from '../shared/agent-management.ts';
const directories: string[] = [];
function temporary() { const p = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-permission-host-'))); directories.push(p); return p; }
afterEach(() => { for (const p of directories.splice(0)) rmSync(p, { recursive: true, force: true }); });
async function failure(operation: Promise<unknown>, message: string) {
  let error: unknown; try { await operation; } catch (e) { error = e; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(message);
}
test('creation presets persist project overrides, survive unrelated edits, and can restore inherited permissions', () => {
  const workspace = temporary(), registry = createAgentRegistry(join(workspace, 'registry.json'));
  const input = specialistInput(); input.profile.permissions = { ...EXECUTION_PRESETS.review };
  let agent = registry.save({ ...input, assignment: { ...input.assignment, permissions: EXECUTION_PRESETS.development } }, workspace).snapshot.agents[0]!;
  expect(projectPermissions(agent, workspace)).toEqual(EXECUTION_PRESETS.development);
  expect(projectPermissions(agent, '/other')).toEqual(EXECUTION_PRESETS.review);
  agent = registry.save({ ...input, id: agent.id, revision: agent.revision }, workspace).snapshot.agents[0]!;
  expect(projectPermissions(agent, workspace)).toEqual(EXECUTION_PRESETS.development);
  agent = registry.save({ ...input, id: agent.id, revision: agent.revision, assignment: { ...input.assignment, permissions: null } }, workspace).snapshot.agents[0]!;
  expect(projectPermissions(agent, workspace)).toEqual(EXECUTION_PRESETS.review);
  expect(() => parseSaveSpecialistAgent({ ...input, assignment: { ...input.assignment, permissions: { fileWrite: 'true', commandExecution: false } } })).toThrow();
});
test('Chats projects one durable permission card, binds decisions to the saved room identity and retains failures', async () => {
  const workspace = temporary(), filename = join(workspace, 'chats.json'), registry = createAgentRegistry(join(workspace, 'registry.json'));
  const input = specialistInput(); input.profile.accountId = 'default';
  const agent = registry.save(input, workspace).snapshot.agents[0]!;
  const room: AgentRoom = { id: 'room', name: 'Room', workspace, engineId: 'docker:test', defaultAgentId: agent.id,
    members: [{ id: agent.id, accountId: 'default', name: agent.name }], createdAt: new Date().toISOString() };
  const permission = { id: 'request', reason: 'Run tests', fileWrite: false, commandExecution: true, status: 'pending' as const };
  const details: AgentDetails = { agent: { id: 'container', name: 'Agent', image: 'worker', state: 'running' }, ready: true, authenticated: true, busy: false,
    error: null, logs: '', threadId: null, tasks: [{ id: 'task', prompt: 'Implement', status: 'waiting', roomId: room.id, createdAt: room.createdAt, output: '', error: null,
      inspection: { permissionRequest: permission, finishedAt: null, threadId: null, conversation: null, goal: null, messages: [], evidence: [], recall: null, error: null } }] };
  const messages: RoomMessage[] = [{ id: 'anchor', roomId: room.id, threadId: null, sender: 'user', recipient: agent.id, taskId: 'task', kind: 'message', text: 'Implement', createdAt: room.createdAt }];
  recordRoomTasks(messages, room, agent.id, details.tasks); recordRoomTasks(messages, room, agent.id, details.tasks);
  expect(messages.filter(m => m.kind === 'permission_request')).toHaveLength(1);
  const card = messages.find(m => m.kind === 'permission_request')!;
  const journal = new ChatsStore(filename); journal.update(s => { s.rooms.push(room); s.messages.push(...messages); });
  let blocked = true, calls = 0;
  const service = createAgentChats({ filename, registry: root => registry.snapshot(root), status: async () => ({ details }), dispatch: async () => ({ details }),
    permissions: async (_root, request) => {
      calls++; expect(request.accountId).toBe('default'); expect(request.request).toEqual(permission);
      if (blocked) throw new Error('Worker is busy');
      details.tasks[0]!.inspection!.permissionRequest = { ...permission, status: request.decision === 'allow' ? 'allowed' : 'denied' };
      return { details };
    } });
  const decision = { action: 'permission', roomId: room.id, messageId: card.id, decision: 'deny' };
  await failure(service.permissions(workspace, decision), 'busy');
  expect(new ChatsStore(filename).snapshot(workspace).messages.find(m => m.id === card.id)?.permissionRequest?.status).toBe('pending');
  await failure(service.permissions(temporary(), decision), 'Unknown room'); expect(calls).toBe(1);
  blocked = false;
  const result = parseChatsSnapshot(await service.permissions(workspace, decision));
  expect(result.messages.find(m => m.id === card.id)?.permissionRequest?.status).toBe('denied');
  expect(new ChatsStore(filename).snapshot(workspace).messages.find(m => m.id === card.id)?.permissionRequest?.status).toBe('denied');
  const current = registry.snapshot(workspace).agents[0]!;
  registry.save({ ...input, id: current.id, revision: current.revision, profile: { ...input.profile, accountId: null } }, workspace);
  await failure(service.permissions(workspace, decision), 'identity'); expect(calls).toBe(2);
  expect(() => parseChatsRequest({ ...decision, decision: true })).toThrow();
  await service.dispose();
});
