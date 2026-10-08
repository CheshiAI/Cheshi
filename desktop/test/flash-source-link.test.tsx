import { expect, test } from 'bun:test';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { flashSourceHref, flashSourceTarget, type FlashSourceTarget } from '../shared/flash-memory';
import { MessageContent } from '../frontend/src/features/chat/MessageContent';
import { FlashSourceNavigationContext } from '../frontend/src/features/chat/FlashSourceLink';

const target = { threadId: 'session-123', itemId: 'message_456' };
const href = flashSourceHref(target);
const text = `출처\n\n> 메모리 제한은 1024MB 로 하자\n\n[대화 원문 보기](${href})`;

test('source URLs accept only a canonical internal message destination', () => {
  expect(flashSourceTarget(href)).toEqual(target);
  for (const value of [
    'https://example.com', 'javascript:alert(1)', 'file:///tmp/a',
    href + '#fragment', href + '&extra=1', href + '&itemId=other',
    href.replace('message?', 'message/?'), href.replace('session-123', '..%2Fsecret'),
    href.replace('message_456', ''), href.replace('message_456', 'a'.repeat(1025)),
    href.replace('cheshi-source:', 'other:'), href.replace('message?', 'message.evil?'),
  ]) expect(flashSourceTarget(value)).toBeNull();
  expect(() => flashSourceHref({ ...target, itemId: '../secret' })).toThrow();
});

test('Markdown source quotes render an internal icon link while unsafe links stay inert', () => {
  const html = renderToStaticMarkup(<MessageContent text={text} />);
  expect(html).toContain('<blockquote>');
  expect(html).toContain('대화 원문 보기');
  expect(html).toContain('cheshi-source://message?');
  expect(html).toContain('<svg');
  expect(html).not.toContain('target="_blank"');
  expect(html).not.toContain('source_id');
  const unsafe = renderToStaticMarkup(<MessageContent text={`[invalid](${href}&extra=1)`} />);
  expect(unsafe).not.toContain('<a');
});

test('source clicks navigate only on activation and expose unavailable or failed navigation', async () => {
  const window = new Window({ url: 'http://localhost' });
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let unmount = async () => {};
  try {
    const { createRoot } = await import('react-dom/client');
    const container = globalThis.document.createElement('div');
    globalThis.document.body.append(container);
    const root = createRoot(container);
    unmount = async () => { await act(async () => root.unmount()); };
    const opened: FlashSourceTarget[] = [];
    let outcome: 'success' | 'blocked' | 'error' = 'success';
    const open = async (value: FlashSourceTarget) => {
      opened.push(value);
      if (outcome === 'error') throw new Error('Unavailable');
      return outcome === 'success';
    };
    await act(async () => root.render(<FlashSourceNavigationContext.Provider value={open}>
      <MessageContent text={text} />
    </FlashSourceNavigationContext.Provider>));
    expect(opened).toEqual([]);
    const link = container.querySelector('a')!;
    const click = () => new window.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as MouseEvent;
    const event = click();
    await act(async () => { link.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(opened).toEqual([target]);
    expect(window.location.href).toBe('http://localhost/');
    outcome = 'blocked';
    await act(async () => { link.dispatchEvent(click()); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('잠시 후');
    outcome = 'error';
    await act(async () => { link.dispatchEvent(click()); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('접근할 수 없는');
    await act(async () => root.render(<MessageContent text={text} />));
    await act(async () => { container.querySelector('a')!.dispatchEvent(click()); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('이 화면에서는');
    expect(opened).toHaveLength(3);
  } finally {
    await unmount();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
