import { expect, test } from 'bun:test';
import { MailModel } from '../frontend/src/features/mail/mailModel';
import { MAIL_ERRORS, mailFailure } from '../shared/apple-mail';
import type { MailMessage, MailPage, MailReply } from '../shared/apple-mail';
import { mailApiFixture, mailBox, mailMessageFixture as message, mailSuccess, createMailDeferred } from './apple-mail-fixtures';

test('connection is explicit; pagination scopes reads and clears selected body', async () => {
  const offsets: number[] = [];
  const model = new MailModel(mailApiFixture({ list: async (_box, offset = 0) => {
    offsets.push(offset);
    return mailSuccess({ offset, nextOffset: offset === 0 ? 50 : null, messages: [message] });
  } }));
  expect(offsets).toEqual([]);
  await model.connect();
  await model.selectMessage(1);
  expect(model.getSnapshot().message?.body).toBe(message.body);
  await model.nextPage();
  expect(model.getSnapshot().message).toBeNull();
  await model.previousPage();
  expect(offsets).toEqual([0, 50, 0]);
});

test('stale mailbox pages and message bodies never replace a newer selection', async () => {
  const page = createMailDeferred<MailReply<MailPage>>();
  const body = createMailDeferred<MailReply<MailMessage>>();
  let reads = 0;
  const model = new MailModel(mailApiFixture({ list: async box => box.accountId === 'slow' ? page.promise
    : mailSuccess({ offset: 0, nextOffset: null, messages: [message, { ...message, id: 2 }] }),
    read: async target => { reads++; return target.id === 1 ? body.promise : mailSuccess({ ...message, id: 2 }); } }));
  await model.connect();
  const oldBody = model.selectMessage(1);
  await model.selectMessage(2);
  body.resolve(mailSuccess(message)); await oldBody;
  expect(model.getSnapshot().message?.id).toBe(2);
  const oldPage = model.selectMailbox({ ...mailBox, accountId: 'slow' });
  await model.selectMailbox(mailBox);
  page.resolve(mailSuccess({ offset: 0, nextOffset: null, messages: [] })); await oldPage;
  expect(model.getSnapshot().page?.messages).toHaveLength(2);
  expect(model.getSnapshot().message).toBeNull();
  await model.selectMessage(99); expect(reads).toBe(2);
});

test('permission and page failures are distinct from empty mailboxes and refresh can recover', async () => {
  let denied = false;
  let failedPage = true;
  const model = new MailModel(mailApiFixture({ mailboxes: async () => denied ? mailFailure('permission') : mailSuccess([mailBox]),
    list: async () => failedPage ? mailFailure('invalid-response') : mailSuccess({ offset: 0, nextOffset: null, messages: [] }) }));
  await model.connect();
  expect(model.getSnapshot().pageError).toBeTruthy(); expect(model.getSnapshot().page).toBeNull();
  failedPage = false; await model.connect();
  expect(model.getSnapshot().pageError).toBeNull(); expect(model.getSnapshot().page?.messages).toEqual([]);
  denied = true; await model.connect();
  expect(model.getSnapshot().boxesError).toBe(MAIL_ERRORS.permission);
  expect(model.getSnapshot().connected).toBe(false); expect(model.getSnapshot().boxes).toEqual([]);
});

test('unmount cancellation ignores pending reads and refresh preserves mailbox identity', async () => {
  const body = createMailDeferred<MailReply<MailMessage>>();
  const other = { ...mailBox, accountId: 'other' };
  const model = new MailModel(mailApiFixture({ mailboxes: async () => mailSuccess([mailBox, other]), read: async () => body.promise }));
  await model.connect(); await model.selectMailbox(other); await model.connect();
  expect(model.getSnapshot().selectedBox?.accountId).toBe('other');
  const pending = model.selectMessage(1);
  model.cancelPending(); body.resolve(mailSuccess(message)); await pending;
  expect(model.getSnapshot().message).toBeNull();
});

test('management prevents concurrent mutations and refreshes read state after acknowledgement', async () => {
  const pending = createMailDeferred<MailReply<{ mailbox: typeof mailBox; id: number }>>();
  let read = false;
  let writes = 0;
  const model = new MailModel(mailApiFixture({ read: async () => mailSuccess({ ...message, read }),
    change: async () => { writes++; return pending.promise; } }));
  await model.connect(); await model.selectMessage(1);
  const input = { action: 'read' as const, target: { mailbox: mailBox, id: 1 }, value: true };
  const changing = model.change(input); await model.change(input);
  await model.selectMailbox({ ...mailBox, path: ['Other'] });
  expect(writes).toBe(1); expect(model.getSnapshot().selectedBox?.path).toEqual(['INBOX']);
  read = true; pending.resolve(mailSuccess(input.target)); await changing;
  expect(model.getSnapshot().message?.read).toBe(true);
  expect(model.getSnapshot().changing).toBe(false);
});

test('uncertain changes block repeated actions until the user refreshes', async () => {
  let writes = 0;
  const model = new MailModel(mailApiFixture({ change: async () => { writes++; return mailFailure('change-unknown'); } }));
  await model.connect(); await model.selectMessage(1);
  const input = { action: 'flag' as const, target: { mailbox: mailBox, id: 1 }, value: true };
  await model.change(input); await model.change(input);
  expect(writes).toBe(1); expect(model.getSnapshot().changeBlocked).toBe(true);
  await model.connect(); expect(model.getSnapshot().changeBlocked).toBe(false);
});
