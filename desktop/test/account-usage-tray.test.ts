import { EventEmitter } from 'node:events';
import type { Menu, MenuItemConstructorOptions, NativeImage } from 'electron';
import { expect, test } from 'bun:test';
import { createAccountUsageTray } from '../lib/account-usage-tray.mts';
import { renderAccountUsageTrayIcon } from '../lib/account-usage-tray-icon.mts';
import type { CodexAccountsSnapshot } from '../shared/codex-accounts';
import type { MenuBarFont } from '../lib/menu-bar-font.mts';

type Options = Parameters<typeof createAccountUsageTray>[0];
type Source = ReturnType<ReturnType<typeof createAccountUsageTray>['register']>;
type UsageWindow = Parameters<Source['attach']>[0];

class FakeWindow extends EventEmitter {
  destroyed = false;
  focused = false;
  minimized = false;
  calls: string[] = [];
  isDestroyed() { return this.destroyed; }
  isFocused() { return this.focused; }
  isMinimized() { return this.minimized; }
  restore() { this.calls.push('restore'); this.minimized = false; }
  show() { this.calls.push('show'); }
  focus() { this.calls.push('focus'); this.focused = true; this.emit('focus'); }
  attach(source: Source) { source.attach(this as unknown as UsageWindow); }
}

interface ImageState { template: boolean; representations: Array<{ scaleFactor?: number; buffer?: Buffer }> }

function harness(loadFont?: Options['loadFont']) {
  const imageStates = new Map<NativeImage, ImageState>();
  const theme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
  let creations = 0;
  let destroyed = 0;
  let openCalls = 0;
  let quitCalls = 0;
  let tooltip = '';
  let menu: MenuItemConstructorOptions[] = [];
  let currentImage: NativeImage;
  const updates: NativeImage[] = [];
  const errors: unknown[] = [];
  let menuFailure: Error | null = null;
  const tray = createAccountUsageTray({
    loadFont,
    createTray(image) {
      creations++;
      currentImage = image;
      return {
        setImage(next) {
          if (typeof next === 'string') throw new Error('Expected an in-memory tray image');
          currentImage = next; updates.push(next);
        },
        setToolTip(value) { tooltip = value; },
        setContextMenu() {},
        destroy() { destroyed++; },
      };
    },
    createMenu(template) { if (menuFailure) throw menuFailure; menu = template; return {} as Menu; },
    images: { createEmpty() {
      const state: ImageState = { template: false, representations: [] };
      const image = {
        addRepresentation(representation: ImageState['representations'][number]) { state.representations.push(representation); },
        setTemplateImage(value: boolean) { state.template = value; },
      } as unknown as NativeImage;
      imageStates.set(image, state);
      return image;
    } },
    theme: theme as unknown as Options['theme'],
    openApp() { openCalls++; },
    quit() { quitCalls++; },
    onError(error) { errors.push(error); },
  });
  return {
    tray, theme, updates, errors,
    failMenu(error: Error) { menuFailure = error; },
    get creations() { return creations; }, get destroyed() { return destroyed; },
    get tooltip() { return tooltip; }, get menu() { return menu; },
    get image() { return imageStates.get(currentImage!)!; },
    get openCalls() { return openCalls; }, get quitCalls() { return quitCalls; },
    click(label: string) {
      const action = menu.find(item => item.label === label)?.click;
      if (!action) throw new Error(`Missing menu action: ${label}`);
      Reflect.apply(action, undefined, []);
    },
  };
}

function snapshot(remaining = [92, 100], activeId = 'a'): CodexAccountsSnapshot {
  return { activeId, profiles: remaining.map((value, index) => ({
    id: String.fromCharCode(97 + index), label: `Account ${index}`, email: `${String.fromCharCode(97 + index)}@example.com`,
    login: { state: 'signed_in', error: null },
    usage: { state: 'ready', authenticated: true, plan: 'pro', error: null,
      rateLimits: [{ limitId: 'codex', limitName: null, plan: 'pro', primary: null,
        secondary: { usedPercent: 100 - value, windowDurationMins: 10_080, resetsAt: null } }] },
  })) };
}

test('uses active account usage for both the ring and its number while the tooltip retains totals', () => {
  const app = harness();
  const source = app.tray.register();
  source.update(snapshot());
  expect(app.creations).toBe(1);
  expect(app.tooltip).toContain('192% remaining · 200% total capacity · 2 accounts');
  expect(app.tooltip).toContain('a@example.com');
  expect(app.image.template).toBe(true);
  expect(app.image.representations.map(item => item.scaleFactor)).toEqual([1, 2]);
  expect(app.image.representations[1]?.buffer?.equals(renderAccountUsageTrayIcon(92))).toBe(true);
  expect(app.menu.filter(item => item.type === 'checkbox').map(item => [item.checked, item.enabled])).toEqual([[true, false], [false, false]]);
  app.tray.dispose();
});

