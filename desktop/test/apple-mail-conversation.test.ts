import { expect, test } from 'bun:test';
import vm from 'node:vm';
import { appleMailScript } from '../lib/apple-mail-script.mts';
import { AppleMailService } from '../lib/apple-mail-service.mts';
import { createAppleMailApi } from '../lib/apple-mail-preload.cts';
import { registerAppleMailIpc } from '../lib/apple-mail-ipc.mts';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { mailConversation, mailTargetKey, MAIL_CONVERSATION_LIMIT } from '../shared/mail-conversation';
import type { MailConversation } from '../shared/mail-conversation';
import type { MailReply, MailTarget, MailChange } from '../shared/apple-mail';
import { mailFailure, mailReply, mailSummary } from '../shared/apple-mail';
import { MailModel } from '../frontend/src/features/mail/mailModel';
import { createMailDeferred, mailApiFixture, mailBox, mailMessageFixture, mailSuccess } from './apple-mail-fixtures';

const anchor: MailTarget = { mailbox: { accountId: 'account-a', path: ['INBOX'] }, id: 1 };
const sent: MailTarget = { mailbox: { accountId: 'account-a', path: ['Sent'] }, id: 2 };
const thread: MailConversation = { incomplete: false, messages: [
  { target: anchor, summary: mailSummary(mailMessageFixture) },
  { target: sent, summary: mailSummary({ ...mailMessageFixture, id: 2, subject: 'Re: Hello' }) },
] };

interface NativeMessage { id: number; folder: string; rfc?: string; headers?: string; subject?: string; day?: number }
function nativeConversation(rows: NativeMessage[], selected = anchor, failedFolder?: string) {
  let bodyReads = 0;
  const folders = [...new Set(['INBOX', ...rows.map(row => row.folder)])].map(name => {
    const messages = rows.filter(row => row.folder === name).map(row => ({
      id: () => row.id, exists: () => true, messageId: () => row.rfc ?? '', allHeaders: () => row.headers ?? '',
      subject: () => row.subject ?? 'Hello', sender: () => 'sender@example.test', readStatus: () => true, flaggedStatus: () => false,
      dateReceived: () => new Date(`2026-09-${String(row.day ?? row.id).padStart(2, '0')}T00:00:00Z`), dateSent: () => null,
      content: () => { bodyReads++; throw new Error('No body reads in discovery'); },
      source: () => { bodyReads++; throw new Error('No source reads in discovery'); },
    }));
    const collection = Object.assign(messages, {
      byId: (id: number) => messages.find(message => message.id() === id) ?? { exists: () => false },
      whose: (query: { _or: Array<{ messageId?: string; allHeaders?: { _contains: string } }> }) => () => {
        if (name === failedFolder) throw new Error('Unavailable folder');
        return messages.filter(message => query._or.some(clause => clause.messageId !== undefined
          ? message.messageId() === clause.messageId : message.allHeaders().includes(clause.allHeaders!._contains)));
      },
    });
    return { name: () => name, mailboxes: [], messages: collection };
  });
  const account = { exists: () => true, mailboxes: folders };
  const result: unknown = JSON.parse(vm.runInNewContext(appleMailScript({ action: 'conversation', target: selected }), {
    Application: () => ({ accounts: { byId: (id: string) => { expect(id).toBe('account-a'); return account; } }, mailboxes: [] }), Date,
  }));
  expect(bodyReads).toBe(0);
  const reply = mailReply(result, value => mailConversation(value, selected));
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.value;
}

test('conversation follows ancestors, sent replies, folded references and renamed descendants without merging subjects', () => {
  const rows = [
    { id: 1, folder: 'INBOX', rfc: 'root@test', headers: 'Message-ID: <root@test>' },
    { id: 2, folder: 'Sent', rfc: 'reply@test', headers: 'In-Reply-To: <root@test>', subject: 'Re: Hello' },
    { id: 3, folder: 'Archive', rfc: 'next@test', headers: 'References: <root@test>\r\n\t<reply@test>', subject: 'Renamed topic' },
    { id: 4, folder: 'INBOX', rfc: 'unrelated@test', headers: 'Subject: mentions <root@test>', subject: 'Re: Hello' },
    { id: 5, folder: 'Archive', rfc: 'reply@test', headers: 'In-Reply-To: <root@test>' },
    { id: 6, folder: 'INBOX', rfc: 'cycle@test', headers: 'References: <next@test> <cycle@test>' },
  ];
  for (const selected of [anchor, sent]) {
    const result = nativeConversation(rows, selected);
    expect(result.incomplete).toBe(false);
    expect(result.messages.map(entry => entry.target.id)).toEqual([1, 2, 3, 6]);
    expect(result.messages[1]?.target.mailbox.path).toEqual(['Sent']);
  }
});

test('missing identifiers stay single; unavailable folders and capped threads are explicitly incomplete', () => {
  expect(nativeConversation([{ id: 1, folder: 'INBOX' }, { id: 2, folder: 'Sent' }]).messages).toHaveLength(1);
  const rows = [{ id: 1, folder: 'INBOX', rfc: 'root@test' }, { id: 2, folder: 'Sent', headers: 'References: <root@test>' }];
  expect(nativeConversation(rows, anchor, 'Sent').incomplete).toBe(true);
  const many = Array.from({ length: 55 }, (_, index) => ({ id: index + 2, folder: 'Sent', rfc: `${index}@test`,
    headers: 'References: <root@test>', day: 2 }));
  const result = nativeConversation([rows[0]!, ...many]);
  expect(result.messages).toHaveLength(MAIL_CONVERSATION_LIMIT);
  expect(result.incomplete).toBe(true);
});

