import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceDeleteEntryDialog } from '../frontend/src/features/navigation/WorkspaceDeleteEntryDialog';
import type { CheshiWorkspaceEntry } from '../frontend/src/cheshiDesktop';

const entry: CheshiWorkspaceEntry = {
  name: 'sample.ts', path: 'src/sample.ts', kind: 'file', size: 10, modifiedAt: 1, revision: 'r1',
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

async function withDialog(run: (h: {
  submit(): void;
  cancel(): void;
  button(label: string): HTMLButtonElement;
  calls: { deleted: number; closed: number };
  requests: ReturnType<typeof createDeferred<boolean>>[];
}) => Promise<void>, target = entry) {
  const window = new Window();
  const showModal = window.HTMLDialogElement.prototype.showModal;
  // Happy DOM does not perform the browser's initial dialog focus step.
  window.HTMLDialogElement.prototype.showModal = function () {
    showModal.call(this);
    const firstButton = this.querySelector('button:not(:disabled)');
    if (firstButton instanceof window.HTMLButtonElement) firstButton.focus();
  };
  const globals = { window, document: window.document, HTMLElement: window.HTMLElement,
    Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const calls = { deleted: 0, closed: 0 };
  const requests = [createDeferred<boolean>(), createDeferred<boolean>()];
  try {
    await act(async () => root.render(<WorkspaceDeleteEntryDialog entry={target}
      onDelete={() => requests[calls.deleted++]!.promise} onClose={() => { calls.closed++; }} />));
    await run({ calls, requests,
      submit: () => { document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event); },
      cancel: () => { document.querySelector('dialog')!.dispatchEvent(new window.Event('cancel', { cancelable: true }) as unknown as Event); },
      button: label => [...document.querySelectorAll('button')].find(button => button.textContent === label)!,
    });
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

test.each(['file', 'directory'] as const)('shows the %s target and cancels without deletion', async kind => {
  await withDialog(async h => {
    expect(document.querySelector('dialog')?.open).toBe(true);
    expect(document.body.textContent).toContain('MOVE TO TRASH');
    expect(document.body.textContent).toContain(entry.path);
    expect(document.body.textContent).toContain(kind === 'directory'
      ? 'This folder and its contents will be moved to Trash.' : 'This file will be moved to Trash.');
    expect(document.activeElement === h.button('Cancel')).toBe(true);
    expect(h.calls.deleted).toBe(0);
    await act(async () => h.button('Cancel').click());
    expect(h.calls).toEqual({ deleted: 0, closed: 1 });
  }, { ...entry, kind });
});

test('blocks duplicate submissions and dismissal until Trash completes', async () => {
  await withDialog(async h => {
    await act(async () => { h.submit(); h.submit(); h.cancel(); });
    expect(h.calls).toEqual({ deleted: 1, closed: 0 });
    expect(h.button('Cancel').disabled).toBe(true);
    expect(h.button('Move to Trash').disabled).toBe(true);
    expect(document.querySelector('[aria-label="Close dialog"]')?.hasAttribute('disabled')).toBe(true);
    expect(document.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Moving to Trash…');
    await act(async () => { h.cancel(); h.button('Cancel').click(); });
    expect(h.calls.closed).toBe(0);
    await act(async () => { h.requests[0]!.resolve(true); });
    expect(h.calls).toEqual({ deleted: 1, closed: 1 });
  });
});

test.each(['busy', 'error'] as const)('keeps the dialog open after %s and allows retry', async failure => {
  await withDialog(async h => {
    await act(async () => h.submit());
    await act(async () => {
      if (failure === 'busy') h.requests[0]!.resolve(false);
      else h.requests[0]!.reject(new Error('Permission denied.'));
    });
    expect(h.calls.closed).toBe(0);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(failure === 'busy'
      ? 'Another file operation is in progress. Please try again.' : 'Permission denied.');
    expect(h.button('Move to Trash').disabled).toBe(false);
    await act(async () => h.submit());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(h.calls.deleted).toBe(2);
    await act(async () => { h.requests[1]!.resolve(true); });
    expect(h.calls.closed).toBe(1);
  });
});

test('Escape dismisses an idle dialog without deleting', async () => {
  await withDialog(async h => {
    await act(async () => h.cancel());
    expect(h.calls).toEqual({ deleted: 0, closed: 1 });
  });
});
