import { expect, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSessionListHarness } from './chat-session-list-test-harness';
import { ChatSessionList } from '../frontend/src/features/chat/ChatSessionList';
import { ChatDeleteSessionForm } from '../frontend/src/features/chat/ChatDeleteSessionDialog';
import { chatSessionDeletionReason } from '../frontend/src/features/chat/chatSessionDeletion';
import { INITIAL_CHAT_STATE, type ChatSession } from '../frontend/src/features/chat/model';

const session: ChatSession = { id: 'thread', title: 'A long conversation', preview: '', updatedAt: 1, createdAt: 1,
  status: 'idle' };
type ElementProps = { children?: ReactNode; onClick?: () => void; disabled?: boolean; 'aria-label'?: string;
  onSubmit?: (event: { preventDefault: () => void }) => void };
function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...elements(node.props.children)];
}

test('chat title and delete action are separate keyboard buttons with separate callbacks', () => {
  const opened: string[] = [];
  const deleted: string[] = [];
  const nodes = createSessionListHarness().render({ sessions: [session], loading: false, activeSessionId: null,
    responseThreadIds: [], newChatDisabled: false, selectionDisabled: false,
    onOpen: (id) => opened.push(id), onNew: () => {}, onDelete: (id) => deleted.push(id), deleteReason: () => null });
  const remove = nodes.find((element) => element.props['aria-label'] === `Delete chat: ${session.title}`)!;
  (remove.props.onClick as (() => void))();
  expect(deleted).toEqual(['thread']);
  expect(opened).toEqual([]);
  const title = nodes.find((element) => element.type === 'button' && element.props.title === session.title)!;
  (title.props.onClick as (() => void))();
  expect(opened).toEqual(['thread']);
  expect(elements(title.props.children as ReactNode).some((element) => element.props.onClick)).toBe(false);
});

test('deletion restriction disables only the delete action and exposes its reason', () => {
  const html = renderToStaticMarkup(<ChatSessionList sessions={[session]} loading={false} activeSessionId="thread"
    responseThreadIds={['thread']} newChatDisabled={false} selectionDisabled={false}
    onOpen={() => {}} onNew={() => {}} onDelete={() => {}} deleteReason={() => 'Stop the active response first.'} />);
  expect(html).toMatch(/<button[^>]*aria-label="Delete chat: A long conversation"[^>]*disabled=""/);
  expect(html).toContain('title="Stop the active response first."');
  expect(html).toContain('aria-current="page"');
});

test('delete confirmation names the irreversible child deletion and preserves errors', () => {
  const html = renderToStaticMarkup(<ChatDeleteSessionForm sessionTitle={session.title} reason={null}
    pending={false} error="Codex refused deletion." onDelete={() => {}} onClose={() => {}} />);
  expect(html).toContain('child agent conversations');
  expect(html).toContain('This cannot be undone.');
  expect(html).toContain('role="alert">Codex refused deletion.');
  expect(html).toContain('title="A long conversation"');
  expect(html).toContain('autofocus=""');
  expect(html).not.toContain('aria-label="Deleting chat…"');
});

test('pending chat deletion shows the shared loading indicator and elapsed time', () => {
  const html = renderToStaticMarkup(<ChatDeleteSessionForm sessionTitle={session.title} reason={null}
    pending error={null} onDelete={() => {}} onClose={() => {}} />);
  expect(html).toContain('role="status" aria-label="Deleting chat…"');
  expect(html).toContain('0.0s');
  expect(html).toContain('aria-busy="true"');
  expect(html.match(/disabled=""/g)).toHaveLength(2);
});

test('pending or newly blocked deletion cannot be submitted by Enter', () => {
  let calls = 0;
  for (const options of [{ pending: true, reason: null }, { pending: false, reason: 'Busy' }]) {
    const view = ChatDeleteSessionForm({ sessionTitle: session.title, ...options, error: null,
      onDelete: () => { calls += 1; }, onClose: () => {} });
    elements(view)[0]?.props.onSubmit?.({ preventDefault() {} });
  }
  expect(calls).toBe(0);
});

test('workspace deletion waits for operations and responses in every pane, including a hidden thread', () => {
  const idle = { state: INITIAL_CHAT_STATE, isOperationPending: () => false };
  expect(chatSessionDeletionReason('thread', true, false, false, [idle])).toBeNull();
  expect(chatSessionDeletionReason('thread', false, false, false, [])).not.toBeNull();
  expect(chatSessionDeletionReason('thread', true, true, false, [idle])).not.toBeNull();
  expect(chatSessionDeletionReason('thread', true, false, true, [idle])).not.toBeNull();
  expect(chatSessionDeletionReason('thread', true, false, false, [idle, { ...idle, isOperationPending: () => true }])).not.toBeNull();
  expect(chatSessionDeletionReason('thread', true, false, false,
    [idle, { ...idle, state: { ...INITIAL_CHAT_STATE, activeSessionId: 'other', responseThreadIds: ['hidden'] } }])).not.toBeNull();
  expect(chatSessionDeletionReason('thread', true, false, false,
    [{ ...idle, state: { ...INITIAL_CHAT_STATE, sessions: [{ ...session, status: 'active' }] } }])).not.toBeNull();
});
