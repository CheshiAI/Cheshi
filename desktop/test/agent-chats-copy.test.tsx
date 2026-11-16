import { expect, test } from 'bun:test';
import { act, StrictMode } from 'react';
import { withDOM } from './agent-chats-test-dom';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import { ChatsMessageActions } from '../frontend/src/features/agent-chats/ChatsMessageActions';
import type { ChatsSnapshot, RoomMessage } from '../shared/agent-chats';

function createDeferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}

const rawText = '  # Heading\r\n\r\n```ts\nconst value = "Markdown **unchanged**";\n```\n\nTrailing space  \n';
function snapshot(): ChatsSnapshot {
  const createdAt = '2026-10-06T00:00:00Z';
  const message = (id: string, kind: RoomMessage['kind'], text = id): RoomMessage => ({
    id, kind, text, roomId: 'first', threadId: null, sender: 'dev', recipient: null, createdAt,
  });
  return {
    rooms: ['first', 'second'].map(id => ({ id, name: id, workspace: '/project', engineId: 'docker:test',
      defaultAgentId: 'dev', members: [{ id: 'dev', name: 'Development', accountId: 'account' }], createdAt })),
    messages: [
      { ...message('user', 'message', rawText), sender: 'user' },
      message('homie', 'message', 'Homie response'),
      { ...message('activity-message', 'message', 'Original activity text'), activity: {
        id: 'activity', turnId: 'turn', kind: 'message', title: 'Response', text: 'Rendered activity text',
        status: 'completed', createdAt, final: true, truncated: false,
      } },
      { ...message('execution', 'message'), activity: {
        id: 'command', turnId: 'turn', kind: 'command', title: 'bun test', text: 'Output',
        status: 'completed', createdAt, final: true, truncated: false,
      } },
      ...(['permission_request', 'verification_request', 'verification_result', 'work_request', 'work_result',
        'goal', 'question', 'question_closed', 'reply'] as const).map(kind => message(kind, kind)),
      { ...message('other', 'message', 'Other room'), roomId: 'second' },
    ],
  };
}

function messageButton(id: string, label = 'Copy') {
  const button = document.querySelector<HTMLButtonElement>(`[data-message-id="${id}"] button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing ${label} on ${id}`);
  return button;
}

test('Copy is limited to ordinary user/Homie messages and preserves raw text, Reply, draft and scroll', async () => {
  await withDOM(async ui => {
    const writes: string[] = [];
    clipboard(async text => { writes.push(text); });
    await ui.render(<ChatsView active api={{ request: async () => snapshot() }} />);
    expect([...document.querySelectorAll('[data-message-id]')]
      .filter(node => node.querySelector('button[aria-label="Copy"]'))
      .map(node => node.getAttribute('data-message-id'))).toEqual(['user', 'homie', 'activity-message']);
    const article = messageButton('user').closest('article')!;
    expect([...article.querySelectorAll(':scope > div:first-child button')].map(button => button.getAttribute('aria-label')))
      .toEqual([`Reply to ${rawText.slice(0, 80)}`, 'Copy']);
    await ui.type('Message', 'Keep my draft');
    const timeline = document.querySelector<HTMLElement>('[aria-label="Room messages"]')!;
    timeline.scrollTop = 42;
    await act(async () => timeline.dispatchEvent(new window.Event('scroll', { bubbles: true })));
    await act(async () => messageButton('user').click());
    await act(async () => messageButton('homie').click());
    await act(async () => messageButton('activity-message').click());
    expect(writes).toEqual([rawText, 'Homie response', 'Original activity text']);
    expect(document.querySelector('[aria-label="Room messages"]')).toBe(timeline);
    expect(timeline.scrollTop).toBe(42);
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe('Keep my draft');
    await ui.click(`Reply to ${rawText.slice(0, 80)}`);
    expect(document.querySelector('[aria-label="Reply context"]')?.textContent).toContain('Heading');
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe('Keep my draft');
  });
});

