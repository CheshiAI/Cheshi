import { describe, expect, test } from 'bun:test';
import type { KeyboardEvent } from 'react';
import { createChatMessageQueue, type ChatQueueDelivery } from '../frontend/src/features/chat/chatMessageQueueStore';
import { createChatDraftRecovery, type ChatDraftSnapshot, type ChatSendResult } from '../frontend/src/features/chat/chatDraftRecovery';
import { handleChatEscape, handleChatComposerKey, submitChatComposerDraft } from '../frontend/src/features/chat/chatComposerKeyboard';

const input = (draft: string): ChatDraftSnapshot => ({ draft, selectedSkill: null, attachments: [] });
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function settle() { for (let index = 0; index < 5; index++) await Promise.resolve(); }
function harness() {
  const calls: { input: ChatDraftSnapshot; delivery: ChatQueueDelivery; result: ReturnType<typeof createDeferred<ChatSendResult>> }[] = [];
  const queue = createChatMessageQueue((input, delivery) => {
    const result = createDeferred<ChatSendResult>();
    calls.push({ input, delivery, result });
    return result.promise;
  });
  const context = (responding: boolean, threadId = 'a', blocked = false) => queue.setContext({ threadId, responding, blocked });
  context(true);
  return { queue, calls, context };
}

describe('queued message delivery', () => {
  test('waits for completion, preserves FIFO, and waits for each accepted turn', async () => {
    const { queue, calls, context } = harness();
    queue.enqueue(input('one')); queue.enqueue(input('two'));
    expect(calls).toHaveLength(0);
    queue.complete('a', 'completed'); context(false);
    expect(calls.map(call => call.input.draft)).toEqual(['one']);
    context(false); context(false);
    expect(calls).toHaveLength(1);
    calls[0]!.result.resolve({ status: 'accepted' }); await settle();
    context(false);
    expect(calls).toHaveLength(1);
    context(true); queue.complete('a', 'completed'); context(false);
    expect(calls.map(call => call.input.draft)).toEqual(['one', 'two']);
    expect(calls[1]!.delivery).toEqual({ threadId: 'a', mode: 'next-turn' });
    calls[1]!.result.resolve({ status: 'accepted' }); await settle();
    expect(queue.getSnapshot().entries).toEqual([]);
  });
  test('completion arriving before acknowledgement does not stall the next message', async () => {
    const { queue, calls, context } = harness();
    queue.enqueue(input('one')); queue.enqueue(input('two')); context(false);
    queue.complete('a', 'completed'); context(false);
    calls[0]!.result.resolve({ status: 'accepted' }); await settle(); context(false);
    expect(calls).toHaveLength(2);
  });
  test('switching threads never redirects a queued message', () => {
    const { queue, calls, context } = harness();
    queue.enqueue(input('only a')); context(false, 'b');
    expect(calls).toHaveLength(0);
    context(false, 'a', true); expect(calls).toHaveLength(0);
    context(false, 'a'); expect(calls[0]!.delivery.threadId).toBe('a');
  });
  test('keeps messages while paused and resumes explicitly', () => {
    const { queue, calls, context } = harness();
    queue.enqueue(input('wait')); queue.pause('a'); context(false);
    expect(calls).toHaveLength(0);
    expect(queue.getSnapshot().entries).toHaveLength(1);
    queue.toggle('a'); expect(calls).toHaveLength(1);
  });
  test.each(['interrupted', 'failed'])('%s completion pauses the queue', (status) => {
    const { queue, calls, context } = harness();
    queue.enqueue(input('wait')); queue.complete('a', status); context(false);
    expect(calls).toHaveLength(0);
    expect(queue.getSnapshot().pausedThreads).toContain('a');
  });
  test('confirmed failures retain the message and retry only when enabled', async () => {
    const { queue, calls, context } = harness();
    queue.enqueue(input('retry')); context(false);
    calls[0]!.result.resolve({ status: 'failed', message: 'Rejected' }); await settle();
    context(false);
    expect(calls).toHaveLength(1);
    expect(queue.getSnapshot().entries[0]).toMatchObject({ status: 'failed', error: 'Rejected' });
    queue.toggle('a'); expect(calls).toHaveLength(2);
  });
  test('uncertain delivery never retries through enable or steer', async () => {
    const { queue, calls, context } = harness();
    queue.enqueue(input('uncertain')); context(false);
    calls[0]!.result.resolve({ status: 'unknown' }); await settle();
    queue.toggle('a'); context(true);
    expect(await queue.steer(queue.getSnapshot().entries[0]!.id)).toBe(false);
    expect(calls).toHaveLength(1);
  });
  test('steers immediately only when running and rejects double clicks', async () => {
    const { queue, calls } = harness();
    queue.enqueue(input('steer'));
    const id = queue.getSnapshot().entries[0]!.id;
    const result = queue.steer(id);
    expect(await queue.steer(id)).toBe(false);
    queue.remove(id); expect(queue.getSnapshot().entries).toHaveLength(1);
    expect(queue.take(id, () => true)).toBe(false);
    expect(calls[0]!.delivery.mode).toBe('steer');
    calls[0]!.result.resolve({ status: 'accepted' }); expect(await result).toBe(true);
    expect(queue.getSnapshot().entries).toHaveLength(0);
  });
  test('failed side-chat creation retains the item; successful transfer removes it once', () => {
    const { queue } = harness();
    queue.enqueue(input('side chat'));
    const id = queue.getSnapshot().entries[0]!.id;
    expect(queue.take(id, () => false)).toBe(false);
    expect(queue.getSnapshot().entries).toHaveLength(1);
    let moves = 0;
    const receive = (value: ChatDraftSnapshot) => { expect(value.draft).toBe('side chat'); moves++; return true; };
    expect(queue.take(id, receive)).toBe(true);
    expect(queue.take(id, receive)).toBe(false);
    expect(moves).toBe(1);
  });
  test('deletion removes only the deleted conversation; unmount suspends sends', () => {
    const { queue, calls, context } = harness();
    queue.enqueue(input('a')); context(true, 'b'); queue.enqueue(input('b'));
    queue.deleteThreads(['a']);
    expect(queue.getSnapshot().entries.map(entry => entry.threadId)).toEqual(['b']);
    queue.suspend(); context(false, 'b'); expect(calls).toHaveLength(0);
    queue.resume(); context(false, 'b'); expect(calls).toHaveLength(1);
  });
});

