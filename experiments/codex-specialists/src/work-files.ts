import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { assertWorkRequest, parseWorkRequest, parseWorkResult, workPath, workSnapshotText, type WorkFile, type WorkRequest, type WorkResult } from './work-contract.ts';

export const workDigest = (text: string) => createHash('sha256').update(text).digest('hex');

/** Check every component, including missing files, before opening a project path. */
export function checkedWorkPath(root: string, path: string): string {
  workPath(path);
  const absoluteRoot = realpathSync(root), target = resolve(absoluteRoot, path);
  if (relative(absoluteRoot, target).replaceAll('\\', '/') !== path) throw new Error('Work path escaped its workspace.');
  let current = absoluteRoot;
  for (const part of path.split('/')) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Symlinks are not supported in delegated work.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}
export function readWorkFile(root: string, path: string): WorkFile {
  const filename = checkedWorkPath(root, path);
  let fd: number;
  try { fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, content: null, sha256: null };
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 128_000) throw new Error('Delegation supports text files up to 128 KB each.');
    if (process.platform === 'linux' && realpathSync(`/proc/self/fd/${fd}`) !== filename) throw new Error('Work path changed during open.');
    const bytes = readFileSync(fd);
    if (bytes.length > 128_000) throw new Error('Work file grew beyond 128 KB.');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (content.includes('\0') || !Buffer.from(content).equals(bytes)) throw new Error('Delegation requires UTF-8 text without a byte-order mark.');
    return { path, content, sha256: workDigest(content) };
  } finally { closeSync(fd); }
}
export function captureWork(root: string, input: Omit<WorkRequest, 'version' | 'files' | 'snapshot'> & { paths: string[] }): WorkRequest {
  const files = [...new Set([...input.paths, ...input.writePaths])].sort().map(path => readWorkFile(root, path));
  const result = parseWorkRequest({ ...input, version: 1, files, snapshot: workDigest(workSnapshotText(files)) });
  // Reject a snapshot captured across a concurrent edit instead of silently mixing revisions.
  if (files.some(file => readWorkFile(root, file.path).sha256 !== file.sha256)) throw new Error('Project changed while capturing delegated work. Retry with a fresh request.');
  return result;
}

/** Persistent, per-request copies. Model commands only receive read access to this directory. */
export class WorkFiles {
  readonly directory: string;
  readonly request: WorkRequest;
  constructor(parent: string, id: string, request: WorkRequest, existing = false) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid work directory identity.');
    this.request = parseWorkRequest(request); assertWorkRequest(this.request, workDigest);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    this.directory = join(realpathSync(parent), id);
    if (existsSync(this.directory)) {
      if (!lstatSync(this.directory).isDirectory() || lstatSync(this.directory).isSymbolicLink()) throw new Error('Invalid saved work directory.');
      this.assertTree();
      return;
    }
    if (existing) throw new Error('Saved work directory is missing. Do not recreate an unknown execution.');
    const temporary = join(realpathSync(parent), `${id}-${randomUUID()}`);
    mkdirSync(temporary, { mode: 0o700 });
    for (const file of request.files) {
      if (file.content === null) continue;
      const target = checkedWorkPath(temporary, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, { flag: 'wx', mode: 0o600 });
    }
    renameSync(temporary, this.directory);
  }
  private assertTree(): void {
    const walk = (folder: string) => {
      for (const item of readdirSync(folder, { withFileTypes: true })) {
        const filename = join(folder, item.name), path = relative(this.directory, filename);
        if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) throw new Error('Invalid object in delegated workspace.');
        if (item.isDirectory()) {
          if (!this.request.files.some(f => f.path.startsWith(`${path}/`))) throw new Error('Unexpected delegated directory.');
          walk(filename);
        } else if (!this.request.files.some(f => f.path === path) || lstatSync(filename).nlink !== 1) throw new Error('Unexpected or linked delegated file.');
      }
    };
    walk(this.directory);
    for (const file of this.request.files) if (!this.request.writePaths.includes(file.path) && readWorkFile(this.directory, file.path).sha256 !== file.sha256) {
      throw new Error('Read-only context file changed.');
    }
  }
  read(path: string): WorkFile {
    if (!this.request.files.some(f => f.path === path)) throw new Error('File is outside this work snapshot.');
    return readWorkFile(this.directory, path);
  }
  write(path: string, content: string | null): WorkFile {
    if (!this.request.writePaths.includes(path)) throw new Error('File is outside the delegated write scope.');
    if (content !== null && (typeof content !== 'string' || Buffer.byteLength(content) > 128_000 || content.includes('\0'))) throw new Error('Invalid work file content.');
    this.assertTree();
    const filename = checkedWorkPath(this.directory, path);
    if (content === null) { if (existsSync(filename)) unlinkSync(filename); }
    else {
      mkdirSync(dirname(filename), { recursive: true });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      writeFileSync(temporary, content, { flag: 'wx', mode: 0o600, flush: true }); renameSync(temporary, filename);
    }
    return this.read(path);
  }
  result(summary: string): WorkResult {
    this.assertTree();
    const changes = this.request.writePaths.flatMap(path => {
      const before = this.request.files.find(f => f.path === path)!.sha256, after = this.read(path);
      return before === after.sha256 ? [] : [{ ...after, before }];
    });
    return parseWorkResult({ version: 1, snapshot: this.request.snapshot, status: 'submitted', summary, changes });
  }
}
