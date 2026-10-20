import { expect, test } from 'bun:test';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { Modal } from '../frontend/src/shared/ui/Modal';
import { registerModalLayer } from '../frontend/src/shared/ui/modalBlur';
import type { WorkspaceSurfaceApi } from '../shared/workspace-host';

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

test('modal adds no background blur, preserves existing styles, and restores focus', async () => {
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
    expect(h.app.style.filter).toBe('opacity(0.9)');
    expect(h.app.style.getPropertyPriority('filter')).toBe('important');
    // Dropdowns inside a modal keep their own regional blur provider.
    expect(h.document.querySelectorAll('[id^="modal-scene-blur-"]').length).toBe(0);
    await h.render({ first: false });
    expect(h.app.style.filter).toBe('opacity(0.9)');
    expect(h.app.style.getPropertyPriority('filter')).toBe('important');
    expect(h.document.querySelector('feGaussianBlur')).toBeNull();
    expect(h.document.activeElement).toBe(trigger);
  });
});

test('nested modals keep the background unfiltered and only the active modal owns the dim', async () => {
  await withDOM(async h => {
    await h.render();
    const first = h.document.querySelector('dialog')!;
    const input = first.querySelector('input')!; input.focus();
    await h.render({ second: true });
    const second = h.document.querySelectorAll('dialog')[1]!;
    expect(h.app.style.filter).toBe('');
    expect(first.style.filter).toBe('');
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

test('the host stays blocked until the last modal closes, including native close and unmount', async () => {
  await withDOM(async h => {
    const states: boolean[] = [];
    h.document.defaultView!.workspaceSurface = {
      reportModal: (open: boolean) => { states.push(open); },
    } as WorkspaceSurfaceApi;
    await h.render();
    expect(states.at(-1)).toBe(true);
    states.length = 0;
    await h.render({ second: true });
    await h.render({ first: false, second: true });
    expect(states).not.toContain(false);
    h.document.querySelector('dialog')!.close();
    await h.flush();
    expect(states).toEqual([false]);
    await h.render({ first: false, second: false });
    expect(states).toEqual([false]);
    await h.render();
    expect(states.at(-1)).toBe(true);
    await h.render({ first: false });
    expect(states.at(-1)).toBe(false);
  });
});

test('portals behind the modal retain their own styles without receiving a modal filter', async () => {
  await withDOM(async h => {
    await h.render();
    const portal = h.document.createElement('div');
    portal.style.filter = 'contrast(0.9)';
    h.document.body.append(portal); await h.flush();
    expect(portal.style.filter).toBe('contrast(0.9)');
    portal.remove(); await h.flush();
    expect(portal.style.filter).toBe('contrast(0.9)');
    await h.render({ first: false });
    const later = h.document.createElement('div'); h.document.body.append(later); await h.flush();
    expect(later.style.filter).toBe('');
  });
});

test('out-of-order release and native close restore stack attributes without changing the scene', async () => {
  await withDOM(async h => {
    await h.render({ first: false });
    const first = h.document.createElement('dialog'), second = h.document.createElement('dialog');
    h.document.body.append(first, second);
    first.showModal(); const releaseFirst = registerModalLayer(first);
    second.showModal(); const releaseSecond = registerModalLayer(second);
    releaseFirst(); first.close(); first.remove(); await h.flush();
    expect(second.style.filter).toBe('');
    expect(h.app.style.filter).toBe('');
    expect(second.dataset.modalBlurTop).toBe('true');
    second.close(); await h.flush();
    expect(second.dataset.modalBlurTop).toBe('false');
    expect(h.app.style.filter).toBe('');
    releaseSecond(); releaseSecond(); second.remove();
    expect(second.hasAttribute('data-modal-blur-top')).toBe(false);
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
