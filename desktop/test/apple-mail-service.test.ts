import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { AppleMailService } from '../lib/apple-mail-service.mts';
import { createAppleMailApi } from '../lib/apple-mail-preload.cts';
import { registerAppleMailIpc } from '../lib/apple-mail-ipc.mts';
import { MailProcessError, runMailScript } from '../lib/apple-mail-process.mts';
import { MAIL_BODY_LIMIT, mailboxes, mailboxKey, mailMessage, mailPage, mailSummary, mailFailure } from '../shared/apple-mail';
import { mailBox, mailMessageFixture as message, mailSuccess } from './apple-mail-fixtures';

test('Mail boundaries distinguish accounts, reject malformed flags, dates, identities and pagination', () => {
  const second = { ...mailBox, accountId: 'account-b' };
  expect(mailboxKey(mailBox)).not.toBe(mailboxKey(second));
  expect(mailboxes([mailBox, second])).toHaveLength(2);
  for (const boxes of [[mailBox, mailBox], [{ ...mailBox, path: [] }], [{ ...mailBox, unread: -1 }]]) {
    expect(() => mailboxes(boxes)).toThrow();
  }
  for (const bad of [{ read: 1 }, { date: 'invalid' }, { id: 0 }, { id: '1' }, { sender: null }]) {
    expect(() => mailSummary({ ...message, ...bad })).toThrow();
  }
  expect(mailSummary({ ...message, date: null, subject: '' }).date).toBeNull();
  expect(() => mailPage({ messages: [message], offset: 0, nextOffset: 1 }, 0)).toThrow();
  expect(() => mailPage({ messages: [message, message], offset: 0, nextOffset: null }, 0)).toThrow();
  expect(() => mailMessage({ ...message, body: 'x'.repeat(MAIL_BODY_LIMIT + 1) }, 1)).toThrow();
  expect(() => mailMessage(message, 2)).toThrow();
});

test('service validates before invoking Mail and maps safe failure categories', async () => {
  let calls = 0;
  const service = new AppleMailService({ platform: 'darwin', execute: async () => { calls++; return 'not JSON'; } });
  expect(await service.list({ ...mailBox, path: [] })).toEqual(mailFailure('invalid'));
  expect(await service.list(mailBox, -1)).toEqual(mailFailure('invalid'));
  expect(await service.read({ mailbox: mailBox, id: 0 })).toEqual(mailFailure('invalid'));
  expect(calls).toBe(0);
  expect(await service.mailboxes()).toEqual(mailFailure('invalid-response'));
  expect(await new AppleMailService({ platform: 'linux', execute: async () => { throw new Error('must not execute'); } }).mailboxes()).toEqual(mailFailure('unsupported'));
  for (const [reason, code] of [['timeout', 'timeout'], ['output', 'too-large'], ['process', 'unavailable']] as const) {
    const failed = new AppleMailService({ platform: 'darwin', execute: async () => { throw new MailProcessError(reason); } });
    expect(await failed.mailboxes()).toEqual(mailFailure(code));
  }
  const denied = new AppleMailService({ platform: 'darwin', execute: async () => JSON.stringify({ ok: false, error: { code: 'permission', message: 'private data' } }) });
  expect(await denied.mailboxes()).toEqual(mailFailure('permission'));
});

test('preload, IPC and service roundtrip scopes messages to their mailbox and rejects untrusted senders', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipcMain: Pick<IpcMain, 'handle'> = { handle: (channel, listener) => { handlers.set(channel, listener); } };
  let allowed = true;
  let executions = 0;
  const service = new AppleMailService({ platform: 'darwin', execute: async source => {
    executions++;
    expect(source).toContain('account-a');
    return JSON.stringify(mailSuccess(message));
  } });
  registerAppleMailIpc({ ipcMain, service, assertSender: () => { if (!allowed) throw new Error('Untrusted'); } });
  const api = createAppleMailApi({ invoke: async (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args) }, 'darwin');
  expect(Object.keys(api).sort()).toEqual(['accounts', 'available', 'change', 'list', 'mailboxes', 'read', 'send']);
  expect(await api.read({ mailbox: mailBox, id: 1 })).toEqual(mailSuccess(message));
  allowed = false;
  expect(await api.read({ mailbox: mailBox, id: 1 })).toEqual(mailFailure('unavailable'));
  expect(executions).toBe(1);
  const malformed = createAppleMailApi({ invoke: async (_channel: string, ..._args: unknown[]): Promise<unknown> => mailSuccess({ ...message, read: 'true' }) }, 'darwin');
  expect(await malformed.read({ mailbox: mailBox, id: 1 })).toEqual(mailFailure('invalid-response'));
});

test('Mail services load under native Node strip-only TypeScript without application startup', () => {
  const result = spawnSync('node', ['--input-type=module', '-e', "await import('./desktop/lib/apple-mail-service.mts'); await import('./desktop/lib/apple-mail-ipc.mts');"], { encoding: 'utf8', cwd: new URL('../..', import.meta.url) });
  expect(result.stderr).toBe(''); expect(result.status).toBe(0);
});

async function processFailure(operation: Promise<string>, reason: MailProcessError['reason']) {
  let error: unknown;
  try { await operation; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(MailProcessError);
  expect((error as MailProcessError).reason).toBe(reason);
}
test.skipIf(process.platform !== 'darwin')('osascript transport handles output and limits without invoking Mail', async () => {
  expect(await runMailScript('JSON.stringify({ok:true,value:[]})')).toBe('{"ok":true,"value":[]}');
  await processFailure(runMailScript('"xxxxxxxxxx"', { maxOutputBytes: 4 }), 'output');
  await processFailure(runMailScript('while (true) {}', { timeoutMs: 100 }), 'timeout');
});
