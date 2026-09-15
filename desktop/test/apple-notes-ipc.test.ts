import { expect, test } from 'bun:test';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerAppleNotesIpc } from '../lib/apple-notes-ipc.mts';
import { createAppleNotesApi } from '../lib/apple-notes-preload.cts';
import { AppleNotesService } from '../lib/apple-notes-service.mts';
import { appleNote, readAppleNotesReply } from '../shared/apple-notes.ts';

async function expectFailure(operation: Promise<unknown>, message: RegExp) {
  try { await operation; }
  catch (error) { expect(error instanceof Error ? error.message : String(error)).toMatch(message); return; }
  throw new Error('Expected the operation to fail.');
}

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
  expect(handlers.size).toBe(4);
  expect(executions).toBe(0);
  allowed = true;
  expect(await handlers.get('cheshi:apple-notes-folders')?.(event)).toEqual({ ok: true, value: [] });
  expect(executions).toBe(1);
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

test('a lost IPC reply after creating a note is returned as an uncertain save', async () => {
  const api = createAppleNotesApi({ invoke: async () => { throw new Error('Renderer connection closed'); } }, 'darwin');
  expect(await api.create({ folderId: 'folder', title: 'Title', body: 'Body' })).toMatchObject({ ok: false, error: { code: 'save-unknown' } });
});
