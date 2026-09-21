import type { BrowserWindow, Dialog, Event, Rectangle } from 'electron';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceIpcRouter } from './workspace-ipc-router.mts';
import type { HistoryRecallAccess } from './workspace-history-mcp.mts';
import type { WorkspaceAccountSelection } from './settings-service.mts';

export interface WorkspaceWindowState { bounds: Rectangle; maximized: boolean; fullscreen: boolean; }
export interface WorkspaceRuntimeOptions {
  workspaceRoot: string;
  getTypeSafeKey?(): string | null;
  historyRecall?: HistoryRecallAccess;
  accountSelection?: WorkspaceAccountSelection;
  managementOnly?: boolean;
  initial: boolean;
  deferShow?: boolean;
  windowState?: WorkspaceWindowState;
  scope: ReturnType<WorkspaceIpcRouter['createScope']>;
  onOpenWorkspace(root: string): Promise<void>;
  onReplaceWorkspace(root: string): Promise<void>;
  withWorkspaceDeletion(root: string, operation: () => Promise<boolean>): Promise<boolean>;
  assertWorkspaceAvailable(root: string): void;
  onClosed(): void;
}
export interface WorkspaceRuntime {
  start(): Promise<BrowserWindow>;
  show?(): void;
  dispose(): Promise<void>;
}
interface WorkspaceEntry {
  root: string;
  managementOnly: boolean;
  runtime: WorkspaceRuntime;
  window: BrowserWindow | null;
  closing: Promise<void> | null;
  replacement: WorkspaceEntry | null;
  switching: boolean;
}

function workspacePath(root: string): string {
  let resolved = path.resolve(root);
  try { resolved = realpathSync.native(resolved); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return process.platform === 'darwin' || process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function overlaps(first: string, second: string): boolean {
  const contains = (parent: string, child: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
  return contains(first, second) || contains(second, first);
}

export class WorkspaceWindowCloseCancelledError extends Error {
  constructor() {
    super('The workspace has unsaved files. Closing was canceled.');
    this.name = 'WorkspaceWindowCloseCancelledError';
  }
}

export function registerWorkspaceWindowCloseConfirmation(window: BrowserWindow, dialog: Pick<Dialog, 'showMessageBoxSync'>): void {
  const contents = window.webContents;
  const confirmClose = (event: Event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning', title: 'Unsaved changes',
      message: 'Close this workspace without saving?',
      detail: 'Unsaved changes in open files will be lost. To keep them, cancel and save your files before closing.',
      buttons: ['Cancel', 'Discard Changes'], defaultId: 0, cancelId: 0, noLink: true,
    });
    // Electron allows unloading only when this event's default is prevented.
    if (choice === 1) event.preventDefault();
  };
  contents.on('will-prevent-unload', confirmClose);
  window.once('closed', () => contents.off('will-prevent-unload', confirmClose));
}

export function closeWorkspaceWindow(window: BrowserWindow, onClosed?: () => void): Promise<void> {
  if (window.isDestroyed()) return Promise.resolve();
  const contents = window.webContents;
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      window.off('closed', closed);
      contents.off('will-prevent-unload', blocked);
    };
    const closed = () => {
      cleanup();
      try { onClosed?.(); resolve(); } catch (error) { reject(error); }
    };
    const blocked = (event: Event) => {
      // The window's confirmation listener runs first, including for native close buttons.
      if (event.defaultPrevented === true) {
        timeout.refresh();
        return;
      }
      cleanup();
      reject(new WorkspaceWindowCloseCancelledError());
    };
    const timeout = setTimeout(() => {
      cleanup(); reject(new Error('The workspace window did not close. Please try again.'));
    }, 10_000);
    window.once('closed', closed);
    contents.once('will-prevent-unload', blocked);
    try { window.close(); } catch (error) { cleanup(); reject(error); }
  });
}

export class WorkspaceApplication {
  private readonly router: WorkspaceIpcRouter;
  private readonly createRuntime: (options: WorkspaceRuntimeOptions) => WorkspaceRuntime;
  private readonly entries = new Set<WorkspaceEntry>();
  private readonly cleanups = new Set<Promise<void>>();
  private readonly closingRoots = new Set<WorkspaceEntry>();
  private readonly deletingRoots = new Set<string>();
  private shuttingDown = false;
  private shutdownVersion = 0;
  private firstWindow = true;
  private transitions = 0;
  lastWorkspaceRoot: string;

  constructor(options: { router: WorkspaceIpcRouter; createRuntime: (options: WorkspaceRuntimeOptions) => WorkspaceRuntime; initialRoot: string }) {
    this.router = options.router;
    this.createRuntime = options.createRuntime;
    this.lastWorkspaceRoot = options.initialRoot;
  }

  get hasWorkspaces(): boolean { return this.entries.size > 0; }
  get isTransitioning(): boolean { return this.transitions > 0; }

  async open(root: string, windowState?: WorkspaceWindowState): Promise<void> {
    await this.openRuntime(root, false, windowState);
  }

  async openManager(): Promise<void> {
    await this.openRuntime('', true);
  }

