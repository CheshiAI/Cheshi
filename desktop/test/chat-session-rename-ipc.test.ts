import { expect, test } from 'bun:test';
import type { IpcMainInvokeEvent } from 'electron';
import { registerCodexChatIpc } from '../lib/codex-chat-ipc.mts';
import type { CodexChatService } from '../lib/codex-chat-service.mts';

type Options = Parameters<typeof registerCodexChatIpc>[0];

test('rename IPC checks sender and mutation gate, routes to the owning catalog and publishes only acknowledged changes', async () => {
  const handlers = new Map<string, Parameters<Options['ipc']['handle']>[1]>();
  const calls: unknown[][] = [], events: unknown[] = [];
  let allowed = true, blocked = false, fail = false;
  const service = { conversations: { renameSession: async (id: unknown, title: unknown) => {
    calls.push(['rename', id, title]);
    if (fail) throw new Error('Provider failed');
    return { threadId: 'current-thread', title: 'Short title' };
  } }, emit: (event: unknown) => events.push(event) };
  registerCodexChatIpc({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); } },
    assertSender: () => { if (!allowed) throw new Error('Untrusted sender'); },
    service: (_event, contextId) => { calls.push(['service', contextId]); return service as unknown as CodexChatService; },
    deletion: { mutation: async (operation: () => unknown) => {
      if (blocked) throw new Error('Deletion pending');
      return operation();
    } } as Options['deletion'],
    savedTurns: { list: async () => [], save: async () => { throw new Error('unused'); }, delete: async () => ({ id: '' }) },
    prepareMessage: async () => { throw new Error('Renaming must not send a message'); },
  });
  const invoke = () => handlers.get('cheshi:rename-codex-chat-session')!({} as IpcMainInvokeEvent, 'old-thread', 'Short title', 'pane-b');
  const failure = async (message: string) => {
    let error: unknown;
    try { await invoke(); } catch (cause) { error = cause; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
  };
  allowed = false; await failure('Untrusted sender');
  allowed = true; blocked = true; await failure('Deletion pending');
  expect(calls).toEqual([]);
  blocked = false; fail = true; await failure('Provider failed');
  expect(events).toEqual([]);
  fail = false;
  expect(await invoke()).toEqual({ threadId: 'current-thread', title: 'Short title' });
  expect(calls.at(-2)).toEqual(['service', 'pane-b']);
  expect(events).toEqual([
    { type: 'session-title', threadId: 'current-thread', title: 'Short title' },
    { type: 'session-title', threadId: 'old-thread', title: 'Short title' },
    { type: 'sessions-changed' },
  ]);
});
