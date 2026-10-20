import { createHash, randomUUID } from 'node:crypto';
import { link as createHardLink, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { CanvasDocument, CanvasSaveRequest } from '../../shared/canvas.ts';
import { isGitMetadataPath, normalizeRelativePath, openWorkspaceRoot, resolveWorkspaceTarget } from '../workspace-file-paths.mts';

const maximumBytes = 64 * 1024 * 1024;
const revisionOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function canvasDocumentPath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Design path must be a string.');
  const relative = normalizeRelativePath(value);
  if (!relative.endsWith('.fig') || isGitMetadataPath(relative)) throw new Error('Choose a .fig file inside the workspace.');
  return relative;
}

export function assertDocumentBytes(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 8 || value.byteLength > maximumBytes) {
    throw new Error('Design files must contain between 8 bytes and 64 MB.');
  }
  const signature = Buffer.from(value.subarray(0, 8)).toString('ascii');
  if (!signature.startsWith('fig-kiwi') && !signature.startsWith('PK\u0003\u0004')) throw new Error('This is not a .fig design file.');
}

async function readBytes(target: string): Promise<Buffer> {
  const information = await stat(target);
  if (!information.isFile() || information.size > maximumBytes) throw new Error('Choose a .fig file no larger than 64 MB.');
  const bytes = await readFile(target);
  assertDocumentBytes(bytes);
  return bytes;
}

function assertCurrentRevision(bytes: Uint8Array, expected: string) {
  if (revisionOf(bytes) !== expected) throw new Error('The design changed on disk. Reopen it or save under a new name.');
}

/** Workspace-scoped native design files. Writes are serialized and reject stale revisions. */
export class CanvasDocuments {
  private readonly root: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(root: string) { this.root = root; }

  async read(value: unknown): Promise<CanvasDocument> {
    const relative = canvasDocumentPath(value);
    const target = await resolveWorkspaceTarget(await openWorkspaceRoot(this.root), relative);
    const data = await readBytes(target);
    return { path: relative, revision: revisionOf(data), data: new Uint8Array(data) };
  }

  save(request: CanvasSaveRequest): Promise<{ path: string; revision: string }> {
    const operation = this.pending.then(() => this.write(request));
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  rename(previousPath: string, nextPath: string, expectedRevision: string, preserveHistory: () => Promise<void>) {
    const operation = this.pending.then(async () => {
      const root = await openWorkspaceRoot(this.root);
      const source = await resolveWorkspaceTarget(root, canvasDocumentPath(previousPath));
      const target = await resolveWorkspaceTarget(root, canvasDocumentPath(nextPath), true);
      assertCurrentRevision(await readBytes(source), expectedRevision);
      // Exclusive publication also protects a destination created after the dialog opened.
      await createHardLink(source, target);
      try {
        await preserveHistory();
        await unlink(source);
      } catch (error) {
        const [original, created] = await Promise.all([stat(source), stat(target)]);
        if (original.dev === created.dev && original.ino === created.ino) await unlink(target);
        throw error;
      }
      return { previousPath, path: nextPath, revision: expectedRevision };
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async write(request: CanvasSaveRequest): Promise<{ path: string; revision: string }> {
    if (!request || typeof request !== 'object') throw new Error('Invalid design save request.');
    const relative = canvasDocumentPath(request.path);
    assertDocumentBytes(request.data);
    if (request.expectedRevision !== null && (typeof request.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedRevision))) {
      throw new Error('Invalid design revision.');
    }
    const root = await openWorkspaceRoot(this.root);
    const target = await resolveWorkspaceTarget(root, relative, true);
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    const bytes = Buffer.from(request.data);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      // Resolve again after writing the temporary file; never follow an edited symlink.
      await resolveWorkspaceTarget(root, relative, true);
      if (request.expectedRevision === null) {
        // Exclusive publication: an existing file, even an empty one, is never overwritten.
        await createHardLink(temporary, target);
      } else {
        const current = await readBytes(target);
        assertCurrentRevision(current, request.expectedRevision);
        await rename(temporary, target);
      }
      return { path: relative, revision: revisionOf(bytes) };
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
}
