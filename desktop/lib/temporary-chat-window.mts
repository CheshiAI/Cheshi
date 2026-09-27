import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import type { WorkspaceIpcScope } from './workspace-ipc-router.mts';
import { createWorkspaceWindowReadiness } from './workspace-window-readiness.mts';
import { chatWindowOptions } from './chat-window-options.mts';
import { createWindowAppearance, INITIAL_WINDOW_BACKGROUND_COLORS } from './window-appearance.mts';

interface Options {
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  scope: WorkspaceIpcScope;
  getParent(): BrowserWindow | null;
  preload: string;
  appearanceFile: string;
  metadata: { workspaceRoot: string; workspaceName: string; userName: string };
  registerSession(scope: WorkspaceIpcScope, window: BrowserWindow): { stop(): Promise<void> };
  onCleanupError(error: unknown): void;
  openExternal(url: string): Promise<void>;
  createAppearance?: typeof createWindowAppearance;
}

/** One independent window per workspace, with only ephemeral chat capabilities. */
export function createTemporaryChatWindow(options: Options) {
  let current: BrowserWindow | null = null;
  let opening: Promise<void> | null = null;
  let stopped = false;
  const closing = new Set<Promise<void>>();
  const publish = () => {
    const parent = options.getParent();
    if (parent && !parent.isDestroyed()) parent.webContents.send('cheshi:temporary-chat-window-changed', current !== null);
  };
  const stopSession = (stop: () => Promise<void>) => {
    const flight = Promise.resolve().then(stop);
    closing.add(flight);
    void flight.finally(() => closing.delete(flight)).catch(options.onCleanupError);
  };
  const open = async () => {
    if (stopped) throw new Error('The workspace is closing.');
    if (opening) return opening;
    if (current && !current.isDestroyed()) {
      if (current.isMinimized()) current.restore();
      current.show(); current.focus(); return;
    }
    const parent = options.getParent();
    if (!parent || parent.isDestroyed()) throw new Error('The workspace window is unavailable.');
    const scope = options.scope.fork();
    let window: BrowserWindow;
    try {
      const [, minHeight = 750] = parent.getMinimumSize();
      const minWidth = 500;
      window = options.createWindow({ ...chatWindowOptions(options.preload),
        width: minWidth, height: minHeight, minWidth, minHeight, title: 'Temporary Chat' });
    } catch (error) { scope.dispose(); throw error; }
    const lifetime = new AbortController();
    const readiness = createWorkspaceWindowReadiness({ signal: lifetime.signal });
    window.once('ready-to-show', () => readiness.browserReady());
    current = window;
    let session: ReturnType<Options['registerSession']> | undefined;
    let appearance: ReturnType<typeof createWindowAppearance> | undefined;
    const parentClosed = () => window.destroy();
    parent.once('closed', parentClosed);
    window.once('closed', () => {
      lifetime.abort();
      parent.off('closed', parentClosed);
      if (current === window) current = null;
      appearance?.dispose();
      scope.dispose();
      if (session) stopSession(() => session!.stop());
      publish();
    });
    try {
      scope.addOwner(window.webContents);
      scope.ipc.on('cheshi:get-workspace-metadata', event => { event.returnValue = options.metadata; });
      session = options.registerSession(scope, window);
      appearance = (options.createAppearance ?? createWindowAppearance)({ window, ipc: scope.ipc,
        filename: options.appearanceFile, backgrounds: INITIAL_WINDOW_BACKGROUND_COLORS });
      scope.ipc.on('cheshi:renderer-ready', (event, theme: unknown) => {
        if (event.sender !== window.webContents || (theme !== 'dark' && theme !== 'light')) return;
        readiness.rendererReady(theme);
      });
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) void options.openExternal(url).catch(options.onCleanupError);
        return { action: 'deny' };
      });
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('render-process-gone', () => { if (!window.isDestroyed()) window.destroy(); });
      window.webContents.setZoomFactor(parent.webContents.getZoomFactor());
      const url = new URL(parent.webContents.getURL());
      url.searchParams.set('temporaryChat', '1');
      url.hash = '';
      publish();
      opening = window.loadURL(url.href).then(async () => {
        readiness.loaded();
        const theme = await readiness.ready;
        if (!window.isDestroyed()) { appearance?.ready(theme); window.show(); window.focus(); }
      }).catch((error: unknown) => {
        if (!window.isDestroyed()) window.destroy();
        throw error;
      }).finally(() => { opening = null; });
      await opening;
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  };
  return {
    open,
    get hasSessions() { return current !== null || closing.size > 0; },
    get isOpen() { return current !== null; },
    async stop() {
      stopped = true;
      if (current && !current.isDestroyed()) current.destroy();
      await Promise.allSettled([...closing]);
    },
  };
}
