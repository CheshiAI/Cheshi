import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
  loading = false;
  loadOperation?: (contents: Contents, url: string) => Promise<void>;
  linkAvailable = true;
  linkUrl = 'https://example.org/target';
  pageText = 'Page';
  opening: (() => { action: string }) | null = null;
  isDestroyed() { return this.destroyed; }
  isLoadingMainFrame() { return this.loading; }
  getZoomFactor() { return 2; }
  stop() { this.stops += 1; this.loading = false; }
  send(_channel: string, state: AutopilotState) { this.messages.push(state); }
  close() { this.destroyed = true; }
  setWindowOpenHandler(handler: NonNullable<Contents['opening']>) { this.opening = handler; }
  async loadURL(url: string) {
    this.url = url; this.loads.push(url); this.loading = true;
    if (this.loadOperation) return this.loadOperation(this, url);
    this.loading = false;
  }
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

function harness(beforeResponse?: () => void, options: {
  load?: Contents['loadOperation']; navigationTimeoutMs?: number;
  reportDirectory?: string;
} = {}) {
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
    createView(preference) {
      preferences.push(preference);
      const view = new View(); view.webContents.loadOperation = options.load;
      views.push(view); return view as unknown as WebContentsView;
    },
    navigationTimeoutMs: options.navigationTimeoutMs,
    reportDirectory: options.reportDirectory,
    getKey: () => 'fixture-key',
    request: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      modelPages.push(body.state.currentPage);
      const answers = Object.fromEntries(Object.entries(body.questions as Record<string, { criteria: Record<string, string> }>).map(([id, question]) =>
        [id, { type: 'choice', confidence: 1, choice: id === 'completion'
          ? body.state.currentPage.title === 'Target' ? 'reached' : 'continue'
          : id === 'evidence' && body.state.currentPage.title === 'Target'
            ? Object.keys(question.criteria).find(key => key !== 'none') ?? 'none' : Object.keys(question.criteria)[0] }]));
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

const abortedNavigation = () => Object.assign(new Error('Navigation replaced'), { code: 'ERR_ABORTED' });
const loadEvents = ['did-finish-load', 'did-stop-loading', 'did-fail-load', 'did-fail-provisional-load', 'destroyed', 'render-process-gone'];
function expectLoadListenersRemoved(contents: Contents) {
  for (const event of loadEvents) expect(contents.listenerCount(event)).toBe(0);
}

test('an aborted initial request follows the replacement navigation and reads only the finished page', async () => {
  const h = harness(undefined, { load: async () => { throw abortedNavigation(); } });
  try {
    h.invoke(AUTOPILOT_CHANNELS.start, { url: 'https://example.org/start', goal: 'Target' });
    await flush();
    const contents = h.views[0]!.webContents;
    expect(parseAutopilotState(h.invoke(AUTOPILOT_CHANNELS.get)).phase).toBe('loading');
    expect(contents.stops).toBe(0);
    expect(contents.worlds).toHaveLength(0);
    let blocked = false;
    contents.emit('will-navigate', { url: 'https://example.org/target', preventDefault() { blocked = true; } });
    expect(blocked).toBe(false);
    contents.emit('did-fail-provisional-load', {}, -3, 'ERR_ABORTED', contents.url, true);
    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://subframe.invalid/', false);
    contents.url = 'https://example.org/target'; contents.loading = false;
    contents.emit('did-finish-load');
    await flush();
    const state = parseAutopilotState(h.invoke(AUTOPILOT_CHANNELS.get));
    expect(state.phase).toBe('completed');
    expect(state.steps.map(step => step.url)).toEqual(['https://example.org/target']);
    expect(contents.stops).toBe(0);
    expectLoadListenersRemoved(contents);
    contents.emit('will-navigate', { url: 'https://example.org/elsewhere', preventDefault() { blocked = true; } });
    expect(blocked).toBe(true);
  } finally { h.service.dispose(); }
});

test('completion arriving before the superseded load promise rejects is not missed', async () => {
  const h = harness(undefined, { load: async contents => {
    contents.url = 'https://example.org/target'; contents.loading = false;
    contents.emit('did-finish-load');
    throw abortedNavigation();
  } });
  try {
    h.invoke(AUTOPILOT_CHANNELS.start, { url: 'https://example.org/start', goal: 'Target' });
    await flush();
    expect(parseAutopilotState(h.invoke(AUTOPILOT_CHANNELS.get)).phase).toBe('completed');
    expectLoadListenersRemoved(h.views[0]!.webContents);
  } finally { h.service.dispose(); }
});

test('recovery waits for the loading flag to clear after did-finish-load and ignores an early stop', async () => {
  const h = harness(undefined, { load: async () => { throw abortedNavigation(); } });
  try {
    h.invoke(AUTOPILOT_CHANNELS.start, { url: 'https://example.org/start', goal: 'Target' });
    await flush();
    const contents = h.views[0]!.webContents;
    contents.loading = false;
    contents.emit('did-stop-loading');
    await flush();
    expect(h.modelPages).toHaveLength(0);
    contents.loading = true;
    contents.url = 'https://example.org/target';
    contents.emit('did-finish-load');
    await flush();
    expect(h.modelPages).toHaveLength(0);
    contents.loading = false;
    contents.emit('did-stop-loading');
    await flush();
    expect(parseAutopilotState(h.invoke(AUTOPILOT_CHANNELS.get)).phase).toBe('completed');
    expect(contents.stops).toBe(0);
    expectLoadListenersRemoved(contents);
  } finally { h.service.dispose(); }
});

test('a replacement navigation still fails on a real main-frame error', async () => {
  const h = harness(undefined, { load: async () => { throw abortedNavigation(); } });
  try {
    h.invoke(AUTOPILOT_CHANNELS.start, { url: 'https://example.org/start', goal: 'Target' });
    await flush();
    const contents = h.views[0]!.webContents;
    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', contents.url, true);
    await flush();
    expect(parseAutopilotState(h.invoke(AUTOPILOT_CHANNELS.get)).phase).toBe('error');
    expect(contents.stops).toBe(1);
    expect(h.modelPages).toHaveLength(0);
    expectLoadListenersRemoved(contents);
  } finally { h.service.dispose(); }
});

test('an initial real network failure is not treated as a replaced request', async () => {
  const h = harness(undefined, { load: async () => {
    throw Object.assign(new Error('Network unavailable'), { code: 'ERR_NAME_NOT_RESOLVED' });
  } });
  try {
    h.invoke(AUTOPILOT_CHANNELS.start, { url: 'https://example.org/start', goal: 'Target' });
    await flush();
    expect(parseAutopilotState(h.invoke(AUTOPILOT_CHANNELS.get)).phase).toBe('error');
    expect(h.modelPages).toHaveLength(0);
    expectLoadListenersRemoved(h.views[0]!.webContents);
  } finally { h.service.dispose(); }
});

test('replacement recovery times out instead of waiting or retrying forever', async () => {
  const h = harness(undefined, { load: async () => { throw abortedNavigation(); }, navigationTimeoutMs: 10 });
  try {
    h.invoke(AUTOPILOT_CHANNELS.start, { url: 'https://example.org/start', goal: 'Target' });
    await delay(30);
    expect(parseAutopilotState(h.invoke(AUTOPILOT_CHANNELS.get)).phase).toBe('error');
    const contents = h.views[0]!.webContents;
    expect(contents.loads).toHaveLength(1);
    expect(contents.stops).toBe(1);
    expectLoadListenersRemoved(contents);
  } finally { h.service.dispose(); }
});

test('unsafe replacement navigation is blocked and fails the pending load', async () => {
  for (const event of ['will-navigate', 'will-redirect']) {
    const h = harness(undefined, { load: async () => { throw abortedNavigation(); } });
    try {
      h.invoke(AUTOPILOT_CHANNELS.start, { url: 'https://example.org/start', goal: 'Target' });
      await flush();
      const contents = h.views[0]!.webContents;
      let blocked = false;
      contents.emit(event, { url: 'file:///etc/passwd', preventDefault() { blocked = true; } });
      await flush();
      expect(blocked).toBe(true);
      expect(parseAutopilotState(h.invoke(AUTOPILOT_CHANNELS.get)).phase).toBe('error');
      expect(h.modelPages).toHaveLength(0);
      expectLoadListenersRemoved(contents);
    } finally { h.service.dispose(); }
  }
});

test('stop during recovery releases listeners and permits a fresh run without reviving the stopped one', async () => {
  const h = harness(undefined, { load: async () => { throw abortedNavigation(); } });
  try {
    h.invoke(AUTOPILOT_CHANNELS.start, { url: 'https://example.org/start', goal: 'Target' });
    await flush();
    const contents = h.views[0]!.webContents;
    h.invoke(AUTOPILOT_CHANNELS.stop);
    await flush();
    expect(parseAutopilotState(h.invoke(AUTOPILOT_CHANNELS.get)).phase).toBe('stopped');
    expect(contents.stops).toBeGreaterThan(0);
    expectLoadListenersRemoved(contents);
    contents.emit('did-finish-load');
    await flush();
    expect(h.modelPages).toHaveLength(0);
    contents.loadOperation = undefined;
    h.invoke(AUTOPILOT_CHANNELS.start, { url: 'https://example.org/target', goal: 'Target' });
    await flush();
    expect(parseAutopilotState(h.invoke(AUTOPILOT_CHANNELS.get)).phase).toBe('completed');
    expectLoadListenersRemoved(contents);
  } finally { h.service.dispose(); }
});


async function expectRejected(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}

test('research export saves directly and rejects dialog requests and foreign frames', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-research-ipc-'));
  const h = harness(undefined, {
    reportDirectory: directory,
    load: async contents => { contents.pageText = 'A primary source describing the TypeSafe AI Jev model with original evidence.'; contents.loading = false; },
  });
  try {
    h.invoke(AUTOPILOT_CHANNELS.start, { url: 'https://example.org/start', goal: 'Find original Jev evidence', mode: 'research', targetSources: 1 });
    await flush();
    expect(parseAutopilotState(h.invoke(AUTOPILOT_CHANNELS.get)).sources).toHaveLength(1);
    for (const format of ['markdown', 'csv']) expect(await h.invoke(AUTOPILOT_CHANNELS.export, format)).toBe(true);
    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    for (const filename of files) {
      const saved = await readFile(join(directory, filename), 'utf8');
      expect(saved).toContain('https://example.org/target');
      expect(saved).toContain('A primary source describing');
      expect(saved).not.toContain('fixture-key');
    }
    await expectRejected(h.invoke(AUTOPILOT_CHANNELS.export, { format: 'csv', saveAs: true }), 'format');
    await expectRejected(h.invoke(AUTOPILOT_CHANNELS.export, 'csv', { ...h.event, senderFrame: {} } as IpcMainInvokeEvent), 'workspace window');
    await expectRejected(h.invoke(AUTOPILOT_CHANNELS.export, 'exe'), 'format');
  } finally { h.service.dispose(); await rm(directory, { recursive: true, force: true }); }
});
