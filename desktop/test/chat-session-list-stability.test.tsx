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
  return nodes.find((node) => node.type === 'button' && node.props.title === title)!;
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

test('active sessions and live responses replace the leading icon and restore it when finished', () => {
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
    expect(children.map(child => child.type)).toEqual(['loading-indicator', 'span']);
    expect(children[0]?.props['aria-label']).toBe('Active response');
    expect(children[1]?.props.children).toBe('two');
    expect(row(responding, 'one')).toBe(row(idle, 'one'));

    const completed = harness.render(initial);
    const restored = sessionListElements(row(completed, 'two').props.children);
    expect(restored.map(child => child.type)).toEqual(['MessageSquareText', 'span']);
    expect(restored[1]?.props.children).toBe('two');
    expect(harness.rowRenders).toBe(4);
  }
});
