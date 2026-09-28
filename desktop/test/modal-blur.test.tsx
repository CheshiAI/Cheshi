import { expect, test } from 'bun:test';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { Modal } from '../frontend/src/shared/ui/Modal';
import { registerModalBlur } from '../frontend/src/shared/ui/modalBlur';

function sceneFilter(document: Document, app: HTMLElement) {
  const id = app.style.filter.match(/url\(["']?#([^"')]+)["']?\)/)?.[1];
  if (!id) throw new Error('Expected a scene blur filter.');
  const filter = document.getElementById(id);
  if (!filter) throw new Error('Scene blur filter is missing.');
  return filter;
}

async function withDOM(run: (h: {
  document: Document; app: HTMLElement;
  render: (props?: { first?: boolean; second?: boolean; disabled?: boolean }) => Promise<void>;
  flush: () => Promise<void>; cancelled: () => number;
}) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, HTMLElement: window.HTMLElement, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const app = document.createElement('div'); app.id = 'app'; document.body.append(app);
  const root = createRoot(app);
  let cancelled = 0;
  try {
    await run({ document, app, cancelled: () => cancelled,
      flush: async () => { await window.happyDOM.waitUntilComplete(); },
      render: async ({ first = true, second = false, disabled = false } = {}) => {
        await act(async () => root.render(<StrictMode>
          <button id="trigger">Open</button>
          {first && <Modal title="First" closeDisabled={disabled} onClose={() => { cancelled++; }}><input defaultValue="Keep this draft" /></Modal>}
          {second && <Modal title="Second" onClose={() => { cancelled++; }}><button>Cancel second</button></Modal>}
        </StrictMode>));
      },
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('modal blurs the original scene, leaves foreground sharp, and restores styles and focus', async () => {
  await withDOM(async h => {
    await h.render({ first: false });
    const trigger = h.document.querySelector<HTMLButtonElement>('#trigger')!;
    trigger.focus();
    h.app.style.setProperty('filter', 'opacity(0.9)', 'important');
    await h.render();
    const dialog = h.document.querySelector('dialog')!;
    expect(dialog.open).toBe(true);
    expect(dialog.style.filter).toBe('');
    expect(dialog.querySelector('[data-liquid-glass-backdrop="true"]')).toBeNull();
    expect(h.app.style.filter).toContain('opacity(0.9) url(');
    expect(sceneFilter(h.document, h.app).querySelectorAll('feGaussianBlur').length).toBe(2);
    await h.render({ first: false });
    expect(h.app.style.filter).toBe('opacity(0.9)');
    expect(h.app.style.getPropertyPriority('filter')).toBe('important');
    expect(h.document.querySelector('feGaussianBlur')).toBeNull();
    expect(h.document.activeElement).toBe(trigger);
  });
});

test('nested modals share one scene filter and only the active modal owns the dimming backdrop', async () => {
  await withDOM(async h => {
    await h.render();
    const first = h.document.querySelector('dialog')!;
    const input = first.querySelector('input')!; input.focus();
    const sceneFilter = h.app.style.filter;
    await h.render({ second: true });
    const second = h.document.querySelectorAll('dialog')[1]!;
    expect(h.app.style.filter).toBe(sceneFilter);
    expect(first.style.filter).toContain('url(');
    expect(first.dataset.modalBlurTop).toBe('false');
    expect(second.dataset.modalBlurTop).toBe('true');
    expect(second.style.filter).toBe('');
    await h.render();
    expect(first.style.filter).toBe('');
    expect(first.dataset.modalBlurTop).toBe('true');
    expect(input.value).toBe('Keep this draft');
    expect(h.document.activeElement).toBe(input);
    await h.render({ first: false });
    expect(h.app.style.filter).toBe('');
  });
});

test('extra blur follows the rounded modal region while the outside scene retains its base blur', async () => {
  await withDOM(async h => {
    await h.render();
    const dialog = h.document.querySelector('dialog')!;
    const rect = (x: number, y: number, width: number, height: number) =>
      ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON() { return {}; } });
    let sourceWidth = 600, dialogX = 100;
    Object.defineProperties(h.app, {
      offsetWidth: { get: () => sourceWidth }, offsetHeight: { get: () => 400 },
      getBoundingClientRect: { value: () => rect(0, 0, sourceWidth, 400) },
    });
    Object.defineProperty(dialog, 'getBoundingClientRect', { value: () => rect(dialogX, 100, 200, 100) });
    dialog.style.borderRadius = '16px';
    const refresh = () => h.document.defaultView!.dispatchEvent(new Event('resize'));
    const mask = () => decodeURIComponent(sceneFilter(h.document, h.app).querySelector('feImage')?.getAttribute('href')?.split(',').slice(1).join(',') ?? '');
    refresh();
    expect(mask()).toContain('M116 100');
    const filter = sceneFilter(h.document, h.app);
    expect(filter.querySelector('feGaussianBlur[in="scene"]')?.getAttribute('stdDeviation')).toBe('16');
    expect(filter.querySelector('feComposite[in="scene"]')?.getAttribute('operator')).toBe('out');
    expect(dialog.style.filter).toBe('');
    dialogX = 200; sourceWidth = 700; refresh();
    expect(mask()).toContain('M216 100');
    expect(filter.getAttribute('width')).toBe('700');
    dialogX = 800; sourceWidth = 500; refresh();
    expect(mask()).toBe('');
    expect(filter.getAttribute('width')).toBe('500');
    expect(h.app.style.filter).toContain('url(');
  });
});

test('portals added behind the modal are filtered and removed sources recover their original styles', async () => {
  await withDOM(async h => {
    await h.render();
    const portal = h.document.createElement('div');
    portal.style.filter = 'contrast(0.9)';
    h.document.body.append(portal); await h.flush();
    expect(portal.style.filter).toContain('contrast(0.9) url(');
    portal.remove(); await h.flush();
    expect(portal.style.filter).toBe('contrast(0.9)');
    await h.render({ first: false });
    const later = h.document.createElement('div'); h.document.body.append(later); await h.flush();
    expect(later.style.filter).toBe('');
  });
});

test('out-of-order release and native close leave the remaining modal sharp and restore the scene', async () => {
  await withDOM(async h => {
    await h.render({ first: false });
    const first = h.document.createElement('dialog'), second = h.document.createElement('dialog');
    h.document.body.append(first, second);
    first.showModal(); const releaseFirst = registerModalBlur(first);
    second.showModal(); const releaseSecond = registerModalBlur(second);
    releaseFirst(); first.close(); first.remove(); await h.flush();
    expect(second.style.filter).toBe('');
    expect(h.app.style.filter).toContain('url(');
    second.close(); await h.flush();
    expect(h.app.style.filter).toBe('');
    releaseSecond(); releaseSecond(); second.remove();
    expect(h.document.querySelector('feGaussianBlur')).toBeNull();
  });
});

test('pending modal still prevents native Escape cancellation', async () => {
  await withDOM(async h => {
    await h.render({ disabled: true });
    const dialog = h.document.querySelector('dialog')!;
    await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
    expect(h.cancelled()).toBe(0);
    expect(dialog.open).toBe(true);
    await h.render({ disabled: false });
    await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
    expect(h.cancelled()).toBe(1);
  });
});