test('Copy waits for actual success, blocks duplicate clicks and returns from Copied to Copy', async () => {
  await withDOM(async ui => {
    const pending = createDeferred(), writes: string[] = [];
    clipboard(text => { writes.push(text); return pending.promise; });
    await ui.render(<StrictMode><ChatsMessageActions text={rawText} copyable replyLabel="Reply" onReply={() => {}} /></StrictMode>);
    await ui.click('Copy');
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Copy"]')!;
    expect(button.disabled).toBe(true);
    await act(async () => { button.click(); button.click(); });
    expect(writes).toEqual([rawText]);
    expect(document.querySelector('[aria-label="Copied"]')).toBeNull();
    await act(async () => pending.resolve());
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Copied"]')?.disabled).toBe(false);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2_100)); });
    expect(document.querySelector('[aria-label="Copied"]')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Copy"]')?.disabled).toBe(false);
  });
});

test('clipboard failure displays an English error and retry copies the same original', async () => {
  await withDOM(async ui => {
    const writes: string[] = [];
    clipboard(async text => { writes.push(text); if (writes.length === 1) throw new Error('Denied'); });
    await ui.render(<ChatsMessageActions text={rawText} copyable replyLabel="Reply" onReply={() => {}} />);
    await ui.click('Copy');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Could not copy this message. Please try again.');
    expect(document.querySelector('[aria-label="Copied"]')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Copy"]')?.disabled).toBe(false);
    await ui.click('Copy');
    expect(writes).toEqual([rawText, rawText]);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[aria-label="Copied"]')).not.toBeNull();
  });
});

test('missing clipboard API is recoverable and empty text is copied without a placeholder', async () => {
  await withDOM(async ui => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await ui.render(<ChatsMessageActions text="" copyable replyLabel="Reply" onReply={() => {}} />);
    await ui.click('Copy');
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    const writes: string[] = [];
    clipboard(async text => { writes.push(text); });
    await ui.click('Copy');
    expect(writes).toEqual(['']);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});

test.each(['success', 'failure'] as const)('late clipboard %s cannot update another room or a remounted message', async outcome => {
  await withDOM(async ui => {
    const pending = createDeferred();
    let calls = 0;
    clipboard(() => { calls++; return calls === 1 ? pending.promise : Promise.resolve(); });
    await ui.render(<ChatsView active api={{ request: async () => snapshot() }} />);
    await act(async () => messageButton('user').click());
    await ui.click('second');
    expect(document.querySelector('[data-message-id="user"]') === null).toBe(true);
    await ui.click('first');
    await act(async () => {
      if (outcome === 'success') pending.resolve(); else pending.reject(new Error('Denied'));
    });
    expect([...document.querySelectorAll('[role="alert"]')].map(node => node.textContent))
      .not.toContain('Could not copy this message. Please try again.');
    expect(document.querySelector('[aria-label="Copied"]') === null).toBe(true);
    expect(messageButton('user').disabled).toBe(false);
    await act(async () => messageButton('user').click());
    expect(messageButton('user', 'Copied').disabled).toBe(false);
  });
});

test.each(['success', 'failure'] as const)('late clipboard %s after unmount adds no feedback or success timer', async outcome => {
  await withDOM(async ui => {
    const pending = createDeferred();
    clipboard(() => pending.promise);
    await ui.render(<ChatsMessageActions text={rawText} copyable replyLabel="Reply" onReply={() => {}} />);
    await ui.click('Copy');
    await ui.render(<p>Unmounted</p>);
    await act(async () => {
      if (outcome === 'success') pending.resolve(); else pending.reject(new Error('Denied'));
    });
    expect(document.body.textContent).toBe('Unmounted');
  });
});

test('text changes discard pending completion, clear feedback and keep an older timer from resetting newer success', async () => {
  await withDOM(async ui => {
    const pending = createDeferred();
    let calls = 0;
    clipboard(() => { calls++; return calls === 1 ? pending.promise : Promise.resolve(); });
    const render = (text: string) => ui.render(<ChatsMessageActions text={text} copyable replyLabel="Reply" onReply={() => {}} />);
    await render('First'); await ui.click('Copy');
    await render('Second');
    await act(async () => pending.resolve());
    expect(document.querySelector('[aria-label="Copied"]')).toBeNull();
    await ui.click('Copy');
    await render('Third');
    expect(document.querySelector('[aria-label="Copied"]')).toBeNull();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1_100)); });
    await ui.click('Copy');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1_100)); });
    expect(document.querySelector('[aria-label="Copied"]')).not.toBeNull();
    await render('Fourth');
    expect(document.querySelector('[aria-label="Copied"]')).toBeNull();
    clipboard(async () => { throw new Error('Denied'); });
    await ui.click('Copy');
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    await render('Fifth');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
