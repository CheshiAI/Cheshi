import { expect, test } from 'bun:test';
import { INITIAL_CHAT_STATE, chatReducer, normalizeChatEvent, normalizeDeletedSessionsResponse } from '../frontend/src/features/chat/model.ts';
import type { ChatSession, ChatState } from '../frontend/src/features/chat/model.ts';

function session(id: string): ChatSession {
  return { id, title: id, preview: id, createdAt: 1, updatedAt: 1, status: 'idle' };
}

function state(): ChatState {
  return {
    ...INITIAL_CHAT_STATE,
    sessions: ['current', 'child', 'other'].map(session),
    activeSessionId: 'current', activeTitle: 'Current chat', access: 'Workspace write',
    items: [{ kind: 'assistant', id: 'answer', text: 'Keep this answer', createdAt: 1 }],
    responseThreadIds: ['other'], phase: 'streaming',
    approvals: ['child', 'other'].map(threadId => ({ id: threadId, threadId, kind: 'command', title: 'Approval', detail: '', canAllowForSession: false })),
  };
}

test('validates deletion receipts and events without accepting empty or malformed identifiers', () => {
  expect(normalizeDeletedSessionsResponse({ threadIds: ['root', 'child', 'root'] })).toEqual(['root', 'child']);
  expect(() => normalizeDeletedSessionsResponse({ threadIds: ['other'] }, 'root')).toThrow(/does not match/);
  for (const threadIds of [null, [], [''], [' root '], ['root', 42]]) {
    expect(() => normalizeDeletedSessionsResponse({ threadIds })).toThrow();
    expect(normalizeChatEvent({ type: 'sessions-deleted', threadIds })).toBeNull();
  }
  expect(normalizeChatEvent({ type: 'sessions-deleted', threadIds: ['root'] })).toEqual({ type: 'sessions-deleted', threadIds: ['root'] });
});

test('deleting the viewed session and its descendants resets the pane while preserving unrelated work', () => {
  const next = chatReducer(state(), { type: 'event', event: { type: 'sessions-deleted', threadIds: ['current', 'child'] } });
  expect(next.sessions.map(entry => entry.id)).toEqual(['other']);
  expect(next.activeSessionId).toBeNull();
  expect(next.activeTitle).toBe('New chat');
  expect(next.items).toEqual([]);
  expect(next.access).toBe('Read only');
  expect(next.permissionMode).toBeNull();
  expect(next.responseThreadIds).toEqual(['other']);
  expect(next.approvals.map(entry => entry.threadId)).toEqual(['other']);
  expect(next.phase).toBe('streaming');
});

test('deleting an inactive session preserves the viewed transcript and permissions', () => {
  const before = state();
  const next = chatReducer(before, { type: 'event', event: { type: 'sessions-deleted', threadIds: ['child'] } });
  expect(next.activeSessionId).toBe(before.activeSessionId);
  expect(next.items).toBe(before.items);
  expect(next.access).toBe(before.access);
  expect(next.sessions.map(entry => entry.id)).toEqual(['current', 'other']);
  expect(next.approvals.map(entry => entry.threadId)).toEqual(['other']);
});
