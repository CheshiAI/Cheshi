import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import * as React from 'react';
import { createPortal } from 'react-dom';
import type { OriginalCanvasEditor } from '../frontend/src/features/canvas/integration/OriginalCanvasEditor';
import type { CanvasApi, CanvasFileRelocation, CanvasSaveRequest } from '../shared/canvas';
import { CanvasSidebar } from '../frontend/src/features/canvas/CanvasSidebar';
import { useCanvasDock } from '../frontend/src/features/canvas/integration/useCanvasDock';
import { isCanvasOverlayList } from '../shared/canvas-layout';
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
  const commands: { id: number; method: string; payload?: { path: string; previousPath?: string } }[] = [];
  const responses: { channel: string; type: string; id: number; payload?: unknown; error?: string }[] = [];
  let folder: string | null = 'designs', chosen = 0, saveId = 80000;
  let diskRevision = 'existing-revision', refreshError: string | undefined, readError: string | undefined;
  let reads = 0;
  let relocations: CanvasFileRelocation[] = [], openedDocumentPath = 'designs/existing.fig';
  let renameError: string | undefined, draft = false;
  let filesChanged: ((event: { overflow: boolean; paths: string[] }) => void) | undefined;
  const readPaths: string[] = [];
  const notifications: string[] = [];
  let creation: { id: number; path: string } | null = null;
  const api: CanvasApi = {
    lastDocument: async () => 'designs/existing.fig',
    rememberDocument: async path => { if (path) remembered.push(path); },
    list: async () => ({ workspaceRoot: '/workspace', canvasRoot: folder, historyDirectory: '/history', truncated: false, files: [], relocations }),
    chooseRoot: async () => { chosen++; return null; },
    newPath: async name => `designs/${name}.fig`,
    read: async path => {
      reads++;
      readPaths.push(path);
      if (readError) throw new Error(readError);
      return { path, revision: diskRevision, data: new Uint8Array([1]) };
    },
    save: async request => {
      saves.push(request);
      if (request.path === 'designs/existing.fig' || request.path === openedDocumentPath) throw new Error('A file with this name already exists.');
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
    '../../../cheshiDesktop': { cheshiDesktop: { canvas: api, onWorkspaceFilesChanged: (listener: typeof filesChanged) => {
      filesChanged = listener; return () => { filesChanged = undefined; };
    } } },
    '../../../shared/ui': { Modal, NeumorphicButton, NeumorphicTextField },
    '../../../shared/ui/StatusToast': { StatusToast: () => null },
    '../../../shared/useHelpLanguage': { useHelpLanguage: () => ['en'] },
    './sdk/canvasNotifications': { canvasErrorNotification: (error: unknown) => {
      notifications.push(String(error)); return { title: String(error) };
    } },
    '../CanvasSidebar': { CanvasSidebar }, '../CanvasEmptyState': { CanvasEmptyState: () => null },
    '../CanvasCloseDialog': { CanvasCloseDialog },
    './useCanvasDock': { useCanvasDock },
    '../../../../../shared/canvas-layout': { isCanvasOverlayList },
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
      channel: string; type: string; id: number; method: string; payload?: { path: string; previousPath?: string }; error?: string;
    }) => {
      if (message.type === 'response') responses.push(message);
      if (message.type === 'command') {
        commands.push(message);
        if (message.method === 'create') {
          creation = { id: message.id, path: message.payload!.path };
          emit({ type: 'request', id: ++saveId, method: 'save', payload: { path: creation.path, data: new Uint8Array([1, 2]) } });
        } else {
          if (message.method === 'renamed' && !renameError) {
            openedDocumentPath = message.payload!.path;
            emit({ type: 'state', payload: { hasDocument: true, path: openedDocumentPath,
              name: openedDocumentPath, paths: [openedDocumentPath], dirty: draft } });
          }
          emit({ type: 'result', id: message.id,
            error: message.method === 'refresh' ? refreshError : message.method === 'renamed' ? renameError : undefined });
        }
      } else if (message.type === 'response' && creation) {
        emit({ type: 'result', id: creation.id, error: message.error });
        creation = null;
      }
    } });
    await React.act(async () => { emit({ type: 'ready' }); });
    expect(commands.some(command => command.method === 'open')).toBe(true);
    const renderActive = async (active: boolean) => {
      await React.act(async () => root.render(<Editor active={active} target={null} sidebarTarget={sidebar}
        onOpenFile={path => opened.push(path)} onDirtyChange={() => {}} />));
    };
    const documentState = async (hasDocument: boolean) => {
      await React.act(async () => { emit({ type: 'state', payload: {
        hasDocument, path: hasDocument ? 'designs/existing.fig' : '', name: 'existing', dirty: false,
      } }); });
    };
    await renderActive(true);
    await documentState(false);
    expect(sidebar.querySelector('[data-canvas-layers]') === null).toBe(true);
    expect(sidebar.querySelector<HTMLElement>('[role="separator"]')?.hidden).toBe(true);
    expect(sidebar.textContent).not.toContain('Open a canvas to view');
    await documentState(true);
    expect(sidebar.querySelector('[data-canvas-layers]')).not.toBeNull();
    expect(sidebar.querySelector<HTMLElement>('[role="separator"]')?.hidden).toBe(false);
    expect(sidebar.querySelector('[role="separator"]')?.getAttribute('aria-valuenow')).toBe('50');
    const refreshes = () => commands.filter(command => command.method === 'refresh');
    const refreshCanvas = () => click('[aria-label="Refresh canvases"]');
    const initialReads = reads;
    await refreshCanvas();
    expect(reads).toBe(initialReads + 1);
    expect(refreshes()).toHaveLength(0); // Unchanged files keep the existing editor.
    diskRevision = 'external-edit';
    await refreshCanvas();
    expect(refreshes()).toHaveLength(1);
    expect(refreshes()[0]?.payload?.path).toBe('designs/existing.fig');
    await refreshCanvas();
    expect(refreshes()).toHaveLength(1);
    diskRevision = 'another-external-edit';
    refreshError = 'Save or discard changes in this canvas before refreshing. Your edits have been kept.';
    await refreshCanvas();
    expect(notifications.at(-1)).toContain('Your edits have been kept');
    const requestSave = async () => {
      await React.act(async () => { emit({ type: 'request', id: ++saveId, method: 'save',
        payload: { path: openedDocumentPath, data: new Uint8Array([1]) } }); });
    };
    await requestSave();
    expect(saves.at(-1)?.expectedRevision).toBe('external-edit'); // A refused refresh cannot advance the save revision.
    refreshError = undefined;
    await refreshCanvas();
    expect(refreshes()).toHaveLength(3);
    await requestSave();
    expect(saves.at(-1)?.expectedRevision).toBe('another-external-edit');
    readError = 'File not found';
    await refreshCanvas();
    expect(notifications.at(-1)).toContain('File not found');
    expect(refreshes()).toHaveLength(3);
    readError = undefined;
    // Manual refresh reconciles paths before reading, even when React still has the old path.
    relocations = [{ previousPath: openedDocumentPath, path: 'designs/료혼진심관.fig' }];
    diskRevision = 'renamed-disk-revision';
    await refreshCanvas();
    expect(readPaths.at(-1)).toBe('designs/료혼진심관.fig');
    expect(commands.findLast(command => command.method === 'renamed')?.payload?.previousPath).toBe('designs/existing.fig');
    expect(remembered.at(-1)).toBe('designs/료혼진심관.fig');
    await requestSave();
    expect(saves.at(-1)?.expectedRevision).toBe('renamed-disk-revision');

    // Watcher-driven listing retargets an unsaved tab without importing over its draft.
    const refreshCount = refreshes().length, readsBeforeMove = reads;
    draft = true;
    relocations = [{ previousPath: openedDocumentPath, path: 'designs/moved-again.fig' }];
    await React.act(async () => { filesChanged?.({ overflow: false, paths: ['designs/moved-again.fig'] }); });
    expect(openedDocumentPath).toBe('designs/moved-again.fig');
    expect(reads).toBe(readsBeforeMove);
    expect(refreshes()).toHaveLength(refreshCount);
    diskRevision = 'newer-external-revision';
    refreshError = 'Your edits have been kept';
    await refreshCanvas();
    expect(notifications.at(-1)).toContain('Your edits have been kept');
    await requestSave();
    expect(saves.at(-1)?.expectedRevision).toBe('renamed-disk-revision');

    // A failed automatic retarget is not retried forever; manual refresh can retry it.
    relocations = [{ previousPath: openedDocumentPath, path: 'designs/final.fig' }];
    renameError = 'Rename bridge failed';
    await React.act(async () => { filesChanged?.({ overflow: false, paths: ['designs/final.fig'] }); });
    const renameCount = commands.filter(command => command.method === 'renamed').length;
    await React.act(async () => { filesChanged?.({ overflow: false, paths: ['designs/final.fig'] }); });
    expect(commands.filter(command => command.method === 'renamed')).toHaveLength(renameCount);
    expect(openedDocumentPath).toBe('designs/moved-again.fig');
    renameError = undefined; refreshError = undefined; draft = false;
    await refreshCanvas();
    expect(readPaths.at(-1)).toBe('designs/final.fig');
    expect(openedDocumentPath).toBe('designs/final.fig');
    relocations = [];
    saves.length = 0;
    await documentState(false);
    const readsBeforeEmpty = reads;
    await refreshCanvas();
    expect(reads).toBe(readsBeforeEmpty);
    expect(sidebar.querySelector('[data-canvas-layers]') === null).toBe(true);
    expect(sidebar.querySelector<HTMLElement>('[role="separator"]')?.hidden).toBe(true);
    await renderActive(false);
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
