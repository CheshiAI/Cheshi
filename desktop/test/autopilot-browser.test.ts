import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, Session, WebContentsView, WebContentsViewConstructorOptions } from 'electron';
import { createAutopilotBrowser } from '../lib/autopilot-browser.mts';
import { AUTOPILOT_CHANNELS, parseAutopilotState } from '../shared/autopilot.ts';
import type { AutopilotState } from '../shared/autopilot.ts';

class Contents extends EventEmitter {
  mainFrame = {};
  destroyed = false;
  url = '';
  loads: string[] = [];
  messages: AutopilotState[] = [];
  worlds: number[] = [];
  stops = 0;
  linkAvailable = true;
  linkUrl = 'https://example.org/target';
  pageText = 'Page';
  opening: (() => { action: string }) | null = null;
  isDestroyed() { return this.destroyed; }
  getZoomFactor() { return 2; }
  stop() { this.stops += 1; }
  send(_channel: string, state: AutopilotState) { this.messages.push(state); }
  close() { this.destroyed = true; }
  setWindowOpenHandler(handler: NonNullable<Contents['opening']>) { this.opening = handler; }
  async loadURL(url: string) { this.url = url; this.loads.push(url); }
  async executeJavaScriptInIsolatedWorld(world: number) {
    this.worlds.push(world);
    return { url: this.url, title: this.url.endsWith('/target') ? 'Target' : 'Start', text: this.pageText,
      links: this.linkAvailable ? [{ url: this.linkUrl, label: 'Target' }] : [] };
  }
}
class View {
  webContents = new Contents();
  visible = false;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  setVisible(value: boolean) { this.visible = value; }
  setBounds(value: View['bounds']) { this.bounds = value; }
}
class Window extends EventEmitter {
  webContents = new Contents();
  children = new Set<View>();
  contentView = { addChildView: (view: View) => this.children.add(view), removeChildView: (view: View) => this.children.delete(view) };
  getContentSize() { return [1000, 800]; }
  isDestroyed() { return false; }
}

function harness(beforeResponse?: () => void) {
  const window = new Window();
  const views: View[] = [];
  const preferences: WebContentsViewConstructorOptions[] = [];
  const modelPages: Array<{ url: string; text: string }> = [];
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const session = Object.assign(new EventEmitter(), { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} });
  const service = createAutopilotBrowser({
    window: window as unknown as BrowserWindow,
    session: session as unknown as Session,
    ipc: { handle(channel, listener) { handlers.set(channel, listener); }, removeHandler(channel) { handlers.delete(channel); } },
    createView(options) { preferences.push(options); const view = new View(); views.push(view); return view as unknown as WebContentsView; },
    getKey: () => 'fixture-key',
    request: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      modelPages.push(body.state.currentPage);
      const answers = Object.fromEntries(Object.entries(body.questions as Record<string, { criteria: Record<string, string> }>).map(([id, question]) =>
        [id, { type: 'choice', confidence: 1, choice: id === 'completion'
          ? body.state.currentPage.title === 'Target' ? 'reached' : 'continue' : Object.keys(question.criteria)[0] }]));
      beforeResponse?.();
      return Response.json({ answers });
    }),
  });
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame } as unknown as IpcMainInvokeEvent;
  const invoke = (channel: string, value?: unknown, sender = event) => handlers.get(channel)!(sender, value);
  return { window, views, preferences, handlers, session, service, event, invoke, modelPages };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('native browser is lazy, uses an isolated session, exposes state and cleans up with its workspace', async () => {
  const h = harness();
  try {
    const initial = parseAutopilotState(h.invoke(AUTOPILOT_CHANNELS.get));
    expect(initial.phase).toBe('idle');
    expect(initial.configured).toBe(true);
    h.invoke(AUTOPILOT_CHANNELS.view, { visible: true, bounds: { x: 20, y: 30, width: 700, height: 500 } });
    expect(h.views).toHaveLength(0);
    h.invoke(AUTOPILOT_CHANNELS.start, { url: 'https://example.org/start', goal: 'Target page' });
    await flush();
    const view = h.views[0]!;
    expect(h.preferences[0]?.webPreferences?.sandbox).toBe(true);
    expect(h.preferences[0]?.webPreferences?.nodeIntegration).toBe(false);
    expect(h.preferences[0]?.webPreferences?.preload).toBeUndefined();
    expect(view.bounds).toEqual({ x: 40, y: 60, width: 960, height: 740 });
    expect(view.visible).toBe(true);
    expect(view.webContents.loads).toEqual(['https://example.org/start', 'https://example.org/target']);
    expect(view.webContents.worlds.every(world => world === 1002)).toBe(true);
    expect(parseAutopilotState(h.invoke(AUTOPILOT_CHANNELS.get)).phase).toBe('completed');
    expect(JSON.stringify(h.window.webContents.messages)).not.toContain('fixture-key');
    expect(view.webContents.opening?.().action).toBe('deny');
    h.invoke(AUTOPILOT_CHANNELS.view, { visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } });
    expect(view.visible).toBe(false);
  } finally { h.service.dispose(); }
  expect(h.handlers.size).toBe(0);
  expect(h.window.children.size).toBe(0);
  expect(h.views[0]?.webContents.destroyed).toBe(true);
  expect(h.session.listenerCount('will-download')).toBe(0);
});

