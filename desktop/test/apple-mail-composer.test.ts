import { expect, test } from 'bun:test';
import { MailComposer, mailComposer } from '../frontend/src/features/mail/mailComposer';
import { mailFailure, mailTarget } from '../shared/apple-mail';
import type { MailReply, MailSent } from '../shared/apple-mail';
import { mailApiFixture, mailBox, mailMessageFixture as message, mailSuccess, createMailDeferred } from './apple-mail-fixtures';

test('drafts survive closing and navigation and require a separate confirmation before sending', async () => {
  let sends = 0;
  const api = mailApiFixture({ send: async input => { sends++; return mailSuccess({ operationId: input.operationId, accepted: true }); } });
  const composer = mailComposer(api);
  await composer.start(); composer.edit({ to: 'someone@example.test', subject: 'Test', body: 'Keep me' });
  composer.hide(); expect(mailComposer(api)).toBe(composer);
  await composer.start(); expect(composer.getSnapshot().form?.body).toBe('Keep me');
  await composer.send(); expect(sends).toBe(0);
  composer.review(); expect(sends).toBe(0);
  expect(composer.getSnapshot().confirmation?.to).toEqual(['someone@example.test']);
  await composer.send(); expect(sends).toBe(1); expect(composer.getSnapshot().form).toBeNull();
});

test('editing invalidates the confirmed snapshot and malformed recipients never reach the service', async () => {
  let sends = 0;
  const composer = new MailComposer(mailApiFixture({ send: async input => { sends++; return mailSuccess({ operationId: input.operationId, accepted: true }); } }));
  await composer.start(); composer.edit({ to: 'someone@example.test' }); composer.review();
  composer.edit({ body: 'Changed after confirmation' }); await composer.send(); expect(sends).toBe(0);
  composer.edit({ to: 'invalid' }); composer.review(); await composer.send();
  expect(sends).toBe(0); expect(composer.getSnapshot().error).toBeTruthy();
});

test('reply-all respects reply-to, excludes own aliases, removes duplicates, and never copies bcc', async () => {
  const composer = new MailComposer(mailApiFixture({ accounts: async () => mailSuccess([
    { id: 'other', name: 'Other', addresses: ['other@example.test'] },
    { id: 'account-a', name: 'Personal', addresses: ['me@example.test', 'alias@example.test'] },
  ]) }));
  const target = { mailbox: mailBox, id: 1 };
  await composer.start({ ...message, replyTo: 'Reply <reply@example.test>',
    to: ['me@example.test', 'colleague@example.test', 'REPLY@example.test'],
    cc: ['alias@example.test', 'other@example.test', 'colleague@example.test', 'cc@example.test'] }, target, true);
  const form = composer.getSnapshot().form!;
  expect(form.accountId).toBe('account-a'); expect(form.sender).toBe('me@example.test');
  expect(form.to).toBe('reply@example.test, colleague@example.test');
  expect(form.cc).toBe('cc@example.test'); expect(form.bcc).toBe(''); expect(form.subject).toBe('Re: Hello');
  composer.review(); expect(composer.getSnapshot().confirmation?.reply).toEqual({ target: mailTarget(target), all: true });
});

test('single replies use reply-to without adding original recipients', async () => {
  const composer = new MailComposer(mailApiFixture());
  await composer.start({ ...message, cc: ['cc@example.test'] }, { mailbox: mailBox, id: 1 }, false);
  expect(composer.getSnapshot().form?.to).toBe('sender@example.test');
  expect(composer.getSnapshot().form?.cc).toBe('');
});

test('double clicks send once; uncertain results retain text and remain blocked after reopening', async () => {
  const deferred = createMailDeferred<MailReply<MailSent>>();
  let sends = 0;
  const composer = new MailComposer(mailApiFixture({ send: async () => { sends++; return deferred.promise; } }));
  await composer.start(); composer.edit({ to: 'someone@example.test', body: 'Do not lose me' }); composer.review();
  const pending = composer.send(); await composer.send();
  composer.edit({ body: 'Wrong' }); composer.discard(); composer.hide();
  expect(composer.getSnapshot().visible).toBe(true); expect(sends).toBe(1);
  deferred.resolve(mailFailure('send-unknown')); await pending;
  expect(composer.getSnapshot().form?.body).toBe('Do not lose me');
  composer.hide(); await composer.start(); composer.review(); await composer.send();
  expect(sends).toBe(1); expect(composer.getSnapshot().blocked).toBe(true);
});

test('known pre-send failures retain an editable draft and allow a new reviewed request', async () => {
  let denied = true;
  const composer = new MailComposer(mailApiFixture({ send: async input => denied ? mailFailure('permission')
    : mailSuccess({ operationId: input.operationId, accepted: true }) }));
  await composer.start(); composer.edit({ to: 'someone@example.test', body: 'Keep' }); composer.review();
  const firstId = composer.getSnapshot().confirmation!.operationId;
  await composer.send(); expect(composer.getSnapshot().blocked).toBe(false); expect(composer.getSnapshot().form?.body).toBe('Keep');
  denied = false; composer.review(); expect(composer.getSnapshot().confirmation?.operationId).not.toBe(firstId);
  await composer.send(); expect(composer.getSnapshot().form).toBeNull();
});