test('tracks the focused workspace account without creating another tray or selecting an account', () => {
  const app = harness();
  const first = app.tray.register();
  const second = app.tray.register();
  const firstWindow = new FakeWindow();
  const secondWindow = new FakeWindow();
  firstWindow.focused = true;
  firstWindow.attach(first);
  first.update(snapshot());
  secondWindow.attach(second);
  second.update(snapshot([92, 100], 'b'));
  expect(app.tooltip).toContain('a@example.com');
  secondWindow.focus();
  expect(app.tooltip).toContain('b@example.com');
  expect(app.creations).toBe(1);
  expect(app.menu.filter(item => item.type === 'checkbox').map(item => item.checked)).toEqual([false, true]);
  secondWindow.emit('closed');
  expect(app.tooltip).toContain('a@example.com');
  const previous = app.tooltip;
  second.update(snapshot([0], 'b'));
  expect(app.tooltip).toBe(previous);
  expect(secondWindow.listenerCount('focus')).toBe(0);
  expect(secondWindow.listenerCount('closed')).toBe(0);
  app.tray.dispose();
});

test('incomplete inactive usage preserves the active indicator while the summed tooltip stays unavailable', () => {
  const app = harness();
  const source = app.tray.register();
  const partial = snapshot();
  partial.profiles[1]!.usage.rateLimits = [];
  source.update(partial);
  expect(app.tooltip).toContain('Usage unavailable');
  expect(app.tooltip).not.toContain('192%');
  expect(app.tooltip).toContain('Ring: 92% remaining');
  expect(app.image.representations[1]?.buffer?.equals(renderAccountUsageTrayIcon(92))).toBe(true);
  app.tray.dispose();
});

test('closing the last window retains its active account and background updates keep the ring live', () => {
  const app = harness();
  const source = app.tray.register();
  const window = new FakeWindow();
  window.attach(source);
  source.update(snapshot([100, 90], 'b'));
  const previous = app.image.representations[1]?.buffer;
  window.destroyed = true;
  window.emit('closed');
  source.dispose();
  expect(app.image.representations[1]?.buffer).toEqual(previous);
  expect(app.tooltip).toContain('b@example.com · Ring: 90% remaining');
  app.click('Show Cheshi');
  expect(app.openCalls).toBe(1);

  app.tray.updateBackground(snapshot([100, 29], 'a'));
  expect(app.tooltip).toContain('129% remaining');
  expect(app.tooltip).toContain('b@example.com · Ring: 29% remaining');
  expect(app.image.template).toBe(true);
  expect(app.image.representations[1]?.buffer?.equals(renderAccountUsageTrayIcon(29))).toBe(true);
  source.update(snapshot([0, 0], 'a'));
  expect(app.tooltip).toContain('b@example.com · Ring: 29% remaining');

  const reopened = app.tray.register();
  new FakeWindow().attach(reopened);
  expect(app.tooltip).toContain('b@example.com · Ring: 29% remaining');
  reopened.update(snapshot([100, 29], 'a'));
  expect(app.tooltip).toContain('a@example.com · Ring: 100% remaining');
  app.tray.dispose();
  const count = app.updates.length;
  app.tray.updateBackground(snapshot([0]));
  expect(app.updates.length).toBe(count);
});

test('background logout clears retained usage rather than displaying a stale number', () => {
  const app = harness();
  const source = app.tray.register();
  source.update(snapshot());
  source.dispose();
  const signedOut = snapshot();
  signedOut.profiles[0]!.login.state = 'signed_out';
  signedOut.profiles[0]!.usage.authenticated = false;
  app.tray.updateBackground(signedOut);
  expect(app.tooltip).toContain('Ring: Unavailable');
  expect(app.image.representations[1]?.buffer?.equals(renderAccountUsageTrayIcon(null))).toBe(true);
  app.tray.dispose();
});

test('low usage retains macOS template coloring across theme changes', () => {
  const app = harness();
  const source = app.tray.register();
  source.update(snapshot([20]));
  expect(app.image.template).toBe(true);
  expect(app.image.representations[1]?.buffer?.equals(renderAccountUsageTrayIcon(20))).toBe(true);
  const updateCount = app.updates.length;
  app.theme.shouldUseDarkColors = true;
  app.theme.emit('updated');
  expect(app.updates.length).toBe(updateCount + 1);
  expect(app.image.representations[1]?.buffer?.equals(renderAccountUsageTrayIcon(20, { dark: true }))).toBe(true);
  source.update(snapshot([30]));
  expect(app.image.template).toBe(true);
  app.tray.dispose();
});

