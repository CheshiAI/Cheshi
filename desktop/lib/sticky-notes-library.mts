import type { BrowserWindow, IpcMain } from 'electron';
import { STICKY_NOTES_LIBRARY_CHANNEL as channel, stickyNoteId, stickyNoteIds, stickyNoteQuery, stickyNoteRename,
  type StickyNotesLibraryApi } from '../shared/sticky-notes.ts';

type NotesWindow = Pick<BrowserWindow, 'isDestroyed' | 'isMinimized' | 'restore' | 'show' | 'focus'> & {
  webContents: Pick<BrowserWindow['webContents'], 'isDestroyed' | 'isLoadingMainFrame' | 'send' | 'mainFrame'>;
};

/** The workspace can manage the library, but cannot edit another window's draft. */
export function registerStickyNotesLibrary(options: {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  windows(): NotesWindow[];
  service: StickyNotesLibraryApi;
}) {
  options.ipc.handle(channel, (event, action: unknown, value: unknown) => {
    const window = options.windows().find(window => !window.isDestroyed() && window.webContents === event.sender);
    if (!window || event.senderFrame !== event.sender.mainFrame) throw new Error('Notes library requires a workspace window.');
    switch (action) {
      case 'list': return options.service.list(stickyNoteQuery(value));
      case 'rename': {
        const input = stickyNoteRename(value);
        return options.service.rename(input.id, input.title);
      }
      case 'create': return options.service.create();
      case 'open': return options.service.open(stickyNoteId(value));
      case 'delete-selected': return options.service.deleteSelected(stickyNoteIds(value));
      default: throw new Error('Unsupported notes library operation.');
    }
  });
  const unsubscribe = options.service.onChanged(() => {
    for (const window of options.windows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(`${channel}:changed`);
    }
  });
  return () => { unsubscribe(); options.ipc.removeHandler(channel); };
}

export function createStickyNotesMenuAction(options: {
  windows(): NotesWindow[];
  focused(): NotesWindow | null;
  openWorkspace(): Promise<void>;
}) {
  let opening: Promise<void> | null = null;
  const target = () => {
    const windows = options.windows().filter(window => !window.isDestroyed()
      && !window.webContents.isDestroyed() && !window.webContents.isLoadingMainFrame());
    const focused = options.focused();
    return focused && windows.includes(focused) ? focused : windows[0];
  };
  return () => {
    if (opening) return opening;
    opening = (async () => {
      let window = target();
      if (!window) { await options.openWorkspace(); window = target(); }
      if (!window) throw new Error('Open a workspace to view saved notes.');
      if (window.isMinimized()) window.restore();
      window.show(); window.focus(); window.webContents.send(`${channel}:open-list`);
    })().finally(() => { opening = null; });
    return opening;
  };
}
