import type { Menu, MenuItem, MenuItemConstructorOptions } from 'electron';

/** Keep existing native menu actions, replacing only the About command. */
export function aboutMenuTemplate(items: readonly MenuItem[], name: string, open: () => void, buildMenu: typeof Menu.buildFromTemplate): Array<MenuItem | MenuItemConstructorOptions> {
  return items.map(item => {
    if (item.role === 'about') return { label: `About ${name}`, click: open };
    if (!item.submenu) return item;
    return {
      label: item.label,
      role: item.role,
      type: item.type,
      id: item.id,
      enabled: item.enabled,
      visible: item.visible,
      submenu: buildMenu(aboutMenuTemplate(item.submenu.items, name, open, buildMenu)),
    };
  });
}
