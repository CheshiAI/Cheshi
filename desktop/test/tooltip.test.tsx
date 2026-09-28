import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';

mock.module('../frontend/src/shared/ui/Tooltip.module.css', () => ({
  default: { anchor: 'tooltip-anchor', content: 'tooltip-content' },
}));

test.each(['button', 'disabled-button', 'text', 'nested', 'svg'] as const)('shared tooltip supports %s anchors, delay, dismissal and cleanup', async kind => {
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
  const { TooltipTarget } = await import('../frontend/src/shared/ui/TooltipTarget');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let entered = 0;
  let clicked = 0;
  const content = 'Full node name\nsource/file.ts:42';
  let disabled = kind === 'disabled-button';
  let tooltipContent: string | undefined = content;
  const textRef = { current: null as HTMLSpanElement | null };
  const Fixture = () => kind === 'button' || kind === 'disabled-button'
    ? <TooltipButton disabled={disabled} title={tooltipContent} onPointerEnter={() => entered++} onClick={() => clicked++}>Open</TooltipButton>
    : kind === 'nested' ? <TooltipTarget content="Attachment path"><div><TooltipButton title={content} onClick={() => clicked++}>Remove attachment</TooltipButton></div></TooltipTarget>
    : kind === 'text' ? <TooltipTarget content={content}><span ref={textRef} tabIndex={0} onPointerEnter={() => entered++} onClick={() => clicked++}>File path</span></TooltipTarget>
    : <svg><Tooltip<SVGGElement> content={content}>{trigger => <g {...trigger} tabIndex={0}
      role="button" aria-label="Node" onClick={() => clicked++}><rect width="100" height="40" /></g>}</Tooltip></svg>;
  try {
    await act(async () => root.render(<Fixture />));
    const anchor = container.querySelector(kind === 'svg' ? 'g' : kind === 'text' ? 'span' : 'button')!;
    const pointer = (type: string) => anchor.dispatchEvent(new window.PointerEvent(type, {
      bubbles: true, pointerType: 'mouse',
    }) as unknown as Event);
    const open = async () => {
      await act(async () => { pointer('pointerover'); });
      await act(async () => { advance(1000); });
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(content);
    };
    expect(anchor.hasAttribute('title')).toBe(false);
    if (kind === 'text') expect(textRef.current?.isSameNode(anchor)).toBe(true);
    expect(container.querySelector('title')).toBeNull();
    await act(async () => { pointer('pointerover'); });
    await act(async () => { advance(999); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => { advance(1); });
    const tooltip = document.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).toBe(content);
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
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
    expect(clicked).toBe(kind === 'disabled-button' ? 0 : 1);
    if (kind === 'disabled-button') expect((anchor as HTMLButtonElement).disabled).toBe(true);
    if (kind === 'button') expect(entered).toBe(3);
    if (kind === 'button' || kind === 'disabled-button') {
      disabled = !disabled;
      tooltipContent = undefined;
      await act(async () => root.render(<Fixture />));
      expect(container.querySelector('button')?.isSameNode(anchor)).toBe(true);

      expect(anchor.hasAttribute('aria-description')).toBe(false);
      disabled = !disabled;
      tooltipContent = content;
      await act(async () => root.render(<Fixture />));
      expect(container.querySelector('button')?.isSameNode(anchor)).toBe(true);
      expect(anchor.getAttribute('aria-description')).toBe(content);
    }
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
