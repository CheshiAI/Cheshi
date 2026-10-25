import { opendir, stat } from 'node:fs/promises';
import { canvasFileName, type CanvasDocument, type CanvasLibraryListing, type CanvasRenameRequest, type CanvasRestoreRequest, type CanvasSaveRequest } from '../../shared/canvas.ts';
import path from 'node:path';
import { openWorkspaceRoot, resolveWorkspaceTarget } from '../workspace-file-paths.mts';
import type { WorkspaceFilesChangedEvent } from '../workspace-file-types.mts';
import { CanvasDocuments, assertDocumentBytes, canvasDocumentPath } from './canvas-documents.mts';
import { CanvasHistory, canvasDescription, canvasRevision, type CanvasHistoryIndex } from './canvas-history.mts';
import { CanvasSession } from './canvas-session.mts';
import { canvasFileIdentity, type CanvasFileLocation } from './canvas-file-locations.mts';

const excludedDirectories = new Set(['.git', 'node_modules', '.development', '.cache', '.next', 'dist', 'out', 'vendor']);
function assertRevision(current: CanvasDocument | null, expected: string | null): void {
  if ((current?.revision ?? null) !== expected) throw new Error('The design changed on disk. Reopen it before saving or restoring.');
}

export class CanvasLibrary {
  private readonly root: string;
  private readonly documents: CanvasDocuments;
  readonly versions: CanvasHistory;
  readonly session: CanvasSession;
  constructor(root: string, dataRoot: string) {
    this.root = root; this.documents = new CanvasDocuments(root); this.versions = new CanvasHistory(dataRoot, root);
    this.session = new CanvasSession(dataRoot, root);
  }
  private async current(relative: string): Promise<CanvasDocument | null> {
    try { return await this.documents.read(relative); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async transaction<T>(value: unknown, operation: (index: CanvasHistoryIndex, current: CanvasDocument | null) => Promise<T>): Promise<T> {
    const relative = canvasDocumentPath(value);
    return this.versions.locked(relative, async () => {
      const index = await this.versions.load(relative);
      const current = await this.current(relative);
      // Complete a save interrupted after publishing the file but before committing its journal.
      if (index.pending) {
        if (current?.revision === index.pending.revision) index.versions.push(index.pending);
        delete index.pending; await this.versions.persist(index);
      }
      return operation(index, current);
    });
  }
  async read(relative: string): Promise<CanvasDocument> {
    return this.transaction(relative, async (index, current) => {
      if (!current) throw new Error('Canvas file not found. It may have been moved or deleted. Open its current location from the canvas list.');
      await this.versions.capture(index, current, 'opened', 'Opened from workspace');
      return current;
    });
  }
  async save(request: CanvasSaveRequest): Promise<{ path: string; revision: string }> {
    if (!request || typeof request !== 'object') throw new Error('Invalid Canvas save request.');
    assertDocumentBytes(request.data);
    request = { ...request, data: new Uint8Array(request.data) };
    const description = canvasDescription(request.description, 'Saved canvas');
    return this.transaction(request.path, async (index, current) => {
      assertRevision(current, request.expectedRevision);
      if (current) await this.versions.capture(index, current, 'external', 'Before save');
      return this.publish(index, request, description, 'saved');
    });
  }
  private async publish(index: CanvasHistoryIndex, request: CanvasSaveRequest, description: string, reason: 'saved' | 'restored') {
    // Validate before writing history blobs; the document service validates again at publication.
    assertDocumentBytes(request.data);
    const document = { path: index.path, data: request.data, revision: canvasRevision(request.data) };
    if (reason === 'saved' && index.versions.at(-1)?.revision === document.revision) return this.documents.save(request);
    index.pending = await this.versions.prepare(document, reason, description);
    await this.versions.persist(index);
    const result = await this.documents.save(request);
    index.versions.push(index.pending); delete index.pending;
    await this.versions.persist(index);
    return result;
  }
  async history(relative: string) {
    return this.transaction(relative, async (index, current) => {
      if (current) await this.versions.capture(index, current, 'external', 'Workspace file snapshot');
      return { path: index.path, currentRevision: current?.revision ?? null, versions: [...index.versions].reverse() };
    });
  }
  async readVersion(relative: string, id: string): Promise<CanvasDocument> {
    return this.transaction(relative, index => this.versions.read(index, id));
  }
  async checkpoint(request: { path: string; description: string }) {
    const description = canvasDescription(request?.description, 'Checkpoint');
    return this.transaction(request?.path, async (index, current) => {
      if (!current) throw new Error('Canvas file not found.');
      return this.versions.capture(index, current, 'checkpoint', description);
    });
  }
  async restore(request: CanvasRestoreRequest): Promise<CanvasDocument> {
    return this.transaction(request?.path, async (index, current) => {
      assertRevision(current, request.expectedRevision);
      const document = await this.versions.read(index, request.versionId);
      if (current) await this.versions.capture(index, current, 'before-restore', 'Before restore');
      const restored = index.versions.find(item => item.id === request.versionId)!;
      await this.publish(index, { path: index.path, expectedRevision: request.expectedRevision, data: document.data },
        `Restored version from ${restored.createdAt}`, 'restored');
      return document;
    });
  }
  async rename(request: CanvasRenameRequest) {
    const previous = canvasDocumentPath(request?.path);
    const next = path.posix.join(path.posix.dirname(previous), canvasFileName(request?.name));
    const rename = async () => {
      const current = await this.documents.read(previous);
      if (request.expectedRevision !== undefined) assertRevision(current, request.expectedRevision);
      if (previous === next) return { previousPath: previous, path: next, revision: current.revision };
      const index = await this.versions.load(previous);
      if (index.pending) {
        if (index.pending.revision === current.revision) index.versions.push(index.pending);
        delete index.pending;
      }
      await this.versions.capture(index, current, 'external', 'Before rename');
      const remembered = await this.session.read();
      try {
        return await this.documents.rename(previous, next, current.revision, async () => {
          await this.versions.copyTo(index, next);
          if (remembered === previous) await this.session.remember(next);
        });
      } catch (error) {
        if (remembered === previous && await this.session.read() === next) await this.session.remember(previous);
        throw error;
      }
    };
    if (previous === next) return this.versions.locked(previous, rename);
    const ordered = [previous, next].sort();
    return this.versions.locked(ordered[0]!, () => this.versions.locked(ordered[1]!, rename));
  }
  async list(): Promise<CanvasLibraryListing> {
    const root = await openWorkspaceRoot(this.root);
    const canvasRoot = await this.session.root();
    const files: CanvasLibraryListing['files'] = [];
    const locations: CanvasFileLocation[] = [];
    const directories = canvasRoot === null ? [] : [canvasRoot];
    let visited = 0, truncated = false;
    while (directories.length && !truncated) {
      const relative = directories.pop()!;
      const directory = await opendir(await resolveWorkspaceTarget(root, relative));
      for await (const entry of directory) {
        if (++visited > 50_000 || files.length >= 1000) { truncated = true; break; }
        const child = relative === '.' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && !excludedDirectories.has(entry.name)) directories.push(child);
        else if (entry.isFile() && entry.name.endsWith('.fig')) {
          try {
            const information = await stat(await resolveWorkspaceTarget(root, child));
            files.push({ path: child, size: information.size, modifiedAt: information.mtimeMs });
            locations.push({ path: child, identity: canvasFileIdentity(information) });
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
    }
    return { workspaceRoot: root.resolved, canvasRoot, historyDirectory: this.versions.directory,
      files: files.sort((a, b) => a.path.localeCompare(b.path)), truncated,
      relocations: this.documents.locations.observe(locations, truncated) };
  }
  async captureChanged(event: WorkspaceFilesChangedEvent): Promise<void> {
    const paths = event.overflow ? (await this.list()).files.map(file => file.path) : event.paths.filter(file => file.endsWith('.fig'));
    const failures: string[] = [];
    for (const relative of new Set(paths)) {
      try { await this.history(relative); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (failures.length) throw new Error(failures.join('\n'));
  }
}
