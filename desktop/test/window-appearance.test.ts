import { afterEach, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { APPEARANCE_CHANNELS, DEFAULT_WINDOW_APPEARANCE, parseWindowAppearance } from '../shared/window-appearance';
import { createWindowAppearanceStore } from '../lib/window-appearance-store.mts';
import { createWindowAppearance } from '../lib/window-appearance.mts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function filename() {
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-appearance-'));
  directories.push(directory);
  return path.join(directory, 'appearance.json');
}

test('appearance validates literal flags and finite bounded controls', () => {
  expect(parseWindowAppearance(DEFAULT_WINDOW_APPEARANCE)).toEqual(DEFAULT_WINDOW_APPEARANCE);
  for (const patch of [{ enabled: 1 }, { mainPaneGlass: 'true' }, { opacity: NaN }, { opacity: .14 },
    { opacity: 1.1 }, { blurRadius: 65 }, { blurRadius: 1.5 }, { blurRadius: -1 }]) {
    expect(() => parseWindowAppearance({ ...DEFAULT_WINDOW_APPEARANCE, ...patch })).toThrow();
  }
});

test('appearance persists atomically, rejects invalid writes, and reports corrupt storage', () => {
  const file = filename();
  const store = createWindowAppearanceStore(file);
  expect(store.read()).toEqual(DEFAULT_WINDOW_APPEARANCE);
  const saved = { ...DEFAULT_WINDOW_APPEARANCE, enabled: false, opacity: .6 };
  store.save(saved);
  expect(createWindowAppearanceStore(file).read()).toEqual(saved);
  expect(() => store.save({ ...saved, enabled: 'false' })).toThrow();
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(saved);
  writeFileSync(file, '{bad json');
  expect(() => store.read()).toThrow('Could not read');
});

function harness(file = filename()) {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const window = new EventEmitter();
  const calls: { enabled: boolean; radius: number }[] = [];
  let background = '', fail = false, reduced = false;
  const owner = { mainFrame: {}, isDestroyed: () => false, send: () => {} };
  const boundary = Object.assign(window, {
    webContents: owner, isDestroyed: () => false,
    getNativeWindowHandle: () => Buffer.alloc(8),
    setBackgroundColor: (value: string) => { background = value; },
  }) as unknown as BrowserWindow;
  const controller = createWindowAppearance({
    window: boundary, filename: file, backgrounds: { dark: '#111111', light: '#eeeeee' },
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler: channel => { handlers.delete(channel); } },
    binding: {
      windowGlassSupported: () => true,
      setWindowGlass(_handle, enabled, radius) {
        calls.push({ enabled, radius });
        if (enabled && fail) throw new Error('Native failure');
        return enabled ? reduced ? 'reduced-transparency' : 'active' : 'disabled';
      },
    },
  });
  const invoke = (channel: string, value?: unknown, foreign = false) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error('Missing handler');
    return handler({ sender: foreign ? {} : owner, senderFrame: owner.mainFrame } as IpcMainInvokeEvent, value);
  };
  return { controller, calls, invoke, handlers, window, background: () => background,
    fail: () => { fail = true; }, reduce: () => { reduced = true; } };
}

test('first paint stays opaque; ready enables glass; light theme and disabled settings restore opacity', () => {
  const h = harness();
  expect(h.calls.at(-1)?.enabled).toBe(false);
  h.controller.ready('dark');
  expect(h.invoke(APPEARANCE_CHANNELS.get).active).toBe(true);
  expect(h.background()).toBe('#00000000');
  h.controller.setTheme('light');
  expect(h.background()).toBe('#eeeeee');
  h.controller.setTheme('dark');
  h.invoke(APPEARANCE_CHANNELS.set, { ...DEFAULT_WINDOW_APPEARANCE, enabled: false });
  expect(h.background()).toBe('#111111');
  expect(() => h.invoke(APPEARANCE_CHANNELS.set, DEFAULT_WINDOW_APPEARANCE, true)).toThrow();
  h.window.emit('closed');
  expect(h.handlers.size).toBe(0);
});

test('native failure and accessibility reduction leave an opaque readable window', () => {
  const h = harness();
  h.fail(); h.controller.ready('dark');
  expect(h.background()).toBe('#111111');
  expect(h.invoke(APPEARANCE_CHANNELS.get).active).toBe(false);
  expect(h.invoke(APPEARANCE_CHANNELS.get).error).toContain('Could not apply');
  h.controller.dispose();
  const reduced = harness();
  reduced.reduce(); reduced.controller.ready('dark');
  expect(reduced.background()).toBe('#111111');
  expect(reduced.invoke(APPEARANCE_CHANNELS.get).error).toContain('accessibility');
  reduced.controller.dispose();
});

test('saved changes propagate to other workspace windows without polling', () => {
  const file = filename(), first = harness(file), second = harness(file);
  first.controller.ready('dark'); second.controller.ready('dark');
  first.invoke(APPEARANCE_CHANNELS.set, { ...DEFAULT_WINDOW_APPEARANCE, blurRadius: 8 });
  expect(second.calls.at(-1)).toEqual({ enabled: true, radius: 8 });
  const count = second.calls.length;
  second.controller.dispose();
  first.invoke(APPEARANCE_CHANNELS.set, { ...DEFAULT_WINDOW_APPEARANCE, enabled: false });
  expect(second.calls.length).toBe(count);
  first.controller.dispose();
});

test('opacity and main pane changes do not reapply the native blur', () => {
  const h = harness();
  h.controller.ready('dark');
  const calls = h.calls.length;
  h.invoke(APPEARANCE_CHANNELS.set, { ...DEFAULT_WINDOW_APPEARANCE, opacity: .4, mainPaneGlass: false });
  expect(h.calls.length).toBe(calls);
  expect(h.invoke(APPEARANCE_CHANNELS.get).active).toBe(true);
  h.controller.dispose();
});
