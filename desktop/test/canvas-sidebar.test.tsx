import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { CanvasHistoryPanel } from '../frontend/src/features/canvas/CanvasHistoryPanel';
import { CanvasSidebar } from '../frontend/src/features/canvas/CanvasSidebar';
import type { CanvasApi, CanvasRestoreRequest, CanvasVersion } from '../shared/canvas';
import { zipSync } from 'fflate';
import { canvasVersionPreview } from '../frontend/src/features/canvas/canvasVersionPreview';

test('placeholder thumbnails are not presented as a design preview', () => {
  const placeholder = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
  expect(canvasVersionPreview(zipSync({ 'thumbnail.png': placeholder }))).toBeNull();
  expect(canvasVersionPreview(new TextEncoder().encode('fig-kiwi'))).toBeNull();
  expect(canvasVersionPreview(zipSync({ 'metadata.json': new Uint8Array(0) }))).toBeNull();
});

test('Canvas sidebar opens workspace files and restores only a confirmed version with the current disk revision', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator,
    Event: window.Event, KeyboardEvent: window.KeyboardEvent, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement,
    MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const opened: string[] = [], restored: CanvasRestoreRequest[] = [], errors: unknown[] = [], previewed: string[] = [];
  let chosenCount = 0, savedCount = 0, createdCount = 0;
  const renamed: string[][] = [];
  const listing = { workspaceRoot: '/workspace', canvasRoot: 'designs', historyDirectory: '/data/history', truncated: false, files: [{ path: 'designs/screen.fig', size: 8, modifiedAt: 1 }] };
  const old: CanvasVersion = { id: 'old', revision: 'old-hash', createdAt: '2026-10-19T10:00:00.000Z', description: 'Before agent work', reason: 'checkpoint', size: 8 };
  const api: CanvasApi = {
    lastDocument: async () => null, rememberDocument: async () => {},
    chooseRoot: async () => { chosenCount++; return null; }, newPath: async name => `designs/${name}.fig`,
    rename: async request => ({ previousPath: request.path, path: 'designs/new.fig', revision: 'current-hash' }),
    list: async () => listing,
    history: async path => ({ path, currentRevision: 'current-hash', versions: [old] }),
    readVersion: async (path, id) => { previewed.push(id); return { path, revision: old.revision, data: new TextEncoder().encode('fig-kiwi') }; },
    read: async path => ({ path, revision: 'current-hash', data: new Uint8Array(8) }),
    save: async request => ({ path: request.path, revision: 'current-hash' }),
    checkpoint: async () => old,
    restore: async request => ({ path: request.path, revision: 'old-hash', data: new Uint8Array(8) }),
  };
  const props = { api, currentPath: 'designs/screen.fig', busy: false, ready: true, canSave: true, refresh: 0,
    onOpen: (path: string) => { opened.push(path); }, onSave: () => { savedCount++; },
    onCreate: () => { createdCount++; },
    onRename: async (path: string, name: string) => { renamed.push([path, name]); },
    onError: (error: unknown) => { errors.push(error); } };
  const historyProps = { api, path: props.currentPath, active: true, refresh: 0, disabled: false,
    onRestore: async (request: CanvasRestoreRequest) => { restored.push(request); }, onClose() {} };
  const button = (label: string) => {
    const element = [...document.querySelectorAll('button')].find(item => item.textContent?.startsWith(label));
    if (!element) throw new Error(`Missing button ${label}`);
    return element;
  };
  const click = async (label: string) => { await act(async () => button(label).click()); };
  try {
    await act(async () => root.render(<CanvasSidebar {...props} />));
    expect(container.textContent).not.toContain('/data/history');
    expect(container.textContent).not.toContain('Workspace file path');
    await act(async () => root.render(<CanvasSidebar {...props} canSave={false} />));
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Save canvas"]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-canvas-path]')!.disabled).toBe(false);
    await act(async () => root.render(<CanvasSidebar {...props} />));
    await click('screen.fig'); expect(opened).toEqual(['designs/screen.fig']);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Add canvas"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label="Choose canvas folder"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Add canvas"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label="New canvas"]')!.click());
    expect(createdCount).toBe(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Save canvas"]')!.click());
    expect([chosenCount, savedCount]).toEqual([1, 1]);
    expect(container.textContent).toContain('screen.fig');
    await act(async () => document.querySelector('[data-canvas-path]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Canvas file name');
    const input = document.querySelector<HTMLInputElement>('[aria-label="Canvas file name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'renamed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(renamed).toEqual([['designs/screen.fig', 'renamed']]);
    await act(async () => root.render(<CanvasHistoryPanel {...historyProps} />));
    await click('Before agent work'); expect(previewed).toEqual(['old']); expect(restored).toEqual([]);
    await act(async () => root.render(<CanvasHistoryPanel {...historyProps} disabled />));
    expect(button('Restore version').disabled).toBe(true);
    expect(container.textContent).toContain('Save open canvas changes');
    await act(async () => root.render(<CanvasHistoryPanel {...historyProps} />));
    await click('Restore version'); await click('Cancel'); expect(restored).toEqual([]);
    await click('Restore version');
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(item => item.textContent === 'Restore')!;
    await act(async () => confirm.click());
    expect(restored).toEqual([{ path: 'designs/screen.fig', versionId: 'old', expectedRevision: 'current-hash' }]);
    expect(errors).toEqual([]);
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
