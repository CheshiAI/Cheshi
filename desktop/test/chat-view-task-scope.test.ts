import { describe, expect, test } from 'bun:test';

import { createChatTaskScope } from '../frontend/src/features/chat/chatTaskScope';

describe('chat view task scope', () => {
  test('another pane changing session does not invalidate this pane request', () => {
    const firstPane = createChatTaskScope('first');
    const secondPane = createChatTaskScope('second');
    const firstRequest = firstPane.capture();
    const secondRequest = secondPane.capture();
    secondPane.selectSession('third');
    expect(firstRequest()).toBe(true);
    expect(secondRequest()).toBe(false);
  });

  test('a delayed result cannot overwrite a different session or a later visit', async () => {
    const pane = createChatTaskScope('first');
    const isCurrent = pane.capture();
    let configuration = 'new configuration';
    const completion = Promise.resolve('old configuration').then((value) => {
      if (isCurrent()) configuration = value;
    });
    pane.selectSession('second');
    pane.selectSession('first');
    await completion;
    expect(configuration).toBe('new configuration');
    expect(pane.capture()()).toBe(true);
  });

  test('rerenders of the same session preserve an in flight request', () => {
    const pane = createChatTaskScope('first');
    const request = pane.capture();
    pane.selectSession('first');
    expect(request()).toBe(true);
  });

  test('a new blank chat invalidates work from the previous blank chat', () => {
    const pane = createChatTaskScope('0:');
    const request = pane.capture();
    pane.selectSession('1:');
    expect(request()).toBe(false);
    expect(pane.capture()()).toBe(true);
  });

  test('closing a pane invalidates requests even if its effect mounts again', () => {
    const pane = createChatTaskScope(null);
    const request = pane.capture();
    pane.unmount();
    expect(request()).toBe(false);
    pane.mount();
    expect(request()).toBe(false);
    expect(pane.capture()()).toBe(true);
  });
});
