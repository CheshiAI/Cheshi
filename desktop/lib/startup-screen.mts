import { startupPage } from './startup-page.mts';

export function shouldShowStartupScreen(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.CHESHI_E2E_HEADLESS !== '1' && environment.CHESHI_WORKSPACE_WINDOW !== '1';
}

export interface StartupView {
  once(event: 'ready-to-show' | 'closed', listener: () => void): unknown;
  isDestroyed(): boolean;
  show(): void;
  destroy(): void;
  loadURL(url: string): Promise<void>;
  webContents: { executeJavaScript(script: string): Promise<unknown> };
}

interface StartupScreenOptions {
  name: string;
  version: string;
  onCancel(): void;
}

export class StartupScreen {
  private view: StartupView | null = null;
  private settleReady: ((shown: boolean) => void) | null = null;

  get isOpen(): boolean {
    return this.view !== null && !this.view.isDestroyed();
  }

  async open(view: StartupView, options: StartupScreenOptions): Promise<boolean> {
    this.close();
    this.view = view;
    const ready = new Promise<boolean>((resolve) => { this.settleReady = resolve; });
    view.once('ready-to-show', () => {
      if (this.view !== view || view.isDestroyed()) return;
      view.show();
      this.settleReady?.(true);
    });
    view.once('closed', () => {
      if (this.view !== view) return;
      this.close();
      options.onCancel();
    });
    try {
      await view.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupPage(options.name, options.version))}`);
      return await ready;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async setStatus(message: string): Promise<void> {
    const view = this.view;
    if (!view || view.isDestroyed()) return;
    try {
      await view.webContents.executeJavaScript(
        `document.getElementById('status').textContent = ${JSON.stringify(message)}`,
      );
    } catch (error) {
      if (this.view === view && !view.isDestroyed()) {
        process.stderr.write(`[cheshi] Startup status: ${String(error)}\n`);
      }
    }
  }

  close(): void {
    const view = this.view;
    this.view = null;
    this.settleReady?.(false);
    this.settleReady = null;
    if (view && !view.isDestroyed()) view.destroy();
  }
}

export const startupScreen = new StartupScreen();
