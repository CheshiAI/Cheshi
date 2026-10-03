import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerAgentChatsIpc } from '../lib/agent-chats/ipc.mts';
import { createAgentChatsApi } from '../lib/agent-chats-preload.cts';
import { AGENT_CHATS_CHANNEL } from '../shared/agent-chats.ts';

test('Chats bridge is confined to the owning workspace frame and validates requests before dispatch', async () => {
  const events = new EventEmitter(), mainFrame = {}, owner = { mainFrame, isDestroyed: () => false };
  const window = Object.assign(events, { webContents: owner }) as unknown as BrowserWindow;
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const calls: string[] = [];
  const registration = registerAgentChatsIpc({ window, workspaceRoot: '/project', ipc: {
    handle: (name, fn) => { handlers.set(name, fn); }, removeHandler: name => { handlers.delete(name); },
  }, service: {
    question: async root => { calls.push(root); return { rooms: [], messages: [] }; },
    recover: async root => { calls.push(root); return { rooms: [], messages: [] }; },
    request: root => { calls.push(root); return { rooms: [], messages: [] }; },
    rooms: { roster: () => ({}), allowed: () => false, record: () => {} }, tick: async () => {}, start: () => {}, dispose: async () => {},
  } });
  const handler = handlers.get(AGENT_CHATS_CHANNEL)!;
  const invoke = (sender: unknown, senderFrame: unknown, request: unknown) => handler({ sender, senderFrame } as IpcMainInvokeEvent, request);
  expect(() => invoke({}, mainFrame, { action: 'list' })).toThrow('workspace');
  expect(() => invoke(owner, {}, { action: 'list' })).toThrow('workspace');
  expect(() => invoke(owner, mainFrame, { action: 'send', goal: 'true' })).toThrow('Invalid');
  const api = createAgentChatsApi({ invoke: async (_channel: string, request: unknown) => invoke(owner, mainFrame, request) });
  expect(await api.request({ action: 'list' })).toEqual({ rooms: [], messages: [] });
  expect(calls).toEqual(['/project']);
  expect(await api.request({ action: 'recover', roomId: 'room', goalId: 'goal' })).toEqual({ rooms: [], messages: [] });
  expect(calls).toEqual(['/project', '/project']);
  expect(await api.request({ action: 'question', roomId: 'room', goalId: 'goal', questionId: 'question', recipient: null })).toEqual({ rooms: [], messages: [] });
  expect(calls).toHaveLength(3);
  expect(await api.request({ action: 'question-deadline', roomId: 'room', goalId: 'goal', questionId: 'question', expiresAt: null })).toEqual({ rooms: [], messages: [] });
  expect(calls).toHaveLength(4);
  registration.dispose();
  expect(handlers.size).toBe(0);
  expect(() => invoke(owner, mainFrame, { action: 'list' })).toThrow('workspace');
});
