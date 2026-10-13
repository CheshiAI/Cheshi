import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useRelationshipGraphMenu } from '../frontend/src/features/shell/useRelationshipGraphMenu';

test('graph menu uses the latest workspace navigation and unsubscribes on unmount', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const listeners = new Set<() => void>();
  let subscriptions = 0;
  const api = { onRelationshipGraphRequested(listener: () => void) {
    subscriptions++; listeners.add(listener);
    return () => { listeners.delete(listener); };
  } };
  const opened: string[] = [];
  function Fixture({ pane }: { pane: string }) {
    useRelationshipGraphMenu(view => opened.push(`${pane}:${view}`), api);
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Fixture pane="chat" />));
    for (const listener of listeners) listener();
    expect(opened).toEqual(['chat:codegraph']);
    await act(async () => root.render(<Fixture pane="split-editor" />));
    for (const listener of listeners) listener();
    expect(opened).toEqual(['chat:codegraph', 'split-editor:codegraph']);
    expect(subscriptions).toBe(1);
    await act(async () => root.render(null));
    expect(listeners.size).toBe(0);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
