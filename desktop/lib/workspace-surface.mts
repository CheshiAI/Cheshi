import { EventEmitter } from 'node:events';
import type { BrowserWindow, Rectangle, WebContentsView } from 'electron';

const surfaces = new WeakMap<object, WorkspaceSurface>();
export function sameWorkspaceBounds(left: Rectangle, right: Rectangle): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
export function workspaceNativeFrame<T extends Rectangle>(owner: object, frame: T): T {
  return surfaces.get(owner)?.offsetFrame(frame) ?? frame;
}

/** Native Electron APIs require the actual host, not the workspace's lifecycle handle. */
export function nativeWorkspaceWindow(window: BrowserWindow): BrowserWindow {
  return surfaces.get(window)?.host ?? window;
}
export function workspaceSurface(window: BrowserWindow): WorkspaceSurface | undefined { return surfaces.get(window); }

/**
 * Adapts the existing workspace window contract to a retained WebContentsView.
 * Renderer identity and close events belong to the surface. Geometry/native
 * decorations belong to its host. No renderer is reloaded on activation.
 */
export class WorkspaceSurface {
  readonly window: BrowserWindow;
  readonly host: BrowserWindow;
  readonly view: WebContentsView;
  private readonly events = new EventEmitter();
  private readonly cleanup: Array<() => void> = [];
  private active = false;
  private destroyed = false;
  private closing: Promise<boolean> | null = null;
  private frame: Rectangle | null = null;
  confirmClose?: () => boolean;

  constructor(options: { host: BrowserWindow; view: WebContentsView; activate(): void; closed(): void }) {
    this.host = options.host;
    this.view = options.view;
    const host = this.host, contents = this.view.webContents;
    const methods: Record<string, unknown> = {
      webContents: contents,
      id: contents.id,
      contentView: this.view,
      isDestroyed: () => this.destroyed,
      isVisible: () => this.active && host.isVisible(),
      isFocused: () => this.active && host.isFocused(),
      show: () => { options.activate(); host.show(); },
      focus: () => { options.activate(); host.focus(); contents.focus(); },
      hide: () => this.setActive(false),
      close: () => { void this.requestClose().catch(error => process.stderr.write(`[cheshi] Workspace close: ${String(error)}\n`)); },
      destroy: () => contents.close({ waitForBeforeUnload: false }),
      loadURL: contents.loadURL.bind(contents),
      loadFile: contents.loadFile.bind(contents),
      setBackgroundColor: (color: string) => {
        this.view.setBackgroundColor(color);
        if (this.active) host.setBackgroundColor(color);
      },
    };
    for (const method of ['on', 'once', 'off', 'addListener', 'removeListener'] as const) {
      methods[method] = (event: string, listener: (...args: unknown[]) => void) => {
        this.events[method](event, listener); return this.window;
      };
    }
    // One compatibility boundary keeps existing workspace services bound to their
    // own contents. Never pass this handle directly to a native dialog/parent API.
    this.window = new Proxy(host, { get: (target, key) => {
      if (typeof key === 'string' && key in methods) return methods[key];
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    surfaces.set(this.window, this);
    for (const event of ['show', 'hide', 'focus', 'blur', 'minimize', 'restore', 'resize', 'move', 'maximize', 'unmaximize'] as const) {
      const listener = () => { if (this.active) this.events.emit(event); };
      const emitter: EventEmitter = host;
      emitter.on(event, listener);
      this.cleanup.push(() => emitter.off(event, listener));
    }
    contents.once('did-finish-load', () => this.events.emit('ready-to-show'));
    contents.once('destroyed', () => {
      this.destroyed = true;
      for (const dispose of this.cleanup) dispose();
      if (!host.isDestroyed()) host.contentView.removeChildView(this.view);
      this.events.emit('closed');
      this.events.removeAllListeners();
      options.closed();
    });
  }

  setActive(active: boolean, focus = true): void {
    if (this.destroyed || active === this.active) return;
    this.active = active;
    this.view.setVisible(active);
    this.events.emit(active ? 'show' : 'hide');
    this.events.emit(active ? 'focus' : 'blur');
    if (active && focus) this.view.webContents.focus();
  }

  requestClose(): Promise<boolean> {
    if (this.destroyed) return Promise.resolve(true);
    if (this.closing) return this.closing;
    this.closing = this.closeChecked().finally(() => { this.closing = null; });
    return this.closing;
  }

  private async closeChecked(): Promise<boolean> {
    const contents = this.view.webContents;
    // WebContentsView does not honor will-prevent-unload the way BrowserWindow
    // does. Ask the existing editor guards before destroying this view.
    const blocked = await contents.executeJavaScript(`(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    })()`);
    if (blocked === true && this.confirmClose?.() !== true) return false;
    if (this.destroyed) return true;
    await new Promise<void>(resolve => {
      contents.once('destroyed', () => resolve());
      contents.close({ waitForBeforeUnload: false });
    });
    return true;
  }

  setBounds(frame: Rectangle): void {
    if (this.destroyed || (this.frame && sameWorkspaceBounds(this.frame, frame))) return;
    this.view.setBounds(frame);
    this.frame = { ...frame };
    this.events.emit('resize');
  }

  offsetFrame<T extends Rectangle>(frame: T): T {
    const offset = this.view.getBounds();
    return { ...frame, x: frame.x + offset.x, y: frame.y + offset.y };
  }
}