describe('draft transfer', () => {
  test('atomically queues exact text, attachments and skill; repeated Tab does not duplicate', () => {
    const { queue } = harness();
    const draft = createChatDraftRecovery(async () => ({ status: 'accepted' }));
    const original: ChatDraftSnapshot = { draft: '  next\nmessage ',
      selectedSkill: { name: 'review', displayName: 'Review', description: '', path: '/skills/review', scope: 'repo' },
      attachments: [{ kind: 'image', path: '/tmp/image.png', name: 'Image', previewUrl: 'data:image/png;base64,a' }] };
    draft.receive(original);
    expect(draft.transfer(queue.enqueue)).toBe(true);
    expect(draft.transfer(queue.enqueue)).toBe(false);
    expect(queue.getSnapshot().entries[0]!.input).toEqual(original);
    draft.edit('draft', 'new text');
    const id = queue.getSnapshot().entries[0]!.id;
    expect(queue.take(id, draft.receive)).toBe(false);
    draft.edit('draft', '');
    expect(queue.take(id, draft.receive)).toBe(true);
    expect(draft.getSnapshot()).toMatchObject(original);
  });
  test('unavailable queue and pending draft send never discard input', async () => {
    const { queue, context } = harness(); context(false);
    const result = createDeferred<ChatSendResult>();
    const draft = createChatDraftRecovery(() => result.promise);
    draft.edit('draft', 'keep'); expect(draft.transfer(queue.enqueue)).toBe(false);
    expect(draft.getSnapshot().draft).toBe('keep');
    const sending = draft.submit(); draft.edit('draft', 'new'); context(true);
    expect(draft.transfer(queue.enqueue)).toBe(false);
    result.resolve({ status: 'accepted' }); await sending;
    expect(draft.getSnapshot().draft).toBe('new');
  });
});

