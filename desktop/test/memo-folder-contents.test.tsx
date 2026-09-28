import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';

test.each([false, true])('memo accordion retains closing content and respects reduced motion: %s', async reduced => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const timers = new Map<number, () => void>();
  let sequence = 0;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: reduced }) });
  Object.defineProperty(window, 'setTimeout', { configurable: true, value: (callback: () => void) => {
    timers.set(++sequence, callback);
    return sequence;
  } });
  Object.defineProperty(window, 'clearTimeout', { configurable: true, value: (id: number) => timers.delete(id) });
  const { createRoot } = await import('react-dom/client');
  const { MemoFolderContents } = await import('../frontend/src/features/notes/MemoFolderContents');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (active: string | null, text = 'Saved memo') => {
    await act(async () => root.render(<>{['first', 'second'].map(id =>
      <MemoFolderContents key={id} expanded={active === id}>
        {active === id && <div id={id} role="region"><button>{text}</button></div>}
      </MemoFolderContents>)}</>));
  };
  const transitionEnd = (element: Element) => {
    const event = new window.Event('transitionend', { bubbles: true });
    Object.defineProperty(event, 'propertyName', { value: 'grid-template-rows' });
    element.dispatchEvent(event as unknown as Event);
  };
  try {
    await render(null);
    expect(container.childNodes).toHaveLength(0);
    await render('first');
    const first = container.querySelector('#first')!;
    await render(null);
    if (reduced) {
      expect(container.childNodes).toHaveLength(0);
      expect(timers.size).toBe(0);
      return;
    }
    expect(container.querySelector('#first')).toBe(first);
    expect(first.parentElement?.hasAttribute('inert')).toBe(true);
    expect(first.parentElement?.getAttribute('aria-hidden')).toBe('true');
    await act(async () => { transitionEnd(first.querySelector('button')!); });
    expect(container.querySelector('#first')).toBe(first);
    await render('first', 'Updated memo');
    expect(timers.size).toBe(0);
    expect(first.textContent).toBe('Updated memo');
    expect(first.parentElement?.hasAttribute('inert')).toBe(false);
    await render('second', 'Other folder memo');
    expect(first.textContent).toBe('Updated memo');
    expect(container.querySelector('#second')?.textContent).toBe('Other folder memo');
    await act(async () => { transitionEnd(first.parentElement!); });
    expect(container.querySelector('#first') === null).toBe(true);
    expect(timers.size).toBe(0);
    await render(null);
    await act(async () => { for (const callback of [...timers.values()]) callback(); });
    expect(container.childNodes).toHaveLength(0);
    await render('first');
    await render(null);
    expect(timers.size).toBe(1);
  } finally {
    await act(async () => root.unmount());
    expect(timers.size).toBe(0);
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
