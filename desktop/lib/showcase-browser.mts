import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, Session, WebContentsView, WebContentsViewConstructorOptions } from 'electron';
import { SHOWCASE_CHANNELS, SHOWCASE_URLS, parseShowcaseAction, parseShowcaseViewRequest, safeShowcaseUrl } from '../shared/showcase.ts';
import type { ShowcasePage, ShowcaseState, ShowcaseViewRequest } from '../shared/showcase.ts';
import { pageBackgroundCss, pageBackgroundScript } from './showcase-page-theme.mts';

interface Options {
  window: BrowserWindow;
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  createView(options: WebContentsViewConstructorOptions): WebContentsView;
  session: Session;
  openExternal(url: string): Promise<unknown>;
}

interface PageView {
  view: WebContentsView;
  state: ShowcaseState;
  displayReady: boolean;
  style: { ready: boolean; revision: number; key?: string; color?: string };
}

/** Remote pages have their own session and never receive the workspace preload. */
export function createShowcaseBrowser(options: Options) {
  const owner = options.window.webContents;
  const pages = new Map<ShowcasePage, PageView>();
  const registeredChannels: string[] = [];
  let current: ShowcaseViewRequest | null = null;
  let disposed = false;
  let backgroundColor: string | undefined;

  async function syncBackground(page: PageView) {
    const contents = page.view.webContents;
    if (disposed || contents.isDestroyed() || !page.style.ready) return;
    const color = safeShowcaseUrl(contents.getURL()) ? backgroundColor : undefined;
    if (page.style.color === color) {
      if (!color) { page.displayReady = true; layout(); emit(page); }
      return;
    }
    const revision = ++page.style.revision;
    const previousKey = page.style.key;
    page.style.color = color;
    page.style.key = undefined;
    page.view.setBackgroundColor(color ?? '#ffffff');
    try {
      if (previousKey) await contents.removeInsertedCSS(previousKey);
      if (disposed || contents.isDestroyed() || revision !== page.style.revision) return;
      await contents.executeJavaScriptInIsolatedWorld(1001, [{ code: pageBackgroundScript(color ?? null) }]);
      if (!color || disposed || contents.isDestroyed() || revision !== page.style.revision) return;
      const key = await contents.insertCSS(pageBackgroundCss(color), { cssOrigin: 'user' });
      if (!disposed && !contents.isDestroyed() && revision === page.style.revision) {
        page.style.key = key;
        page.displayReady = true;
        layout();
        emit(page);
      }
      else if (!contents.isDestroyed()) await contents.removeInsertedCSS(key);
    } catch {
      if (!disposed && revision === page.style.revision) {
        page.style.color = undefined;
        console.warn('[cheshi] Showcase background could not be applied.');
        if (!page.displayReady) fail(page, 'This page could not be prepared. Try again or open it in your browser.');
      }
    }
  }

  const denyDownload = (event: Electron.Event) => event.preventDefault();
  options.session.setPermissionCheckHandler(() => false);
  options.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  options.session.on('will-download', denyDownload);

  function assertOwner(event: IpcMainInvokeEvent) {
    if (disposed || event.sender !== owner || event.senderFrame !== owner.mainFrame) {
      throw new Error('Showcase is only available to its workspace window.');
    }
  }

  function emit(page: PageView) {
    // The content loader stays visible until the themed page can actually be shown.
    page.state.loading = !page.displayReady && page.state.error === null;
    if (!disposed && !owner.isDestroyed()) owner.send(SHOWCASE_CHANNELS.state, { ...page.state });
  }

  function layout() {
    if (disposed || options.window.isDestroyed()) return;
    const [width = 0, height = 0] = options.window.getContentSize();
    const zoom = owner.getZoomFactor();
    for (const [id, page] of pages) {
      const bounds = current?.bounds;
      const visible = current?.visible === true && current.page === id && page.state.error === null && bounds !== undefined;
      if (!visible || !bounds) { page.view.setVisible(false); continue; }
      const x = Math.max(0, Math.min(width, Math.round(bounds.x * zoom)));
      const y = Math.max(0, Math.min(height, Math.round(bounds.y * zoom)));
      const right = Math.max(x, Math.min(width, Math.round((bounds.x + bounds.width) * zoom)));
      const bottom = Math.max(y, Math.min(height, Math.round((bounds.y + bounds.height) * zoom)));
      page.view.setBounds({ x, y, width: right - x, height: bottom - y });
      page.view.setVisible(page.displayReady && right > x && bottom > y);
    }
  }

  function update(page: PageView) {
    if (disposed || page.view.webContents.isDestroyed()) return;
    const contents = page.view.webContents;
    page.state.url = safeShowcaseUrl(contents.getURL()) ?? page.state.url;
    page.state.title = contents.getTitle().slice(0, 4096);
    page.state.canGoBack = contents.navigationHistory.canGoBack();
    page.state.canGoForward = contents.navigationHistory.canGoForward();
    emit(page);
  }

  function fail(page: PageView, message: string) {
    if (disposed) return;
    page.state.error = message;
    layout();
    emit(page);
  }

  async function load(page: PageView, url: string) {
    page.state.error = null;
    page.displayReady = false;
    page.style = { ready: false, revision: page.style.revision + 1 };
    layout();
    emit(page);
    try { await page.view.webContents.loadURL(url); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_ABORTED') return;
      fail(page, 'This page could not be loaded. Try again or open it in your browser.');
    }
  }

  async function external(page: PageView, value: string) {
    const url = safeShowcaseUrl(value);
    if (!url) return;
    try { await options.openExternal(url); }
    catch { fail(page, 'The browser could not be opened. Please try again.'); }
  }

  function createPage(id: ShowcasePage): PageView {
    const view = options.createView({ webPreferences: {
      session: options.session, sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false,
    } });
    if (backgroundColor) view.setBackgroundColor(backgroundColor);
    const page: PageView = { view, displayReady: false, style: { ready: false, revision: 0 }, state: {
      page: id, url: SHOWCASE_URLS[id], title: '', loading: true, error: null,
      canGoBack: false, canGoForward: false,
    } };
    pages.set(id, page);
    options.window.contentView.addChildView(view);
    view.setVisible(false);
    const contents = view.webContents;
    // The submission form needs HTTPS, not direct UDP ICE discovery.
    // Keep gallery demos on the default WebRTC policy.
    if (id === 'submission') contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.on('did-start-navigation', event => {
      if (event.isMainFrame && !event.isSameDocument) {
        page.displayReady = false;
        page.state.error = null;
        page.style = { ready: false, revision: page.style.revision + 1 };
        layout();
        update(page);
      }
    });
    contents.on('dom-ready', () => { page.style.ready = true; void syncBackground(page); });
    contents.setWindowOpenHandler(({ url }) => { void external(page, url); return { action: 'deny' }; });
    contents.on('will-frame-navigate', event => {
      if (event.isMainFrame && !safeShowcaseUrl(event.url)) {
        event.preventDefault();
        fail(page, 'This link requires an external browser.');
      }
    });
    contents.on('will-redirect', event => {
      if (event.isMainFrame && !safeShowcaseUrl(event.url)) {
        event.preventDefault();
        fail(page, 'This redirect is not supported in Showcase.');
      }
    });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('did-start-loading', () => update(page));
    contents.on('did-stop-loading', () => update(page));
    contents.on('did-navigate', () => update(page));
    contents.on('did-navigate-in-page', () => { update(page); void syncBackground(page); });
    contents.on('page-title-updated', () => update(page));
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) fail(page, 'This page could not be loaded. Try again or open it in your browser.');
    });
    contents.on('render-process-gone', () => fail(page, 'This page stopped responding. Reload to continue.'));
    void load(page, SHOWCASE_URLS[id]);
    return page;
  }

  const hideOnNavigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (event.isMainFrame && !event.isSameDocument) { current = null; layout(); }
  };
  owner.on('did-start-navigation', hideOnNavigation);
  options.window.on('resize', layout);
  options.window.on('closed', dispose);

  const handle = (channel: string, listener: Parameters<IpcMain['handle']>[1]) => {
    try { options.ipc.handle(channel, listener); registeredChannels.push(channel); }
    catch (error) { dispose(); throw error; }
  };
  handle(SHOWCASE_CHANNELS.view, (event, value: unknown) => {
    assertOwner(event);
    current = parseShowcaseViewRequest(value);
    if (current.backgroundColor) backgroundColor = current.backgroundColor;
    const page = pages.get(current.page) ?? (current.visible ? createPage(current.page) : undefined);
    for (const entry of pages.values()) void syncBackground(entry);
    layout();
    if (page) emit(page);
  });
  handle(SHOWCASE_CHANNELS.navigate, async (event, value: unknown) => {
    assertOwner(event);
    const action = parseShowcaseAction(value);
    const page = current && pages.get(current.page);
    if (!page) return;
    const contents = page.view.webContents;
    if (action === 'external') { await external(page, page.state.url); return; }
    if (action === 'home') { await load(page, SHOWCASE_URLS[page.state.page]); return; }
    if (action === 'reload') { await load(page, safeShowcaseUrl(contents.getURL()) ?? SHOWCASE_URLS[page.state.page]); return; }
    const history = contents.navigationHistory;
    if (action === 'back' && history.canGoBack()) history.goBack();
    if (action === 'forward' && history.canGoForward()) history.goForward();
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    owner.off('did-start-navigation', hideOnNavigation);
    options.window.off('resize', layout);
    options.window.off('closed', dispose);
    for (const channel of registeredChannels) options.ipc.removeHandler(channel);
    options.session.off('will-download', denyDownload);
    for (const page of pages.values()) {
      if (!options.window.isDestroyed()) options.window.contentView.removeChildView(page.view);
      if (!page.view.webContents.isDestroyed()) page.view.webContents.close({ waitForBeforeUnload: false });
    }
    pages.clear();
  }
  return { dispose };
}
