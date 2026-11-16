import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { codeGraphStorageDirectory } from '../../config/workspace-storage.mts';
import type { WorkspaceProject } from '../shared/workspace-projects.ts';

const limit = 16;
const listeners = new Map<string, Set<() => void>>();

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function project(rootPath: string, primary = false): WorkspaceProject {
  let available = false;
  try { available = statSync(rootPath).isDirectory(); } catch { /* Keep unavailable projects removable. */ }
  return { id: primary ? 'primary' : createHash('sha256').update(rootPath).digest('hex').slice(0, 24),
    name: path.basename(rootPath), rootPath, primary, available };
}

/** Membership is independent of Git, CodeGraph indexes and the source directories. */
export class WorkspaceProjectStore {
  readonly root: string;
  private readonly file: string;

  constructor(dataRoot: string, root: string) {
    this.root = existsSync(root) ? realpathSync(root) : path.resolve(root);
    this.file = path.join(path.dirname(codeGraphStorageDirectory(dataRoot, root)), 'linked-projects.json');
  }

  list(): WorkspaceProject[] {
    if (!existsSync(this.file)) return [project(this.root, true)];
    const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
      || !('roots' in value) || !Array.isArray(value.roots) || value.roots.length >= limit
      || value.roots.some((root: unknown) => typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0'))) {
      throw new Error('Invalid linked project configuration.');
    }
    const roots: string[] = value.roots;
    const all = [this.root, ...roots];
    if (all.some((root, index) => all.slice(index + 1).some(other => contains(root, other) || contains(other, root)))) {
      throw new Error('Linked project roots overlap.');
    }
    return [project(this.root, true), ...roots.map(root => project(root))];
  }

  get(id: unknown): WorkspaceProject {
    const entry = this.list().find(item => item.id === id);
    if (!entry) throw new Error('The project is not connected to this workspace.');
    return entry;
  }

  async add(value: string, beforeCommit: () => void = () => {}): Promise<WorkspaceProject[]> {
    if (!path.isAbsolute(value) || value.includes('\0')) throw new Error('Select an absolute project folder.');
    const root = await realpath(value);
    if (!(await stat(root)).isDirectory()) throw new Error('Select a project folder.');
    const entries = this.list();
    if (entries.some(entry => entry.rootPath === root)) return entries;
    if (entries.length >= limit) throw new Error(`A workspace supports up to ${limit} projects.`);
    if (entries.some(entry => contains(entry.rootPath, root) || contains(root, entry.rootPath))) {
      throw new Error('This folder overlaps a project already in the workspace.');
    }
    beforeCommit();
    this.save([...entries.slice(1).map(entry => entry.rootPath), root]);
    return this.list();
  }

  remove(id: unknown): WorkspaceProject[] {
    const entry = this.get(id);
    if (entry.primary) throw new Error('The primary project cannot be disconnected.');
    this.save(this.list().filter(item => !item.primary && item.id !== id).map(item => item.rootPath));
    return this.list();
  }

  subscribe(listener: () => void): () => void {
    const set = listeners.get(this.file) ?? new Set();
    set.add(listener);
    listeners.set(this.file, set);
    return () => { set.delete(listener); if (!set.size) listeners.delete(this.file); };
  }

  private save(roots: string[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, roots }, null, 2) + '\n', { mode: 0o600 });
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
    for (const listener of listeners.get(this.file) ?? []) listener();
  }
}
