import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatDeleteRecordDialog } from '../frontend/src/features/chat/ChatDeleteRecordDialog';

async function withDialog(kind: 'turn' | 'history', run: (h: {
  render(pending: boolean): Promise<void>;
  escape(): Promise<void>;
  calls: { panelClosed: number; dialogClosed: number; deleted: number };
}) => Promise<void>) {
  const window = new Window();
  const showModal = window.HTMLDialogElement.prototype.showModal;
  // Model the native focus step that Happy DOM omits.
  window.HTMLDialogElement.prototype.showModal = function () {
    showModal.call(this);
    const first = this.querySelector('button:not(:disabled)');
    if (first instanceof window.HTMLButtonElement) first.focus();
  };
  const globals = { window, document: window.document, HTMLElement: window.HTMLElement,
    Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const calls = { panelClosed: 0, dialogClosed: 0, deleted: 0 };
  const render = async (pending: boolean) => {
    await act(async () => root.render(<section onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); calls.panelClosed++; }
    }}>
      <ChatDeleteRecordDialog kind={kind} recordTitle="Synthetic saved record" pending={pending} error={null}
        onDelete={async () => { calls.deleted++; return true; }} onClose={() => { calls.dialogClosed++; }} />
    </section>));
  };
  try {
    await render(false);
    await run({ calls, render, escape: async () => {
      await act(async () => {
        const key = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        window.document.activeElement!.dispatchEvent(key);
        // Native dialog cancellation only follows an Escape whose default was not prevented.
        if (!key.defaultPrevented) window.document.querySelector('dialog')!.dispatchEvent(new window.Event('cancel', { cancelable: true }));
      });
    } });
  } finally {
    await act(async () => root.unmount());
    window.HTMLDialogElement.prototype.showModal = showModal;
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test.each(['turn', 'history'] as const)('%s deletion focuses Cancel after opening and confines Escape to the modal', async kind => {
  await withDialog(kind, async h => {
    expect(document.querySelector('dialog')?.open).toBe(true);
    expect(document.activeElement === document.querySelector('button[name="cancel"]')).toBe(true);
    await h.escape();
    expect(h.calls).toEqual({ panelClosed: 0, dialogClosed: 1, deleted: 0 });
  });
});

test('pending deletion blocks Escape without closing the panel behind the modal', async () => {
  await withDialog('turn', async h => {
    await h.render(true);
    document.querySelector('dialog')!.focus();
    await h.escape();
    expect(h.calls).toEqual({ panelClosed: 0, dialogClosed: 0, deleted: 0 });
    await h.render(false);
    document.querySelector<HTMLButtonElement>('button[name="cancel"]')!.focus();
    await h.escape();
    expect(h.calls).toEqual({ panelClosed: 0, dialogClosed: 1, deleted: 0 });
  });
});
