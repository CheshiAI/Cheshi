import { expect, test } from 'bun:test';
import type { KeyboardEvent } from 'react';
import { handleChatComposerKeyDown } from '../frontend/src/features/chat/chatComposerKeyDown';
import { createChatDraftRecovery } from '../frontend/src/features/chat/chatDraftRecovery';

function press(key: string, patch: Partial<KeyboardEvent<HTMLTextAreaElement>> = {},
  options: Partial<Parameters<typeof handleChatComposerKeyDown>[1]> = {}) {
  const calls: string[] = [];
  const event = { key, nativeEvent: {}, preventDefault: () => calls.push('prevent'), ...patch } as KeyboardEvent<HTMLTextAreaElement>;
  handleChatComposerKeyDown(event, {
    interactionsLocked: false, commandMenuOpen: false, goalEditorOpen: false, optionPickerOpen: false,
    closeCommandMenu: () => calls.push('close'), saveGoal: () => calls.push('goal'),
    moveHighlightedOption: direction => calls.push(`move:${direction}`), activateHighlightedOption: () => calls.push('select'),
    queueDraft: () => { calls.push('queue'); return true; }, submit: () => calls.push('send'), ...options,
  });
  return calls;
}

test('Tab queues without sending; Enter sends immediately; Shift+Enter retains newline', () => {
  expect(press('Tab')).toEqual(['queue', 'prevent']);
  expect(press('Enter')).toEqual(['prevent', 'send']);
  expect(press('Enter', { shiftKey: true })).toEqual([]);
});

test('ordinary Tab navigation remains when a draft cannot be queued', () => {
  expect(press('Tab', {}, { queueDraft: () => false })).toEqual([]);
  for (const modifier of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey', 'repeat']) {
    expect(press('Tab', { [modifier]: true })).toEqual([]);
  }
  expect(press('Tab', {}, { interactionsLocked: true })).toEqual([]);
});

test('IME input and key code 229 cannot queue or send', () => {
  for (const key of ['Tab', 'Enter']) {
    expect(press(key, { nativeEvent: { isComposing: true } as globalThis.KeyboardEvent })).toEqual([]);
    expect(press(key, { nativeEvent: { keyCode: 229 } as globalThis.KeyboardEvent })).toEqual([]);
  }
});

test('command menus retain their existing selection and navigation keys', () => {
  const menu = { commandMenuOpen: true, optionPickerOpen: true };
  expect(press('Tab', {}, menu)).toEqual(['prevent', 'select']);
  expect(press('Enter', {}, menu)).toEqual(['prevent', 'select']);
  expect(press('ArrowDown', {}, menu)).toEqual(['prevent', 'move:1']);
  expect(press('Escape', {}, menu)).toEqual(['prevent', 'close']);
  expect(press('Tab', {}, { commandMenuOpen: true })).toEqual([]);
  expect(press('Enter', {}, { ...menu, goalEditorOpen: true })).toEqual(['prevent', 'goal']);
});

test('queue acceptance clears the complete draft; rejection preserves it', () => {
  const draft = createChatDraftRecovery(async () => { throw new Error('Queue must not send immediately'); });
  draft.edit('draft', '  Next instruction\n');
  draft.edit('attachments', [{ kind: 'file', path: '/workspace/file.ts', name: 'file.ts' }]);
  const snapshot = draft.getSnapshot();
  expect(draft.queue(() => false)).toBe(false);
  expect(draft.getSnapshot()).toBe(snapshot);
  expect(draft.queue(input => {
    expect(input.draft).toBe(snapshot.draft);
    expect(input.attachments).toEqual(snapshot.attachments);
    return true;
  })).toBe(true);
  expect(draft.getSnapshot()).toMatchObject({ draft: '', attachments: [], selectedSkill: null, pending: false });
  expect(draft.queue(() => { throw new Error('Empty input'); })).toBe(false);
});
