import type { LocalHistoryEntry, LocalHistoryRestoreRequest, LocalHistorySnapshot } from '../shared/local-history.ts';
import { LocalHistoryStore, localHistoryPath } from './local-history-store.mts';
import type { LocalHistoryCapture, LocalHistoryStoreOptions } from './local-history-store.mts';
import { isGitMetadataPath, isRecordValue, normalizeRelativePath, WorkspaceRequestError } from './workspace-file-paths.mts';
import { getWorkspaceFileVersion, readWorkspaceFile } from './workspace-file-reads.mts';
import { writeWorkspaceFile, writeWorkspaceFiles } from './workspace-file-writes.mts';
import type {
  WorkspaceFileReadResult,
  WorkspaceFilesChangedEvent,
  WorkspaceFilesWriteRequest,
  WorkspaceFilesWriteResult,
  WorkspaceFileWriteRequest,
  WorkspaceFileWriteResult,
} from './workspace-file-types.mts';

export interface LocalHistoryServiceOptions extends LocalHistoryStoreOptions {
  workspaceRoot: string;
  onError?: (error: Error) => void;
}

const PASSIVE_EXCLUSIONS = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', '.next',
  '.nuxt', '.output', '.cache', '.turbo', '.venv', 'venv', '__pycache__', 'target',
]);
const MAX_PENDING_PATHS = 512;

function passivePath(value: string): string | null {
  const normalized = normalizeRelativePath(value);
  if (!normalized || normalized.split('/').some((segment) => PASSIVE_EXCLUSIONS.has(segment))) return null;
  if (/\.cheshi-.*\.(?:tmp|bak)$/.test(normalized)) return null;
  return normalized;
}

function assertWriteBatch(value: unknown): asserts value is WorkspaceFilesWriteRequest {
  if (!isRecordValue(value) || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 100
    || !value.files.every((entry: unknown) => isRecordValue(entry)
      && typeof entry.path === 'string' && typeof entry.content === 'string'
      && typeof entry.expectedRevision === 'string'
      && (entry.hasBom === undefined || typeof entry.hasBom === 'boolean')
      && (entry.lineEnding === undefined || entry.lineEnding === 'lf' || entry.lineEnding === 'crlf' || entry.lineEnding === 'cr'))) {
    throw new WorkspaceRequestError('Local history file save request is invalid.', 400);
  }
}

function assertRestoreRequest(value: unknown): asserts value is LocalHistoryRestoreRequest {
  if (!isRecordValue(value) || typeof value.path !== 'string' || typeof value.id !== 'string'
    || typeof value.expectedRevision !== 'string' || value.expectedRevision.length === 0) {
    throw new WorkspaceRequestError('Local history restore request is invalid.', 400);
  }
}

function asCapture(result: WorkspaceFileReadResult, reason: LocalHistoryCapture['reason']): LocalHistoryCapture | null {
  if (result.file.fileKind !== 'text' || result.content === null || isGitMetadataPath(result.file.path)) return null;
  return {
    path: result.file.path, content: result.content, hasBom: result.file.hasBom,
    lineEnding: result.file.lineEnding, reason,
  };
}

function savedCapture(request: WorkspaceFileWriteRequest, original: WorkspaceFileReadResult): LocalHistoryCapture {
  const lineEnding = request.lineEnding ?? original.file.lineEnding;
  const separator = lineEnding === 'crlf' ? '\r\n' : lineEnding === 'cr' ? '\r' : '\n';
  const withoutBom = request.content.startsWith('\uFEFF') ? request.content.slice(1) : request.content;
  return {
    path: original.file.path,
    content: withoutBom.replace(/\r\n|\r|\n/g, separator),
    hasBom: request.hasBom === true || (request.hasBom === undefined && original.file.hasBom),
    lineEnding,
    reason: 'saved',
  };
}

function isUncapturableWatchTarget(error: unknown): boolean {
  if (error instanceof WorkspaceRequestError) return error.status === 400 || error.status === 403 || error.status === 404;
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR');
}

export class LocalHistoryService {
  private readonly workspaceRoot: string;
  private readonly store: LocalHistoryStore;
  private readonly onError: (error: Error) => void;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private pendingPaths = new Set<string>();
  private overflow = false;
  private capturePromise: Promise<void> | null = null;
  private captureErrors = new Map<string, Error>();