  private async openRuntime(root: string, managementOnly: boolean, windowState?: WorkspaceWindowState, source?: WorkspaceEntry): Promise<WorkspaceEntry> {
    if (this.shuttingDown) throw new Error('The application is closing.');
    if (!managementOnly) this.assertNotDeleting(root);
    const scope = this.router.createScope();
    const initial = this.firstWindow;
    this.firstWindow = false;
    let entry: WorkspaceEntry;
    try {
      const runtime = this.createRuntime({
        workspaceRoot: root, managementOnly, initial, windowState, deferShow: source !== undefined, scope,
        onOpenWorkspace: (target) => this.open(target),
        onReplaceWorkspace: (target) => managementOnly ? this.open(target) : this.replace(entry, target),
        withWorkspaceDeletion: (target, operation) => this.withWorkspaceDeletion(target, operation),
        assertWorkspaceAvailable: (target) => this.assertNotDeleting(target),
        onClosed: () => {
          void this.disposeEntry(entry).catch((error: unknown) => {
            process.stderr.write(`[cheshi] Workspace disposal failed: ${String(error)}\n`);
          });
        },
      });
      entry = { root, managementOnly, runtime, window: null, closing: null, replacement: null, switching: false };
      this.entries.add(entry);
      if (source) source.replacement = entry;
      try {
        entry.window = await runtime.start();
        this.assertEntryReady(entry);
        if (!managementOnly && !source) this.lastWorkspaceRoot = root;
        return entry;
      }
      catch (error) { await this.disposeEntry(entry); throw error; }
    } catch (error) { scope.dispose(); throw error; }
  }

  private disposeEntry(entry: WorkspaceEntry): Promise<void> {
    if (entry.closing) return entry.closing;
    this.entries.delete(entry);
    this.closingRoots.add(entry);
    const replacement = entry.replacement;
    entry.replacement = null;
    const closing = Promise.resolve().then(async () => {
      await Promise.all([entry.runtime.dispose(), replacement ? this.disposeEntry(replacement) : undefined]);
    });
    entry.closing = closing;
    this.cleanups.add(closing);
    const finished = () => { this.cleanups.delete(closing); this.closingRoots.delete(entry); };
    // Failed disposal may leave services using the folder; keep deletion blocked.
    void closing.then(finished, () => { this.cleanups.delete(closing); });
    return closing;
  }

  private assertNotDeleting(root: string): void {
    const candidate = workspacePath(root);
    if ([...this.deletingRoots].some((deleting) => overlaps(deleting, candidate))) {
      throw new Error('This workspace folder is being deleted. Please wait.');
    }
  }

  private async withWorkspaceDeletion(root: string, operation: () => Promise<boolean>): Promise<boolean> {
    if (this.shuttingDown) throw new Error('The application is closing.');
    this.assertNotDeleting(root);
    const candidate = workspacePath(root);
    if ([...this.entries, ...this.closingRoots].some((entry) => !entry.managementOnly && overlaps(candidate, workspacePath(entry.root)))) {
      throw new Error('Close all workspace windows using this folder before deleting it.');
    }
    this.deletingRoots.add(candidate);
    try { return await operation(); }
    finally { this.deletingRoots.delete(candidate); }
  }

  private async replace(entry: WorkspaceEntry, root: string): Promise<void> {
    if (entry.switching) throw new Error('A workspace switch is already in progress.');
    this.assertNotDeleting(root);
    const window = entry.window;
    if (!window || window.isDestroyed()) throw new Error('The original workspace window is no longer available.');
    if (root === entry.root) throw new Error('This workspace is already open in the original window.');
    const state = { bounds: window.getNormalBounds(), maximized: window.isMaximized(), fullscreen: window.isFullScreen() };
    entry.switching = true;
    this.transitions += 1;
    let replacement: WorkspaceEntry | null = null;
    let sourceClosedForSwitch = false;
    const shutdownVersion = this.shutdownVersion;
    try {
      replacement = await this.openRuntime(root, false, state, entry);
      this.assertEntryReady(entry);
      this.assertReplacementCanShow(replacement);
      Object.assign(state, {
        bounds: window.getNormalBounds(), maximized: window.isMaximized(), fullscreen: window.isFullScreen(),
      });
      // Closing the source now commits the switch; its disposal must not cancel the prepared window.
      entry.replacement = null;
      const prepared = replacement;
      await closeWorkspaceWindow(window, () => {
        sourceClosedForSwitch = true;
        this.assertReplacementCanShow(prepared);
        prepared.runtime.show!();
        this.lastWorkspaceRoot = root;
      });
    } catch (error) {
      if (replacement) await this.disposeEntry(replacement);
      // A renderer can exit while the source is handling beforeunload.
      if (sourceClosedForSwitch && !this.shuttingDown && shutdownVersion === this.shutdownVersion) {
        await this.disposeEntry(entry);
        if (!this.shuttingDown && shutdownVersion === this.shutdownVersion) await this.open(entry.root, state);
      }
      throw error;
    } finally {
      entry.replacement = null;
      entry.switching = false;
      this.transitions -= 1;
    }
    // The replacement is already visible while the old services finish shutting down.
    try {
      await this.disposeEntry(entry);
    } catch (error) {
      process.stderr.write(`[cheshi] Workspace disposal failed after switching: ${String(error)}\n`);
    }
  }

  private assertEntryReady(entry: WorkspaceEntry): void {
    if (this.shuttingDown || entry.closing || !entry.window || entry.window.isDestroyed()) {
      throw new Error('Workspace startup was canceled.');
    }
  }

  private assertReplacementCanShow(entry: WorkspaceEntry): void {
    this.assertEntryReady(entry);
    if (!entry.runtime.show) throw new Error('The replacement workspace cannot be shown.');
  }

  async closeAll(): Promise<void> {
    this.shutdownVersion += 1;
    this.shuttingDown = true;
    try {
      for (const entry of this.entries) {
        if (entry.window) await closeWorkspaceWindow(entry.window);
        await this.disposeEntry(entry);
      }
      await Promise.all([...this.cleanups]);
    } finally { this.shuttingDown = false; }
  }
}
