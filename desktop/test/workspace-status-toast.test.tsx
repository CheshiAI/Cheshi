import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { IpcRenderer } from 'electron';
import { forwardWorkspaceStatusToast } from '../lib/workspace-status-toast.mts';
import { createWorkspaceHostApi, createWorkspaceSurfaceApi } from '../lib/workspace-host-preload.cts';
import { StatusToast } from '../frontend/src/shared/ui/StatusToast';
import { WorkspaceStatusToasts } from '../frontend/src/features/shell/WorkspaceStatusToasts';
import { WORKSPACE_HOST_CHANNEL as channel } from '../shared/workspace-host';
import type { WorkspaceHostApi } from '../shared/workspace-host';
import type { StatusToastMessage } from '../shared/status-toast';

const message: StatusToastMessage = { id: 1, variant: 'success', title: 'Keep awake enabled', description: 'Your Mac will stay awake.' };

function toastHost(showStatusToast: WorkspaceHostApi['showStatusToast']): WorkspaceHostApi {
  return {
    showStatusToast,
    state: async () => ({ activeId: null, entries: [] }),
    activate: async () => {}, close: async () => {}, command: async () => {}, layout: async () => {},
    railOverlay: () => {}, onRailEvent: () => () => {}, onState: () => () => {},
  };
}

test('routes only trusted host messages to the currently selected live surface', () => {
  const host = {}, sent: unknown[] = [];
  const target = { isDestroyed: () => false, send: (...args: unknown[]) => { sent.push(args); } };
  expect(forwardWorkspaceStatusToast(host, host, target, message)).toBe(true);
  expect(sent).toEqual([[`${channel}:status-toast`, message]]);
  for (const invalid of [null, {}, { ...message, variant: 'unknown' }, { ...message, id: NaN },
    { ...message, title: 'x'.repeat(513) }, { ...message, description: 42 }]) {
    expect(forwardWorkspaceStatusToast(host, host, target, invalid)).toBe(false);
  }
  expect(forwardWorkspaceStatusToast({}, host, target, message)).toBe(false);
  expect(forwardWorkspaceStatusToast(host, host, undefined, message)).toBe(false);
  expect(forwardWorkspaceStatusToast(host, host, { ...target, isDestroyed: () => true }, message)).toBe(false);
  expect(sent).toHaveLength(1);
});

test('preload relays the payload without exposing IPC events and unsubscribes', async () => {
  const calls: unknown[] = [];
  const listeners = new Map<string, (event: unknown, value: StatusToastMessage) => void>();
  const ipc = {
    invoke: async (...args: unknown[]) => { calls.push(args); return true; },
    on: (name: string, handler: (event: unknown, value: StatusToastMessage) => void) => { listeners.set(name, handler); },
    off: (name: string) => { listeners.delete(name); },
  } as unknown as IpcRenderer;
  const host = createWorkspaceHostApi(ipc), surface = createWorkspaceSurfaceApi(ipc);
  expect(await host.showStatusToast(message)).toBe(true);
  expect(calls).toEqual([[`${channel}:status-toast`, message]]);
  const received: StatusToastMessage[] = [];
  const unsubscribe = surface.onStatusToast(value => received.push(value));
  listeners.get(`${channel}:status-toast`)?.({ sender: 'private' }, message);
  expect(received).toEqual([message]);
  unsubscribe();
  expect(listeners.size).toBe(0);
});

test('host toasts render in the foreground surface, retain close behavior, and fall back when delivery fails', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Node: window.Node,
    HTMLElement: window.HTMLElement, ResizeObserver: window.ResizeObserver, MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  // React detects input-event support on import; initialize it after installing the test DOM.
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container);
  let received: StatusToastMessage | undefined, dismissed = 0;
  const appWindow = globalThis.window;
  try {
    appWindow.workspaceHost = toastHost(async value => { received = value; return true; });
    await act(async () => root.render(<StatusToast message={message} onDismiss={() => { dismissed++; }} />));
    expect(received).toEqual(message);
    expect(dismissed).toBe(1);
    expect(document.querySelector('[role="status"]')).toBeNull();
    await act(async () => root.render(null));
    delete appWindow.workspaceHost;
    let listener: ((value: StatusToastMessage) => void) | undefined;
    let unsubscribed = false;
    appWindow.workspaceSurface = { reportModal: () => {}, onStatusToast: callback => {
      listener = callback;
      return () => { unsubscribed = true; listener = undefined; };
    }, report: () => {}, onRailBlur: () => () => {}, onCommand: () => () => {} };
    await act(async () => root.render(<WorkspaceStatusToasts />));
    await act(async () => listener!(received!));
    expect(document.querySelector('[role="status"]')?.textContent).toContain(message.title);
    expect(container.contains(document.querySelector('[role="status"]'))).toBe(false);
    await act(async () => listener!({ ...message, title: 'Keep awake disabled' }));
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Keep awake disabled');
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close notification"]')!.click());
    expect(document.querySelector('[role="status"]')).toBeNull();
    await act(async () => root.render(null));
    expect(unsubscribed).toBe(true);
    delete appWindow.workspaceSurface;
    for (const result of ['false', 'error'] as const) {
      appWindow.workspaceHost = toastHost(async () => {
        if (result === 'error') throw new Error('Connection unavailable');
        return false;
      });
      await act(async () => root.render(<StatusToast message={message} onDismiss={() => { dismissed++; }} />));
      expect(document.querySelector('[role="status"]')?.textContent).toContain(message.title);
      await act(async () => root.render(null));
    }
    expect(dismissed).toBe(1);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
