import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState } from 'react';

test.each(['standard', 'raised', 'pill'] as const)('%s select preserves selection, keyboard navigation and focus restoration', async appearance => {
  const window = new Window();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const globals = {
    window, document: window.document, navigator: window.navigator, Node: window.Node,
    HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { LiquidGlassSelect } = await import('../frontend/src/shared/ui/LiquidGlassSelect');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const changes: string[] = [];
  let setDisabled!: (value: boolean) => void;
  function Fixture() {
    const [value, setValue] = useState('directory');
    const [disabled, updateDisabled] = useState(false);
    setDisabled = updateDisabled;
    return <LiquidGlassSelect ariaLabel="Group by" triggerAppearance={appearance} menuAppearance="toolbar"
      value={value} disabled={disabled} options={[
        { value: 'directory', label: 'Directory' },
        { value: 'blocked', label: 'Unavailable', disabled: true },
        { value: 'language', label: 'Language' },
      ]} onChange={next => { changes.push(next); setValue(next); }} />;
  }
  const key = (target: Element, value: string) => target.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }) as unknown as Event,
  );
  const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(0));
  };
  try {
    await act(async () => root.render(<Fixture />));
    const trigger = container.querySelector('button')!;
    await act(async () => { trigger.focus(); key(trigger, 'ArrowDown'); });
    await act(async () => { flushFrames(); });
    const directory = document.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')!;
    expect(document.activeElement).toBe(directory);
    await act(async () => { key(directory, 'ArrowDown'); });
    const language = document.activeElement as HTMLButtonElement;
    expect(language.textContent).toBe('Language');
    expect(document.querySelector<HTMLButtonElement>('[role="menuitemradio"]:disabled')?.textContent).toBe('Unavailable');
    await act(async () => { language.click(); });
    expect(changes).toEqual(['language']);
    expect(trigger.textContent).toBe('Language');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await act(async () => { trigger.click(); });
    await act(async () => { flushFrames(); });
    expect(document.activeElement?.textContent).toBe('Language');
    await act(async () => { key(document.activeElement!, 'Escape'); });
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(changes).toEqual(['language']);
    await act(async () => { setDisabled(true); });
    expect(trigger.disabled).toBe(true);
    await act(async () => { trigger.click(); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
