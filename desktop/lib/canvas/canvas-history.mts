import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { codeGraphStorageDirectory } from '../../../config/workspace-storage.mts';
import type { CanvasDocument, CanvasVersion, CanvasVersionReason } from '../../shared/canvas.ts';
import { withLocalHistoryLock } from '../local-history-lock.mts';

export interface CanvasHistoryIndex {
  version: 1;
  path: string;
  versions: CanvasVersion[];
  pending?: CanvasVersion;
}
const revisionPattern = /^[a-f0-9]{64}$/;
const reasons: CanvasVersionReason[] = ['opened', 'saved', 'external', 'checkpoint', 'before-restore', 'restored'];
export const canvasRevision = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
function assertBlobRevision(data: Uint8Array, expected: string): void {
  if (canvasRevision(data) !== expected) throw new Error('Canvas version data is damaged.');
}

export function canvasDescription(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 240 || value.includes('\0')) throw new Error('Version descriptions must be text of at most 240 characters.');
  return value.trim() || fallback;
}
function isVersion(value: unknown): value is CanvasVersion {
  if (!value || typeof value !== 'object') return false;
  const item = value as CanvasVersion;
  return typeof item.id === 'string' && /^[a-f0-9-]{36}$/.test(item.id)
    && typeof item.revision === 'string' && revisionPattern.test(item.revision)
    && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))
    && typeof item.description === 'string' && item.description.length <= 240
    && reasons.includes(item.reason) && Number.isSafeInteger(item.size) && item.size >= 8 && item.size <= 64 * 1024 * 1024;
}
async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(data); await handle.sync(); await handle.close();
    await rename(temporary, file);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

/** Immutable binary blobs and a recoverable save journal, scoped to one workspace. */
export class CanvasHistory {
  readonly directory: string;
  constructor(dataRoot: string, workspaceRoot: string) {
    this.directory = path.join(path.dirname(codeGraphStorageDirectory(dataRoot, workspaceRoot)), 'canvas-history');
  }
  private folder(relative: string): string {
    return path.join(this.directory, createHash('sha256').update(relative).digest('hex'));
  }
  async locked<T>(relative: string, operation: () => Promise<T>): Promise<T> {
    return withLocalHistoryLock(this.folder(relative), operation);
  }
  async load(relative: string): Promise<CanvasHistoryIndex> {
    let source: string;
    try { source = await readFile(path.join(this.folder(relative), 'history.json'), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, path: relative, versions: [] };
      throw error;
    }
    const index = JSON.parse(source) as CanvasHistoryIndex;
    if (!index || index.version !== 1 || index.path !== relative || !Array.isArray(index.versions)
      || !index.versions.every(isVersion) || (index.pending !== undefined && !isVersion(index.pending))
      || new Set(index.versions.map(item => item.id)).size !== index.versions.length) {
      throw new Error('Canvas history is damaged. The original file has not been changed.');
    }
    return index;
  }
  async persist(index: CanvasHistoryIndex): Promise<void> {
    await atomicWrite(path.join(this.folder(index.path), 'history.json'), JSON.stringify(index) + '\n');
  }
  async prepare(document: CanvasDocument, reason: CanvasVersionReason, description: string): Promise<CanvasVersion> {
    const folder = this.folder(document.path);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, `${document.revision}.fig`);
    // Verify an existing blob as well: corrupted history must never replace the original.
    try {
      const existing = await readFile(file);
      assertBlobRevision(existing, document.revision);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await atomicWrite(file, document.data);
    }
    return { id: randomUUID(), revision: document.revision, createdAt: new Date().toISOString(),
      size: document.data.byteLength, description, reason };
  }
  async capture(index: CanvasHistoryIndex, document: CanvasDocument, reason: CanvasVersionReason, description: string): Promise<CanvasVersion> {
    const latest = index.versions.at(-1);
    if (latest?.revision === document.revision) return latest;
    const item = await this.prepare(document, reason, description);
    index.versions.push(item); await this.persist(index); return item;
  }
  async copyTo(index: CanvasHistoryIndex, destination: string): Promise<void> {
    const next = await this.load(destination);
    if (next.pending) throw new Error('Reopen the destination history before renaming.');
    for (const item of index.versions) {
      const document = await this.read(index, item.id);
      await this.prepare({ ...document, path: destination }, item.reason, item.description);
      if (!next.versions.some(existing => existing.id === item.id)) next.versions.push(item);
    }
    await this.persist(next);
  }
  async read(index: CanvasHistoryIndex, id: unknown): Promise<CanvasDocument> {
    const item = index.versions.find(version => version.id === id);
    if (!item) throw new Error('Canvas version not found.');
    const data = await readFile(path.join(this.folder(index.path), `${item.revision}.fig`));
    if (canvasRevision(data) !== item.revision || data.byteLength !== item.size) throw new Error('Canvas version data is damaged.');
    return { path: index.path, revision: item.revision, data: new Uint8Array(data) };
  }
}