  constructor(options: LocalHistoryServiceOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.store = new LocalHistoryStore(options);
    this.onError = options.onError ?? ((error) => console.error('[local-history]', error.message));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Local history has been closed.'));
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private report(error: unknown, filePath = '*'): Error {
    const detail = error instanceof Error ? error : new Error(String(error));
    const captureError = new Error(`Some file changes could not be recorded in local history: ${detail.message}`);
    this.captureErrors.set(filePath, captureError);
    try {
      this.onError(captureError);
    } catch {
      console.error('[local-history]', captureError.message);
    }
    return captureError;
  }

  private async capture(value: LocalHistoryCapture | null, required = false, protectedIds: readonly string[] = []): Promise<LocalHistoryEntry | null> {
    if (!value) return null;
    try {
      const entry = await this.store.capture(value, protectedIds);
      this.captureErrors.delete(value.path);
      return entry;
    } catch (error) {
      const reported = this.report(error, value.path);
      if (required) throw reported;
      return null;
    }
  }

  private async stableRead(filePath: string): Promise<WorkspaceFileReadResult> {
    // A watcher can race an external writer. Do not pair earlier bytes with a later revision.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await getWorkspaceFileVersion(this.workspaceRoot, filePath);
      const result = await readWorkspaceFile(this.workspaceRoot, filePath);
      const after = await getWorkspaceFileVersion(this.workspaceRoot, filePath);
      if (before.revision === result.file.revision && result.file.revision === after.revision) return result;
    }
    throw new WorkspaceRequestError('The file is changing; retry after the external write finishes.', 409);
  }

  readFile(filePath: string): Promise<WorkspaceFileReadResult> {
    return this.enqueue(async () => {
      const result = await this.stableRead(filePath);
      await this.capture(asCapture(result, 'opened'));
      return result;
    });
  }

  writeFile(request: WorkspaceFileWriteRequest): Promise<WorkspaceFileWriteResult> {
    return this.writeFiles({ files: [request] }).then((result) => ({ status: result.status, file: result.files[0]! }));
  }

  writeFiles(value: WorkspaceFilesWriteRequest): Promise<WorkspaceFilesWriteResult> {
    return this.enqueue(async () => {
      assertWriteBatch(value);
      const originals = await Promise.all(value.files.map((request) => this.stableRead(request.path)));
      for (const original of originals) await this.capture(asCapture(original, 'opened'));
      const result = await writeWorkspaceFiles(this.workspaceRoot, value);
      if (result.status === 'written') {
        for (const [index, request] of value.files.entries()) {
          const original = originals[index]!;
          if (!isGitMetadataPath(original.file.path)) await this.capture(savedCapture(request, original));
        }
      }
      return result;
    });
  }

  list(filePath: string): Promise<LocalHistoryEntry[]> {
    return this.enqueue(async () => {
      const normalized = localHistoryPath(filePath);
      const entries = await this.store.list(normalized);
      const captureError = this.captureErrors.get(normalized) ?? this.captureErrors.get('*');
      if (captureError) throw captureError;
      return entries;
    });
  }

  read(filePath: string, id: string): Promise<LocalHistorySnapshot> {
    return this.enqueue(() => this.store.read(localHistoryPath(filePath), id));
  }

  restore(request: LocalHistoryRestoreRequest): Promise<WorkspaceFileWriteResult> {
    return this.enqueue(async () => {
      assertRestoreRequest(request);
      const snapshot = await this.store.read(localHistoryPath(request.path), request.id);
      const current = await this.stableRead(request.path);
      if (current.file.revision !== request.expectedRevision) return { status: 'conflict', file: current.file };
      const predecessor = asCapture(current, 'before-restore');
      if (!predecessor) throw new WorkspaceRequestError('Only supported text files can be restored.', 415);
      // Unlike ordinary saving, restoring must preserve the content it is about to replace.
      const protectedEntry = (await this.capture(predecessor, true))!;
      const value: WorkspaceFileWriteRequest = {
        path: request.path, expectedRevision: request.expectedRevision, content: snapshot.content,
        hasBom: snapshot.hasBom, lineEnding: snapshot.lineEnding,
      };
      const restoredCapture: LocalHistoryCapture = { ...savedCapture(value, current), reason: 'restored' };
      await this.store.ensureCaptureFits(restoredCapture, [protectedEntry.id]);
      const result = await writeWorkspaceFile(this.workspaceRoot, value);
      if (result.status === 'written') {
        await this.capture(restoredCapture, false, [protectedEntry.id]);
      }
      return result;
    });
  }

  captureChanged(event: WorkspaceFilesChangedEvent): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.overflow ||= event.overflow === true;
    for (const filePath of event.paths) {
      try {
        const normalized = passivePath(filePath);
        if (!normalized) continue;
        if (this.pendingPaths.size >= MAX_PENDING_PATHS) { this.overflow = true; break; }
        this.pendingPaths.add(normalized);
      } catch (error) { this.report(error); }
    }
    if (this.capturePromise) return this.capturePromise;
    this.capturePromise = this.enqueue(async () => {
      while (this.pendingPaths.size > 0 || this.overflow) {
        const paths = this.pendingPaths;
        this.pendingPaths = new Set();
        const overflow = this.overflow;
        this.overflow = false;
        if (overflow) {
          for (const tracked of await this.store.trackedPaths()) {
            if (passivePath(tracked)) paths.add(tracked);
          }
        }
        for (const filePath of paths) {
          try {
            await this.capture(asCapture(await this.stableRead(filePath), 'external'));
          } catch (error) {
            if (!isUncapturableWatchTarget(error)) this.report(error, filePath);
          }
        }
      }
    }).catch((error: unknown) => { this.report(error); }).finally(() => { this.capturePromise = null; });
    return this.capturePromise;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    await this.queue;
    await this.capturePromise;
  }
}
