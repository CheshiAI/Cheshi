import { reactive, watch } from 'vue';
import { activeTab, allTabs, createTab, createDocumentInCurrentTab, getActiveStore, openFileInNewTab, getTabsSnapshot, closeTab, switchTab } from '@/app/tabs';
import { isCanvasEditorLayout, type CanvasEditorLayout } from '../../../shared/canvas-layout';
import { connectCanvasOverlays } from './canvasOverlays';

const channel = 'cheshi:open-pencil:v1';
let nextId = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> | undefined }>();
const origin = window.location.origin === 'null' ? '*' : window.location.origin;
function post(message: object) { window.parent.postMessage({ channel, ...message }, origin); }
export const hostStatus = reactive({ busy: false, dirty: false, revision: 0 });
export const hostLayout = reactive<{ value: CanvasEditorLayout | null }>({ value: null });

function retargetDocumentSource(store: ReturnType<typeof getActiveStore>, path: string) {
  // The pinned-source adapter exposes rename without marking drafts saved.
  if (!('retargetDocumentSource' in store) || typeof store.retargetDocumentSource !== 'function') {
    throw new Error('Canvas rename integration is unavailable.');
  }
  store.retargetDocumentSource(path);
}

async function refreshDocument(path: string, data: Uint8Array) {
  const previous = getTabsSnapshot().find(tab => tab.store.getDocumentFilePath() === path);
  if (!previous) throw new Error('Select an open canvas before refreshing.');
  previous.store.commitTextEdit();
  if (previous.store.hasUnsavedChanges()) throw new Error('Save or discard changes in this canvas before refreshing. Your edits have been kept.');
  const { currentPageId, zoom, panX, panY } = previous.store.state;
  const activeId = activeTab.value?.id;
  // Reserve a separate tab even for an empty document. Import failures must not
  // replace the old graph, and other tabs may contain unsaved work.
  const candidate = createTab();
  try {
    const filename = path.split('/').at(-1) ?? 'design.fig';
    const store = await openFileInNewTab(new File([new Uint8Array(data)], filename));
    if (store.graph.getPages().some(page => page.id === currentPageId)) {
      await store.switchPage(currentPageId);
      Object.assign(store.state, { zoom, panX, panY });
      store.requestRender();
    }
    store.setDocumentSource(filename, 'fig', undefined, path);
    await closeTab(previous.id);
  } catch (error) {
    await closeTab(candidate.id, 'discard');
    switchTab(previous.id);
    throw error;
  } finally {
    if (activeId && activeId !== previous.id) switchTab(activeId);
  }
}

export function requestHost<T>(method: string, payload: unknown, timeoutMs: number | null = 120_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = timeoutMs === null ? undefined
      : setTimeout(() => { pending.delete(id); reject(new Error('Cheshi Canvas request timed out.')); }, timeoutMs);
    pending.set(id, { resolve: value => resolve(value as T), reject, timer });
    post({ type: 'request', id, method, payload });
  });
}

