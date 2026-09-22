import { expect, test } from 'bun:test';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appleMailScript, type MailCommand } from '../lib/apple-mail-script.mts';
import { MAIL_BODY_LIMIT, mailboxes, mailMessage, mailPage, mailReply } from '../shared/apple-mail';

interface Named { name(): string; id(): string | number; exists(): boolean }
function collection<T extends Named>(items: T[], rejectsName = false) {
  const missing = { exists: () => false };
  return Object.assign(items, {
    byName: (name: string) => rejectsName ? missing : items.find(item => item.name() === name) ?? missing,
    byId: (id: string | number) => items.find(item => item.id() === id) ?? missing,
  });
}
function fixture(rejectsName = false) {
  let contentReads = 0;
  let summaryReads = 0;
  const messages = collection(Array.from({ length: 51 }, (_, i) => ({
    id: () => i + 1, name: () => `Message ${i + 1}`, exists: () => true,
    subject: () => { summaryReads++; return i === 0 ? '' : `Message ${i + 1}`; },
    sender: () => 'Sender <sender@example.test>', readStatus: () => false, flaggedStatus: () => false,
    toRecipients: () => [{ address: () => 'me@example.test' }], ccRecipients: () => [], replyTo: () => 'sender@example.test',
    dateReceived: () => new Date('2026-09-22T00:00:00Z'), dateSent: () => new Date(NaN),
    content: () => { contentReads++; return i === 0 ? '<script>private</script>' : 'x'.repeat(MAIL_BODY_LIMIT + 1); },
  })));
  const child = { name: () => 'Nested " / \\ box', id: () => 'child', exists: () => true, unreadCount: () => 0,
    mailboxes: collection<Named>([]), messages };
  const inbox = { name: () => 'INBOX', id: () => 'box', exists: () => true, unreadCount: () => 51,
    mailboxes: collection([child], rejectsName), messages };
  const accounts = collection(['a', 'b'].map(id => ({ name: () => `Account ${id}`, id: () => id,
    exists: () => true, enabled: () => true, mailboxes: collection([inbox], rejectsName) })));
  const app = { accounts: Object.assign(() => accounts, { byId: accounts.byId }), mailboxes: collection([child], rejectsName) };
  const run = (command: MailCommand): unknown => JSON.parse(vm.runInNewContext(appleMailScript(command), {
    Application: (id: string) => { expect(id).toBe('com.apple.mail'); return app; }, Date,
  }));
  return { run, contentReads: () => contentReads, summaryReads: () => summaryReads };
}

test('JXA enumerates account and nested mailboxes without opening messages', () => {
  const data = fixture();
  const result = mailReply(data.run({ action: 'mailboxes' }), mailboxes);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected mailboxes');
  expect(result.value.map(box => [box.accountId, box.path])).toEqual([
    ['a', ['INBOX']], ['a', ['INBOX', 'Nested " / \\ box']],
    ['b', ['INBOX']], ['b', ['INBOX', 'Nested " / \\ box']], [null, ['Nested " / \\ box']],
  ]);
  expect(data.contentReads()).toBe(0); expect(data.summaryReads()).toBe(0);
});

test('JXA lists only the requested page and fetches selected body separately', () => {
  const data = fixture();
  const mailbox = { accountId: 'b', path: ['INBOX'] };
  const first = mailReply(data.run({ action: 'list', mailbox, offset: 0 }), value => mailPage(value, 0));
  expect(first.ok && first.value.messages.length).toBe(50);
  expect(first.ok && first.value.nextOffset).toBe(50);
  expect(data.summaryReads()).toBe(50); expect(data.contentReads()).toBe(0);
  const last = mailReply(data.run({ action: 'list', mailbox, offset: 50 }), value => mailPage(value, 50));
  expect(last.ok && last.value.nextOffset).toBeNull();
  expect(last.ok && last.value.messages[0]?.id).toBe(51);
  const read = mailReply(data.run({ action: 'read', target: { mailbox, id: 1 } }), value => mailMessage(value, 1));
  expect(read.ok && read.value.body).toBe('<script>private</script>');
  expect(data.contentReads()).toBe(1);
  const long = mailReply(data.run({ action: 'read', target: { mailbox, id: 2 } }), value => mailMessage(value, 2));
  expect(long.ok && long.value.bodyTruncated).toBe(true);
  expect(long.ok && long.value.body.length).toBe(MAIL_BODY_LIMIT);
});

test('quoted mailbox paths stay data and missing targets return a controlled error', () => {
  const data = fixture();
  const mailbox = { accountId: null, path: ['Nested " / \\ box'] };
  const result = mailReply(data.run({ action: 'list', mailbox, offset: 0 }), value => mailPage(value, 0));
  expect(result.ok).toBe(true);
  expect(data.run({ action: 'read', target: { mailbox, id: 99 } })).toEqual({ ok: false, error: { code: 'not-found' } });
  expect(data.run({ action: 'list', mailbox: { accountId: 'missing', path: ['INBOX'] }, offset: 0 })).toEqual({ ok: false, error: { code: 'not-found' } });
});

test('enumerated account, nested and local mailboxes remain readable when Mail rejects by-name specifiers', () => {
  const data = fixture(true);
  const listed = mailReply(data.run({ action: 'mailboxes' }), mailboxes);
  expect(listed.ok).toBe(true);
  if (!listed.ok) throw new Error('Expected mailboxes');
  for (const mailbox of listed.value) {
    const page = mailReply(data.run({ action: 'list', mailbox, offset: 0 }), value => mailPage(value, 0));
    expect(page.ok && page.value.messages.length).toBe(50);
    const body = mailReply(data.run({ action: 'read', target: { mailbox, id: 1 } }), value => mailMessage(value, 1));
    expect(body.ok && body.value.body).toBe('<script>private</script>');
  }
  expect(data.run({ action: 'list', mailbox: { accountId: 'a', path: ['INBOX', 'deleted'] }, offset: 0 }))
    .toEqual({ ok: false, error: { code: 'not-found' } });
});

test('JXA returns permission errors without leaking native exception contents', () => {
  const result = JSON.parse(vm.runInNewContext(appleMailScript({ action: 'mailboxes' }), {
    Application: () => { throw Object.assign(new Error('private'), { errorNumber: -1743 }); },
  }));
  expect(result).toEqual({ ok: false, error: { code: 'permission' } });
});

test.skipIf(process.platform !== 'darwin')('Mail script compiles in native JavaScript for Automation without executing it', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-mail-script-'));
  try {
    const result = spawnSync('/usr/bin/osacompile', ['-l', 'JavaScript', '-o', path.join(directory, 'mail.scpt')], {
      input: appleMailScript({ action: 'mailboxes' }), encoding: 'utf8',
    });
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
