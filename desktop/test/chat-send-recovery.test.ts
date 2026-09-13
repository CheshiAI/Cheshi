import { describe, expect, test } from 'bun:test';
import { createChatDraftRecovery, type ChatSendResult } from '../frontend/src/features/chat/chatDraftRecovery';
import { observeChatSendAttempt, performChatSend, type ChatSendAttempt } from '../frontend/src/features/chat/chatSendAttempt';
import type { ChatSkill } from '../frontend/src/features/chat/model';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const skill: ChatSkill = { name: 'review', displayName: 'Review', description: '', path: '/skills/review', scope: 'repo' };
const attachment = { kind: 'image' as const, path: '/tmp/screenshot.png', name: 'Screenshot', previewUrl: 'data:image/png;base64,a' };

describe('failed chat draft recovery', () => {
  test('restores exact text, selected skill, and attachments after a confirmed rejection', async () => {
    const store = createChatDraftRecovery(async () => ({ status: 'failed', message: 'Rejected' }));
    store.edit('draft', '  Fix the issue\n');
    store.edit('selectedSkill', skill);
    store.edit('attachments', [attachment]);
    expect(await store.submit()).toBe(false);
    expect(store.getSnapshot()).toMatchObject({ draft: '  Fix the issue\n', selectedSkill: skill,
      attachments: [attachment], pending: false, recovery: { status: 'restored' } });
  });

  test('does not overwrite edits, even if the user types then clears their draft', async () => {
    const pending = createDeferred<ChatSendResult>();
    const store = createChatDraftRecovery(() => pending.promise);
    store.edit('draft', 'First request');
    const sending = store.submit();
    store.edit('draft', 'Another request');
    pending.resolve({ status: 'failed' });
    await sending;
    expect(store.getSnapshot().draft).toBe('Another request');
    expect(store.restore()).toBe(false);
    store.edit('draft', '');
    expect(store.restore()).toBe(true);
    expect(store.getSnapshot().draft).toBe('First request');
  });

  test('synchronously prevents duplicate submits and ignores a failure from a previous session', async () => {
    const pending = createDeferred<ChatSendResult>();
    let calls = 0;
    const store = createChatDraftRecovery(() => { calls += 1; return pending.promise; });
    store.edit('draft', 'Old request');
    const sending = store.submit();
    store.edit('draft', 'New text');
    expect(await store.submit()).toBe(false);
    expect(calls).toBe(1);
    store.reset();
    store.edit('draft', 'Another session');
    pending.resolve({ status: 'failed' });
    await sending;
    expect(store.getSnapshot()).toMatchObject({ draft: 'Another session', recovery: null, pending: false });
  });

  test('does not offer automatic or one-click resend when delivery is uncertain', async () => {
    const store = createChatDraftRecovery(async () => ({ status: 'unknown', message: 'Disconnected' }));
    store.edit('draft', 'Run an operation');
    await store.submit();
    expect(store.getSnapshot()).toMatchObject({ draft: '', recovery: { status: 'unknown' } });
    expect(store.restore()).toBe(false);
  });

  test('successful sends leave edits made during submission intact', async () => {
    const pending = createDeferred<ChatSendResult>();
    const store = createChatDraftRecovery(() => pending.promise);
    store.edit('draft', 'First');
    const sending = store.submit();
    store.edit('draft', 'Next');
    pending.resolve({ status: 'accepted' });
    expect(await sending).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ draft: 'Next', pending: false, recovery: null });
  });
});

describe('chat send acknowledgement', () => {
  const attempt = (): ChatSendAttempt => ({ clientMessageId: 'client', threadId: null, accepted: false });
  test('retains a matching server acknowledgement when the IPC response fails later', async () => {
    const current = attempt();
    const result = await performChatSend(current, async () => {
      observeChatSendAttempt(current, { type: 'turn-started', threadId: 'new-thread', clientMessageId: 'client' });
      throw new Error('IPC closed');
    });
    expect(result.status).toBe('accepted');
    expect(current.threadId).toBe('new-thread');
  });
  test('does not mistake a different user message or selection for an acceptance', async () => {
    const current = attempt();
    observeChatSendAttempt(current, { type: 'session-selected', threadId: 'new-thread' });
    observeChatSendAttempt(current, { type: 'user-message', threadId: 'new-thread', clientMessageId: 'other' });
    expect((await performChatSend(current, async () => { throw new Error('Timeout'); })).status).toBe('unknown');
  });
  test('distinguishes a confirmed server rejection from malformed or missing delivery results', async () => {
    expect(await performChatSend(attempt(), async () => ({ sendFailure: 'failed', message: 'Too large' })))
      .toEqual({ status: 'failed', message: 'Too large' });
    expect((await performChatSend(attempt(), async () => ({}))).status).toBe('unknown');
    expect((await performChatSend(attempt(), async () => ({ threadId: 'new-thread' }))).status).toBe('accepted');
  });
});
