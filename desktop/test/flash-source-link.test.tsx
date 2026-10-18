import { expect, test } from 'bun:test';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { flashSourceHref, flashSourceTarget, type FlashSourceTarget } from '../shared/flash-memory';
import { MessageContent } from '../frontend/src/features/chat/MessageContent';
import { FlashSourceLink, FlashSourceNavigationContext } from '../frontend/src/features/chat/FlashSourceLink';

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
  expect(flashSourceTarget(flashSourceHref({ ...target, owner: 'a'.repeat(64) }))).toEqual({ ...target, owner: 'a'.repeat(64) });
  expect(flashSourceTarget(href + '&owner=other')).toBeNull();
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

test('memory source headings use a decorative book while their original links remain separate', () => {
  for (const heading of ['출처', '**출처**', '## 출처']) {
    for (const renderLocalImages of [false, true]) {
      const html = renderToStaticMarkup(<MessageContent renderLocalImages={renderLocalImages}
        text={`요약입니다.\n\n${heading}\n\n> 원문 근거\n\n[대화 원문 보기](${href})`} />);
      expect(html).toContain('role="heading" aria-level="2"');
      expect(html).toContain('lucide-book-open');
      expect(html).toContain('lucide-link');
      expect(html.match(/<a\s/g)).toHaveLength(1);
      expect(html).toContain('원문 근거');
    }
  }
  const addressed = renderToStaticMarkup(<MessageContent mention={{ id: 'atlas', name: 'atlas' }}
    text={`@atlas 요약\n\n${text}`} />);
  expect(addressed).toContain('data-mention-id="atlas"');
  expect(addressed).toContain('lucide-book-open');
});

test('source decoration leaves prose, code, quoted headings and unrelated references unchanged', () => {
  for (const input of [
    '출처\n\n일반 설명입니다.',
    `출처 확인\n\n> 원문\n\n[대화 원문 보기](${href})`,
    '`출처`\n\n> 원문\n\n' + `[대화 원문 보기](${href})`,
    `출처\n\n> 원문\n\n[외부 링크](https://example.com)`,
    `출처\n\n> 원문\n\n[잘못된 링크](${href}&extra=1)`,
    `> 출처\n>\n> > 원문\n>\n> [대화 원문 보기](${href})`,
    '```md\n출처\n\n> 원문\n```',
  ]) expect(renderToStaticMarkup(<MessageContent text={input} />)).not.toContain('lucide-book-open');
  expect(renderToStaticMarkup(<MessageContent text={text} presentation="description" />)).not.toContain('lucide-book-open');
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
    let originalReads = 0;
    const dockerTarget = { ...target, owner: 'a'.repeat(64) };
    await act(async () => root.render(<FlashSourceLink href={flashSourceHref(dockerTarget)} target={dockerTarget}
      readOriginal={async value => { expect(value).toEqual(dockerTarget); originalReads++; return '<script>literal source</script>\nsecond line'; }}>
      대화 원문 보기
    </FlashSourceLink>));
    expect(originalReads).toBe(0);
    await act(async () => { container.querySelector('a')!.dispatchEvent(click()); });
    expect(originalReads).toBe(1);
    expect(container.querySelector('[role="note"]')?.textContent).toBe('<script>literal source</script>\nsecond line');
    expect(container.querySelector('script')).toBeNull();
    await act(async () => root.render(<FlashSourceNavigationContext.Provider value={open}><MessageContent text={text} /></FlashSourceNavigationContext.Provider>));
    expect(window.location.href).toBe('http://localhost/');
    outcome = 'blocked';
    await act(async () => { container.querySelector('a')!.dispatchEvent(click()); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('잠시 후');
    outcome = 'error';
    await act(async () => { container.querySelector('a')!.dispatchEvent(click()); });
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
