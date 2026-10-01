import { expect, test } from 'bun:test';
import { sendRichMail } from '../lib/apple-mail-rich-send.mts';
import { mailFailure } from '../shared/apple-mail';
import { mailMutationFixture } from './apple-mail-mutation-fixture';
import { mailSendFixture, mailBox, createMailDeferred } from './apple-mail-fixtures';

const input = { ...mailSendFixture, html: '<p>Message</p>', reply: { target: { mailbox: mailBox, id: 1 }, all: false } };
test('rich preparation never activates Mail for new messages, replies, or reply-all', () => {
  for (const reply of [null, input.reply, { ...input.reply, all: true }]) {
    const fixture = mailMutationFixture();
    expect(fixture.run({ action: 'prepare-rich', input: { ...input, reply } })).toEqual({
      ok: true, value: { id: 42, title: `Cheshi-${input.operationId}` },
    });
    expect(fixture.actions).not.toContain('activate');
    expect(fixture.actions).not.toContain('send');
    expect(fixture.outgoing()!.toRecipients()).toHaveLength(0);
    expect(fixture.outgoing()!.ccRecipients()).toHaveLength(0);
    expect(fixture.outgoing()!.bccRecipients()).toHaveLength(0);
  }
});
test('rich reply preparation clears all recipients and retains the native reply target', () => {
  const fixture = mailMutationFixture();
  expect(fixture.run({ action: 'prepare-rich', input })).toEqual({ ok: true, value: { id: 42, title: `Cheshi-${input.operationId}` } });
  expect(fixture.actions[0]).toBe('reply');
  expect(fixture.actions).not.toContain('send');
  expect(fixture.outgoing()!.toRecipients()).toHaveLength(0);
  fixture.paste(input.body);
  expect(fixture.run({ action: 'send-rich', input, outgoingId: 42 })).toEqual({ ok: true, value: { operationId: input.operationId, accepted: true } });
  expect(fixture.outgoing()!.toRecipients().map(recipient => recipient.address())).toEqual(input.to);
  expect(fixture.actions.filter(action => action === 'send')).toHaveLength(1);
});
test('rich final stage rejects a wrong window or duplicate dispatch without reading stale scripting content', () => {
  const fixture = mailMutationFixture();
  fixture.run({ action: 'prepare-rich', input });
  for (const id of [9]) {
    expect(fixture.run({ action: 'send-rich', input, outgoingId: id })).toEqual({ ok: false, error: { code: 'preparation-failed' } });
  }
  expect(fixture.actions).not.toContain('send');
  fixture.paste(input.body);
  fixture.run({ action: 'send-rich', input, outgoingId: 42 });
  expect(fixture.run({ action: 'send-rich', input, outgoingId: 42 })).toEqual({ ok: false, error: { code: 'preparation-failed' } });
  expect(fixture.actions.filter(action => action === 'send')).toHaveLength(1);
});
function decode(source: string) {
  const start = source.lastIndexOf('})(') + 3;
  return JSON.parse(source.slice(start, -3)) as { action: string };
}
test('rich delivery checks accessibility before creating a draft and never sends after a paste failure', async () => {
  const calls: string[] = [];
  const execute = async (source: string) => {
    calls.push(decode(source).action);
    return JSON.stringify({ ok: true, value: { id: 42, title: `Cheshi-${input.operationId}` } });
  };
  expect(await sendRichMail(input, execute, async () => { throw new Error('accessibility'); })).toEqual(mailFailure('accessibility'));
  expect(calls).toEqual([]);
  expect(await sendRichMail(input, execute, async request => { if (request.action === 'paste') throw new Error('failed'); }))
    .toEqual(mailFailure('preparation-failed'));
  expect(calls).toEqual(['prepare-rich']);
});
test('rich delivery serializes workspace access and preserves uncertainty after final dispatch', async () => {
  const gate = createMailDeferred<void>();
  const actions: string[] = [];
  const execute = async (source: string) => {
    const action = decode(source).action; actions.push(action);
    if (action === 'send-rich') throw new Error('lost response');
    return JSON.stringify({ ok: true, value: { id: 42, title: `Cheshi-${input.operationId}` } });
  };
  const first = sendRichMail(input, execute, () => gate.promise);
  expect(await sendRichMail(input, execute)).toEqual(mailFailure('busy'));
  gate.resolve();
  expect(await first).toEqual(mailFailure('send-unknown'));
  expect(actions).toEqual(['prepare-rich', 'send-rich']);
});
