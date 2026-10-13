import { createRequire } from 'node:module';
import type { BrowserWindow } from 'electron';

interface TopHighlightBinding {
  setWindowTopHighlightHidden(handle: Buffer, hidden: boolean): boolean;
}

function loadBinding(): TopHighlightBinding | null {
  if (process.platform !== 'darwin') return null;
  try {
    const binding = createRequire(import.meta.url)('./electron-libghostty/native/cheshi_ghostty.node') as Partial<TopHighlightBinding>;
    return typeof binding.setWindowTopHighlightHidden === 'function' ? binding as TopHighlightBinding : null;
  } catch { return null; }
}

const LAYOUT_EVENTS = ['ready-to-show', 'show', 'resize', 'focus', 'enter-full-screen', 'leave-full-screen'] as const;

/** Suppress only the workspace's native top highlight, retaining its frame and buttons. */
export function createWindowTopHighlight(options: {
  window: Pick<BrowserWindow, 'isDestroyed' | 'getNativeWindowHandle'> & {
    on(event: string, listener: () => void): unknown;
    off(event: string, listener: () => void): unknown;
  };
  binding?: TopHighlightBinding | null;
  onError(error: unknown): void;
}) {
  const { window } = options;
  const binding = options.binding === undefined ? loadBinding() : options.binding;
  let disposed = false;
  let pending: ReturnType<typeof setImmediate> | undefined;
  const apply = (hidden: boolean) => {
    if (!binding || window.isDestroyed()) return;
    try { binding.setWindowTopHighlightHidden(window.getNativeWindowHandle(), hidden); }
    catch (error) { options.onError(error); }
  };
  const refresh = () => {
    if (disposed || pending !== undefined) return;
    // AppKit may recreate its decoration while Electron is laying out the window.
    pending = setImmediate(() => { pending = undefined; if (!disposed) apply(true); });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (pending !== undefined) clearImmediate(pending);
    for (const event of LAYOUT_EVENTS) window.off(event, refresh);
    window.off('closed', dispose);
    apply(false);
  };
  if (binding) {
    for (const event of LAYOUT_EVENTS) window.on(event, refresh);
    window.on('closed', dispose);
    apply(true);
  }
  return { dispose };
}
