import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';

type ScopedIpc = Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'off'>;
type InvokeHandler = Parameters<IpcMain['handle']>[1];
type EventListener = Parameters<IpcMain['on']>[1];

export interface WorkspaceIpcScope {
  ipc: ScopedIpc;
  addOwner(webContents: WebContents, managementOnly?: boolean): void;
  dispose(): void;
}

interface ScopeState {
  handlers: Map<string, InvokeHandler>;
  listeners: Map<string, EventListener[]>;
  owners: Map<WebContents, () => void>;
  disposed: boolean;
}

interface Owner {
  scope: ScopeState;
  managementOnly: boolean;
}

const managementPrefix = 'cheshi:workspace-management:';

/** Multiplexes shared Electron channels without sharing workspace capabilities. */
export class WorkspaceIpcRouter {
  private readonly ipcMain: ScopedIpc;
  private readonly owners = new Map<WebContents, Owner>();
  private readonly scopes = new Set<ScopeState>();
  private readonly invokeRoutes = new Set<string>();
  private readonly eventRoutes = new Map<string, EventListener>();

  constructor(ipcMain: ScopedIpc) {
    this.ipcMain = ipcMain;
  }

  createScope(): WorkspaceIpcScope {
    const scope: ScopeState = {
      handlers: new Map(), listeners: new Map(), owners: new Map(), disposed: false,
    };
    this.scopes.add(scope);
    // Electron types on/off as returning the entire emitter. The adapter exposes
    // only these four methods at runtime, including through method chaining.
    const ipc: ScopedIpc = {
      handle: (channel, handler) => {
        this.assertActive(scope);
        if (scope.handlers.has(channel)) throw new Error(`Workspace IPC handler already registered: ${channel}`);
        this.ensureInvokeRoute(channel);
        scope.handlers.set(channel, handler);
      },
      removeHandler: (channel) => {
        scope.handlers.delete(channel);
        this.releaseRoutes(channel);
      },
      on: (channel, listener) => {
        this.assertActive(scope);
        this.ensureEventRoute(channel);
        const listeners = scope.listeners.get(channel) ?? [];
        listeners.push(listener);
        scope.listeners.set(channel, listeners);
        return ipc as IpcMain;
      },
      off: (channel, listener) => {
        const listeners = scope.listeners.get(channel);
        const index = listeners?.lastIndexOf(listener) ?? -1;
        if (listeners && index >= 0) listeners.splice(index, 1);
        if (listeners?.length === 0) scope.listeners.delete(channel);
        this.releaseRoutes(channel);
        return ipc as IpcMain;
      },
    };
    return {
      ipc,
      addOwner: (webContents, managementOnly: unknown = false) => {
        this.assertActive(scope);
        if (webContents.isDestroyed()) throw new Error('Cannot register a destroyed workspace IPC owner.');
        const restrictToManagement = managementOnly === true;
        const existing = this.owners.get(webContents);
        if (existing) {
          if (existing.scope !== scope || existing.managementOnly !== restrictToManagement) {
            throw new Error('Workspace IPC owner already registered with different capabilities.');
          }
          return;
        }
        const cleanup = () => {
          this.owners.delete(webContents);
          scope.owners.delete(webContents);
        };
        this.owners.set(webContents, { scope, managementOnly: restrictToManagement });
        scope.owners.set(webContents, cleanup);
        webContents.once('destroyed', cleanup);
      },
      dispose: () => {
        if (scope.disposed) return;
        scope.disposed = true;
        for (const [webContents, cleanup] of scope.owners) {
          webContents.off('destroyed', cleanup);
          this.owners.delete(webContents);
        }
        scope.owners.clear();
        const channels = new Set([...scope.handlers.keys(), ...scope.listeners.keys()]);
        scope.handlers.clear();
        scope.listeners.clear();
        this.scopes.delete(scope);
        for (const channel of channels) this.releaseRoutes(channel);
      },
    };
  }

  private assertActive(scope: ScopeState): void {
    if (scope.disposed) throw new Error('Workspace IPC scope is disposed.');
  }

  private scopeFor(channel: string, event: IpcMainEvent | IpcMainInvokeEvent): ScopeState | null {
    const owner = this.owners.get(event.sender);
    if (!owner || owner.scope.disposed || event.sender.isDestroyed()
      || !event.senderFrame || event.senderFrame !== event.sender.mainFrame
      || (owner.managementOnly && !channel.startsWith(managementPrefix))) return null;
    return owner.scope;
  }

  private ensureInvokeRoute(channel: string): void {
    if (this.invokeRoutes.has(channel)) return;
    this.ipcMain.handle(channel, (event, ...arguments_) => {
      const handler = this.scopeFor(channel, event)?.handlers.get(channel);
      if (!handler) throw new Error('Workspace IPC sender is not authorized.');
      return handler(event, ...arguments_);
    });
    this.invokeRoutes.add(channel);
  }

  private ensureEventRoute(channel: string): void {
    if (this.eventRoutes.has(channel)) return;
    const route: EventListener = (event, ...arguments_) => {
      const listeners = this.scopeFor(channel, event)?.listeners.get(channel);
      if (!listeners?.length) {
        event.returnValue = null;
        return;
      }
      for (const listener of [...listeners]) listener(event, ...arguments_);
    };
    this.ipcMain.on(channel, route);
    this.eventRoutes.set(channel, route);
  }

  private releaseRoutes(channel: string): void {
    if (this.invokeRoutes.has(channel) && ![...this.scopes].some((scope) => scope.handlers.has(channel))) {
      this.ipcMain.removeHandler(channel);
      this.invokeRoutes.delete(channel);
    }
    const route = this.eventRoutes.get(channel);
    if (route && ![...this.scopes].some((scope) => scope.listeners.has(channel))) {
      this.ipcMain.off(channel, route);
      this.eventRoutes.delete(channel);
    }
  }
}
