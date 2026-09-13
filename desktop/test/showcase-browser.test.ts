import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, Session, WebContentsView, WebContentsViewConstructorOptions } from 'electron';
import { createShowcaseBrowser } from '../lib/showcase-browser.mts';
import { SHOWCASE_CHANNELS, SHOWCASE_URLS } from '../shared/showcase.ts';
import type { ShowcasePage, ShowcaseState } from '../shared/showcase.ts';

class Contents extends EventEmitter {
  mainFrame = {};
  destroyed = false;
  url = '';
  title = '';
  zoom = 1;
  loads: string[] = [];
  rtcPolicy: Parameters<WebContentsView['webContents']['setWebRTCIPHandlingPolicy']>[0] = 'default';
  loadPolicies: string[] = [];
  styles: Array<{ key: string; css: string }> = [];
  removedStyles: string[] = [];
  scripts: Array<{ worldId: number; code: string }> = [];
  messages: ShowcaseState[] = [];
  closes: unknown[] = [];
  loadError: Error | null = null;
  insertCssGate: Promise<void> | null = null;
  insertCssError: Error | null = null;
  opening: ((details: { url: string }) => { action: string }) | null = null;
  back = 0;
  forward = 0;
  navigationHistory = {
    canGoBack: () => this.back > 0,
    canGoForward: () => this.forward > 0,
    goBack: () => { this.back -= 1; },
    goForward: () => { this.forward -= 1; },
  };
  isDestroyed() { return this.destroyed; }
  getZoomFactor() { return this.zoom; }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  send(_channel: string, state: ShowcaseState) { this.messages.push(state); }
  close(options: unknown) { this.closes.push(options); this.destroyed = true; }
  setWindowOpenHandler(callback: NonNullable<Contents['opening']>) { this.opening = callback; }
  setWebRTCIPHandlingPolicy(policy: Contents['rtcPolicy']) { this.rtcPolicy = policy; }
  async insertCSS(css: string) {
    const key = String(this.styles.length + 1);
    this.styles.push({ key, css });
    await this.insertCssGate;
    if (this.insertCssError) throw this.insertCssError;
    return key;
  }
  async removeInsertedCSS(key: string) { this.removedStyles.push(key); }
  async executeJavaScriptInIsolatedWorld(worldId: number, scripts: Array<{ code: string }>) {
    for (const script of scripts) this.scripts.push({ worldId, code: script.code });
  }
  async loadURL(url: string) {
    this.loadPolicies.push(this.rtcPolicy);
    this.loads.push(url);
    this.url = url;
    if (this.loadError) throw this.loadError;
  }
}

class View {
  webContents = new Contents();
  visible = false;
  backgroundColor = '#ffffff';
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  setVisible(value: boolean) { this.visible = value; }
  setBackgroundColor(value: string) { this.backgroundColor = value; }
  setBounds(value: View['bounds']) { this.bounds = value; }
}

class Window extends EventEmitter {
  webContents = new Contents();
  destroyed = false;
  children = new Set<View>();
  contentView = {
    addChildView: (view: View) => this.children.add(view),
    removeChildView: (view: View) => this.children.delete(view),
  };
  getContentSize() { return [800, 600]; }
  isDestroyed() { return this.destroyed; }
}

function harness() {
  const window = new Window();
  const views: View[] = [];
  const preferences: WebContentsViewConstructorOptions[] = [];
  const handlers = new Map<string, (event: IpcMainInvokeEvent, value: unknown) => unknown>();
  const external: string[] = [];
  const session = new EventEmitter();
  let check: Parameters<Session['setPermissionCheckHandler']>[0] = null;
  let request: Parameters<Session['setPermissionRequestHandler']>[0] = null;
  const service = createShowcaseBrowser({
    window: window as unknown as BrowserWindow,
    ipc: {
      handle: (channel: string, handler: (event: IpcMainInvokeEvent, value: unknown) => unknown) => handlers.set(channel, handler),
      removeHandler: (channel: string) => { handlers.delete(channel); },
    } as Pick<IpcMain, 'handle' | 'removeHandler'>,
    session: Object.assign(session, {
      setPermissionCheckHandler: (value: typeof check) => { check = value; },
      setPermissionRequestHandler: (value: typeof request) => { request = value; },
    }) as unknown as Session,
    createView: options => {
      preferences.push(options);
      const view = new View(); views.push(view);
      return view as unknown as WebContentsView;
    },
    openExternal: async url => { external.push(url); },
  });
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame } as unknown as IpcMainInvokeEvent;
  const invoke = (channel: string, value: unknown, sender = event) => handlers.get(channel)!(sender, value);
  const show = (page: ShowcasePage, visible = true) => invoke(SHOWCASE_CHANNELS.view, { page, visible, bounds: { x: 100, y: 50, width: 600, height: 500 } });
  return { window, views, preferences, handlers, external, session, service, event, invoke, show,
    getCheck: () => check!, getRequest: () => request! };
}

