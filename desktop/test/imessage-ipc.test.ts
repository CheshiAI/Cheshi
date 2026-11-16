import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerIMessageIpc } from '../lib/imessage-ipc.mts';
import { createIMessageNotifications, type ChatNotification } from '../lib/imessage-notifications.mts';
import { createWorkspaceNotifications } from '../lib/workspace-notifications.mts';
import type { WorkspaceIpcScope } from '../lib/workspace-ipc-router.mts';
import { TemporaryChatClosedError, type TemporaryChatResult } from '../shared/temporary-chat';

function fixture() {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const ipc = { handle(channel: string, handler: Parameters<IpcMain['handle']>[1]) { handlers.set(channel, handler); },
    removeHandler(channel: string) { handlers.delete(channel); } };
  const owner = { mainFrame: {}, isDestroyed: () => false, send() {} };
  const window = Object.assign(new EventEmitter(), { webContents: owner }) as unknown as BrowserWindow;
  const event = { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent;
  const scope = { ipc } as unknown as WorkspaceIpcScope;
  const calls: ChatNotification[] = [];
  const workspace = createWorkspaceNotifications({ workspaceRoot: '/fixtures/workspace', scope,
    getParent: () => window, sink: { notify: event => { calls.push(event); } } });
  return { handlers, ipc, window, event, workspace, calls };
}

test('settings and queue IPC reject foreign windows, subframes and malformed queue state', async () => {
  const f = fixture();
  const service = createIMessageNotifications({ filename: '/nonexistent/imessage-test.json', platform: 'darwin',
    send: async () => { throw new Error('Unexpected send'); } });
  const registration = registerIMessageIpc({ window: f.window, ipc: f.ipc, service });
  try {
    const get = f.handlers.get('cheshi:imessage:get')!;
    expect(await get(f.event)).toMatchObject({ enabled: false });
    const queue = f.handlers.get('cheshi:imessage:queue')!;
    for (const handler of [get, queue]) {
      expect(() => handler({ ...f.event, senderFrame: {} } as IpcMainInvokeEvent)).toThrow(/owner/);
      expect(() => handler({ ...f.event, sender: {} } as IpcMainInvokeEvent)).toThrow(/owner/);
    }
    for (const count of [-1, 1.5, '1', NaN, 10001]) {
      expect(() => queue(f.event, { contextId: 'pane', threads: [{ threadId: 'thread', count }] })).toThrow();
    }
    queue(f.event, { contextId: 'pane', threads: [] });
  } finally { registration.dispose(); f.workspace.dispose(); await service.dispose(); }
  expect(f.handlers.size).toBe(0);
});

test('temporary windows notify independently and closing a window suppresses late completion', async () => {
  const f = fixture();
  let resolve!: (value: TemporaryChatResult) => void;
  const pending = new Promise<TemporaryChatResult>(done => { resolve = done; });
  const base = { models: async () => [], close: async () => {}, send: async (_request: unknown) => ({ text: 'Done', model: 'fixture' }) };
  const first = f.workspace.temporary(base);
  const second = f.workspace.temporary({ ...base, send: async () => pending });
  try {
    await first.send({});
    const sending = second.send({});
    await second.close(); resolve({ text: 'Late', model: 'fixture' }); await sending;
    await new Promise(done => setTimeout(done, 380));
    expect(f.calls).toEqual([{ kind: 'completed', workspace: 'workspace', conversation: 'Temporary chat' }]);
  } finally { await first.close(); await second.close(); f.workspace.dispose(); }
});

test('temporary failures notify while user closure stays silent', async () => {
  const f = fixture();
  try {
    for (const error of [new Error('Provider failed'), new TemporaryChatClosedError()]) {
      const service = f.workspace.temporary({ models: async () => [], close: async () => {}, send: async () => { throw error; } });
      let failure: unknown;
      try { await service.send({}); } catch (cause) { failure = cause; }
      expect(failure).toBe(error); await service.close();
    }
    expect(f.calls.map(event => event.kind)).toEqual(['failed']);
  } finally { f.workspace.dispose(); }
});