test('conversation boundaries reject cross-account, mismatched, duplicate and missing-anchor results', () => {
  expect(mailConversation(thread, anchor)).toEqual(thread);
  const bad: unknown[] = [
    { ...thread, incomplete: 'true' }, { ...thread, messages: [] },
    { ...thread, messages: [thread.messages[1]] }, { ...thread, messages: [thread.messages[0], thread.messages[0]] },
    { ...thread, messages: [thread.messages[0], { ...thread.messages[1], target: { ...sent, id: 9 } }] },
    { ...thread, messages: [thread.messages[0], { ...thread.messages[1], target: { ...sent, mailbox: { ...sent.mailbox, accountId: 'other' } } }] },
  ];
  for (const value of bad) expect(() => mailConversation(value, anchor)).toThrow();
});

test('conversation crosses the validated preload and IPC boundary without allowing untrusted callers', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipcMain: Pick<IpcMain, 'handle'> = { handle: (channel, listener) => { handlers.set(channel, listener); } };
  let allowed = true, calls = 0;
  const service = new AppleMailService({ platform: 'darwin', execute: async () => { calls++; return JSON.stringify(mailSuccess(thread)); } });
  registerAppleMailIpc({ ipcMain, service, assertSender: () => { if (!allowed) throw new Error('Untrusted'); } });
  const api = createAppleMailApi({ invoke: async (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args) }, 'darwin');
  expect(await service.conversation({ ...anchor, id: 0 })).toEqual(mailFailure('invalid'));
  expect(await api.conversation(anchor)).toEqual(mailSuccess(thread));
  allowed = false;
  expect(await api.conversation(anchor)).toEqual(mailFailure('unavailable'));
  expect(calls).toBe(1);
});

test('late conversation discovery cannot replace a new selection, refresh or cancellation', async () => {
  for (const action of ['selection', 'refresh', 'cancel'] as const) {
    const pending = createMailDeferred<MailReply<MailConversation>>();
    let calls = 0;
    const model = new MailModel(mailApiFixture({
      list: async () => mailSuccess({ offset: 0, nextOffset: null, messages: [mailMessageFixture, { ...mailMessageFixture, id: 3 }] }),
      conversation: async target => ++calls === 1 ? pending.promise : mailSuccess({ incomplete: false,
        messages: [{ target, summary: { ...mailMessageFixture, id: target.id } }] }),
    }));
    await model.connect(); await model.selectMessage(1);
    expect(model.getSnapshot().message?.id).toBe(1);
    if (action === 'selection') await model.selectMessage(3);
    else if (action === 'refresh') await model.connect();
    else model.cancelPending();
    pending.resolve(mailSuccess(thread)); await pending.promise; await Promise.resolve(); await Promise.resolve();
    if (action === 'cancel') expect(model.getSnapshot().conversation).toBeNull();
    else expect(model.getSnapshot().conversation?.messages.map(entry => entry.target.id)).toEqual([action === 'selection' ? 3 : 1]);
  }
});

test('related mutations use their own mailbox, retain the anchor and block unknown results; image consent is per target', async () => {
  const changes: MailChange[] = [];
  const model = new MailModel(mailApiFixture({
    read: async target => mailSuccess({ ...mailMessageFixture, id: target.id, read: true }),
    conversation: async () => mailSuccess(thread),
    change: async input => { changes.push(input); return mailFailure('change-unknown'); },
  }));
  await model.connect(); await model.selectMessage(1); await model.refreshConversation();
  model.allowConversationImages(sent);
  expect(model.remoteImagesFor(sent)).toBe(true);
  expect(model.remoteImagesFor(anchor)).toBe(false);
  expect(mailTargetKey(anchor)).not.toBe(mailTargetKey({ ...sent, id: anchor.id }));
  await model.change({ action: 'move', target: { ...sent, id: 99 }, destination: { ...mailBox, path: ['Trash'] } });
  expect(changes).toHaveLength(0);
  await model.change({ action: 'move', target: sent, destination: { ...mailBox, path: ['Trash'] } });
  expect(changes[0]?.target).toEqual(sent);
  expect(model.getSnapshot().message?.id).toBe(1);
  expect(model.getSnapshot().changeBlocked).toBe(true);
  await model.change({ action: 'read', target: sent, value: true });
  expect(changes).toHaveLength(1);
});

test('late conversation body batches cannot publish after switching mailboxes', async () => {
  const pending = createMailDeferred<MailReply<typeof mailMessageFixture>>();
  const started = createMailDeferred<void>();
  const model = new MailModel(mailApiFixture({
    read: async target => {
      if (target.id === 1) return mailSuccess({ ...mailMessageFixture, read: true });
      started.resolve();
      return pending.promise;
    },
    conversation: async () => mailSuccess(thread),
  }));
  await model.connect(); await model.selectMessage(1); await started.promise;
  expect(model.getSnapshot().conversation).toBeNull();
  expect(model.getSnapshot().loadingConversation).toBe(true);
  await model.selectMailbox({ ...mailBox, path: ['Archive'] });
  pending.resolve(mailSuccess({ ...mailMessageFixture, id: 2 }));
  await pending.promise;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(model.getSnapshot().selectedBox?.path).toEqual(['Archive']);
  expect(model.getSnapshot().conversation).toBeNull();
  expect(model.getSnapshot().conversationMessages).toEqual({});
  expect(model.getSnapshot().loadingConversation).toBe(false);
});
