import type { AppleMailApi, Mailbox, MailMessage, MailReply, MailSend } from '../shared/apple-mail';

export const mailBox: Mailbox = { accountId: 'account-a', accountName: 'Personal', path: ['INBOX'], unread: 1 };
export const mailMessageFixture: MailMessage = { id: 1, subject: 'Hello', sender: 'Sender <sender@example.test>',
  date: '2026-09-22T01:00:00.000Z', read: false, flagged: false, to: ['me@example.test'], cc: [], replyTo: 'sender@example.test', body: 'Plain text body', bodyTruncated: false };
export const mailSendFixture: MailSend = { operationId: '12345678-1234-1234-1234-123456789abc', accountId: 'account-a',
  sender: 'me@example.test', to: ['recipient@example.test'], cc: [], bcc: [], subject: 'Hello', body: 'Message', reply: null };
export function mailSuccess<T>(value: T): MailReply<T> { return { ok: true, value }; }
export function mailApiFixture(overrides: Partial<AppleMailApi> = {}): AppleMailApi {
  return { available: true, mailboxes: async () => mailSuccess([mailBox]),
    list: async (_box, offset = 0) => mailSuccess({ messages: [mailMessageFixture], offset, nextOffset: null }),
    read: async target => mailSuccess({ ...mailMessageFixture, id: target.id }),
    accounts: async () => mailSuccess([{ id: 'account-a', name: 'Personal', addresses: ['me@example.test'] }]),
    change: async input => mailSuccess(input.target),
    send: async input => mailSuccess({ operationId: input.operationId, accepted: true }), ...overrides };
}
export function createMailDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
