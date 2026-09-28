import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';

function createDeferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

test('locked note screen opens only on request, prevents duplicates and scopes failures to the selected note', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { LockedNoteState } = await import('../frontend/src/features/notes/LockedNoteState');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const calls: string[] = [];
  let operation = createDeferred();
  const api = { open: async (id: string) => { calls.push(id); await operation.promise; } };
  const render = async (id: string) => { await act(async () => root.render(<LockedNoteState key={id} noteId={id} api={api} />)); };
  const button = () => container.querySelector<HTMLButtonElement>('button')!;
  try {
    await render('locked');
    expect(container.textContent).toContain('This note is locked');
    expect(button().textContent).toBe('Open in Apple Notes');
    expect(container.querySelector('input') === null).toBe(true);
    expect(calls).toEqual([]);
    await act(async () => { button().click(); button().click(); });
    expect(calls).toEqual(['locked']);
    expect(button().disabled).toBe(true);
    await act(async () => { operation.reject(new Error('Allow Notes automation.')); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Allow Notes automation.');
    expect(button().disabled).toBe(false);
    operation = createDeferred();
    await act(async () => button().click());
    expect(container.querySelector('[role="alert"]') === null).toBe(true);
    await render('other');
    await act(async () => { operation.reject(new Error('Late error')); });
    expect(button().disabled).toBe(false);
    expect(container.querySelector('[role="alert"]') === null).toBe(true);
    operation = createDeferred();
    await act(async () => button().click());
    expect(calls).toEqual(['locked', 'locked', 'other']);
    await act(async () => { operation.resolve(); });
    expect(button().disabled).toBe(false);
    expect(container.textContent).toContain('This note is locked');
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
