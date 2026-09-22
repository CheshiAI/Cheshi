import { expect, test } from 'bun:test';
import { AppleMailService } from '../lib/apple-mail-service.mts';
import type { MailCommand } from '../lib/apple-mail-script.mts';
import { createAppleMailApi } from '../lib/apple-mail-preload.cts';
import { mailChange, mailSend, mailFailure, mailSent, mailChanged } from '../shared/apple-mail';
import { mailBox, mailSendFixture as input, createMailDeferred, mailSuccess } from './apple-mail-fixtures';
import { mailMutationFixture } from './apple-mail-mutation-fixture';

const target = { mailbox: mailBox, id: 1 };
test('read and flag changes address one message; moving to trash uses move instead of delete', () => {
  const fixture = mailMutationFixture();
  expect(fixture.run({ action: 'change', input: { action: 'read', target, value: true } })).toEqual(mailSuccess(target));
  expect(fixture.message.readStatus()).toBe(true);
  expect(fixture.run({ action: 'change', input: { action: 'flag', target, value: true } })).toEqual(mailSuccess(target));
  expect(fixture.message.flaggedStatus()).toBe(true);
  expect(fixture.run({ action: 'change', input: { action: 'read', target, value: false } })).toEqual(mailSuccess(target));
  expect(fixture.message.readStatus()).toBe(false);
  expect(fixture.run({ action: 'change', input: { action: 'move', target, destination: { ...mailBox, path: ['Trash'] } } })).toEqual(mailSuccess(target));
  expect(fixture.trashMessages).toHaveLength(1); expect(fixture.actions).toEqual(['move']);
});

test('ambiguous mailbox aliases are rejected before changing any message', () => {
  const fixture = mailMutationFixture({ ambiguous: true });
  expect(fixture.run({ action: 'change', input: { action: 'read', target, value: true } }))
    .toEqual({ ok: false, error: { code: 'ambiguous-mailbox' } });
  expect(fixture.message.readStatus()).toBe(false);
});

test('moves confirm new local IDs and delayed arrivals without mistaking an existing copy for the moved message', () => {
  const command: MailCommand = { action: 'change', input: { action: 'move', target, destination: { ...mailBox, path: ['Trash'] } } };
  for (const moveMode of ['renumber', 'delayed'] as const) {
    const fixture = mailMutationFixture({ moveMode, existingCopy: true });
    expect(fixture.run(command)).toEqual(mailSuccess(target));
    expect(fixture.trashMessages.map(message => message.id())).toEqual([20, 2]);
    expect(fixture.actions).toEqual(['move']);
  }
  for (const moveMode of ['noop', 'copy', 'lost'] as const) {
    const fixture = mailMutationFixture({ moveMode, existingCopy: true });
    expect(fixture.run(command)).toEqual({ ok: false, error: { code: 'change-unknown' } });
    expect(fixture.actions).toEqual(['move']);
  }
});

test('messages without an RFC Message-ID only confirm moves when their local ID survives', () => {
  const command: MailCommand = { action: 'change', input: { action: 'move', target, destination: { ...mailBox, path: ['Trash'] } } };
  expect(mailMutationFixture({ messageId: '' }).run(command)).toEqual(mailSuccess(target));
  expect(mailMutationFixture({ messageId: '', moveMode: 'renumber' }).run(command))
    .toEqual({ ok: false, error: { code: 'change-unknown' } });
});

test('move confirmation retries transient native reference errors without repeating the move', () => {
  const command: MailCommand = { action: 'change', input: { action: 'move', target, destination: { ...mailBox, path: ['Trash'] } } };
  const recovered = mailMutationFixture({ moveMode: 'renumber', moveReadFailures: 2 });
  expect(recovered.run(command)).toEqual(mailSuccess(target));
  expect(recovered.actions).toEqual(['move']);
  const unavailable = mailMutationFixture({ moveMode: 'renumber', moveReadFailures: 100 });
  expect(unavailable.run(command)).toEqual({ ok: false, error: { code: 'change-unknown' } });
  expect(unavailable.actions).toEqual(['move']);
});