async function flushBackground() {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('isolated Showcase browser', () => {
  test('offers retry after theme preparation fails instead of exposing an unstyled page', async () => {
    const h = harness();
    h.invoke(SHOWCASE_CHANNELS.view, { page: 'gallery', visible: true, backgroundColor: '#1E2025',
      bounds: { x: 0, y: 0, width: 600, height: 500 } });
    const view = h.views[0]!;
    view.webContents.insertCssError = new Error('stylesheet unavailable');
    view.webContents.emit('dom-ready');
    await flushBackground();
    expect(view.visible).toBe(false);
    expect(h.window.webContents.messages.at(-1)?.error).toContain('could not be prepared');
    view.webContents.insertCssError = null;
    await h.invoke(SHOWCASE_CHANNELS.navigate, 'reload');
    expect(view.visible).toBe(false);
    view.webContents.emit('dom-ready');
    await flushBackground();
    expect(view.visible).toBe(true);
    expect(h.window.webContents.messages.at(-1)?.error).toBeNull();
    h.service.dispose();
  });

  test('keeps correctly sized pages hidden until their theme is installed, including navigation', async () => {
    const h = harness();
    const show = () => h.invoke(SHOWCASE_CHANNELS.view, { page: 'gallery', visible: true,
      backgroundColor: '#1E2025', bounds: { x: 0, y: 0, width: 600, height: 500 } });
    show();
    const view = h.views[0]!;
    expect(view.visible).toBe(false);
    expect(view.backgroundColor).toBe('#1E2025');
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 600, height: 500 });
    for (const url of [SHOWCASE_URLS.gallery, 'https://example.com/another-page']) {
      view.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      view.webContents.url = url;
      expect(view.visible).toBe(false);
      const gate = createDeferred();
      view.webContents.insertCssGate = gate.promise;
      view.webContents.emit('dom-ready');
      await flushBackground();
      view.webContents.emit('did-stop-loading');
      expect(h.window.webContents.messages.at(-1)?.loading).toBe(true);
      show(); // Repeated viewport updates must not reveal an unfinished style application.
      expect(view.visible).toBe(false);
      gate.resolve();
      await flushBackground();
      expect(view.visible).toBe(true);
      expect(h.window.webContents.messages.at(-1)?.loading).toBe(false);
    }
    h.service.dispose();
  });

  test('an obsolete style completion cannot reveal a newer document or an inactive page', async () => {
    const h = harness();
    h.invoke(SHOWCASE_CHANNELS.view, { page: 'gallery', visible: true, backgroundColor: '#1E2025',
      bounds: { x: 0, y: 0, width: 600, height: 500 } });
    const view = h.views[0]!;
    const gate = createDeferred();
    view.webContents.insertCssGate = gate.promise;
    view.webContents.emit('dom-ready');
    await flushBackground();
    view.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    gate.resolve();
    await flushBackground();
    expect(view.visible).toBe(false);
    expect(view.webContents.removedStyles).toEqual(['1']);
    view.webContents.emit('dom-ready');
    h.show('submission');
    await flushBackground();
    expect(view.visible).toBe(false);
    h.service.dispose();
  });

  test('applies the workspace background after load, token changes and reload', async () => {
    const h = harness();
    const show = (backgroundColor: string) => h.invoke(SHOWCASE_CHANNELS.view, {
      page: 'gallery', visible: true, backgroundColor, bounds: { x: 0, y: 0, width: 600, height: 500 },
    });
    show('#1E2025');
    const view = h.views[0]!;
    const contents = view.webContents;
    expect(contents.styles).toHaveLength(0);
    contents.emit('dom-ready');
    await flushBackground();
    expect(view.backgroundColor).toBe('#1E2025');
    expect(contents.styles[0]?.css).toContain('background-color: #1E2025');
    expect(contents.scripts[0]?.worldId).toBe(1001);
    show('#242832');
    await flushBackground();
    expect(view.backgroundColor).toBe('#242832');
    expect(contents.removedStyles).toContain('1');
    expect(contents.styles.at(-1)?.css).toContain('background-color: #242832');
    await h.invoke(SHOWCASE_CHANNELS.navigate, 'reload');
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    contents.emit('dom-ready');
    await flushBackground();
    expect(contents.loads).toEqual([SHOWCASE_URLS.gallery, SHOWCASE_URLS.gallery]);
    expect(contents.styles).toHaveLength(3);
    expect(contents.styles.at(-1)?.css).toContain('background-color: #242832');
    h.service.dispose();
  });

  test('themes arbitrary HTTPS pages and same-document routes in both views', async () => {
    const h = harness();
    for (const page of ['gallery', 'submission'] as const) {
      h.invoke(SHOWCASE_CHANNELS.view, { page, visible: true, backgroundColor: '#1E2025',
        bounds: { x: 0, y: 0, width: 600, height: 500 } });
      const contents = h.views.at(-1)!.webContents;
      contents.emit('dom-ready');
      await flushBackground();
      expect(contents.styles).toHaveLength(1);
      expect(contents.scripts[0]?.worldId).toBe(1001);
      contents.url = 'https://developers.openai.com/codex';
      contents.emit('did-navigate-in-page');
      await flushBackground();
      expect(contents.removedStyles).toEqual([]);
      expect(contents.styles).toHaveLength(1);
      expect(contents.styles.at(-1)?.css).toContain('background-color: #1E2025');
      for (const url of ['https://example.com/demo', 'https://community.example.org/projects/new']) {
        const previousStyles = contents.styles.length;
        contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
        contents.url = url;
        contents.emit('dom-ready');
        await flushBackground();
        expect(contents.styles).toHaveLength(previousStyles + 1);
        expect(contents.styles.at(-1)?.css).toContain('background-color: #1E2025');
        expect(contents.scripts.at(-1)?.worldId).toBe(1001);
      }
    }
    h.service.dispose();
  });

  test('updates the application background for existing gallery and submission documents', async () => {
    const h = harness();
    for (const page of ['gallery', 'submission'] as const) {
      h.invoke(SHOWCASE_CHANNELS.view, { page, visible: true, backgroundColor: '#1E2025',
        bounds: { x: 0, y: 0, width: 600, height: 500 } });
      h.views.at(-1)!.webContents.emit('dom-ready');
      await flushBackground();
    }
    h.invoke(SHOWCASE_CHANNELS.view, { page: 'submission', visible: true, backgroundColor: '#242832',
      bounds: { x: 0, y: 0, width: 600, height: 500 } });
    await flushBackground();
    for (const view of h.views) {
      expect(view.backgroundColor).toBe('#242832');
      expect(view.webContents.styles.at(-1)?.css).toContain('background-color: #242832');
      expect(view.webContents.removedStyles).toContain('1');
    }
    h.service.dispose();
  });

  test('does not inject page background styling into non-HTTPS documents', async () => {
    const h = harness();
    h.invoke(SHOWCASE_CHANNELS.view, { page: 'gallery', visible: true, backgroundColor: '#1E2025',
      bounds: { x: 0, y: 0, width: 600, height: 500 } });
    const contents = h.views[0]!.webContents;
    contents.emit('dom-ready');
    await flushBackground();
    const styleCount = contents.styles.length;
    const scriptCount = contents.scripts.length;
    for (const url of ['http://example.com/demo', 'file:///tmp/demo.html', 'about:blank']) {
      contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      contents.url = url;
      contents.emit('dom-ready');
      await flushBackground();
      expect(contents.styles).toHaveLength(styleCount);
      expect(contents.scripts).toHaveLength(scriptCount);
    }
    h.service.dispose();
  });

  test('restricts direct UDP before loading the submission form while preserving gallery WebRTC', async () => {
    const h = harness();
    h.show('gallery');
    h.show('submission');
    expect(h.views[0]!.webContents.loadPolicies).toEqual(['default']);
    expect(h.views[1]!.webContents.loadPolicies).toEqual(['disable_non_proxied_udp']);
    await h.invoke(SHOWCASE_CHANNELS.navigate, 'reload');
    expect(h.views[1]!.webContents.loadPolicies).toEqual(['disable_non_proxied_udp', 'disable_non_proxied_udp']);
    expect(h.window.webContents.rtcPolicy).toBe('default');
    h.service.dispose();
  });

  test('creates only requested pages and preserves each page when switching or hiding', () => {
    const h = harness();
    h.show('gallery', false);
    expect(h.views).toHaveLength(0);
    h.show('gallery');
    h.views[0]!.webContents.emit('dom-ready');
    h.show('submission');
    h.views[1]!.webContents.emit('dom-ready');
    expect(h.views.map(view => view.visible)).toEqual([false, true]);
    h.show('gallery');
    expect(h.views.map(view => view.webContents.loads)).toEqual([[SHOWCASE_URLS.gallery], [SHOWCASE_URLS.submission]]);
    h.show('gallery', false);
    expect(h.views.every(view => !view.visible)).toBe(true);
    expect(h.preferences[0]?.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false });
    expect(h.preferences[0]?.webPreferences?.preload).toBeUndefined();
    h.service.dispose();
  });

  test('converts CSS bounds using owner zoom and clamps to window content', () => {
    const h = harness();
    h.window.webContents.zoom = 2;
    h.show('gallery');
    expect(h.views[0]!.bounds).toEqual({ x: 200, y: 100, width: 600, height: 500 });
    h.window.webContents.zoom = 1;
    h.window.emit('resize');
    expect(h.views[0]!.bounds).toEqual({ x: 100, y: 50, width: 600, height: 500 });
    h.service.dispose();
  });

  test('requires the owner main frame and rejects malformed requests', () => {
    const h = harness();
    expect(() => h.invoke(SHOWCASE_CHANNELS.view, {}, { ...h.event, senderFrame: null })).toThrow('workspace window');
    expect(() => h.invoke(SHOWCASE_CHANNELS.view, { page: 'gallery', visible: 'true' })).toThrow();
    expect(h.views).toHaveLength(0);
    h.service.dispose();
  });

  test('denies permissions and downloads, blocks unsafe navigation and opens safe popups externally', async () => {
    const h = harness();
    expect(h.getCheck()(null, 'clipboard-read', '', { isMainFrame: true })).toBe(false);
    const granted: boolean[] = [];
    h.getRequest()(h.window.webContents as unknown as Electron.WebContents, 'media', value => { granted.push(value); }, { isMainFrame: true, requestingUrl: SHOWCASE_URLS.gallery });
    expect(granted).toEqual([false]);
    let prevented = 0;
    h.session.emit('will-download', { preventDefault() { prevented += 1; } });
    h.show('gallery');
    const contents = h.views[0]!.webContents;
    contents.emit('will-frame-navigate', { isMainFrame: true, url: 'file:///etc/passwd', preventDefault() { prevented += 1; } });
    contents.emit('will-redirect', { isMainFrame: true, url: 'javascript:alert(1)', preventDefault() { prevented += 1; } });
    expect(prevented).toBe(3);
    expect(contents.opening!({ url: 'https://example.com/demo' })).toEqual({ action: 'deny' });
    contents.opening!({ url: 'https://name:password@example.com/' });
    contents.opening!({ url: 'file:///tmp/test' });
    await Promise.resolve();
    expect(h.external).toEqual(['https://example.com/demo']);
    h.service.dispose();
  });

  test('hides native overlays on workspace navigation and removes every view and handler on disposal', () => {
    const h = harness();
    h.show('gallery'); h.show('submission');
    h.window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(h.views.every(view => !view.visible)).toBe(true);
    h.show('submission');
    h.window.emit('closed'); h.service.dispose();
    expect(h.handlers.size).toBe(0);
    expect(h.window.children.size).toBe(0);
    expect(h.session.listenerCount('will-download')).toBe(0);
    expect(h.window.webContents.listenerCount('did-start-navigation')).toBe(0);
    expect(h.views.map(view => view.webContents.closes)).toEqual([[{ waitForBeforeUnload: false }], [{ waitForBeforeUnload: false }]]);
  });

  test('reports main frame failures, ignores canceled/subframe loads, and reloads after a crash', async () => {
    const h = harness(); h.show('gallery');
    const view = h.views[0]!;
    view.webContents.emit('dom-ready');
    view.webContents.emit('did-fail-load', {}, -3, '', '', true);
    view.webContents.emit('did-fail-load', {}, -105, '', '', false);
    expect(view.visible).toBe(true);
    view.webContents.emit('render-process-gone', {});
    expect(view.visible).toBe(false);
    expect(h.window.webContents.messages.at(-1)?.error).toContain('stopped responding');
    await h.invoke(SHOWCASE_CHANNELS.navigate, 'reload');
    expect(view.visible).toBe(false);
    view.webContents.emit('dom-ready');
    expect(view.visible).toBe(true);
    expect(view.webContents.loads).toEqual([SHOWCASE_URLS.gallery, SHOWCASE_URLS.gallery]);
    view.webContents.loadError = new Error('network unavailable');
    await h.invoke(SHOWCASE_CHANNELS.navigate, 'home');
    expect(view.visible).toBe(false);
    expect(h.window.webContents.messages.at(-1)?.error).toContain('could not be loaded');
    h.service.dispose();
  });

  test('publishes navigation state and routes navigation controls to the selected page', async () => {
    const h = harness(); h.show('gallery');
    const contents = h.views[0]!.webContents;
    contents.emit('dom-ready');
    contents.title = 'A community project'; contents.url = 'https://example.com/demo'; contents.back = 1; contents.forward = 1;
    contents.emit('did-stop-loading');
    expect(h.window.webContents.messages.at(-1)).toMatchObject({ title: contents.title, url: contents.url, loading: false, canGoBack: true, canGoForward: true });
    await h.invoke(SHOWCASE_CHANNELS.navigate, 'external');
    expect(h.external).toEqual([contents.url]);
    await h.invoke(SHOWCASE_CHANNELS.navigate, 'back');
    await h.invoke(SHOWCASE_CHANNELS.navigate, 'forward');
    expect(contents.back).toBe(0); expect(contents.forward).toBe(0);
    h.service.dispose();
  });
});
