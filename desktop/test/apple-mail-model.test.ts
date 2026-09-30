import { expect, test } from 'bun:test';
import { MailModel } from '../frontend/src/features/mail/mailModel';
import { MAIL_ERRORS, mailFailure } from '../shared/apple-mail';
import type { MailMessage, MailPage, MailReply } from '../shared/apple-mail';
import { mailApiFixture, mailBox, mailMessageFixture as message, mailSuccess, createMailDeferred } from './apple-mail-fixtures';

test('load more appends 25 messages, preserves selection and stops at the end', async () => {
  const offsets: number[] = [];
  const model = new MailModel(mailApiFixture({ list: async (_box, offset = 0) => {
    offsets.push(offset);
    return mailSuccess({ offset, nextOffset: offset === 0 ? 25 : null,
      messages: Array.from({ length: 25 }, (_, i) => ({ ...message, id: offset + i + 1 })) });
  } }));
  expect(offsets).toEqual([]);
  await model.connect();
  await model.selectMessage(1);
  expect(model.getSnapshot().message?.body).toBe(message.body);
  const body = model.getSnapshot().message;
  await model.loadMore();
  expect(model.getSnapshot().page?.messages).toHaveLength(50);
  expect(model.getSnapshot().message).toBe(body);
  expect(model.getSnapshot().selectedId).toBe(1);
  await model.loadMore();
  expect(offsets).toEqual([0, 25]);
  await model.connect();
  expect(offsets).toEqual([0, 25, 0, 25]);
  expect(model.getSnapshot().page?.messages).toHaveLength(50);
  expect(model.getSnapshot().message?.body).toBe(message.body);
});

test('load more coalesces requests, retains failed pages for retry and deduplicates overlapping rows', async () => {
  const pending = createMailDeferred<MailReply<MailPage>>();
  let calls = 0;
  let retry = false;
  const first = Array.from({ length: 25 }, (_, i) => ({ ...message, id: i + 1 }));
  const model = new MailModel(mailApiFixture({ list: async (_box, offset = 0) => {
    if (!offset) return mailSuccess({ offset, messages: first, nextOffset: 25 });
    calls++;
    return retry ? mailSuccess({ offset, messages: [{ ...message, id: 25 }, { ...message, id: 26 }], nextOffset: null }) : pending.promise;
  } }));
  await model.connect(); await model.selectMessage(1);
  const page = model.getSnapshot().page;
  const loading = model.loadMore();
  await model.loadMore();
  expect(calls).toBe(1);
  expect(model.getSnapshot().page).toBe(page);
  expect(model.getSnapshot().loadingMore).toBe(true);
  pending.resolve(mailFailure('unavailable')); await loading;
  expect(model.getSnapshot().page).toBe(page);
  expect(model.getSnapshot().moreError).toBe(MAIL_ERRORS.unavailable);
  expect(model.getSnapshot().message?.body).toBe(message.body);
  retry = true; await model.loadMore();
  expect(calls).toBe(2);
  expect(model.getSnapshot().page?.messages).toHaveLength(26);
  expect(model.getSnapshot().moreError).toBeNull();
});

test.each(['switch', 'refresh', 'cancel'] as const)('late additional mail cannot overwrite a newer %s', async action => {
  const pending = createMailDeferred<MailReply<MailPage>>();
  const other = { ...mailBox, path: ['Archive'] };
  const model = new MailModel(mailApiFixture({ list: async (_box, offset = 0) => offset ? pending.promise
    : mailSuccess({ offset, messages: [message], nextOffset: 25 }) }));
  await model.connect();
  const loading = model.loadMore();
  if (action === 'switch') await model.selectMailbox(other);
  else if (action === 'refresh') await model.connect();
  else model.cancelPending();
  pending.resolve(mailSuccess({ offset: 25, messages: [{ ...message, id: 26 }], nextOffset: null }));
  await loading;
  expect(model.getSnapshot().page?.messages.map(row => row.id)).toEqual([1]);
  if (action === 'switch') expect(model.getSnapshot().selectedBox).toEqual(other);
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
  expect(model.getSnapshot().connected).toBe(true); expect(model.getSnapshot().boxes).toEqual([mailBox]);
  expect(model.getSnapshot().page?.messages).toEqual([]);
});

test('refresh retains the current page and body on failure and reconciles removed messages on success', async () => {
  let fail = false;
  let removed = false;
  const offsets: number[] = [];
  const model = new MailModel(mailApiFixture({ list: async (_box, offset = 0) => {
    offsets.push(offset);
    return fail ? mailFailure('unavailable') : mailSuccess({ offset, nextOffset: null, messages: removed ? [] : [message] });
  } }));
  await model.connect();
  await model.selectMailbox(mailBox, 50);
  await model.selectMessage(1);
  const previous = model.getSnapshot();
  fail = true;
  await model.connect();
  expect(model.getSnapshot().page).toBe(previous.page);
  expect(model.getSnapshot().message).toEqual(previous.message);
  expect(model.getSnapshot().selectedId).toBe(1);
  expect(model.getSnapshot().pageError).toBe(MAIL_ERRORS.unavailable);
  expect(offsets).toEqual([0, 50, 50]);
  fail = false; removed = true;
  await model.connect();
  expect(model.getSnapshot().page?.messages).toEqual([]);
  expect(model.getSnapshot().message).toBeNull();
  expect(model.getSnapshot().selectedId).toBeNull();
  expect(model.getSnapshot().pageError).toBeNull();
});

test('refresh replaces a removed mailbox and discards a cancelled second-stage response', async () => {
  const page = createMailDeferred<MailReply<MailPage>>();
  const pageStarted = createMailDeferred<void>();
  const other = { ...mailBox, path: ['Archive'] };
  let replace = false;
  const model = new MailModel(mailApiFixture({
    mailboxes: async () => mailSuccess([replace ? other : mailBox]),
    list: async () => {
      if (!replace) return mailSuccess({ offset: 0, nextOffset: null, messages: [message] });
      pageStarted.resolve();
      return page.promise;
    },
  }));
  await model.connect(); await model.selectMessage(1);
  replace = true;
  const pending = model.connect();
  await pageStarted.promise;
  expect(model.getSnapshot().selectedBox).toEqual(mailBox);
  expect(model.getSnapshot().message?.body).toBe(message.body);
  model.cancelPending();
  page.resolve(mailSuccess({ offset: 0, nextOffset: null, messages: [] }));
  await pending;
  expect(model.getSnapshot().selectedBox).toEqual(mailBox);
  await model.connect();
  expect(model.getSnapshot().selectedBox).toEqual(other);
  expect(model.getSnapshot().message).toBeNull();
  expect(model.getSnapshot().selectedId).toBeNull();
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
