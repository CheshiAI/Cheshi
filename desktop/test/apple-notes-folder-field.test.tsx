import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppleNotesFolderField } from '../frontend/src/features/notes/AppleNotesFolderField';
import { Modal } from '../frontend/src/shared/ui/Modal';
import type { AppleNotesFolder } from '../shared/apple-notes';

const folders: AppleNotesFolder[] = [
  { id: 'personal', name: 'Notes', path: 'Notes', account: 'Personal', isDefault: true },
  { id: 'work', name: 'Notes', path: 'Projects / Notes', account: 'Work', isDefault: false },
];

test.each([true, false])('folder dropdown in a modal handles selection and unavailable folders (available: %s)', async available => {
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
  const menuBox = () => new window.DOMRect(150, 180, 220, 120);
  const originalBounds = window.HTMLElement.prototype.getBoundingClientRect;
  const originalRects = window.HTMLElement.prototype.getClientRects;
  Object.defineProperties(window.HTMLElement.prototype, {
    getBoundingClientRect: { configurable: true, value(this: HTMLElement) {
      return this.getAttribute('role') === 'menu' ? menuBox() : originalBounds.call(this);
    } },
    getClientRects: { configurable: true, value(this: HTMLElement) {
      return this.getAttribute('role') === 'menu' ? [menuBox()] : originalRects.call(this);
    } },
  });
  const css = document.createElement('style');
  css.textContent = '[role="menu"] { display: block; visibility: visible; opacity: 1; border-radius: 8px; }';
  document.head.append(css);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const changes: string[] = [];
  let closed = 0;
  let setDisabled!: (value: boolean) => void;
  function Fixture() {
    const [value, setValue] = useState('personal');
    const [disabled, updateDisabled] = useState(false);
    setDisabled = updateDisabled;
    return <Modal title="Save response" onClose={() => { closed++; }}>
      <AppleNotesFolderField folders={available ? folders : []} value={value} disabled={disabled}
        onChange={next => { changes.push(next); setValue(next); }} />
      <input aria-label="Title" />
    </Modal>;
  }
  const flushFrames = async () => act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(0));
  });
  const key = async (value: string) => act(async () => {
    const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
    window.document.activeElement!.dispatchEvent(event);
    // Happy DOM does not perform the browser's native Escape cancellation.
    if (value === 'Escape' && !event.defaultPrevented) {
      window.document.querySelector('dialog')!.dispatchEvent(new window.Event('cancel', { cancelable: true }));
    }
  });
  try {
    await act(async () => root.render(<Fixture />));
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Folder"]')!;
    const dialog = document.querySelector('dialog')!;
    const surface = dialog.querySelector<HTMLDivElement>(':scope > div')!;
    Object.defineProperties(surface, {
      offsetWidth: { configurable: true, value: 600 }, offsetHeight: { configurable: true, value: 500 },
      getBoundingClientRect: { configurable: true, value: () => new window.DOMRect(100, 100, 600, 500) },
    });
    const sceneFilter = container.style.filter;
    expect(dialog.open).toBe(true);
    expect(surface.style.filter).toBe('');
    expect(trigger.disabled).toBe(!available);
    if (!available) {
      expect(trigger.textContent).toBe('No folders available');
      await act(async () => { trigger.click(); });
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(changes).toEqual([]);
      return;
    }
    await act(async () => { trigger.focus(); });
    await key('ArrowDown');
    await flushFrames();
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.closest('dialog')).toBe(dialog);
    expect(menu.parentElement?.parentElement).toBe(dialog);
    expect(surface.contains(menu)).toBe(false);
    expect(menu.getAttribute('data-regional-blur-surface')).toBe('true');
    const filterId = surface.getAttribute('data-regional-blur-source')!;
    const filter = document.getElementById(filterId)!;
    expect(surface.style.filter).toContain(filterId);
    expect(filter.querySelector('feGaussianBlur')?.getAttribute('stdDeviation')).toBe('16');
    const mask = decodeURIComponent(filter.querySelector('feImage')!.getAttribute('href')!.split(',').slice(1).join(','));
    expect(mask).toContain('M58 80');
    expect((menu as HTMLElement).style.filter).toBe('');
    expect(dialog.style.filter).toBe('');
    expect(container.style.filter).toBe(sceneFilter);
    expect(document.activeElement?.textContent).toBe('Personal / Notes');
    await key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Work / Projects / Notes');
    await act(async () => { (document.activeElement as HTMLButtonElement).click(); });
    expect(changes).toEqual(['work']);
    expect(trigger.textContent).toBe('Work / Projects / Notes');
    expect(trigger.getAttribute('aria-description')).toBe('Work / Projects / Notes');
    expect(document.activeElement).toBe(trigger);
    expect(surface.style.filter).toBe('');
    expect(surface.hasAttribute('data-regional-blur-source')).toBe(false);
    await act(async () => { trigger.click(); });
    await flushFrames();
    expect(document.activeElement?.getAttribute('aria-checked')).toBe('true');
    await key('Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(surface.style.filter).toBe('');
    expect(document.activeElement).toBe(trigger);
    expect(closed).toBe(0);
    await key('Escape');
    expect(closed).toBe(1);
    await act(async () => { trigger.click(); });
    await act(async () => {
      window.document.querySelector('input')!.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(closed).toBe(1);
    await act(async () => { trigger.click(); });
    await act(async () => { setDisabled(true); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(trigger.disabled).toBe(true);
    expect(changes).toEqual(['work']);
  } finally {
    await act(async () => root.unmount());
    expect(document.querySelector('filter')).toBeNull();
    Object.defineProperties(window.HTMLElement.prototype, {
      getBoundingClientRect: { configurable: true, value: originalBounds },
      getClientRects: { configurable: true, value: originalRects },
    });
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
