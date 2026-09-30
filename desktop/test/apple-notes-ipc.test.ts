import { expect, test } from 'bun:test';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerAppleNotesIpc } from '../lib/apple-notes-ipc.mts';
import { createAppleNotesApi } from '../lib/apple-notes-preload.cts';
import { AppleNotesService } from '../lib/apple-notes-service.mts';
import { appleNote, readAppleNotesReply } from '../shared/apple-notes.ts';
import type { NotesSearchResponse } from '../shared/apple-notes-search.ts';

async function expectFailure(operation: Promise<unknown>, message: RegExp) {
  try { await operation; }
  catch (error) { expect(error instanceof Error ? error.message : String(error)).toMatch(message); return; }
  throw new Error('Expected the operation to fail.');
}

test('search validates requests before IPC and rejects malformed indexed hits', async () => {
  const calls: unknown[][] = [];
  const result: NotesSearchResponse = { hits: [], folders: [], total: 0, nextOffset: null, version: '1',
    state: 'ready', completed: 0, pending: 0, error: null };
  let reply: unknown = { ok: true, value: result };
  const api = createAppleNotesApi({ invoke: async (...args: unknown[]) => { calls.push(args); return reply; } }, 'darwin');
  for (const request of [{ query: 'word', refresh: 'true' }, { query: 'word', offset: -1 }, { query: '\0' }]) {
    await expectFailure(api.search!(request as Parameters<NonNullable<typeof api.search>>[0]), /Invalid note search/);
  }
  expect(calls).toHaveLength(0);
  expect(await api.search!({ query: ' 읽기 ' })).toEqual(result);
  expect(calls[0]).toEqual(['cheshi:apple-notes-search', { query: '읽기', offset: 0, version: '', refresh: false }]);
  reply = { ok: true, value: { ...result, hits: [{ id: 'one', title: 'Title', modifiedAt: '', locked: 'false', folderId: 'folder' }] } };
  await expectFailure(api.search!({ query: 'Title' }), /flag/);
});

test('search status uses its read-only channel and validates progress', async () => {
  const channels: string[] = [];
  let reply: unknown = { ok: true, value: { state: 'building', completed: 19, pending: 102, error: null } };
  const api = createAppleNotesApi({ invoke: async channel => { channels.push(channel); return reply; } }, 'darwin');
  expect(await api.searchStatus!()).toMatchObject({ state: 'building', completed: 19, pending: 102 });
  expect(channels).toEqual(['cheshi:apple-notes-search-status']);
  reply = { ok: true, value: { state: 'building', completed: '19', pending: 102, error: null } };
  await expectFailure(api.searchStatus!(), /Invalid note search status/);
});

test('checks every Apple Notes IPC sender before touching Notes', async () => {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  let allowed = false;
  let executions = 0;
  registerAppleNotesIpc({
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); } },
    assertSender: () => { if (!allowed) throw new Error('Untrusted sender'); },
    service: new AppleNotesService({ platform: 'darwin', execute: async () => { executions += 1; return '{"ok":true,"value":[]}'; } }),
  });
  const event = { sender: { id: 1 } } as IpcMainInvokeEvent;
  for (const handler of handlers.values()) expect(() => handler(event, 'id')).toThrow('Untrusted sender');
  expect(handlers.size).toBe(10);
  expect(executions).toBe(0);
  allowed = true;
  expect(await handlers.get('cheshi:apple-notes-folders')?.(event)).toEqual({ ok: true, value: [] });
  expect(executions).toBe(1);
  await handlers.get('cheshi:apple-notes-folders')?.(event);
  expect(executions).toBe(1);
  await handlers.get('cheshi:apple-notes-folders')?.(event, true);
  expect(executions).toBe(2);
  expect(await handlers.get('cheshi:apple-notes-folders')?.(event, 'true')).toMatchObject({ ok: false, error: { code: 'invalid' } });
  expect(executions).toBe(2);
});

