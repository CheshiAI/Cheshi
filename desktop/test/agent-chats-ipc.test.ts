import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, IpcRenderer } from 'electron';
import { registerAgentChatsIpc } from '../lib/agent-chats/ipc.mts';
import { createAgentChatsApi } from '../lib/agent-chats-preload.cts';
import { AGENT_CHATS_CHANNEL, AGENT_CHATS_CHANGED, type ChatsUpdate } from '../shared/agent-chats.ts';

test('Chats bridge is confined to the owning workspace frame and validates requests before dispatch', async () => {
  const events = new EventEmitter(), renderer = new EventEmitter(), mainFrame = {};
  let destroyed = false, subscribed = '', removed = 0;
  let publish: (update: ChatsUpdate) => void = () => {};
  const owner = { mainFrame, isDestroyed: () => destroyed, send: (channel: string, value: unknown) => renderer.emit(channel, {}, value) };
  const window = Object.assign(events, { webContents: owner }) as unknown as BrowserWindow;
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const calls: string[] = [];
  const registration = registerAgentChatsIpc({ window, workspaceRoot: '/project', ipc: {
    handle: (name, fn) => { handlers.set(name, fn); }, removeHandler: name => { handlers.delete(name); },
  }, service: {
    inspectWorkspace: async root => { calls.push(`${root}/workspace`); return { rooms: [], messages: [] }; },
    openFile: async root => { calls.push(`${root}/open-file`); return { rooms: [], messages: [] }; },
    isolated: async root => { calls.push(`${root}/isolated`); return { rooms: [], messages: [] }; },
    isolatedSettled: async () => {},
    deleteRoom: async root => { calls.push(`${root}/delete`); return { rooms: [], messages: [] }; },
    settled: async () => {}, subscribe: (root, listener) => { subscribed = root; publish = listener; return () => { removed++; }; }, changed: () => {},
    permissions: async root => { calls.push(`${root}/permission`); return { rooms: [], messages: [] }; },
    prepareProject: async root => { calls.push(`${root}/project-setup`); return { rooms: [], messages: [] }; },
    retry: async root => { calls.push(`${root}/retry`); return { rooms: [], messages: [] }; },
    inspectApplication: async root => { calls.push(`${root}/application`); return { rooms: [], messages: [] }; },
    question: async root => { calls.push(root); return { rooms: [], messages: [] }; },
    recover: async root => { calls.push(root); return { rooms: [], messages: [] }; },
    request: root => { calls.push(root); return { rooms: [], messages: [] }; },
    rooms: { bindings: () => [], pending: () => false, roster: () => ({}), allowed: () => false, record: () => {} }, tick: async () => {}, start: () => {}, dispose: async () => {},
  } });
  const handler = handlers.get(AGENT_CHATS_CHANNEL)!;
  const invoke = (sender: unknown, senderFrame: unknown, request: unknown) => handler({ sender, senderFrame } as IpcMainInvokeEvent, request);
  expect(() => invoke({}, mainFrame, { action: 'list' })).toThrow('workspace');
  expect(() => invoke(owner, {}, { action: 'list' })).toThrow('workspace');
  expect(() => invoke(owner, mainFrame, { action: 'send', goal: 'true' })).toThrow('Invalid');
  const bridge = Object.assign(renderer, { invoke: async (_channel: string, request: unknown) => invoke(owner, mainFrame, request) });
  const api = createAgentChatsApi(bridge as unknown as Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>);
  const updates: ChatsUpdate[] = [], stop = api.onDidChange!(update => updates.push(update));
  const update = { cursor: { epoch: 'test', sequence: 1 }, rooms: [], messages: [], removedRoomIds: [], removedMessageIds: [] };
  expect(subscribed).toBe('/project'); publish(update); expect(updates).toEqual([update]);
  destroyed = true; publish(update); expect(updates).toHaveLength(1); destroyed = false;
  expect(() => renderer.emit(AGENT_CHATS_CHANGED, {}, { ...update, cursor: { epoch: 'test', sequence: -1 } })).toThrow();
  stop(); expect(renderer.listenerCount(AGENT_CHATS_CHANGED)).toBe(0);
  expect(await api.request({ action: 'list' })).toEqual({ rooms: [], messages: [] });
  expect(calls).toEqual(['/project']);
  expect(await api.request({ action: 'recover', roomId: 'room', goalId: 'goal' })).toEqual({ rooms: [], messages: [] });
  expect(calls).toEqual(['/project', '/project']);
  expect(await api.request({ action: 'question', roomId: 'room', goalId: 'goal', questionId: 'question', recipient: null })).toEqual({ rooms: [], messages: [] });
  expect(calls).toHaveLength(3);
  expect(await api.request({ action: 'question-deadline', roomId: 'room', goalId: 'goal', questionId: 'question', expiresAt: null })).toEqual({ rooms: [], messages: [] });
  expect(calls).toHaveLength(4);
  expect(() => invoke(owner, mainFrame, { action: 'application-inspect', roomId: 'room', goalId: 'goal', candidateId: '../bad', hash: 'b'.repeat(64) })).toThrow('identity');
  expect(await api.request({ action: 'application-inspect', roomId: 'room', goalId: 'goal', candidateId: 'a'.repeat(64), hash: 'b'.repeat(64) })).toEqual({ rooms: [], messages: [] });
  expect(calls.at(-1)).toBe('/project/application');
  expect(await api.request({ action: 'retry', roomId: 'room', messageId: 'queued' })).toEqual({ rooms: [], messages: [] });
  expect(calls.at(-1)).toBe('/project/retry');
  await api.request({ action: 'permission', roomId: 'room', messageId: 'pending', decision: 'deny' });
  expect(calls.at(-1)).toBe('/project/permission');
  await api.request({ action: 'project-setup', roomId: 'room' });
  expect(calls.at(-1)).toBe('/project/project-setup');
  await api.request({ action: 'isolated-submit', id: 'isolated', roomId: 'room', agentId: 'homie', prompt: 'Implement the requested change', scope: ['src/'], check: 'bun test' });
  expect(calls.at(-1)).toBe('/project/isolated');
  expect(() => invoke(owner, {}, { action: 'isolated-setup', roomId: 'room' })).toThrow('workspace');
  expect(() => invoke(owner, mainFrame, { action: 'isolated-submit', id: 'invalid', roomId: 'room', agentId: 'homie', prompt: 'Change', scope: ['../outside'], check: 'true' })).toThrow('Scope');
  await api.request({ action: 'delete', roomId: 'room' });
  expect(calls.at(-1)).toBe('/project/delete');
  await api.request({ action: 'open-file', roomId: 'room', messageId: 'reply', href: '/workspace/result.txt' });
  expect(calls.at(-1)).toBe('/project/open-file');
  for (const action of ['workspace-inspect', 'workspace-open'] as const) {
    await api.request({ action, roomId: 'room', messageId: 'reply' });
    expect(calls.at(-1)).toBe('/project/workspace');
    expect(() => invoke(owner, {}, { action, roomId: 'room', messageId: 'reply' })).toThrow('workspace');
    expect(() => invoke(owner, mainFrame, { action, roomId: 'room', messageId: '../escape' })).toThrow('Invalid agent ID');
  }
  expect(() => invoke(owner, {}, { action: 'open-file', roomId: 'room', messageId: 'reply', href: '/workspace/result.txt' })).toThrow('workspace');
  expect(() => invoke(owner, mainFrame, { action: 'open-file', roomId: 'room', messageId: 'reply', href: 'file:///etc/passwd' })).toThrow('file link');
  expect(() => invoke(owner, {}, { action: 'delete', roomId: 'room' })).toThrow('workspace');
  expect(() => invoke(owner, {}, { action: 'permission', roomId: 'room', messageId: 'pending', decision: 'allow' })).toThrow('workspace');
  events.emit('closed'); registration.dispose();
  expect(removed).toBe(1);
  expect(handlers.size).toBe(0);
  expect(() => invoke(owner, mainFrame, { action: 'list' })).toThrow('workspace');
});
