import path from 'node:path';
import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from 'electron';
import { createWindowAppearance, INITIAL_WINDOW_BACKGROUND_COLORS } from './window-appearance.mts';
import type { WindowGlassBinding } from './window-appearance.mts';
import { createWindowTopHighlight } from './window-top-highlight.mts';
import type { WindowAppearanceState } from '../shared/window-appearance.ts';

export interface WorkspaceManagerWindowOptions {
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
  rendererUrl?: string;
  workspaceRoot: string;
  appearanceFile: string;
  appearanceBinding?: WindowGlassBinding | null;
  topHighlightBinding?: Parameters<typeof createWindowTopHighlight>[0]['binding'];
  onWindowCreated?: (window: BrowserWindow) => void;
  onShown?: () => void;
  readinessTimeoutMs?: number;
}

function assertManagerOpen(window: BrowserWindow): void {
  if (window.isDestroyed()) throw new Error('The workspace manager closed before it finished opening.');
}

export class WorkspaceManagerWindow {
  private readonly options: WorkspaceManagerWindowOptions;
  private window: BrowserWindow | null = null;
  private loading: Promise<void> | null = null;
  private disposed = false;
  private shown = false;
  private markContentReady: (() => void) | null = null;

  constructor(options: WorkspaceManagerWindowOptions) {
    this.options = options;
  }

  windowFor(sender: WebContents): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() && this.window.webContents === sender
      ? this.window : null;
  }

  contentReady(sender: WebContents): void {
    if (!this.windowFor(sender)) throw new Error('Workspace readiness requires the manager window.');
    this.markContentReady?.();
  }

  dispose(): void {
    this.disposed = true;
    const window = this.window;
    this.window = null;
    this.loading = null;
    this.markContentReady = null;
    this.shown = false;
    if (window && !window.isDestroyed()) window.destroy();
  }

  async open(): Promise<void> {
    if (this.disposed) throw new Error('The workspace manager has been disposed.');
    if (this.window && !this.window.isDestroyed()) {
      if (this.shown) {
        if (this.window.isMinimized()) this.window.restore();
        this.window.focus();
      }
      return this.loading ?? undefined;
    }
    const options = this.options;
    const runtimeRoot = options.isPackaged ? options.resourcesPath : path.join(options.appPath, 'desktop');
    const window = options.createWindow({
      show: false, width: 800, height: 650, minWidth: 600, maxWidth: 800, minHeight: 650, maxHeight: 650,
      title: 'Cheshi Workspaces', backgroundColor: INITIAL_WINDOW_BACKGROUND_COLORS.dark,
      transparent: process.platform === 'darwin',
      frame: false,
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        preload: path.join(runtimeRoot, 'runtime', 'workspace-manager-preload.cjs'),
        additionalArguments: [
          `--cheshi-manager-root=${encodeURIComponent(options.workspaceRoot)}`,
          `--cheshi-manager-name=${encodeURIComponent(path.basename(options.workspaceRoot) || 'Workspace')}`,
        ],
      },
    });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    this.shown = false;
    let nativeReady = false;
    let contentReady = false;
    let loaded = false;
    let settled = false;
    let revealing = false;
    let appearanceReady = false;
    let appearance: ReturnType<typeof createWindowAppearance> | undefined;
    let resolveOpening!: () => void;
    let rejectOpening!: (error: unknown) => void;
    const opening = new Promise<void>((resolve, reject) => {
      resolveOpening = resolve;
      rejectOpening = reject;
    });
    this.loading = opening;
    const complete = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      window.off('ready-to-show', onNativeReady);
      if (this.window === window) {
        this.loading = null;
        this.markContentReady = null;
      }
      if (error === undefined) resolveOpening();
      else rejectOpening(error);
    };
    const fail = (error: unknown) => {
      complete(error);
      if (!window.isDestroyed()) window.destroy();
    };
    const reveal = async () => {
      try {
        assertManagerOpen(window);
        appearance?.ready('dark');
        appearanceReady = true;
        if (appearance) await this.applyAppearance(window, appearance.getState());
        if (settled) return;
        assertManagerOpen(window);
        window.show();
        assertManagerOpen(window);
        this.shown = true;
        options.onShown?.();
        complete();
      } catch (error) { fail(error); }
    };
    const showWhenReady = () => {
      if (settled || revealing || !nativeReady || !contentReady || !loaded) return;
      revealing = true;
      void reveal();
    };
    const onNativeReady = () => { nativeReady = true; showWhenReady(); };
    const timeout = setTimeout(() => {
      fail(new Error('The workspace manager did not finish its startup checks in time.'));
    }, options.readinessTimeoutMs ?? 45_000);
    this.markContentReady = () => { contentReady = true; showWhenReady(); };
    window.once('ready-to-show', onNativeReady);
    window.once('closed', () => {
      complete(new Error('The workspace manager closed before it finished opening.'));
      if (this.window === window) {
        this.window = null;
        this.loading = null;
        this.markContentReady = null;
        this.shown = false;
      }
    });
    try {
      options.onWindowCreated?.(window);
      assertManagerOpen(window);
      createWindowTopHighlight({ window, binding: options.topHighlightBinding,
        onError: error => process.stderr.write(`[cheshi] Workspaces top highlight: ${String(error)}\n`),
      });
      appearance = createWindowAppearance({
        window, filename: options.appearanceFile, backgrounds: INITIAL_WINDOW_BACKGROUND_COLORS,
        binding: options.appearanceBinding,
        onChanged: state => {
          if (!appearanceReady || window.isDestroyed()) return;
          void this.applyAppearance(window, state).catch(error => {
            if (!window.isDestroyed()) process.stderr.write(`[cheshi] Workspaces appearance: ${String(error)}\n`);
          });
        },
      });
      const load = options.rendererUrl
        ? window.loadURL(options.rendererUrl)
        : window.loadFile(path.join(options.isPackaged ? options.resourcesPath : path.join(options.appPath, 'desktop', 'frontend'), 'dist', 'index.html'));
      void load.then(() => { loaded = true; showWhenReady(); }, fail);
    } catch (error) { fail(error); }
    return opening;
  }

  private async applyAppearance(window: BrowserWindow, state: WindowAppearanceState): Promise<void> {
    await window.webContents.executeJavaScript(`
      document.documentElement.toggleAttribute('data-window-glass', ${JSON.stringify(state.active)});
      document.documentElement.style.setProperty('--window-glass-opacity', ${JSON.stringify(String(state.preferences.opacity))});
    `);
  }
}
