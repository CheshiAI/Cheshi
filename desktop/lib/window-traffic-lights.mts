import { createRequire } from 'node:module';
import type { BrowserWindow } from 'electron';

interface TrafficLightBinding {
  setWindowTrafficLightScale(handle: Buffer, scale: number): boolean;
}

function loadBinding(): TrafficLightBinding | null {
  if (process.platform !== 'darwin') return null;
  try {
    const binding = createRequire(import.meta.url)('./electron-libghostty/native/cheshi_ghostty.node') as Partial<TrafficLightBinding>;
    return typeof binding.setWindowTrafficLightScale === 'function' ? binding as TrafficLightBinding : null;
  } catch { return null; }
}

const LAYOUT_EVENTS = ['ready-to-show', 'show', 'resize', 'maximize', 'unmaximize', 'restore',
  'focus', 'enter-full-screen', 'leave-full-screen'] as const;

/** Keep the native buttons and their actions, scaling their geometry to 80%. */
export function createWindowTrafficLights(options: {
  window: Pick<BrowserWindow, 'isDestroyed' | 'getNativeWindowHandle'> & {
    on(event: string, listener: () => void): unknown;
    off(event: string, listener: () => void): unknown;
  };
  binding?: TrafficLightBinding | null;
  onError(error: unknown): void;
}) {
  const { window } = options;
  const binding = options.binding === undefined ? loadBinding() : options.binding;
  let disposed = false;
  let pending: ReturnType<typeof setImmediate> | undefined;
  const apply = (scale: number) => {
    if (!binding || window.isDestroyed()) return;
    try { binding.setWindowTrafficLightScale(window.getNativeWindowHandle(), scale); }
    catch (error) { options.onError(error); }
  };
  const refresh = () => {
    if (disposed || pending !== undefined) return;
    // Electron finishes laying out native buttons after emitting window events.
    pending = setImmediate(() => {
      pending = undefined;
      if (!disposed) apply(0.8);
    });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (pending !== undefined) clearImmediate(pending);
    for (const event of LAYOUT_EVENTS) window.off(event, refresh);
    window.off('closed', dispose);
    apply(1);
  };
  if (binding) {
    for (const event of LAYOUT_EVENTS) window.on(event, refresh);
    window.on('closed', dispose);
    apply(0.8);
  }
  return { dispose };
}