function key(key: string, overrides: Partial<KeyboardEvent<HTMLTextAreaElement>> = {}) {
  let prevented = false;
  const event = { key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
    nativeEvent: { isComposing: false, keyCode: 0 }, preventDefault: () => { prevented = true; }, stopPropagation() {}, ...overrides } as KeyboardEvent<HTMLTextAreaElement>;
  return { event, prevented: () => prevented };
}
function keyboardOptions() {
  const calls: string[] = [];
  return { calls, options: { locked: false, menuOpen: false, goalOpen: false, pickerOpen: false,
    closeMenu: () => { calls.push('close'); }, saveGoal: () => { calls.push('goal'); },
    moveOption: (offset: number) => { calls.push(`move:${offset}`); }, activateOption: () => { calls.push('select'); },
    enqueue: () => { calls.push('queue'); return true; }, submit: () => { calls.push('submit'); } } };
}
describe('composer keyboard', () => {
  test('Tab queues and Enter uses the shared submit handler', () => {
    const { calls, options } = keyboardOptions();
    const tab = key('Tab'); handleChatComposerKey(tab.event, options);
    expect(tab.prevented()).toBe(true);
    handleChatComposerKey(key('Enter').event, options);
    expect(calls).toEqual(['queue', 'submit']);
  });
  test('Tab retains normal focus navigation when queuing is unavailable', () => {
    const { options } = keyboardOptions(); const tab = key('Tab');
    handleChatComposerKey(tab.event, { ...options, enqueue: () => false });
    expect(tab.prevented()).toBe(false);
  });
  test('slash and skill menu selection wins over queue insertion', () => {
    const { calls, options } = keyboardOptions();
    handleChatComposerKey(key('Tab').event, { ...options, menuOpen: true, pickerOpen: true });
    expect(calls).toEqual(['select']);
  });
  test('composition, modifier Tab, newline and locked interactions do not enqueue', () => {
    const { calls, options } = keyboardOptions();
    for (const flag of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey']) handleChatComposerKey(key('Tab', { [flag]: true }).event, options);
    handleChatComposerKey(key('Enter', { shiftKey: true }).event, options);
    handleChatComposerKey(key('Tab', { nativeEvent: { isComposing: true } as globalThis.KeyboardEvent }).event, options);
    handleChatComposerKey(key('Enter', { nativeEvent: { keyCode: 229 } as globalThis.KeyboardEvent }).event, options);
    handleChatComposerKey(key('Tab').event, { ...options, locked: true });
    expect(calls).toEqual([]);
  });
});


describe('composer submission policy', () => {
  test('Enter and the send button queue during a response without sending immediately', () => {
    const { queue, calls } = harness();
    const draft = createChatDraftRecovery(async () => { throw new Error('Must not send while responding'); });
    let directSends = 0;
    const submit = () => submitChatComposerDraft({ streaming: true,
      enqueue: () => draft.transfer(queue.enqueue), send: () => { directSends++; } });
    draft.edit('draft', 'via Enter');
    handleChatComposerKey(key('Enter').event, { ...keyboardOptions().options, submit });
    draft.edit('draft', 'via button');
    submit();
    expect(queue.getSnapshot().entries.map(entry => entry.input.draft)).toEqual(['via Enter', 'via button']);
    expect(calls).toHaveLength(0);
    expect(directSends).toBe(0);
    expect(draft.getSnapshot().draft).toBe('');
  });
  test('a blocked queue never falls through to immediate sending or discards the draft', () => {
    const { queue, context } = harness(); context(true, 'a', true);
    const draft = createChatDraftRecovery(async () => ({ status: 'accepted' }));
    draft.edit('draft', 'keep this');
    let directSends = 0;
    submitChatComposerDraft({ streaming: true, enqueue: () => draft.transfer(queue.enqueue), send: () => { directSends++; } });
    expect(directSends).toBe(0);
    expect(draft.getSnapshot().draft).toBe('keep this');
  });
  test('idle submission still sends directly', () => {
    const calls: string[] = [];
    submitChatComposerDraft({ streaming: false, enqueue: () => { calls.push('queue'); return true; }, send: () => { calls.push('send'); } });
    expect(calls).toEqual(['send']);
  });
});


describe('Escape cancels current conversation work', () => {
  function options(cancelAll: () => boolean) {
    return { active: true, locked: false, overlayFocused: false, menuOpen: false, configurationOpen: false,
      closeMenu() {}, closeConfiguration() {}, cancelAll };
  }
  test('pauses and removes every current-thread item before stopping, preserving other threads', () => {
    const { queue, context, calls } = harness();
    queue.enqueue(input('a one')); queue.enqueue(input('a two'));
    context(true, 'b'); queue.enqueue(input('b one')); context(true, 'a');
    const escape = key('Escape');
    let stopped = false;
    handleChatEscape(escape.event, options(() => {
      queue.cancelThread('a');
      expect(queue.getSnapshot().entries.map(entry => entry.threadId)).toEqual(['b']);
      expect(queue.getSnapshot().pausedThreads).toContain('a');
      stopped = true; return true;
    }));
    expect(stopped).toBe(true);
    expect(escape.prevented()).toBe(true);
    queue.complete('a', 'completed'); context(false, 'a');
    expect(calls).toHaveLength(0);
  });
  test.each(['accepted', 'failed', 'unknown'] as const)('late %s delivery does not restore cancelled entries', async (status) => {
    const { queue, context, calls } = harness();
    queue.enqueue(input('starting')); queue.enqueue(input('next')); context(false);
    queue.cancelThread('a');
    calls[0]!.result.resolve({ status }); await settle();
    queue.complete('a', 'completed'); context(false);
    expect(queue.getSnapshot().entries).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });
  test('open menus and configuration take precedence over cancellation', () => {
    const calls: string[] = [];
    const handlers = { ...options(() => { calls.push('stop'); return true; }),
      closeMenu: () => { calls.push('menu'); }, closeConfiguration: () => { calls.push('configuration'); } };
    handleChatEscape(key('Escape').event, { ...handlers, menuOpen: true });
    handleChatEscape(key('Escape').event, { ...handlers, configurationOpen: true });
    expect(calls).toEqual(['menu', 'configuration']);
  });
  test('does not cancel for inactive panes, overlays, locks, IME, repeats or consumed Escape', () => {
    let cancellations = 0;
    const handlers = options(() => { cancellations++; return true; });
    for (const override of [{ active: false }, { locked: true }, { overlayFocused: true }]) {
      handleChatEscape(key('Escape').event, { ...handlers, ...override });
    }
    for (const override of [{ repeat: true }, { defaultPrevented: true }, { ctrlKey: true },
      { nativeEvent: { isComposing: true } as globalThis.KeyboardEvent }]) {
      handleChatEscape(key('Escape', override).event, handlers);
    }
    expect(cancellations).toBe(0);
  });
  test('unhandled Escape retains its default behavior when there is no current work', () => {
    const escape = key('Escape'); handleChatEscape(escape.event, options(() => false));
    expect(escape.prevented()).toBe(false);
  });
});
