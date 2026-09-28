import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';

mock.module('../frontend/src/shared/ui/Tooltip.module.css', () => ({
  default: { anchor: 'tooltip-anchor', content: 'tooltip-content' },
}));

test.each(['button', 'svg'] as const)('shared tooltip supports %s anchors, delay, dismissal and cleanup', async kind => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const timers = new Map<number, { at: number; callback: () => void }>();
  let now = 0;
  let sequence = 0;
  const timeoutDescriptors = new Map(['setTimeout', 'clearTimeout'].map(key => [key, Object.getOwnPropertyDescriptor(window, key)]));
  Object.defineProperty(window, 'setTimeout', { configurable: true, value: (callback: () => void, delay: number) => {
    timers.set(++sequence, { at: now + delay, callback });
    return sequence;
  } });
  Object.defineProperty(window, 'clearTimeout', { configurable: true, value: (id: number) => { timers.delete(id); } });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) { timers.delete(id); timer.callback(); }
    }
  };
  const { createRoot } = await import('react-dom/client');
  const { Tooltip } = await import('../frontend/src/shared/ui/Tooltip');
  const { TooltipButton } = await import('../frontend/src/shared/ui/TooltipButton');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let entered = 0;
  let clicked = 0;
  const content = 'Full node name\nsource/file.ts:42';
  const Fixture = () => kind === 'button'
    ? <TooltipButton title={content} onPointerEnter={() => entered++} onClick={() => clicked++}>Open</TooltipButton>
    : <svg><Tooltip<SVGGElement> content={content}>{trigger => <g {...trigger} tabIndex={0}
      role="button" aria-label="Node" onClick={() => clicked++}><rect width="100" height="40" /></g>}</Tooltip></svg>;
  try {
    await act(async () => root.render(<Fixture />));
    const anchor = container.querySelector(kind === 'button' ? 'button' : 'g')!;
    const pointer = (type: string) => anchor.dispatchEvent(new window.PointerEvent(type, {
      bubbles: true, pointerType: 'mouse',
    }) as unknown as Event);
    const open = async () => {
      await act(async () => { pointer('pointerover'); });
      await act(async () => { advance(1000); });
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(content);
    };
    expect(anchor.hasAttribute('title')).toBe(false);
    expect(container.querySelector('title')).toBeNull();
    await act(async () => { pointer('pointerover'); });
    await act(async () => { advance(999); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => { advance(1); });
    const tooltip = document.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).toBe(content);
    expect(tooltip.getAttribute('data-regional-blur-surface')).toBe('true');
    expect(tooltip.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
    expect(container.contains(tooltip)).toBe(false);
    expect(anchor.getAttribute('aria-describedby')).toBe(tooltip.id);
    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event);
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(anchor.hasAttribute('aria-describedby')).toBe(false);
    await open();
    await act(async () => { window.dispatchEvent(new window.Event('scroll')); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await open();
    await act(async () => { pointer('pointerout'); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => { anchor.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as unknown as Event); });
    expect(clicked).toBe(1);
    if (kind === 'button') expect(entered).toBe(3);
    await act(async () => { pointer('pointerover'); });
    expect(timers.size).toBe(1);
    await act(async () => root.render(null));
    expect(timers.size).toBe(0);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of timeoutDescriptors) {
      if (descriptor) Object.defineProperty(window, key, descriptor);
      else Reflect.deleteProperty(window, key);
    }
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