test('changing the active account updates the ring while keeping template coloring and the total', () => {
  const app = harness();
  const source = app.tray.register();
  source.update(snapshot([29.9, 100], 'a'));
  expect(app.image.template).toBe(true);
  expect(app.tooltip).toContain('130% remaining');
  const lowImage = app.image.representations[1]?.buffer;
  expect(lowImage?.equals(renderAccountUsageTrayIcon(29.9))).toBe(true);
  source.update(snapshot([29.9, 100], 'b'));
  expect(app.image.template).toBe(true);
  expect(app.tooltip).toContain('130% remaining');
  expect(app.image.representations[1]?.buffer?.equals(renderAccountUsageTrayIcon(100))).toBe(true);
  source.update(snapshot([30, 100], 'a'));
  expect(app.image.template).toBe(true);
  app.tray.dispose();
});

test('missing active usage leaves the ring unknown instead of using another account', () => {
  const app = harness();
  const source = app.tray.register();
  const accounts = snapshot([16, 100]);
  accounts.profiles[0]!.usage.state = 'error';
  source.update(accounts);
  expect(app.image.template).toBe(true);
  expect(app.tooltip).toContain('Ring: Unavailable');
  expect(app.image.representations[1]?.buffer?.equals(renderAccountUsageTrayIcon(null))).toBe(true);
  app.tray.dispose();
});

test('Show restores the selected window and falls back to app opening without a live window', () => {
  const app = harness();
  app.click('Show Cheshi');
  expect(app.openCalls).toBe(1);
  const source = app.tray.register();
  const window = new FakeWindow();
  window.minimized = true;
  window.attach(source);
  app.click('Show Cheshi');
  expect(window.calls).toEqual(['restore', 'show', 'focus']);
  window.destroyed = true;
  app.click('Show Cheshi');
  expect(app.openCalls).toBe(2);
  app.click('Quit Cheshi');
  expect(app.quitCalls).toBe(1);
  app.tray.dispose();
});

test('teardown removes theme and window subscriptions and destroys the tray exactly once', () => {
  const app = harness();
  const source = app.tray.register();
  const window = new FakeWindow();
  window.attach(source);
  expect(app.theme.listenerCount('updated')).toBe(1);
  app.tray.dispose();
  app.tray.dispose();
  expect(app.destroyed).toBe(1);
  expect(app.theme.listenerCount('updated')).toBe(0);
  expect(window.listenerCount('focus')).toBe(0);
  expect(window.listenerCount('closed')).toBe(0);
  const updates = app.updates.length;
  source.update(snapshot());
  source.dispose();
  app.theme.emit('updated');
  app.tray.register().update(snapshot());
  expect(app.updates.length).toBe(updates);
  expect(app.creations).toBe(1);
});

test('menu creation failures reach the error handler without breaking snapshot delivery', () => {
  const app = harness();
  const source = app.tray.register();
  const error = new Error('Menu unavailable');
  app.failMenu(error);
  expect(() => source.update(snapshot())).not.toThrow();
  expect(app.errors).toEqual([error]);
  app.tray.dispose();
});

function deferredFont() {
  let resolve!: (font: MenuBarFont) => void;
  const promise = new Promise<MenuBarFont>(done => { resolve = done; });
  return { promise, resolve };
}

test('loads the native font without blocking initial usage and ignores completion after disposal', async () => {
  const font: MenuBarFont = { scale: 4, glyphs: Object.fromEntries([...'-0123456789'].map(digit =>
    [digit, { width: 4, height: 8, left: 0, top: 0, advance: 5, alpha: Array<number>(32).fill(255) }])) };
  const pending = deferredFont();
  const app = harness(() => pending.promise);
  app.tray.register().update(snapshot());
  expect(app.image.representations[1]?.buffer?.equals(renderAccountUsageTrayIcon(92))).toBe(true);
  pending.resolve(font);
  await pending.promise;
  expect(app.image.representations[1]?.buffer?.equals(renderAccountUsageTrayIcon(92, { font }))).toBe(true);
  app.tray.dispose();

  const late = deferredFont();
  const closed = harness(() => late.promise);
  closed.tray.dispose();
  const count = closed.updates.length;
  late.resolve(font);
  await late.promise;
  expect(closed.updates.length).toBe(count);
});
