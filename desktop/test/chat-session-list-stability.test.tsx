import { expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import type { ChatSessionList } from '../frontend/src/features/chat/ChatSessionList';
import { createSessionListHarness, sessionListElements, type SessionListElement } from './chat-session-list-test-harness';

type Props = ComponentProps<typeof ChatSessionList>;
function props(): Props {
  return {
    sessions: ['one', 'two'].map((id) => ({ id, title: id, preview: '', updatedAt: 1, createdAt: 1, status: 'idle' })),
    loading: false, activeSessionId: 'one', responseThreadIds: [], newChatDisabled: false,
    selectionDisabled: false, onOpen() {}, onNew() {}, onDelete() {}, deleteReason: () => null,
  };
}
function row(nodes: SessionListElement[], title: string) {
  return nodes.find((node) => node.type === 'button' && node.props['aria-label'] === title)!;
}
function click(node: SessionListElement) { (node.props.onClick as () => void)(); }

test('configuration lock preserves session content and unlock invokes the latest pane handler', () => {
  const harness = createSessionListHarness();
  const opened: string[] = [];
  const initial = props();
  const before = harness.render({ ...initial, onOpen: () => opened.push('old pane') });
  const pending = harness.render({ ...initial, selectionDisabled: true, responseThreadIds: [],
    onOpen: () => opened.push('saving pane'), deleteReason: () => 'Wait for the current operation to finish.' });
  expect(harness.rowRenders).toBe(2);
  expect(row(pending, 'one')).toBe(row(before, 'one'));
  expect(pending.find((node) => node.type === 'fieldset')?.props.disabled).toBe(true);
  expect(pending.find((node) => node.props['aria-label'] === 'Delete chat: one')?.props.disabled).toBe(true);
  click(row(pending, 'one'));
  expect(opened).toEqual([]);
  const after = harness.render({ ...initial, onOpen: () => opened.push('new pane') });
  expect(harness.rowRenders).toBe(2);
  expect(after.find((node) => node.type === 'fieldset')?.props.disabled).toBe(false);
  click(row(before, 'one'));
  expect(opened).toEqual(['new pane']);
});

test('session changes update only affected titles, current markers and response indicators', () => {
  const harness = createSessionListHarness();
  const initial = props();
  harness.render(initial);
  const renamed = harness.render({ ...initial, sessions: initial.sessions.map((session) =>
    session.id === 'one' ? { ...session, title: 'Renamed' } : session) });
  expect(harness.rowRenders).toBe(3);
  expect(row(renamed, 'Renamed').props['aria-current']).toBe('page');
  const responding = harness.render({ ...initial, activeSessionId: 'two', responseThreadIds: ['two'] });
  expect(harness.rowRenders).toBe(5);
  expect(row(responding, 'one').props['aria-current']).toBeUndefined();
  expect(row(responding, 'two').props['aria-current']).toBe('page');
  expect(responding.some((node) => node.props['aria-label'] === 'Active response')).toBe(true);
});

test('ref-backed deletion restrictions stay fresh without rerendering session content', () => {
  const harness = createSessionListHarness();
  let restriction: string | null = null;
  const initial = { ...props(), deleteReason: () => restriction };
  harness.render(initial);
  restriction = 'Stop the active response before deleting a conversation.';
  const pending = harness.render(initial);
  const remove = pending.find((node) => node.props['aria-label'] === 'Delete chat: one')!;
  expect(remove.props.title).toBe(restriction);
  expect(remove.props.disabled).toBe(true);
  restriction = null;
  const idle = harness.render(initial);
  expect(idle.find((node) => node.props['aria-label'] === 'Delete chat: one')?.props.disabled).toBe(false);
  expect(harness.rowRenders).toBe(2);
});

test('active sessions and live responses retain their indicator without a decorative conversation icon', () => {
  const initial = props();
  const runningStates: Props[] = [
    { ...initial, sessions: initial.sessions.map(session =>
      session.id === 'two' ? { ...session, status: 'active' } : session) },
    { ...initial, responseThreadIds: ['two'] },
  ];
  for (const running of runningStates) {
    const harness = createSessionListHarness();
    const idle = harness.render(initial);
    const responding = harness.render(running);
    const children = sessionListElements(row(responding, 'two').props.children);
    expect(children.some(child => child.props['aria-label'] === 'Active response')).toBe(true);
    expect(children.some(child => child.type === 'MessageSquareText')).toBe(false);
    expect(children.some(child => child.props.title === 'two' && child.props.children === 'two')).toBe(true);
    expect(row(responding, 'one')).toBe(row(idle, 'one'));

    const completed = harness.render(initial);
    const restored = sessionListElements(row(completed, 'two').props.children);
    expect(restored.some(child => child.type === 'loading-indicator' || child.type === 'MessageSquareText')).toBe(false);
    expect(restored.some(child => child.props.title === 'two' && child.props.children === 'two')).toBe(true);
    expect(harness.rowRenders).toBe(4);
  }
});

test('clock ticks only rerender rows whose displayed elapsed time changes', () => {
  const harness = createSessionListHarness();
  const now = 1_000_000;
  harness.setTime(now);
  const initial = props();
  initial.sessions[0]!.updatedAt = now / 1_000 - 1;
  initial.sessions[1]!.updatedAt = now / 1_000 - 300;
  harness.render(initial);
  harness.setTime(now + 1_000);
  const updated = harness.render(initial);
  expect(harness.rowRenders).toBe(3);
  expect(updated.some(node => node.props['aria-label'] === 'Last updated 2s ago')).toBe(true);
  expect(updated.some(node => node.props['aria-label'] === 'Last updated 5m ago')).toBe(true);
});

test('new activity moves a session to the top without mutating the source order', () => {
  const harness = createSessionListHarness();
  const initial = props();
  initial.sessions[0]!.updatedAt = 10;
  initial.sessions[1]!.updatedAt = 20;
  const ordered = (nodes: SessionListElement[]) => nodes
    .filter(node => node.type === 'button' && ['one', 'two'].includes(String(node.props['aria-label'])))
    .map(node => node.props['aria-label']);
  expect(ordered(harness.render(initial))).toEqual(['two', 'one']);
  expect(initial.sessions.map(session => session.id)).toEqual(['one', 'two']);
  const updated = { ...initial, sessions: initial.sessions.map(session =>
    session.id === 'one' ? { ...session, updatedAt: 30 } : session) };
  expect(ordered(harness.render(updated))).toEqual(['one', 'two']);
});
