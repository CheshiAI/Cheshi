import type { BrowserWindowConstructorOptions } from 'electron';
import { INITIAL_WINDOW_BACKGROUND_COLORS } from './window-appearance.mts';

/** Shared native frame and isolation settings for workspace and temporary chat. */
export function chatWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    show: false,
    backgroundColor: INITIAL_WINDOW_BACKGROUND_COLORS.dark,
    transparent: process.platform === 'darwin',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 14 },
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload },
  };
}
