import { randomUUID } from 'node:crypto';
import type { BrowserWindow, BrowserWindowConstructorOptions, GlobalShortcut, IpcMain, IpcMainInvokeEvent, Screen } from 'electron';
import { STICKY_NOTES_CHANNEL as channel, STICKY_NOTES_SHORTCUT, STICKY_NOTES_LIST_SHORTCUT, stickyNoteId, stickyNoteIds,
  type StickyNoteBounds, type StickyNoteRequest } from '../shared/sticky-notes.ts';
import { StickyNotesStore } from './sticky-notes-store.mts';
import { createWindowAppearance, INITIAL_WINDOW_BACKGROUND_COLORS } from './window-appearance.mts';

interface Options {
  directory: string;
  rendererUrl: string;
  preload: string;
  appearanceFile: string;
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  shortcuts: Pick<GlobalShortcut, 'register' | 'unregister'>;
  screen: Pick<Screen, 'getCursorScreenPoint' | 'getDisplayNearestPoint' | 'getDisplayMatching'>;
  createAppearance?: typeof createWindowAppearance;
  onError(error: unknown): void;
}
interface Entry {
  id: string | null;
  window: BrowserWindow;
  ready: boolean;
  appearance: ReturnType<typeof createWindowAppearance>;
}
interface PendingFlush {
  entry: Entry;
  finish(error?: string): void;
}

