interface RendererFrame {
  isDestroyed(): boolean;
  readonly detached: boolean;
  send(channel: string, ...args: unknown[]): void;
}

interface RendererWindow {
  isDestroyed(): boolean;
  readonly webContents: {
    isDestroyed(): boolean;
    readonly mainFrame: RendererFrame;
  };
}

/** Each workspace owns its delivery gate; closing one must not mute another. */
export function createWorkspaceRendererEvents() {
  let stopped = false;
  return {
    stop() { stopped = true; },
    send(window: RendererWindow | null, channel: string, ...args: unknown[]): void {
      if (stopped || !window || window.isDestroyed()) return;
      const contents = window.webContents;
      if (contents.isDestroyed()) return;
      const frame = contents.mainFrame;
      // BrowserWindow can outlive its renderer during unload or workspace replacement.
      if (frame.isDestroyed() || frame.detached) return;
      frame.send(channel, ...args);
    },
  };
}
