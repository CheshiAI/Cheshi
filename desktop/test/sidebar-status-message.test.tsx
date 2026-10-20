import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { CanvasSidebar } from '../frontend/src/features/canvas/CanvasSidebar';
import { ChatSessionList } from '../frontend/src/features/chat/ChatSessionList';
import type { ChatSession } from '../frontend/src/features/chat/model';
import { SidebarStatusContext } from '../frontend/src/shared/ui/SidebarStatusMessage';
import type { CanvasApi, CanvasLibraryListing } from '../shared/canvas';
import type { Sidebar } from '../frontend/src/features/navigation/Sidebar';
import type { SidebarRail } from '../frontend/src/features/navigation/SidebarRail';
import { props, shellHarness } from './workspace-shell-test-harness';

const noop = () => {};
const rename = async () => {};
const deleteReason = () => null;
const unexpected = async (): Promise<never> => { throw new Error('Unexpected canvas operation'); };

test('the shell selects guidance from the current sidebar and hides it when the sidebar closes', () => {
  const app = shellHarness();
  const context = () => props<ComponentProps<typeof SidebarStatusContext.Provider>>(app.render(), 'SidebarStatusContext').value;
  const sidebar = () => props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
  const rail = () => props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail');
  expect(context().activePanel).toBe('files');
  sidebar().onPanelChange!('chats');
  expect(context().activePanel).toBe('chats');
  sidebar().onPanelChange!('canvas');
  expect(context().activePanel).toBe('canvas');
  rail().onToggleSidebar();
  expect(context().activePanel).toBeNull();
  rail().onToggleSidebar();
  expect(context().activePanel).toBe('canvas');
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function Fixture({ panel, canvasTarget, api, sessions, loading, refresh }: {
  panel: string | null; canvasTarget: HTMLElement; api: CanvasApi;
  sessions: ChatSession[]; loading: boolean; refresh: number;
}) {
  const [target, setTarget] = useState<HTMLSpanElement | null>(null);
  return <SidebarStatusContext.Provider value={{ activePanel: panel, target }}>
    <ChatSessionList sessions={sessions} loading={loading} activeSessionId={null} responseThreadIds={[]}
      newChatDisabled={false} selectionDisabled={false} onOpen={noop} onNew={noop} onDelete={noop} deleteReason={deleteReason} />
    {createPortal(<CanvasSidebar api={api} currentPath="" busy={false} ready canSave={false} refresh={refresh}
      onOpen={noop} onSave={noop} onCreate={noop} onRename={rename} onError={noop} />, canvasTarget)}
    <footer><span ref={setTarget} role="status" aria-label="Sidebar guidance" /></footer>
  </SidebarStatusContext.Provider>;
}

test('empty guidance follows the visible sidebar, clears during loading, and disappears when content arrives', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, ResizeObserver: window.ResizeObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div'), canvasTarget = document.createElement('div');
  document.body.append(host, canvasTarget);
  const root = createRoot(host);
  let listing: CanvasLibraryListing = { workspaceRoot: '/workspace', canvasRoot: null,
    historyDirectory: '/history', files: [], truncated: false };
  const pending = createDeferred<CanvasLibraryListing>();
  let waiting = true;
  const api: CanvasApi = {
    list: () => waiting ? pending.promise : Promise.resolve(listing),
    chooseRoot: unexpected, newPath: unexpected, rename: unexpected, lastDocument: unexpected,
    rememberDocument: unexpected, read: unexpected, save: unexpected, history: unexpected,
    readVersion: unexpected, checkpoint: unexpected, restore: unexpected,
  };
  let panel: string | null = 'chats', loading = false, refresh = 0;
  let sessions: ChatSession[] = [];
  const render = async () => { await act(async () => root.render(
    <Fixture panel={panel} canvasTarget={canvasTarget} api={api} sessions={sessions} loading={loading} refresh={refresh} />,
  )); };
  const guidance = () => host.querySelector('[aria-label="Sidebar guidance"]')!;
  try {
    await render();
    expect(guidance().textContent).toBe('your workspace chats will appear here.');
    const conversationList = host.querySelector('[aria-label="Conversations"]')!;
    expect(conversationList.textContent).toBe('');
    expect(conversationList.querySelector('svg')).toBeNull();
    expect(host.querySelector('[aria-label="New chat"]')).not.toBeNull();

    loading = true; await render();
    expect(guidance().textContent).toBe('');
    loading = false;
    sessions = [{ id: 'saved', title: 'Saved session', preview: '', createdAt: 1, updatedAt: 1, status: 'idle' }];
    await render();
    expect(guidance().textContent).toBe('');
    expect(host.querySelector('[aria-label="Saved session"]')).not.toBeNull();

    panel = 'canvas'; await render();
    expect(guidance().textContent).toBe('');
    await act(async () => { waiting = false; pending.resolve(listing); });
    expect(guidance().textContent).toBe('choose a canvas folder with +.');
    expect(canvasTarget.textContent).not.toContain('choose a canvas folder');
    expect(canvasTarget.querySelector('[aria-label="Add canvas"]')).not.toBeNull();

    sessions = []; panel = 'chats'; await render();
    expect(guidance().textContent).toBe('your workspace chats will appear here.');
    panel = 'files'; await render();
    expect(guidance().textContent).toBe('');
    panel = null; await render();
    expect(guidance().textContent).toBe('');

    panel = 'canvas'; listing = { ...listing, canvasRoot: 'designs' }; refresh++; await render();
    expect(guidance().textContent).toBe('no canvases in this folder. use + to create a new canvas.');
    expect(canvasTarget.textContent).not.toContain('no canvases in this folder');
    listing = { ...listing, files: [{ path: 'designs/screen.fig', size: 8, modifiedAt: 1 }] }; refresh++; await render();
    expect(guidance().textContent).toBe('');
    expect(canvasTarget.querySelector('[data-canvas-path="designs/screen.fig"]')).not.toBeNull();

    await act(async () => root.render(null));
    expect(canvasTarget.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
