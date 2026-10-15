import { BrowserWindow, WebContentsView, app, dialog } from 'electron';
import type { BrowserWindowConstructorOptions, Rectangle } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceProjectColors } from '../../config/workspace-project-colors.mts';
import { resolveCodeGraphDataRoot } from '../../config/workspace-storage.mts';
import { WORKSPACE_HOST_CHANNEL as channel } from '../shared/workspace-host.ts';
import type { WorkspaceHostEntry, WorkspaceHostLayout, WorkspaceHostState, WorkspaceRailOverlay } from '../shared/workspace-host.ts';
import type { WorkspaceIpcScope } from './workspace-ipc-router.mts';
import { sameWorkspaceBounds, WorkspaceSurface } from './workspace-surface.mts';
import { WorkspaceRailOverlayLayer } from './workspace-rail-overlay.mts';
import { workspaceWindowOptions } from './workspace-window-options.mts';
import { closeWorkspaceWindow } from './workspace-application.mts';
import { createWindowTrafficLights } from './window-traffic-lights.mts';
import { createWindowTopHighlight } from './window-top-highlight.mts';
import { createWindowAppearance, INITIAL_WINDOW_BACKGROUND_COLORS } from './window-appearance.mts';

interface HostedWorkspace { surface: WorkspaceSurface; state: WorkspaceHostEntry; }
const navigationViews = new Set(['explorer', 'chat', 'chats', 'notes', 'git', 'terminal', 'calendar', 'voice', 'docker', 'plugins', 'settings', 'editor', 'search']);

/** One native window and fixed navigation shell, with isolated retained renderers. */
export class WorkspaceHost {
  readonly window: BrowserWindow;
  private readonly entries = new Map<number, HostedWorkspace>();
  private activeId: number | null = null;
  private frame: Rectangle = { x: 76, y: 36, width: 1364, height: 864 };
  private insets = { right: 0, bottom: 0 };
  private closing = false;
  private readonly railOverlay: WorkspaceRailOverlayLayer;

  private readonly activated: (root: string) => void;

