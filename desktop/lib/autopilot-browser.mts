import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, Session, WebContentsView, WebContentsViewConstructorOptions } from 'electron';
import { AUTOPILOT_CHANNELS, parseAutopilotView, safeAutopilotUrl } from '../shared/autopilot.ts';
import type { AutopilotViewRequest } from '../shared/autopilot.ts';
import { createAutopilotModel } from './autopilot-model.mts';
import type { AutopilotFetch } from './autopilot-model.mts';
import { AUTOPILOT_PAGE_SCRIPT, autopilotOperation, parseAutopilotPage } from './autopilot-page.mts';
import { AutopilotPageChangedError, createAutopilotRunner } from './autopilot-runner.mts';

interface Options {
  window: BrowserWindow;
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  session: Session;
  createView(options: WebContentsViewConstructorOptions): WebContentsView;
  getKey(): string | null;
  request?: AutopilotFetch;
}

export function createAutopilotBrowser(options: Options) {
  const owner = options.window.webContents;
  let view: WebContentsView | undefined;
  let viewport: AutopilotViewRequest | null = null;
  let disposed = false;
  const channels: string[] = [];
  const cancelLoad = () => { if (view && !view.webContents.isDestroyed()) view.webContents.stop(); };
  const runner = createAutopilotRunner({
    configured: () => !!options.getKey(), cancelLoad,
    decide: input => {
      const key = options.getKey();
      if (!key) throw new Error('The TypeSafe API key is unavailable.');
      return createAutopilotModel(key, options.request)(input);
    },
    load,
    async follow(page, link, signal) {
      const current = await readPage(signal);
      assertCurrentLink(current, page.url, link.url);
      signal.throwIfAborted();
      return load(link.url, signal);
    },
    onState(state) {
      if (!disposed && !owner.isDestroyed()) owner.send(AUTOPILOT_CHANNELS.state, state);
    },
  });

  const denyDownload = (event: Electron.Event) => event.preventDefault();
  options.session.setPermissionCheckHandler(() => false);
  options.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  options.session.on('will-download', denyDownload);

  function ensureView() {
    if (view) return view;
    view = options.createView({ webPreferences: { session: options.session, sandbox: true,
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false } });
    view.setVisible(false);
    options.window.contentView.addChildView(view);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // All top-level navigation in this first beta is owned by the link runner.
    view.webContents.on('will-navigate', event => event.preventDefault());
    view.webContents.on('will-redirect', event => {
      if (!safeAutopilotUrl(event.url)) event.preventDefault();
    });
    view.webContents.on('will-attach-webview', event => event.preventDefault());
    layout();
    return view;
  }

  async function readPage(signal: AbortSignal) {
    signal.throwIfAborted();
    const contents = ensureView().webContents;
    const result: unknown = await autopilotOperation(contents.executeJavaScriptInIsolatedWorld(1002,
      [{ code: AUTOPILOT_PAGE_SCRIPT }]), signal);
    signal.throwIfAborted();
    return parseAutopilotPage(result);
  }

  async function load(url: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const contents = ensureView().webContents;
    const abort = () => { if (!contents.isDestroyed()) contents.stop(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await autopilotOperation(contents.loadURL(url), signal);
      return await readPage(signal);
    } catch {
      signal.throwIfAborted();
      contents.stop();
      throw new Error('Could not load or read this page. Check the start URL and try again.');
    } finally { signal.removeEventListener('abort', abort); }
  }

  function layout() {
    if (!view || disposed || options.window.isDestroyed()) return;
    if (!viewport?.visible) { view.setVisible(false); return; }
    const [width = 0, height = 0] = options.window.getContentSize();
    const zoom = owner.getZoomFactor();
    const bounds = viewport.bounds;
    const x = Math.max(0, Math.min(width, Math.round(bounds.x * zoom)));
    const y = Math.max(0, Math.min(height, Math.round(bounds.y * zoom)));
    const right = Math.max(x, Math.min(width, Math.round((bounds.x + bounds.width) * zoom)));
    const bottom = Math.max(y, Math.min(height, Math.round((bounds.y + bounds.height) * zoom)));
    view.setBounds({ x, y, width: right - x, height: bottom - y });
    view.setVisible(right > x && bottom > y);
  }

  function assertOwner(event: IpcMainInvokeEvent) {
    if (disposed || event.sender !== owner || event.senderFrame !== owner.mainFrame) {
      throw new Error('Autopilot is only available to its workspace window.');
    }
  }
  const hide = () => { viewport = null; runner.stop(); layout(); };
  owner.on('did-start-loading', hide);
  options.window.on('resize', layout);
  options.window.on('closed', dispose);
  const handle = (channel: string, listener: Parameters<IpcMain['handle']>[1]) => {
    try { options.ipc.handle(channel, listener); channels.push(channel); }
    catch (error) { dispose(); throw error; }
  };
  handle(AUTOPILOT_CHANNELS.get, event => { assertOwner(event); return runner.snapshot(); });
  handle(AUTOPILOT_CHANNELS.start, (event, value: unknown) => { assertOwner(event); return runner.start(value); });
  handle(AUTOPILOT_CHANNELS.stop, event => { assertOwner(event); return runner.stop(); });
  handle(AUTOPILOT_CHANNELS.view, (event, value: unknown) => {
    assertOwner(event);
    viewport = parseAutopilotView(value);
    layout();
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    runner.dispose();
    owner.off('did-start-loading', hide);
    options.window.off('resize', layout);
    options.window.off('closed', dispose);
    for (const channel of channels) options.ipc.removeHandler(channel);
    options.session.off('will-download', denyDownload);
    if (view) {
      if (!options.window.isDestroyed()) options.window.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    }
  }
  return { dispose };
}

function assertCurrentLink(page: ReturnType<typeof parseAutopilotPage>, expectedUrl: string, link: string): void {
  if (page.url !== expectedUrl || !page.links.some(candidate => candidate.url === link)) {
    throw new AutopilotPageChangedError(page);
  }
}
