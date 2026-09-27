import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { useWorkflowChatNavigation } from '../frontend/src/features/shell/useWorkflowChatNavigation';

type Workspace = Parameters<typeof useWorkflowChatNavigation>[0];

test('setup completion uses the latest live pane without querying saved history', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const selected: string[] = [], queried: string[] = [];
  let revealed = 0;
  let open: ReturnType<typeof useWorkflowChatNavigation> | undefined;
  const workspace: Workspace = {
    deletePending: false, paneIds: ['first', 'setup'],
    controllers: { first: { state: { activeSessionId: 'other-thread' } }, setup: { state: { activeSessionId: null } } },
    selectPane: id => { selected.push(id); },
    openSession: async id => { queried.push(id); return true; },
  };
  function Harness({ current }: { current: Workspace }) {
    open = useWorkflowChatNavigation(current, () => { revealed++; });
    return null;
  }
  let unmount: (() => Promise<void>) | undefined;
  try {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(document.createElement('div'));
    unmount = async () => { await act(async () => root.unmount()); };
    await act(async () => root.render(<Harness current={workspace} />));
    // The settings handler retains this callback while its setup IPC is pending.
    const pendingCompletion = open!;
    const started: Workspace = { ...workspace, controllers: { ...workspace.controllers,
      setup: { state: { activeSessionId: 'new-setup-thread' } } } };
    await act(async () => root.render(<Harness current={started} />));
    expect(await pendingCompletion('new-setup-thread')).toBe(true);
    expect(selected).toEqual(['setup']);
    expect(queried).toEqual([]);
    expect(revealed).toBe(1);

    // A conversation that is not already displayed still follows normal opening.
    expect(await pendingCompletion('saved-thread')).toBe(true);
    expect(queried).toEqual(['saved-thread']);
    expect(revealed).toBe(2);

    // The retained completion callback must also respect a new deletion guard.
    await act(async () => root.render(<Harness current={{ ...started, deletePending: true }} />));
    expect(await pendingCompletion('new-setup-thread')).toBe(false);
    expect(revealed).toBe(2);
    expect(selected).toEqual(['setup']);
    expect(queried).toEqual(['saved-thread']);
  } finally {
    await unmount?.();
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
