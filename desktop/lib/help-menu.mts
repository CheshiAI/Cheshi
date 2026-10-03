import type { BrowserWindow, Menu, MenuItem, MenuItemConstructorOptions } from 'electron';
import { OPEN_HELP_CHANNEL } from '../shared/workspace-management.ts';

export function helpMenuTemplate(items: Array<MenuItem | MenuItemConstructorOptions>, open: () => void, buildMenu: typeof Menu.buildFromTemplate): Array<MenuItem | MenuItemConstructorOptions> {
  const command: MenuItemConstructorOptions = { id: 'cheshi-help', label: 'Cheshi Help', click: open };
  const index = items.findIndex(item => item.role === 'help');
  if (index < 0) return [...items, { role: 'help', submenu: [command] }];
  return items.map((item, position) => {
    if (position !== index) return item;
    const children = Array.isArray(item.submenu) ? item.submenu : item.submenu?.items ?? [];
    return { label: item.label, role: 'help', submenu: buildMenu([command, ...children.filter(child => child.id !== command.id)]) };
  });
}

type HelpWindow = Pick<BrowserWindow, 'isDestroyed' | 'show' | 'focus'> & {
  webContents: Pick<BrowserWindow['webContents'], 'isDestroyed' | 'isLoadingMainFrame' | 'send'>;
};

/** Send only to a workspace renderer, never auxiliary notes, auth or About windows. */
export function createHelpMenuAction(options: {
  focused(): HelpWindow | null; windows(): HelpWindow[]; openManager(): Promise<void>;
}) {
  let opening: Promise<void> | null = null;
  const available = (window: HelpWindow | null): window is HelpWindow => {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isLoadingMainFrame()) return false;
    return true;
  };
  const target = () => {
    const windows = options.windows();
    const focused = options.focused();
    return focused && windows.includes(focused) && available(focused) ? focused : windows.find(available);
  };
  return () => {
    if (opening) return opening;
    opening = (async () => {
      let window = target();
      if (!window) { await options.openManager(); window = target(); }
      if (!window) throw new Error('The help window is unavailable.');
      window.show(); window.focus(); window.webContents.send(OPEN_HELP_CHANNEL);
    })().finally(() => { opening = null; });
    return opening;
  };
}
