import assert from 'node:assert/strict';
import test from 'node:test';
import type { MenuItem, MenuItemConstructorOptions } from 'electron';
import { aboutMenuTemplate } from '../lib/about-menu.mts';

function item(options: Partial<MenuItem>): MenuItem {
  return options as MenuItem;
}

test('replaces the native About role and retains other menu commands', () => {
  let opened = 0;
  const quit = item({ role: 'quit' });
  const edit = item({ role: 'editMenu' });
  const app = item({ label: 'Cheshi', submenu: { items: [item({ role: 'about' }), quit] } as Electron.Menu });
  const template = aboutMenuTemplate([app, edit], 'Cheshi', () => { opened += 1; }, entries => ({ items: entries }) as Electron.Menu);
  assert.equal(template[1], edit);
  const children = (template[0]?.submenu as Electron.Menu).items as unknown as MenuItemConstructorOptions[];
  assert.equal(children[1], quit);
  assert.equal(children[0]?.label, 'About Cheshi');
  assert.equal(children[0]?.role, undefined);
  (children[0]?.click as () => void)();
  assert.equal(opened, 1);
  assert.equal(app.submenu?.items[0]?.role, 'about');
});
