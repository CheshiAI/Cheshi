import type { IpcRenderer, IpcRendererEvent } from 'electron';
import type { CheshiDesktopApi, WorkspaceFilesChangedEvent } from '../frontend/src/cheshiDesktop.ts';

const channel = 'cheshi:workspace-files-changed';
const pathLimit = 512;
type Handler = (event: WorkspaceFilesChangedEvent) => void;

function workspaceFilesChangedEvent(value: unknown): WorkspaceFilesChangedEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Workspace files changed event must be an object.');
  }
  if (!('paths' in value) || !Array.isArray(value.paths) || value.paths.length > pathLimit) {
    throw new TypeError('Workspace files changed paths must be a bounded array.');
  }
  if (!('overflow' in value) || (value.overflow !== true && value.overflow !== false)) {
    throw new TypeError('Workspace files changed overflow flag must be a boolean.');
  }
  const paths = value.paths.map((path: unknown) => {
    if (typeof path !== 'string' || !path.trim()) {
      throw new TypeError('Workspace path must be a non-empty string.');
    }
    return path;
  });
  return { paths, overflow: value.overflow };
}

/** Share the IPC subscription while any renderer consumer needs file updates. */
export function createWorkspaceFileEventsApi(
  ipc: Pick<IpcRenderer, 'on' | 'removeListener'>,
): Pick<CheshiDesktopApi, 'onWorkspaceFilesChanged'> {
  const handlers = new Set<Handler>();
  const dispatch = (_event: IpcRendererEvent, value: unknown) => {
    const event = workspaceFilesChangedEvent(value);
    // Match EventEmitter's current-delivery snapshot and keep consumer payloads separate.
    for (const handler of [...handlers]) handler({ paths: [...event.paths], overflow: event.overflow });
  };
  return {
    onWorkspaceFilesChanged(handler) {
      if (typeof handler !== 'function') throw new TypeError('Workspace files changed handler must be a function.');
      // Each call owns its registration, even when callers reuse the same function.
      const listener: Handler = event => handler(event);
      if (handlers.size === 0) ipc.on(channel, dispatch);
      handlers.add(listener);
      return () => {
        if (!handlers.delete(listener)) return;
        if (handlers.size === 0) ipc.removeListener(channel, dispatch);
      };
    },
  };
}
