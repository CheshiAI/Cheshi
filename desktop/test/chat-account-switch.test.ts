import { describe, expect, test } from 'bun:test';
import { chatAccountSwitchReason, chatComposerAccountSwitchReason } from '../frontend/src/features/chat/chatAccountSwitch.ts';
import { INITIAL_CHAT_STATE } from '../frontend/src/features/chat/model.ts';

const idle = { state: { ...INITIAL_CHAT_STATE, phase: 'idle' as const }, isOperationPending: () => false };
const ready = { pending: false, relayRunning: false, paneCount: 2, controllers: [idle, idle], composerReasons: [null, null] };

describe('manual account switching guards', () => {
  test('allows idle panes without discarding draft content', () => {
    expect(chatAccountSwitchReason(ready)).toBeNull();
    expect(chatAccountSwitchReason({ ...ready, composerReasons: [null, 'Clear attachments first.'] })).toBe('Clear attachments first.');
  });

  test('requires every pane and composer to be registered', () => {
    expect(chatAccountSwitchReason({ ...ready, controllers: [idle] })).toContain('ready');
    expect(chatAccountSwitchReason({ ...ready, composerReasons: [null] })).toContain('ready');
  });

  test('blocks background turns and synchronous pending operations', () => {
    for (const state of [
      { ...idle.state, responseThreadIds: ['background'] },
      { ...idle.state, pendingNewResponse: true },
      { ...idle.state, phase: 'loading' as const },
    ]) expect(chatAccountSwitchReason({ ...ready, controllers: [idle, { ...idle, state }] })).toContain('active chat');
    expect(chatAccountSwitchReason({ ...ready, controllers: [idle, { ...idle, isOperationPending: () => true }] })).toContain('active chat');
  });

  test('blocks relay and workspace mutations', () => {
    expect(chatAccountSwitchReason({ ...ready, relayRunning: true })).toContain('linked conversation');
    expect(chatAccountSwitchReason({ ...ready, pending: true })).toContain('current operation');
  });
});

describe('composer account switching guards', () => {
  const empty = { pending: false, draft: '', selectedSkill: null, attachmentCount: 0 };
  test('protects draft, skill and attachment content independently', () => {
    for (const content of [{ draft: 'Draft' }, { selectedSkill: {} }, { attachmentCount: 1 }]) {
      expect(chatComposerAccountSwitchReason({ ...empty, ...content })).toContain('drafts and attachments');
    }
  });
  test('protects unrecovered messages but allows a restored message deliberately cleared by the user', () => {
    expect(chatComposerAccountSwitchReason({ ...empty, recoveryStatus: 'available' })).toContain('failed message');
    expect(chatComposerAccountSwitchReason({ ...empty, recoveryStatus: 'unknown' })).toContain('failed message');
    expect(chatComposerAccountSwitchReason({ ...empty, recoveryStatus: 'restored' })).toBeNull();
  });
  test('blocks attachment and other composer operations even before content arrives', () => {
    expect(chatComposerAccountSwitchReason({ ...empty, pending: true })).toContain('composer operation');
  });
});
