import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { APP_UPDATE_CHANNEL } from '../shared/app-update.ts';
import type { WorkspaceRuntimeOptions, WorkspaceWindowState } from './workspace-application.mts';

interface SavedWindow {
  id: string;
  root: string;
  managementOnly: boolean;
  windowState?: WorkspaceWindowState;
  snapshot: unknown;
}
interface ResumeManifest { schema: 1; windows: SavedWindow[]; }
interface RegisteredWindow {
  id: string;
  options: WorkspaceRuntimeOptions;
  window: BrowserWindow | null;
  saved: unknown;
  restored: SavedWindow | undefined;
  pending?: { id: string; resolve: () => void; reject: (error: Error) => void; saved: boolean };
}

const MAX_RESUME_BYTES = 64 * 1024 * 1024;
function assertSnapshot(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > 16 * 1024 * 1024) {
    throw new Error('Workspace recovery data is invalid or too large. Save your files and retry.');
  }
}

export function createAppUpdateResume(directory: string) {
  const filename = path.join(directory, 'update-resume.json');
  const checkpoint = path.join(directory, 'update-resume.pending.json');
  const registrations = new Set<RegisteredWindow>();
  let restored: SavedWindow[] = [];
  let preparing = false;
  let activating = false;
  let generation = 0;
  let stagedEntries: RegisteredWindow[] | null = null;
  let activatedEntries: RegisteredWindow[] | null = null;
  let writeQueue = Promise.resolve();
  const enqueue = (operation: () => Promise<void>) => {
    const write = writeQueue.catch(() => undefined).then(operation);
    writeQueue = write;
    return write;
  };
  const persist = async (windows: SavedWindow[], destination = filename) => {
    const body = JSON.stringify({ schema: 1, windows } satisfies ResumeManifest);
    if (Buffer.byteLength(body, 'utf8') > MAX_RESUME_BYTES) throw new Error('Workspace recovery data is too large. Close some windows and retry.');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, body, { mode: 0o600, flag: 'wx', flush: true });
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
  };
  const assertWindowsUnchanged = (entries: RegisteredWindow[]) => {
    if (entries.length !== registrations.size || entries.some(entry => !registrations.has(entry)
      || (entry.window !== null && entry.window.isDestroyed()))) {
      throw new Error('The open workspace windows changed. Please retry.');
    }
  };
  const assertGeneration = (expected: number) => {
    if (generation !== expected) throw new Error('Update preparation was cancelled.');
  };
  const requestWindows = async (entries: RegisteredWindow[], phase: 'prepare' | 'committed') => {
    const requests = entries.map(async entry => {
      if (entry.options.managementOnly === true) return;
      const window = entry.window;
      if (!window || window.isDestroyed()) throw new Error('A workspace window is not ready.');
      const id = randomUUID();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          entry.pending = { id, resolve, reject, saved: phase === 'committed' };
          timer = setTimeout(() => reject(new Error('Saving workspace recovery data timed out. Please retry.')), 20_000);
          window.webContents.send(`${APP_UPDATE_CHANNEL}:${phase}`, id);
        });
      } finally {
        if (timer) clearTimeout(timer);
        if (entry.pending?.id === id) entry.pending = undefined;
      }
    });
    try { await Promise.all(requests); }
    catch (error) {
      for (const entry of entries) entry.pending?.reject(new Error('Update preparation failed.'));
      await Promise.allSettled(requests);
      throw error;
    }
  };
  return {
    async load(): Promise<Pick<SavedWindow, 'root' | 'managementOnly' | 'windowState'>[]> {
      let source: string;
      try { source = await readFile(filename, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      if (Buffer.byteLength(source, 'utf8') > MAX_RESUME_BYTES) throw new Error('Update resume manifest is too large.');
      const value: unknown = JSON.parse(source);
      if (!value || typeof value !== 'object' || !('schema' in value) || value.schema !== 1
        || !('windows' in value) || !Array.isArray(value.windows) || value.windows.length > 100) {
        throw new Error('Invalid update resume manifest.');
      }
      const ids = new Set<string>();
      restored = value.windows.map((entry: unknown) => {
        if (!entry || typeof entry !== 'object') throw new Error('Invalid update resume window.');
        const row = entry as SavedWindow;
        if (typeof row.id !== 'string' || ids.has(row.id) || typeof row.root !== 'string'
          || (row.managementOnly !== true && row.managementOnly !== false)
          || (!row.managementOnly && (!path.isAbsolute(row.root) || row.root === path.parse(row.root).root))) {
          throw new Error('Invalid update resume workspace.');
        }
        ids.add(row.id);
        if (!row.managementOnly) assertSnapshot(row.snapshot);
        if (row.windowState) {
          const { bounds, maximized, fullscreen } = row.windowState;
          if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
            || bounds.width < 1 || bounds.height < 1 || typeof maximized !== 'boolean' || typeof fullscreen !== 'boolean') {
            throw new Error('Invalid update resume window bounds.');
          }
        }
        return row;
      });
      return restored.map(({ root, managementOnly, windowState }) => ({ root, managementOnly, windowState }));
    },
    register(options: WorkspaceRuntimeOptions) {
      const claimed = new Set([...registrations].map(entry => entry.restored?.id));
      const previous = restored.find(entry => entry.root === options.workspaceRoot
        && entry.managementOnly === (options.managementOnly === true) && !claimed.has(entry.id));
      const entry: RegisteredWindow = { id: randomUUID(), options, window: null, saved: null, restored: previous };
      registrations.add(entry);
      const ipc = options.scope.ipc;
      ipc.handle(`${APP_UPDATE_CHANNEL}:resume`, () => entry.restored?.snapshot ?? null);
      const consumeRestored = () => enqueue(async () => {
        if (!entry.restored) return;
        const remaining = restored.filter(row => row.id !== entry.restored?.id);
        await persist(remaining);
        restored = remaining;
        entry.restored = undefined;
      });
      ipc.handle(`${APP_UPDATE_CHANNEL}:clear`, consumeRestored);
      ipc.handle(`${APP_UPDATE_CHANNEL}:save`, (_event, snapshot: unknown) => {
        if (!entry.pending) throw new Error('No update preparation is pending.');
        assertSnapshot(snapshot);
        entry.saved = structuredClone(snapshot);
        entry.pending.saved = true;
      });
      ipc.handle(`${APP_UPDATE_CHANNEL}:ack`, (_event, id: unknown, error: unknown) => {
        if (typeof id !== 'string' || entry.pending?.id !== id) throw new Error('Invalid update preparation acknowledgement.');
        if (error !== null && typeof error !== 'string') throw new Error('Invalid update preparation error.');
        if (error !== null) entry.pending.reject(new Error(error.slice(0, 2_000)));
        else if (!entry.pending.saved) entry.pending.reject(new Error('Workspace recovery data was not saved.'));
        else entry.pending.resolve();
      });
      return {
        attach(window: BrowserWindow) {
          entry.window = window;
          if (options.managementOnly === true && entry.restored) {
            void consumeRestored().catch(error => { console.warn('[cheshi] Could not consume restored management window:', error); });
          }
        },
        dispose() {
          entry.pending?.reject(new Error('A window closed during update preparation. Please retry.'));
          registrations.delete(entry);
        },
      };
    },
    async prepare() {
      if (preparing || activating) throw new Error('Update preparation is already running.');
      preparing = true;
      const currentGeneration = generation;
      stagedEntries = null;
      try {
        const entries = [...registrations];
        await requestWindows(entries, 'prepare');
        assertWindowsUnchanged(entries);
        assertGeneration(currentGeneration);
        await enqueue(() => persist(entries.map(entry => ({
          id: entry.id, root: entry.options.workspaceRoot, managementOnly: entry.options.managementOnly === true,
          snapshot: entry.saved,
          windowState: entry.window && !entry.window.isDestroyed() ? {
            bounds: entry.window.getNormalBounds(), maximized: entry.window.isMaximized(), fullscreen: entry.window.isFullScreen(),
          } : undefined,
        })), checkpoint));
        assertGeneration(currentGeneration);
        assertWindowsUnchanged(entries);
        stagedEntries = entries;
      } finally { preparing = false; }
    },
    async activate() {
      if (preparing || activating || !stagedEntries) throw new Error('No completed update preparation is available.');
      const entries = stagedEntries;
      const currentGeneration = generation;
      assertWindowsUnchanged(entries);
      activating = true;
      try {
        await enqueue(async () => {
          assertGeneration(currentGeneration);
          assertWindowsUnchanged(entries);
          await rename(checkpoint, filename);
          activatedEntries = entries;
          stagedEntries = null;
        });
        assertGeneration(currentGeneration);
        // Renderer close guards are released only after the manifest is durable.
        await requestWindows(entries, 'committed');
        assertGeneration(currentGeneration);
        assertWindowsUnchanged(entries);
      } finally { activating = false; }
    },
    async cancel() {
      generation++;
      stagedEntries = null;
      for (const entry of registrations) {
        entry.pending?.reject(new Error('Update preparation was cancelled.'));
        if (entry.window && !entry.window.isDestroyed()) entry.window.webContents.send(`${APP_UPDATE_CHANNEL}:cancelled`);
      }
      await enqueue(async () => {
        await rm(checkpoint, { force: true });
        // If shutdown already closed a window, keep its only durable recovery copy.
        if (activatedEntries && activatedEntries.every(entry => registrations.has(entry)
          && (entry.window === null || !entry.window.isDestroyed()))) {
          await rm(filename, { force: true });
          activatedEntries = null;
        }
      });
    },
  };
}
