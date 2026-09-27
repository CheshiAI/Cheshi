import { expect, test } from 'bun:test';
import { createIMessageCommands, messageCommand, type IMessageCommandEndpoint } from '../lib/imessage-commands.mts';
import type { InboxMessage } from '../lib/imessage-inbox.mts';

async function until(condition: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(execute?: IMessageCommandEndpoint['execute']) {
  const rows: InboxMessage[] = [{ rowid: 1, guid: 'old', text: '체시 old command' }];
  const calls: string[] = [], replies: string[] = [];
  let address = 'me@example.com', present = true, reads = 0, targetId = 'target';
  const service = createIMessageCommands({ intervalMs: 2, recipient: async () => address,
    reply: async (_recipient, text) => { replies.push(text); },
    open: () => ({ latest: () => rows.at(-1)?.rowid ?? 0, close() {}, read(after) {
      reads++; return { cursor: rows.at(-1)?.rowid ?? after, messages: rows.filter(row => row.rowid > after) };
    } }),
  });
  service.register('workspace', () => present ? [{ id: targetId, label: targetId, execute: execute ?? (async command => { calls.push(command); return 'Accepted'; }) }] : []);
  const add = (text: string | null, guid = `message-${rows.length}`) => { rows.push({ rowid: rows.length + 1, guid, text }); };
  return { service, calls, replies, add, reads: () => reads,
    continueTarget: (id: string) => { targetId = id; },
    removeTarget: () => { present = false; }, changeRecipient: () => { address = 'other@example.com'; } };
}

test('only bounded, explicit commands are parsed; outbound notifications never loop', () => {
  expect(messageCommand('체시 상태')).toBe('상태');
  expect(messageCommand('체시, 테스트\n이어서 해줘')).toBe('테스트\n이어서 해줘');
  expect(messageCommand('Cheshi status')).toBe('status');
  expect(messageCommand('cheshi STOP')).toBe('STOP');
  expect(messageCommand('Cheshi continue the test')).toBe('continue the test');
  expect(messageCommand('Cheshi 이 내용은 한국어로 유지')).toBe('이 내용은 한국어로 유지');
  for (const value of ['Cheshi', 'Cheshistatus', 'hello Cheshi status', 'Cheshi · work\nWork failed. Check Cheshi.',
    'Cheshi: iMessage notification connection test.', 'Cheshi ' + 'a'.repeat(8000)]) {
    expect(messageCommand(value)).toBeNull();
  }
  for (const value of [null, '', '체시', '체시상태', '안녕 체시 상태', 'Cheshi · work\n접수 완료', '체시 ' + 'a'.repeat(8000)]) {
    expect(messageCommand(value)).toBeNull();
  }
});

test('a confirmed continuation keeps receiving subsequent commands without replaying the first', async () => {
  const calls: string[] = [];
  const f = fixture(async command => {
    calls.push(command);
    if (command === 'first') {
      f.continueTarget('continued');
      return { reply: 'Accepted', continuedTarget: { id: 'continued', label: 'Continued' } };
    }
    return 'Status';
  });
  try {
    await f.service.configure({ enabled: true, targetId: 'target' });
    f.add('Cheshi first', 'first'); f.add('체시 상태');
    await until(() => f.replies.length === 2);
    expect(f.service.get().targetId).toBe('continued'); expect(f.service.get().enabled).toBe(true);
    expect(f.replies[0]).toContain('continued');
    f.add('체시 first', 'first'); f.add('체시 later');
    await until(() => f.replies.length === 3);
    expect(calls).toEqual(['first', '상태', 'later']);
  } finally { await f.service.dispose(); }
});

test('a continuation that is no longer selected does not retarget or execute later commands', async () => {
  let attempts = 0;
  const f = fixture(async () => {
    attempts++; f.continueTarget('unrelated');
    return { reply: 'Accepted', continuedTarget: { id: 'continued', label: 'Continued' } };
  });
  try {
    await f.service.configure({ enabled: true, targetId: 'target' });
    f.add('체시 first'); f.add('체시 second');
    await until(() => !f.service.get().enabled);
    expect(attempts).toBe(1); expect(f.replies).toEqual([]);
    expect(f.service.get().targetId).toBe('target');
  } finally { await f.service.dispose(); }
});

test('arming skips historical rows; new commands execute once even with duplicate GUIDs', async () => {
  const f = fixture();
  try {
    await f.service.configure({ enabled: true, targetId: 'target' });
    f.add('not a command'); f.add('체시 new command', 'same'); f.add('체시 duplicate', 'same');
    await until(() => f.replies.length === 1);
    expect(f.calls).toEqual(['new command']);
    await f.service.configure({ enabled: false, targetId: 'target' });
    f.add('체시 while off');
    await f.service.configure({ enabled: true, targetId: 'target' });
    f.add('체시 after reenable');
    await until(() => f.replies.length === 2);
    expect(f.calls).toEqual(['new command', 'after reenable']);
  } finally { await f.service.dispose(); }
});

test('recipient changes and closing the selected conversation disarm before executing commands', async () => {
  for (const reason of ['recipient', 'target']) {
    const f = fixture();
    try {
      await f.service.configure({ enabled: true, targetId: 'target' });
      if (reason === 'recipient') f.changeRecipient(); else f.removeTarget();
      f.add('체시 must not execute');
      await until(() => !f.service.get().enabled);
      expect(f.calls).toEqual([]); expect(f.replies).toEqual([]);
    } finally { await f.service.dispose(); }
  }
});

test('disabling during execution aborts its lifetime and prevents subsequent commands and replies', async () => {
  const started = deferred(), release = deferred();
  const calls: string[] = [];
  let signal: AbortSignal | undefined;
  const f = fixture(async (command, _id, lifetime) => {
    calls.push(command); signal = lifetime; started.resolve(); await release.promise; return 'Accepted';
  });
  try {
    await f.service.configure({ enabled: true, targetId: 'target' });
    f.add('체시 first'); f.add('체시 second'); await started.promise;
    const stopped = f.service.configure({ enabled: false, targetId: 'target' });
    expect(signal!.aborted).toBe(true); release.resolve(); await stopped;
    expect(calls).toEqual(['first']); expect(f.replies).toEqual([]);
  } finally { release.resolve(); await f.service.dispose(); }
});

test('unknown provider delivery is reported without retries and unsupported bodies do not execute', async () => {
  let attempts = 0;
  const f = fixture(async () => { attempts++; const error = new Error('private provider error'); error.name = 'CodexMessageDeliveryUnknown'; throw error; });
  try {
    await f.service.configure({ enabled: true, targetId: 'target' });
    f.add(null); f.add('체시 run');
    await until(() => f.replies.length === 1);
    await until(() => f.reads() > 3);
    expect(attempts).toBe(1); expect(f.replies[0]).toContain('will not be resent automatically');
    expect(f.replies[0]).not.toContain('private');
  } finally { await f.service.dispose(); }
});

test('invalid switches, targets, and denied access cannot arm the reader', async () => {
  const f = fixture();
  try {
    for (const value of [{ enabled: 'true', targetId: 'target' }, { enabled: true, targetId: 'missing' }]) {
      let failure: unknown;
      try { await f.service.configure(value); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error); expect(f.service.get().enabled).toBe(false);
    }
  } finally { await f.service.dispose(); }
  const service = createIMessageCommands({ recipient: async () => 'me@example.com', reply: async () => {}, open: () => { throw new Error('EPERM'); } });
  service.register('test', () => [{ id: 'target', label: 'Test', execute: async () => '' }]);
  let failure: unknown;
  try { await service.configure({ enabled: true, targetId: 'target' }); } catch (error) { failure = error; }
  expect(String(failure)).toContain('Full Disk Access'); expect(service.get().enabled).toBe(false);
  await service.dispose();
});
