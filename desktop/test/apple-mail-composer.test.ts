import { expect, test } from 'bun:test';
import { MailComposer, mailComposer } from '../frontend/src/features/mail/mailComposer';
import { mailFailure, mailTarget } from '../shared/apple-mail';
import type { MailAccount, MailReply, MailSent } from '../shared/apple-mail';
import type { MailReplyEditingResult } from '../shared/mail-reply';
import { mailApiFixture, mailBox, mailMessageFixture as message, mailSuccess, createMailDeferred } from './apple-mail-fixtures';

test('drafts survive closing and navigation and one send action polishes before sending', async () => {
  let sends = 0;
  const api = mailApiFixture({ send: async input => { sends++; return mailSuccess({ operationId: input.operationId, accepted: true }); } });
  const composer = mailComposer(api);
  await composer.start(); composer.edit({ to: 'someone@example.test', subject: 'Test', body: 'Keep me' });
  composer.hide(); expect(mailComposer(api)).toBe(composer);
  await composer.start(); expect(composer.getSnapshot().form?.body).toBe('Keep me');
  composer.review(); expect(sends).toBe(0);
  expect(composer.getSnapshot().confirmation?.to).toEqual(['someone@example.test']);
  await composer.send(); expect(sends).toBe(1); expect(composer.getSnapshot().form).toBeNull();
  composer.dismissNotice();
});

test('malformed recipients never reach the editor or service', async () => {
  let sends = 0;
  const composer = new MailComposer(mailApiFixture({ send: async input => { sends++; return mailSuccess({ operationId: input.operationId, accepted: true }); } }));
  await composer.start(); composer.edit({ to: 'someone@example.test' }); composer.review();
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
  await Promise.resolve();
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
  composer.dismissNotice();
});

test('reply loading and retained drafts keep their original message, target and image consent', async () => {
  const accounts = createMailDeferred<MailReply<MailAccount[]>>();
  const composer = new MailComposer(mailApiFixture({ accounts: () => accounts.promise }));
  const target = { mailbox: mailBox, id: 1 };
  const loading = composer.start(message, target, true, true);
  expect(composer.getSnapshot().reply).toEqual({ target, all: true });
  expect(composer.getSnapshot().original).toBe(message);
  expect(composer.getSnapshot().remoteImagesAllowed).toBe(true);
  await composer.start({ ...message, id: 2 }, { ...target, id: 2 });
  accounts.resolve(mailSuccess([{ id: 'account-a', name: 'Personal', addresses: ['me@example.test'] }]));
  await loading;
  composer.edit({ body: 'Keep this reply' }); composer.hide();
  await composer.start({ ...message, id: 2 }, { ...target, id: 2 });
  expect(composer.getSnapshot().original).toBe(message);
  expect(composer.getSnapshot().reply).toEqual({ target, all: true });
  expect(composer.getSnapshot().form?.body).toBe('Keep this reply');
  composer.discard();
  expect(composer.getSnapshot().original).toBeNull();
  expect(composer.getSnapshot().remoteImagesAllowed).toBe(false);
  await composer.start();
  expect(composer.getSnapshot().reply).toBeNull();
});

test('Send locks the original envelope during polishing and sends escaped edited HTML exactly once', async () => {
  const editing = createMailDeferred<MailReply<MailReplyEditingResult>>();
  let requestId = '';
  const sent: import('../shared/apple-mail').MailSend[] = [];
  let edits = 0;
  const composer = new MailComposer(mailApiFixture({
    polish: input => { edits++; requestId = input.requestId; return editing.promise; },
    send: async input => { sent.push(input); return mailSuccess({ operationId: input.operationId, accepted: true }); },
  }));
  await composer.start(); composer.edit({ to: 'recipient@example.test', body: 'rough', subject: 'Keep subject' });
  const pending = composer.send();
  await composer.send(); composer.edit({ to: 'wrong@example.test', body: 'Changed' }); composer.discard();
  expect(composer.getSnapshot().phase).toBe('editing');
  expect(sent).toHaveLength(0); expect(edits).toBe(1);
  editing.resolve(mailSuccess({ requestId, model: 'test', segments: [{ id: 'body', text: 'Edited <text>' }] }));
  await pending;
  expect(sent).toHaveLength(1);
  expect(sent[0]!.to).toEqual(['recipient@example.test']);
  expect(sent[0]!.subject).toBe('Keep subject');
  expect(sent[0]!.html).toContain('Edited &lt;text&gt;');
  composer.dismissNotice();
});

