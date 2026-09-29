import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain, IpcMainInvokeEvent, Rectangle } from 'electron';
import { USAGE_POPOVER_CHANNEL as channel, type UsagePopoverState } from '../shared/account-usage-popover.ts';
import type { CodexAccountsSnapshot } from '../shared/codex-accounts.ts';
import { createWindowAppearance, INITIAL_WINDOW_BACKGROUND_COLORS, type WindowGlassBinding } from './window-appearance.mts';

const POPOVER_WINDOW_WIDTH = 240;

type PopoverWindow = Pick<BrowserWindow, 'isDestroyed' | 'isVisible' | 'show' | 'hide' | 'focus' | 'destroy'
  | 'setBounds' | 'loadURL' | 'on' | 'off' | 'webContents' | 'setBackgroundColor' | 'getNativeWindowHandle'>;

export interface UsagePopover {
  updateScheduler?(summary: NonNullable<UsagePopoverState['scheduler']>): void;
  update(snapshot: CodexAccountsSnapshot | null, dark: boolean): void;
  toggle(): void;
  dispose(): void;
}

export function usagePopoverBounds(anchor: Rectangle, area: Rectangle, height: number): Rectangle {
  const width = Math.min(POPOVER_WINDOW_WIDTH, area.width);
  const boundedHeight = Math.min(height, area.height);
  return {
    x: Math.round(Math.max(area.x, Math.min(anchor.x + anchor.width / 2 - width / 2, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(anchor.y + anchor.height + 4, area.y + area.height - boundedHeight))),
    width, height: boundedHeight,
  };
}

export function createAccountUsagePopover(options: {
  createWindow(options: BrowserWindowConstructorOptions): PopoverWindow;
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  getAnchor(): Rectangle;
  getWorkArea(anchor: Rectangle): Rectangle;
  rendererUrl: string;
  preload: string;
  appearanceFile: string;
  appearanceBinding?: WindowGlassBinding | null;
  showApp(): void;
  openScheduler?(): void;
  quit(): void;
  onError(error: unknown): void;
  now?: () => number;
}): UsagePopover {
  let view: PopoverWindow | null = null;
  let state: UsagePopoverState = { snapshot: null, dark: true, revision: 0, appearance: null };
  let appearance: ReturnType<typeof createWindowAppearance> | null = null;
  let disposed = false;
  let ready = false;
  let wantsOpen = false;
  let height = 180;
  let blurredAt = -Infinity;
  const now = options.now ?? Date.now;

  function assertSender(event: IpcMainInvokeEvent) {
    if (!view || view.isDestroyed() || event.sender !== view.webContents || event.senderFrame !== view.webContents.mainFrame) {
      throw new Error('Untrusted account usage popover sender.');
    }
  }
  function position() {
    if (!view || view.isDestroyed()) return;
    const anchor = options.getAnchor();
    view.setBounds(usagePopoverBounds(anchor, options.getWorkArea(anchor), height));
  }
  function hide() {
    wantsOpen = false;
    if (view && !view.isDestroyed()) view.hide();
  }
  function reveal() {
    if (!ready || !wantsOpen || !view || view.isDestroyed()) return;
    position();
    view.show();
    view.focus();
  }
  function destroy() {
    appearance?.dispose();
    appearance = null;
    const old = view;
    view = null;
    ready = false;
    wantsOpen = false;
    if (old && !old.isDestroyed()) old.destroy();
  }

  options.ipc.handle(`${channel}:read`, event => { assertSender(event); return state; });
  options.ipc.handle(`${channel}:resize`, (event, value: unknown) => {
    assertSender(event);
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10_000) {
      throw new Error('Invalid account usage popover height.');
    }
    height = Math.max(100, value);
    position();
  });
  options.ipc.handle(`${channel}:action`, (event, action: unknown) => {
    assertSender(event);
    if (action !== 'show' && action !== 'quit' && action !== 'close' && action !== 'scheduler') throw new Error('Invalid account usage popover action.');
    hide();
    if (action === 'show') options.showApp();
    if (action === 'quit') options.quit();
    if (action === 'scheduler') options.openScheduler?.();
  });

  return {
    updateScheduler(summary) {
      if (disposed) return;
      state = { ...state, scheduler: summary, revision: state.revision + 1 };
      if (view && !view.isDestroyed()) view.webContents.send(`${channel}:changed`, state);
    },
    update(snapshot, dark) {
      if (disposed) return;
      state = { ...state, snapshot, dark, revision: state.revision + 1 };
      appearance?.setTheme(dark ? 'dark' : 'light');
      if (view && !view.isDestroyed()) view.webContents.send(`${channel}:changed`, state);
    },
    toggle() {
      if (disposed) return;
      // macOS may deliver blur just before a second click on the menu-bar item.
      if (wantsOpen || now() - blurredAt < 200) { hide(); return; }
      wantsOpen = true;
      if (view && !view.isDestroyed()) { reveal(); return; }
      try {
        const window = options.createWindow({
          width: POPOVER_WINDOW_WIDTH, height, show: false, frame: false, transparent: true,
          backgroundColor: INITIAL_WINDOW_BACKGROUND_COLORS[state.dark ? 'dark' : 'light'],
          resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
          skipTaskbar: true, alwaysOnTop: true, title: 'Cheshi · Account & Usage',
          webPreferences: { preload: options.preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
        });
        view = window;
        appearance = createWindowAppearance({
          window, filename: options.appearanceFile, backgrounds: INITIAL_WINDOW_BACKGROUND_COLORS,
          binding: options.appearanceBinding,
          onChanged(value) {
            if (disposed || view !== window) return;
            state = { ...state, appearance: value, revision: state.revision + 1 };
            window.webContents.send(`${channel}:changed`, state);
          },
        });
        state = { ...state, appearance: appearance.getState(), revision: state.revision + 1 };
        window.on('ready-to-show', () => {
          if (view !== window) return;
          appearance?.ready(state.dark ? 'dark' : 'light');
          ready = true;
          reveal();
        });
        window.on('blur', () => { if (view === window) { blurredAt = now(); hide(); } });
        window.on('closed', () => {
          if (view !== window) return;
          appearance?.dispose();
          appearance = null;
          view = null; ready = false; wantsOpen = false;
        });
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', event => event.preventDefault());
        window.webContents.on('will-redirect', event => event.preventDefault());
        window.webContents.on('before-input-event', (event, input) => {
          if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); hide(); }
        });
        window.webContents.on('render-process-gone', () => { if (view === window) destroy(); });
        void window.loadURL(options.rendererUrl).catch(error => {
          if (view !== window) return;
          destroy();
          options.onError(error);
        });
      } catch (error) { destroy(); options.onError(error); }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const method of ['read', 'resize', 'action']) options.ipc.removeHandler(`${channel}:${method}`);
      destroy();
    },
  };
}
