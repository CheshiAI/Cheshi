import { expect, test } from 'bun:test';
import { chatReducer, INITIAL_CHAT_STATE, normalizeChatConfiguration, normalizeChatEvent, normalizeOpenSessionResponse,
  type ChatPermissionMode, type ChatState } from '../frontend/src/features/chat/model';

const thread = { id: 'thread', title: 'Conversation', preview: '', createdAt: 1, updatedAt: 1, status: 'idle' };
const workspace: ChatPermissionMode = { id: 'ask-for-approval', profileId: ':workspace', label: 'Ask for approval',
  description: 'Workspace edits', access: 'Ask for approval', allowed: true, dangerous: false };
const readOnly: ChatPermissionMode = { ...workspace, id: 'read-only', profileId: ':read-only', label: 'Read only', access: 'Read only' };
const state = (): ChatState => ({ ...INITIAL_CHAT_STATE, activeSessionId: 'thread' });
function event(current: ChatState, value: unknown): ChatState {
  const normalized = normalizeChatEvent(value);
  if (!normalized) throw new Error('Expected a valid chat event.');
  return chatReducer(current, { type: 'event', event: normalized });
}

test('permission events update both legacy access text and the authoritative mode id', () => {
  const custom = { ...workspace, id: 'custom:workspace-alias' };
  const selected = event(state(), { type: 'permission-mode-changed', mode: custom });
  expect(selected.access).toBe(workspace.access);
  expect(selected.permissionMode?.id).toBe(custom.id);
  expect(event(selected, { type: 'permission-mode-changed', mode: readOnly }).permissionMode).toEqual(readOnly);
});

test('new sessions reset permissions and opened sessions wait for their authoritative catalog', () => {
  const current = { ...state(), permissionMode: workspace, access: workspace.access };
  const fresh = chatReducer(current, { type: 'new-session' });
  expect(fresh.permissionMode).toBeNull();
  expect(fresh.access).toBe('Read only');
  const opened = chatReducer(current, { type: 'session-opened', session: thread, items: [], responseInProgress: false, responseThreadIds: [] });
  expect(opened.permissionMode).toBeNull();
});

test('streams plan fragments and replaces them with the final authoritative text', () => {
  const base = { threadId: 'thread', itemId: 'plan', createdAt: 12 };
  let current = event(state(), { ...base, type: 'plan-delta', text: '# Plan\n' });
  current = event(current, { ...base, type: 'plan-delta', text: 'Draft steps' });
  expect(current.items[0]).toMatchObject({ kind: 'plan', text: '# Plan\nDraft steps' });
  current = event(current, { ...base, type: 'plan-completed', text: '# Final plan\n1. Test' });
  expect(current.items).toHaveLength(1);
  expect(current.items[0]).toMatchObject({ kind: 'plan', text: '# Final plan\n1. Test' });
  expect(event(current, { ...base, type: 'plan-completed', text: '' }).items[0]).toMatchObject({ text: '' });
});

test('does not add plan events from another session and restores plan history', () => {
  const current = state();
  expect(event(current, { type: 'plan-completed', threadId: 'other', itemId: 'p', text: 'Other plan' })).toBe(current);
  const opened = normalizeOpenSessionResponse({ session: thread, items: [{ id: 'p', kind: 'plan', text: '**Saved plan**', createdAt: 5 }] });
  expect(opened.items).toEqual([{ id: 'p', kind: 'plan', text: '**Saved plan**', createdAt: 5 }]);
});

test('accepts supported collaboration modes without coercing invalid external values', () => {
  const configuration = { model: null, modelDisplayName: 'Default', reasoningEffort: 'medium', supportedReasoningEfforts: [],
    serviceTier: null, serviceTierDisplayName: 'Standard', fastModeAvailable: false, fastModeEnabled: false };
  expect(normalizeChatConfiguration(configuration).collaborationMode).toBeUndefined();
  for (const collaborationMode of ['default', 'plan'] as const) {
    expect(normalizeChatConfiguration({ ...configuration, collaborationMode }).collaborationMode).toBe(collaborationMode);
  }
  for (const collaborationMode of [true, 1, null, 'unknown']) {
    expect(() => normalizeChatConfiguration({ ...configuration, collaborationMode })).toThrow('configuration response is invalid');
  }
});

test('a failed steering message retains the running response and pending approvals', () => {
  const running: ChatState = { ...state(), phase: 'streaming', responseThreadIds: ['thread'], approvals: [{ id: 'approval',
    threadId: 'thread', kind: 'command', title: 'Approve', detail: '', canAllowForSession: false }] };
  const optimistic = chatReducer(running, { type: 'optimistic-user', id: 'client:steer', text: 'Also test', title: 'Also test', createdAt: 1 });
  const failed = chatReducer(optimistic, { type: 'send-failed', clientMessageId: 'steer', threadId: 'thread',
    message: 'Could not steer', steering: true });
  expect(failed.phase).toBe('streaming');
  expect(failed.responseThreadIds).toEqual(['thread']);
  expect(failed.approvals).toEqual(running.approvals);
  expect(failed.items[0]).toMatchObject({ pending: false, delivery: 'failed' });
});

test('an acknowledgement marks only its message accepted without completing the active response', () => {
  const current: ChatState = { ...state(), phase: 'streaming', responseThreadIds: ['thread'], items: [
    { id: 'client:first', kind: 'user', text: 'First', createdAt: 1, pending: true },
    { id: 'client:steer', kind: 'user', text: 'Steer', createdAt: 2, pending: true, delivery: 'unknown' },
  ] };
  const accepted = chatReducer(current, { type: 'send-accepted', clientMessageId: 'steer' });
  expect(accepted.items[0]).toMatchObject({ pending: true });
  expect(accepted.items[1]).toMatchObject({ pending: false });
  expect(accepted.items[1]).not.toHaveProperty('delivery');
  expect(accepted.phase).toBe('streaming');
});

test('interrupted and failed turns settle unfinished activities without losing command output', () => {
  const command = { id: 'command', kind: 'activity' as const, activity: 'command', label: 'Command',
    detail: 'sleep 45', status: 'inProgress', output: 'Started\n', cwd: '/workspace' };
  const completed = { ...command, id: 'completed', status: 'completed', exitCode: 0, durationMs: 12 };
  const rejected = { ...command, id: 'rejected', status: 'failed', exitCode: 1 };
  const running: ChatState = { ...state(), phase: 'streaming', responseThreadIds: ['thread', 'background'], items: [
    { id: 'client:first', kind: 'user', text: 'Run', createdAt: 1, pending: true },
    command, completed, rejected,
  ] };
  for (const status of ['interrupted', 'failed']) {
    const stopped = event(running, { type: 'turn-completed', threadId: 'thread', status });
    expect(stopped.responseThreadIds).toEqual(['background']);
    expect(stopped.items[0]).toMatchObject({ pending: false });
    expect(stopped.items[1]).toEqual({ ...command, status });
    expect(stopped.items[2]).toBe(completed);
    expect(stopped.items[3]).toBe(rejected);
    expect(event(stopped, { type: 'command-output-delta', threadId: 'thread', itemId: 'command', text: 'Late' })).toBe(stopped);
    const background = event(running, { type: 'turn-completed', threadId: 'background', status });
    expect(background.items).toBe(running.items);
    expect(background.responseThreadIds).toEqual(['thread']);
  }
});