test('editing failures retain the rough draft and never reach Mail', async () => {
  let sends = 0;
  const composer = new MailComposer(mailApiFixture({ polish: async () => mailFailure('editing-failed'),
    send: async input => { sends++; return mailSuccess({ operationId: input.operationId, accepted: true }); } }));
  await composer.start(); composer.edit({ to: 'recipient@example.test', body: 'Keep my rough draft' });
  await composer.send();
  expect(sends).toBe(0);
  expect(composer.getSnapshot().form?.body).toBe('Keep my rough draft');
  expect(composer.getSnapshot().busy).toBe(false);
  expect(composer.getSnapshot().blocked).toBe(false);
});

async function withNoticeClock(run: (clock: { advance: (milliseconds: number) => void; pending: () => number }) => Promise<void>) {
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const previous = {
    setTimeout: Object.getOwnPropertyDescriptor(globalThis, 'setTimeout')!,
    clearTimeout: Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout')!,
  };
  Object.defineProperties(globalThis, {
    setTimeout: { configurable: true, writable: true, value: (callback: () => void, delay: number) => {
      timers.set(++sequence, { at: now + delay, callback });
      return sequence;
    } },
    clearTimeout: { configurable: true, writable: true, value: (id: number) => { timers.delete(id); } },
  });
  try {
    await run({ pending: () => timers.size, advance: milliseconds => {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
    } });
  } finally { Object.defineProperties(globalThis, previous); }
}

test('send notice expires ten seconds after acknowledgement even across navigation', async () => {
  await withNoticeClock(async clock => {
    const accepted = createMailDeferred<void>();
    const api = mailApiFixture({ send: async input => {
      await accepted.promise;
      return mailSuccess({ operationId: input.operationId, accepted: true });
    } });
    const composer = mailComposer(api);
    await composer.start(); composer.edit({ to: 'recipient@example.test', body: 'Test notice' });
    const pending = composer.send();
    await Promise.resolve();
    clock.advance(20_000);
    expect(composer.getSnapshot().notice).toBeNull();
    expect(clock.pending()).toBe(0);
    accepted.resolve(); await pending;
    expect(composer.getSnapshot().notice).toBeTruthy();
    expect(clock.pending()).toBe(1);
    const unsubscribe = composer.subscribe(() => {});
    unsubscribe();
    clock.advance(9_999);
    expect(mailComposer(api)).toBe(composer);
    expect(composer.getSnapshot().notice).toBeTruthy();
    clock.advance(1);
    expect(composer.getSnapshot().notice).toBeNull();
    expect(clock.pending()).toBe(0);
  });
});

test('dismissing a send notice clears its timer and does not affect subsequent drafts', async () => {
  await withNoticeClock(async clock => {
    const composer = new MailComposer(mailApiFixture());
    await composer.start(); composer.edit({ to: 'recipient@example.test', body: 'First message' });
    await composer.send();
    composer.dismissNotice(); composer.dismissNotice();
    expect(composer.getSnapshot().notice).toBeNull();
    expect(clock.pending()).toBe(0);
    await composer.start(); composer.edit({ body: 'Next draft' });
    clock.advance(10_000);
    expect(composer.getSnapshot().form?.body).toBe('Next draft');
    expect(composer.getSnapshot().visible).toBe(true);
  });
});

test('a fresh compose cancels the previous notice so each accepted send gets ten seconds', async () => {
  await withNoticeClock(async clock => {
    const composer = new MailComposer(mailApiFixture());
    await composer.start(); composer.edit({ to: 'recipient@example.test', body: 'First message' });
    await composer.send();
    clock.advance(9_000);
    await composer.start();
    expect(composer.getSnapshot().notice).toBeNull();
    expect(clock.pending()).toBe(0);
    composer.edit({ to: 'recipient@example.test', body: 'Second message' });
    await composer.send();
    clock.advance(1_000);
    expect(composer.getSnapshot().notice).toBeTruthy();
    clock.advance(8_999);
    expect(composer.getSnapshot().notice).toBeTruthy();
    clock.advance(1);
    expect(composer.getSnapshot().notice).toBeNull();
    expect(clock.pending()).toBe(0);
  });
});

test('failed sends keep their error and never start a success notice timer', async () => {
  await withNoticeClock(async clock => {
    const composer = new MailComposer(mailApiFixture({ send: async () => mailFailure('send-unknown') }));
    await composer.start(); composer.edit({ to: 'recipient@example.test', body: 'Keep on failure' });
    await composer.send();
    const error = composer.getSnapshot().error;
    expect(error).toBeTruthy();
    expect(composer.getSnapshot().notice).toBeNull();
    expect(clock.pending()).toBe(0);
    clock.advance(10_000);
    expect(composer.getSnapshot().error).toBe(error);
    expect(composer.getSnapshot().form?.body).toBe('Keep on failure');
  });
});
