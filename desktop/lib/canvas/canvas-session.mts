import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { codeGraphStorageDirectory } from '../../../config/workspace-storage.mts';
import { CanvasDocuments, canvasDocumentPath } from './canvas-documents.mts';
import { isGitMetadataPath, normalizeRelativePath, openWorkspaceRoot, resolveWorkspaceTarget } from '../workspace-file-paths.mts';
import { canvasFileName } from '../../shared/canvas.ts';

interface SessionState { version: 1; path: string | null; root?: string | null }

/** Remember only a file reference, independently of the renderer's development URL. */
export class CanvasSession {
  private readonly file: string;
  private readonly documents: CanvasDocuments;
  private readonly workspaceRoot: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(dataRoot: string, workspaceRoot: string) {
    this.file = path.join(path.dirname(codeGraphStorageDirectory(dataRoot, workspaceRoot)), 'canvas-session.json');
    this.documents = new CanvasDocuments(workspaceRoot);
    this.workspaceRoot = workspaceRoot;
  }

  async read(): Promise<string | null> {
    await this.pending;
    return (await this.load()).path;
  }

  private async load(): Promise<SessionState> {
    let source: string;
    try { source = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, path: null };
      throw error;
    }
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('path' in value)) {
      throw new Error('Invalid saved canvas session. Choose a file or start a new design.');
    }
    const state: SessionState = { version: 1, path: value.path === null ? null : canvasDocumentPath(value.path) };
    if ('root' in value) state.root = value.root === null ? null : this.rootPath(value.root);
    return state;
  }

  private rootPath(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Invalid canvas folder.');
    const relative = normalizeRelativePath(value) || '.';
    if (isGitMetadataPath(relative)) throw new Error('Choose a canvas folder outside Git metadata.');
    return relative;
  }

  async root(): Promise<string | null> {
    await this.pending;
    const state = await this.load();
    return state.root === undefined ? (state.path ? path.posix.dirname(state.path) : null) : state.root;
  }

  selectRoot(value: string): Promise<void> {
    return this.update(async state => {
      const root = await openWorkspaceRoot(this.workspaceRoot);
      if (path.isAbsolute(value) && (await lstat(value)).isSymbolicLink()) throw new Error('Choose a folder, not a symbolic link.');
      const relative = this.rootPath(path.isAbsolute(value) ? path.relative(root.resolved, await realpath(value)) : value);
      const target = await resolveWorkspaceTarget(root, relative);
      if (!(await stat(target)).isDirectory()) throw new Error('Choose a canvas folder.');
      return { ...state, root: relative };
    });
  }

  async newPath(name: string): Promise<string> {
    const folder = await this.root();
    if (folder === null) throw new Error('Choose a canvas folder with + before saving a new canvas.');
    const target = await resolveWorkspaceTarget(await openWorkspaceRoot(this.workspaceRoot), folder);
    if (!(await stat(target)).isDirectory()) throw new Error('The canvas folder is unavailable.');
    return path.posix.join(folder, canvasFileName(name));
  }

  remember(value: unknown): Promise<void> {
    return this.update(async state => {
      // The renderer calls this only after parsing/opening or saving successfully.
      const relative = value === null ? null : (await this.documents.read(value)).path;
      return { ...state, path: relative };
    }, value === null);
  }

  private update(change: (state: SessionState) => Promise<SessionState>, allowReset = false): Promise<void> {
    const operation = this.pending.then(async () => {
      let state: SessionState;
      try { state = await this.load(); }
      catch (error) { if (!allowReset) throw error; state = { version: 1, path: null }; }
      const next = await change(state);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.file);
      } finally { await unlink(temporary).catch(() => undefined); }
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