export function visibleStickyNoteBounds(saved: StickyNoteBounds | null, area: StickyNoteBounds): StickyNoteBounds {
  const width = Math.min(saved?.width ?? 360, area.width);
  const height = Math.min(saved?.height ?? 420, area.height);
  return {
    width, height,
    x: Math.round(Math.max(area.x, Math.min(saved?.x ?? area.x + (area.width - width) / 2, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(saved?.y ?? area.y + (area.height - height) / 2, area.y + area.height - height))),
  };
}

export function createStickyNotesRuntime(options: Options) {
  const store = new StickyNotesStore(options.directory);
  const entries = new Map<string, Entry>();
  const opening = new Map<string, Promise<void>>();
  const pending = new Map<string, PendingFlush>();
  const deleting = new Set<string>();
  let disposed = false;
  let frozen = false;
  let shortcutAvailable = false;
  let listShortcutAvailable = false;

  const report = (error: unknown) => options.onError(error);
  function reveal(entry: Entry) {
    if (entry.window.isDestroyed()) return;
    if (entry.window.isMinimized()) entry.window.restore();
    entry.window.show();
    entry.window.moveTop();
    entry.window.focus();
  }
  function request(entry: Entry, value: StickyNoteRequest) {
    if (!entry.window.isDestroyed()) entry.window.webContents.send(`${channel}:request`, value);
  }
  async function remember(entry: Entry) {
    if (entry.id && !deleting.has(entry.id) && !entry.window.isDestroyed()) await store.move(entry.id, entry.window.getNormalBounds());
  }
  function changed() {
    for (const entry of entries.values()) if (!entry.window.isDestroyed()) entry.window.webContents.send(`${channel}:changed`);
  }

  async function open(id: string | null): Promise<void> {
    if (disposed || frozen) return;
    const key = id ?? 'list';
    const existing = entries.get(key);
    if (existing) { if (existing.ready) reveal(existing); return; }
    const inFlight = opening.get(key);
    if (inFlight) return inFlight;
    const flight = (async () => {
      const note = id ? await store.get(id) : null;
      if (disposed || frozen) return;
      const area = note?.bounds ? options.screen.getDisplayMatching(note.bounds).workArea
        : options.screen.getDisplayNearestPoint(options.screen.getCursorScreenPoint()).workArea;
      const window = options.createWindow({
        ...visibleStickyNoteBounds(note?.bounds ?? null, area), minWidth: 280, minHeight: 220,
        title: note?.title || 'Cheshi Notes', frame: false, show: false, transparent: true,
        backgroundColor: INITIAL_WINDOW_BACKGROUND_COLORS.dark, alwaysOnTop: note?.pinned ?? false,
        resizable: true, maximizable: false, fullscreenable: false,
        webPreferences: { preload: options.preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      const appearance = (options.createAppearance ?? createWindowAppearance)({ window, filename: options.appearanceFile,
        backgrounds: INITIAL_WINDOW_BACKGROUND_COLORS,
        onChanged: state => { if (!window.webContents.isDestroyed()) window.webContents.send(`${channel}:appearance`, state); } });
      const entry: Entry = { id, window, ready: false, appearance };
      entries.set(key, entry);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && (input.meta || input.control) && input.key.toLowerCase() === 'w') {
          event.preventDefault(); window.close();
        }
      });
      window.on('close', event => {
        if (disposed) return;
        event.preventDefault();
        if (frozen) return;
        if (entry.ready) request(entry, { kind: 'close' });
        else window.hide();
      });
      window.on('closed', () => {
        for (const [entryKey, value] of entries) if (value === entry) entries.delete(entryKey);
        for (const value of pending.values()) if (value.entry === entry) value.finish('The note window closed before saving.');
        appearance.dispose();
      });
      window.on('blur', () => { void remember(entry).catch(report); });
      window.webContents.on('render-process-gone', () => {
        report(new Error('A note window stopped responding. Saved notes are available from the Notes menu.'));
        window.destroy();
      });
      const url = new URL(options.rendererUrl);
      url.searchParams.set('stickyNotes', '1');
      try { await window.loadURL(url.href); appearance.ready('dark'); }
      catch (error) { window.destroy(); throw error; }
    })();
    opening.set(key, flight);
    try { await flight; } finally { opening.delete(key); }
  }

  async function create() {
    if (disposed || frozen) return;
    const note = await store.create();
    await open(note.id);
  }
  function owner(event: IpcMainInvokeEvent): Entry {
    const entry = [...entries.values()].find(value => value.window.webContents === event.sender);
    if (!entry || disposed || event.senderFrame !== event.sender.mainFrame) throw new Error('Notes are only accessible from their own window.');
    return entry;
  }
  function noteId(entry: Entry): string {
    if (!entry.id) throw new Error('Open a note first.');
    return entry.id;
  }
  options.ipc.handle(channel, async (event, action: unknown, value: unknown) => {
    const entry = owner(event);
    switch (action) {
      case 'read': {
        const note = entry.id ? await store.get(entry.id) : null;
        entry.ready = true;
        reveal(entry);
        return { note, shortcutAvailable, listShortcutAvailable };
      }
      case 'appearance': return entry.appearance.getState();
      case 'save':
        if (deleting.has(noteId(entry))) throw new Error('This note is being deleted.');
        await store.save(noteId(entry), value);
        changed();
        return;
      case 'list': return store.list();
      case 'create': return create();
      case 'open': return open(stickyNoteId(value));
      case 'pin':
        await store.pin(noteId(entry), value);
        entry.window.setAlwaysOnTop(value === true);
        return;
      case 'close':
        if (frozen) return;
        await remember(entry);
        entry.window.hide();
        return;
      case 'delete':
        if (frozen) throw new Error('Notes are preparing to close.');
        await store.delete(noteId(entry));
        entry.window.destroy();
        changed();
        return;
      case 'delete-selected': {
        if (frozen) throw new Error('Notes are preparing to close.');
        const ids = stickyNoteIds(value);
        if (ids.some(id => deleting.has(id))) throw new Error('A selected note is already being deleted.');
        for (const id of ids) deleting.add(id);
        try {
          const result = await store.deleteSelected(ids);
          for (const id of result.deletedIds) {
            const opened = entries.get(id);
            if (!opened) continue;
            if (opened === entry) {
              entries.delete(id);
              opened.id = null;
              entries.set(`list:${opened.window.id}`, opened);
            } else opened.window.destroy();
          }
          changed();
          return result;
        } finally { for (const id of ids) deleting.delete(id); }
      }
      case 'acknowledge': {
        const reply = value as { token?: unknown; error?: unknown } | null;
        if (!reply || typeof reply.token !== 'string'
          || (reply.error !== undefined && typeof reply.error !== 'string')) throw new TypeError('Invalid save acknowledgement.');
        const wait = pending.get(reply.token);
        if (wait?.entry !== entry) throw new Error('Unknown note save request.');
        wait.finish(reply.error as string | undefined);
        return;
      }
      default: throw new Error('Unknown notes action.');
    }
  });

  return {
    create, openList: () => open(null),
    start() {
      try { shortcutAvailable = options.shortcuts.register(STICKY_NOTES_SHORTCUT, () => { void create().catch(report); }); }
      catch (error) { report(error); }
      if (!shortcutAvailable) report(new Error('The Notes shortcut is unavailable. Use Notes → New Note in the application menu.'));
      try { listShortcutAvailable = options.shortcuts.register(STICKY_NOTES_LIST_SHORTCUT, () => { void open(null).catch(report); }); }
      catch (error) { report(error); }
      if (!listShortcutAvailable) report(new Error('The Notes list shortcut is unavailable. Use Notes → All Notes in the application menu.'));
    },
    async prepareToQuit() {
      frozen = true;
      const results = await Promise.allSettled([...entries.values()].map(async entry => {
        if (entry.ready) await new Promise<void>((resolve, reject) => {
          const token = randomUUID();
          const timer = setTimeout(() => finish('A note did not finish saving. Try again.'), 10_000);
          function finish(error?: string) {
            clearTimeout(timer); pending.delete(token);
            if (error) reject(new Error(error)); else resolve();
          }
          pending.set(token, { entry, finish });
          request(entry, { kind: 'flush', token });
        });
        await remember(entry);
      }));
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      await store.flush();
    },
    resume() {
      frozen = false;
      for (const entry of entries.values()) request(entry, { kind: 'resume' });
    },
    dispose() {
      disposed = true;
      if (shortcutAvailable) options.shortcuts.unregister(STICKY_NOTES_SHORTCUT);
      if (listShortcutAvailable) options.shortcuts.unregister(STICKY_NOTES_LIST_SHORTCUT);
      options.ipc.removeHandler(channel);
      for (const entry of entries.values()) entry.window.destroy();
    },
  };
}
