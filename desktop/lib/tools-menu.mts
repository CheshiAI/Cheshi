import type { BrowserWindow, Menu, MenuItem, MenuItemConstructorOptions } from 'electron';
import { OPEN_RELATIONSHIP_GRAPH_CHANNEL } from '../shared/workspace-management.ts';

type ToolWindow = Pick<BrowserWindow, 'isDestroyed' | 'isMinimized' | 'restore' | 'show' | 'focus'> & {
  webContents: Pick<BrowserWindow['webContents'], 'isDestroyed' | 'isLoadingMainFrame' | 'send'> & {
    on(event: 'did-start-loading' | 'did-stop-loading', listener: () => void): unknown;
    off(event: 'did-start-loading' | 'did-stop-loading', listener: () => void): unknown;
  };
};

/** The supplied window list excludes workspace managers and auxiliary windows. */
export function createToolsMenu(items: Array<MenuItem | MenuItemConstructorOptions>, options: {
  focused(): ToolWindow | null;
  windows(): ToolWindow[];
  onWindowsChanged(listener: () => void): () => void;
  buildMenu: typeof Menu.buildFromTemplate;
}) {
  const available = (window: ToolWindow) => !window.isDestroyed()
    && !window.webContents.isDestroyed() && !window.webContents.isLoadingMainFrame();
  const target = () => {
    const windows = options.windows().filter(available);
    const focused = options.focused();
    return focused && windows.includes(focused) ? focused : windows[0];
  };
  const commands = [
    { id: 'cheshi-relationship-graph', label: 'Relationship Graph', channel: OPEN_RELATIONSHIP_GRAPH_CHANNEL },
  ];
  const submenu = options.buildMenu(commands.map(({ id, label, channel }) => ({
    id, label, enabled: Boolean(target()),
    click: () => {
      const window = target();
      if (!window) return;
      if (window.isMinimized()) window.restore();
      window.show(); window.focus(); window.webContents.send(channel);
    },
  })));
  let disposed = false;
  const refresh = () => {
    if (disposed) return;
    const enabled = Boolean(target());
    for (const { id } of commands) {
      const command = submenu.getMenuItemById(id);
      if (command) command.enabled = enabled;
    }
  };
  const watched = new Map<ToolWindow, ToolWindow['webContents']>();
  const unwatch = (window: ToolWindow) => {
    // BrowserWindow.webContents throws after the native window has been destroyed.
    // EventEmitter cleanup is still safe on the object captured when subscribing.
    const contents = watched.get(window);
    contents?.off('did-start-loading', refresh);
    contents?.off('did-stop-loading', refresh);
    watched.delete(window);
  };
  const sync = () => {
    if (disposed) return;
    const windows = options.windows().filter(window => !window.isDestroyed() && !window.webContents.isDestroyed());
    for (const window of watched.keys()) if (!windows.includes(window)) unwatch(window);
    for (const window of windows) {
      if (watched.has(window)) continue;
      const contents = window.webContents;
      watched.set(window, contents);
      contents.on('did-start-loading', refresh);
      contents.on('did-stop-loading', refresh);
    }
    refresh();
  };
  const unsubscribe = options.onWindowsChanged(sync);
  sync();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    for (const window of watched.keys()) unwatch(window);
  };
  const template = items.filter(item => item.id !== 'cheshi-tools');
  const helpIndex = template.findIndex(item => item.role === 'help');
  template.splice(helpIndex < 0 ? template.length : helpIndex, 0, { id: 'cheshi-tools', label: 'Tools', submenu });
  return { template, dispose };
}
