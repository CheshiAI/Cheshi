import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createIMessageNotifications } from '../lib/imessage-notifications.mts';
import { createNotificationEvents } from '../lib/notification-events.mts';
import { DEFAULT_IMESSAGE_PREFERENCES, parseIMessagePreferences, parseIMessageRecipient } from '../shared/imessage-notifications';

async function rejects(operation: Promise<unknown>, pattern: RegExp) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect(String(failure)).toMatch(pattern);
}
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
async function fixture(send?: (recipient: string, text: string, signal: AbortSignal) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-imessage-test-'));
  const sent: { recipient: string; text: string }[] = [];
  const filename = path.join(directory, 'notifications.json');
  const events = createNotificationEvents({ filename: path.join(directory, 'events.json'), legacyIMessageFilename: filename });
  const service = createIMessageNotifications({ filename, events, platform: 'darwin', send: send ?? (async (recipient, text) => { sent.push({ recipient, text }); }) });
  await service.get();
  return { service, events, sent, filename, async close() { await service.dispose(); await rm(directory, { recursive: true, force: true }); } };
}
const enabled = { ...DEFAULT_IMESSAGE_PREFERENCES, enabled: true, recipient: '+821012345678' };
const event = { kind: 'completed' as const, workspace: 'fixture', conversation: 'chat-one' };
async function settled() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

test('settings validate literal switches and iMessage addresses, never accepting script input', () => {
  expect(parseIMessageRecipient(' +821012345678 ')).toBe('+821012345678');
  expect(parseIMessageRecipient('me@example.com')).toBe('me@example.com');
  for (const recipient of ['123', 'x" & do shell script "id', 'me@example.com\nother@example.com', '']) {
    expect(() => parseIMessageRecipient(recipient)).toThrow();
  }
  for (const value of [1, 'true', null]) expect(() => parseIMessagePreferences({ ...enabled, enabled: value })).toThrow();
  expect(parseIMessagePreferences(DEFAULT_IMESSAGE_PREFERENCES).enabled).toBe(false);
});

test('defaults never send, configured category filters apply, and settings persist', async () => {
  const f = await fixture();
  try {
    f.service.notify(event); await settled(); expect(f.sent).toHaveLength(0);
    f.events.set('completed', false);
    await f.service.save(enabled);
    f.service.notify(event); f.service.notify({ ...event, kind: 'attention' }); await settled();
    expect(f.sent).toHaveLength(1); expect(f.sent[0]!.text).toContain('needs your response');
    expect(JSON.parse(await readFile(f.filename, 'utf8'))).toEqual(enabled);
    expect(f.events.get().completed).toBe(false);
  } finally { await f.close(); }
});

test('an explicit test sends once while automation is off and describes submission truthfully', async () => {
  const f = await fixture();
  try {
    await f.service.save({ ...enabled, enabled: false });
    f.events.set('completed', false); f.events.set('attention', false); f.events.set('failed', false);
    const state = await f.service.test();
    expect(f.sent).toEqual([{ recipient: enabled.recipient, text: 'Cheshi: iMessage notification connection test.' }]);
    expect(state.lastStatus).toContain('not confirmed');
  } finally { await f.close(); }
});

test.each(['completed', 'attention', 'failed'] as const)('common %s event switch cancels current and queued iMessages without affecting delivery preference', async kind => {
  let attempts = 0;
  const started = createDeferred<void>();
  const f = await fixture(async (_recipient, _text, signal) => {
    attempts++; started.resolve();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
  });
  try {
    await f.service.save(enabled);
    f.service.notify({ ...event, kind }); await started.promise;
    f.service.notify({ ...event, kind });
    f.events.set(kind, false); f.events.set(kind, true);
    await settled();
    expect(attempts).toBe(1); expect((await f.service.get()).enabled).toBe(true);
  } finally { await f.close(); }
});

test('turning off cancels an active send and prevents queued notifications from being sent', async () => {
  let attempts = 0;
  const started = createDeferred<void>();
  const f = await fixture(async (_recipient, _text, signal) => {
    attempts++; started.resolve();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
  });
  try {
    await f.service.save(enabled); f.service.notify(event); await started.promise;
    f.service.notify({ ...event, kind: 'attention' });
    await f.service.save({ ...enabled, enabled: false }); await settled();
    expect(attempts).toBe(1); expect((await f.service.get()).enabled).toBe(false);
  } finally { await f.close(); }
});

test('permission failures are visible without retries or rejection into the chat', async () => {
  let attempts = 0;
  const f = await fixture(async () => { attempts++; throw new Error('Allow automation in System Settings.'); });
  try {
    await f.service.save(enabled); f.service.notify(event); await settled();
    expect(attempts).toBe(1); expect((await f.service.get()).lastStatus).toContain('Allow automation');
  } finally { await f.close(); }
});

test('no recipient and unsupported platforms cannot test-send', async () => {
  const f = await fixture();
  try { await rejects(f.service.test(), /international number/); expect(f.sent).toHaveLength(0); }
  finally { await f.close(); }
  const service = createIMessageNotifications({ filename: '/nonexistent/cheshi-test.json', platform: 'linux' });
  await rejects(service.test(), /macOS/); await service.dispose();
});
