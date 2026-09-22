import { createRequire } from 'node:module';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { APPEARANCE_CHANNELS, DEFAULT_WINDOW_APPEARANCE } from '../shared/window-appearance.ts';
import type { WindowAppearanceState } from '../shared/window-appearance.ts';
import { windowAppearanceStore } from './window-appearance-store.mts';

export const INITIAL_WINDOW_BACKGROUND_COLORS = Object.freeze({
  dark: '#000000',
  light: '#d7e6ed',
});

export interface WindowGlassBinding {
  windowGlassSupported(): boolean;
  setWindowGlass(handle: Buffer, enabled: boolean, radius: number): 'active' | 'disabled' | 'unsupported' | 'reduced-transparency';
}

function loadWindowGlass(): WindowGlassBinding | null {
  if (process.platform !== 'darwin') return null;
  try {
    const binding = createRequire(import.meta.url)('./electron-libghostty/native/cheshi_ghostty.node') as WindowGlassBinding;
    return binding.windowGlassSupported() === true ? binding : null;
  } catch { return null; }
}

export function createWindowAppearance(options: {
  window: BrowserWindow;
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  filename: string;
  backgrounds: Record<'dark' | 'light', string>;
  binding?: WindowGlassBinding | null;
}) {
  const { window, ipc } = options;
  const binding = options.binding === undefined ? loadWindowGlass() : options.binding;
  const store = windowAppearanceStore(options.filename);
  let ready = false, disposed = false;
  let theme: 'dark' | 'light' = 'dark';
  let nativeKey: string | null = null;
  let state: WindowAppearanceState = {
    preferences: { ...DEFAULT_WINDOW_APPEARANCE }, supported: binding !== null, active: false, error: null,
  };
  const publish = () => {
    if (!disposed && !window.webContents.isDestroyed()) window.webContents.send(APPEARANCE_CHANNELS.changed, state);
  };
  const apply = (force = false) => {
    if (disposed || window.isDestroyed()) return;
    const previousState = state;
    const previous = JSON.stringify(state);
    state = { ...state, active: false, error: null };
    try { state.preferences = store.read(); }
    catch (error) {
      state.preferences = { ...DEFAULT_WINDOW_APPEARANCE, enabled: false };
      state.error = (error as Error).message;
    }
    const enabled = ready && theme === 'dark' && state.preferences.enabled;
    const nextNativeKey = `${enabled}:${state.preferences.blurRadius}:${theme}`;
    if (!force && nativeKey === nextNativeKey) {
      state.active = previousState.active;
      state.error ??= previousState.error;
      if (JSON.stringify(state) !== previous) publish();
      return;
    }
    nativeKey = nextNativeKey;
    window.setBackgroundColor(options.backgrounds[theme]);
    if (binding) {
      try {
        if (enabled) window.setBackgroundColor('#00000000');
        const result = binding.setWindowGlass(window.getNativeWindowHandle(), enabled, state.preferences.blurRadius);
        state.active = result === 'active';
        if (result === 'reduced-transparency') state.error = 'Transparency is reduced in macOS accessibility settings.';
        if (result === 'unsupported') state.error = 'Native window transparency is unavailable.';
      } catch {
        // Undo both the compositor effect and Chromium background on native failure.
        try { binding.setWindowGlass(window.getNativeWindowHandle(), false, 0); } catch { /* Keep the opaque fallback. */ }
        state.error = 'Could not apply native window transparency.';
      }
    }
    if (!state.active) window.setBackgroundColor(options.backgrounds[theme]);
    if (JSON.stringify(state) !== previous) publish();
  };
  const assertOwner = (event: IpcMainInvokeEvent) => {
    if (disposed || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Appearance settings are only available to their workspace window.');
    }
  };
  ipc.handle(APPEARANCE_CHANNELS.get, event => { assertOwner(event); return state; });
  ipc.handle(APPEARANCE_CHANNELS.set, (event, value: unknown) => {
    assertOwner(event);
    store.save(value);
    return state;
  });
  const unsubscribe = store.subscribe(apply);
  const refreshAccessibility = () => apply(true);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    window.off('focus', refreshAccessibility);
    window.off('closed', dispose);
    ipc.removeHandler(APPEARANCE_CHANNELS.get);
    ipc.removeHandler(APPEARANCE_CHANNELS.set);
  };
  window.on('focus', refreshAccessibility);
  window.on('closed', dispose);
  apply();
  return {
    ready(value: 'dark' | 'light') { theme = value; ready = true; apply(); },
    setTheme(value: 'dark' | 'light') { if (theme !== value) { theme = value; apply(); } },
    dispose,
  };
}
