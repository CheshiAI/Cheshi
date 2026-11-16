import { startupPage, STARTUP_FIRST_FRAME_SCRIPT } from './startup-page.mts';
import { createWindowAppearance, INITIAL_WINDOW_BACKGROUND_COLORS } from './window-appearance.mts';
import type { WindowGlassBinding } from './window-appearance.mts';
import type { WindowAppearanceState } from '../shared/window-appearance.ts';

type AppearanceWindow = Parameters<typeof createWindowAppearance>[0]['window'];

export function shouldShowStartupScreen(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.CHESHI_E2E_HEADLESS !== '1' && environment.CHESHI_WORKSPACE_WINDOW !== '1';
}

export interface StartupView extends AppearanceWindow {
  once(event: 'ready-to-show' | 'closed', listener: () => void): unknown;
  isDestroyed(): boolean;
  show(): void;
  destroy(): void;
  loadURL(url: string): Promise<void>;
}

interface StartupScreenOptions {
  name: string;
  version: string;
  appearanceFile?: string;
  appearanceBinding?: WindowGlassBinding | null;
  onCancel(): void;
}

export class StartupScreen {
  private view: StartupView | null = null;
  private settleReady: ((shown: boolean) => void) | null = null;
  private appearance: ReturnType<typeof createWindowAppearance> | null = null;

  get isOpen(): boolean {
    return this.view !== null && !this.view.isDestroyed();
  }

  async open(view: StartupView, options: StartupScreenOptions): Promise<boolean> {
    this.close();
    this.view = view;
    const ready = new Promise<boolean>((resolve) => { this.settleReady = resolve; });
    view.once('ready-to-show', () => {
      if (this.view !== view || view.isDestroyed()) return;
      this.settleReady?.(true);
    });
    view.once('closed', () => {
      if (this.view !== view) return;
      this.close();
      options.onCancel();
    });
    try {
      let pageReady = false;
      const appearance = options.appearanceFile ? createWindowAppearance({
        window: view,
        filename: options.appearanceFile,
        backgrounds: INITIAL_WINDOW_BACKGROUND_COLORS,
        binding: options.appearanceBinding,
        onChanged: state => {
          if (!pageReady || this.view !== view || view.isDestroyed()) return;
          void this.applyAppearance(view, state).catch(error => {
            if (this.view === view && !view.isDestroyed()) {
              process.stderr.write(`[cheshi] Startup appearance: ${String(error)}\n`);
            }
          });
        },
      }) : null;
      this.appearance = appearance;
      const [, shown] = await Promise.all([
        view.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupPage(options.name, options.version))}`),
        ready,
      ]);
      if (!shown || this.view !== view || view.isDestroyed()) return false;
      if (appearance) {
        appearance.ready('dark');
        pageReady = true;
        await this.applyAppearance(view, appearance.getState());
      }
      if (this.view !== view || view.isDestroyed()) return false;
      await view.webContents.executeJavaScript(STARTUP_FIRST_FRAME_SCRIPT);
      if (this.view !== view || view.isDestroyed()) return false;
      view.show();
      return true;
    } catch (error) {
      if (this.view === view) this.close();
      throw error;
    }
  }

  private async applyAppearance(view: StartupView, state: WindowAppearanceState): Promise<void> {
    await view.webContents.executeJavaScript(`
      document.documentElement.toggleAttribute('data-window-glass', ${JSON.stringify(state.active)});
      document.documentElement.style.setProperty('--window-glass-opacity', ${JSON.stringify(String(state.preferences.opacity))});
    `);
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
    this.appearance?.dispose();
    this.appearance = null;
    this.settleReady?.(false);
    this.settleReady = null;
    if (view && !view.isDestroyed()) view.destroy();
  }
}

export const startupScreen = new StartupScreen();