test('preload validates inputs, validates replies, and retains actionable error codes', async () => {
  const invocations: unknown[][] = [];
  let reply: unknown = { ok: true, value: [] };
  const api = createAppleNotesApi({ invoke: async (...args: unknown[]) => { invocations.push(args); return reply; } }, 'darwin');
  expect(api.available).toBe(true);
  expect(await api.folders()).toEqual([]);
  expect(invocations).toEqual([['cheshi:apple-notes-folders']]);
  await expectFailure(api.list('', 0), /identifier/);
  expect(invocations).toHaveLength(1);
  await api.folders(true);
  expect(invocations.at(-1)).toEqual(['cheshi:apple-notes-folders', true]);
  reply = { ok: false, error: { code: 'save-unknown', message: 'Check Notes before saving again.' } };
  expect(await api.create({ folderId: 'folder', title: 'Title', body: 'Body' })).toEqual({
    ok: false, error: { code: 'save-unknown', message: 'Check Notes before saving again.' },
  });
  reply = { ok: 'true', value: [] };
  await expectFailure(api.folders(), /Invalid Apple Notes reply/);
  reply = { ok: true, value: [{ id: 'folder', name: 'Notes', account: 'iCloud', path: 'Notes', isDefault: 'false' }] };
  await expectFailure(api.folders(), /flag/);
  expect(createAppleNotesApi({ invoke: async () => reply }, 'win32').available).toBe(false);
});

test('a malformed note response cannot be attached as an unlocked note', () => {
  expect(() => readAppleNotesReply({ ok: true, value: { id: 'id', title: 'Title', modifiedAt: '2026-09-16', locked: 'false', plaintext: 'text' } }, appleNote)).toThrow(/flag/);
});

test('open validates identifiers and accepts only a literal successful acknowledgement', async () => {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const invocations: unknown[][] = [];
  const service = new AppleNotesService({ platform: 'darwin', execute: async () => '{"ok":true,"value":true}' });
  const event = { sender: { id: 1 } } as IpcMainInvokeEvent;
  registerAppleNotesIpc({ ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); } },
    assertSender() {}, service });
  const api = createAppleNotesApi({ invoke: async (channel, ...args: unknown[]) => {
    invocations.push([channel, ...args]);
    return handlers.get(channel)?.(event, ...args);
  } }, 'darwin');
  await expectFailure(api.open(''), /identifier/);
  expect(invocations).toHaveLength(0);
  await api.open('chosen');
  expect(invocations).toEqual([['cheshi:apple-notes-open', 'chosen']]);
  for (const value of [false, 'true', null, {}]) {
    await expectFailure(createAppleNotesApi({ invoke: async () => ({ ok: true, value }) }, 'darwin').open('chosen'), /acknowledgement/);
  }
  await expectFailure(createAppleNotesApi({ invoke: async () => ({ ok: false, error: { code: 'permission', message: 'Allow Notes automation.' } }) }, 'darwin').open('chosen'), /Allow Notes automation/);
});

test('a lost IPC reply after creating a note is returned as an uncertain save', async () => {
  const api = createAppleNotesApi({ invoke: async () => { throw new Error('Renderer connection closed'); } }, 'darwin');
  expect(await api.create({ folderId: 'folder', title: 'Title', body: 'Body' })).toMatchObject({ ok: false, error: { code: 'save-unknown' } });
});

test('delete validates the target and requires a matching acknowledgement across preload and IPC', async () => {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const targets: unknown[] = [];
  registerAppleNotesIpc({ ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); } },
    assertSender() {}, service: {
      searchStatus: () => ({ ok: true, value: { state: 'idle', completed: 0, pending: 0, error: null } }),
      search: async () => ({ ok: false, error: { code: 'unavailable', message: 'Unavailable' } }),
      open: async () => ({ ok: true, value: true }),
      folders: async () => ({ ok: true, value: [] }), list: async () => ({ ok: true, value: { notes: [], nextOffset: null } }),
      document: async () => ({ ok: false, error: { code: 'not-found', message: 'Missing' } }),
      update: async () => ({ ok: false, error: { code: 'not-found', message: 'Missing' } }),
      read: async () => ({ ok: false, error: { code: 'not-found', message: 'Missing' } }),
      create: async () => ({ ok: true, value: { id: 'new', title: 'New' } }),
      delete: async id => { targets.push(id); return { ok: true, value: { id: String(id) } }; },
    } });
  const event = { sender: { id: 1 } } as IpcMainInvokeEvent;
  const api = createAppleNotesApi({ invoke: async (channel, ...args: unknown[]) => handlers.get(channel)?.(event, ...args) }, 'darwin');
  await expectFailure(api.delete(''), /identifier/);
  expect(targets).toEqual([]);
  expect(await api.delete('chosen')).toEqual({ ok: true, value: { id: 'chosen' } });
  expect(targets).toEqual(['chosen']);
  for (const invoke of [async () => { throw new Error('Disconnected'); },
    async () => ({ ok: true, value: { id: 'other' } }), async () => ({ ok: 'true', value: { id: 'chosen' } })]) {
    expect(await createAppleNotesApi({ invoke }, 'darwin').delete('chosen')).toMatchObject({ ok: false, error: { code: 'delete-unknown' } });
  }
});
