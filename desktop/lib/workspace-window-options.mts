import type { BrowserWindowConstructorOptions } from 'electron';
import { chatWindowOptions } from './chat-window-options.mts';

export function workspaceWindowOptions(preload: string, title: string): BrowserWindowConstructorOptions {
  return {
    ...chatWindowOptions(preload),
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 750,
    title,
    fullscreenable: process.platform !== 'darwin',
  };
}
