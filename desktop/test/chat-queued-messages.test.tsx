import assert from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatQueuedMessages } from '../frontend/src/features/chat/ChatQueuedMessages';
import type { ChatQueuedMessage } from '../frontend/src/features/chat/chatMessageQueue';

function queuedMessage(id: string, status: ChatQueuedMessage['status'] = 'queued'): ChatQueuedMessage {
  return { id, threadId: 'thread-a', status,
    input: { draft: `Instruction ${id}`, selectedSkill: null, attachments: [] } };
}

function actionProps(tree: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(tree)) return tree.flatMap(actionProps);
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  const children = actionProps(tree.props.children);
  return typeof tree.props.onClick === 'function' ? [tree.props, ...children] : children;
}

function clickAction(props: Record<string, unknown> | undefined) {
  assert.ok(props);
  const onClick = props.onClick;
  assert.ok(typeof onClick === 'function');
  onClick();
}

const noop = () => {};

test('does not render an empty queue or reserve its section', () => {
  const element = ChatQueuedMessages({ messages: [], onRemove: noop, onRetry: noop });
  expect(element).toBeNull();
  expect(renderToStaticMarkup(element)).toBe('');
});

test('shows instructions in queue order with their full multiline text and attachment context', () => {
  const first = queuedMessage('first');
  first.input.draft = `Inspect this full instruction\n${'details '.repeat(70)}END OF INSTRUCTION`;
  first.input.selectedSkill = { name: 'review', displayName: 'Code review', description: 'Review changes',
    scope: 'repo', path: '/workspace/skills/review/SKILL.md' };
  first.input.attachments = [
    { kind: 'file', name: 'example.ts', path: '/workspace/example.ts' },
    { kind: 'image', name: 'preview.png', path: '/workspace/preview.png' },
  ];
  const html = renderToStaticMarkup(<ChatQueuedMessages messages={[first, queuedMessage('second')]}
    onRemove={noop} onRetry={noop} />);
  expect(html).toContain('aria-label="2 queued instructions"');
  expect(html).toContain('<ol');
  expect(html.match(/<li\b/g)).toHaveLength(2);
  expect(html).toContain(first.input.draft);
  expect(html.indexOf('END OF INSTRUCTION')).toBeLessThan(html.indexOf('Instruction second'));
  expect(html).toContain('Skill: Code review');
  expect(html).toContain('2 attachments');
  expect(html).toContain('example.ts\npreview.png');
});

test('removes the selected instruction by id and prevents removal while it is sending', () => {
  const removed: string[] = [];
  const element = ChatQueuedMessages({ messages: [queuedMessage('first'), queuedMessage('sending', 'sending')],
    onRemove: id => removed.push(id), onRetry: noop });
  const buttons = actionProps(element);
  expect(buttons).toHaveLength(2);
  expect(buttons[0]?.disabled).toBe(false);
  clickAction(buttons[0]);
  expect(removed).toEqual(['first']);
  expect(buttons[1]?.disabled).toBe(true);
  const html = renderToStaticMarkup(element);
  expect(html).toContain('Sending…');
  expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(1);
});

test('offers queue resumption only for paused instructions and calls it with the correct id', () => {
  const retried: string[] = [];
  const paused = { ...queuedMessage('paused-id', 'paused'), message: 'The current task stopped.' };
  const element = ChatQueuedMessages({ messages: [queuedMessage('waiting'), paused],
    onRemove: noop, onRetry: id => retried.push(id) });
  const retryButtons = actionProps(element).filter(props => props['aria-label'] === 'Resume queued instructions');
  expect(retryButtons).toHaveLength(1);
  expect(retryButtons[0]?.disabled).toBe(false);
  clickAction(retryButtons[0]);
  expect(retried).toEqual(['paused-id']);
  expect(renderToStaticMarkup(element)).toContain('The current task stopped.');
});

test('unconfirmed delivery shows its explanation and dismiss action without offering retry', () => {
  const dismissed: string[] = [];
  const element = ChatQueuedMessages({ messages: [{ ...queuedMessage('uncertain', 'unknown'),
    message: 'Connection closed before acknowledgement.' }], onRemove: id => dismissed.push(id), onRetry: noop });
  const html = renderToStaticMarkup(element);
  expect(html).toContain('Delivery unconfirmed');
  expect(html).toContain('Connection closed before acknowledgement.');
  expect(html).toContain('Check this conversation before sending again.');
  expect(html).not.toContain('Resume queued instructions');
  const actions = actionProps(element);
  expect(actions).toHaveLength(1);
  expect(actions[0]?.['aria-label']).toBe('Dismiss unconfirmed instruction');
  clickAction(actions[0]);
  expect(dismissed).toEqual(['uncertain']);
});

test('disables every queue action while interactions are locked', () => {
  const element = ChatQueuedMessages({ messages: [queuedMessage('waiting'), queuedMessage('paused', 'paused')],
    onRemove: noop, onRetry: noop, disabled: true });
  const actions = actionProps(element);
  expect(actions).toHaveLength(3);
  expect(actions.every(props => props.disabled === true)).toBe(true);
  expect(renderToStaticMarkup(element).match(/<button[^>]*disabled=""/g)).toHaveLength(3);
});