test('new mail and both reply modes send only the confirmed sender and recipients through native Mail', () => {
  for (const reply of [null, { target, all: false }, { target, all: true }]) {
    const fixture = mailMutationFixture();
    const request = { ...input, reply, cc: ['cc@example.test'], bcc: ['hidden@example.test'] };
    expect(fixture.run({ action: 'send', input: request })).toEqual(mailSuccess({ operationId: input.operationId, accepted: true }));
    expect(fixture.actions[0]).toBe(reply ? (reply.all ? 'reply-all' : 'reply') : 'create');
    expect(fixture.actions.at(-1)).toBe('send');
    const outgoing = fixture.outgoing()!;
    expect(outgoing.sender()).toBe(input.sender); expect(outgoing.subject()).toBe(input.subject); expect(outgoing.content()).toBe(input.body);
    expect(outgoing.toRecipients().map(item => item.address())).toEqual(input.to);
    expect(outgoing.ccRecipients().map(item => item.address())).toEqual(request.cc);
    expect(outgoing.bccRecipients().map(item => item.address())).toEqual(request.bcc);
  }
});

test('unconfigured senders and missing reply targets never reach send; uncertain replies do not claim delivery', () => {
  const fixture = mailMutationFixture();
  expect(fixture.run({ action: 'send', input: { ...input, sender: 'other@example.test' } })).toEqual({ ok: false, error: { code: 'invalid' } });
  expect(fixture.run({ action: 'send', input: { ...input, reply: { target: { ...target, id: 99 }, all: false } } }))
    .toEqual({ ok: false, error: { code: 'not-found' } });
  expect(fixture.actions).toEqual([]);
  for (const options of [{ sendResult: false }, { sendResult: 1 }, { sendThrows: true }]) {
    expect(mailMutationFixture(options).run({ action: 'send', input })).toEqual({ ok: false, error: { code: 'send-unknown' } });
  }
});

test('reply-all clears positional recipient references and never sends if native recipients remain', () => {
  const request = { ...input, reply: { target, all: true }, cc: [], bcc: [] };
  const fixture = mailMutationFixture();
  expect(fixture.run({ action: 'send', input: request })).toEqual(mailSuccess({ operationId: input.operationId, accepted: true }));
  expect(fixture.outgoing()!.toRecipients().map(recipient => recipient.address())).toEqual(input.to);
  expect(fixture.outgoing()!.ccRecipients()).toHaveLength(0);
  expect(fixture.outgoing()!.bccRecipients()).toHaveLength(0);
  const ignored = mailMutationFixture({ recipientDeleteIgnored: true });
  expect(ignored.run({ action: 'send', input: request })).toEqual({ ok: false, error: { code: 'invalid' } });
  expect(ignored.actions).not.toContain('send');
});

test('send and change boundaries reject header injection, invalid flags and different acknowledgements', () => {
  for (const patch of [{ sender: 'me@example.test\r\nBcc:x@example.test' }, { to: ['bad'] }, { to: [] }, { subject: 'hello\nBcc: x' },
    { operationId: 'bad' }, { reply: { target, all: 1 } }]) expect(() => mailSend({ ...input, ...patch })).toThrow();
  expect(() => mailChange({ action: 'read', target, value: 1 })).toThrow();
  expect(() => mailChange({ action: 'move', target, destination: mailBox })).toThrow();
  expect(() => mailSent({ operationId: input.operationId, accepted: 1 }, input.operationId)).toThrow();
  expect(() => mailChanged({ ...target, id: 2 }, target)).toThrow();
});

test('service shares pending sends, remembers uncertain results and rejects operation-id reuse with different contents', async () => {
  const pending = createMailDeferred<string>();
  let executions = 0;
  const service = new AppleMailService({ platform: 'darwin', execute: async () => { executions++; return pending.promise; } });
  const first = service.send(input), second = service.send(input);
  expect(executions).toBe(1);
  expect(await service.send({ ...input, body: 'different' })).toEqual(mailFailure('invalid'));
  pending.resolve('broken output');
  expect(await first).toEqual(mailFailure('send-unknown'));
  expect(await second).toEqual(mailFailure('send-unknown'));
  expect(await service.send(input)).toEqual(mailFailure('send-unknown'));
  expect(executions).toBe(1);
});

test('transport failures for send and mutations preserve uncertainty at service and preload boundaries', async () => {
  const service = new AppleMailService({ platform: 'darwin', execute: async () => { throw new Error('connection lost'); } });
  expect(await service.send(input)).toEqual(mailFailure('send-unknown'));
  expect(await service.change({ action: 'read', target, value: true })).toEqual(mailFailure('change-unknown'));
  const api = createAppleMailApi({ invoke: async (_channel: string, ..._args: unknown[]): Promise<unknown> => { throw new Error('lost'); } }, 'darwin');
  expect(await api.send(input)).toEqual(mailFailure('send-unknown'));
  expect(await api.change({ action: 'flag', target, value: false })).toEqual(mailFailure('change-unknown'));
});