export function connectHost(): () => void {
  const disconnectOverlays = connectCanvasOverlays(post);
  const stop = watch([
    () => activeTab.value?.id ?? '',
    () => allTabs.value.some(tab => tab.isDirty),
    () => activeTab.value?.store.getDocumentFilePath() ?? '',
    () => activeTab.value?.store.state.documentName ?? 'New design',
    () => getTabsSnapshot().map(tab => tab.store.getDocumentFilePath() ?? '').join('\n'),
    () => activeTab.value?.kind === 'document',
  ], ([id, dirty, path, name, , hasDocument]) => {
    hostStatus.dirty = dirty as boolean;
    post({ type: 'state', payload: { id, dirty, path, name, hasDocument, paths: getTabsSnapshot().map(tab => tab.store.getDocumentFilePath()) } });
  }, { immediate: true });
  async function receive(event: MessageEvent) {
    const sameOrigin = location.protocol === 'file:'
      ? event.origin === 'null' || event.origin === 'file://'
      : event.origin === location.origin;
    if (event.source !== window.parent || !sameOrigin || event.data?.channel !== channel) return;
    const message = event.data;
    if (message.type === 'layout') {
      if (isCanvasEditorLayout(message.payload)) hostLayout.value = message.payload;
      return;
    }
    if (message.type === 'host-state') {
      hostStatus.busy = message.payload?.busy === true;
      if (Number.isSafeInteger(message.payload?.revision)) hostStatus.revision = message.payload.revision;
      return;
    }
    if (message.type === 'response') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (typeof message.error === 'string') entry.reject(new Error(message.error));
      else entry.resolve(message.payload);
      return;
    }
    if (message.type !== 'command' || !Number.isSafeInteger(message.id)) return;
    try {
      if (message.method === 'open') {
        const { path, data } = message.payload;
        if (typeof path !== 'string' || !(data instanceof Uint8Array)) throw new Error('Invalid document.');
        const initial = activeTab.value;
        const placeholder = initial && !initial.store.getDocumentFilePath() && !initial.store.hasUnsavedChanges()
          && initial.store.graph.getPages().every(page => page.childIds.length === 0);
        const opened = await openFileInNewTab(new File([new Uint8Array(data)], path.split('/').at(-1) ?? 'design.fig'), undefined, path);
        if (placeholder && initial.store !== opened && !initial.store.hasUnsavedChanges()) await closeTab(initial.id);
      } else if (message.method === 'refresh') {
        const { path, data } = message.payload ?? {};
        if (typeof path !== 'string' || !(data instanceof Uint8Array)) throw new Error('Invalid document.');
        await refreshDocument(path, data);
      } else if (message.method === 'assert-clean' || message.method === 'reload') {
        for (const tab of getTabsSnapshot()) tab.store.commitTextEdit();
        if (allTabs.value.some(tab => tab.isDirty)) throw new Error('Save open canvas changes before restoring.');
        if (message.method === 'reload') {
          const { path, data } = message.payload;
          if (typeof path !== 'string' || !(data instanceof Uint8Array)) throw new Error('Invalid document.');
          const previous = getTabsSnapshot().find(tab => tab.store.getDocumentFilePath() === path);
          const filename = path.split('/').at(-1) ?? 'design.fig';
          // Parse into a separate document first; a failed import keeps the old tab intact.
          const store = await openFileInNewTab(new File([new Uint8Array(data)], filename));
          store.setDocumentSource(filename, 'fig', undefined, path);
          if (previous && previous.store !== store) await closeTab(previous.id);
        }
      } else if (message.method === 'renamed') {
        const { previousPath, path } = message.payload ?? {};
        if (typeof previousPath !== 'string' || typeof path !== 'string') throw new Error('Invalid rename result.');
        for (const tab of getTabsSnapshot()) if (tab.store.getDocumentFilePath() === previousPath) {
          tab.store.commitTextEdit();
          retargetDocumentSource(tab.store, path);
        }
      } else if (message.method === 'save') {
        if (activeTab.value?.kind !== 'document') throw new Error('Select or create a canvas before saving.');
        const store = getActiveStore();
        store.commitTextEdit();
        const path = message.payload?.path;
        if (typeof path === 'string' && path.trim() && path !== store.getDocumentFilePath()) await store.saveFigFileToPath(path.trim());
        else await store.saveFigFile();
      } else if (message.method === 'new') {
        createDocumentInCurrentTab();
      } else if (message.method === 'create') {
        const path = message.payload?.path;
        if (typeof path !== 'string' || !path.trim()) throw new Error('Invalid canvas file path.');
        const previous = activeTab.value;
        previous?.store.commitTextEdit();
        const created = createDocumentInCurrentTab();
        try { await created.store.saveFigFileToPath(path); }
        catch (error) {
          await closeTab(created.id);
          if (previous && getTabsSnapshot().some(tab => tab.id === previous.id)) switchTab(previous.id);
          throw error;
        }
      } else if (message.method === 'deactivate') {
        for (const tab of getTabsSnapshot()) tab.store.commitTextEdit();
      } else throw new Error('Unknown Canvas command.');
      post({ type: 'result', id: message.id });
    } catch (error) {
      post({ type: 'result', id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  window.addEventListener('message', receive);
  post({ type: 'ready' });
  return () => {
    disconnectOverlays();
    stop(); window.removeEventListener('message', receive);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Canvas closed.')); }
    pending.clear();
  };
}
