import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import * as React from 'react';
import { createPortal } from 'react-dom';
import type { OriginalCanvasEditor } from '../frontend/src/features/canvas/integration/OriginalCanvasEditor';
import type { CanvasApi, CanvasSaveRequest } from '../shared/canvas';
import { CanvasSidebar } from '../frontend/src/features/canvas/CanvasSidebar';
import { CanvasCloseDialog } from '../frontend/src/features/canvas/CanvasCloseDialog';
import { Modal, NeumorphicButton, NeumorphicTextField } from '../frontend/src/shared/ui';
import { load } from './workspace-shell-test-harness';

test('Canvas host creates files safely and answers shared close dialogs through the bridge', async () => {
  const browser = new Window({ url: 'http://localhost/', settings: { disableIframePageLoading: true } });
  const editorWindow = new Window({ url: 'http://localhost/' });
  const globals = { window: browser, document: browser.document, location: browser.location, navigator: browser.navigator,
    Event: browser.Event, KeyboardEvent: browser.KeyboardEvent, MessageEvent: browser.MessageEvent, HTMLElement: browser.HTMLElement, Element: browser.Element,
    Node: browser.Node, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div'), sidebar = document.createElement('div');
  document.body.append(container, sidebar);
  const root = createRoot(container);
  const opened: string[] = [], saves: CanvasSaveRequest[] = [], remembered: string[] = [];
  const commands: { id: number; method: string; payload?: { path: string } }[] = [];
  const responses: { channel: string; type: string; id: number; payload?: unknown; error?: string }[] = [];
  let folder: string | null = 'designs', chosen = 0, saveId = 80000;
  let creation: { id: number; path: string } | null = null;
  const api: CanvasApi = {
    lastDocument: async () => 'designs/existing.fig',
    rememberDocument: async path => { if (path) remembered.push(path); },
    list: async () => ({ workspaceRoot: '/workspace', canvasRoot: folder, historyDirectory: '/history', truncated: false, files: [] }),
    chooseRoot: async () => { chosen++; return null; },
    newPath: async name => `designs/${name}.fig`,
    read: async path => ({ path, revision: 'existing-revision', data: new Uint8Array([1]) }),
    save: async request => {
      saves.push(request);
      if (request.path === 'designs/existing.fig') throw new Error('A file with this name already exists.');
      return { path: request.path, revision: 'new-revision' };
    },
    rename: async () => { throw new Error('Unexpected rename'); },
    history: async () => { throw new Error('Unexpected history'); },
    readVersion: async () => { throw new Error('Unexpected readVersion'); },
    checkpoint: async () => { throw new Error('Unexpected checkpoint'); },
    restore: async () => { throw new Error('Unexpected restore'); },
  };
  const Editor = load<typeof OriginalCanvasEditor>('features/canvas/integration/OriginalCanvasEditor.tsx', 'OriginalCanvasEditor', {
    react: React, 'react-dom': { createPortal },
    '../../../cheshiDesktop': { cheshiDesktop: { canvas: api, onWorkspaceFilesChanged: () => () => {} } },
    '../../../shared/ui': { Modal, NeumorphicButton, NeumorphicTextField },
    '../../../shared/ui/StatusToast': { StatusToast: () => null },
    '../../../shared/useHelpLanguage': { useHelpLanguage: () => ['en'] },
    './sdk/canvasNotifications': { canvasErrorNotification: (error: unknown) => ({ title: String(error) }) },
    '../CanvasSidebar': { CanvasSidebar }, '../CanvasEmptyState': { CanvasEmptyState: () => null },
    '../CanvasCloseDialog': { CanvasCloseDialog },
  }, { window, document, location, URL, Uint8Array, setTimeout, clearTimeout });
  const click = async (selector: string) => {
    await React.act(async () => {
      const button = document.querySelector<HTMLButtonElement>(selector);
      if (!button) throw new Error(`Missing ${selector}`);
      button.click();
    });
  };
  const begin = async () => {
    await click('[aria-label="Add canvas"]');
    await click('[role="menuitem"][aria-label="New canvas"]');
  };
  const name = async (value: string) => {
    await React.act(async () => {
      const input = document.querySelector<HTMLInputElement>('[aria-label="New Canvas file name"]')!;
      input.focus();
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: value.at(-1), bubbles: true }));
    });
  };
  try {
    // The Canvas sidebar can create a file while the main area shows Explorer.
    await React.act(async () => root.render(<Editor active={false} target={null} sidebarTarget={sidebar}
      onOpenFile={path => opened.push(path)} onDirtyChange={() => {}} />));
    const iframe = document.querySelector('iframe')!;
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: editorWindow });
    const emit = (message: object) => window.dispatchEvent(new MessageEvent('message', {
      origin: location.origin, source: iframe.contentWindow, data: { channel: 'cheshi:open-pencil:v1', ...message },
    }));
    Object.defineProperty(iframe.contentWindow, 'postMessage', { configurable: true, value: (message: {
      channel: string; type: string; id: number; method: string; payload?: { path: string }; error?: string;
    }) => {
      if (message.type === 'response') responses.push(message);
      if (message.type === 'command') {
        commands.push(message);
        if (message.method === 'create') {
          creation = { id: message.id, path: message.payload!.path };
          emit({ type: 'request', id: ++saveId, method: 'save', payload: { path: creation.path, data: new Uint8Array([1, 2]) } });
        } else emit({ type: 'result', id: message.id });
      } else if (message.type === 'response' && creation) {
        emit({ type: 'result', id: creation.id, error: message.error });
        creation = null;
      }
    } });
    await React.act(async () => { emit({ type: 'ready' }); });
    expect(commands.some(command => command.method === 'open')).toBe(true);
    await begin();
    expect(document.querySelector('dialog')).not.toBeNull();
    await click('dialog button[type="button"]:not([aria-label])');
    expect(commands.filter(command => command.method === 'create')).toHaveLength(0);
    expect(saves).toHaveLength(0);
    folder = null;
    await begin();
    expect(chosen).toBe(1);
    expect(document.querySelector('dialog')).toBeNull();
    folder = 'designs';
    await begin(); await name('existing');
    await click('dialog button[type="submit"]');
    expect(saves[0]?.expectedRevision).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('already exists');
    expect(opened).toEqual([]);
    await name('fresh');
    await click('dialog button[type="submit"]');
    expect(saves[1]?.path).toBe('designs/fresh.fig');
    expect(saves[1]?.expectedRevision).toBeNull();
    expect(opened).toEqual(['designs/fresh.fig']);
    expect(remembered).toContain('designs/fresh.fig');
    expect(document.querySelector('dialog')).toBeNull();

    const requestClose = async () => {
      const id = ++saveId;
      await React.act(async () => { emit({ type: 'request', id, method: 'confirm-close', payload: { documentName: 'fresh' } }); });
      const dialog = document.querySelector('dialog')!;
      expect(dialog.parentElement).toBe(document.body);
      expect(dialog.textContent).toContain('SAVE CHANGES');
      expect(dialog.textContent).toContain('Save changes to “fresh”?');
      expect(iframe.inert).toBe(true);
      return id;
    };
    const expectChoice = (id: number, choice: string) => {
      expect(responses.filter(response => response.id === id)).toEqual([{ channel: 'cheshi:open-pencil:v1', type: 'response', id, payload: choice }]);
      expect(document.querySelector('dialog')).toBeNull();
    };
    let id = await requestClose();
    await click('dialog [aria-label="Close dialog"]');
    expectChoice(id, 'cancel');
    id = await requestClose();
    // A native dialog sends cancel for Escape; use that same event path.
    await React.act(async () => { document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })); });
    expectChoice(id, 'cancel');
    id = await requestClose();
    await click('dialog button[type="button"]:not([aria-label]):nth-child(2)');
    expectChoice(id, 'cancel');
    id = await requestClose();
    await click('dialog button[type="button"]:not([aria-label]):first-child');
    expectChoice(id, 'discard');
    id = await requestClose();
    await click('dialog button[type="submit"]');
    expectChoice(id, 'save');
    // A duplicate request must not replace a pending confirmation.
    id = await requestClose();
    const duplicateId = ++saveId;
    await React.act(async () => { emit({ type: 'request', id: duplicateId, method: 'confirm-close', payload: { documentName: 'other' } }); });
    expect(responses.find(response => response.id === duplicateId)?.error).toContain('already open');
    expect(document.querySelector('dialog')!.textContent).toContain('“fresh”');
    await click('dialog [aria-label="Close dialog"]');
    expectChoice(id, 'cancel');
  } finally {
    await React.act(async () => root.unmount());
    await browser.happyDOM.abort();
    await editorWindow.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