  constructor(scope: WorkspaceIpcScope, configure?: (window: BrowserWindow, scope: WorkspaceIpcScope) => void, activated: (root: string) => void = () => {}) {
    this.activated = activated;
    const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const preload = app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'workspace-host-preload.cjs')
      : path.join(desktop, 'runtime', 'workspace-host-preload.cjs');
    this.window = new BrowserWindow(workspaceWindowOptions(preload, 'Cheshi'));
    const window = this.window;
    this.railOverlay = new WorkspaceRailOverlayLayer(window, region => this.updateRailBlur(region));
    scope.ipc.on(`${channel}:rail-overlay`, (event, value: unknown) => {
      if (event.sender === window.webContents) this.railOverlay.update(value, this.frame.x);
    });
    scope.addOwner(window.webContents);
    configure?.(window, scope);
    const onError = (error: unknown) => process.stderr.write(`[cheshi] Workspace window decoration: ${String(error)}\n`);
    createWindowTrafficLights({ window, onError });
    createWindowTopHighlight({ window, onError });
    // Resize the native child in the same event as its host. Renderer IPC can
    // wait until AppKit's nested zoom loop finishes, exposing an empty stage.
    window.on('resize', () => this.resizeActiveSurface());
    const appearance = createWindowAppearance({ window, ipc: scope.ipc,
      filename: path.join(app.getPath('userData'), 'appearance.json'), backgrounds: INITIAL_WINDOW_BACKGROUND_COLORS });
    appearance.ready('dark');
    scope.ipc.handle(`${channel}:state`, () => this.snapshot());
    scope.ipc.handle(`${channel}:activate`, (_event, id: unknown) => {
      this.activate(this.entry(id), false);
      // Showing a native child view may transfer native focus even without an
      // explicit contents.focus(). Keep consecutive header key presses here.
      window.webContents.focus();
    });
    scope.ipc.handle(`${channel}:close`, async (_event, id: unknown) => {
      await closeWorkspaceWindow(this.entry(id).surface.window);
    });
    scope.ipc.handle(`${channel}:command`, (_event, input: unknown) => {
      if (!input || typeof input !== 'object') throw new Error('Invalid workspace action.');
      const command = input as { action?: unknown; view?: unknown };
      if (command.action !== 'manager' && command.action !== 'sidebar'
        && !(command.action === 'navigate' && typeof command.view === 'string' && navigationViews.has(command.view))) {
        throw new Error('Invalid workspace action.');
      }
      if (this.activeId !== null) this.entry(this.activeId).surface.view.webContents.send(`${channel}:command`, input);
    });
    scope.ipc.handle(`${channel}:layout`, (_event, input: unknown) => {
      if (!input || typeof input !== 'object') throw new Error('Invalid workspace bounds.');
      const value = input as WorkspaceHostLayout;
      if (![value.x, value.y, value.width, value.height].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
        throw new Error('Invalid workspace bounds.');
      }
      const bounds = window.getContentBounds();
      const zoom = window.webContents.getZoomFactor();
      if (value.viewport !== undefined) {
        const viewport = value.viewport;
        if (!viewport || ![viewport.width, viewport.height].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)) {
          throw new Error('Invalid workspace viewport.');
        }
        // Do not replay geometry queued at an earlier animation frame. CSS
        // viewport dimensions can differ by one DIP due to zoom rounding.
        if (Math.abs(viewport.width * zoom - bounds.width) > 1
          || Math.abs(viewport.height * zoom - bounds.height) > 1) return;
      }
      const frame = { x: Math.round(value.x * zoom), y: Math.round(value.y * zoom),
        width: Math.min(bounds.width, Math.round(value.width * zoom)), height: Math.min(bounds.height, Math.round(value.height * zoom)) };
      this.insets = { right: Math.max(0, bounds.width - frame.x - frame.width),
        bottom: Math.max(0, bounds.height - frame.y - frame.height) };
      this.applyFrame(frame);
    });
    window.on('close', event => {
      if (!this.entries.size) return;
      event.preventDefault();
      if (this.closing) return;
      this.closing = true;
      void this.closeAll().catch(error => {
        if (!window.isDestroyed()) void dialog.showMessageBox(window, { type: 'info', message: String(error) });
      }).finally(() => { this.closing = false; });
    });
    window.once('closed', () => {
      this.railOverlay.dispose();
      // destroy()/app shutdown can bypass the cancellable close event. Detach
      // entries before child destruction calls back into workspace selection.
      this.closing = true;
      this.activeId = null;
      const entries = [...this.entries.values()];
      this.entries.clear();
      for (const entry of entries) if (!entry.surface.window.isDestroyed()) entry.surface.window.destroy();
      scope.dispose();
    });
    const renderer = process.env.CHESHI_RENDERER_URL?.trim();
    const loading = renderer ? window.loadURL(`${renderer}${renderer.includes('?') ? '&' : '?'}workspaceHost=1`)
      : window.loadFile(app.isPackaged ? path.join(process.resourcesPath, 'dist', 'index.html') : path.join(desktop, 'frontend', 'dist', 'index.html'), { query: { workspaceHost: '1' } });
    void loading.catch(error => {
      if (window.isDestroyed()) return;
      process.stderr.write(`[cheshi] Workspace host failed: ${String(error)}\n`);
      window.destroy();
    });
  }

  private applyFrame(frame: Rectangle): void {
    if (sameWorkspaceBounds(this.frame, frame)) return;
    this.railOverlay.hide();
    this.frame = frame;
    if (this.activeId !== null) this.entries.get(this.activeId)?.surface.setBounds(frame);
  }

  private resizeActiveSurface(): void {
    if (this.window.isDestroyed()) return;
    const { width, height } = this.window.getContentBounds();
    this.applyFrame({ x: this.frame.x, y: this.frame.y,
      width: Math.max(0, width - this.frame.x - this.insets.right),
      height: Math.max(0, height - this.frame.y - this.insets.bottom) });
  }

  createWindow(configuration: BrowserWindowConstructorOptions, scope: WorkspaceIpcScope, root: string): BrowserWindow {
    if (this.window.isDestroyed() || this.closing) throw new Error('The workspace window is closing.');
    const view = new WebContentsView({ webPreferences: { ...configuration.webPreferences,
      backgroundThrottling: false, additionalArguments: [...configuration.webPreferences?.additionalArguments ?? [], '--cheshi-workspace-surface'] } });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    const id = view.webContents.id;
    const surface = new WorkspaceSurface({ host: this.window, view,
      activate: () => this.activate(this.entry(id)),
      closed: () => {
        if (this.activeId === id) this.railOverlay.hide();
        this.entries.delete(id);
        if (this.activeId === id) {
          this.activeId = null;
          const next = [...this.entries.values()][0];
          if (next && !this.closing) this.activate(next);
        }
        this.publish();
        if (!this.entries.size && !this.window.isDestroyed()) this.window.destroy();
      },
    });
    surface.setBounds(this.frame);
    view.webContents.on('did-start-loading', () => {
      if (this.activeId === id) this.railOverlay.hide();
    });
    this.entries.set(id, { surface, state: { id, root, name: path.basename(root),
      iconColor: workspaceProjectColors(resolveCodeGraphDataRoot() ?? app.getPath('userData'), [root])[0],
      view: 'explorer', sidebarOpen: true, running: 0, attention: false } });
    scope.ipc.on(`${channel}:report`, (event, input: unknown) => {
      if (event.sender !== view.webContents || !input || typeof input !== 'object') return;
      const value = input as Record<string, unknown>;
      if (typeof value.view !== 'string' || !navigationViews.has(value.view) || typeof value.sidebarOpen !== 'boolean'
        || typeof value.running !== 'number' || !Number.isSafeInteger(value.running) || value.running < 0 || typeof value.attention !== 'boolean') return;
      const entry = this.entries.get(id);
      if (!entry) return;
      Object.assign(entry.state, { view: value.view, sidebarOpen: value.sidebarOpen, running: value.running, attention: value.attention });
      this.publish();
    });
    this.publish();
    return surface.window;
  }

  private updateRailBlur(region: WorkspaceRailOverlay | null): void {
    if (this.window.isDestroyed()) return;
    const view = this.activeId === null ? undefined : this.entries.get(this.activeId)?.surface.view;
    const contents = view?.webContents;
    if (!view || !contents || contents.isDestroyed()) return;
    const zoom = contents.getZoomFactor(), hostZoom = this.window.webContents.getZoomFactor();
    const frame = view.getBounds();
    contents.send(`${channel}:rail-blur`, region ? {
      x: (region.x * hostZoom - frame.x) / zoom, y: (region.y * hostZoom - frame.y) / zoom,
      width: region.width * hostZoom / zoom, height: region.height * hostZoom / zoom,
      radius: (Number.parseFloat(region.radius) || 0) * hostZoom / zoom,
    } : null);
  }

  private entry(id: unknown): HostedWorkspace {
    const entry = typeof id === 'number' ? this.entries.get(id) : undefined;
    if (!entry || entry.surface.window.isDestroyed()) throw new Error('This workspace is no longer open.');
    return entry;
  }
  private activate(entry: HostedWorkspace, focus = true): void {
    if (this.window.isDestroyed() || entry.surface.window.isDestroyed()) return;
    if (this.activeId !== entry.state.id) {
      this.railOverlay.hide();
      if (this.activeId !== null) this.entries.get(this.activeId)?.surface.setActive(false);
      this.activeId = entry.state.id;
      // Hidden workspaces keep working at their previous size until revealed.
      entry.surface.setBounds(this.frame);
      entry.surface.setActive(true, focus);
      this.window.setTitle(`${entry.state.name} — Cheshi`);
      this.activated(entry.state.root);
      this.publish();
    }
    if (this.window.isMinimized()) this.window.restore();
  }
  private snapshot(): WorkspaceHostState { return { activeId: this.activeId, entries: [...this.entries.values()].map(entry => ({ ...entry.state })) }; }
  disposeIfEmpty(): void { if (!this.entries.size && !this.window.isDestroyed()) this.window.destroy(); }
  private publish(): void {
    if (!this.window.isDestroyed()) this.window.webContents.send(`${channel}:changed`, this.snapshot());
  }
  private async closeAll(): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      if (this.window.isDestroyed()) return;
      if (entry.surface.window.isDestroyed()) continue;
      this.activate(entry);
      await closeWorkspaceWindow(entry.surface.window);
    }
  }
}
