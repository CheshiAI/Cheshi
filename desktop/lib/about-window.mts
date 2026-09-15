import type { BrowserWindowConstructorOptions } from 'electron';

export const ABOUT_CHANGELOG_URL = 'https://github.com/CheshiAI/Cheshi/blob/main/CHANGELOG.md';

interface PreventableEvent { preventDefault(): void }
interface KeyboardInput {
  type: string;
  key: string;
  meta: boolean;
  control: boolean;
}

export interface AboutView {
  once(event: 'ready-to-show' | 'closed', listener: () => void): unknown;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  close(): void;
  destroy(): void;
  loadURL(url: string): Promise<void>;
  webContents: {
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
    on(event: 'will-navigate', listener: (event: PreventableEvent, url: string) => void): unknown;
    on(event: 'before-input-event', listener: (event: PreventableEvent, input: KeyboardInput) => void): unknown;
  };
}

interface AboutWindowOptions {
  title: string;
  backgroundColor: string;
  createWindow(options: BrowserWindowConstructorOptions): AboutView;
  page(): string;
  openExternal(url: string): Promise<void>;
  onError(error: unknown): void;
}

export function createAboutWindow(options: AboutWindowOptions) {
  let view: AboutView | null = null;
  let ready = false;
  let disposed = false;

  async function openChangelog(url: string): Promise<void> {
    if (url !== ABOUT_CHANGELOG_URL) return;
    try { await options.openExternal(ABOUT_CHANGELOG_URL); }
    catch (error) { options.onError(error); }
  }

  function destroy(window: AboutView): void {
    if (view === window) {
      view = null;
      ready = false;
    }
    if (!window.isDestroyed()) {
      try { window.destroy(); } catch (error) { options.onError(error); }
    }
  }

  function close(): void {
    const window = view;
    if (!window) return;
    try {
      if (!window.isDestroyed()) window.close();
    } catch (error) {
      options.onError(error);
    } finally {
      destroy(window);
    }
  }

  function reveal(window: AboutView): void {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  function open(): void {
    if (disposed) return;
    if (view && !view.isDestroyed()) {
      if (ready) reveal(view);
      return;
    }
    let window: AboutView | null = null;
    try {
      window = options.createWindow({
        width: 320,
        height: 440,
        title: options.title,
        titleBarStyle: 'hiddenInset',
        backgroundColor: options.backgroundColor,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        show: false,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      const opened = window;
      view = opened;
      ready = false;
      opened.once('closed', () => {
        if (view === opened) {
          view = null;
          ready = false;
        }
      });
      opened.once('ready-to-show', () => {
        if (view !== opened || opened.isDestroyed()) return;
        ready = true;
        reveal(opened);
      });
      opened.webContents.setWindowOpenHandler(({ url }) => {
        void openChangelog(url);
        return { action: 'deny' };
      });
      opened.webContents.on('will-navigate', (event, url) => {
        event.preventDefault();
        void openChangelog(url);
      });
      opened.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        if (input.key === 'Escape' || (input.key.toLowerCase() === 'w' && (input.meta || input.control))) {
          event.preventDefault();
          if (view === opened) close();
        }
      });
      void opened.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(options.page())}`).catch((error: unknown) => {
        if (view !== opened || opened.isDestroyed()) return;
        destroy(opened);
        options.onError(error);
      });
    } catch (error) {
      if (window) destroy(window);
      options.onError(error);
    }
  }

  return {
    open,
    close,
    dispose(): void {
      disposed = true;
      close();
    },
  };
}
