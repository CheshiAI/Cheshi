import { expect, test } from 'bun:test';
import type { IpcMainInvokeEvent } from 'electron';
import { registerCodexChatIpc } from '../lib/codex-chat-ipc.mts';

type Options = Parameters<typeof registerCodexChatIpc>[0];
type Handler = Parameters<Options['ipc']['handle']>[1];
const event = { sender: { id: 1 } } as IpcMainInvokeEvent;

function fixture() {
  const handlers = new Map<string, Handler>();
  const calls: unknown[][] = [];
  let allowed = true;
  let removalFails = false;
  let deletionFails = false;
  // These injected services exercise only the search/delete IPC boundary.
  const options: Options = {
    ipc: { handle(channel, listener) { handlers.set(channel, listener); } },
    service(_event: IpcMainInvokeEvent, contextId: unknown) { calls.push(['service', contextId]); return {} as ReturnType<Options['service']>; },
    relays: {} as Options['relays'],
    savedTurns: { async list() { return []; }, async save() { throw new Error('Not used.'); }, async delete() { return { id: '' }; } },
    assertSender() { if (!allowed) throw new Error('Untrusted sender.'); },
    async prepareMessage() { throw new Error('Search must not prepare or send messages.'); },
    deletion: {
      async deleteSession(_service: ReturnType<Options['service']>, id: unknown) {
        calls.push(['delete', id]);
        if (deletionFails) throw new Error('Provider deletion failed.');
        return { threadIds: ['thread', 'fork'] };
      },
    } as Options['deletion'],
    historySearch: {
      async search(request: unknown) { calls.push(['search', request]); return { hits: [], total: 0, indexedSessions: 1, unavailableSessions: [] }; },
      async remove(ids: readonly string[]) { calls.push(['remove', ids]); if (removalFails) throw new Error('Disk unavailable.'); },
    },
  };
  registerCodexChatIpc(options);
  return { calls, invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args),
    deny: () => { allowed = false; }, failRemoval: () => { removalFails = true; }, failDeletion: () => { deletionFails = true; } };
}

async function failure(operation: () => unknown | Promise<unknown>, message: string) {
  let rejected: unknown;
  try { await operation(); } catch (error) { rejected = error; }
  expect(rejected).toBeInstanceOf(Error);
  expect((rejected as Error).message).toBe(message);
}

test('search authenticates the renderer and does not select or create a chat context', async () => {
  const f = fixture();
  const request = { query: 'error' };
  expect(await f.invoke('cheshi:search-codex-chat-history', request, 'pane')).toEqual({ hits: [], total: 0, indexedSessions: 1, unavailableSessions: [] });
  expect(f.calls).toEqual([['search', request]]);
  f.deny();
  await failure(() => f.invoke('cheshi:search-codex-chat-history', request, 'pane'), 'Untrusted sender.');
  expect(f.calls).toHaveLength(1);
});

test('successful conversation deletion removes every returned physical history from the index', async () => {
  const f = fixture();
  expect(await f.invoke('cheshi:delete-codex-chat-session', 'thread', 'pane')).toEqual({ threadIds: ['thread', 'fork'] });
  expect(f.calls).toEqual([['service', 'pane'], ['delete', 'thread'], ['remove', ['thread', 'fork']]]);
});

test('a cleanup failure preserves the confirmed deletion and returns a separate warning', async () => {
  const f = fixture();
  f.failRemoval();
  const result = await f.invoke('cheshi:delete-codex-chat-session', 'thread', 'pane');
  expect(result.threadIds).toEqual(['thread', 'fork']);
  expect(result.historySearchWarning).toContain('conversation was deleted');
});

test('a failed provider deletion never removes its searchable history', async () => {
  const f = fixture();
  f.failDeletion();
  await failure(() => f.invoke('cheshi:delete-codex-chat-session', 'thread', 'pane'), 'Provider deletion failed.');
  expect(f.calls).toEqual([['service', 'pane'], ['delete', 'thread']]);
});