test('only the owner main frame can invoke Autopilot and unsafe redirects and downloads are blocked', async () => {
  const h = harness();
  try {
    const other = { ...h.event, senderFrame: {} } as IpcMainInvokeEvent;
    expect(() => h.invoke(AUTOPILOT_CHANNELS.start, {}, other)).toThrow('workspace window');
    expect(h.views).toHaveLength(0);
    h.invoke(AUTOPILOT_CHANNELS.start, { url: 'https://example.org/start', goal: 'Target' });
    await flush();
    let blocked = 0;
    h.views[0]!.webContents.emit('will-redirect', { url: 'file:///etc/passwd', preventDefault() { blocked += 1; } });
    h.session.emit('will-download', { preventDefault() { blocked += 1; } });
    expect(blocked).toBe(2);
  } finally { h.service.dispose(); }
});

test('a link removed while the model is deciding cannot be followed', async () => {
  const h = harness(() => { h.views[0]!.webContents.linkAvailable = false; });
  try {
    h.invoke(AUTOPILOT_CHANNELS.start, { url: 'https://example.org/start', goal: 'Target' });
    await flush();
    expect(h.views[0]!.webContents.loads).toEqual(['https://example.org/start']);
    const state = parseAutopilotState(h.invoke(AUTOPILOT_CHANNELS.get));
    expect(state.phase).toBe('error');
    expect(state.error).toContain('No unvisited links');
    expect(h.modelPages).toHaveLength(2);
  } finally { h.service.dispose(); }
});

test('a stale selection is replaced using fresh page text and links without loading the removed URL', async () => {
  const h = harness(() => {
    h.views[0]!.webContents.linkUrl = 'https://example.org/target';
    h.views[0]!.webContents.pageText = 'Updated page';
  });
  try {
    h.invoke(AUTOPILOT_CHANNELS.start, { url: 'https://example.org/start', goal: 'Target' });
    h.views[0]!.webContents.linkUrl = 'https://example.org/stale';
    await flush();
    expect(h.views[0]!.webContents.loads).toEqual(['https://example.org/start', 'https://example.org/target']);
    expect(h.modelPages.map(page => page.text)).toEqual(['Page', 'Updated page', 'Updated page']);
    const state = parseAutopilotState(h.invoke(AUTOPILOT_CHANNELS.get));
    expect(state.phase).toBe('completed');
    expect(state.error).toBeNull();
    expect(state.steps.map(page => page.title)).toEqual(['Start', 'Target']);
  } finally { h.service.dispose(); }
});

test('URL changes trigger a fresh decision even when the previously selected link still exists', async () => {
  const h = harness(() => {
    if (h.modelPages.length === 1) h.views[0]!.webContents.url = 'https://example.org/changed';
  });
  try {
    h.invoke(AUTOPILOT_CHANNELS.start, { url: 'https://example.org/start', goal: 'Target' });
    await flush();
    const state = parseAutopilotState(h.invoke(AUTOPILOT_CHANNELS.get));
    expect(state.phase).toBe('completed');
    expect(h.modelPages.map(page => page.url)).toEqual(state.steps.map(page => page.url));
    expect(state.steps.map(page => page.url)).toEqual([
      'https://example.org/start', 'https://example.org/changed', 'https://example.org/target',
    ]);
  } finally { h.service.dispose(); }
});
